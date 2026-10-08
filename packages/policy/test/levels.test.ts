import { LEVELS, RESOURCES, type Level, type Resource } from "@ytw/shared";
import { describe, expect, it } from "vitest";
import {
  FULL_ACCESS,
  NO_ACCESS,
  PolicyError,
  capLevel,
  levelRank,
  levelsFromRows,
  maxLevelFor,
  minLevel,
  satisfies,
} from "../src/index.js";

describe("level ordering", () => {
  it("ranks none < read < write, and write includes read", () => {
    expect(LEVELS.map(levelRank)).toEqual([0, 1, 2]);
    expect(satisfies("write", "read")).toBe(true);
    expect(satisfies("read", "write")).toBe(false);
    expect(minLevel("write", "read")).toBe("read");
    expect(minLevel("none", "write")).toBe("none");
  });

  it("throws a PolicyError for a corrupt level instead of comparing it", () => {
    for (const value of ["admin", undefined, null, "", "WRITE", 2]) {
      expect(() => levelRank(value as Level)).toThrow(PolicyError);
    }
    expect(() => levelRank("admin" as Level)).toThrow(
      'Unknown access level "admin"; valid levels: none, read, write',
    );
    expect(() => satisfies("write", "admin" as Level)).toThrow(PolicyError);
  });
});

describe("per-object ceilings", () => {
  it("caps the activity log at read and allows write everywhere else", () => {
    for (const resource of RESOURCES) {
      const max = resource === "activity" ? "read" : "write";
      expect(maxLevelFor(resource)).toBe(max);
      expect(capLevel(resource, "write")).toBe(max);
    }
    expect(() => capLevel("users" as Resource, "read")).toThrow(PolicyError);
    expect(Object.values(NO_ACCESS)).toEqual(RESOURCES.map(() => "none"));
    expect(FULL_ACCESS.activity).toBe("read");
    expect(FULL_ACCESS.ideas).toBe("write");
  });
});

describe("parsing stored levels", () => {
  it("fills objects without a row with none, and ignores objects this code does not know", () => {
    expect(levelsFromRows([])).toEqual(NO_ACCESS);
    expect(
      levelsFromRows([
        { resource: "not_an_object", level: "garbage" },
        { resource: "scripts", level: "read" },
      ]),
    ).toEqual({ ...NO_ACCESS, scripts: "read" });
  });

  it("throws on an unknown level or a duplicate row", () => {
    expect(() => levelsFromRows([{ resource: "ideas", level: "admin" }])).toThrow(
      'Unknown access level "admin" for ideas; valid levels: none, read, write',
    );
    expect(() =>
      levelsFromRows([
        { resource: "ideas", level: "none" },
        { resource: "ideas", level: "write" },
      ]),
    ).toThrow("More than one level given for ideas");
  });
});
