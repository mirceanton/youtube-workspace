import { SERVICES, type HealthResponse, type Service } from "@ytw/shared/api/health";
import fp from "fastify-plugin";
import { z } from "zod";
import { scrubString } from "./redact.js";

/**
 * A readiness check. It resolves when the dependency is usable and either throws or returns
 * `{ ok: false, detail }` when it is not. The observability package knows nothing about the
 * database: the app injects the checks, for example
 *
 * ```ts
 * checks: {
 *   database: async () => { await pool.query("select 1"); },
 *   migrations: async () => {
 *     const pending = await pendingMigrations(pool);
 *     return pending.length === 0 ? undefined : { ok: false, detail: `${pending.length} pending` };
 *   },
 * }
 * ```
 */
export type ReadinessCheck = () => Promise<void | ReadinessCheckResult>;

export interface ReadinessCheckResult {
  ok: boolean;
  /** Short, non-sensitive explanation shown to the caller when `ok` is false. */
  detail?: string;
}

/** Body of `GET /readyz` (200 when ready, 503 otherwise). */
export const readinessResponseSchema = z.object({
  status: z.enum(["ready", "unavailable"]),
  service: z.enum(SERVICES),
  checks: z.record(
    z.string(),
    z.object({ status: z.enum(["ok", "fail"]), detail: z.string().optional() }),
  ),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

export interface HealthOptions {
  service: Service;
  version: string;
  commit: string;
  /** Named checks run on every `/readyz`; none means the process is ready as soon as it listens. */
  checks?: Record<string, ReadinessCheck>;
  /** A check that takes longer than this counts as failed. Default 2000 ms. */
  checkTimeoutMs?: number;
  /**
   * How long a result is reused. `/readyz` is unauthenticated, so without this a caller could turn
   * it into a stream of database queries. Concurrent calls always share one run. Default 1000 ms.
   */
  cacheMs?: number;
}

type CheckOutcome = ReadinessResponse["checks"][string];

const MAX_DETAIL_LENGTH = 200;

async function runCheck(
  check: ReadinessCheck,
  timeoutMs: number,
  onError: (error: unknown) => void,
): Promise<CheckOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref();
  });
  try {
    const result = await Promise.race([check(), timeout]);
    if (result === "timeout") return { status: "fail", detail: `timed out after ${timeoutMs} ms` };
    if (result && !result.ok) {
      const detail = result.detail ? scrubString(result.detail).slice(0, MAX_DETAIL_LENGTH) : "";
      return detail ? { status: "fail", detail } : { status: "fail" };
    }
    return { status: "ok" };
  } catch (error) {
    // The caller gets no error text (it could name hosts or users); the log gets all of it.
    onError(error);
    return { status: "fail", detail: "check failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registers the probe routes on both services:
 * - `GET /healthz`: liveness; 200 with service, version and commit (the shared `HealthResponse`).
 * - `GET /readyz`: readiness; runs the injected checks, 200 `ready` or 503 `unavailable`.
 */
export const healthPlugin = fp<HealthOptions>(
  async (app, options) => {
    const checks = Object.entries(options.checks ?? {});
    const timeoutMs = options.checkTimeoutMs ?? 2000;
    const cacheMs = options.cacheMs ?? 1000;

    const health: HealthResponse = {
      status: "ok",
      service: options.service,
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
        checks.map(async ([name, check]) => {
          const outcome = await runCheck(check, timeoutMs, (error) =>
            app.log.warn({ err: error, check: name }, "readiness check failed"),
          );
          return [name, outcome] as const;
        }),
      );
      const failed = results.some(([, outcome]) => outcome.status === "fail");
      return {
        status: failed ? "unavailable" : "ready",
        service: options.service,
        checks: Object.fromEntries(results),
      };
    };

    const readiness = async (): Promise<ReadinessResponse> => {
      if (cached && Date.now() - cached.at < cacheMs) return cached.response;
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
  },
  { name: "ytw-health", fastify: "5.x" },
);
