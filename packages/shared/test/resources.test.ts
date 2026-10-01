import { describe, expect, it } from "vitest";
import {
  GRANTABLE_LEVELS,
  LEVELS,
  RESOURCE_LABELS,
  RESOURCES,
  levelSchema,
  resourceLevelsSchema,
  resourceSchema,
  type ResourceLevels,
} from "../src/index.js";

const allRead: ResourceLevels = {
  ideas: "read",
  scripts: "read",
  experiments: "read",
  videos: "read",
  notes: "read",
  activity: "read",
};

describe("resources and levels", () => {
  it("lists the PRD 7 objects and levels", () => {
    expect(RESOURCES).toEqual(["ideas", "scripts", "experiments", "videos", "notes", "activity"]);
    expect(LEVELS).toEqual(["none", "read", "write"]);
    expect(resourceSchema.safeParse("users").success).toBe(false);
    expect(levelSchema.safeParse("admin").success).toBe(false);
  });

  it("caps the activity log at read and allows every level elsewhere", () => {
    for (const resource of RESOURCES) {
      const expected = resource === "activity" ? ["none", "read"] : ["none", "read", "write"];
      expect(GRANTABLE_LEVELS[resource]).toEqual(expected);
    }
  });

  it("has a label for every resource", () => {
    expect(Object.keys(RESOURCE_LABELS).toSorted()).toEqual(RESOURCES.toSorted());
  });

  it("accepts a complete, grantable level map", () => {
    expect(resourceLevelsSchema.parse(allRead)).toEqual(allRead);
  });

  it("rejects write on the activity log with a readable message", () => {
    const result = resourceLevelsSchema.safeParse({ ...allRead, activity: "write" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["activity"]);
    expect(result.error?.issues[0]?.message).toBe(
      '"write" is not allowed for activity; valid levels: none, read',
    );
  });

  it("rejects a map with a missing resource or an unknown one", () => {
    const { notes: _notes, ...missingNotes } = allRead;
    expect(resourceLevelsSchema.safeParse(missingNotes).success).toBe(false);
    expect(resourceLevelsSchema.safeParse({ ...allRead, users: "read" }).success).toBe(false);
  });
});
