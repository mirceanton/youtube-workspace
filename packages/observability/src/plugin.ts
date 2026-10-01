import type { Service } from "@ytw/shared/api/health";
import fp from "fastify-plugin";
import type { Registry } from "prom-client";
import { healthPlugin, type ReadinessCheck } from "./health.js";
import {
  createHttpMetrics,
  createMetricsRegistry,
  createToolCallMetrics,
  httpMetricsPlugin,
  type ToolCallMetrics,
  type ToolCallMetricsOptions,
} from "./metrics.js";
import { metricsRoutePlugin } from "./metrics-route.js";
import { requestIdPlugin } from "./request-context.js";

export interface ObservabilityOptions {
  service: Service;
  version: string;
  commit: string;
  /** Readiness checks for `/readyz`, injected by the app (database ping, migrations current, ...). */
  readiness?: Record<string, ReadinessCheck>;
  readinessTimeoutMs?: number;
  readinessCacheMs?: number;
  /** `METRICS_TOKEN`: when set, `/metrics` needs `Authorization: Bearer <token>`. */
  metricsToken?: string | undefined;
  /** Collect Node.js process metrics. Default true. */
  defaultMetrics?: boolean;
  /** Cardinality limits of the MCP tool-call metrics. */
  toolCalls?: ToolCallMetricsOptions;
}

/** What {@link observabilityPlugin} adds to the Fastify instance as `app.observability`. */
export interface Observability {
  registry: Registry;
  /** Record every MCP tool call here (`mcp_tool_calls_total{tool,token}` and friends). */
  toolCalls: ToolCallMetrics;
}

declare module "fastify" {
  interface FastifyInstance {
    observability: Observability;
  }
}

/**
 * One call that wires the whole package into a Fastify app: the `X-Request-Id` response header,
 * HTTP request metrics, `/healthz`, `/readyz` and `/metrics`, and `app.observability` for custom
 * metrics. Request ids and the logger itself are constructor options; see `fastifyLoggingOptions`.
 *
 * ```ts
 * const logger = createLogger({ service: "mcp", level: env.LOG_LEVEL, secrets: secretValuesFromEnv() });
 * const app = Fastify({ ...fastifyLoggingOptions(logger) });
 * await app.register(observabilityPlugin, { service: "mcp", version, commit, readiness: { ... } });
 * ```
 */
export const observabilityPlugin = fp<ObservabilityOptions>(
  async (app, options) => {
    const registry = createMetricsRegistry({
      service: options.service,
      version: options.version,
      commit: options.commit,
      defaultMetrics: options.defaultMetrics ?? true,
    });

    app.decorate("observability", {
      registry,
      toolCalls: createToolCallMetrics(registry, options.toolCalls),
    });

    await app.register(requestIdPlugin);
    await app.register(httpMetricsPlugin, { metrics: createHttpMetrics(registry) });
    await app.register(healthPlugin, {
      service: options.service,
      version: options.version,
      commit: options.commit,
      checks: options.readiness,
      checkTimeoutMs: options.readinessTimeoutMs,
      cacheMs: options.readinessCacheMs,
    });
    await app.register(metricsRoutePlugin, { registry, token: options.metricsToken });
  },
  { name: "ytw-observability", fastify: "5.x" },
);
