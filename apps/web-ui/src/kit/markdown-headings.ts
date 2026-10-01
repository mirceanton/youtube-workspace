// Heading levels inside agent- or user-written markdown must fit the page around them: the page has
// its own h1 (and usually h2 sections), and a heading level must never skip a level (WCAG 1.3.1,
// axe "heading-order"). This remark plugin re-levels every heading of a document:
//  - the shallowest heading becomes `start` (default h3), the others keep their relative depth,
//  - no heading is more than one level deeper than the one before it, whatever the source did,
//  - nothing goes below h6.

interface MdNode {
  type: string;
  depth?: number;
  children?: MdNode[];
}

function collectHeadings(node: MdNode, into: MdNode[]): void {
  if (node.type === "heading" && typeof node.depth === "number") into.push(node);
  for (const child of node.children ?? []) collectHeadings(child, into);
}

/** Pure re-levelling on the mdast tree; exported for tests. */
export function normalizeHeadings(tree: MdNode, start: number): void {
  const headings: MdNode[] = [];
  collectHeadings(tree, headings);
  if (headings.length === 0) return;

  const shallowest = Math.min(...headings.map((h) => h.depth ?? 1));
  let previous = start - 1;
  for (const heading of headings) {
    const shifted = (heading.depth ?? 1) - shallowest + start;
    const level = Math.min(shifted, previous + 1, 6);
    heading.depth = level;
    previous = level;
  }
}

/** remark plugin factory: `remarkPlugins={[remarkHeadingLevels(3)]}`. */
export function remarkHeadingLevels(start: number) {
  return () => (tree: MdNode) => {
    normalizeHeadings(tree, start);
  };
}
