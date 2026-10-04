import { baseEnvShape, EnvError, loadEnv as loadBaseEnv } from "@ytw/observability";
import { z } from "zod";

/**
 * Environment variables read by the web server. Every setting comes from the environment (PRD 9);
 * the process refuses to start when a value is malformed. An empty value counts as unset.
 */
export const envSchema = z.object({
  ...baseEnvShape({ port: 3000 }),
  DATABASE_URL: z.string().url().describe("PostgreSQL connection string for the ytw_web role."),
  OIDC_ISSUER_URL: z.url().describe("Issuer URL used for OpenID Connect discovery."),
  OIDC_CLIENT_ID: z.string().min(1).describe("Confidential OpenID Connect client id."),
  OIDC_CLIENT_SECRET: z.string().min(1).describe("Confidential OpenID Connect client secret."),
  OIDC_REDIRECT_URI: z.url().describe("Registered callback URI for the authorization code flow."),
  OIDC_GROUPS_CLAIM_PATH: z.string().min(1).describe("Dot or slash path to the group claim."),
  OIDC_REQUIRED_GROUP: z.string().min(1).describe("Group required for workspace access."),
  SESSION_SECRET: z
    .string()
    .min(32)
    .describe("Secret used to encrypt server-side OIDC state and refresh tokens."),
  SESSION_IDLE_TIMEOUT: z.coerce
    .number()
    .int()
    .min(60)
    .max(31_622_400)
    .default(28_800)
    .describe("Idle session timeout in seconds."),
  SESSION_ABSOLUTE_TIMEOUT: z.coerce
    .number()
    .int()
    .min(60)
    .max(31_622_400)
    .default(604_800)
    .describe("Absolute session timeout in seconds."),
  STATIC_WEB_DIR: z.string().min(1).optional().describe("Built SPA directory, when packaged."),
});

export type Env = z.infer<typeof envSchema>;

/** Thrown when the environment does not match {@link envSchema}; the message lists every problem. */
export function loadEnv(source: Readonly<Record<string, string | undefined>> = process.env): Env {
  const env = loadBaseEnv(envSchema, source, { service: "web-server" });
  const issuer = new URL(env.OIDC_ISSUER_URL);
  const redirect = new URL(env.OIDC_REDIRECT_URI);
  if (issuer.protocol !== "https:" && !isLoopback(issuer.hostname)) {
    throw new EnvError(
      "Invalid environment for web-server:\n  - OIDC_ISSUER_URL: use HTTPS outside localhost",
    );
  }
  if (redirect.protocol !== "https:" && !isLoopback(redirect.hostname)) {
    throw new EnvError(
      "Invalid environment for web-server:\n  - OIDC_REDIRECT_URI: use HTTPS outside localhost",
    );
  }
  return env;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export { EnvError };
