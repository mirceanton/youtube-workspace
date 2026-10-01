import type { HealthResponse } from "@ytw/shared/api/health";
import Fastify, { type FastifyInstance } from "fastify";
import type { Env } from "./env.js";

/** Builds the web server (backend-for-frontend) without binding a port, so tests can `inject`. */
export function buildApp(env: Env): FastifyInstance {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

  const health: HealthResponse = {
    status: "ok",
    service: "web-server",
    version: env.APP_VERSION,
    commit: env.GIT_SHA,
  };
  app.get("/healthz", async () => health);

  return app;
}
