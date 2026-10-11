const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** Parses an ISO string, epoch milliseconds or a Date; returns null when it is not a valid time. */
export function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "5 minutes ago", "yesterday", "in 2 hours"; "just now" under a minute. */
export function formatRelativeTime(value: string | number | Date, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return "unknown time";
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return "just now";
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (abs >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** "1 Oct 2026, 14:05" in the viewer's locale and time zone. */
export function formatDateTime(value: string | number | Date): string {
  const date = toDate(value);
  if (!date) return "unknown time";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

/** "1 Oct 2026". */
export function formatDate(value: string | number | Date): string {
  const date = toDate(value);
  if (!date) return "unknown date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

/** 1234 -> "1.2K", 1_500_000 -> "1.5M"; small numbers keep up to two decimals. */
export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(
    value,
  );
}

/** Full number with thousands separators, for tables and tooltips. */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 4 }).format(value);
}

/** 42 -> "42s", 222 -> "3m 42s", 3725 -> "1h 02m"; rounds to the whole second first. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** 4.5234 -> "4.52%", 5 -> "5%": a percentage that is already 0 to 100, at most two decimals. */
export function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value)}%`;
}
