import type { ReactNode } from "react";
import { cx } from "@/lib/cx.ts";

export type Tone = "neutral" | "info" | "ok" | "warn" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "border-line-strong bg-subtle text-ink",
  info: "border-info bg-info-soft text-info",
  ok: "border-ok bg-ok-soft text-ok",
  warn: "border-warn bg-warn-soft text-warn",
  danger: "border-danger bg-danger-soft text-danger",
};

/** Small status label. Colour never carries meaning alone: always put the meaning in the text. */
export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
