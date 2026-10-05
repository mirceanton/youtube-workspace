import { createPool } from "@ytw/db";
import {
  createLogger,
  fastifyLoggingOptions,
  observabilityPlugin,
  secretValuesFromEnv,
} from "@ytw/observability";
import Fastify, { type FastifyInstance, type RawServerDefault } from "fastify";
import type { Pool } from "pg";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "./env.js";
import { OidcClient, type OidcFetch } from "./core/oidc.js";
import { registerFeatureRoutes } from "./core/routes.js";
import { installSpaFallback } from "./core/static.js";
import { registerAuthCore } from "./core/auth.js";

export interface BuildAppOptions {
  /** Test injection only; production creates a pool from DATABASE_URL. */
  pool?: Pool;
  /** Replaces outbound OIDC Fetch calls for in-process provider tests. */
  oidcFetch?: OidcFetch;
  /** Override for a test or a packaged layout; defaults to this app's routes directory. */
  routeDirectory?: string;
}

/** Builds the web server, loads feature route plugins and waits until it is ready for injection. */
export async function buildApp(env: Env, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const loggerSecrets: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") loggerSecrets[key] = value;
  }
  const logger = createLogger({
    service: "web-server",
    level: env.LOG_LEVEL,
    secrets: secretValuesFromEnv(loggerSecrets),
  });
  const app = Fastify<RawServerDefault>({
    ...fastifyLoggingOptions(logger),
    bodyLimit: 1_048_576,
  });

  const pool =
    options.pool ??
    createPool({
      role: "ytw-web",
      connectionString: env.DATABASE_URL,
      onError: (error) => app.log.error({ err: error }, "idle database connection failed"),
    });
  app.addHook("onClose", async () => {
    if (options.pool === undefined) await pool.end().catch(() => undefined);
  });

  const oidc = new OidcClient(env, options.oidcFetch);
  // Register the route observer and shared BFF decorators before health and feature routes so the
  // authorization coverage manifest includes all Fastify routes.
  registerAuthCore(app, env, oidc, pool);

  await app.register(observabilityPlugin, {
    service: "web-server",
    version: env.APP_VERSION,
    commit: env.GIT_SHA,
    metricsToken: env.METRICS_TOKEN,
    readiness: {
      database: async () => {
        try {
          await pool.query("SELECT 1");
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "database unavailable",
          };
        }
      },
    },
  });

  const routeDirectory =
    options.routeDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), "routes");
  await registerFeatureRoutes(app, routeDirectory);
  installSpaFallback(app, env);
  await app.ready();
  return app;
}
