import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPool } from "@ytw/db";
import {
  createLogger,
  fastifyLoggingOptions,
  observabilityPlugin,
  secretValuesFromEnv,
} from "@ytw/observability";
import { createAuthenticator, FailureLimiter, type Authenticator } from "@ytw/tokens";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Env } from "./env.js";
import { filesPlugin } from "./files/routes.js";
import { createMcpServer } from "./server.js";
import { loadTools, type ToolDefinition } from "./tools.js";

export interface BuildAppOptions {
  pool?: Pool | undefined;
  readonlyPool?: Pool | undefined;
  authenticator?: Authenticator | undefined;
  limiter?: FailureLimiter | undefined;
  tools?: readonly ToolDefinition[] | undefined;
}

/**
 * Builds the MCP server Fastify application.
 */
export async function buildApp(env: Env, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const logger = createLogger({
    service: "mcp",
    level: env.LOG_LEVEL,
    secrets: secretValuesFromEnv(),
  });

  const app = Fastify({
    ...fastifyLoggingOptions(logger),
    bodyLimit: 1_048_576,
    trustProxy: true, // 1 MB body limit (PRD 5, 9)
  });

  const pool =
    options.pool ??
    createPool({
      connectionString: env.DATABASE_URL,
      role: "ytw_mcp",
    });

  const readonlyPool =
    options.readonlyPool ??
    (env.READONLY_DATABASE_URL
      ? createPool({
          connectionString: env.READONLY_DATABASE_URL,
          role: "ytw_readonly",
        })
      : undefined);

  app.addHook("onClose", async () => {
    if (!options.pool) {
      await pool.end().catch(() => undefined);
    }
    if (!options.readonlyPool && readonlyPool) {
      await readonlyPool.end().catch(() => undefined);
    }
  });

  await app.register(observabilityPlugin, {
    service: "mcp",
    version: env.APP_VERSION,
    commit: env.GIT_SHA,
    metricsToken: env.METRICS_TOKEN,
    readiness: {
      database: async () => {
        try {
          await pool.query("SELECT 1");
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    },
  });

  const authenticator =
    options.authenticator ??
    createAuthenticator({
      db: pool,
      limiter: options.limiter ?? new FailureLimiter(),
      onTouchError: (err) => app.log.warn({ err }, "failed to touch token last_used_at"),
    });

  await app.register(filesPlugin, {
    pool,
    authenticator,
  });

  const tools = options.tools ?? (await loadTools());

  // Stateless MCP endpoint (PRD 5)
  app.post("/mcp", async (request, reply) => {
    const auth = await authenticator.authenticate(request.headers.authorization, request.ip);

    if (!auth.ok) {
      if (auth.reason === "rate_limited") {
        reply.header("Retry-After", auth.retryAfterSeconds ?? 60);
        return reply
          .status(429)
          .send({ error: "rate_limited", message: "Too many authentication failures" });
      }

      // Every other auth failure answers an identical 401 with no detail (no leak)
      return reply.status(401).send({ error: "unauthorized", message: "Unauthorized" });
    }

    const server = createMcpServer({
      principal: auth.principal,
      pool,
      readonlyPool,
      tools,
      log: request.log,
      toolCallMetrics: app.observability.toolCalls,
      appVersion: env.APP_VERSION,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);

    reply.raw.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
  });

  // In stateless mode, GET and DELETE are not supported
  app.get("/mcp", async (_request, reply) => {
    return reply.status(405).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode." },
      id: null,
    });
  });

  app.delete("/mcp", async (_request, reply) => {
    return reply.status(405).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode." },
      id: null,
    });
  });

  return app;
}
