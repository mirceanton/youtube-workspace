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
import { toDbError } from "../errors.js";

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
 * level map. Anything but exactly one valid level per object throws a plain Error: the database
 * always writes the full set, so a gap or a stranger means a corrupt or out-of-date schema, and the
 * caller must fail closed instead of guessing a level.
 */
export function parseResourceLevels(value: unknown, what = "levels"): ResourceLevels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`the database returned ${what} that are not an object`);
  }
  const record = value as Record<string, unknown>;
  const levels: Partial<Record<Resource, Level>> = {};
  for (const resource of RESOURCES) {
    const level = record[resource];
    if (typeof level !== "string" || !(LEVELS as readonly string[]).includes(level)) {
      throw new Error(`the database returned ${what} without a valid level for ${resource}`);
    }
    levels[resource] = level as Level;
  }
  const known = new Set<string>(RESOURCES);
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `the database returned ${what} for objects this build does not know: ${unknown.join(", ")}`,
    );
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
