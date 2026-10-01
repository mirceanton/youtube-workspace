import { z } from "zod";

/** The two HTTP processes built from this repository. */
export const SERVICES = ["web-server", "mcp"] as const;
export type Service = (typeof SERVICES)[number];

/** Body of `GET /healthz` on both services (liveness only; readiness is `/readyz`). */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.enum(SERVICES),
  /** Release version from the `APP_VERSION` environment variable. */
  version: z.string().min(1),
  /** Git commit from the `GIT_SHA` environment variable. */
  commit: z.string().min(1),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
