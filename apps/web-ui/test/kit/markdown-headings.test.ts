import { describe, expect, it } from "vitest";
import { normalizeHeadings, remarkHeadingLevels } from "../../src/kit/markdown-headings.ts";

interface Node {
  type: string;
  depth?: number;
  children?: Node[];
}

const heading = (depth: number): Node => ({ type: "heading", depth });
const tree = (...children: Node[]): Node => ({ type: "root", children });
const depths = (root: Node): number[] =>
  (root.children ?? []).flatMap((child) => (child.depth === undefined ? [] : [child.depth]));

describe("normalizeHeadings", () => {
  it("makes the shallowest heading the start level and keeps relative depth", () => {
    const root = tree(heading(1), heading(2), heading(3), heading(2));
    normalizeHeadings(root, 3);
    expect(depths(root)).toEqual([3, 4, 5, 4]);
  });

  it("treats a document that starts at h2 or h3 like one that starts at h1", () => {
    const fromTwo = tree(heading(2), heading(3));
    normalizeHeadings(fromTwo, 3);
    expect(depths(fromTwo)).toEqual([3, 4]);
    const fromThree = tree(heading(3), heading(4), heading(3));
    normalizeHeadings(fromThree, 3);
    expect(depths(fromThree)).toEqual([3, 4, 3]);
  });

  it("never skips a level, however far the source jumps", () => {
    const root = tree(heading(1), heading(6), heading(2), heading(5));
    normalizeHeadings(root, 3);
    // 1 -> 6 would skip: capped at one deeper than the previous heading, then back up, then capped again.
    expect(depths(root)).toEqual([3, 4, 4, 5]);
  });

  it("stops at h6", () => {
    const root = tree(heading(1), heading(2), heading(3), heading(4));
    normalizeHeadings(root, 5);
    expect(depths(root)).toEqual([5, 6, 6, 6]);
  });

  it("finds headings nested in lists and quotes, in document order", () => {
    const root: Node = {
      type: "root",
      children: [
        { type: "blockquote", children: [heading(2)] },
        { type: "list", children: [{ type: "listItem", children: [heading(4)] }] },
        heading(2),
      ],
    };
    normalizeHeadings(root, 3);
    const nested = [
      root.children?.[0]?.children?.[0]?.depth,
      root.children?.[1]?.children?.[0]?.children?.[0]?.depth,
      root.children?.[2]?.depth,
    ];
    expect(nested).toEqual([3, 4, 3]);
  });

  it("leaves documents without headings alone", () => {
    const root = tree({ type: "paragraph" });
    normalizeHeadings(root, 3);
    expect(root).toEqual(tree({ type: "paragraph" }));
  });

  it("is a remark plugin factory", () => {
    const root = tree(heading(1));
    remarkHeadingLevels(4)()(root);
    expect(depths(root)).toEqual([4]);
  });
});
