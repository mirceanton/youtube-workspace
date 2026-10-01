import type { Level, Resource, ResourceLevels } from "@ytw/shared";
import {
  FULL_ACCESS,
  PolicyError,
  assertResource,
  capLevel,
  mapResources,
  minLevel,
} from "./levels.js";

/** The levels a user holds, as stored, plus the admin flag. */
export interface UserLevelsSource {
  readonly isAdmin: boolean;
  /** Stored per-object levels (`user_permissions`). Ignored for admins, see `userLevels`. */
  readonly levels: Readonly<ResourceLevels>;
}

/** A signed-in human using the web app. Build it from the database on every request (PRD 7). */
export interface UserPrincipal extends UserLevelsSource {
  readonly kind: "user";
  readonly userId: string;
  /** `preferred_username`; also the audit actor. */
  readonly username: string;
}

/** The user an API token belongs to, with that user's *current* admin flag and levels. */
export interface TokenOwner extends UserLevelsSource {
  readonly userId: string;
  readonly username: string;
}

/** An agent calling the MCP service with an API token. */
export interface TokenPrincipal {
  readonly kind: "token";
  readonly tokenId: string;
  /** The token's name; the audit actor for every call made with it. */
  readonly tokenName: string;
  /** The token's own stored levels (`api_token_permissions`). */
  readonly levels: Readonly<ResourceLevels>;
  readonly owner: TokenOwner;
}

/** Whoever is making a request: a user (web app) or an API token (MCP service). */
export type Principal = UserPrincipal | TokenPrincipal;

const PRINCIPAL_KINDS: readonly unknown[] = ["user", "token"] satisfies Principal["kind"][];

/** Throws a `PolicyError` unless `value` is a user or token principal. */
export function assertPrincipal(value: unknown): asserts value is Principal {
  const kind = (value as { kind?: unknown } | null | undefined)?.kind;
  if (!PRINCIPAL_KINDS.includes(kind)) {
    throw new PolicyError(`Unknown principal kind ${JSON.stringify(kind)}; expected user or token`);
  }
}

/**
 * The effective level for one object: the lower of the owner's level and the token's level
 * (PRD 7). Called without a token it is the owner's (user's) own level. Passing `undefined` as the
 * token (say, from a token map that lacks the object) throws a `PolicyError` instead of falling
 * back to the owner's level.
 */
export function effectiveLevel(owner: Level, ...token: [token?: Level]): Level {
  return minLevel(owner, token.length === 0 ? owner : (token[0] as Level));
}

/**
 * `effectiveLevel` for every object, capped at what each object allows (the activity log is Read
 * at most). `owner` must already be the owner's effective user levels, see `userLevels`. When a
 * token map is given, every object must be in it: a missing entry throws a `PolicyError` rather
 * than falling back to the owner's level.
 */
export function effectiveLevels(
  owner: Readonly<ResourceLevels>,
  token?: Readonly<ResourceLevels>,
): ResourceLevels {
  return mapResources((resource) =>
    capLevel(
      resource,
      token === undefined ? owner[resource] : minLevel(owner[resource], token[resource]),
    ),
  );
}

/**
 * A user's effective levels. Admins have the maximum on every object (PRD 7: "Admins have Write on
 * everything"), whatever rows are stored; everyone else has their stored levels, capped per object.
 * Only a literal `true` admin flag counts.
 */
export function userLevels(user: UserLevelsSource): ResourceLevels {
  return user.isAdmin === true ? { ...FULL_ACCESS } : effectiveLevels(user.levels);
}

/**
 * The levels a principal actually has right now. For a token that is, per object, the lower of the
 * token's level and its owner's current effective level, so lowering a user immediately lowers every
 * token they own.
 */
export function principalLevels(principal: Principal): ResourceLevels {
  assertPrincipal(principal);
  return principal.kind === "user"
    ? userLevels(principal)
    : effectiveLevels(userLevels(principal.owner), principal.levels);
}

/** The principal's effective level on one object. Throws a `PolicyError` for an unknown object. */
export function levelOn(principal: Principal, resource: Resource): Level {
  assertResource(resource);
  return principalLevels(principal)[resource];
}

/** How a principal is named in messages: `user "alice"` or `token "editor-bot" (owner "alice")`. */
export function describePrincipal(principal: Principal): string {
  assertPrincipal(principal);
  return principal.kind === "user"
    ? `user ${JSON.stringify(principal.username)}`
    : `token ${JSON.stringify(principal.tokenName)} (owner ${JSON.stringify(principal.owner.username)})`;
}
