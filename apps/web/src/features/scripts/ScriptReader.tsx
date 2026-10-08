import { Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { MarkdownView } from "@/kit/MarkdownView.tsx";
import { Button } from "@/kit/Button.tsx";
import { cx } from "@/lib/cx.ts";

const FONT_KEY = "ytw.script-reader-font-size";
const DEFAULT_FONT_SIZE = 18;
const MIN_FONT_SIZE = 14;
const MAX_FONT_SIZE = 24;

function readFontSize(): number {
  try {
    const value = Number(window.localStorage.getItem(FONT_KEY));
    return Number.isInteger(value) && value >= MIN_FONT_SIZE && value <= MAX_FONT_SIZE
      ? value
      : DEFAULT_FONT_SIZE;
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

/** Phone-friendly reading column with a locally remembered, adjustable type size. */
export function ScriptReader({ markdown, className }: { markdown: string; className?: string }) {
  const [fontSize, setFontSize] = useState(readFontSize);

  useEffect(() => {
    try {
      window.localStorage.setItem(FONT_KEY, String(fontSize));
    } catch {
      // Storage can be disabled; the control still works for the current page.
    }
  }, [fontSize]);

  return (
    <section className={cx("min-w-0 pb-[calc(env(safe-area-inset-bottom)+1rem)]", className)}>
      <div className="mb-3 flex items-center justify-end gap-2" aria-label="Reader text size">
        <span className="me-1 text-sm text-ink-muted">Text size</span>
        <Button
          aria-label="Decrease text size"
          size="icon"
          disabled={fontSize <= MIN_FONT_SIZE}
          onClick={() => setFontSize((size) => Math.max(MIN_FONT_SIZE, size - 1))}
        >
          <Minus aria-hidden="true" className="size-4" />
        </Button>
        <output aria-live="polite" className="min-w-10 text-center text-sm tabular-nums">
          {fontSize}px
        </output>
        <Button
          aria-label="Increase text size"
          size="icon"
          disabled={fontSize >= MAX_FONT_SIZE}
          onClick={() => setFontSize((size) => Math.min(MAX_FONT_SIZE, size + 1))}
        >
          <Plus aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <article
        aria-label="Script reader"
        className="mx-auto w-full max-w-[68ch] rounded-xl border border-line bg-surface px-4 py-5 sm:px-7 sm:py-7"
        style={{ fontSize: `${fontSize}px` }}
      >
        <MarkdownView markdown={markdown} className="leading-relaxed" />
      </article>
    </section>
  );
}
