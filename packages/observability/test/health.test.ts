import { healthResponseSchema } from "@ytw/shared/api/health";
import { afterEach, describe, expect, it } from "vitest";
import { readinessResponseSchema, type ReadinessCheck } from "../src/index.js";
import { SECRET, buildObservedApp, closeApps } from "./helpers.js";

afterEach(closeApps);

/** A slow check that counts how often it ran. */
function counting(): { check: ReadinessCheck; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    check: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
}

describe("GET /healthz", () => {
  it("answers with the shared health contract", async () => {
    const { app } = await buildObservedApp({ service: "web-server" });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(healthResponseSchema.parse(res.json())).toEqual({
      status: "ok",
      service: "web-server",
      version: "1.2.3",
      commit: "abc1234",
    });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("does not depend on any readiness check", async () => {
    const { app } = await buildObservedApp({
      readiness: {
        database: async () => {
          throw new Error("database is down");
        },
      },
    });
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});

describe("GET /readyz", () => {
  it("is ready when no checks are configured", async () => {
    const { app } = await buildObservedApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(readinessResponseSchema.parse(res.json())).toEqual({
      status: "ready",
      service: "mcp",
      checks: {},
    });
  });

  it("is ready when the injected database and migration checks pass", async () => {
    const { app } = await buildObservedApp({
      readiness: {
        database: async () => {},
        migrations: async () => ({ ok: true }),
      },
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ready",
      service: "mcp",
      checks: { database: { status: "ok" }, migrations: { status: "ok" } },
    });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("answers 503 when the database ping throws, without leaking the error", async () => {
    const { app, sink } = await buildObservedApp({
      readiness: {
        database: async () => {
          throw new Error(
            `connect ECONNREFUSED postgres://ytw_mcp:${SECRET.dbPassword}@db.internal:5432/ytw`,
          );
        },
        migrations: async () => {},
      },
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(readinessResponseSchema.parse(res.json())).toEqual({
      status: "unavailable",
      service: "mcp",
      checks: {
        database: { status: "fail", detail: "check failed" },
        migrations: { status: "ok" },
      },
    });
    expect(res.body).not.toContain("ECONNREFUSED");
    expect(res.body).not.toContain("db.internal");

    // The operator still gets the cause in the log, with the password removed.
    const warning = sink.records.find((r) => r["msg"] === "readiness check failed");
    expect(warning).toMatchObject({ level: "warn", check: "database" });
    expect(JSON.stringify(warning)).toContain("ECONNREFUSED");
    expect(sink.text).not.toContain(SECRET.dbPassword);
  });

  it("answers 503 when migrations are pending and shows the check's own detail", async () => {
    const { app } = await buildObservedApp({
      readiness: {
        database: async () => {},
        migrations: async () => ({ ok: false, detail: "2 migrations pending" }),
      },
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: "unavailable",
      checks: { migrations: { status: "fail", detail: "2 migrations pending" } },
    });
  });

  it("scrubs and bounds a check's detail", async () => {
    const { app } = await buildObservedApp({
      readiness: {
        migrations: async () => ({
          ok: false,
          detail: `bad Bearer ${SECRET.opaqueBearer} ${"x".repeat(500)}`,
        }),
      },
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    const detail = (res.json() as { checks: { migrations: { detail: string } } }).checks.migrations
      .detail;
    expect(detail).not.toContain(SECRET.opaqueBearer);
    expect(detail.length).toBeLessThanOrEqual(200);
  });

  it("treats a check that takes too long as failed", async () => {
    const { app } = await buildObservedApp({
      readinessTimeoutMs: 40,
      readiness: { database: () => new Promise<void>(() => {}) },
    });
    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      checks: { database: { status: "fail", detail: "timed out after 40 ms" } },
    });
  });

  it("recovers as soon as the dependency does", async () => {
    let healthy = false;
    const { app } = await buildObservedApp({
      readinessCacheMs: 0,
      readiness: {
        database: async () => {
          if (!healthy) throw new Error("down");
        },
      },
    });
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
    healthy = true;
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });

  describe("load on the dependency", () => {
    it("reuses a result for the cache window", async () => {
      const probe = counting();
      const { app } = await buildObservedApp({
        readinessCacheMs: 60_000,
        readiness: { database: probe.check },
      });
      for (let i = 0; i < 5; i++) await app.inject({ method: "GET", url: "/readyz" });
      expect(probe.calls()).toBe(1);
    });

    it("shares one run between concurrent requests", async () => {
      const probe = counting();
      const { app } = await buildObservedApp({
        readinessCacheMs: 0,
        readiness: { database: probe.check },
      });
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => app.inject({ method: "GET", url: "/readyz" })),
      );
      expect(responses.every((res) => res.statusCode === 200)).toBe(true);
      expect(probe.calls()).toBe(1);
    });

    it("runs again once the cache window has passed", async () => {
      const probe = counting();
      const { app } = await buildObservedApp({
        readinessCacheMs: 0,
        readiness: { database: probe.check },
      });
      await app.inject({ method: "GET", url: "/readyz" });
      await app.inject({ method: "GET", url: "/readyz" });
      expect(probe.calls()).toBe(2);
    });
  });
});

describe("probe logging", () => {
  it("keeps the request log free of probe and scrape traffic but not of real requests", async () => {
    const { app, sink } = await buildObservedApp({}, (instance) => {
      instance.get("/things", async () => ({ ok: true }));
    });
    await app.inject({ method: "GET", url: "/healthz" });
    await app.inject({ method: "GET", url: "/readyz" });
    await app.inject({ method: "GET", url: "/metrics" });
    await app.inject({ method: "GET", url: "/things" });

    const completed = sink.records
      .filter((r) => r["msg"] === "request completed")
      .map((r) => r["res"]);
    expect(completed).toHaveLength(1);
    expect(sink.text).not.toContain("/healthz");
    expect(sink.text).not.toContain("/readyz");
    expect(sink.text).toContain("/things");
  });
});
