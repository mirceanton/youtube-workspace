import { AlertTriangle, Inbox, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx.ts";
import { describeError, ForbiddenError, NetworkError } from "@/lib/errors.ts";
import { Button } from "./Button.tsx";
import { Spinner } from "./Spinner.tsx";
import type { IconComponent } from "./types.ts";

// The three states every screen needs: empty, loading, error. Use them for whole screens
// and for sections; `compact` is the in-card variant.

interface Frame {
  compact?: boolean;
  className?: string;
}

const FRAME = "flex flex-col items-center justify-center gap-2 text-center";

export interface EmptyStateProps extends Frame {
  title: string;
  description?: ReactNode;
  icon?: IconComponent;
  /** A call to action, e.g. a `<Button>` to create the first item. */
  action?: ReactNode;
}

/** Nothing here yet. Say what this place is for and, when the user may, how to add the first item. */
export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  compact,
  className,
}: EmptyStateProps) {
  return (
    <section
      aria-label={title}
      className={cx(FRAME, compact ? "px-4 py-6" : "px-4 py-16", className)}
    >
      <Icon aria-hidden="true" className="size-8 text-ink-muted" />
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? <p className="max-w-md text-ink-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </section>
  );
}

export interface LoadingStateProps extends Frame {
  /** Announced to screen readers; defaults to "Loading". */
  label?: string;
  /** Show placeholder lines instead of a spinner, for lists and detail bodies. */
  lines?: number;
}

/** Content is on its way. Announced politely; no layout jump when `lines` mirrors the content. */
export function LoadingState({ label = "Loading", lines, compact, className }: LoadingStateProps) {
  return (
    <output
      aria-live="polite"
      className={cx(
        lines ? "flex flex-col gap-3" : FRAME,
        compact ? "px-4 py-6" : "px-4 py-16",
        className,
      )}
    >
      {lines ? (
        Array.from({ length: lines }, (_, index) => (
          <span
            key={index}
            aria-hidden="true"
            className="block h-4 animate-pulse rounded bg-subtle motion-reduce:animate-none"
            style={{ width: `${100 - ((index * 17) % 40)}%` }}
          />
        ))
      ) : (
        <Spinner className="size-6 text-ink-muted" />
      )}
      <span className={lines ? "sr-only" : "text-ink-muted"}>{label}</span>
    </output>
  );
}

export interface ErrorStateProps extends Frame {
  /** The thrown error; its message is shown when it is an API or network error. */
  error?: unknown;
  title?: string;
  /** Overrides the message derived from `error`. */
  description?: ReactNode;
  /** Shows a "Try again" button. */
  onRetry?: () => void;
  retrying?: boolean;
}

/** Something failed. Says what, and offers a retry when the action is repeatable. */
export function ErrorState({
  error,
  title,
  description,
  onRetry,
  retrying,
  compact,
  className,
}: ErrorStateProps) {
  const offline = error instanceof NetworkError;
  const forbidden = error instanceof ForbiddenError;
  const Icon = offline ? WifiOff : AlertTriangle;
  const heading =
    title ??
    (offline ? "You seem to be offline" : forbidden ? "Not allowed" : "Something went wrong");
  return (
    <section
      role="alert"
      aria-label={heading}
      className={cx(FRAME, compact ? "px-4 py-6" : "px-4 py-16", className)}
    >
      <Icon aria-hidden="true" className="size-8 text-danger" />
      <h2 className="text-lg font-semibold">{heading}</h2>
      <p className="max-w-md text-ink-muted">{description ?? describeError(error)}</p>
      {onRetry ? (
        <Button className="mt-2" onClick={onRetry} busy={retrying}>
          Try again
        </Button>
      ) : null}
    </section>
  );
}
