import { describe, expect, it } from "vitest";
import { diffScriptLines, mergeScriptBodies } from "../../src/features/scripts/script-diff.ts";

function manyLines(prefix: string): string {
  return Array.from({ length: 700 }, (_, i) => `${prefix} ${i}`).join("\n");
}

describe("script version comparison", () => {
  it("marks changed lines and keeps context with both line numbers", () => {
    const diff = diffScriptLines("opening\nold line\nending", "opening\nnew line\nending");
    expect(diff.summarized).toBe(false);
    expect(diff.lines.map((line) => line.kind)).toEqual(["context", "removed", "added", "context"]);
    expect(diff.lines[1]).toEqual({ kind: "removed", leftText: "old line", leftNumber: 2 });
    expect(diff.lines[2]).toEqual({ kind: "added", rightText: "new line", rightNumber: 2 });
  });

  it("keeps a bounded preview of unusually large changes", () => {
    const diff = diffScriptLines(`${manyLines("old")}\nlast`, `${manyLines("new")}\nlast`);
    expect(diff.summarized).toBe(true);
    expect(diff.lines.length).toBeLessThanOrEqual(203);
    expect(diff.lines.at(-1)).toMatchObject({ kind: "context", leftText: "last" });
  });

  it("merges edits to separate lines", () => {
    expect(mergeScriptBodies("one\ntwo\nthree", "ONE\ntwo\nthree", "one\ntwo\nTHREE")).toBe(
      "ONE\ntwo\nTHREE",
    );
  });

  it("marks overlapping edits so the user must resolve both copies", () => {
    const merged = mergeScriptBodies("intro\nold\nend", "intro\nlatest\nend", "intro\nyours\nend");
    expect(merged).toContain(
      "<<<<<<< Your changes\nyours\n=======\nlatest\n>>>>>>> Latest version",
    );
  });
});
