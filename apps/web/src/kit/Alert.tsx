import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx.ts";
import type { Tone } from "./Badge.tsx";

const STYLES: Record<Exclude<Tone, "neutral">, string> = {
  info: "border-info bg-info-soft text-info",
  ok: "border-ok bg-ok-soft text-ok",
  warn: "border-warn bg-warn-soft text-warn",
  danger: "border-danger bg-danger-soft text-danger",
};

const ICONS = { info: Info, ok: CheckCircle2, warn: AlertTriangle, danger: XCircle } as const;

/**
 * Inline message. `danger` and `warn` are announced immediately (`role="alert"`), `info` and `ok`
 * politely (`role="status"`). The icon and the title carry the meaning next to the colour.
 */
export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: Exclude<Tone, "neutral">;
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  const Icon = ICONS[tone];
  return (
    <div
      role={tone === "danger" || tone === "warn" ? "alert" : "status"}
      className={cx("flex gap-3 rounded-lg border p-3 text-sm", STYLES[tone], className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cx(title && "mt-0.5", "text-ink")}>{children}</div> : null}
      </div>
    </div>
  );
}
