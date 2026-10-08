import { cx } from "@/lib/cx.ts";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "md" | "icon";

const BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border text-base font-medium " +
  "select-none transition-colors disabled:cursor-not-allowed disabled:opacity-60";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-brand text-brand-ink hover:opacity-90",
  secondary: "border-line-strong bg-surface text-ink hover:bg-subtle",
  danger: "border-danger bg-surface text-danger hover:bg-danger-soft",
  ghost: "border-transparent bg-transparent text-ink hover:bg-subtle",
};

const SIZES: Record<ButtonSize, string> = {
  md: "px-4 py-2",
  icon: "min-w-11 p-2",
};

/**
 * Class names of a button, for things that are not a `<button>` (a router `<Link>` that looks like
 * one). Every size is at least 44 px tall and wide (PRD 8).
 */
export function buttonClasses(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cx(BASE, VARIANTS[variant], SIZES[size], className);
}
