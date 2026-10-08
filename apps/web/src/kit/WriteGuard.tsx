import { useId, type ReactNode } from "react";
import type { Resource } from "@ytw/shared/constants";
import { cx } from "@/lib/cx.ts";
import { useWriteGuard } from "./useWriteGuard.ts";

export interface WriteGuardProps {
  /** The object the wrapped controls write to. */
  resource: Resource;
  children: ReactNode;
  /**
   * What to do when the user lacks Write: `"disable"` (default) shows the controls disabled with an
   * explanation, `"hide"` renders nothing. Offline always disables with an explanation, because the
   * controls come back when the connection does.
   */
  whenReadOnly?: "disable" | "hide";
  /** Show the explanation under the controls (default true). */
  explain?: boolean;
  /** Classes of the wrapper, e.g. `flex gap-2` or `contents`. */
  className?: string;
}

/**
 * Wraps write controls (buttons, inputs, forms). When the user lacks Write on `resource`, or the
 * browser is offline (nothing is queued offline), every form control inside is disabled and
 * the reason is stated in text. Hiding or disabling UI is cosmetic: the server checks every
 * mutation again.
 *
 * The wrapper is a `<fieldset disabled>`: the browser disables all descendant controls (not links),
 * and children keep their state when the state flips, so a half-typed note survives a dropped
 * connection.
 */
export function WriteGuard({
  resource,
  children,
  whenReadOnly = "disable",
  explain = true,
  className,
}: WriteGuardProps) {
  const { allowed, reason, message } = useWriteGuard(resource);
  const explanationId = useId();
  if (!allowed && reason === "no-access" && whenReadOnly === "hide") return null;
  return (
    <fieldset
      disabled={!allowed}
      aria-describedby={!allowed && explain ? explanationId : undefined}
      className={cx("m-0 min-w-0 border-0 p-0", className)}
    >
      {children}
      {!allowed && explain && message ? (
        <p id={explanationId} className="mt-2 w-full text-sm text-ink-muted">
          {message}
        </p>
      ) : null}
    </fieldset>
  );
}
