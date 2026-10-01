// Level maps and admin flags are read through own properties only, and anything that is not a plain
// object is rejected with a PolicyError (review finding on T20). Each scenario below used to grant
// more than the data says.
import type { Level, Resource, ResourceLevels } from "@ytw/shared";
import { describe, expect, it } from "vitest";
import {
  FULL_ACCESS,
  NO_ACCESS,
  PolicyError,
  canGrant,
  effectiveLevels,
  grantCeiling,
  grantOptions,
  grantViolations,
  isAdmin,
  isPlainObject,
  levelsFromRecord,
  principalLevels,
  summarizeLevels,
  type Principal,
  type UserPrincipal,
} from "../src/index.js";
import { oracleFull, token, user } from "./fixtures.js";

type Requested = Partial<Record<Resource, Level>>;

/** Levels that only exist on the prototype: `levels.ideas === "write"`, but not as an own property. */
const inherited = (): ResourceLevels => Object.create(FULL_ACCESS) as ResourceLevels;

/** What `JSON.parse` makes of a body with a `__proto__` key: an own property, not a prototype. */
function jsonWithProto(rest: object): Record<string, unknown> {
  const fields = [`"__proto__":{"ideas":"write"}`, JSON.stringify(rest).slice(1, -1)];
  return JSON.parse(`{${fields.filter(Boolean).join(",")}}`) as Record<string, unknown>;
}

describe("plain-object check", () => {
  it("accepts object literals, JSON output and null-prototype objects only", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(JSON.parse('{"ideas":"read"}'))).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    for (const value of [null, undefined, "x", 1, [], new Map(), new Date(), inherited()]) {
      expect(isPlainObject(value)).toBe(false);
    }
  });
});

describe("inherited levels are never read", () => {
  it("principalLevels rejects a user whose levels inherit from FULL_ACCESS", () => {
    const principal: Principal = {
      kind: "user",
      userId: "u",
      username: "mallory",
      isAdmin: false,
      levels: inherited(),
    };
    expect(inherited().ideas).toBe("write");
    expect(() => principalLevels(principal)).toThrow(
      new PolicyError(
        "Owner levels must be a plain object with one own level per object, not [object Object]",
      ),
    );
  });

  it("rejects inherited token levels and inherited owner levels", () => {
    expect(() => principalLevels(token(inherited(), FULL_ACCESS))).toThrow(
      "Token levels must be a plain object",
    );
    expect(() => principalLevels(token(FULL_ACCESS, inherited()))).toThrow(
      "Owner levels must be a plain object",
    );
  });

  it("canGrant rejects an owner map that inherits from FULL_ACCESS", () => {
    expect(() => canGrant(inherited(), { ideas: "write" })).toThrow(PolicyError);
    expect(() => grantOptions(inherited())).toThrow(PolicyError);
  });

  it("rejects an object literal whose __proto__ sets the prototype", () => {
    const levels = { __proto__: FULL_ACCESS } as unknown as ResourceLevels;
    expect(levels.scripts).toBe("write");
    expect(() => principalLevels(user(levels))).toThrow(PolicyError);
    expect(() => canGrant(levels, {})).toThrow(PolicyError);
    const viaPrototype = { __proto__: { ideas: "write" } } as unknown as Requested;
    expect(viaPrototype.ideas).toBe("write");
    expect(() => grantViolations(FULL_ACCESS, viaPrototype)).toThrow(PolicyError);
  });

  it("summaries and parsing reject non-plain maps too", () => {
    expect(() => summarizeLevels(inherited())).toThrow(PolicyError);
    expect(() => levelsFromRecord(inherited())).toThrow(PolicyError);
    expect(() => levelsFromRecord(new Map() as unknown as Record<string, unknown>)).toThrow(
      "Stored levels must be a plain object with one own level per object, not [object Map]",
    );
  });

  it("only an own admin flag counts", () => {
    const fake = Object.assign(Object.create({ isAdmin: true }) as object, {
      kind: "user",
      userId: "u",
      username: "mallory",
      levels: NO_ACCESS,
    }) as UserPrincipal;
    expect(fake.isAdmin).toBe(true);
    expect(principalLevels(fake)).toEqual(NO_ACCESS);
    expect(isAdmin(fake)).toBe(false);
  });

  it("accepts null-prototype maps, which have no inherited properties at all", () => {
    const bare = Object.assign(Object.create(null) as object, FULL_ACCESS) as ResourceLevels;
    expect(principalLevels(user(bare))).toEqual(oracleFull());
    expect(principalLevels(token(bare, bare))).toEqual(oracleFull());
    expect(canGrant(bare, { ...FULL_ACCESS })).toBe(true);
  });
});

describe("requested levels must be a plain object", () => {
  it.each([
    ["a Map", new Map([["ideas", "write"]]), "[object Map]"],
    ["an array", [["ideas", "write"]], "[object Array]"],
    ["null", null, "[object Null]"],
    ["a string", "ideas=write", "[object String]"],
    ["an inherited map", inherited(), "[object Object]"],
  ])("canGrant throws for %s instead of seeing no requests", (_name, requested, tag) => {
    const call = () => canGrant(NO_ACCESS, requested as unknown as Requested);
    expect(call).toThrow(PolicyError);
    expect(call).toThrow(
      `Requested levels must be a plain object with one own level per object, not ${tag}`,
    );
  });
});

describe("__proto__ and constructor keys", () => {
  it("treats an own __proto__ key in a request as an unknown object", () => {
    const requested = jsonWithProto({ scripts: "read" }) as Requested;
    expect(Object.getPrototypeOf(requested)).toBe(Object.prototype);
    expect(grantViolations(NO_ACCESS, requested).map((v) => [v.resource, v.reason])).toEqual([
      ["__proto__", "unknown_resource"],
      ["scripts", "exceeds_owner"],
    ]);
    expect(canGrant(FULL_ACCESS, jsonWithProto({}) as Requested)).toBe(false);
  });

  it("ignores an own __proto__ key in stored levels and never reads through it", () => {
    expect(levelsFromRecord(jsonWithProto({}))).toEqual(NO_ACCESS);
    const owner = jsonWithProto({ ...NO_ACCESS }) as ResourceLevels;
    expect(effectiveLevels(owner)).toEqual(NO_ACCESS);
    expect(canGrant(owner, { ideas: "write" })).toBe(false);
    expect(() => effectiveLevels(jsonWithProto({}) as ResourceLevels)).toThrow(
      "Owner levels have no level for ideas",
    );
  });

  it("treats constructor like any other unknown key", () => {
    expect(grantViolations(FULL_ACCESS, { constructor: "write" } as unknown as Requested)).toEqual([
      expect.objectContaining({ resource: "constructor", reason: "unknown_resource" }),
    ]);
    expect(levelsFromRecord({ constructor: "write", ideas: "read" })).toEqual({
      ...NO_ACCESS,
      ideas: "read",
    });
    const withConstructor = { ...NO_ACCESS, constructor: "write" } as ResourceLevels;
    expect(principalLevels(user(withConstructor))).toEqual(NO_ACCESS);
  });

  it("names the missing object when a map lacks one", () => {
    const { notes: _notes, ...partial } = FULL_ACCESS;
    expect(() => principalLevels(token(partial as ResourceLevels, FULL_ACCESS))).toThrow(
      "Token levels have no level for notes",
    );
  });
});

describe("grant owner given as a user record", () => {
  it("applies the admin rule when given the owner's record", () => {
    const adminRecord = { isAdmin: true, levels: NO_ACCESS };
    expect(grantCeiling(adminRecord)).toEqual(oracleFull());
    expect(canGrant(adminRecord, { ...FULL_ACCESS })).toBe(true);
    expect(canGrant(user(NO_ACCESS, { isAdmin: true }), { ideas: "write" })).toBe(true);
    expect(grantOptions(adminRecord).activity).toEqual(["none", "read"]);
  });

  it("uses the stored levels of a non-admin record", () => {
    const reader = { isAdmin: false, levels: { ...NO_ACCESS, ideas: "read" } as ResourceLevels };
    expect(canGrant(reader, { ideas: "read" })).toBe(true);
    expect(canGrant(reader, { ideas: "write" })).toBe(false);
    expect(canGrant({ ...reader, isAdmin: "true" as unknown as boolean }, { ideas: "write" })).toBe(
      false,
    );
  });

  it("treats a bare map as already-effective levels (an admin's stored map is not enough)", () => {
    expect(canGrant(NO_ACCESS, { ideas: "write" })).toBe(false);
  });

  it("fails closed for anything that is neither a record nor a complete map", () => {
    // Own isAdmin but no levels: read as a level map, which lacks every object.
    expect(() => canGrant({ isAdmin: true } as unknown as ResourceLevels, {})).toThrow(
      "Owner levels have no level for ideas",
    );
    // A token is not a user record and cannot grant anything.
    expect(() =>
      canGrant(token(FULL_ACCESS, FULL_ACCESS) as unknown as ResourceLevels, {}),
    ).toThrow(PolicyError);
    // An inherited admin flag does not make a record.
    const inheritedFlag = Object.assign(Object.create({ isAdmin: true }) as object, {
      levels: NO_ACCESS,
    }) as unknown as ResourceLevels;
    expect(() => canGrant(inheritedFlag, {})).toThrow(PolicyError);
    expect(() => grantCeiling(new Map() as unknown as ResourceLevels)).toThrow(PolicyError);
  });
});
