import { describe, expect, it } from "vitest";
import { diffScriptLines, mergeScriptBodies } from "../../../src/features/scripts/script-diff.ts";

describe("script version comparison", () => {
  it("marks changed lines and preserves context with both line numbers", () => {
    const diff = diffScriptLines("opening\nold line\nending", "opening\nnew line\nending");
    expect(diff.summarized).toBe(false);
    expect(diff.lines).toEqual([
      {
        kind: "context",
        leftText: "opening",
        rightText: "opening",
        leftNumber: 1,
        rightNumber: 1,
      },
      { kind: "removed", leftText: "old line", leftNumber: 2 },
      { kind: "added", rightText: "new line", rightNumber: 2 },
      {
        kind: "context",
        leftText: "ending",
        rightText: "ending",
        leftNumber: 3,
        rightNumber: 3,
      },
    ]);
  });

  it("summarizes unusually large diffs while retaining matching edges", () => {
    const before = `${Array.from({ length: 700 }, (_, index) => `old ${index}`).join("\n")}\nlast`;
    const after = `${Array.from({ length: 700 }, (_, index) => `new ${index}`).join("\n")}\nlast`;
    const diff = diffScriptLines(before, after);
    expect(diff.summarized).toBe(true);
    expect(diff.lines).toHaveLength(2);
    expect(diff.lines[0]).toMatchObject({
      kind: "summary",
      leftStart: 1,
      rightStart: 1,
      leftCount: 700,
      rightCount: 700,
    });
    expect(diff.lines.at(-1)).toMatchObject({
      kind: "context",
      leftText: "last",
      rightText: "last",
    });
  });

  it("merges edits to separate lines and leaves the newer line positions intact", () => {
    expect(mergeScriptBodies("one\ntwo\nthree", "ONE\ntwo\nthree", "one\ntwo\nTHREE")).toBe(
      "ONE\ntwo\nTHREE",
    );
  });

  it("marks overlapping edits so the user must resolve both copies", () => {
    const merged = mergeScriptBodies("intro\nold\nend", "intro\nlatest\nend", "intro\nyours\nend");
    expect(merged).toContain(
      "<<<<<<< Your changes\nyours\n=======\nlatest\n>>>>>>> Latest version",
    );
    expect(merged).toContain("intro\n");
    expect(merged.endsWith("\nend")).toBe(true);
  });
});
