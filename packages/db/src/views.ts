/**
 * Typed readers for the views of migrations 0060-0062: the idea pipeline (`ideas_pipeline`,
 * `ideas_pipeline_all`), video performance against the channel median
 * (`video_performance_summary`) and experiment results (`experiment_results`). Owned by task T15
 * (docs/orchestration/PLAN.md section 3); definitions and edge cases: docs/database.md, "Views,
 * search and activity (T15)".
 *
 * Every function needs only SELECT on the views (all three application roles have it), so it takes
 * any {@link Queryable}. The views are `security_invoker`: they read the tables with the caller's own
 * privileges. The service decides which resources a token may read before it calls these.
 *
 * Numbers: counts and measurements are exact in the database (`bigint`, `numeric`) and come back as
 * strings; medians and differences are `numeric` too. `ctr` is a percentage from 0 to 100.
 */
import type {
  ExperimentStatus,
  ExperimentType,
  IdeaStage,
  ScriptStatus,
} from "@ytw/shared/constants";
import { EXPERIMENT_STATUSES, IDEA_STAGES } from "@ytw/shared/constants";
import { requireUuid } from "./args.js";
import type { Queryable } from "./client.js";
import { toDbError, ValidationError, formatAllowed } from "./errors.js";
import type { IdeaRecord } from "./ideas.js";

/** The default and the largest `limit` of the list functions of this module. */
export const VIEW_LIST_LIMIT_DEFAULT = 500;
export const VIEW_LIST_LIMIT_MAX = 1000;

function checkLimit(limit: number | undefined): number {
  const value = limit ?? VIEW_LIST_LIMIT_DEFAULT;
  if (!Number.isInteger(value) || value < 1 || value > VIEW_LIST_LIMIT_MAX) {
    throw new ValidationError(
      `limit must be a whole number from 1 to ${String(VIEW_LIST_LIMIT_MAX)} (got ${String(value)})`,
      { field: "limit", value: String(value) },
    );
  }
  return value;
}

function checkOneOf<T extends string>(field: string, values: readonly T[], allowed: readonly T[]) {
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new ValidationError(
        `${field} must be one of ${formatAllowed(allowed)} (got ${JSON.stringify(String(value).slice(0, 60))})`,
        { field, allowed: [...allowed] },
      );
    }
  }
}

async function select<R extends object>(
  db: Queryable,
  text: string,
  values: unknown[],
): Promise<R[]> {
  try {
    return (await db.query<R>(text, values)).rows;
  } catch (err) {
    throw toDbError(err);
  }
}

// ---------------------------------------------------------------------------------------------
// Idea pipeline

/** The latest revision of one script kind of an idea. */
export interface ScriptRevisionSummary {
  /** The revision's id (what `set_script_status` takes). */
  id: string;
  /** Its version number: the highest saved for this idea and kind. */
  version: number;
  /** Its review status. */
  status: ScriptStatus;
  /** When this revision was saved. */
  savedAt: Date;
}

/** One row of `ideas_pipeline`: an idea with its age in stage and its latest script revisions. */
export interface IdeaPipelineRecord extends IdeaRecord {
  /** How long the idea has been in its stage (since `statusChangedAt`), in seconds. */
  ageInStageSeconds: number;
  /** The same in whole days. */
  daysInStage: number;
  /** The latest `script` revision, or null when none was saved. */
  latestScript: ScriptRevisionSummary | null;
  /** The latest `packaging` revision, or null when none was saved. */
  latestPackaging: ScriptRevisionSummary | null;
}

export interface ListIdeaPipelineInput {
  /** Only ideas in these stages (default: every stage). */
  stages?: readonly IdeaStage[];
  /** Include archived ideas (default: they are left out). */
  includeArchived?: boolean;
  /** At most this many rows, 1 to 1000 (default 500). */
  limit?: number;
}

interface IdeaPipelineRow extends IdeaRecord {
  ageInStageSeconds: number;
  daysInStage: number;
  scriptId: string | null;
  scriptVersion: number | null;
  scriptStatus: ScriptStatus | null;
  scriptAt: Date | null;
  packagingId: string | null;
  packagingVersion: number | null;
  packagingStatus: ScriptStatus | null;
  packagingAt: Date | null;
}

function revision(
  id: string | null,
  version: number | null,
  status: ScriptStatus | null,
  savedAt: Date | null,
): ScriptRevisionSummary | null {
  return id === null || version === null || status === null || savedAt === null
    ? null
    : { id, version, status, savedAt };
}

/**
 * The ideas of the pipeline, most recently moved first. Archived ideas are left out unless
 * `includeArchived` is set (then they come from `ideas_pipeline_all`).
 */
export async function listIdeaPipeline(
  db: Queryable,
  input: ListIdeaPipelineInput = {},
): Promise<IdeaPipelineRecord[]> {
  const limit = checkLimit(input.limit);
  const stages = input.stages ?? [];
  checkOneOf("stages", stages, IDEA_STAGES);
  const rows = await select<IdeaPipelineRow>(
    db,
    `SELECT id, title, pitch, status, status_changed_at AS "statusChangedAt", score, source, tags,
            version, archived_at AS "archivedAt", created_at AS "createdAt",
            updated_at AS "updatedAt", created_by AS "createdBy", updated_by AS "updatedBy",
            extract(epoch FROM age_in_stage)::float8 AS "ageInStageSeconds",
            days_in_stage AS "daysInStage",
            latest_script_id AS "scriptId", latest_script_version AS "scriptVersion",
            latest_script_status AS "scriptStatus", latest_script_at AS "scriptAt",
            latest_packaging_id AS "packagingId", latest_packaging_version AS "packagingVersion",
            latest_packaging_status AS "packagingStatus", latest_packaging_at AS "packagingAt"
       FROM public.${input.includeArchived === true ? "ideas_pipeline_all" : "ideas_pipeline"}
      WHERE (cardinality($1::text[]) = 0 OR status = ANY ($1::text[]))
      ORDER BY status_changed_at DESC, id DESC
      LIMIT $2::integer`,
    [[...stages], limit],
  );
  return rows.map((row) => {
    const {
      scriptId,
      scriptVersion,
      scriptStatus,
      scriptAt,
      packagingId,
      packagingVersion,
      packagingStatus,
      packagingAt,
      ...idea
    } = row;
    return {
      ...idea,
      latestScript: revision(scriptId, scriptVersion, scriptStatus, scriptAt),
      latestPackaging: revision(packagingId, packagingVersion, packagingStatus, packagingAt),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Video performance

/** The latest metric snapshot of a video; a metric the snapshot did not measure is null. */
export interface LatestSnapshot {
  id: string;
  capturedAt: Date;
  views: string | null;
  impressions: string | null;
  /** Click-through rate in percent, 0 to 100. */
  ctr: string | null;
  avgViewDurationS: string | null;
  avgViewPct: string | null;
  watchTimeMin: string | null;
  /** Net subscribers gained (negative when more were lost). */
  subsGained: number | null;
}

/** One numeric value per metric: the channel medians, or the video's differences from them. */
export interface MetricNumbers {
  views: string | null;
  impressions: string | null;
  ctr: string | null;
  avgViewDurationS: string | null;
  avgViewPct: string | null;
  watchTimeMin: string | null;
  subsGained: string | null;
}

/** One row of `video_performance_summary`. */
export interface VideoPerformanceRecord {
  id: string;
  ideaId: string | null;
  youtubeId: string;
  title: string;
  publishedAt: Date | null;
  thumbnailUrl: string | null;
  /** The video's latest snapshot, or null when it has none. */
  latest: LatestSnapshot | null;
  /**
   * The channel median of each metric over the latest snapshots of all videos that are not archived
   * and measured it (the video itself included); null where nobody measured it.
   */
  median: MetricNumbers & {
    /** How many videos have a snapshot, i.e. how many the medians are computed over. */
    sampleSize: number;
  };
  /** The video's value minus the median, per metric; null when either is not measured. */
  vsMedian: MetricNumbers;
}

export interface ListVideoPerformanceInput {
  /** Only this video (the medians still cover the whole channel). */
  videoId?: string;
  /** At most this many rows, 1 to 1000 (default 500). */
  limit?: number;
}

interface VideoPerformanceRow {
  id: string;
  ideaId: string | null;
  youtubeId: string;
  title: string;
  publishedAt: Date | null;
  thumbnailUrl: string | null;
  snapshotId: string | null;
  capturedAt: Date | null;
  views: string | null;
  impressions: string | null;
  ctr: string | null;
  avgViewDurationS: string | null;
  avgViewPct: string | null;
  watchTimeMin: string | null;
  subsGained: number | null;
  sampleSize: number;
  medianViews: string | null;
  medianImpressions: string | null;
  medianCtr: string | null;
  medianAvgViewDurationS: string | null;
  medianAvgViewPct: string | null;
  medianWatchTimeMin: string | null;
  medianSubsGained: string | null;
  viewsVsMedian: string | null;
  impressionsVsMedian: string | null;
  ctrVsMedian: string | null;
  avgViewDurationSVsMedian: string | null;
  avgViewPctVsMedian: string | null;
  watchTimeMinVsMedian: string | null;
  subsGainedVsMedian: string | null;
}

/**
 * The videos that are not archived with their latest snapshot and their differences from the
 * channel median, most recently published first (videos without a publication time last).
 */
export async function listVideoPerformance(
  db: Queryable,
  input: ListVideoPerformanceInput = {},
): Promise<VideoPerformanceRecord[]> {
  const limit = checkLimit(input.limit);
  if (input.videoId !== undefined) {
    requireUuid("video_id", input.videoId);
  }
  const rows = await select<VideoPerformanceRow>(
    db,
    `SELECT id, idea_id AS "ideaId", youtube_id AS "youtubeId", title,
            published_at AS "publishedAt", thumbnail_url AS "thumbnailUrl",
            snapshot_id AS "snapshotId", captured_at AS "capturedAt",
            views::text AS views, impressions::text AS impressions, ctr::text AS ctr,
            avg_view_duration_s::text AS "avgViewDurationS", avg_view_pct::text AS "avgViewPct",
            watch_time_min::text AS "watchTimeMin", subs_gained AS "subsGained",
            median_sample_size AS "sampleSize",
            median_views::text AS "medianViews", median_impressions::text AS "medianImpressions",
            median_ctr::text AS "medianCtr",
            median_avg_view_duration_s::text AS "medianAvgViewDurationS",
            median_avg_view_pct::text AS "medianAvgViewPct",
            median_watch_time_min::text AS "medianWatchTimeMin",
            median_subs_gained::text AS "medianSubsGained",
            views_vs_median::text AS "viewsVsMedian",
            impressions_vs_median::text AS "impressionsVsMedian",
            ctr_vs_median::text AS "ctrVsMedian",
            avg_view_duration_s_vs_median::text AS "avgViewDurationSVsMedian",
            avg_view_pct_vs_median::text AS "avgViewPctVsMedian",
            watch_time_min_vs_median::text AS "watchTimeMinVsMedian",
            subs_gained_vs_median::text AS "subsGainedVsMedian"
       FROM public.video_performance_summary
      WHERE ($1::uuid IS NULL OR id = $1::uuid)
      ORDER BY published_at DESC NULLS LAST, id DESC
      LIMIT $2::integer`,
    [input.videoId ?? null, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    ideaId: row.ideaId,
    youtubeId: row.youtubeId,
    title: row.title,
    publishedAt: row.publishedAt,
    thumbnailUrl: row.thumbnailUrl,
    latest:
      row.snapshotId === null || row.capturedAt === null
        ? null
        : {
            id: row.snapshotId,
            capturedAt: row.capturedAt,
            views: row.views,
            impressions: row.impressions,
            ctr: row.ctr,
            avgViewDurationS: row.avgViewDurationS,
            avgViewPct: row.avgViewPct,
            watchTimeMin: row.watchTimeMin,
            subsGained: row.subsGained,
          },
    median: {
      sampleSize: row.sampleSize,
      views: row.medianViews,
      impressions: row.medianImpressions,
      ctr: row.medianCtr,
      avgViewDurationS: row.medianAvgViewDurationS,
      avgViewPct: row.medianAvgViewPct,
      watchTimeMin: row.medianWatchTimeMin,
      subsGained: row.medianSubsGained,
    },
    vsMedian: {
      views: row.viewsVsMedian,
      impressions: row.impressionsVsMedian,
      ctr: row.ctrVsMedian,
      avgViewDurationS: row.avgViewDurationSVsMedian,
      avgViewPct: row.avgViewPctVsMedian,
      watchTimeMin: row.watchTimeMinVsMedian,
      subsGained: row.subsGainedVsMedian,
    },
  }));
}

// ---------------------------------------------------------------------------------------------
// Experiment results

/** One variant of an experiment with its result next to the control's. */
export interface VariantResult {
  variantId: string;
  label: string;
  /** The title or description text, or the thumbnail's URL or path. */
  content: string;
  isControl: boolean;
  impressions: string | null;
  /** Click-through rate in percent, 0 to 100; null until recorded. */
  ctr: string | null;
  /** The variant's ctr minus the control's, in percentage points (0 for the control). */
  ctrVsControl: string | null;
  /** That difference as a percentage of the control's ctr; null when it is not defined. */
  ctrLiftPct: string | null;
  /** True for the variant named by `conclude_experiment`. */
  isWinner: boolean;
}

/** One experiment of `experiment_results` with its variants side by side. */
export interface ExperimentResultRecord {
  experimentId: string;
  videoId: string;
  videoTitle: string;
  type: ExperimentType;
  status: ExperimentStatus;
  hypothesis: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  conclusion: string | null;
  /** The winner of a concluded experiment; null while open or when no variant won. */
  winnerVariantId: string | null;
  createdAt: Date;
  /** The control variant, or null for an experiment that has none (not possible through the functions). */
  controlVariantId: string | null;
  /** The control first, then the others by label. */
  variants: VariantResult[];
}

export interface ListExperimentResultsInput {
  experimentId?: string;
  videoId?: string;
  /** Only experiments in these statuses (default: every status). */
  statuses?: readonly ExperimentStatus[];
  /** At most this many experiments, 1 to 1000 (default 500). */
  limit?: number;
}

interface ExperimentResultRow {
  experimentId: string;
  videoId: string;
  videoTitle: string;
  type: ExperimentType;
  status: ExperimentStatus;
  hypothesis: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  conclusion: string | null;
  winnerVariantId: string | null;
  createdAt: Date;
  controlVariantId: string | null;
  variantId: string;
  label: string;
  content: string;
  isControl: boolean;
  impressions: string | null;
  ctr: string | null;
  ctrVsControl: string | null;
  ctrLiftPct: string | null;
  isWinner: boolean;
}

/** The experiments, newest first, each with its variants (control first, then by label). */
export async function listExperimentResults(
  db: Queryable,
  input: ListExperimentResultsInput = {},
): Promise<ExperimentResultRecord[]> {
  const limit = checkLimit(input.limit);
  if (input.experimentId !== undefined) {
    requireUuid("experiment_id", input.experimentId);
  }
  if (input.videoId !== undefined) {
    requireUuid("video_id", input.videoId);
  }
  const statuses = input.statuses ?? [];
  checkOneOf("statuses", statuses, EXPERIMENT_STATUSES);
  const rows = await select<ExperimentResultRow>(
    db,
    `WITH picked AS (
       SELECT e.id FROM public.experiments e
        WHERE ($1::uuid IS NULL OR e.id = $1::uuid)
          AND ($2::uuid IS NULL OR e.video_id = $2::uuid)
          AND (cardinality($3::text[]) = 0 OR e.status = ANY ($3::text[]))
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $4::integer
     )
     SELECT r.experiment_id AS "experimentId", r.video_id AS "videoId",
            r.video_title AS "videoTitle", r.type, r.status, r.hypothesis,
            r.starts_at AS "startsAt", r.ends_at AS "endsAt", r.conclusion,
            r.winner_variant_id AS "winnerVariantId", r.experiment_created_at AS "createdAt",
            r.control_variant_id AS "controlVariantId", r.variant_id AS "variantId", r.label,
            r.content, r.is_control AS "isControl", r.impressions::text AS impressions,
            r.ctr::text AS ctr, r.ctr_vs_control::text AS "ctrVsControl",
            r.ctr_lift_pct::text AS "ctrLiftPct", r.is_winner AS "isWinner"
       FROM public.experiment_results r
       JOIN picked p ON p.id = r.experiment_id
      ORDER BY r.experiment_created_at DESC, r.experiment_id DESC, r.is_control DESC, r.label,
               r.variant_id`,
    [input.experimentId ?? null, input.videoId ?? null, [...statuses], limit],
  );
  const results: ExperimentResultRecord[] = [];
  for (const row of rows) {
    let experiment = results.at(-1);
    if (experiment?.experimentId !== row.experimentId) {
      experiment = {
        experimentId: row.experimentId,
        videoId: row.videoId,
        videoTitle: row.videoTitle,
        type: row.type,
        status: row.status,
        hypothesis: row.hypothesis,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        conclusion: row.conclusion,
        winnerVariantId: row.winnerVariantId,
        createdAt: row.createdAt,
        controlVariantId: row.controlVariantId,
        variants: [],
      };
      results.push(experiment);
    }
    experiment.variants.push({
      variantId: row.variantId,
      label: row.label,
      content: row.content,
      isControl: row.isControl,
      impressions: row.impressions,
      ctr: row.ctr,
      ctrVsControl: row.ctrVsControl,
      ctrLiftPct: row.ctrLiftPct,
      isWinner: row.isWinner,
    });
  }
  return results;
}
