import { describe, expect, it } from "vitest";
import { FULL_ACCESS, NO_ACCESS, describeLevels } from "../src/index.js";
import { raw } from "./fixtures.js";

describe("describeLevels", () => {
  it.each([
    ["no access", NO_ACCESS, "No access"],
    ["the maximum everywhere", FULL_ACCESS, "Full access"],
    ["write stored everywhere (activity capped)", raw("write"), "Full access"],
    ["read everywhere", raw("read"), "Read on everything"],
    ["write only", { ...NO_ACCESS, scripts: "write" }, "Write: Scripts"],
    [
      "a collaborator",
      { ...NO_ACCESS, ideas: "write", scripts: "write", videos: "read", activity: "read" },
      "Write: Ideas, Scripts; Read: Videos and metrics, Activity log",
    ],
  ] as const)("%s", (_name, levels, expected) => {
    expect(describeLevels(levels)).toBe(expected);
  });
});
