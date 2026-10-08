/**
 * Typed wrappers for video metric snapshots: `log_metrics`, and `listMetricSnapshots` to read
 * them back.
 *
 * A snapshot is append-only and unique per (video, `capturedAt`). {@link logMetrics} is idempotent on
 * that key: repeating a call returns the stored snapshot with `created: false`, and different numbers
 * for an existing key fail with a {@link DuplicateError} whose message shows both sets.
 *
 * Numbers: counts and measurements are exact in the database (`bigint`, `numeric`) and come back as
 * strings, because a JavaScript number cannot hold them all. Pass numbers, or strings for exact
 * values; `subsGained` is a plain number.
 */
import { requireUuid } from "./args.js";
import type { ActorTx, Queryable } from "./client.js";
import { ValidationError } from "./errors.js";
import { decimalJson, instantText, type DecimalInput } from "./value-args.js";

/**
 * One point of an audience retention curve: `t` seconds from the start of the video, `pct` percent
 * of the viewers still watching (above 100 when viewers rewatch).
 */
export interface RetentionPoint {
  t: number;
  pct: number;
}

/**
 * The numbers of a snapshot; give at least one. `null` and omitted both mean "not measured".
 * `retention` is 1 to 1000 points sorted by increasing `t`, at most 64 KiB of JSON.
 */
export interface MetricValues {
  views?: DecimalInput | null;
  impressions?: DecimalInput | null;
  /** Impressions click-through rate in percent, 0 to 100 (4.5 means 4.5 %). */
  ctr?: DecimalInput | null;
  avgViewDurationS?: DecimalInput | null;
  /** Average percentage viewed; above 100 happens when viewers rewatch. */
  avgViewPct?: DecimalInput | null;
  watchTimeMin?: DecimalInput | null;
  /** Net subscribers gained; negative when more were lost. */
  subsGained?: DecimalInput | null;
  retention?: readonly RetentionPoint[] | null;
}

/** A stored snapshot (`video_metrics`). */
export interface MetricSnapshot {
  id: string;
  videoId: string;
  /** When the numbers were read. */
  capturedAt: Date;
  views: string | null;
  impressions: string | null;
  ctr: string | null;
  avgViewDurationS: string | null;
  avgViewPct: string | null;
  watchTimeMin: string | null;
  subsGained: number | null;
  retention: RetentionPoint[] | null;
  createdAt: Date;
  /** Who logged it (a username or an API token name). */
  createdBy: string;
}

/** Column list of a snapshot, aliased to {@link MetricSnapshot}; `from` qualifies the columns. */
function metricColumns(from: string): string {
  return [
    `${from}id AS id`,
    `${from}video_id AS "videoId"`,
    `${from}captured_at AS "capturedAt"`,
    `${from}views::text AS views`,
    `${from}impressions::text AS impressions`,
    `${from}ctr::text AS ctr`,
    `${from}avg_view_duration_s::text AS "avgViewDurationS"`,
    `${from}avg_view_pct::text AS "avgViewPct"`,
    `${from}watch_time_min::text AS "watchTimeMin"`,
    `${from}subs_gained AS "subsGained"`,
    `${from}retention AS retention`,
    `${from}created_at AS "createdAt"`,
    `${from}created_by AS "createdBy"`,
  ].join(", ");
}

/** Metric names as the database function knows them. */
const METRIC_NAMES = {
  views: "views",
  impressions: "impressions",
  ctr: "ctr",
  avgViewDurationS: "avg_view_duration_s",
  avgViewPct: "avg_view_pct",
  watchTimeMin: "watch_time_min",
  subsGained: "subs_gained",
  retention: "retention",
} as const;

export interface LogMetricsInput {
  videoId: string;
  /**
   * When the numbers were read: a Date, or a string with a time zone
   * (`2026-10-01T12:00:00Z`). Not before 2005, not more than a day ahead.
   */
  capturedAt: Date | string;
  metrics: MetricValues;
}

export interface LogMetricsResult {
  snapshot: MetricSnapshot;
  /**
   * true when this call appended the snapshot; false when the key already held exactly these
   * numbers (a repeated call) and the stored snapshot is returned unchanged.
   */
  created: boolean;
}

/**
 * Appends a snapshot of a video's numbers (`log_metrics`). Idempotent on (`videoId`, `capturedAt`):
 * the same numbers again return the stored snapshot with `created: false` and write no audit row;
 * other numbers for that key fail with {@link DuplicateError} (`existingId`), because a snapshot
 * never changes: log corrected numbers with another `capturedAt`. An archived video accepts no new
 * snapshots ({@link InvalidTransitionError}, reason `archived`).
 */
export async function logMetrics(tx: ActorTx, input: LogMetricsInput): Promise<LogMetricsResult> {
  requireUuid("video_id", input.videoId);
  const capturedAt = instantText("captured_at", input.capturedAt);
  const metrics: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.metrics)) {
    if (value === undefined) {
      continue;
    }
    const name: string = Object.hasOwn(METRIC_NAMES, key)
      ? METRIC_NAMES[key as keyof typeof METRIC_NAMES]
      : key;
    metrics[name] = value === null ? null : metricJson(name, value);
  }
  const { rows } = await tx.query<MetricSnapshot & { created: boolean }>(
    `SELECT ${metricColumns("(l.snapshot).")}, l.created
       FROM public.log_metrics($1::text, $2::text, $3::uuid, $4::uuid, $5::timestamptz, $6::jsonb) AS l`,
    [
      tx.actor.name,
      tx.actor.type,
      tx.actor.tokenId,
      input.videoId,
      capturedAt,
      JSON.stringify(metrics),
    ],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("log_metrics returned no row");
  }
  const { created, ...snapshot } = row;
  return { snapshot, created };
}

export interface ListMetricSnapshotsInput {
  videoId: string;
  /** At most this many, newest first. Default 100, at most 1000. */
  limit?: number;
}

/** The snapshots of a video, newest `capturedAt` first. Needs only SELECT on `video_metrics`. */
export async function listMetricSnapshots(
  db: Queryable,
  input: ListMetricSnapshotsInput,
): Promise<MetricSnapshot[]> {
  requireUuid("video_id", input.videoId);
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ValidationError(
      `limit must be a whole number from 1 to 1000 (got ${String(limit)})`,
      {
        field: "limit",
      },
    );
  }
  const { rows } = await db.query<MetricSnapshot>(
    `SELECT ${metricColumns("")}
       FROM public.video_metrics
      WHERE video_id = $1::uuid
      ORDER BY captured_at DESC, id DESC
      LIMIT $2::integer`,
    [input.videoId, limit],
  );
  return rows;
}

/** One metric value as JSON: a retention curve with finite numbers, or a number / decimal string. */
function metricJson(name: string, value: unknown): unknown {
  if (name !== "retention") {
    return decimalJson(`metrics.${name}`, value as DecimalInput);
  }
  if (!Array.isArray(value)) {
    return value;
  }
  value.forEach((point: unknown, index) => {
    const { t, pct } = (point ?? {}) as Record<string, unknown>;
    if (
      (typeof t === "number" && !Number.isFinite(t)) ||
      (typeof pct === "number" && !Number.isFinite(pct))
    ) {
      throw new ValidationError(
        `metrics.retention point ${index + 1} has a number that is not finite: t and pct must be finite numbers`,
        { field: "metrics.retention", position: index + 1 },
      );
    }
  });
  return value;
}
