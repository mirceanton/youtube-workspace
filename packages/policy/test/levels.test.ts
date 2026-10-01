import { LEVELS, RESOURCES, type Level, type Resource } from "@ytw/shared";
import { describe, expect, it } from "vitest";
import {
  FULL_ACCESS,
  NO_ACCESS,
  PolicyError,
  assertResource,
  capLevel,
  compareLevels,
  isLevel,
  isResource,
  levelRank,
  levelsEverywhere,
  levelsFromRecord,
  levelsFromRows,
  mapResources,
  maxLevelFor,
  minLevel,
  satisfies,
} from "../src/index.js";
import { VALID_OBJECTS, oracleFull, oracleMax } from "./fixtures.js";

const bogus = "admin" as unknown as Level;

describe("level ordering", () => {
  it("ranks none < read < write, in LEVELS order", () => {
    expect(LEVELS.map(levelRank)).toEqual([0, 1, 2]);
    expect(
      ["write", "none", "read"].toSorted(compareLevels as (a: string, b: string) => number),
    ).toEqual(["none", "read", "write"]);
    expect(compareLevels("read", "read")).toBe(0);
  });

  it.each([
    ["none", "none", true],
    ["none", "read", false],
    ["none", "write", false],
    ["read", "none", true],
    ["read", "read", true],
    ["read", "write", false],
    ["write", "none", true],
    ["write", "read", true],
    ["write", "write", true],
  ] as const)("having %s satisfies needing %s: %s", (have, need, expected) => {
    expect(satisfies(have, need)).toBe(expected);
  });

  it.each([
    ["none", "write", "none"],
    ["write", "none", "none"],
    ["read", "write", "read"],
    ["write", "read", "read"],
    ["write", "write", "write"],
  ] as const)("minLevel(%s, %s) = %s", (a, b, expected) => {
    expect(minLevel(a, b)).toBe(expected);
  });

  it("throws a PolicyError for anything that is not a level, instead of comparing it", () => {
    for (const value of [bogus, undefined, null, "", "WRITE", 2]) {
      expect(() => levelRank(value as Level)).toThrow(PolicyError);
    }
    expect(() => levelRank(bogus)).toThrow(
      'Unknown access level "admin"; valid levels: none, read, write',
    );
    expect(() => satisfies(bogus, "read")).toThrow(PolicyError);
    expect(() => satisfies("write", bogus)).toThrow(PolicyError);
    expect(() => minLevel("none", bogus)).toThrow(PolicyError);
  });
});

describe("guards", () => {
  it("recognises levels and resources from @ytw/shared only", () => {
    for (const level of LEVELS) expect(isLevel(level)).toBe(true);
    for (const resource of RESOURCES) expect(isResource(resource)).toBe(true);
    for (const value of ["admin", "users", "", undefined, null, 1, {}]) {
      expect(isLevel(value)).toBe(false);
      expect(isResource(value)).toBe(false);
    }
  });

  it("assertResource names the valid objects", () => {
    expect(() => assertResource("ideas")).not.toThrow();
    expect(() => assertResource("users")).toThrow(
      `Unknown object "users"; valid objects: ${VALID_OBJECTS}`,
    );
  });

  it("PolicyError is an Error with its own name", () => {
    const error = new PolicyError("x");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PolicyError");
  });
});

describe("per-object ceilings", () => {
  it("caps the activity log at read and allows write everywhere else", () => {
    for (const resource of RESOURCES) {
      expect(maxLevelFor(resource)).toBe(oracleMax(resource));
      expect(capLevel(resource, "write")).toBe(oracleMax(resource));
      expect(capLevel(resource, "read")).toBe("read");
      expect(capLevel(resource, "none")).toBe("none");
    }
  });

  it("rejects unknown resources", () => {
    expect(() => maxLevelFor("users" as Resource)).toThrow(PolicyError);
    expect(() => capLevel("users" as Resource, "read")).toThrow(PolicyError);
  });

  it("builds complete maps from the shared resource list", () => {
    expect(Object.keys(mapResources(() => 0))).toEqual([...RESOURCES]);
    expect(NO_ACCESS).toEqual(Object.fromEntries(RESOURCES.map((r) => [r, "none"])));
    expect(FULL_ACCESS).toEqual(oracleFull());
    expect(FULL_ACCESS.activity).toBe("read");
    expect(levelsEverywhere("write")).toEqual(FULL_ACCESS);
    expect(levelsEverywhere("read")).toEqual(Object.fromEntries(RESOURCES.map((r) => [r, "read"])));
    expect(Object.isFrozen(NO_ACCESS) && Object.isFrozen(FULL_ACCESS)).toBe(true);
    expect(() => levelsEverywhere(bogus)).toThrow(PolicyError);
  });
});

describe("parsing stored levels", () => {
  it("fills objects without a row with none (fail closed)", () => {
    expect(levelsFromRows([])).toEqual(NO_ACCESS);
    expect(
      levelsFromRows([
        { resource: "ideas", level: "write" },
        { resource: "activity", level: "read" },
      ]),
    ).toEqual({ ...NO_ACCESS, ideas: "write", activity: "read" });
  });

  it("ignores objects this code does not know, so a migration can ship before the code", () => {
    expect(
      levelsFromRows([
        { resource: "not_an_object", level: "write" },
        { resource: "not_an_object", level: "garbage" },
        { resource: "scripts", level: "read" },
      ]),
    ).toEqual({ ...NO_ACCESS, scripts: "read" });
  });

  it("throws on an unknown level or a duplicate row", () => {
    expect(() => levelsFromRows([{ resource: "ideas", level: "admin" }])).toThrow(
      'Unknown access level "admin" for ideas; valid levels: none, read, write',
    );
    expect(() => levelsFromRows([{ resource: "ideas", level: null }])).toThrow(PolicyError);
    expect(() =>
      levelsFromRows([
        { resource: "ideas", level: "none" },
        { resource: "ideas", level: "write" },
      ]),
    ).toThrow("More than one level given for ideas");
  });

  it("does not let the returned map alias NO_ACCESS", () => {
    const levels = levelsFromRows([]);
    levels.ideas = "write";
    expect(NO_ACCESS.ideas).toBe("none");
  });

  it("parses an object such as a jsonb column the same way", () => {
    expect(levelsFromRecord({ ideas: "read", videos: "write", unknown: "write" })).toEqual({
      ...NO_ACCESS,
      ideas: "read",
      videos: "write",
    });
    expect(() => levelsFromRecord({ notes: 3 })).toThrow(PolicyError);
  });
});
