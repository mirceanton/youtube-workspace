/**
 * @ytw/observability: logging with secret redaction, request ids, Prometheus metrics,
 * health/readiness helpers and environment loading, shared by the web server and the MCP server
 * (PRD 9). See docs/observability.md.
 */
export {
  EnvError,
  baseEnvShape,
  describeEnv,
  loadEnv,
  renderEnvTable,
  type EnvVariableDoc,
} from "./env.js";
export {
  healthPlugin,
  readinessResponseSchema,
  type HealthOptions,
  type ReadinessCheck,
  type ReadinessCheckResult,
  type ReadinessResponse,
} from "./health.js";
export {
  LOG_LEVELS,
  createLogger,
  secretValuesFromEnv,
  type CreateLoggerOptions,
  type LogLevel,
  type LogSink,
  type Logger,
} from "./logger.js";
export {
  LabelGuard,
  OVERFLOW_LABEL,
  Registry,
  UNMATCHED_ROUTE,
  createHttpMetrics,
  createMetricsRegistry,
  createToolCallMetrics,
  httpMetricsPlugin,
  metricValue,
  type CreateRegistryOptions,
  type HttpMetrics,
  type ToolCall,
  type ToolCallMetrics,
  type ToolCallMetricsOptions,
  type ToolCallOutcome,
} from "./metrics.js";
export { metricsRoutePlugin, type MetricsRouteOptions } from "./metrics-route.js";
export { observabilityPlugin, type Observability, type ObservabilityOptions } from "./plugin.js";
export {
  MAX_REDACT_DEPTH,
  MAX_SCRUB_LENGTH,
  REDACTED,
  SCRUB_HEAD_LENGTH,
  SCRUB_TAIL_LENGTH,
  createLineScrubber,
  createStringScrubber,
  isSensitiveKey,
  redact,
  scrubString,
} from "./redact.js";
export {
  REQUEST_ID_HEADER,
  actorLogFields,
  bindActor,
  fastifyLoggingOptions,
  generateRequestId,
  requestIdPlugin,
  withActor,
  type LogActor,
} from "./request-context.js";
