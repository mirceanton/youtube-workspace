import { RESOURCES, type Resource } from "@ytw/shared";
import { describe, expect, it } from "vitest";
import {
  AccessDeniedError,
  DENIAL_HTTP_STATUS,
  FULL_ACCESS,
  NO_ACCESS,
  PolicyError,
  REQUIRED_LEVELS,
  assertAccess,
  authorize,
  can,
  canCreateTokens,
  hasAnyAccess,
  hasReadOnEverything,
  isAdmin,
  readableResources,
  validateRequirement,
  type AccessRule,
  type Principal,
  type RequiredLevel,
  type Requirement,
} from "../src/index.js";
import { VALID_OBJECTS, raw, token, user } from "./fixtures.js";

const allRead = raw("read");

function attemptNotesWrite(principal: Principal | undefined): () => void {
  return () => assertAccess(principal, { resource: "notes", level: "write" });
}

describe("can", () => {
  it("requires read or write; none or garbage is a bug, not a requirement", () => {
    expect(REQUIRED_LEVELS).toEqual(["read", "write"]);
    const principal = user(FULL_ACCESS);
    for (const level of ["none", "admin", undefined]) {
      expect(() => can(principal, "ideas", level as RequiredLevel)).toThrow(PolicyError);
    }
    expect(() => can(principal, "ideas", "none" as RequiredLevel)).toThrow(
      'A requirement needs level read or write, not "none"',
    );
  });

  it("throws for an unknown object", () => {
    expect(() => can(user(FULL_ACCESS), "users" as Resource, "read")).toThrow(PolicyError);
  });

  it("answers false (not an error) for write on the read-only activity log", () => {
    expect(can(user(raw("write"), { isAdmin: true }), "activity", "write")).toBe(false);
  });
});

describe("resource-set helpers", () => {
  it("readableResources lists objects at read or above, in RESOURCES order", () => {
    expect(readableResources(user(NO_ACCESS))).toEqual([]);
    expect(readableResources(user({ ...NO_ACCESS, notes: "write", ideas: "read" }))).toEqual([
      "ideas",
      "notes",
    ]);
    expect(readableResources(user(FULL_ACCESS))).toEqual([...RESOURCES]);
  });

  it.each(RESOURCES)("hasReadOnEverything is false while %s is missing", (missing) => {
    const levels = { ...allRead, [missing]: "none" };
    expect(hasReadOnEverything(user(levels))).toBe(false);
    expect(hasReadOnEverything(token(allRead, levels))).toBe(false);
    expect(hasReadOnEverything(token(levels, allRead))).toBe(false);
  });

  it("hasReadOnEverything holds for read or write everywhere, the activity log included", () => {
    expect(hasReadOnEverything(user(allRead))).toBe(true);
    expect(hasReadOnEverything(user(raw("write")))).toBe(true);
    expect(hasReadOnEverything(token(allRead, FULL_ACCESS))).toBe(true);
    expect(hasReadOnEverything(token(FULL_ACCESS, NO_ACCESS, { ownerIsAdmin: true }))).toBe(true);
  });

  it.each(RESOURCES)("hasAnyAccess is true with read on %s alone", (resource) => {
    expect(hasAnyAccess(user({ ...NO_ACCESS, [resource]: "read" }))).toBe(true);
    expect(hasAnyAccess(token({ ...NO_ACCESS, [resource]: "read" }, FULL_ACCESS))).toBe(true);
  });

  it("hasAnyAccess is false with none everywhere (the 'access not granted' page)", () => {
    expect(hasAnyAccess(user(NO_ACCESS))).toBe(false);
    expect(hasAnyAccess(token(FULL_ACCESS, NO_ACCESS))).toBe(false);
  });
});

describe("admins and token creation", () => {
  it("only users with the admin flag are admins; their tokens never are", () => {
    expect(isAdmin(user(NO_ACCESS, { isAdmin: true }))).toBe(true);
    expect(isAdmin(user(FULL_ACCESS))).toBe(false);
    expect(isAdmin(token(FULL_ACCESS, FULL_ACCESS, { ownerIsAdmin: true }))).toBe(false);
    expect(isAdmin({ ...user(NO_ACCESS), isAdmin: "true" as unknown as boolean })).toBe(false);
    expect(() => isAdmin({ kind: "robot" } as unknown as Principal)).toThrow(PolicyError);
  });

  it("users with read on at least one object can create tokens; tokens cannot", () => {
    expect(canCreateTokens(user({ ...NO_ACCESS, videos: "read" }))).toBe(true);
    expect(canCreateTokens(user(NO_ACCESS))).toBe(false);
    expect(canCreateTokens(user(NO_ACCESS, { isAdmin: true }))).toBe(true);
    expect(canCreateTokens(token(FULL_ACCESS, FULL_ACCESS))).toBe(false);
  });
});

describe("validateRequirement", () => {
  it("accepts every attainable requirement", () => {
    for (const resource of RESOURCES) {
      expect(() => validateRequirement({ resource, level: "read" })).not.toThrow();
    }
    expect(() => validateRequirement({ resource: "scripts", level: "write" })).not.toThrow();
  });

  it.each([
    [null, "Unknown access rule null"],
    ["pubic", 'Unknown access rule "pubic"'],
    [
      { resource: "users", level: "read" },
      `Unknown object "users"; valid objects: ${VALID_OBJECTS}`,
    ],
    [{ resource: "ideas", level: "none" }, 'A requirement needs level read or write, not "none"'],
    [{ resource: "ideas" }, "A requirement needs level read or write, not undefined"],
    [
      { resource: "activity", level: "write" },
      "write can never be held on activity (its maximum is read)",
    ],
  ])("rejects %j", (requirement, message) => {
    expect(() => validateRequirement(requirement as unknown as Requirement)).toThrow(
      new PolicyError(message),
    );
  });
});

describe("authorize", () => {
  const scriptsWrite: Requirement = { resource: "scripts", level: "write" };

  it("allows public rules without a principal", () => {
    expect(authorize(undefined, "public")).toEqual({ allowed: true });
  });

  it.each<AccessRule>(["authenticated", "admin", scriptsWrite])(
    "denies %j without a principal as unauthenticated",
    (rule) => {
      expect(authorize(undefined, rule)).toEqual({
        allowed: false,
        reason: "unauthenticated",
        message: "Authentication required.",
      });
    },
  );

  it("validates the rule before looking at the principal, so bad declarations fail everywhere", () => {
    const bad = { resource: "activity", level: "write" } as const;
    expect(() => authorize(undefined, bad)).toThrow(PolicyError);
    expect(() => authorize(user(FULL_ACCESS), bad)).toThrow(PolicyError);
    expect(() => authorize(user(FULL_ACCESS), "everyone" as AccessRule)).toThrow(PolicyError);
  });

  it("throws for a malformed principal instead of treating it as signed in", () => {
    for (const rule of ["authenticated", "admin", scriptsWrite] as const) {
      expect(() => authorize({ kind: "ghost" } as unknown as Principal, rule)).toThrow(PolicyError);
    }
  });

  it("allows any valid principal for authenticated rules, even with no access", () => {
    expect(authorize(user(NO_ACCESS), "authenticated").allowed).toBe(true);
    expect(authorize(token(NO_ACCESS, NO_ACCESS), "authenticated").allowed).toBe(true);
  });

  it("allows admin rules only for admin users", () => {
    expect(authorize(user(NO_ACCESS, { isAdmin: true }), "admin")).toEqual({ allowed: true });
    expect(authorize(user(FULL_ACCESS), "admin")).toEqual({
      allowed: false,
      reason: "forbidden",
      message: 'Permission denied: only an admin can do this, and user "alice" is not an admin.',
    });
    expect(authorize(token(FULL_ACCESS, FULL_ACCESS, { ownerIsAdmin: true }), "admin")).toEqual({
      allowed: false,
      reason: "forbidden",
      message:
        "Permission denied: only an admin signed in to the web app can do this; API tokens never have admin rights.",
    });
  });

  it("explains a user's level denial", () => {
    expect(authorize(user({ ...NO_ACCESS, scripts: "read" }), scriptsWrite)).toEqual({
      allowed: false,
      reason: "forbidden",
      message:
        'Permission denied: this needs write access on scripts, but user "alice" has read. An admin can change user levels in settings.',
    });
  });

  it("tells a token that its own level is the limit", () => {
    const decision = authorize(
      token({ ...NO_ACCESS, scripts: "read" }, { ...NO_ACCESS, scripts: "write" }),
      scriptsWrite,
    );
    expect(decision).toEqual({
      allowed: false,
      reason: "forbidden",
      message:
        'Permission denied: this needs write access on scripts, but token "editor-bot" (owner "alice") has read. ' +
        "The token's own level is read and its owner's current level is write; a token never exceeds its owner. " +
        "The owner can raise this token's level in settings.",
    });
  });

  it("tells a token that its owner's lowered level is the limit", () => {
    const decision = authorize(
      token({ ...NO_ACCESS, scripts: "write" }, { ...NO_ACCESS, scripts: "read" }),
      scriptsWrite,
    );
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.message).toBe(
      'Permission denied: this needs write access on scripts, but token "editor-bot" (owner "alice") has read. ' +
        "The token's own level is write and its owner's current level is read; a token never exceeds its owner. " +
        "An admin must raise the owner's level in settings.",
    );
  });

  it("tells a token when both its own level and its owner's are too low", () => {
    const decision = authorize(token(NO_ACCESS, NO_ACCESS), { resource: "ideas", level: "read" });
    expect(!decision.allowed && decision.message).toBe(
      'Permission denied: this needs read access on ideas, but token "editor-bot" (owner "alice") has none. ' +
        "The token's own level is none and its owner's current level is none; a token never exceeds its owner. " +
        "An admin must raise the owner's level, then the owner can raise the token's level, in settings.",
    );
  });

  it("reports the capped activity level in denials", () => {
    const decision = authorize(token(raw("write"), { ...raw("write"), ideas: "none" }), {
      resource: "ideas",
      level: "read",
    });
    expect(!decision.allowed && decision.message).toContain(
      "The token's own level is write and its owner's current level is none",
    );
    const activity = authorize(token(NO_ACCESS, raw("write")), {
      resource: "activity",
      level: "read",
    });
    expect(!activity.allowed && activity.message).toContain(
      "The token's own level is none and its owner's current level is read",
    );
  });
});

describe("assertAccess and adapter helpers", () => {
  it("returns quietly when allowed", () => {
    expect(() =>
      assertAccess(user(FULL_ACCESS), { resource: "notes", level: "write" }),
    ).not.toThrow();
    expect(() => assertAccess(undefined, "public")).not.toThrow();
  });

  it("throws an AccessDeniedError carrying the reason and message", () => {
    expect(attemptNotesWrite(undefined)).toThrow(
      expect.objectContaining({
        name: "AccessDeniedError",
        reason: "unauthenticated",
        message: "Authentication required.",
      }),
    );
    expect(attemptNotesWrite(user(NO_ACCESS))).toThrow(AccessDeniedError);
    expect(attemptNotesWrite(user(NO_ACCESS))).toThrow(
      expect.objectContaining({ reason: "forbidden", message: expect.stringContaining("notes") }),
    );
  });

  it("maps denial reasons to HTTP statuses", () => {
    expect(DENIAL_HTTP_STATUS).toEqual({ unauthenticated: 401, forbidden: 403 });
    expect(new AccessDeniedError("forbidden", "no")).toBeInstanceOf(Error);
  });
});
