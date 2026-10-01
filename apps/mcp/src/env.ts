import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/**
 * Environment variables read by the MCP server. Every setting comes from the environment (PRD 9);
 * the process refuses to start when a value is malformed. An empty value counts as unset.
 */
export const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  /** Release version and git commit, stamped into container images at build time. */
  APP_VERSION: z.string().default("0.0.0-dev"),
  GIT_SHA: z.string().default("unknown"),
});

export type Env = z.infer<typeof envSchema>;

/** Thrown when the environment does not match {@link envSchema}; the message lists every problem. */
export class EnvError extends Error {
  override name = "EnvError";
}

export function loadEnv(source: Readonly<Record<string, string | undefined>> = process.env): Env {
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = envSchema.safeParse(present);
  if (!result.success) {
    throw new EnvError(`Invalid environment for mcp:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
