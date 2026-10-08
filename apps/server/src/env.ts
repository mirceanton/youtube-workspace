import { z } from "zod";
import { LOG_LEVELS } from "./observability/index.js";
import {
  checkBootstrapSecret,
  DEFAULT_BOOTSTRAP_PERMISSIONS,
  parseBootstrapPermissions,
  type BootstrapToken,
} from "./tokens/bootstrap.js";

/** Thrown by {@link loadEnv}; the message lists every invalid variable and never a value. */
export class EnvError extends Error {
  override name = "EnvError";
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** OIDC endpoints carry credentials and codes: HTTPS, except on the local machine. */
function isSecureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || isLoopback(url.hostname);
  } catch {
    return true; // not a URL: the format check reports that
  }
}

const seconds = z.coerce.number().int().min(60).max(31_622_400);
const requiredWithOidc = { error: "required when any OIDC_* variable is set" };

const baseSchema = z.object({
  DATABASE_URL: z.url(),
  HOST: z.string().min(1).default("0.0.0.0"),
  // 0 picks a free port, which the tests use.
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  APP_VERSION: z.string().min(1).default("0.0.0-dev"),
  GIT_SHA: z.string().min(1).default("unknown"),
  STATIC_WEB_DIR: z.string().min(1).optional(),
  METRICS_TOKEN: z.string().min(16).optional(),
  MCP_BOOTSTRAP_TOKEN: z
    .string()
    .refine((secret) => checkBootstrapSecret(secret) === null, {
      error: "must be `ytw_` followed by 43 base64url characters (see the README)",
    })
    .optional(),
  MCP_BOOTSTRAP_TOKEN_NAME: z.string().min(1).max(100).default("bootstrap"),
  MCP_BOOTSTRAP_TOKEN_PERMISSIONS: z
    .string()
    .default(DEFAULT_BOOTSTRAP_PERMISSIONS)
    .transform((text, ctx) => {
      const parsed = parseBootstrapPermissions(text);
      if (parsed.ok) return parsed.permissions;
      for (const problem of parsed.problems) ctx.addIssue({ code: "custom", message: problem });
      return z.NEVER;
    }),
});

/** Read only when some `OIDC_*` variable is set: then all of it is required. */
const oidcSchema = z.object({
  OIDC_ISSUER_URL: z
    .url(requiredWithOidc)
    .refine(isSecureUrl, { error: "use HTTPS outside localhost" }),
  OIDC_CLIENT_ID: z.string(requiredWithOidc).min(1),
  OIDC_CLIENT_SECRET: z.string(requiredWithOidc).min(1),
  OIDC_REDIRECT_URI: z
    .url(requiredWithOidc)
    .refine(isSecureUrl, { error: "use HTTPS outside localhost" }),
  OIDC_GROUPS_CLAIM_PATH: z.string().min(1).default("groups"),
  OIDC_REQUIRED_GROUP: z.string().min(1).optional(),
  SESSION_SECRET: z.string(requiredWithOidc).min(32),
  SESSION_IDLE_TIMEOUT: seconds.default(28_800),
  SESSION_ABSOLUTE_TIMEOUT: seconds.default(604_800),
});

/** Settings of the OIDC login; present only when the server runs with a login. */
export interface OidcConfig {
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly groupsClaimPath: string;
  /** When set, only members of this group may sign in. */
  readonly requiredGroup: string | undefined;
  /** Signs the CSRF tokens and encrypts what the database keeps of a session. */
  readonly sessionSecret: string;
  readonly idleTimeoutSeconds: number;
  readonly absoluteTimeoutSeconds: number;
}

export interface Env {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly appVersion: string;
  readonly gitSha: string;
  readonly staticWebDir: string | undefined;
  readonly metricsToken: string | undefined;
  /** Null: single-user mode, every web request is the local owner. */
  readonly oidc: OidcConfig | null;
  /** Null: no seeded token, and an existing one is revoked on boot. */
  readonly bootstrapToken: BootstrapToken | null;
}

/**
 * Validates the environment and returns it parsed, or throws {@link EnvError} naming every bad
 * variable so one startup attempt shows all the problems. An empty value counts as unset. Values
 * are never echoed in the message, because several variables are secrets.
 */
export function loadEnv(source: Readonly<Record<string, string | undefined>> = process.env): Env {
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  );
  const base = baseSchema.safeParse(present);
  // Any OIDC_* variable means the operator wants a login: a half-configured one must not quietly
  // fall back to single-user mode, where nobody is asked to sign in.
  const wantsOidc = Object.keys(present).some((name) => name.startsWith("OIDC_"));
  const oidc = wantsOidc ? oidcSchema.safeParse(present) : undefined;

  if (!base.success || (oidc !== undefined && !oidc.success)) {
    const issues = [
      ...(base.success ? [] : base.error.issues),
      ...(oidc === undefined || oidc.success ? [] : oidc.error.issues),
    ];
    const lines = issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    throw new EnvError(`Invalid environment:\n${lines.join("\n")}`);
  }

  const v = base.data;
  return {
    databaseUrl: v.DATABASE_URL,
    host: v.HOST,
    port: v.PORT,
    logLevel: v.LOG_LEVEL,
    appVersion: v.APP_VERSION,
    gitSha: v.GIT_SHA,
    staticWebDir: v.STATIC_WEB_DIR,
    metricsToken: v.METRICS_TOKEN,
    oidc:
      oidc === undefined
        ? null
        : {
            issuerUrl: oidc.data.OIDC_ISSUER_URL,
            clientId: oidc.data.OIDC_CLIENT_ID,
            clientSecret: oidc.data.OIDC_CLIENT_SECRET,
            redirectUri: oidc.data.OIDC_REDIRECT_URI,
            groupsClaimPath: oidc.data.OIDC_GROUPS_CLAIM_PATH,
            requiredGroup: oidc.data.OIDC_REQUIRED_GROUP,
            sessionSecret: oidc.data.SESSION_SECRET,
            idleTimeoutSeconds: oidc.data.SESSION_IDLE_TIMEOUT,
            absoluteTimeoutSeconds: oidc.data.SESSION_ABSOLUTE_TIMEOUT,
          },
    bootstrapToken:
      v.MCP_BOOTSTRAP_TOKEN === undefined
        ? null
        : {
            secret: v.MCP_BOOTSTRAP_TOKEN,
            name: v.MCP_BOOTSTRAP_TOKEN_NAME,
            permissions: v.MCP_BOOTSTRAP_TOKEN_PERMISSIONS,
          },
  };
}
