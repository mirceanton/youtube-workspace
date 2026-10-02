/**
 * Typed wrappers for identity: signing a person in (`upsert_user_on_login`), reading a user with the
 * levels they hold (`get_user_access`) and promoting or demoting admins (`set_user_admin`). Used by
 * the web server (T40, T42). The rules (the first user ever becomes admin, race-free; the last admin
 * stays) are in the database functions. Conventions: docs/database.md ("Identity, permissions,
 * tokens, sessions").
 */
import type { ResourceLevels } from "@ytw/shared/constants";
import { sql, type ActorTx, type Queryable } from "./client.js";
import {
  onlyRow,
  parseResourceLevels,
  queryRows,
  userAccessFromRow,
  type UserAccess,
  type UserAccessRow,
} from "./internal/identity-rows.js";

export interface UpsertUserOnLoginInput {
  /** OIDC issuer URL (`iss`). */
  issuer: string;
  /** OIDC subject (`sub`): with the issuer, the stable identity of the person. */
  sub: string;
  /** `preferred_username`. It must equal the transaction's actor name. */
  username: string;
  /** Optional profile claims; values that cannot be stored are dropped instead of failing the login. */
  email?: string | null;
  displayName?: string | null;
}

/** The signed-in user; `created` is true when this login made the account. */
export interface LoginResult extends UserAccess {
  created: boolean;
}

/**
 * Signs a person in. Run it in `withActor(pool, { name: username, type: "human" }, ...)`: the actor
 * must be the person signing in. The very first user ever becomes admin with the maximum level on
 * every object (also when many first logins race); every later user starts with none everywhere
 * until an admin sets their levels. Profile fields mirror the identity provider's latest claims and
 * `lastLoginAt` moves. Throws `ValidationError` for a missing issuer, sub or username and
 * `ForbiddenError` when the actor is an API token or not the signing-in user.
 *
 * The transaction holds a lock that serialises logins until it ends: keep it short (do not call the
 * identity provider inside it).
 */
export async function upsertUserOnLogin(
  tx: ActorTx,
  input: UpsertUserOnLoginInput,
): Promise<LoginResult> {
  const rows = await queryRows<UserAccessRow & { created: boolean }>(
    tx,
    sql`SELECT * FROM upsert_user_on_login(${tx.actor.name}, ${tx.actor.type}, ${tx.actor.tokenId},
                                           ${input.issuer}, ${input.sub}, ${input.username},
                                           ${input.email ?? null}, ${input.displayName ?? null})`,
  );
  const row = onlyRow(rows, "upsert_user_on_login");
  return { ...userAccessFromRow(row), created: row.created };
}

/**
 * The user and the levels they hold right now (admins: the maximum everywhere), or null for an
 * unknown id. Read it on every request that needs a decision; never cache the levels (PRD 7).
 */
export async function getUserAccess(db: Queryable, userId: string): Promise<UserAccess | null> {
  const rows = await queryRows<UserAccessRow>(db, sql`SELECT * FROM get_user_access(${userId})`);
  const row = rows[0];
  return row === undefined ? null : userAccessFromRow(row);
}

export interface SetUserAdminInput {
  /** The signed-in admin making the change; the transaction's actor must be this user. */
  actingUserId: string;
  /** The user to promote or demote. */
  userId: string;
  isAdmin: boolean;
  /**
   * Only when demoting: keep the user's stored levels (for a former admin the maximum everywhere).
   * By default a demotion resets them to none, so it also lowers every token the person owns; the
   * admin then grants back what the person should keep.
   */
  keepLevels?: boolean;
}

/** What `setUserAdmin` did. `changed` is false when the user already was (or was not) an admin. */
export interface AdminChange {
  userId: string;
  username: string;
  isAdmin: boolean;
  previousIsAdmin: boolean;
  changed: boolean;
  levels: ResourceLevels;
}

/**
 * Promotes or demotes a user (admins only). Promoting raises the user's stored levels to the
 * maximum in the same transaction. The last admin cannot be demoted (`ForbiddenError` naming the
 * rule), also when two admins demote each other at the same moment. Throws `ForbiddenError` when
 * the acting user is not an admin or the actor is an API token, and `NotFoundError` for an unknown
 * user.
 */
export async function setUserAdmin(tx: ActorTx, input: SetUserAdminInput): Promise<AdminChange> {
  const rows = await queryRows<{
    user_id: string;
    username: string;
    is_admin: boolean;
    previous_is_admin: boolean;
    changed: boolean;
    levels: unknown;
  }>(
    tx,
    sql`SELECT * FROM set_user_admin(${tx.actor.name}, ${tx.actor.type}, ${tx.actor.tokenId},
                                     ${input.actingUserId}, ${input.userId}, ${input.isAdmin},
                                     ${input.keepLevels ?? false})`,
  );
  const row = onlyRow(rows, "set_user_admin");
  return {
    userId: row.user_id,
    username: row.username,
    isAdmin: row.is_admin,
    previousIsAdmin: row.previous_is_admin,
    changed: row.changed,
    levels: parseResourceLevels(row.levels, `the levels of user ${row.username}`),
  };
}
