/**
 * Typed wrappers for web sessions: create, touch, get, update the refresh tokens, delete and purge
 * expired. The web server (T40) is the only caller. Sessions are not business records: they are not
 * audited and take no actor, and the session id is the bearer handle behind the session cookie, so
 * it appears in no message and no event. Conventions: docs/database.md ("Identity, permissions,
 * tokens, sessions").
 *
 * Two clocks: the idle expiry moves forward on activity (`touchWebSession`), the absolute expiry
 * is fixed at login; a session is alive only while both lie in the future.
 */
import { rejectNul, requireUuid } from "./args.js";
import { sql, type Queryable } from "./client.js";
import { ValidationError } from "./errors.js";
import { onlyRow, queryRows } from "./internal/identity-rows.js";

/** `absolute_expired` wins over `idle_expired` when both hold. */
export type WebSessionStatus = "active" | "idle_expired" | "absolute_expired";

/** A session without its secrets, as create and touch return it. */
export interface WebSession {
  id: string;
  userId: string;
  status: WebSessionStatus;
  createdAt: Date;
  lastSeenAt: Date;
  /** Idle expiry: last activity plus the idle timeout, never later than `absoluteExpiresAt`. */
  expiresAt: Date;
  /** Absolute expiry: login plus the absolute timeout. */
  absoluteExpiresAt: Date;
}

/** A session read back with the opaque ciphertext of its refresh token. */
export interface WebSessionDetails extends WebSession {
  /** The caller's ciphertext, returned only while the session is `active`; otherwise null. */
  refreshTokenEncrypted: Buffer | null;
  /** The ID token to send as `id_token_hint` on logout, if any. */
  idTokenHint: string | null;
}

interface WebSessionRow extends Record<string, unknown> {
  session_id: string;
  user_id: string;
  status: WebSessionStatus;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  absolute_expires_at: Date;
}

function sessionFromRow(row: WebSessionRow): WebSession {
  return {
    id: row.session_id,
    userId: row.user_id,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
  };
}

function requireSeconds(field: string, value: number): number {
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${field} must be a whole number of seconds`, { field, value });
  }
  return value;
}

export interface CreateWebSessionInput {
  userId: string;
  /** The OIDC refresh token, encrypted by the caller (opaque to the database); 1-16384 bytes. */
  refreshTokenEncrypted?: Uint8Array | null;
  /** The ID token for RP-initiated logout; 1-16384 characters. */
  idTokenHint?: string | null;
  /** `SESSION_IDLE_TIMEOUT` in seconds (60 to 31622400). */
  idleTimeoutSeconds: number;
  /** `SESSION_ABSOLUTE_TIMEOUT` in seconds (60 to 31622400). */
  absoluteTimeoutSeconds: number;
}

/**
 * Starts a session for a user who just signed in: idle expiry now plus the idle timeout (capped at
 * the absolute expiry), absolute expiry now plus the absolute timeout. `NotFoundError` for an unknown
 * user, `ValidationError` for timeouts or blobs out of range.
 */
export async function createWebSession(
  db: Queryable,
  input: CreateWebSessionInput,
): Promise<WebSession> {
  requireUuid("user_id", input.userId);
  rejectNul("id_token_hint", input.idTokenHint);
  const rows = await queryRows<WebSessionRow>(
    db,
    sql`SELECT * FROM create_web_session(
          ${input.userId},
          ${input.refreshTokenEncrypted === undefined || input.refreshTokenEncrypted === null ? null : Buffer.from(input.refreshTokenEncrypted)},
          ${input.idTokenHint ?? null},
          ${requireSeconds("idle_timeout_seconds", input.idleTimeoutSeconds)},
          ${requireSeconds("absolute_timeout_seconds", input.absoluteTimeoutSeconds)})`,
  );
  return sessionFromRow(onlyRow(rows, "create_web_session"));
}

/**
 * Records activity on a live session: its idle expiry moves to now plus the idle timeout, never past
 * the absolute expiry, and the session is returned. Null when the session is expired or unknown
 * (the caller treats the request as signed out).
 */
export async function touchWebSession(
  db: Queryable,
  sessionId: string,
  idleTimeoutSeconds: number,
): Promise<WebSession | null> {
  requireUuid("session_id", sessionId);
  const rows = await queryRows<WebSessionRow>(
    db,
    sql`SELECT * FROM touch_web_session(${sessionId}, ${requireSeconds("idle_timeout_seconds", idleTimeoutSeconds)})`,
  );
  const row = rows[0];
  return row === undefined ? null : sessionFromRow(row);
}

/**
 * Reads a session, expired or not, with its status. The refresh token ciphertext comes back only
 * while the session is active (a dead session must not be refreshed). Null for an unknown id.
 */
export async function getWebSession(
  db: Queryable,
  sessionId: string,
): Promise<WebSessionDetails | null> {
  requireUuid("session_id", sessionId);
  const rows = await queryRows<
    WebSessionRow & { refresh_token_encrypted: Buffer | null; id_token_hint: string | null }
  >(db, sql`SELECT * FROM get_web_session(${sessionId})`);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    ...sessionFromRow(row),
    refreshTokenEncrypted: row.refresh_token_encrypted,
    idTokenHint: row.id_token_hint,
  };
}

export interface UpdateWebSessionTokensInput {
  /** The new ciphertext; omitted or null keeps the stored one (a provider that does not rotate). */
  refreshTokenEncrypted?: Uint8Array | null;
  /** The new ID token; omitted or null keeps the stored one. */
  idTokenHint?: string | null;
}

/**
 * Stores the tokens of a silent refresh on a live session. Returns false when the session is
 * expired or unknown: a dead session is never revived.
 */
export async function updateWebSessionTokens(
  db: Queryable,
  sessionId: string,
  input: UpdateWebSessionTokensInput,
): Promise<boolean> {
  requireUuid("session_id", sessionId);
  rejectNul("id_token_hint", input.idTokenHint);
  const rows = await queryRows<{ updated: boolean }>(
    db,
    sql`SELECT update_web_session_tokens(
          ${sessionId},
          ${input.refreshTokenEncrypted === undefined || input.refreshTokenEncrypted === null ? null : Buffer.from(input.refreshTokenEncrypted)},
          ${input.idTokenHint ?? null}) AS updated`,
  );
  return onlyRow(rows, "update_web_session_tokens").updated;
}

/** Ends a session (logout, or a refresh that found the user outside the access group). */
export async function deleteWebSession(db: Queryable, sessionId: string): Promise<boolean> {
  requireUuid("session_id", sessionId);
  const rows = await queryRows<{ deleted: boolean }>(
    db,
    sql`SELECT delete_web_session(${sessionId}) AS deleted`,
  );
  return onlyRow(rows, "delete_web_session").deleted;
}

/** Deletes every session whose idle or absolute expiry has passed; returns how many. */
export async function purgeExpiredWebSessions(db: Queryable): Promise<number> {
  const rows = await queryRows<{ purged: number }>(
    db,
    sql`SELECT purge_expired_web_sessions() AS purged`,
  );
  return onlyRow(rows, "purge_expired_web_sessions").purged;
}
