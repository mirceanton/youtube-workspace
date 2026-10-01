import type { HTMLAttributes } from "react";
import { cx } from "@/lib/cx.ts";

/** A bordered surface for grouping content. Add padding with `className` (default `p-4`). */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("rounded-xl border border-line bg-surface p-4", className)} {...rest} />
  );
}
