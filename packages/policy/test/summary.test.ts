import { RESOURCES } from "@ytw/shared";
import { describe, expect, it } from "vitest";
import {
  FULL_ACCESS,
  NO_ACCESS,
  describeLevels,
  principalLevels,
  summarizeLevels,
} from "../src/index.js";
import { oracleMax, raw, token } from "./fixtures.js";

describe("summarizeLevels", () => {
  it("groups objects by capped level in RESOURCES order", () => {
    expect(summarizeLevels(raw("write"))).toEqual({
      write: RESOURCES.filter((r) => oracleMax(r) === "write"),
      read: RESOURCES.filter((r) => oracleMax(r) === "read"),
      none: [],
    });
    expect(summarizeLevels(raw("write")).read).toContain("activity");
    expect(summarizeLevels({ ...NO_ACCESS, notes: "write", ideas: "read" })).toEqual({
      write: ["notes"],
      read: ["ideas"],
      none: RESOURCES.filter((r) => r !== "notes" && r !== "ideas"),
    });
  });
});

describe("describeLevels", () => {
  it.each([
    ["no access", NO_ACCESS, "No access"],
    ["the maximum everywhere", FULL_ACCESS, "Full access"],
    ["write stored everywhere (activity capped)", raw("write"), "Full access"],
    ["read everywhere", raw("read"), "Read on everything"],
    [
      "the PRD 7 collaborator",
      {
        ...NO_ACCESS,
        ideas: "write",
        scripts: "write",
        experiments: "write",
        videos: "read",
        notes: "write",
        activity: "read",
      },
      "Write: Ideas, Scripts, Experiments, Notes; Read: Videos and metrics, Activity log",
    ],
    [
      "the PRD 7 reader",
      {
        ...NO_ACCESS,
        ideas: "read",
        scripts: "read",
        experiments: "read",
        videos: "read",
        notes: "read",
      },
      "Read: Ideas, Scripts, Experiments, Videos and metrics, Notes",
    ],
    ["write only", { ...NO_ACCESS, scripts: "write" }, "Write: Scripts"],
    [
      "write on every content object, nothing on the activity log",
      {
        ...NO_ACCESS,
        ideas: "write",
        scripts: "write",
        experiments: "write",
        videos: "write",
        notes: "write",
      },
      "Write: Ideas, Scripts, Experiments, Videos and metrics, Notes",
    ],
  ] as const)("%s", (_name, levels, expected) => {
    expect(describeLevels(levels)).toBe(expected);
  });

  it("summarises a token's effective levels after its owner was lowered", () => {
    const owner = { ...NO_ACCESS, ideas: "write", scripts: "read", experiments: "write" } as const;
    const lowered = token(FULL_ACCESS, { ...owner, videos: "write", activity: "read" });
    expect(describeLevels(principalLevels(lowered))).toBe(
      "Write: Ideas, Experiments, Videos and metrics; Read: Scripts, Activity log",
    );
  });
});
