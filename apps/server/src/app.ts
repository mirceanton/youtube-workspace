import { createPool, migrate, migrationStatus, purgeExpiredWebSessions } from "@ytw/db";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Env } from "./env.js";
import { agentPlugin } from "./mcp/index.js";
import { loadTools, type ToolDefinition } from "./mcp/registry.js";
import {
  createLogger,
  createMetrics,
  generateRequestId,
  registerObservability,
  type LogSink,
} from "./observability/index.js";
import { createAuthenticator, FailureLimiter, reconcileBootstrapToken } from "./tokens/index.js";
import type { OidcFetch } from "./web/oidc.js";
import { webPlugin } from "./web/index.js";

export interface BuildAppOptions {
  /** Use this pool instead of creating one from `DATABASE_URL`; the app does not close it. */
  pool?: Pool | undefined;
  /** Replaces outbound OIDC requests, so tests can run a provider in-process. */
  oidcFetch?: OidcFetch | undefined;
  /** Where log lines go (default stdout). */
  logDestination?: LogSink | undefined;
  /** Replaces the failed-authentication limiter. */
  limiter?: FailureLimiter | undefined;
}

/** The literal secrets of this process, which the logger removes wherever they appear. */
function secretsOf(env: Env): string[] {
  const secrets = [
    env.databaseUrl,
    env.metricsToken,
    env.bootstrapToken?.secret,
    env.oidc?.clientSecret,
    env.oidc?.sessionSecret,
  ];
  try {
    const password = new URL(env.databaseUrl).password;
    // A short password would mangle ordinary words in the log; the URL as a whole is covered above.
    if (password.length >= 12) secrets.push(password, decodeURIComponent(password));
  } catch {
    // Not a URL: the environment check has already refused it.
  }
  return secrets.filter((secret): secret is string => secret !== undefined && secret !== "");
}

/** Runs one startup step; a failure aborts the boot with a message that says which step. */
async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${what} failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

/**
 * Builds the server: connects, brings the database up to date, reconciles the seeded MCP token,
 * and registers the three route groups (web, agent, operations). Nothing listens yet.
 *
 * Replicas that boot together are safe: the migrator holds an advisory lock and the token
 * reconciliation is one statement in the database.
 */
export async function buildApp(env: Env, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  // Typed as the plain Fastify logger so the app is an ordinary `FastifyInstance` for the plugins.
  const logger: FastifyBaseLogger = createLogger({
    level: env.logLevel,
    version: env.appVersion,
    commit: env.gitSha,
    secrets: secretsOf(env),
    ...(options.logDestination === undefined ? {} : { destination: options.logDestination }),
  });
  const app = Fastify({
    loggerInstance: logger,
    genReqId: generateRequestId,
    requestIdHeader: false,
    bodyLimit: 1_048_576,
    // The failure limiter and the logs want the client's address, not the reverse proxy's.
    trustProxy: true,
  });

  const pool =
    options.pool ??
    createPool({
      connectionString: env.databaseUrl,
      onError: (error) => app.log.error({ err: error }, "idle database connection failed"),
    });
  app.addHook("onClose", async () => {
    if (options.pool === undefined) await pool.end().catch(() => undefined);
  });

  try {
    await step("database migration", () =>
      migrate({ databaseUrl: env.databaseUrl, log: (line) => app.log.info(line) }),
    );
    const seeded = await step("MCP token setup", () =>
      reconcileBootstrapToken(pool, env.bootstrapToken),
    );
    app.log.info(
      { action: seeded.action, tokenName: env.bootstrapToken?.name, tokenId: seeded.tokenId },
      `MCP bootstrap token: ${seeded.action}`,
    );
    const purged = await purgeExpiredWebSessions(pool);
    if (purged > 0) app.log.info({ purged }, "removed expired web sessions");

    // query_sql lets a token read every table; as a superuser it could also read files and run
    // programs from SQL. So it is only offered when the database role is an ordinary one.
    const { rows } = await pool.query<{ rolsuper: boolean }>(
      "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    const superuser = rows[0]?.rolsuper === true;
    const tools: ToolDefinition[] = (await loadTools()).filter(
      (tool) => !(superuser && tool.runsCallerSql === true),
    );
    if (superuser) {
      app.log.warn(
        "DATABASE_URL connects as a superuser, so the query_sql MCP tool is disabled: it could read " +
          "files and run programs on the database host. Connect as the role that owns the database " +
          "(an ordinary role, as CloudNativePG's app user is) to enable it.",
      );
    }

    const metrics = createMetrics({ version: env.appVersion, commit: env.gitSha });
    registerObservability(app, {
      version: env.appVersion,
      commit: env.gitSha,
      metrics,
      metricsToken: env.metricsToken,
      checks: {
        database: async () => {
          await pool.query("SELECT 1");
          return true;
        },
        schema: async () => (await migrationStatus(pool)).upToDate,
      },
    });

    const authenticator = createAuthenticator({
      db: pool,
      limiter: options.limiter ?? new FailureLimiter(),
      onTouchError: (err) => app.log.warn({ err }, "failed to touch token last_used_at"),
    });
    await app.register(agentPlugin, {
      pool,
      authenticator,
      tools,
      metrics,
      appVersion: env.appVersion,
    });
    await app.register(webPlugin, { env, pool, oidcFetch: options.oidcFetch });

    if (env.oidc === null) {
      app.log.warn(
        "OIDC is not configured: SINGLE-USER MODE. There is no login, every web request is the " +
          "local owner with full access. Only run it where nobody untrusted can reach the server " +
          "(set OIDC_* to require a login).",
      );
    }
    await app.ready();
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
