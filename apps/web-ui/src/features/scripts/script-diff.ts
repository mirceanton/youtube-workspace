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
    };

export interface ScriptDiff {
  lines: DiffLine[];
  /** True when a very large diff is represented as one changed block to keep the phone responsive. */
  summarized: boolean;
}

const MAX_LCS_CELLS = 400_000;

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
  const overlaps =
    Math.max(latest.start, yours.start) < Math.min(latest.end, yours.end) ||
    (latest.start === latest.end && yours.start === yours.end && latest.start === yours.start) ||
    (latest.start === yours.start && (latest.start === latest.end || yours.start === yours.end));

  if (overlaps) {
    return [
      ...base.slice(0, Math.min(latest.start, yours.start)),
      "<<<<<<< Your changes",
      ...yours.replacement,
      "=======",
      ...latest.replacement,
      ">>>>>>> Latest version",
      ...base.slice(Math.max(latest.end, yours.end)),
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
  for (let index = 0; index < prefix; index += 1) {
    const text = left[index] ?? "";
    lines.push({
      kind: "context",
      leftText: text,
      rightText: right[index] ?? "",
      leftNumber: index + 1,
      rightNumber: index + 1,
    });
  }
  const leftCount = left.length - prefix - suffix;
  const rightCount = right.length - prefix - suffix;
  if (leftCount > 0 || rightCount > 0) {
    lines.push({
      kind: "summary",
      leftStart: prefix + 1,
      rightStart: prefix + 1,
      leftCount,
      rightCount,
    });
  }
  for (let offset = suffix; offset > 0; offset -= 1) {
    const leftIndex = left.length - offset;
    const rightIndex = right.length - offset;
    lines.push({
      kind: "context",
      leftText: left[leftIndex] ?? "",
      rightText: right[rightIndex] ?? "",
      leftNumber: leftIndex + 1,
      rightNumber: rightIndex + 1,
    });
  }
  return lines;
}
