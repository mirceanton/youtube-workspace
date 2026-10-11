import { useQuery } from "@tanstack/react-query";
import { IDEA_STAGE_LABELS, IDEA_STAGES, type IdeaStage } from "@ytw/shared/constants";
import type { ReactNode } from "react";
import { Link } from "react-router";
import {
  DASHBOARD_LATEST_VIDEOS,
  DASHBOARD_PATH,
  dashboardResponseSchema,
  type DashboardResponse,
} from "@ytw/shared/api/dashboard";
import { Badge } from "@/kit/Badge.tsx";
import { Button } from "@/kit/Button.tsx";
import { ErrorState } from "@/kit/states.tsx";
import { PageHeader } from "@/kit/PageHeader.tsx";
import { api } from "@/lib/api.ts";
import { cx } from "@/lib/cx.ts";
import {
  formatCompactNumber,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelativeTime,
} from "@/lib/format.ts";
import { usePersistedState } from "@/lib/persisted-state.ts";

const DASHBOARD_KEY = ["dashboard"] as const;

/** How many of the latest videos to list; the response carries at most `DASHBOARD_LATEST_VIDEOS`. */
const VIDEO_COUNT_OPTIONS = [5, DASHBOARD_LATEST_VIDEOS] as const;
const DEFAULT_VIDEO_COUNT = VIDEO_COUNT_OPTIONS[0];
type VideoCount = (typeof VIDEO_COUNT_OPTIONS)[number];

function isVideoCount(value: unknown): value is VideoCount {
  return VIDEO_COUNT_OPTIONS.some((option) => option === value);
}

type Experiment = NonNullable<DashboardResponse["running_experiments"]>[number];
type Video = NonNullable<DashboardResponse["latest_videos"]>[number];

function stageHref(stage: IdeaStage): string {
  return `/ideas?stage=${encodeURIComponent(stage)}`;
}

/** Metrics arrive as decimal strings, or null when the snapshot did not measure them. */
function metric(value: string | null, format: (n: number) => string): string | null {
  return value === null ? null : format(Number(value));
}

/** A section that is empty, or that the user may not read. */
function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-line p-4 text-sm text-ink-muted">{children}</p>;
}

function SectionHeading({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2.5 gap-y-2">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {count === undefined ? null : (
        <span className="rounded-full bg-subtle px-2 py-0.5 text-xs text-ink-muted tabular-nums">
          {count}
        </span>
      )}
      {children ? <div className="ms-auto">{children}</div> : null}
    </div>
  );
}

/**
 * One tile per stage in a single bordered strip. The dividers are cell borders pulled back by one
 * pixel and clipped, so they stay clean at any column count. Seven stages never divide evenly, so
 * `dropped`, which sits outside the pipeline and is the last tile, takes two columns until all
 * seven fit on one row.
 */
function PipelineStrip({ counts }: { counts: Record<IdeaStage, number> }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <ul className="-mr-px -mb-px grid grid-cols-2 @lg:grid-cols-4 @4xl:grid-cols-7">
        {IDEA_STAGES.map((stage) => (
          <li
            key={stage}
            className={cx(
              "border-r border-b border-line",
              stage === "dropped" && "col-span-2 @4xl:col-span-1",
            )}
          >
            <Link
              to={stageHref(stage)}
              className="block h-full px-4 py-3 transition-colors hover:bg-subtle focus-visible:-outline-offset-2"
            >
              <span
                className={cx(
                  "block text-2xl font-extrabold tabular-nums",
                  stage === "dropped" && "text-ink-muted",
                )}
              >
                {formatCompactNumber(counts[stage])}
              </span>
              <span className="mt-0.5 block text-xs tracking-wide text-ink-muted uppercase">
                {IDEA_STAGE_LABELS[stage]}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExperimentCard({ experiment }: { experiment: Experiment }) {
  const variantCount = experiment.variants.length;
  return (
    <Link
      to={`/experiments/${experiment.id}`}
      className="flex h-full flex-col gap-2.5 rounded-xl border border-line bg-surface p-3 transition-colors hover:border-line-strong"
    >
      <span className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-base font-extrabold">
          {experiment.video_title ?? "Video title unavailable"}
        </span>
        <Badge tone="info" className="shrink-0">
          {experiment.type}
        </Badge>
      </span>
      <span className="text-xs text-ink-muted">
        {variantCount} {variantCount === 1 ? "variant" : "variants"}
        {experiment.starts_at
          ? ` · started ${formatRelativeTime(experiment.starts_at)}`
          : " · start time not recorded"}
      </span>
      {experiment.hypothesis ? (
        <span className="line-clamp-2 text-sm">{experiment.hypothesis}</span>
      ) : null}
      <span className="mt-auto flex flex-wrap gap-1.5 pt-1">
        {experiment.variants.map((variant) => (
          <span
            key={variant.label}
            className="max-w-full truncate rounded-md bg-subtle px-2 py-0.5 text-xs"
          >
            {variant.label}
            {variant.is_control ? <span className="text-ink-muted"> · control</span> : null}
          </span>
        ))}
      </span>
    </Link>
  );
}

function VideoMetric({ label, value }: { label: string; value: string | null }) {
  return (
    // The number reads first on screen; the term stays first in the source, as a `dl` requires.
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs tracking-wide text-ink-muted uppercase">{label}</dt>
      <dd className="order-first text-xl font-extrabold tabular-nums">
        {value ?? (
          <>
            <span aria-hidden="true">{"—"}</span>
            <span className="sr-only">Not recorded</span>
          </>
        )}
      </dd>
    </div>
  );
}

function VideoRow({ video }: { video: Video }) {
  return (
    <Link
      to={`/videos/${video.id}`}
      className="grid gap-3 px-4 py-3 transition-colors hover:bg-subtle focus-visible:-outline-offset-2 @2xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @2xl:items-center @2xl:gap-6"
    >
      <span className="min-w-0">
        <span className="line-clamp-2 font-bold">{video.title}</span>
        <time
          dateTime={video.published_at}
          title={formatDateTime(video.published_at)}
          className="mt-0.5 block text-xs text-ink-muted"
        >
          Published {formatRelativeTime(video.published_at)}
        </time>
      </span>
      <dl className="grid grid-cols-2 gap-3 @lg:grid-cols-4">
        <VideoMetric label="Views" value={metric(video.views, formatCompactNumber)} />
        <VideoMetric label="Impressions" value={metric(video.impressions, formatCompactNumber)} />
        <VideoMetric label="CTR" value={metric(video.ctr, formatPercent)} />
        <VideoMetric
          label="Avg view duration"
          value={metric(video.avg_view_duration_s, formatDuration)}
        />
      </dl>
    </Link>
  );
}

function VideoCountToggle({
  value,
  onChange,
}: {
  value: VideoCount;
  onChange: (count: VideoCount) => void;
}) {
  return (
    <fieldset className="flex items-center gap-2">
      <legend className="sr-only">Number of videos shown</legend>
      <span aria-hidden="true" className="text-sm text-ink-muted">
        Show
      </span>
      {VIDEO_COUNT_OPTIONS.map((option) => (
        <Button
          key={option}
          variant={value === option ? "primary" : "secondary"}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {option}
        </Button>
      ))}
    </fieldset>
  );
}

/** Placeholder blocks that mirror the three sections, so nothing jumps when the data arrives. */
function DashboardSkeleton() {
  const block = "block animate-pulse rounded-xl bg-subtle motion-reduce:animate-none";
  return (
    <output aria-live="polite" className="block space-y-8">
      <span className="sr-only">Loading dashboard</span>
      <span aria-hidden="true" className={cx(block, "h-24")} />
      <span aria-hidden="true" className={cx(block, "h-40")} />
      <span aria-hidden="true" className={cx(block, "h-72")} />
    </output>
  );
}

function DashboardSections({ data }: { data: DashboardResponse }) {
  const [videoCount, setVideoCount] = usePersistedState(
    "ytw.dashboard-video-count",
    DEFAULT_VIDEO_COUNT,
    isVideoCount,
  );
  const { ideas, running_experiments: experiments, latest_videos: latestVideos } = data;
  const videos = latestVideos?.slice(0, videoCount) ?? null;

  return (
    // A container, not the viewport, decides the columns: the sidebar takes a quarter of a laptop.
    <div className="@container space-y-8">
      <section aria-labelledby="pipeline-title">
        <SectionHeading id="pipeline-title" title="Idea pipeline" count={ideas?.total} />
        {ideas ? (
          <PipelineStrip counts={ideas.by_stage} />
        ) : (
          <Note>Read access to ideas is required for this summary.</Note>
        )}
      </section>

      <section aria-labelledby="running-title">
        <SectionHeading
          id="running-title"
          title="Running experiments"
          count={experiments?.length}
        />
        {experiments === null ? (
          <Note>Read access to experiments is required for this summary.</Note>
        ) : experiments.length === 0 ? (
          <Note>No experiments running. A running test will appear here when one starts.</Note>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(18.75rem,1fr))] gap-4">
            {experiments.map((experiment) => (
              <li key={experiment.id}>
                <ExperimentCard experiment={experiment} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="videos-title">
        <SectionHeading id="videos-title" title="Latest videos" count={videos?.length}>
          {latestVideos && latestVideos.length > VIDEO_COUNT_OPTIONS[0] ? (
            <VideoCountToggle value={videoCount} onChange={setVideoCount} />
          ) : null}
        </SectionHeading>
        {videos === null ? (
          <Note>Read access to videos is required for this summary.</Note>
        ) : videos.length === 0 ? (
          <Note>No published videos yet. Published videos with metrics will appear here.</Note>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {videos.map((video) => (
              <li key={video.id}>
                <VideoRow video={video} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function Component() {
  const query = useQuery({
    queryKey: DASHBOARD_KEY,
    queryFn: ({ signal }) => api.get(DASHBOARD_PATH, { parse: dashboardResponseSchema, signal }),
  });

  return (
    <div>
      <PageHeader title="Dashboard" />
      {query.isPending ? (
        <DashboardSkeleton />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : (
        <DashboardSections data={query.data} />
      )}
    </div>
  );
}
