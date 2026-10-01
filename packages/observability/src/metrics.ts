import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { Service } from "@ytw/shared/api/health";
import fp from "fastify-plugin";

export { Registry } from "prom-client";

// Everything that touches prom-client lives in this file, so replacing the library (npm marks
// `prom-client` as superseded by `@prometheus-io/client`, which has the same API) is a local change.

export interface CreateRegistryOptions {
  service: Service;
  version?: string;
  commit?: string;
  /** Collect Node.js process metrics (event loop, memory, GC, handles). Default true. */
  defaultMetrics?: boolean;
}

/**
 * One registry per process. It is not the prom-client global, so tests and multiple apps in one
 * process never share counters. Carries `ytw_build_info` and, by default, the Node.js metrics.
 */
export function createMetricsRegistry(options: CreateRegistryOptions): Registry {
  const registry = new Registry();
  if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: registry });

  const buildInfo = new Gauge({
    name: "ytw_build_info",
    help: "Constant 1, labeled with the service, release version and git commit.",
    labelNames: ["service", "version", "commit"] as const,
    registers: [registry],
  });
  buildInfo.set(
    {
      service: options.service,
      version: options.version ?? "unknown",
      commit: options.commit ?? "unknown",
    },
    1,
  );
  return registry;
}

/**
 * Reads one sample back, for tests: `await metricValue(registry, "http_requests_total",
 * { method: "GET", route: "/healthz", status: "200" })`. Returns `undefined` if there is no such series.
 */
export async function metricValue(
  registry: Registry,
  name: string,
  labels: Record<string, string> = {},
): Promise<number | undefined> {
  const metric = registry.getSingleMetric(name);
  if (!metric) return undefined;
  const { values } = await metric.get();
  const wanted = Object.entries(labels);
  const match = values.find((sample) =>
    wanted.every(([key, value]) => sample.labels[key] === value),
  );
  return match?.value;
}

// ---------------------------------------------------------------------------------------------
// HTTP metrics
// ---------------------------------------------------------------------------------------------

const HTTP_LABELS = ["method", "route", "status"] as const;

export interface HttpMetrics {
  requests: Counter<(typeof HTTP_LABELS)[number]>;
  duration: Histogram<(typeof HTTP_LABELS)[number]>;
}

export function createHttpMetrics(registry: Registry): HttpMetrics {
  return {
    requests: new Counter({
      name: "http_requests_total",
      help: "HTTP requests handled, by method, matched route pattern and status code.",
      labelNames: HTTP_LABELS,
      registers: [registry],
    }),
    duration: new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request duration in seconds, by method, matched route pattern and status code.",
      labelNames: HTTP_LABELS,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
  };
}

/** Label for requests that matched no route (404s, scanners): one series instead of one per URL. */
export const UNMATCHED_ROUTE = "unmatched";

/**
 * Records `http_requests_total` (request rate and, through the `status` label, error rate) and
 * `http_request_duration_seconds` (latency) for every response. The route label is the matched
 * pattern (`/api/ideas/:id`), never the concrete URL, so cardinality stays bounded.
 */
export const httpMetricsPlugin = fp<{ metrics: HttpMetrics }>(
  async (app, options) => {
    const { requests, duration } = options.metrics;
    app.addHook("onResponse", async (request, reply) => {
      const labels = {
        method: request.method,
        route: request.routeOptions.url ?? UNMATCHED_ROUTE,
        status: String(reply.statusCode),
      };
      requests.inc(labels);
      duration.observe(labels, reply.elapsedTime / 1000);
    });
  },
  { name: "ytw-http-metrics", fastify: "5.x" },
);

// ---------------------------------------------------------------------------------------------
// MCP tool call metrics
// ---------------------------------------------------------------------------------------------

/** Label value that absorbs every tool or token beyond the configured limit. */
export const OVERFLOW_LABEL = "__other__";

const MAX_LABEL_LENGTH = 64;

/** Makes a client-influenced string safe and short enough to be a label value. */
function sanitizeLabel(raw: string): string {
  let cleaned = "";
  for (const char of raw.trim()) {
    const code = char.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || code === 0x7f ? "?" : char;
  }
  const truncated = cleaned.slice(0, MAX_LABEL_LENGTH);
  return truncated.length > 0 ? truncated : "unknown";
}

/**
 * Bounds the number of distinct values a label can take. The first `max` values are kept as they
 * are; later new values collapse into {@link OVERFLOW_LABEL} (and `onOverflow` is called each time,
 * so the overflow can be counted). Without this, a client that invents tool names or an owner who
 * creates thousands of tokens would grow the metrics registry without bound.
 */
export class LabelGuard {
  readonly #seen = new Set<string>();
  readonly #max: number;
  readonly #onOverflow: (() => void) | undefined;

  constructor(max: number, onOverflow?: () => void) {
    this.#max = max;
    this.#onOverflow = onOverflow;
  }

  resolve(raw: string): string {
    const value = sanitizeLabel(raw);
    if (this.#seen.has(value)) return value;
    if (this.#seen.size < this.#max) {
      this.#seen.add(value);
      return value;
    }
    this.#onOverflow?.();
    return OVERFLOW_LABEL;
  }

  get size(): number {
    return this.#seen.size;
  }
}

export type ToolCallOutcome = "ok" | "error" | "denied";

export interface ToolCall {
  /** MCP tool name. */
  tool: string;
  /** Name of the API token that made the call (a name, never the token). */
  token: string;
  /** Default `ok`. `error` is a handler failure, `denied` a permission refusal. */
  outcome?: ToolCallOutcome;
  /** Handler duration in seconds, if measured. */
  durationSeconds?: number;
}

export interface ToolCallMetricsOptions {
  /** Distinct tool names tracked before the rest become `__other__`. Default 200. */
  maxTools?: number;
  /** Distinct token names tracked before the rest become `__other__`. Default 100. */
  maxTokens?: number;
}

export interface ToolCallMetrics {
  /** Counts one tool call: `mcp_tool_calls_total{tool,token}` always, failures and duration as given. */
  record(call: ToolCall): void;
}

/**
 * Creates the MCP tool-call metrics (PRD 9: "MCP tool call counts by tool and token"):
 * `mcp_tool_calls_total{tool,token}`, `mcp_tool_call_failures_total{tool,outcome}` and
 * `mcp_tool_call_duration_seconds{tool}`. Tool and token labels pass through a {@link LabelGuard}.
 */
export function createToolCallMetrics(
  registry: Registry,
  options: ToolCallMetricsOptions = {},
): ToolCallMetrics {
  const overflow = new Counter({
    name: "observability_label_overflow_total",
    help: "Label values folded into __other__ because the cardinality limit was reached.",
    labelNames: ["metric", "label"] as const,
    registers: [registry],
  });
  const calls = new Counter({
    name: "mcp_tool_calls_total",
    help: "MCP tool calls, by tool and API token name.",
    labelNames: ["tool", "token"] as const,
    registers: [registry],
  });
  const failures = new Counter({
    name: "mcp_tool_call_failures_total",
    help: "MCP tool calls that failed (error) or were refused for lack of permission (denied).",
    labelNames: ["tool", "outcome"] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: "mcp_tool_call_duration_seconds",
    help: "MCP tool call duration in seconds, by tool.",
    labelNames: ["tool"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const tools = new LabelGuard(options.maxTools ?? 200, () =>
    overflow.inc({ metric: "mcp_tool_calls_total", label: "tool" }),
  );
  const tokens = new LabelGuard(options.maxTokens ?? 100, () =>
    overflow.inc({ metric: "mcp_tool_calls_total", label: "token" }),
  );

  return {
    record(call) {
      const tool = tools.resolve(call.tool);
      const token = tokens.resolve(call.token);
      calls.inc({ tool, token });
      const outcome = call.outcome ?? "ok";
      if (outcome !== "ok") failures.inc({ tool, outcome });
      if (call.durationSeconds !== undefined) duration.observe({ tool }, call.durationSeconds);
    },
  };
}
