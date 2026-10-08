/**
 * Typed wrappers for permissions: the access matrix (`set_user_permission`,
 * `list_users_with_levels`). The rules (admins only, `activity` never write, an admin's levels
 * are never lowered) are in the database functions, not here.
 */
import type { Level, Resource } from "@ytw/shared/constants";
import { rejectNul, requireUuid } from "./args.js";
import { sql, type ActorTx, type Queryable } from "./client.js";
import {
  accessRevocationFromRow,
  onlyRow,
  queryRows,
  userAccessFromRow,
  type AccessRevocation,
  type AccessRevocationRow,
  type UserAccess,
  type UserAccessRow,
} from "./internal/identity-rows.js";

export {
  parseResourceLevels,
  type AccessRevocation,
  type UserAccess,
} from "./internal/identity-rows.js";

/** What `setUserPermission` did. `changed` is false when the user already held that level. */
export interface PermissionChange {
  userId: string;
  resource: Resource;
  previousLevel: Level;
  level: Level;
  changed: boolean;
}

export interface SetUserPermissionInput {
  /** The signed-in admin making the change; the transaction's actor must be this user. */
  actingUserId: string;
  /** The user whose level changes. */
  userId: string;
  resource: Resource;
  level: Level;
}

/**
 * Sets one cell of the access matrix (admins only). Throws `ForbiddenError` when the acting user is
 * not an admin, has no access (revoked) or the actor is an API token, or when the user to change is an admin (their levels
 * cannot be lowered: demote them with `setUserAdmin` first); `ValidationError` for an unknown object
 * or level or for write on the activity log; `NotFoundError` for an unknown user. Setting the level
 * a user already has changes nothing and writes no event.
 */
export async function setUserPermission(
  tx: ActorTx,
  input: SetUserPermissionInput,
): Promise<PermissionChange> {
  requireUuid("acting_user_id", input.actingUserId);
  requireUuid("user_id", input.userId);
  rejectNul("resource", input.resource);
  rejectNul("level", input.level);
  const rows = await queryRows<{
    user_id: string;
    resource: Resource;
    previous_level: Level;
    level: Level;
    changed: boolean;
  }>(
    tx,
    sql`SELECT * FROM set_user_permission(${tx.actor.name}, ${tx.actor.type}, ${tx.actor.tokenId},
                                          ${input.actingUserId}, ${input.userId}, ${input.resource},
                                          ${input.level})`,
  );
  const row = onlyRow(rows, "set_user_permission");
  return {
    userId: row.user_id,
    resource: row.resource,
    previousLevel: row.previous_level,
    level: row.level,
    changed: row.changed,
  };
}

export interface SetUserAccessRevokedInput {
  /** The signed-in admin making the change; the transaction's actor must be this user. */
  actingUserId: string;
  /** The user to lock out or restore. */
  userId: string;
  /** true locks the user out, false restores their access. */
  revoked: boolean;
}

/**
 * Locks a person out by hand, or restores them (admins whose access is active only): offboarding for
 * somebody who never comes back to the web app, so the identity provider's group check never reaches
 * them. Locking out sets `accessRevokedAt` (levels none, not an admin, every token they own dead) and
 * ends all their browser sessions; restoring brings back exactly the levels, admin flag and tokens
 * they had. A person who is still in the access group and signs in again is restored by that sign-in:
 * to keep somebody out for good, remove them from the group. The last admin whose access is active
 * cannot be locked out (`ForbiddenError`, `reason: last_admin`). Asking for the state the user already
 * has changes nothing and writes no event.
 */
export async function setUserAccessRevoked(
  tx: ActorTx,
  input: SetUserAccessRevokedInput,
): Promise<AccessRevocation> {
  requireUuid("acting_user_id", input.actingUserId);
  requireUuid("user_id", input.userId);
  const rows = await queryRows<AccessRevocationRow>(
    tx,
    sql`SELECT * FROM set_user_access_revoked(${tx.actor.name}, ${tx.actor.type}, ${tx.actor.tokenId},
                                              ${input.actingUserId}, ${input.userId},
                                              ${input.revoked})`,
  );
  return accessRevocationFromRow(onlyRow(rows, "set_user_access_revoked"));
}

/**
 * The access matrix: every user with the levels they hold, oldest account first, people whose access
 * is revoked included (`accessRevokedAt`). Admins whose access is active only (`ForbiddenError`
 * otherwise).
 */
export async function listUserAccess(db: Queryable, actingUserId: string): Promise<UserAccess[]> {
  requireUuid("acting_user_id", actingUserId);
  const rows = await queryRows<UserAccessRow>(
    db,
    sql`SELECT * FROM list_users_with_levels(${actingUserId})`,
  );
  return rows.map(userAccessFromRow);
}
