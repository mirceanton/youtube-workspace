/**
 * What a single process needs to be operated: request ids, HTTP metrics and the three operations
 * endpoints `/healthz` (liveness), `/readyz` (readiness) and `/metrics` (Prometheus).
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { HealthResponse, ReadinessResponse } from "@ytw/shared/api/health";
import type { FastifyInstance } from "fastify";
import { UNMATCHED_ROUTE, type Metrics } from "./metrics.js";

export { createLogger, LOG_LEVELS, type LogLevel, type LogSink, type Logger } from "./logger.js";
export { createMetrics, type Metrics, type ToolCall } from "./metrics.js";

const REQUEST_ID_HEADER = "x-request-id";
const VALID_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Fastify `genReqId`: reuses a well-formed `X-Request-Id` so a request can be followed across a
 * proxy, and otherwise generates a UUID. A malformed value is dropped rather than logged: the
 * header is attacker-controlled and ends up in every log line.
 */
export function generateRequestId(request: IncomingMessage): string {
  const header = request.headers[REQUEST_ID_HEADER];
  return typeof header === "string" && VALID_REQUEST_ID.test(header) ? header : randomUUID();
}

/** A readiness check resolves to whether the dependency is usable; a throw counts as not usable. */
export type ReadinessCheck = () => Promise<boolean>;

export interface ObservabilityOptions {
  version: string;
  commit: string;
  metrics: Metrics;
  /** Named checks run on `/readyz`. */
  checks: Record<string, ReadinessCheck>;
  /** `METRICS_TOKEN`: when set, `/metrics` needs `Authorization: Bearer <token>`. */
  metricsToken?: string | undefined;
}

const CHECK_TIMEOUT_MS = 2000;
/** `/readyz` is unauthenticated: reuse a result for this long so it cannot become a query stream. */
const READINESS_CACHE_MS = 2000;

/** SHA-256 of the value, so two secrets of different lengths compare in constant time. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

async function runCheck(check: ReadinessCheck, onError: (error: unknown) => void) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([check(), timeout]);
  } catch (error) {
    // The caller learns only that the check failed; the log gets the reason.
    onError(error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Registers the request-id header, the HTTP metrics hook and the operations endpoints. */
export function registerObservability(app: FastifyInstance, options: ObservabilityOptions): void {
  const { metrics } = options;

  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });
  app.addHook("onResponse", async (request, reply) => {
    metrics.recordHttp(
      {
        method: request.method,
        route: request.routeOptions.url ?? UNMATCHED_ROUTE,
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  // Probes log at warn so scrapes do not flood the request log; failures still show up.
  const health: HealthResponse = {
    status: "ok",
    version: options.version,
    commit: options.commit,
  };
  app.get("/healthz", { logLevel: "warn" }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return health;
  });

  let cached: { at: number; response: ReadinessResponse } | undefined;
  let inFlight: Promise<ReadinessResponse> | undefined;
  const evaluate = async (): Promise<ReadinessResponse> => {
    const results = await Promise.all(
      Object.entries(options.checks).map(async ([name, check]) => {
        const ok = await runCheck(check, (error) =>
          app.log.warn({ err: error, check: name }, "readiness check failed"),
        );
        return [name, ok ? "ok" : "fail"] as const;
      }),
    );
    return {
      status: results.every(([, outcome]) => outcome === "ok") ? "ready" : "unavailable",
      checks: Object.fromEntries(results),
    };
  };
  const readiness = (): Promise<ReadinessResponse> => {
    if (cached !== undefined && Date.now() - cached.at < READINESS_CACHE_MS) {
      return Promise.resolve(cached.response);
    }
    inFlight ??= evaluate()
      .then((response) => {
        cached = { at: Date.now(), response };
        return response;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  app.get("/readyz", { logLevel: "warn" }, async (_request, reply) => {
    const response = await readiness();
    reply.header("cache-control", "no-store");
    reply.code(response.status === "ready" ? 200 : 503);
    return response;
  });

  const expectedToken =
    options.metricsToken === undefined ? undefined : digest(options.metricsToken);
  app.get("/metrics", { logLevel: "warn" }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (expectedToken !== undefined) {
      const supplied = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? "")?.[1];
      if (supplied === undefined || !timingSafeEqual(digest(supplied), expectedToken)) {
        return reply
          .code(401)
          .header("www-authenticate", 'Bearer realm="metrics"')
          .send({ error: "unauthorized" });
      }
    }
    return reply
      .header("content-type", metrics.registry.contentType)
      .send(await metrics.registry.metrics());
  });
}
