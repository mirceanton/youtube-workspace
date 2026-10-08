import type { VideoPerformance } from "@ytw/shared/api/videos";

export type MetricField =
  | "views"
  | "impressions"
  | "ctr"
  | "avg_view_duration_s"
  | "avg_view_pct"
  | "watch_time_min"
  | "subs_gained";
export type SortField = "title" | "published_at" | MetricField;
export type SortOrder = "asc" | "desc";

export const metricFields = [
  { field: "views", label: "Views" },
  { field: "impressions", label: "Impressions" },
  { field: "ctr", label: "CTR" },
  { field: "avg_view_duration_s", label: "Avg. view duration" },
  { field: "avg_view_pct", label: "Avg. viewed" },
  { field: "watch_time_min", label: "Watch time" },
  { field: "subs_gained", label: "Subscribers gained" },
] as const satisfies readonly { field: MetricField; label: string }[];

const integerFields = new Set<MetricField>(["views", "impressions", "subs_gained"]);

function integer(value: string): bigint | null {
  return /^-?\d+$/.test(value) ? BigInt(value) : null;
}

function decimal(value: string): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function latestValue(video: VideoPerformance, field: MetricField): string | null {
  const value = video.latest?.[field];
  return value === null || value === undefined ? null : String(value);
}

function compareValues(left: string, right: string, field: MetricField): number {
  if (integerFields.has(field)) {
    const leftInteger = integer(left);
    const rightInteger = integer(right);
    if (leftInteger !== null && rightInteger !== null) {
      return leftInteger === rightInteger ? 0 : leftInteger < rightInteger ? -1 : 1;
    }
  }
  const a = decimal(left);
  const b = decimal(right);
  if (a !== null && b !== null) return a - b;
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

/** Sorting helpers are pure so the full 1,000-row view remains responsive and easy to exercise. */
export function sortVideos(
  videos: readonly VideoPerformance[],
  field: SortField,
  order: SortOrder,
): VideoPerformance[] {
  const sign = order === "asc" ? 1 : -1;
  return videos.toSorted((left, right) => {
    const leftValue =
      field === "title"
        ? left.title
        : field === "published_at"
          ? left.published_at
          : latestValue(left, field);
    const rightValue =
      field === "title"
        ? right.title
        : field === "published_at"
          ? right.published_at
          : latestValue(right, field);
    if (field === "title")
      return sign * left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    if (field === "published_at") {
      if (left.published_at === null && right.published_at === null) return 0;
      if (left.published_at === null) return 1;
      if (right.published_at === null) return -1;
      return sign * (Date.parse(left.published_at) - Date.parse(right.published_at));
    }
    if (leftValue === null && rightValue === null) return 0;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return sign * compareValues(leftValue, rightValue, field);
  });
}
