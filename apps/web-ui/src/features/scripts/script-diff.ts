export type DiffLine =
  | {
      kind: "context";
      leftText: string;
      rightText: string;
      leftNumber: number;
      rightNumber: number;
    }
  | { kind: "removed"; leftText: string; leftNumber: number }
  | { kind: "added"; rightText: string; rightNumber: number }
  | {
      kind: "summary";
      leftStart: number;
      rightStart: number;
      leftCount: number;
      rightCount: number;
    }
  | { kind: "omitted-context"; count: number };

export interface ScriptDiff {
  lines: DiffLine[];
  /** True when a very large diff uses matching edges and bounded previews instead of an LCS. */
  summarized: boolean;
}

const MAX_LCS_CELLS = 400_000;
const MAX_CONTEXT_LINES_PER_EDGE = 3;
const MAX_CHANGED_LINES_PER_SIDE = 100;

/** Line diff with an LCS for ordinary scripts and a prefix/suffix summary for very large edits. */
export function diffScriptLines(before: string, after: string): ScriptDiff {
  const left = before.split("\n");
  const right = after.split("\n");
  if (left.length * right.length > MAX_LCS_CELLS) {
    return { lines: summarizeChange(left, right), summarized: true };
  }

  const lcs: Uint32Array[] = Array.from(
    { length: left.length + 1 },
    () => new Uint32Array(right.length + 1),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    const row = lcs[i];
    const next = lcs[i + 1];
    if (!row || !next) continue;
    for (let j = right.length - 1; j >= 0; j -= 1) {
      if (left[i] === right[j]) row[j] = (next[j + 1] ?? 0) + 1;
      else row[j] = Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      lines.push({
        kind: "context",
        leftText: left[i] ?? "",
        rightText: right[j] ?? "",
        leftNumber: i + 1,
        rightNumber: j + 1,
      });
      i += 1;
      j += 1;
    } else if (
      i < left.length &&
      (j >= right.length || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))
    ) {
      lines.push({ kind: "removed", leftText: left[i] ?? "", leftNumber: i + 1 });
      i += 1;
    } else {
      lines.push({ kind: "added", rightText: right[j] ?? "", rightNumber: j + 1 });
      j += 1;
    }
  }
  return { lines, summarized: false };
}

interface Change {
  start: number;
  end: number;
  replacement: string[];
}

function changeFromBase(base: readonly string[], side: readonly string[]): Change {
  let start = 0;
  while (start < base.length && start < side.length && base[start] === side[start]) start += 1;
  let suffix = 0;
  while (
    suffix < base.length - start &&
    suffix < side.length - start &&
    base[base.length - suffix - 1] === side[side.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return {
    start,
    end: base.length - suffix,
    replacement: side.slice(start, side.length - suffix),
  };
}

function changesOverlap(left: Change, right: Change): boolean {
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;
  if (leftInsertion && rightInsertion) return left.start === right.start;
  if (leftInsertion) return left.start >= right.start && left.start <= right.end;
  if (rightInsertion) return right.start >= left.start && right.start <= left.end;
  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function applyChangeToRange(
  base: readonly string[],
  change: Change,
  rangeStart: number,
  rangeEnd: number,
): string[] {
  return [
    ...base.slice(rangeStart, change.start),
    ...change.replacement,
    ...base.slice(change.end, rangeEnd),
  ];
}

/**
 * Merges one contiguous edit from each side. Overlapping edits become explicit conflict markers
 * for the editor to resolve; no side is silently discarded.
 */
export function mergeScriptBodies(baseText: string, latestText: string, yoursText: string): string {
  if (yoursText === baseText || latestText === yoursText) return latestText;
  if (latestText === baseText) return yoursText;

  const base = baseText.split("\n");
  const latest = changeFromBase(base, latestText.split("\n"));
  const yours = changeFromBase(base, yoursText.split("\n"));
  if (changesOverlap(latest, yours)) {
    const conflictStart = Math.min(latest.start, yours.start);
    const conflictEnd = Math.max(latest.end, yours.end);
    return [
      ...base.slice(0, conflictStart),
      "<<<<<<< Your changes",
      ...applyChangeToRange(base, yours, conflictStart, conflictEnd),
      "=======",
      ...applyChangeToRange(base, latest, conflictStart, conflictEnd),
      ">>>>>>> Latest version",
      ...base.slice(conflictEnd),
    ].join("\n");
  }

  const ordered = [latest, yours].toSorted((a, b) => a.start - b.start);
  const merged: string[] = [];
  let cursor = 0;
  for (const change of ordered) {
    merged.push(...base.slice(cursor, change.start), ...change.replacement);
    cursor = change.end;
  }
  merged.push(...base.slice(cursor));
  return merged.join("\n");
}

function summarizeChange(left: readonly string[], right: readonly string[]): DiffLine[] {
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix])
    prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const lines: DiffLine[] = [];
  appendMatchingContext(lines, left, right, 0, 0, prefix);
  const leftCount = left.length - prefix - suffix;
  const rightCount = right.length - prefix - suffix;
  const visibleLeft = Math.min(leftCount, MAX_CHANGED_LINES_PER_SIDE);
  const visibleRight = Math.min(rightCount, MAX_CHANGED_LINES_PER_SIDE);
  for (let offset = 0; offset < visibleLeft; offset += 1) {
    const index = prefix + offset;
    lines.push({ kind: "removed", leftText: left[index] ?? "", leftNumber: index + 1 });
  }
  for (let offset = 0; offset < visibleRight; offset += 1) {
    const index = prefix + offset;
    lines.push({ kind: "added", rightText: right[index] ?? "", rightNumber: index + 1 });
  }
  const omittedLeft = leftCount - visibleLeft;
  const omittedRight = rightCount - visibleRight;
  if (omittedLeft > 0 || omittedRight > 0) {
    lines.push({
      kind: "summary",
      leftStart: prefix + visibleLeft + 1,
      rightStart: prefix + visibleRight + 1,
      leftCount: omittedLeft,
      rightCount: omittedRight,
    });
  }
  appendMatchingContext(lines, left, right, left.length - suffix, right.length - suffix, suffix);
  return lines;
}

function appendMatchingContext(
  lines: DiffLine[],
  left: readonly string[],
  right: readonly string[],
  leftStart: number,
  rightStart: number,
  count: number,
): void {
  const shownPerEdge = Math.min(MAX_CONTEXT_LINES_PER_EDGE, Math.ceil(count / 2));
  const omitted = count - shownPerEdge * 2;
  for (let offset = 0; offset < shownPerEdge; offset += 1) {
    lines.push({
      kind: "context",
      leftText: left[leftStart + offset] ?? "",
      rightText: right[rightStart + offset] ?? "",
      leftNumber: leftStart + offset + 1,
      rightNumber: rightStart + offset + 1,
    });
  }
  if (omitted > 0) lines.push({ kind: "omitted-context", count: omitted });
  for (let offset = count - shownPerEdge; offset < count; offset += 1) {
    if (offset < shownPerEdge) continue;
    lines.push({
      kind: "context",
      leftText: left[leftStart + offset] ?? "",
      rightText: right[rightStart + offset] ?? "",
      leftNumber: leftStart + offset + 1,
      rightNumber: rightStart + offset + 1,
    });
  }
}
