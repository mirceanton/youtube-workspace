/**
 * Typed wrappers for identity: signing a person in (`upsert_user_on_login`), reading a user with the
 * levels they hold (`get_user_access`) and promoting or demoting admins (`set_user_admin`). The
 * rules (the first user ever becomes admin, race-free; the last admin stays) are in the database
 * functions.
 */
import type { ResourceLevels } from "@ytw/shared/constants";
import { rejectNul, requireUuid } from "./args.js";
import { sql, type ActorTx, type Queryable } from "./client.js";
import {
  accessRevocationFromRow,
  onlyRow,
  parseResourceLevels,
  queryRows,
  userAccessFromRow,
  type AccessRevocation,
  type AccessRevocationRow,
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
 * Call it only AFTER the identity provider's access group check passed: signing in lifts a revoked
 * access (`accessRevokedAt` of the result is always null), so a person who is outside the group goes
 * to `markUserOutsideAccessGroup` instead and never reaches this function.
 *
 * The transaction holds a lock that serialises logins until it ends: keep it short (do not call the
 * identity provider inside it), and leave its isolation level at READ COMMITTED (SERIALIZABLE works;
 * REPEATABLE READ is refused with a `ValidationError`).
 */
export async function upsertUserOnLogin(
  tx: ActorTx,
  input: UpsertUserOnLoginInput,
): Promise<LoginResult> {
  rejectNul("issuer", input.issuer);
  rejectNul("sub", input.sub);
  rejectNul("username", input.username);
  rejectNul("email", input.email);
  rejectNul("display_name", input.displayName);
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
 * The user and the levels they hold right now (admins: the maximum everywhere; a person whose access
 * is revoked: none, and not an admin, with `accessRevokedAt`), or null for an unknown id. Read it on
 * every request that needs a decision; never cache the levels.
 */
export async function getUserAccess(db: Queryable, userId: string): Promise<UserAccess | null> {
  requireUuid("user_id", userId);
  const rows = await queryRows<UserAccessRow>(db, sql`SELECT * FROM get_user_access(${userId})`);
  const row = rows[0];
  return row === undefined ? null : userAccessFromRow(row);
}

export interface MarkOutsideAccessGroupInput {
  /** OIDC issuer URL (`iss`) of the person who failed the access group check. */
  issuer: string;
  /** OIDC subject (`sub`) of that person. */
  sub: string;
}

/**
 * The identity provider says this person is outside the required access group (the check repeated
 * on every token refresh): revokes their access (levels none, not an admin, every token they
 * own dead) and ends all their browser sessions on every device. Run it in
 * `withActor(pool, { name: <their preferred_username>, type: "human" }, ...)`.
 *
 * Never creates a user: it returns null for an identity that never signed in (nothing to revoke;
 * "no user record is created" for someone without the group). Calling it again for a person whose
 * access is already revoked changes nothing and writes no event (`changed` false). It is not subject
 * to the last-admin guard: the identity provider outranks it, so the workspace may be left without an
 * admin whose access is active; that person signs in again once they are back in the group.
 */
export async function markUserOutsideAccessGroup(
  tx: ActorTx,
  input: MarkOutsideAccessGroupInput,
): Promise<AccessRevocation | null> {
  rejectNul("issuer", input.issuer);
  rejectNul("sub", input.sub);
  const rows = await queryRows<AccessRevocationRow>(
    tx,
    sql`SELECT * FROM mark_user_outside_access_group(${tx.actor.name}, ${tx.actor.type},
                                                     ${tx.actor.tokenId}, ${input.issuer},
                                                     ${input.sub})`,
  );
  const row = rows[0];
  return row === undefined ? null : accessRevocationFromRow(row);
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

/**
 * What `setUserAdmin` did. `changed` is false when the user already was (or was not) an admin.
 * `isAdmin` and `previousIsAdmin` are the STORED flag this call decided; for someone whose access is
 * revoked it does not count until the access returns (`getUserAccess` reports the effective flag), and
 * `levels` are the effective levels (none while revoked).
 */
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
 * maximum in the same transaction. The last admin whose access is active cannot be demoted
 * (`ForbiddenError` naming the rule; admins whose access is revoked do not count), also when two
 * admins demote each other at the same moment. Throws `ForbiddenError` when the acting user is not an
 * admin, has no access (revoked) or the actor is an API token, and `NotFoundError` for an unknown
 * user.
 *
 * Demoting resets the user's levels to none unless `keepLevels`: a confirmation dialog must say so
 * (the person loses their access, and every token they own loses it with them).
 */
export async function setUserAdmin(tx: ActorTx, input: SetUserAdminInput): Promise<AdminChange> {
  requireUuid("acting_user_id", input.actingUserId);
  requireUuid("user_id", input.userId);
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
