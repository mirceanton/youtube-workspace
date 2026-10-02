/**
 * Typed wrappers for API tokens: create, update permissions, rotate, revoke, look up by hash, touch,
 * and the lists of the settings screens. The caller (T21, T42) generates the secret, hashes it
 * (SHA-256, 64 lower-case hex digits) and passes only the hash and a short prefix; the secret never
 * reaches the database. The rules (a token never exceeds its owner, only the owner manages it, only
 * a person manages tokens) are in the database functions. Conventions: docs/database.md
 * ("Identity, permissions, tokens, sessions").
 */
import type { Level, Resource, ResourceLevels } from "@ytw/shared/constants";
import { sql, type ActorTx, type Queryable } from "./client.js";
import { onlyRow, parseResourceLevels, queryRows } from "./internal/identity-rows.js";

/** `revoked` wins over `expired` when both hold. */
export type ApiTokenStatus = "active" | "revoked" | "expired";

/** A token as the settings screens show it. It never carries the hash. */
export interface ApiTokenInfo {
  id: string;
  ownerId: string;
  /** The audit actor name of every call made with the token. */
  name: string;
  /** `ytw_` plus a few characters of the secret, to tell tokens apart. */
  prefix: string;
  status: ApiTokenStatus;
  createdAt: Date;
  /** null = never expires. */
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  /** The token's OWN level on every object. */
  levels: ResourceLevels;
  /**
   * What the token may do right now: per object the lower of its own level and its owner's current
   * level, and none while it is revoked or expired.
   */
  effectiveLevels: ResourceLevels;
}

interface ApiTokenInfoRow extends Record<string, unknown> {
  token_id: string;
  owner_id: string;
  name: string;
  token_prefix: string;
  status: ApiTokenStatus;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  levels: unknown;
  effective_levels: unknown;
}

function tokenInfoFromRow(row: ApiTokenInfoRow): ApiTokenInfo {
  return {
    id: row.token_id,
    ownerId: row.owner_id,
    name: row.name,
    prefix: row.token_prefix,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    levels: parseResourceLevels(row.levels, `the levels of token ${row.name}`),
    effectiveLevels: parseResourceLevels(
      row.effective_levels,
      `the effective levels of token ${row.name}`,
    ),
  };
}

export interface CreateApiTokenInput {
  /** The person creating the token for their own account; the transaction's actor must be this user. */
  ownerUserId: string;
  /** 1-100 characters; it becomes the audit actor name of the token's calls. */
  name: string;
  /** `ytw_` plus at most 11 characters of the secret. */
  tokenPrefix: string;
  /** SHA-256 of the secret as 64 lower-case hex digits. Never the secret itself. */
  tokenHash: string;
  /** null = never expires; otherwise in the future. */
  expiresAt: Date | null;
  /** Level per object; objects left out get none. Each must be at or below the owner's current level. */
  permissions: Partial<Record<Resource, Level>>;
}

/**
 * Creates a token for the acting person. Throws `ForbiddenError` when a requested level is above
 * what the owner holds right now (the message lists the values that would be accepted), when the
 * owner has no access to any object, or when the actor is an API token; `ValidationError` for a
 * malformed name, prefix, hash, expiry or permission map (an unknown object or level, write on the
 * activity log); `DuplicateError` when a token with this hash exists.
 */
export async function createApiToken(
  tx: ActorTx,
  input: CreateApiTokenInput,
): Promise<ApiTokenInfo> {
  const rows = await queryRows<ApiTokenInfoRow>(
    tx,
    sql`SELECT * FROM create_api_token(${tx.actor.name}, ${tx.actor.type}, ${tx.actor.tokenId},
                                       ${input.ownerUserId}, ${input.name}, ${input.tokenPrefix},
                                       ${input.tokenHash}, ${input.expiresAt},
                                       ${JSON.stringify(input.permissions)}::jsonb)`,
  );
  return tokenInfoFromRow(onlyRow(rows, "create_api_token"));
}

export interface UpdateTokenPermissionsInput {
  /** The token's owner, who must be the transaction's actor. */
  actingUserId: string;
  apiTokenId: string;
  /** Only the objects named change; each must be at or below the owner's current level. */
  permissions: Partial<Record<Resource, Level>>;
}

/**
 * Changes some or all levels of one of the acting person's tokens, checked against the owner's
 * current levels again. `NotFoundError` when the token is not theirs, `InvalidTransitionError` when
 * it was revoked, `ForbiddenError`/`ValidationError` as for `createApiToken`.
 */
export async function updateTokenPermissions(
  tx: ActorTx,
  input: UpdateTokenPermissionsInput,
): Promise<ApiTokenInfo> {
  const rows = await queryRows<ApiTokenInfoRow>(
    tx,
    sql`SELECT * FROM update_token_permissions(${tx.actor.name}, ${tx.actor.type}, ${tx.actor.tokenId},
                                               ${input.actingUserId}, ${input.apiTokenId},
                                               ${JSON.stringify(input.permissions)}::jsonb)`,
  );
  return tokenInfoFromRow(onlyRow(rows, "update_token_permissions"));
}

export interface RotateApiTokenInput {
  actingUserId: string;
  apiTokenId: string;
  newTokenPrefix: string;
  /** SHA-256 of the new secret. The old secret stops working at once. */
  newTokenHash: string;
  /**
   * Omitted: keep the expiry (an expired token must be given a new one). null: never expires.
   * A date: expires then (must be in the future).
   */
  expiresAt?: Date | null;
}

/**
 * Replaces the secret of one of the acting person's tokens; the old one is dead the moment this
 * commits. Id, name and levels stay and last use starts over. `NotFoundError` when the token is not
 * theirs, `InvalidTransitionError` when it was revoked, `ValidationError` for a malformed hash or
 * prefix or an expired token without a new expiry, `DuplicateError` when the hash is in use.
 */
export async function rotateApiToken(
  tx: ActorTx,
  input: RotateApiTokenInput,
): Promise<ApiTokenInfo> {
  const setExpiry = input.expiresAt !== undefined;
  const rows = await queryRows<ApiTokenInfoRow>(
    tx,
    sql`SELECT * FROM rotate_api_token(${tx.actor.name}, ${tx.actor.type}, ${tx.actor.tokenId},
                                       ${input.actingUserId}, ${input.apiTokenId},
                                       ${input.newTokenPrefix}, ${input.newTokenHash},
                                       ${setExpiry}, ${input.expiresAt ?? null})`,
  );
  return tokenInfoFromRow(onlyRow(rows, "rotate_api_token"));
}

export interface RevokeApiTokenInput {
  actingUserId: string;
  apiTokenId: string;
}

/**
 * Revokes one of the acting person's tokens: it stops working at once and stays listed. Revoking a
 * revoked token changes nothing. `NotFoundError` when the token is not theirs.
 */
export async function revokeApiToken(
  tx: ActorTx,
  input: RevokeApiTokenInput,
): Promise<ApiTokenInfo> {
  const rows = await queryRows<ApiTokenInfoRow>(
    tx,
    sql`SELECT * FROM revoke_api_token(${tx.actor.name}, ${tx.actor.type}, ${tx.actor.tokenId},
                                       ${input.actingUserId}, ${input.apiTokenId})`,
  );
  return tokenInfoFromRow(onlyRow(rows, "revoke_api_token"));
}

/** The acting person's own tokens, newest first, revoked ones included. */
export async function listApiTokens(db: Queryable, ownerUserId: string): Promise<ApiTokenInfo[]> {
  const rows = await queryRows<ApiTokenInfoRow>(
    db,
    sql`SELECT * FROM list_api_tokens(${ownerUserId})`,
  );
  return rows.map(tokenInfoFromRow);
}

/** One of the owner's tokens, or null when it does not exist or belongs to someone else. */
export async function getApiToken(
  db: Queryable,
  ownerUserId: string,
  apiTokenId: string,
): Promise<ApiTokenInfo | null> {
  const rows = await queryRows<ApiTokenInfoRow>(
    db,
    sql`SELECT * FROM get_api_token(${ownerUserId}, ${apiTokenId})`,
  );
  const row = rows[0];
  return row === undefined ? null : tokenInfoFromRow(row);
}

/** A token found by the hash of its secret, with its owner. */
export interface FoundToken {
  /** `active`: usable. `revoked` and `expired` are reported distinctly (revoked wins). */
  status: ApiTokenStatus;
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  owner: {
    id: string;
    username: string;
    isAdmin: boolean;
    /** The owner's EFFECTIVE levels right now (admins: the maximum everywhere). */
    levels: ResourceLevels;
  };
  /** The token's own stored levels. */
  levels: ResourceLevels;
  /** The lower of the two per object; all none unless the token is active. */
  effectiveLevels: ResourceLevels;
}

/** The result of `lookupTokenByHash`: a token in any state, or `unknown`. */
export type TokenLookup = FoundToken | { status: "unknown" };

/**
 * The shape of `@ytw/policy`'s `TokenPrincipal`, built from a found token. Build it only for an
 * `active` token; `principalLevels` of it equals `effectiveLevels`.
 */
export interface TokenPrincipalData {
  kind: "token";
  tokenId: string;
  tokenName: string;
  levels: ResourceLevels;
  owner: { userId: string; username: string; isAdmin: boolean; levels: ResourceLevels };
}

export function toTokenPrincipal(token: FoundToken): TokenPrincipalData {
  return {
    kind: "token",
    tokenId: token.id,
    tokenName: token.name,
    levels: token.levels,
    owner: {
      userId: token.owner.id,
      username: token.owner.username,
      isAdmin: token.owner.isAdmin,
      levels: token.owner.levels,
    },
  };
}

/**
 * The authentication lookup: finds a token by the SHA-256 of its secret (64 lower-case hex digits;
 * `ValidationError` otherwise, so a secret passed by mistake is never searched for) and reads its
 * owner's levels in the same statement, so lowering a user lowers their tokens at once. An unknown
 * hash gives `{ status: "unknown" }`; revoked and expired tokens come back with their facts and
 * `status`, and all-none `effectiveLevels`.
 */
export async function lookupTokenByHash(db: Queryable, tokenHash: string): Promise<TokenLookup> {
  const rows = await queryRows<{
    token_id: string;
    token_name: string;
    token_prefix: string;
    status: ApiTokenStatus;
    created_at: Date;
    expires_at: Date | null;
    revoked_at: Date | null;
    last_used_at: Date | null;
    owner_id: string;
    owner_username: string;
    owner_is_admin: boolean;
    token_levels: unknown;
    owner_levels: unknown;
    effective_levels: unknown;
  }>(db, sql`SELECT * FROM lookup_token_by_hash(${tokenHash})`);
  const row = rows[0];
  if (row === undefined) {
    return { status: "unknown" };
  }
  return {
    status: row.status,
    id: row.token_id,
    name: row.token_name,
    prefix: row.token_prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    owner: {
      id: row.owner_id,
      username: row.owner_username,
      isAdmin: row.owner_is_admin,
      levels: parseResourceLevels(row.owner_levels, `the levels of ${row.owner_username}`),
    },
    levels: parseResourceLevels(row.token_levels, `the levels of token ${row.token_name}`),
    effectiveLevels: parseResourceLevels(
      row.effective_levels,
      `the effective levels of token ${row.token_name}`,
    ),
  };
}

/**
 * Records that an authenticated token was just used (`last_used_at` only: no audit event, no
 * `updated_at` change). Called as the token itself; a single statement, so a pool is enough. Revoked
 * and expired tokens are left alone. Returns whether a token was updated.
 */
export async function touchTokenLastUsed(
  db: Queryable,
  token: { id: string; name: string },
): Promise<boolean> {
  const rows = await queryRows<{ touched: boolean }>(
    db,
    sql`SELECT touch_token_last_used(${token.name}, 'agent', ${token.id}) AS touched`,
  );
  return onlyRow(rows, "touch_token_last_used").touched;
}
