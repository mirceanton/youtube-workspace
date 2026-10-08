import { RESOURCES, type Level, type ResourceLevels } from "@ytw/shared";
import type { TokenPrincipal, UserPrincipal } from "../src/index.js";

/** Every resource at `level`, deliberately not capped (write lands on the activity log too). */
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
  const owner = { userId: "u-alice", username: "alice", isAdmin: opts.ownerIsAdmin ?? false };
  return {
    kind: "token",
    tokenId: "t-1",
    tokenName: "editor-bot",
    levels,
    owner: { ...owner, levels: ownerLevels },
  };
}
