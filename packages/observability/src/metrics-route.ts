import { createHash, timingSafeEqual } from "node:crypto";
import fp from "fastify-plugin";
import type { Registry } from "prom-client";

export interface MetricsRouteOptions {
  registry: Registry;
  /**
   * When set (`METRICS_TOKEN`), `GET /metrics` requires `Authorization: Bearer <token>`. Without it
   * the endpoint is open, which is fine on a private network; the metrics include API token names.
   */
  token?: string | undefined;
}

/** SHA-256 of the value, so two secrets of different lengths compare in constant time. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1];
}

/**
 * Registers `GET /metrics` (Prometheus text format). Probe-style routes log at `warn` so scrapes
 * do not flood the request log; failures still show up.
 */
export const metricsRoutePlugin = fp<MetricsRouteOptions>(
  async (app, options) => {
    const expected = options.token ? digest(options.token) : undefined;

    app.get("/metrics", { logLevel: "warn" }, async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (expected) {
        const supplied = bearerToken(request.headers.authorization);
        if (supplied === undefined || !timingSafeEqual(digest(supplied), expected)) {
          return reply
            .code(401)
            .header("www-authenticate", 'Bearer realm="metrics"')
            .send({ error: "unauthorized" });
        }
      }
      return reply
        .header("content-type", options.registry.contentType)
        .send(await options.registry.metrics());
    });
  },
  { name: "ytw-metrics-route", fastify: "5.x" },
);
