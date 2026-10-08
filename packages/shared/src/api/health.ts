import { z } from "zod";

/** Body of `GET /healthz` (liveness only; readiness is `/readyz`). */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  /** Release version from the `APP_VERSION` environment variable. */
  version: z.string().min(1),
  /** Git commit from the `GIT_SHA` environment variable. */
  commit: z.string().min(1),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Body of `GET /readyz`: 200 when `ready`, 503 when `unavailable`. */
export const readinessResponseSchema = z.object({
  status: z.enum(["ready", "unavailable"]),
  checks: z.record(z.string(), z.enum(["ok", "fail"])),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
