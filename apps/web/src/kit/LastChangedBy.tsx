import type { ActorType } from "@ytw/shared/constants";
import { cx } from "@/lib/cx.ts";
import { formatDateTime, formatRelativeTime, toDate } from "@/lib/format.ts";
import { Badge } from "./Badge.tsx";

export interface LastChangedByProps {
  /** Who made the change: a username, or an API token's name for agents. */
  actor: string;
  actorType?: ActorType;
  /** When: ISO string, epoch milliseconds or Date. */
  at: string | number | Date;
  /** Replaces "Last changed by", e.g. "Created by" or "Noted by". */
  label?: string;
  className?: string;
}

/**
 * "Last changed by <actor> <when>" (every mutating screen shows who last changed the item).
 * Agents get an "Agent" badge so human and agent changes are told apart in text, not colour.
 */
export function LastChangedBy({
  actor,
  actorType,
  at,
  label = "Last changed by",
  className,
}: LastChangedByProps) {
  const date = toDate(at);
  return (
    <p
      className={cx(
        "flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-ink-muted",
        className,
      )}
    >
      <span>{label}</span>
      <strong className="font-semibold text-ink">{actor}</strong>
      {actorType === "agent" ? <Badge tone="info">Agent</Badge> : null}
      {date ? (
        <time dateTime={date.toISOString()} title={formatDateTime(date)}>
          {formatRelativeTime(date)}
        </time>
      ) : (
        <span>at an unknown time</span>
      )}
    </p>
  );
}
