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

  it("keeps a bounded, inspectable preview of unusually large changed blocks", () => {
    const before = `${Array.from({ length: 700 }, (_, index) => `old ${index}`).join("\n")}\nlast`;
    const after = `${Array.from({ length: 700 }, (_, index) => `new ${index}`).join("\n")}\nlast`;
    const diff = diffScriptLines(before, after);
    expect(diff.summarized).toBe(true);
    expect(diff.lines.length).toBeLessThanOrEqual(203);
    expect(diff.lines[0]).toMatchObject({ kind: "removed", leftText: "old 0", leftNumber: 1 });
    expect(diff.lines).toContainEqual({ kind: "added", rightText: "new 0", rightNumber: 1 });
    expect(diff.lines).toContainEqual({
      kind: "summary",
      leftStart: 101,
      rightStart: 101,
      leftCount: 600,
      rightCount: 600,
    });
    expect(diff.lines.at(-1)).toMatchObject({
      kind: "context",
      leftText: "last",
      rightText: "last",
    });
  });

  it("shows the changed lines for a sparse edit in a large script", () => {
    const before = Array.from({ length: 700 }, (_, index) => `line ${index}`).join("\n");
    const afterLines = before.split("\n");
    afterLines[350] = "edited line 350";
    const diff = diffScriptLines(before, afterLines.join("\n"));

    expect(diff.summarized).toBe(true);
    expect(diff.lines).toContainEqual({ kind: "removed", leftText: "line 350", leftNumber: 351 });
    expect(diff.lines).toContainEqual({
      kind: "added",
      rightText: "edited line 350",
      rightNumber: 351,
    });
    expect(diff.lines.length).toBeLessThan(25);
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

  it("preserves base context in both alternatives when an insertion overlaps a wider edit", () => {
    const merged = mergeScriptBodies("a\nb\nc", "A\nB\nc", "a\nX\nb\nc");
    expect(merged).toBe("<<<<<<< Your changes\na\nX\nb\n=======\nA\nB\n>>>>>>> Latest version\nc");
  });
});
