/**
 * The MCP token handed to the server through its environment (`MCP_BOOTSTRAP_TOKEN*`): parsing of
 * its settings and the boot-time reconciliation with the database. The rules for what changes are in
 * `seedApiToken`; here only the secret is hashed and the permission list read.
 */
import { seedApiToken, type Queryable, type SeedApiTokenResult } from "@ytw/db";
import { GRANTABLE_LEVELS, RESOURCES, type Level, type Resource } from "@ytw/shared/constants";
import { hashToken, isTokenShaped, tokenPrefix } from "./secret.js";

/** What `MCP_BOOTSTRAP_TOKEN_PERMISSIONS` means when it is unset. */
export const DEFAULT_BOOTSTRAP_PERMISSIONS =
  "ideas=write,scripts=write,experiments=write,videos=write,notes=write,activity=read";

export type TokenPermissions = Partial<Record<Resource, Level>>;

/** The seeded token as configured. */
export interface BootstrapToken {
  readonly secret: string;
  readonly name: string;
  readonly permissions: TokenPermissions;
}

/** Why a bootstrap token variable is unusable. Messages never repeat what was configured. */
export function checkBootstrapSecret(secret: string): string | null {
  return isTokenShaped(secret)
    ? null
    : "must be `ytw_` followed by 43 base64url characters (see the README for how to generate one)";
}

/**
 * Reads `resource=level,resource=level`. Strict on purpose: a typo in a permission list must stop
 * the boot, not quietly grant less (or more) than intended. Returns the permissions or the list of
 * problems, which refer to entries by position because the text may be a secret in the wrong place.
 */
export function parseBootstrapPermissions(
  text: string,
): { ok: true; permissions: TokenPermissions } | { ok: false; problems: string[] } {
  const permissions: TokenPermissions = {};
  const problems: string[] = [];
  text.split(",").forEach((raw, index) => {
    const entry = `entry ${index + 1}`;
    const parts = raw.trim().split("=");
    const resource = parts[0]?.trim() ?? "";
    const level = parts[1]?.trim() ?? "";
    if (parts.length !== 2 || resource === "" || level === "") {
      problems.push(`${entry} is not in the form resource=level`);
      return;
    }
    if (!isResource(resource)) {
      problems.push(`${entry} names an unknown resource (known: ${RESOURCES.join(", ")})`);
      return;
    }
    const grantable = GRANTABLE_LEVELS[resource];
    if (!(grantable as readonly string[]).includes(level)) {
      problems.push(`${entry}: ${resource} can be ${grantable.join(", ")}`);
      return;
    }
    if (Object.hasOwn(permissions, resource)) {
      problems.push(`${entry} repeats ${resource}`);
      return;
    }
    permissions[resource] = level as Level;
  });
  return problems.length === 0 ? { ok: true, permissions } : { ok: false, problems };
}

function isResource(value: string): value is Resource {
  return (RESOURCES as readonly string[]).includes(value);
}

/**
 * Makes the database agree with the configuration: `token` set, create or update the seeded token;
 * `null`, revoke it. Idempotent, and safe when several replicas boot at once.
 */
export function reconcileBootstrapToken(
  db: Queryable,
  token: BootstrapToken | null,
): Promise<SeedApiTokenResult> {
  return seedApiToken(
    db,
    token === null
      ? null
      : {
          name: token.name,
          tokenPrefix: tokenPrefix(token.secret),
          tokenHash: hashToken(token.secret),
          permissions: token.permissions,
        },
  );
}
