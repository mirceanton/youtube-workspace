/**
 * Resolving user records by username or UUID for CLI commands.
 */
import { NotFoundError, type Queryable } from "@ytw/db";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly issuer: string;
  readonly sub: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly isAdmin: boolean;
  readonly accessRevokedAt: Date | null;
}

interface RawUserRow {
  id: string;
  username: string;
  oidc_issuer: string;
  oidc_sub: string;
  email: string | null;
  display_name: string | null;
  is_admin: boolean;
  access_revoked_at: Date | null;
}

function userRecordFromRow(row: RawUserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    issuer: row.oidc_issuer,
    sub: row.oidc_sub,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin,
    accessRevokedAt: row.access_revoked_at,
  };
}

/**
 * Finds a user by UUID or preferred username.
 */
export async function findUser(db: Queryable, identifier: string): Promise<UserRecord | null> {
  const isUuid = UUID_REGEX.test(identifier);
  const result = isUuid
    ? await db.query<RawUserRow>(
        `SELECT id, username, oidc_issuer, oidc_sub, email, display_name, is_admin, access_revoked_at
         FROM public.users WHERE id = $1`,
        [identifier],
      )
    : await db.query<RawUserRow>(
        `SELECT id, username, oidc_issuer, oidc_sub, email, display_name, is_admin, access_revoked_at
         FROM public.users WHERE username = $1`,
        [identifier],
      );

  const row = result.rows[0];
  return row ? userRecordFromRow(row) : null;
}

/**
 * Finds a user or throws NotFoundError.
 */
export async function requireUser(
  db: Queryable,
  identifier: string,
  roleDescription = "User",
): Promise<UserRecord> {
  const user = await findUser(db, identifier);
  if (!user) {
    throw new NotFoundError(
      `${roleDescription} "${identifier}" does not exist: users appear after their first login or user create.`,
    );
  }
  return user;
}

/**
 * Finds an active admin (the oldest created active admin) when `--as` is omitted.
 */
export async function findDefaultAdmin(db: Queryable): Promise<UserRecord | null> {
  const result = await db.query<RawUserRow>(
    `SELECT id, username, oidc_issuer, oidc_sub, email, display_name, is_admin, access_revoked_at
     FROM public.users
     WHERE is_admin = true AND access_revoked_at IS NULL
     ORDER BY created_at ASC
     LIMIT 1`,
  );
  const row = result.rows[0];
  return row ? userRecordFromRow(row) : null;
}
