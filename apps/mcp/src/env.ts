import { baseEnvShape, EnvError, loadEnv as baseLoadEnv } from "@ytw/observability";
import { z } from "zod";

/**
 * Environment variables read by the MCP server (PRD 9). Every setting comes from the environment;
 * the process refuses to start when a value is malformed. An empty value counts as unset.
 */
export const envSchema = z.object({
  ...baseEnvShape({ port: 3001 }),
  // Allow port 0 for testing ephemeral ports
  PORT: z.coerce.number().int().min(0).max(65535).default(3001).describe("Port to listen on."),
  DATABASE_URL: z
    .string()
    .url()
    .default("postgres://ytw_mcp:ytw_mcp@localhost:5432/youtube_workspace")
    .describe("PostgreSQL connection string used for MCP operations."),
  READONLY_DATABASE_URL: z
    .string()
    .url()
    .optional()
    .describe(
      "Optional PostgreSQL connection string used by query_sql. When unset, query_sql uses DATABASE_URL inside a read-only transaction.",
    ),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Readonly<Record<string, string | undefined>> = process.env): Env {
  return baseLoadEnv(envSchema, source, { service: "mcp" });
}

export { EnvError };
