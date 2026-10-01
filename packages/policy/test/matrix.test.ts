// The PRD 7 permission matrix, exhaustively: None/Read/Write x every resource x {user, token,
// token whose owner was lowered}, plus admins. Expected values come from the small oracle below,
// written from the PRD text rather than from the implementation. The cases are generated from
// `RESOURCES` in @ytw/shared, so a new object type is covered without editing this file (unless it
// is read-only: then add it to READ_ONLY in fixtures.ts, see docs/policy.md).
import {
  GRANTABLE_LEVELS,
  LEVELS,
  RESOURCES,
  type Level,
  type Resource,
  type ResourceLevels,
} from "@ytw/shared";
import { describe, expect, it } from "vitest";
import {
  PolicyError,
  authorize,
  can,
  canGrant,
  levelOn,
  principalLevels,
  type Principal,
  type RequiredLevel,
} from "../src/index.js";
import { READ_ONLY, raw, token, user } from "./fixtures.js";

// --- Oracle -------------------------------------------------------------------------------------

/** The levels a principal can hold, lowest first. */
const HELD = ["none", "read", "write"] as const satisfies readonly Level[];

/** Which requirements a level meets: Write includes Read. */
const MEETS: Record<Level, readonly RequiredLevel[]> = {
  none: [],
  read: ["read"],
  write: ["read", "write"],
};

/** The lower of two levels, spelled out. */
const LOWER: Record<Level, Record<Level, Level>> = {
  none: { none: "none", read: "none", write: "none" },
  read: { none: "none", read: "read", write: "read" },
  write: { none: "none", read: "read", write: "write" },
};

function cap(resource: Resource, level: Level): Level {
  return READ_ONLY.includes(resource) && level === "write" ? "read" : level;
}

/** Levels that may be stored (and granted) for a resource. */
function storable(resource: Resource): readonly Level[] {
  return READ_ONLY.includes(resource) ? ["none", "read"] : HELD;
}

function below(level: Level): Level[] {
  return HELD.slice(0, HELD.indexOf(level));
}

function atOrBelow(level: Level): Level[] {
  return HELD.slice(0, HELD.indexOf(level) + 1);
}

function withLevel(base: ResourceLevels, resource: Resource, level: Level): ResourceLevels {
  return { ...base, [resource]: level };
}

type Outcome = "allowed" | "forbidden" | "invalid requirement";

/** Every way of asking about one object, as observed from the implementation. */
function observe(principal: Principal, resource: Resource) {
  const outcome = (need: RequiredLevel): Outcome => {
    try {
      return authorize(principal, { resource, level: need }).allowed ? "allowed" : "forbidden";
    } catch (error) {
      if (error instanceof PolicyError) return "invalid requirement";
      throw error;
    }
  };
  return {
    levelOn: levelOn(principal, resource),
    principalLevels: principalLevels(principal)[resource],
    canRead: can(principal, resource, "read"),
    canWrite: can(principal, resource, "write"),
    authorizeRead: outcome("read"),
    authorizeWrite: outcome("write"),
  };
}

/** What `observe` must return when the effective level on `resource` is `level`. */
function predict(resource: Resource, level: Level): ReturnType<typeof observe> {
  // Nothing can require a level the object never allows: that is a declaration bug, not a denial.
  const outcome = (need: RequiredLevel): Outcome =>
    cap(resource, need) !== need
      ? "invalid requirement"
      : MEETS[level].includes(need)
        ? "allowed"
        : "forbidden";
  return {
    levelOn: level,
    principalLevels: level,
    canRead: MEETS[level].includes("read"),
    canWrite: MEETS[level].includes("write"),
    authorizeRead: outcome("read"),
    authorizeWrite: outcome("write"),
  };
}

/** Effective levels on every object except `resource`, observed and predicted. */
function othersObserved(principal: Principal, resource: Resource): Record<string, Level> {
  return Object.fromEntries(
    RESOURCES.filter((r) => r !== resource).map((r) => [r, levelOn(principal, r)]),
  );
}

function othersPredicted(resource: Resource, level: Level): Record<string, Level> {
  return Object.fromEntries(RESOURCES.filter((r) => r !== resource).map((r) => [r, cap(r, level)]));
}

describe("oracle", () => {
  it("agrees with @ytw/shared on levels and on which objects are read-only", () => {
    expect(LEVELS).toEqual(HELD);
    expect(GRANTABLE_LEVELS).toEqual(
      Object.fromEntries(RESOURCES.map((resource) => [resource, storable(resource)])),
    );
  });
});

// --- Users --------------------------------------------------------------------------------------

const userCases = RESOURCES.flatMap((resource) =>
  HELD.flatMap((level) =>
    (["none", "write"] as const).map((others) => ({ resource, level, others })),
  ),
);

describe("user x resource x level", () => {
  it.each(userCases)("$resource at $level, others at $others", ({ resource, level, others }) => {
    const principal = user(withLevel(raw(others), resource, level));
    expect(observe(principal, resource)).toEqual(predict(resource, cap(resource, level)));
    expect(othersObserved(principal, resource)).toEqual(othersPredicted(resource, others));
  });
});

describe("admin user", () => {
  it.each(RESOURCES.flatMap((resource) => HELD.map((stored) => ({ resource, stored }))))(
    "has the maximum on $resource whatever is stored ($stored)",
    ({ resource, stored }) => {
      const admin = user(raw(stored), { isAdmin: true });
      expect(observe(admin, resource)).toEqual(predict(resource, cap(resource, "write")));
    },
  );
});

// --- Tokens -------------------------------------------------------------------------------------

const tokenCases = RESOURCES.flatMap((resource) =>
  HELD.flatMap((owner) => HELD.map((tokenLevel) => ({ resource, owner, tokenLevel }))),
);

describe("token x resource x token level x owner level", () => {
  it.each(tokenCases)(
    "$resource: token $tokenLevel, owner $owner",
    ({ resource, owner, tokenLevel }) => {
      // Other objects: token Read, owner Write, so they must come out as (capped) Read.
      const principal = token(
        withLevel(raw("read"), resource, tokenLevel),
        withLevel(raw("write"), resource, owner),
      );
      expect(observe(principal, resource)).toEqual(
        predict(resource, cap(resource, LOWER[owner][tokenLevel])),
      );
      expect(othersObserved(principal, resource)).toEqual(othersPredicted(resource, "read"));
    },
  );

  it.each(RESOURCES.flatMap((resource) => HELD.map((tokenLevel) => ({ resource, tokenLevel }))))(
    "$resource: token $tokenLevel owned by an admin is limited only by the token",
    ({ resource, tokenLevel }) => {
      const principal = token(raw(tokenLevel), raw("none"), { ownerIsAdmin: true });
      expect(observe(principal, resource)).toEqual(predict(resource, cap(resource, tokenLevel)));
    },
  );
});

// A token is created within its owner's ceiling; later an admin lowers the owner. The very next
// evaluation must use the lowered level (PRD 7: "Lowering a user's levels immediately lowers their
// tokens"). The principal is rebuilt from fresh data, as the services do on every request.
const loweredCases = RESOURCES.flatMap((resource) =>
  storable(resource).flatMap((ownerBefore) =>
    atOrBelow(ownerBefore).flatMap((tokenLevel) =>
      below(ownerBefore).map((ownerAfter) => ({ resource, ownerBefore, tokenLevel, ownerAfter })),
    ),
  ),
);

describe("token whose owner was lowered", () => {
  it("covers every object", () => {
    expect(new Set(loweredCases.map((c) => c.resource))).toEqual(new Set(RESOURCES));
  });

  it.each(loweredCases)(
    "$resource: token $tokenLevel, owner $ownerBefore -> $ownerAfter",
    ({ resource, ownerBefore, tokenLevel, ownerAfter }) => {
      const ownerLevelsBefore = withLevel(raw("none"), resource, ownerBefore);
      const tokenLevels = withLevel(raw("none"), resource, tokenLevel);

      // Valid when it was created ...
      expect(canGrant(ownerLevelsBefore, { [resource]: tokenLevel })).toBe(true);
      expect(observe(token(tokenLevels, ownerLevelsBefore), resource)).toEqual(
        predict(resource, tokenLevel),
      );

      // ... and capped by the owner's new level from the next call on.
      const ownerLevelsAfter = withLevel(raw("none"), resource, ownerAfter);
      const lowered = token(tokenLevels, ownerLevelsAfter);
      expect(observe(lowered, resource)).toEqual(predict(resource, LOWER[ownerAfter][tokenLevel]));

      // The stored token level could no longer be granted if it is now above the owner.
      const stillGrantable = HELD.indexOf(tokenLevel) <= HELD.indexOf(ownerAfter);
      expect(canGrant(ownerLevelsAfter, { [resource]: tokenLevel })).toBe(stillGrantable);
    },
  );

  it.each(RESOURCES.flatMap((resource) => HELD.map((tokenLevel) => ({ resource, tokenLevel }))))(
    "$resource: token $tokenLevel loses everything when its admin owner is demoted to none",
    ({ resource, tokenLevel }) => {
      const tokenLevels = raw(tokenLevel);
      const beforeDemotion = token(tokenLevels, raw("none"), { ownerIsAdmin: true });
      const afterDemotion = token(tokenLevels, raw("none"), { ownerIsAdmin: false });
      expect(observe(beforeDemotion, resource)).toEqual(
        predict(resource, cap(resource, tokenLevel)),
      );
      expect(observe(afterDemotion, resource)).toEqual(predict(resource, "none"));
    },
  );
});
