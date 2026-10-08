/**
 * The agent group: `POST /mcp` and the script file endpoints. Every request needs the bearer token
 * of an API token, in every deployment mode; failures answer an identical 401 without detail (no
 * leak), and clients that keep failing are rate limited.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { TokenPrincipal } from "@ytw/policy";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Metrics } from "../observability/index.js";
import type { Authenticator } from "../tokens/index.js";
import { registerScriptFiles } from "./files.js";
import type { ToolDefinition } from "./registry.js";
import { createMcpServer } from "./server.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The API token's principal; set on every request of the agent group. */
    principal: TokenPrincipal | undefined;
  }
}

export interface AgentOptions {
  pool: Pool;
  authenticator: Authenticator;
  tools: readonly ToolDefinition[];
  metrics: Metrics;
  appVersion: string;
}

const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply) =>
  reply.status(405).send({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed in stateless mode." },
    id: null,
  });

export const agentPlugin: FastifyPluginAsync<AgentOptions> = async (app, options) => {
  const { pool, authenticator, tools, metrics, appVersion } = options;

  app.decorateRequest("principal", null as unknown as TokenPrincipal | undefined);
  // Authenticating before the body is read keeps unauthenticated clients from making us parse it.
  app.addHook("onRequest", async (request, reply) => {
    const auth = await authenticator.authenticate(request.headers.authorization, request.ip);
    if (auth.ok) {
      request.principal = auth.principal;
      return;
    }
    if (auth.reason === "rate_limited") {
      return reply
        .header("Retry-After", auth.retryAfterSeconds ?? 60)
        .status(429)
        .send({ error: "rate_limited", message: "Too many authentication failures" });
    }
    return reply.status(401).send({ error: "unauthorized", message: "Unauthorized" });
  });

  registerScriptFiles(app, pool);

  // Stateless MCP: a fresh server and transport per request.
  app.post("/mcp", async (request, reply) => {
    if (request.principal === undefined) return reply;
    const server = createMcpServer({
      principal: request.principal,
      pool,
      tools,
      log: request.log,
      metrics,
      appVersion,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
    reply.raw.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
  });

  // Without sessions there is nothing to stream or terminate.
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
};
