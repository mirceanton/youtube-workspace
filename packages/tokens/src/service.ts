/**
 * Creating, changing, rotating and revoking API tokens on behalf of a signed-in person (PRD 7). It
 * generates the secret, hashes it, checks the requested levels against the owner's CURRENT levels
 * with `@ytw/policy` for a readable error, and then calls the database functions, which enforce the
 * same ceiling again (the database is the authority; this check only gives better messages first).
 *
 * Run it with the web role's pool: the management functions belong to `ytw_web`. The secret is in
 * the result of `createToken` and `rotateToken` and nowhere else; it is never logged here.
 */
import {
  createApiToken,
  getUserAccess,
  revokeApiToken,
  rotateApiToken,
  updateTokenPermissions,
  withActor,
  NotFoundError,
  type ApiTokenInfo,
} from "@ytw/db";
import { grantViolations, type GrantViolation } from "@ytw/policy";
import type { Level, Resource } from "@ytw/shared/constants";
import { generateToken } from "./secret.js";

/** The person acting. Tokens are managed by their owner only. */
export interface TokenOwnerRef {
  readonly id: string;
  /** `preferred_username`: the audit actor of every change. */
  readonly username: string;
}

/** The web role's pool, as `withActor` takes it. */
export type WebPool = Parameters<typeof withActor>[0];

export type Permissions = Partial<Record<Resource, Level>>;

/** Thrown before any write when the requested levels exceed what the owner holds. */
export class TokenGrantError extends Error {
  readonly violations: readonly GrantViolation[];
  constructor(violations: readonly GrantViolation[]) {
    super(violations.map((violation) => violation.message).join(" "));
    this.name = "TokenGrantError";
    this.violations = violations;
  }
}

/** A token together with the secret that exists only now. */
export interface IssuedToken {
  readonly token: ApiTokenInfo;
  /** Show it once and drop it: only its hash is stored. */
  readonly secret: string;
}

export interface CreateTokenInput {
  readonly name: string;
  /** null = never expires. */
  readonly expiresAt: Date | null;
  /** Level per object; objects left out get none. */
  readonly permissions: Permissions;
}

async function assertGrantable(
  pool: WebPool,
  owner: TokenOwnerRef,
  requested: Permissions,
): Promise<void> {
  const access = await getUserAccess(pool, owner.id);
  if (access === null) {
    throw new NotFoundError(`User ${owner.id} does not exist.`);
  }
  const violations = grantViolations(access, requested);
  if (violations.length > 0) {
    throw new TokenGrantError(violations);
  }
}

const asPerson = (owner: TokenOwnerRef) => ({ name: owner.username, type: "human" as const });

export async function createToken(
  pool: WebPool,
  owner: TokenOwnerRef,
  input: CreateTokenInput,
): Promise<IssuedToken> {
  await assertGrantable(pool, owner, input.permissions);
  const generated = generateToken();
  const token = await withActor(pool, asPerson(owner), (tx) =>
    createApiToken(tx, {
      ownerUserId: owner.id,
      name: input.name,
      tokenPrefix: generated.prefix,
      tokenHash: generated.hash,
      expiresAt: input.expiresAt,
      permissions: input.permissions,
    }),
  );
  return { token, secret: generated.secret };
}

export async function updateToken(
  pool: WebPool,
  owner: TokenOwnerRef,
  apiTokenId: string,
  permissions: Permissions,
): Promise<ApiTokenInfo> {
  await assertGrantable(pool, owner, permissions);
  return withActor(pool, asPerson(owner), (tx) =>
    updateTokenPermissions(tx, { actingUserId: owner.id, apiTokenId, permissions }),
  );
}

/** Replaces the secret; the old one stops working when this returns. `expiresAt`: see `rotateApiToken`. */
export async function rotateToken(
  pool: WebPool,
  owner: TokenOwnerRef,
  apiTokenId: string,
  expiresAt?: Date | null,
): Promise<IssuedToken> {
  const generated = generateToken();
  const token = await withActor(pool, asPerson(owner), (tx) =>
    rotateApiToken(tx, {
      actingUserId: owner.id,
      apiTokenId,
      newTokenPrefix: generated.prefix,
      newTokenHash: generated.hash,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }),
  );
  return { token, secret: generated.secret };
}

export async function revokeToken(
  pool: WebPool,
  owner: TokenOwnerRef,
  apiTokenId: string,
): Promise<ApiTokenInfo> {
  return withActor(pool, asPerson(owner), (tx) =>
    revokeApiToken(tx, { actingUserId: owner.id, apiTokenId }),
  );
}
