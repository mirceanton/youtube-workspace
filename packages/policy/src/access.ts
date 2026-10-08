import { RESOURCES, type Level, type Resource } from "@ytw/shared/constants";
import {
  PolicyError,
  assertResource,
  capLevel,
  maxLevelFor,
  ownLevel,
  satisfies,
  type RequiredLevel,
} from "./levels.js";
import {
  assertPrincipal,
  describePrincipal,
  hasAdminFlag,
  levelOn,
  principalLevels,
  userLevels,
  type Principal,
} from "./principal.js";

/** The levels a requirement can name, lowest first. */
export const REQUIRED_LEVELS: readonly RequiredLevel[] = ["read", "write"];

/**
 * What a guarded operation needs: a level on one object. Web routes (`requireLevel`), MCP tools
 * (`defineTool({ requires })`) and SPA feature routes (`routes.tsx`) all declare one of these.
 */
export interface Requirement {
  readonly resource: Resource;
  readonly level: RequiredLevel;
}

/**
 * Everything a route or tool can declare:
 * - `"public"`: no principal needed (health checks, the login callback);
 * - `"authenticated"`: any signed-in user or valid token (e.g. `/api/me`, managing your own tokens);
 * - `"admin"`: a user with the admin flag (the access matrix). Tokens never qualify;
 * - a `Requirement`: a level on one object.
 */
export type AccessRule = "public" | "authenticated" | "admin" | Requirement;

/** `unauthenticated`: nobody is signed in (HTTP 401). `forbidden`: signed in, not allowed (HTTP 403). */
export type DenialReason = "unauthenticated" | "forbidden";

/** HTTP status for each denial reason, for the web and MCP HTTP adapters. */
export const DENIAL_HTTP_STATUS: Readonly<Record<DenialReason, 401 | 403>> = {
  unauthenticated: 401,
  forbidden: 403,
};

/**
 * The outcome of `authorize`. A denial carries a message written for the caller, human or LLM:
 * it says what was needed, what the principal has and how to fix it.
 */
export type Decision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DenialReason; readonly message: string };

/** Thrown by `assertAccess`. Adapters map `reason` to a status (`DENIAL_HTTP_STATUS`) or a tool error. */
export class AccessDeniedError extends Error {
  override readonly name = "AccessDeniedError";
  readonly reason: DenialReason;

  constructor(reason: DenialReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

function assertRequiredLevel(level: unknown): asserts level is RequiredLevel {
  if (!(REQUIRED_LEVELS as readonly unknown[]).includes(level)) {
    throw new PolicyError(
      `A requirement needs level ${REQUIRED_LEVELS.join(" or ")}, not ${JSON.stringify(level)}`,
    );
  }
}

/**
 * Throws a `PolicyError` unless the requirement names a known object, a level of read or write,
 * and a level that object can ever have (nothing can require write on the read-only activity log).
 * Call it when a route or tool is registered so a bad declaration fails at startup.
 */
export function validateRequirement(requirement: Requirement): void {
  if (typeof requirement !== "object" || requirement === null) {
    throw new PolicyError(`Unknown access rule ${JSON.stringify(requirement)}`);
  }
  assertResource(requirement.resource);
  assertRequiredLevel(requirement.level);
  const max = maxLevelFor(requirement.resource);
  if (!satisfies(max, requirement.level)) {
    throw new PolicyError(
      `${requirement.level} can never be held on ${requirement.resource} (its maximum is ${max})`,
    );
  }
}

/**
 * Whether the principal has at least `level` on `resource` right now. Write includes Read; a token
 * is limited by its owner's current level. Asking for write on the activity log is simply `false`.
 */
export function can(principal: Principal, resource: Resource, level: RequiredLevel): boolean {
  assertRequiredLevel(level);
  return satisfies(levelOn(principal, resource), level);
}

/** Objects the principal can read, in `RESOURCES` order (e.g. what search may cover). */
export function readableResources(principal: Principal): Resource[] {
  const levels = principalLevels(principal);
  return RESOURCES.filter((resource) => satisfies(levels[resource], "read"));
}

/**
 * Read (or more) on every object, the activity log included. The MCP `query_sql` tool is offered
 * only to tokens for which this holds, because raw SQL cannot be filtered per object.
 */
export function hasReadOnEverything(principal: Principal): boolean {
  return readableResources(principal).length === RESOURCES.length;
}

/** Read (or more) on at least one object. A user without it sees "access not granted". */
export function hasAnyAccess(principal: Principal): boolean {
  return readableResources(principal).length > 0;
}

/** A user with the admin flag. A token is never an admin, even when its owner is. */
export function isAdmin(principal: Principal): boolean {
  assertPrincipal(principal);
  return principal.kind === "user" && hasAdminFlag(principal);
}

/**
 * Whether the principal may create API tokens for their own account: a user (never a token) with
 * Read or Write on at least one object.
 */
export function canCreateTokens(principal: Principal): boolean {
  return principal.kind === "user" && hasAnyAccess(principal);
}

const ALLOWED: Decision = Object.freeze({ allowed: true });

function deny(reason: DenialReason, message: string): Decision {
  return { allowed: false, reason, message };
}

function levelDenialMessage(
  principal: Principal,
  { resource, level }: Requirement,
  have: Level,
): string {
  const head = `Permission denied: this needs ${level} access on ${resource}, but ${describePrincipal(principal)} has ${have}.`;
  if (principal.kind === "user") {
    return `${head} An admin can change user levels in settings.`;
  }
  const tokenLevel = capLevel(resource, ownLevel(principal.levels, resource, "Token levels"));
  const ownerLevel = userLevels(principal.owner)[resource];
  const detail = `The token's own level is ${tokenLevel} and its owner's current level is ${ownerLevel}; a token never exceeds its owner.`;
  if (satisfies(ownerLevel, level)) {
    return `${head} ${detail} The owner can raise this token's level in settings.`;
  }
  if (satisfies(tokenLevel, level)) {
    return `${head} ${detail} An admin must raise the owner's level in settings.`;
  }
  return `${head} ${detail} An admin must raise the owner's level, then the owner can raise the token's level, in settings.`;
}

function adminDenialMessage(principal: Principal): string {
  return principal.kind === "user"
    ? `Permission denied: only an admin can do this, and ${describePrincipal(principal)} is not an admin.`
    : "Permission denied: only an admin signed in to the web app can do this; API tokens never have admin rights.";
}

/**
 * Decides whether `principal` (undefined when nobody authenticated) may do something guarded by
 * `rule`. Always evaluate against levels loaded for this request, never cached ones.
 * Throws a `PolicyError` for a malformed rule or principal: that is a bug, not a denial.
 */
export function authorize(principal: Principal | undefined, rule: AccessRule): Decision {
  if (rule === "public") return ALLOWED;
  if (rule !== "authenticated" && rule !== "admin") validateRequirement(rule);
  if (principal === undefined) return deny("unauthenticated", "Authentication required.");
  assertPrincipal(principal);
  if (rule === "authenticated") return ALLOWED;
  if (rule === "admin") {
    return isAdmin(principal) ? ALLOWED : deny("forbidden", adminDenialMessage(principal));
  }
  const have = levelOn(principal, rule.resource);
  return satisfies(have, rule.level)
    ? ALLOWED
    : deny("forbidden", levelDenialMessage(principal, rule, have));
}

/** `authorize`, throwing an `AccessDeniedError` on denial. */
export function assertAccess(principal: Principal | undefined, rule: AccessRule): void {
  const decision = authorize(principal, rule);
  if (!decision.allowed) throw new AccessDeniedError(decision.reason, decision.message);
}
