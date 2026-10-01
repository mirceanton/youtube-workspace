import { healthResponseSchema } from "@ytw/shared/api/health";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

describe("web-server", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("answers /healthz with the service name, version and commit", async () => {
    app = buildApp(loadEnv({ LOG_LEVEL: "silent", APP_VERSION: "1.2.3", GIT_SHA: "abc123" }));
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(healthResponseSchema.parse(res.json())).toEqual({
      status: "ok",
      service: "web-server",
      version: "1.2.3",
      commit: "abc123",
    });
  });

  it("serves /healthz over a real socket", async () => {
    app = buildApp(loadEnv({ LOG_LEVEL: "silent" }));
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const res = await fetch(`${address}/healthz`);
    expect(res.status).toBe(200);
    expect(healthResponseSchema.parse(await res.json()).service).toBe("web-server");
  });

  it("returns 404 for unknown routes", async () => {
    app = buildApp(loadEnv({ LOG_LEVEL: "silent" }));
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
  });
});
