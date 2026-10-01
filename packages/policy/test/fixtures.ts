import { RESOURCES, type Level, type Resource, type ResourceLevels } from "@ytw/shared";
import type { TokenPrincipal, UserPrincipal } from "../src/index.js";

// --- Oracle: the PRD 7 rules, written independently of the implementation ---------------------

/**
 * Objects that are None or Read only (PRD 7: "the activity log, which is None or Read only").
 * Adding a read-only object type? Add it here too; the matrix test checks this list against
 * `GRANTABLE_LEVELS` in @ytw/shared and fails until both agree.
 */
export const READ_ONLY: readonly Resource[] = ["activity"];

/** The highest level an object allows. */
export function oracleMax(resource: Resource): Level {
  return READ_ONLY.includes(resource) ? "read" : "write";
}

/** Every object at its maximum: what an admin holds. */
export function oracleFull(): ResourceLevels {
  return Object.fromEntries(RESOURCES.map((r) => [r, oracleMax(r)])) as ResourceLevels;
}

/** The list of valid objects as error messages print it. */
export const VALID_OBJECTS = RESOURCES.join(", ");

// --- Builders -----------------------------------------------------------------------------------

/**
 * Every resource at `level`, deliberately *not* capped (so `"write"` puts Write on the activity log
 * too). Tests use it to prove the policy caps stored data it should never receive.
 */
export function raw(level: Level): ResourceLevels {
  return Object.fromEntries(RESOURCES.map((resource) => [resource, level])) as ResourceLevels;
}

export function user(levels: ResourceLevels, opts: { isAdmin?: boolean } = {}): UserPrincipal {
  return {
    kind: "user",
    userId: "u-alice",
    username: "alice",
    isAdmin: opts.isAdmin ?? false,
    levels,
  };
}

export function token(
  levels: ResourceLevels,
  ownerLevels: ResourceLevels,
  opts: { ownerIsAdmin?: boolean } = {},
): TokenPrincipal {
  return {
    kind: "token",
    tokenId: "t-1",
    tokenName: "editor-bot",
    levels,
    owner: {
      userId: "u-alice",
      username: "alice",
      isAdmin: opts.ownerIsAdmin ?? false,
      levels: ownerLevels,
    },
  };
}
