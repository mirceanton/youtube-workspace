import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export { Registry } from "prom-client";

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const HTTP_LABELS = ["method", "route", "status"] as const;

/** Label for requests that matched no route (404s, scanners): one series instead of one per URL. */
export const UNMATCHED_ROUTE = "unmatched";

export type ToolCallOutcome = "ok" | "error" | "denied";

export interface ToolCall {
  tool: string;
  /** Name of the API token that made the call (a name, never the token). */
  token: string;
  outcome: ToolCallOutcome;
  durationSeconds: number;
}

export interface Metrics {
  registry: Registry;
  /** Counts one MCP tool call by tool and token, with failures and duration. */
  recordToolCall(call: ToolCall): void;
  /** Records `http_requests_total` and `http_request_duration_seconds` for one response. */
  recordHttp(labels: Record<(typeof HTTP_LABELS)[number], string>, seconds: number): void;
}

/**
 * One registry per process (not the prom-client global, so tests never share counters). Carries
 * `ytw_build_info`, the Node.js process metrics, the HTTP metrics (the route label is the matched
 * pattern, never the concrete URL) and the MCP tool-call metrics.
 */
export function createMetrics(info: { version: string; commit: string }): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  new Gauge({
    name: "ytw_build_info",
    help: "Constant 1, labeled with the release version and git commit.",
    labelNames: ["version", "commit"] as const,
    registers: [registry],
  }).set(info, 1);

  const requests = new Counter({
    name: "http_requests_total",
    help: "HTTP requests handled, by method, matched route pattern and status code.",
    labelNames: HTTP_LABELS,
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds, by method, matched route pattern and status code.",
    labelNames: HTTP_LABELS,
    buckets: BUCKETS,
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
  const toolDuration = new Histogram({
    name: "mcp_tool_call_duration_seconds",
    help: "MCP tool call duration in seconds, by tool.",
    labelNames: ["tool"] as const,
    buckets: BUCKETS,
    registers: [registry],
  });

  return {
    registry,
    recordHttp(labels, seconds) {
      requests.inc(labels);
      httpDuration.observe(labels, seconds);
    },
    recordToolCall(call) {
      calls.inc({ tool: call.tool, token: call.token });
      if (call.outcome !== "ok") failures.inc({ tool: call.tool, outcome: call.outcome });
      toolDuration.observe({ tool: call.tool }, call.durationSeconds);
    },
  };
}
