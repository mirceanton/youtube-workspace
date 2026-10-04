import { diffScriptLines } from "./script-diff.ts";
import { cx } from "@/lib/cx.ts";

const ROW_TONE = {
  context: "bg-surface",
  removed: "bg-danger-soft text-danger",
  added: "bg-ok-soft text-ok",
  summary: "bg-subtle text-ink-muted",
} as const;

export function ScriptDiff({
  before,
  after,
  beforeLabel,
  afterLabel,
}: {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
}) {
  const diff = diffScriptLines(before, after);
  const addedCount = diff.lines.reduce(
    (count, line) =>
      count + (line.kind === "added" ? 1 : line.kind === "summary" ? line.rightCount : 0),
    0,
  );
  const removedCount = diff.lines.reduce(
    (count, line) =>
      count + (line.kind === "removed" ? 1 : line.kind === "summary" ? line.leftCount : 0),
    0,
  );
  return (
    <section aria-label="Script version diff" className="min-w-0">
      {diff.summarized ? (
        <p className="mb-2 text-sm text-ink-muted">
          This large change is grouped into one changed block so the comparison stays responsive.
        </p>
      ) : null}
      <div className="hidden overflow-hidden rounded-lg border border-line md:grid md:grid-cols-2">
        {[
          { label: beforeLabel, side: "left" },
          { label: afterLabel, side: "right" },
        ].map(({ label, side }) => (
          <div key={side} className={side === "right" ? "border-s border-line" : ""}>
            <h3 className="border-b border-line bg-subtle px-3 py-2 text-sm font-semibold">
              {label}
            </h3>
            <ol aria-label={`${label} lines`} className="overflow-x-auto py-1 font-mono text-sm">
              {diff.lines.map((line, index) => {
                const kind = line.kind;
                const content =
                  line.kind === "summary"
                    ? `${line.leftCount} removed · ${line.rightCount} added lines`
                    : side === "left"
                      ? line.kind === "added"
                        ? ""
                        : line.leftText
                      : line.kind === "removed"
                        ? ""
                        : line.rightText;
                const number =
                  line.kind === "summary"
                    ? "…"
                    : side === "left"
                      ? line.kind === "added"
                        ? ""
                        : line.leftNumber
                      : line.kind === "removed"
                        ? ""
                        : line.rightNumber;
                return (
                  <li
                    key={`${kind}-${index}`}
                    className={cx("grid min-h-6 grid-cols-[3rem_minmax(0,1fr)]", ROW_TONE[kind])}
                  >
                    <span aria-hidden="true" className="select-none px-2 text-end opacity-60">
                      {number}
                    </span>
                    <code className="whitespace-pre-wrap break-words pe-3">{content || " "}</code>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-line md:hidden">
        <h3 className="border-b border-line bg-subtle px-3 py-2 text-sm font-semibold">
          {beforeLabel} → {afterLabel}
        </h3>
        <ol aria-label="Unified script diff" className="overflow-x-auto py-1 font-mono text-sm">
          {diff.lines.map((line, index) => {
            const marker =
              line.kind === "removed"
                ? "−"
                : line.kind === "added"
                  ? "+"
                  : line.kind === "summary"
                    ? "…"
                    : " ";
            const number =
              line.kind === "summary"
                ? `${line.leftStart}/${line.rightStart}`
                : line.kind === "added"
                  ? line.rightNumber
                  : line.kind === "removed"
                    ? line.leftNumber
                    : line.rightNumber;
            const content =
              line.kind === "summary"
                ? `${line.leftCount} lines removed, ${line.rightCount} lines added`
                : line.kind === "added"
                  ? line.rightText
                  : line.kind === "removed"
                    ? line.leftText
                    : line.rightText;
            return (
              <li
                key={`${line.kind}-${index}`}
                className={cx(
                  "grid min-h-6 grid-cols-[2.75rem_1rem_minmax(0,1fr)]",
                  ROW_TONE[line.kind],
                )}
              >
                <span aria-hidden="true" className="select-none px-1 text-end opacity-60">
                  {number}
                </span>
                <span aria-hidden="true" className="select-none text-center">
                  {marker}
                </span>
                <code className="whitespace-pre-wrap break-words pe-3">{content || " "}</code>
              </li>
            );
          })}
        </ol>
      </div>
      <span className="sr-only" aria-live="polite">
        {addedCount} added lines, {removedCount} removed lines.
      </span>
    </section>
  );
}
