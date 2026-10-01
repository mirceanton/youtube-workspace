import type { Level, Resource } from "@ytw/shared";
import { describe, expect, it } from "vitest";
import {
  FULL_ACCESS,
  NO_ACCESS,
  PolicyError,
  assertPrincipal,
  describePrincipal,
  effectiveLevel,
  effectiveLevels,
  levelOn,
  principalLevels,
  userLevels,
  type Principal,
} from "../src/index.js";
import { oracleFull, raw, token, user } from "./fixtures.js";

describe("effectiveLevel", () => {
  it.each([
    ["none", "none", "none"],
    ["none", "read", "none"],
    ["none", "write", "none"],
    ["read", "none", "none"],
    ["read", "read", "read"],
    ["read", "write", "read"],
    ["write", "none", "none"],
    ["write", "read", "read"],
    ["write", "write", "write"],
  ] as const)("owner %s, token %s -> %s", (owner, tokenLevel, expected) => {
    expect(effectiveLevel(owner, tokenLevel)).toBe(expected);
  });

  it.each(["none", "read", "write"] as const)("without a token is the owner's %s", (owner) => {
    expect(effectiveLevel(owner)).toBe(owner);
  });

  it("validates the owner level even without a token", () => {
    expect(() => effectiveLevel("admin" as Level)).toThrow(PolicyError);
  });

  it("fails closed when a token level is passed but missing", () => {
    const tokenLevels: Partial<Record<Resource, Level>> = {};
    expect(() => effectiveLevel("write", tokenLevels.ideas)).toThrow(PolicyError);
  });
});

describe("effectiveLevels", () => {
  it("takes the lower level per object and caps the activity log at read", () => {
    expect(effectiveLevels(raw("write"))).toEqual(FULL_ACCESS);
    expect(
      effectiveLevels(
        { ...raw("write"), scripts: "read", notes: "none" },
        { ...raw("write"), ideas: "none", videos: "read" },
      ),
    ).toEqual({ ...oracleFull(), ideas: "none", scripts: "read", videos: "read", notes: "none" });
  });

  it("fails closed when a map is missing an object", () => {
    const { ideas: _ideas, ...partial } = raw("write");
    expect(() => effectiveLevels(partial as typeof NO_ACCESS)).toThrow(PolicyError);
    expect(() => effectiveLevels(raw("write"), partial as typeof NO_ACCESS)).toThrow(PolicyError);
  });
});

describe("userLevels", () => {
  it("gives admins the maximum everywhere, whatever is stored", () => {
    expect(userLevels({ isAdmin: true, levels: NO_ACCESS })).toEqual(FULL_ACCESS);
  });

  it("returns a fresh object for admins", () => {
    const levels = userLevels({ isAdmin: true, levels: NO_ACCESS });
    levels.ideas = "none";
    expect(FULL_ACCESS.ideas).toBe("write");
  });

  it("uses the stored levels, capped, for everyone else", () => {
    expect(userLevels({ isAdmin: false, levels: raw("write") })).toEqual(FULL_ACCESS);
    expect(userLevels({ isAdmin: false, levels: { ...NO_ACCESS, notes: "read" } })).toEqual({
      ...NO_ACCESS,
      notes: "read",
    });
  });

  it("treats only a literal true as admin", () => {
    for (const isAdmin of ["true", "f", 1, null, undefined]) {
      expect(userLevels({ isAdmin: isAdmin as unknown as boolean, levels: NO_ACCESS })).toEqual(
        NO_ACCESS,
      );
    }
  });
});

describe("principals", () => {
  it("resolves a user and a token", () => {
    expect(principalLevels(user({ ...NO_ACCESS, ideas: "read" }))).toEqual({
      ...NO_ACCESS,
      ideas: "read",
    });
    expect(principalLevels(token(raw("write"), { ...NO_ACCESS, scripts: "write" }))).toEqual({
      ...NO_ACCESS,
      scripts: "write",
    });
  });

  it("rejects anything that is not a user or token principal", () => {
    for (const value of [undefined, null, {}, { kind: "admin" }, "user"]) {
      expect(() => assertPrincipal(value)).toThrow(PolicyError);
      expect(() => principalLevels(value as Principal)).toThrow(PolicyError);
    }
    expect(() => assertPrincipal({ kind: "service" })).toThrow(
      'Unknown principal kind "service"; expected user or token',
    );
    expect(() => assertPrincipal(user(NO_ACCESS))).not.toThrow();
  });

  it("levelOn names an unknown object instead of returning undefined", () => {
    expect(() => levelOn(user(FULL_ACCESS), "users" as Resource)).toThrow('Unknown object "users"');
  });

  it("describes principals for messages, quoting names safely", () => {
    expect(describePrincipal(user(NO_ACCESS))).toBe('user "alice"');
    expect(describePrincipal(token(NO_ACCESS, NO_ACCESS))).toBe(
      'token "editor-bot" (owner "alice")',
    );
    expect(describePrincipal({ ...token(NO_ACCESS, NO_ACCESS), tokenName: 'a"b\nc' })).toBe(
      'token "a\\"b\\nc" (owner "alice")',
    );
    expect(() => describePrincipal({ kind: "x" } as unknown as Principal)).toThrow(PolicyError);
  });
});
