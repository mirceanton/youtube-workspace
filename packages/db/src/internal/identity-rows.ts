/**
 * Row mapping shared by the identity, permissions, tokens and sessions wrappers (T14). Internal:
 * `index.ts` does not export this file; the public types are re-exported by the wrapper modules.
 */
import {
  LEVELS,
  RESOURCES,
  type Level,
  type Resource,
  type ResourceLevels,
} from "@ytw/shared/constants";
import type { Queryable, SqlQuery } from "../client.js";
import { ValidationError, toDbError } from "../errors.js";

/**
 * Throws a {@link ValidationError} when a JSON-bound value (a permission map) contains a NUL
 * character anywhere: Postgres cannot store U+0000 in `jsonb`, and its own error would be a bare
 * driver error. Strings are checked by `rejectNul` of args.ts.
 */
export function rejectNulInJson(field: string, value: unknown): void {
  if (containsNul(value)) {
    throw new ValidationError(
      `${field} contains a NUL character (U+0000), which cannot be stored: remove it`,
      { field },
    );
  }
}

function containsNul(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("\u0000");
  }
  if (Array.isArray(value)) {
    return value.some(containsNul);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([key, item]) => key.includes("\u0000") || containsNul(item));
  }
  return false;
}

/** Runs a query on any `Queryable` and returns the rows, turning catalogue errors into typed ones. */
export async function queryRows<R extends Record<string, unknown>>(
  db: Queryable,
  query: SqlQuery,
): Promise<R[]> {
  try {
    const { rows } = await db.query<R>(query);
    return rows;
  } catch (err) {
    throw toDbError(err);
  }
}

/** The one row a function that always returns exactly one must have returned. */
export function onlyRow<R>(rows: readonly R[], fn: string): R {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`${fn} returned no row`);
  }
  return row;
}

/**
 * Turns the `jsonb` object a database function returns (`{"ideas": "write", ...}`) into a complete
 * level map for the objects this build knows (`RESOURCES`), the way `@ytw/policy` reads stored rows:
 *
 * - an object the database lists but this build does not know is ignored, so a migration that adds
 *   an object type can run before the services that understand it are deployed (docs/policy.md);
 * - an object this build knows but the database does not list yet is `none` (fail closed);
 * - a value that is not a level, or something that is not an object, is corrupt data and throws a
 *   plain Error, so the caller fails instead of guessing a level.
 */
export function parseResourceLevels(value: unknown, what = "levels"): ResourceLevels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`the database returned ${what} that are not an object`);
  }
  const record = value as Record<string, unknown>;
  const levels: Partial<Record<Resource, Level>> = {};
  for (const resource of RESOURCES) {
    const level = record[resource];
    if (level === undefined) {
      levels[resource] = "none";
    } else if (typeof level === "string" && (LEVELS as readonly string[]).includes(level)) {
      levels[resource] = level as Level;
    } else {
      throw new Error(`the database returned ${what} with an invalid level for ${resource}`);
    }
  }
  return levels as ResourceLevels;
}

/**
 * A user with the levels they hold right now. `levels` is the EFFECTIVE level on every object (what
 * `@ytw/policy` `userLevels` computes): admins hold the maximum everywhere, everyone else the stored
 * level. It is therefore safe to pass `{ isAdmin, levels }` to every `@ytw/policy` function.
 */
export interface UserAccess {
  id: string;
  /** OIDC issuer URL of the identity. */
  issuer: string;
  /** OIDC `sub` claim of the identity (together with the issuer it identifies the person). */
  subject: string;
  /** `preferred_username`; also the audit actor. Not unique: the identity is (issuer, subject). */
  username: string;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  levels: ResourceLevels;
}

/** Row shape of `public.ytw_user_access` (and the head of `upsert_user_on_login`'s result). */
export interface UserAccessRow extends Record<string, unknown> {
  user_id: string;
  oidc_issuer: string;
  oidc_sub: string;
  username: string;
  email: string | null;
  display_name: string | null;
  is_admin: boolean;
  last_login_at: Date | null;
  created_at: Date;
  levels: unknown;
}

export function userAccessFromRow(row: UserAccessRow): UserAccess {
  return {
    id: row.user_id,
    issuer: row.oidc_issuer,
    subject: row.oidc_sub,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    levels: parseResourceLevels(row.levels, `the levels of user ${row.username}`),
  };
}
