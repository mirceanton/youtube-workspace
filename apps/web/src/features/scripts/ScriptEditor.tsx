import { useState } from "react";
import { TextAreaField } from "@/kit/Field.tsx";
import { MarkdownView } from "@/kit/MarkdownView.tsx";
import { Button } from "@/kit/Button.tsx";
import { cx } from "@/lib/cx.ts";

export function ScriptEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [mobileView, setMobileView] = useState<"edit" | "preview">("edit");
  return (
    <section aria-label="Script editor" className="min-w-0">
      <div className="mb-2 flex gap-2 md:hidden">
        <Button
          aria-pressed={mobileView === "edit"}
          variant={mobileView === "edit" ? "primary" : "secondary"}
          onClick={() => setMobileView("edit")}
        >
          Edit
        </Button>
        <Button
          aria-pressed={mobileView === "preview"}
          variant={mobileView === "preview" ? "primary" : "secondary"}
          onClick={() => setMobileView("preview")}
        >
          Preview
        </Button>
      </div>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <div className={cx(mobileView === "preview" && "hidden md:block")}>
          <TextAreaField
            label="Markdown source"
            hint="Saving appends a new draft revision."
            value={value}
            onChange={(event) => onChange(event.target.value)}
            rows={24}
            inputClassName="min-h-96 font-mono text-sm leading-relaxed"
            spellCheck={false}
          />
        </div>
        <section
          aria-label="Markdown preview"
          className={cx(
            "min-w-0 rounded-lg border border-line bg-surface p-4 md:block",
            mobileView === "edit" && "hidden md:block",
          )}
        >
          <h3 className="mb-3 text-sm font-semibold text-ink-muted">Preview</h3>
          {value.trim() ? (
            <MarkdownView markdown={value} />
          ) : (
            <p className="text-sm text-ink-muted">Markdown preview appears here.</p>
          )}
        </section>
      </div>
    </section>
  );
}
