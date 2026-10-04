import { healthResponseSchema } from "@ytw/shared/api/health";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

const env = () =>
  loadEnv({
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgres://ytw_web:ytw-web-dev-password@localhost:5432/youtube_workspace",
    OIDC_ISSUER_URL: "http://localhost:8080/realms/youtube-workspace",
    OIDC_CLIENT_ID: "youtube-workspace",
    OIDC_CLIENT_SECRET: "dev-only-secret",
    OIDC_REDIRECT_URI: "http://localhost:3000/auth/callback",
    OIDC_GROUPS_CLAIM_PATH: "groups",
    OIDC_REQUIRED_GROUP: "youtube-workspace-users",
    SESSION_SECRET: "a-dev-only-session-secret-with-32-or-more-characters",
  });

describe("web-server", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("answers /healthz with the service name, version and commit", async () => {
    app = await buildApp({ ...env(), APP_VERSION: "1.2.3", GIT_SHA: "abc123" });
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
    app = await buildApp(env());
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const res = await fetch(`${address}/healthz`);
    expect(res.status).toBe(200);
    expect(healthResponseSchema.parse(await res.json()).service).toBe("web-server");
  });

  it("returns 404 for unknown routes", async () => {
    app = await buildApp(env());
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/auth/login?return_to=%2Fnope");
    expect((await app.inject({ method: "GET", url: "/api/missing" })).statusCode).toBe(401);
  });

  it("adds browser security headers and exposes route authorization metadata", async () => {
    app = await buildApp(env());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(app.securityRoutes().filter((route) => !route.guarded)).toEqual([]);
  });
});
