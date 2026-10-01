import { afterEach, describe, expect, it } from "vitest";
import { Registry, bindActor, metricValue } from "../src/index.js";
import { SECRET, buildObservedApp, closeApps } from "./helpers.js";

afterEach(closeApps);

describe("observabilityPlugin over a real socket", () => {
  it("serves the probe and scrape routes and tags requests with an id", async () => {
    const { app } = await buildObservedApp({
      readiness: { database: async () => {}, migrations: async () => {} },
      metricsToken: "scrape-token-0123456789",
    });
    const base = await app.listen({ host: "127.0.0.1", port: 0 });

    const health = await fetch(`${base}/healthz`, { headers: { "x-request-id": "probe-1" } });
    expect(health.status).toBe(200);
    expect(health.headers.get("x-request-id")).toBe("probe-1");
    expect(await health.json()).toMatchObject({ status: "ok", service: "mcp", version: "1.2.3" });

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: "ready" });

    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    const metrics = await fetch(`${base}/metrics`, {
      headers: { authorization: "Bearer scrape-token-0123456789" },
    });
    expect(metrics.status).toBe(200);
    const body = await metrics.text();
    expect(body).toContain('http_requests_total{method="GET",route="/healthz",status="200"} 1');
    expect(body).toContain('http_requests_total{method="GET",route="/readyz",status="200"} 1');
    expect(body).toContain('http_requests_total{method="GET",route="/metrics",status="401"} 1');
  });

  it("keeps credentials out of the log when real clients send them", async () => {
    const { app, sink } = await buildObservedApp({}, (instance) => {
      instance.get("/auth/callback", async (request, reply) => {
        bindActor(request, reply, { actor: "owner", actorType: "human", userId: "u-1" });
        request.log.info({ headers: request.headers, query: request.query }, "callback");
        return { ok: true };
      });
    });
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const res = await fetch(
      `${base}/auth/callback?code=${SECRET.oidcCode}&state=${SECRET.oidcState}`,
      {
        headers: {
          authorization: `Bearer ${SECRET.apiToken}`,
          cookie: SECRET.sessionCookie,
          "x-forwarded-authorization": `Bearer ${SECRET.opaqueBearer}`,
        },
      },
    );
    expect(res.status).toBe(200);

    const text = sink.text;
    for (const secret of [
      SECRET.apiToken,
      "SESSIONVALUE-7f3a9c1e5b2d4f60",
      SECRET.opaqueBearer,
      SECRET.oidcCode,
      SECRET.oidcState,
    ]) {
      expect(text).not.toContain(secret);
    }
    const completed = sink.records.find((r) => r["msg"] === "request completed");
    expect(completed).toMatchObject({ actor: "owner", actorType: "human", userId: "u-1" });
  });
});

describe("observabilityPlugin decoration", () => {
  it("exposes the registry and the tool-call recorder to the app", async () => {
    const { app } = await buildObservedApp();
    expect(app.observability.registry).toBeInstanceOf(Registry);
    app.observability.toolCalls.record({ tool: "whoami", token: "agent-1" });
    expect(
      await metricValue(app.observability.registry, "mcp_tool_calls_total", {
        tool: "whoami",
        token: "agent-1",
      }),
    ).toBe(1);
  });
});
