import type { Level, Resource, ResourceLevels } from "@ytw/shared";
import { describe, expect, it } from "vitest";
import {
  FULL_ACCESS,
  NO_ACCESS,
  PolicyError,
  effectiveLevel,
  effectiveLevels,
  isAdmin,
  levelOn,
  principalLevels,
  userLevels,
  type Principal,
  type UserPrincipal,
} from "../src/index.js";
import { raw, token, user } from "./fixtures.js";

describe("effective levels", () => {
  it("takes the lower of owner and token, and fails closed when the token level is missing", () => {
    expect(effectiveLevel("write", "read")).toBe("read");
    expect(effectiveLevel("read", "write")).toBe("read");
    expect(effectiveLevel("write", "none")).toBe("none");
    expect(effectiveLevel("read")).toBe("read");
    const tokenLevels: Partial<Record<Resource, Level>> = {};
    expect(() => effectiveLevel("write", tokenLevels.ideas)).toThrow(PolicyError);
  });

  it("takes the lower level per object and caps the activity log at read", () => {
    expect(effectiveLevels(raw("write"))).toEqual(FULL_ACCESS);
    const owner = { ...raw("write"), scripts: "read" } as const;
    expect(effectiveLevels(owner, { ...raw("write"), ideas: "none" })).toEqual({
      ...FULL_ACCESS,
      ideas: "none",
      scripts: "read",
    });
  });

  it("fails closed when a map is missing an object or inherits its levels", () => {
    const { ideas: _ideas, ...partial } = raw("write");
    expect(() => effectiveLevels(partial as ResourceLevels)).toThrow(
      "Owner levels have no level for ideas",
    );
    expect(() => effectiveLevels(raw("write"), partial as ResourceLevels)).toThrow(
      "Token levels have no level for ideas",
    );
    const inherited = Object.create(FULL_ACCESS) as ResourceLevels;
    expect(() => principalLevels(token(FULL_ACCESS, inherited))).toThrow(
      "Owner levels must be a plain object",
    );
  });
});

describe("users and admins", () => {
  it("gives admins the maximum everywhere, whatever is stored, and others their capped levels", () => {
    expect(userLevels({ isAdmin: true, levels: NO_ACCESS })).toEqual(FULL_ACCESS);
    expect(userLevels({ isAdmin: false, levels: raw("write") })).toEqual(FULL_ACCESS);
    expect(userLevels({ isAdmin: false, levels: { ...NO_ACCESS, notes: "read" } })).toEqual({
      ...NO_ACCESS,
      notes: "read",
    });
  });

  it("treats only an own, literal true as the admin flag", () => {
    for (const flag of ["true", 1, null, undefined]) {
      const levels = userLevels({ isAdmin: flag as unknown as boolean, levels: NO_ACCESS });
      expect(levels).toEqual(NO_ACCESS);
    }
    const { isAdmin: _own, ...record } = user(NO_ACCESS);
    const inheritedFlag = Object.assign(Object.create({ isAdmin: true }) as object, record);
    expect(isAdmin(inheritedFlag as UserPrincipal)).toBe(false);
  });

  it("never makes a token an admin, even when its owner is", () => {
    expect(isAdmin(user(NO_ACCESS, { isAdmin: true }))).toBe(true);
    expect(isAdmin(token(FULL_ACCESS, FULL_ACCESS, { ownerIsAdmin: true }))).toBe(false);
  });
});

describe("principals", () => {
  it("lowering a token's owner immediately lowers the token", () => {
    const lowered = token(raw("write"), { ...FULL_ACCESS, scripts: "read", notes: "none" });
    expect(principalLevels(token(raw("write"), FULL_ACCESS))).toEqual(FULL_ACCESS);
    expect(levelOn(lowered, "scripts")).toBe("read");
    expect(levelOn(lowered, "notes")).toBe("none");
    expect(levelOn(lowered, "ideas")).toBe("write");
  });

  it("rejects anything that is not a user or token principal, and unknown objects", () => {
    for (const value of [undefined, null, {}, { kind: "admin" }]) {
      expect(() => principalLevels(value as Principal)).toThrow(PolicyError);
    }
    expect(() => levelOn(user(FULL_ACCESS), "users" as Resource)).toThrow('Unknown object "users"');
  });
});
