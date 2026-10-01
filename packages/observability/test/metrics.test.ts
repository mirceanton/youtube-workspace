import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  LabelGuard,
  OVERFLOW_LABEL,
  Registry,
  createMetricsRegistry,
  createToolCallMetrics,
  metricValue,
} from "../src/index.js";
import { buildObservedApp, closeApps } from "./helpers.js";

afterEach(closeApps);

async function scrape(app: FastifyInstance, headers: Record<string, string> = {}) {
  return app.inject({ method: "GET", url: "/metrics", headers });
}

/** The sample lines of a Prometheus text exposition (no HELP/TYPE comments). */
function samples(body: string): string[] {
  return body.split("\n").filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** An app that has served successes, a 201, a 500 and three requests that match no route. */
async function buildWithTraffic(): Promise<FastifyInstance> {
  const built = await buildObservedApp({}, (instance) => {
    instance.get("/items/:id", async () => ({ ok: true }));
    instance.get("/fail", async () => {
      throw new Error("boom");
    });
    instance.post("/items", async (_request, reply) => reply.code(201).send({ created: true }));
  });
  for (const url of ["/items/1", "/items/2"]) await built.app.inject({ method: "GET", url });
  await built.app.inject({ method: "GET", url: "/fail" });
  await built.app.inject({ method: "POST", url: "/items", payload: {} });
  for (const url of ["/random-path-123", "/wp-admin/setup.php", "/another/unknown"]) {
    await built.app.inject({ method: "GET", url });
  }
  return built.app;
}

describe("HTTP metrics", () => {
  it("exposes request rate by method, matched route pattern and status", async () => {
    const app = await buildWithTraffic();
    const res = await scrape(app);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain; version=0\.0\.4/);
    const output = samples(res.body);
    expect(output).toContain('http_requests_total{method="GET",route="/items/:id",status="200"} 2');
    expect(output).toContain('http_requests_total{method="POST",route="/items",status="201"} 1');
  });

  it("exposes the error rate through the status label", async () => {
    const app = await buildWithTraffic();
    expect(samples((await scrape(app)).body)).toContain(
      'http_requests_total{method="GET",route="/fail",status="500"} 1',
    );
  });

  it("collapses unmatched URLs into one series so scanners cannot grow the registry", async () => {
    const app = await buildWithTraffic();
    const body = (await scrape(app)).body;
    expect(samples(body)).toContain(
      'http_requests_total{method="GET",route="unmatched",status="404"} 3',
    );
    expect(body).not.toContain("random-path-123");
    expect(body).not.toContain("wp-admin");
    expect(body).not.toContain("/items/1");
  });

  it("exposes request latency as a histogram", async () => {
    const app = await buildWithTraffic();
    const output = samples((await scrape(app)).body);
    const labels = 'method="GET",route="/items/:id",status="200"';
    expect(output).toContain(`http_request_duration_seconds_count{${labels}} 2`);
    expect(output.some((l) => l.startsWith(`http_request_duration_seconds_sum{${labels}}`))).toBe(
      true,
    );
    expect(
      output.some((l) =>
        l.startsWith(`http_request_duration_seconds_bucket{le="0.005",${labels}}`),
      ),
    ).toBe(true);
    expect(
      output.some((l) => l.startsWith(`http_request_duration_seconds_bucket{le="+Inf",${labels}}`)),
    ).toBe(true);
  });

  it("publishes build information", async () => {
    const app = await buildWithTraffic();
    expect(samples((await scrape(app)).body)).toContain(
      'ytw_build_info{service="mcp",version="1.2.3",commit="abc1234"} 1',
    );
  });

  it("includes Node.js process metrics by default and omits them on request", async () => {
    const withDefaults = await buildObservedApp({ defaultMetrics: true });
    const body = (await scrape(withDefaults.app)).body;
    expect(body).toContain("process_cpu_user_seconds_total");
    expect(body).toContain("nodejs_eventloop_lag_seconds");

    const without = await buildObservedApp({ defaultMetrics: false });
    expect((await scrape(without.app)).body).not.toContain("process_cpu_user_seconds_total");
  });

  it("keeps each app's counters separate", async () => {
    const first = await buildObservedApp({}, (i) => i.get("/x", async () => "x"));
    const second = await buildObservedApp({}, (i) => i.get("/x", async () => "x"));
    await first.app.inject({ method: "GET", url: "/x" });
    expect(
      await metricValue(first.app.observability.registry, "http_requests_total", { route: "/x" }),
    ).toBe(1);
    expect(
      await metricValue(second.app.observability.registry, "http_requests_total", { route: "/x" }),
    ).toBeUndefined();
  });
});

describe("MCP tool call metrics", () => {
  it("counts calls by tool and token name", async () => {
    const { app } = await buildObservedApp();
    const { toolCalls } = app.observability;
    toolCalls.record({ tool: "whoami", token: "analytics-agent" });
    toolCalls.record({ tool: "whoami", token: "analytics-agent" });
    toolCalls.record({ tool: "list_ideas", token: "analytics-agent" });
    toolCalls.record({ tool: "whoami", token: "editor-agent" });

    const output = samples((await scrape(app)).body);
    expect(output).toContain('mcp_tool_calls_total{tool="whoami",token="analytics-agent"} 2');
    expect(output).toContain('mcp_tool_calls_total{tool="list_ideas",token="analytics-agent"} 1');
    expect(output).toContain('mcp_tool_calls_total{tool="whoami",token="editor-agent"} 1');
  });

  it("counts denied and failed calls separately, without a token label", async () => {
    const { app } = await buildObservedApp();
    const { toolCalls } = app.observability;
    toolCalls.record({ tool: "log_metrics", token: "t1", outcome: "denied" });
    toolCalls.record({ tool: "log_metrics", token: "t2", outcome: "denied" });
    toolCalls.record({ tool: "log_metrics", token: "t1", outcome: "error" });
    toolCalls.record({ tool: "log_metrics", token: "t1", outcome: "ok" });

    const output = samples((await scrape(app)).body);
    expect(output).toContain('mcp_tool_call_failures_total{tool="log_metrics",outcome="denied"} 2');
    expect(output).toContain('mcp_tool_call_failures_total{tool="log_metrics",outcome="error"} 1');
    expect(output).toContain('mcp_tool_calls_total{tool="log_metrics",token="t1"} 3');
  });

  it("records call durations", async () => {
    const { app } = await buildObservedApp();
    app.observability.toolCalls.record({ tool: "whoami", token: "t", durationSeconds: 0.02 });
    app.observability.toolCalls.record({ tool: "whoami", token: "t", durationSeconds: 0.2 });
    const output = samples((await scrape(app)).body);
    expect(output).toContain('mcp_tool_call_duration_seconds_count{tool="whoami"} 2');
    expect(output).toContain('mcp_tool_call_duration_seconds_bucket{le="0.025",tool="whoami"} 1');
  });

  it("caps the number of distinct token and tool labels", async () => {
    const registry = new Registry();
    const toolCalls = createToolCallMetrics(registry, { maxTokens: 3, maxTools: 2 });
    for (let i = 0; i < 50; i++) toolCalls.record({ tool: `tool_${i % 5}`, token: `token-${i}` });

    const { values } = await registry.getSingleMetric("mcp_tool_calls_total")!.get();
    const tokens = new Set(values.map((v) => v.labels["token"]));
    const tools = new Set(values.map((v) => v.labels["tool"]));
    expect(tokens).toEqual(new Set(["token-0", "token-1", "token-2", OVERFLOW_LABEL]));
    expect(tools).toEqual(new Set(["tool_0", "tool_1", OVERFLOW_LABEL]));
    expect(values.length).toBeLessThanOrEqual(4 * 3);
    // Nothing is lost: every call is still counted, in the overflow series.
    expect(values.reduce((sum, v) => sum + v.value, 0)).toBe(50);
    expect(
      await metricValue(registry, "observability_label_overflow_total", {
        metric: "mcp_tool_calls_total",
        label: "token",
      }),
    ).toBe(47);
  });

  it("sanitizes and truncates label values taken from clients", async () => {
    const registry = new Registry();
    const toolCalls = createToolCallMetrics(registry);
    toolCalls.record({ tool: "x".repeat(500), token: "line1\nline2\u0000" });
    toolCalls.record({ tool: "  ", token: "" });
    const { values } = await registry.getSingleMetric("mcp_tool_calls_total")!.get();
    const labels = values.map((v) => v.labels);
    expect(labels).toContainEqual({ tool: "x".repeat(64), token: "line1?line2?" });
    expect(labels).toContainEqual({ tool: "unknown", token: "unknown" });
  });
});

describe("LabelGuard", () => {
  it("keeps seen values and folds new ones once the limit is reached", () => {
    let overflowed = 0;
    const guard = new LabelGuard(2, () => overflowed++);
    expect(guard.resolve("a")).toBe("a");
    expect(guard.resolve("b")).toBe("b");
    expect(guard.resolve("a")).toBe("a");
    expect(guard.resolve("c")).toBe(OVERFLOW_LABEL);
    expect(guard.resolve("b")).toBe("b");
    expect(guard.size).toBe(2);
    expect(overflowed).toBe(1);
  });
});

describe("metricValue", () => {
  it("reads one sample and returns undefined for unknown series", async () => {
    const registry = createMetricsRegistry({ service: "web-server", defaultMetrics: false });
    expect(await metricValue(registry, "ytw_build_info", { service: "web-server" })).toBe(1);
    expect(await metricValue(registry, "ytw_build_info", { service: "mcp" })).toBeUndefined();
    expect(await metricValue(registry, "no_such_metric")).toBeUndefined();
  });
});

describe("GET /metrics access", () => {
  const TOKEN = "metrics-scrape-token-0123456789";

  it("is open when no METRICS_TOKEN is configured", async () => {
    const { app } = await buildObservedApp();
    expect((await scrape(app)).statusCode).toBe(200);
  });

  it("rejects a missing, wrong or malformed credential and accepts the right one", async () => {
    const { app } = await buildObservedApp({ metricsToken: TOKEN });

    const missing = await scrape(app);
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toMatch(/^Bearer/);
    expect(missing.body).not.toContain("http_requests_total");

    const rejected = [
      `Bearer ${TOKEN}x`,
      "Bearer short",
      `Bearer ${TOKEN.toUpperCase()}`,
      TOKEN,
      `Basic ${Buffer.from(`u:${TOKEN}`).toString("base64")}`,
      "Bearer ",
    ];
    const statuses: Array<[string, number]> = [];
    for (const header of rejected) {
      const res = await scrape(app, { authorization: header });
      statuses.push([header, res.statusCode]);
    }
    expect(statuses).toEqual(rejected.map((header) => [header, 401]));

    const ok = await scrape(app, { authorization: `Bearer ${TOKEN}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("ytw_build_info");
    expect(ok.headers["cache-control"]).toBe("no-store");
  });

  it("never writes the scrape token to the log", async () => {
    const { app, sink } = await buildObservedApp({ metricsToken: TOKEN });
    await scrape(app, { authorization: `Bearer ${TOKEN}` });
    await scrape(app, { authorization: `Bearer ${TOKEN}-wrong` });
    expect(sink.text).not.toContain(TOKEN);
  });
});
