/**
 * Typed wrappers for permissions: the access matrix (`set_user_permission`,
 * `list_users_with_levels`). Used by the web server only (settings, T42); the rules (admins only,
 * `activity` never write, an admin's levels are never lowered) are in the database functions, not
 * here. Conventions: docs/database.md ("Identity, permissions, tokens, sessions").
 */
import type { Level, Resource } from "@ytw/shared/constants";
import { sql, type ActorTx, type Queryable } from "./client.js";
import {
  onlyRow,
  queryRows,
  userAccessFromRow,
  type UserAccess,
  type UserAccessRow,
} from "./internal/identity-rows.js";

export { parseResourceLevels, type UserAccess } from "./internal/identity-rows.js";

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
 * not an admin or the actor is an API token, or when the user to change is an admin (their levels
 * cannot be lowered: demote them with `setUserAdmin` first); `ValidationError` for an unknown object
 * or level or for write on the activity log; `NotFoundError` for an unknown user. Setting the level
 * a user already has changes nothing and writes no event.
 */
export async function setUserPermission(
  tx: ActorTx,
  input: SetUserPermissionInput,
): Promise<PermissionChange> {
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

/**
 * The access matrix: every user with the levels they hold, oldest account first. Admins only
 * (`ForbiddenError` otherwise).
 */
export async function listUserAccess(db: Queryable, actingUserId: string): Promise<UserAccess[]> {
  const rows = await queryRows<UserAccessRow>(
    db,
    sql`SELECT * FROM list_users_with_levels(${actingUserId})`,
  );
  return rows.map(userAccessFromRow);
}
