import { useQuery } from "@tanstack/react-query";
import { IDEA_STAGE_LABELS, IDEA_STAGES, type IdeaStage } from "@ytw/shared/constants";
import { Link } from "react-router";
import { DASHBOARD_PATH, dashboardResponseSchema } from "@ytw/shared/api/dashboard";
import { Badge } from "@/kit/Badge.tsx";
import { EmptyState, ErrorState, LoadingState } from "@/kit/states.tsx";
import { PageHeader } from "@/kit/PageHeader.tsx";
import { api } from "@/lib/api.ts";
import { formatCompactNumber, formatDateTime, formatRelativeTime } from "@/lib/format.ts";

const DASHBOARD_KEY = ["dashboard"] as const;

function stageHref(stage: IdeaStage): string {
  return `/ideas?stage=${encodeURIComponent(stage)}`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-subtle px-3 py-3">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

export function Component() {
  const query = useQuery({
    queryKey: DASHBOARD_KEY,
    queryFn: ({ signal }) => api.get(DASHBOARD_PATH, { parse: dashboardResponseSchema, signal }),
  });
  const ideaCounts = query.data?.ideas ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboard"
        description="A current view of the channel pipeline, experiments and videos."
      />
      {query.isPending ? (
        <LoadingState label="Loading dashboard" lines={6} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : (
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          <section
            aria-labelledby="pipeline-title"
            className="rounded-xl border border-line bg-surface p-4 min-w-0"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="pipeline-title" className="text-lg font-semibold">
                  Idea pipeline
                </h2>
                <p className="mt-1 text-sm text-ink-muted">Active ideas by production stage.</p>
              </div>
              {ideaCounts ? <Badge>{ideaCounts.total} ideas</Badge> : null}
            </div>
            {ideaCounts ? (
              <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {IDEA_STAGES.map((stage) => (
                  <Link
                    key={stage}
                    to={stageHref(stage)}
                    className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <Metric
                      label={IDEA_STAGE_LABELS[stage]}
                      value={formatCompactNumber(ideaCounts.by_stage[stage])}
                    />
                  </Link>
                ))}
              </dl>
            ) : (
              <p className="mt-4 text-sm text-ink-muted">
                Read access to ideas is required for this summary.
              </p>
            )}
          </section>

          <section
            aria-labelledby="running-title"
            className="rounded-xl border border-line bg-surface p-4 min-w-0"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="running-title" className="text-lg font-semibold">
                  Running experiments
                </h2>
                <p className="mt-1 text-sm text-ink-muted">Tests currently collecting results.</p>
              </div>
              {query.data.running_experiments ? (
                <Badge>{query.data.running_experiments.length} running</Badge>
              ) : null}
            </div>
            {query.data.running_experiments === null ? (
              <p className="mt-4 text-sm text-ink-muted">
                Read access to experiments is required for this summary.
              </p>
            ) : query.data.running_experiments.length === 0 ? (
              <EmptyState
                compact
                title="No running experiments"
                description="A running test will appear here when one starts."
              />
            ) : (
              <ul className="mt-4 divide-y divide-line">
                {query.data.running_experiments.map((experiment) => (
                  <li key={experiment.id}>
                    <Link
                      to={`/experiments/${experiment.id}`}
                      className="block min-h-11 py-3 outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {experiment.video_title ?? "Video title unavailable"}
                        </span>
                        <Badge tone="info">{experiment.type}</Badge>
                      </div>
                      <p className="mt-1 text-sm text-ink-muted">
                        {experiment.variants.length} variants
                        {experiment.starts_at
                          ? ` · started ${formatRelativeTime(experiment.starts_at)}`
                          : " · start time not recorded"}
                      </p>
                      {experiment.hypothesis ? (
                        <p className="mt-1 line-clamp-2 text-sm">{experiment.hypothesis}</p>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            aria-labelledby="videos-title"
            className="rounded-xl border border-line bg-surface p-4 min-w-0"
          >
            <div>
              <h2 id="videos-title" className="text-lg font-semibold">
                Latest published videos
              </h2>
              <p className="mt-1 text-sm text-ink-muted">Latest recorded headline metrics.</p>
            </div>
            {query.data.latest_videos === null ? (
              <p className="mt-4 text-sm text-ink-muted">
                Read access to videos is required for this summary.
              </p>
            ) : query.data.latest_videos.length === 0 ? (
              <EmptyState
                compact
                title="No published videos yet"
                description="Published videos with metrics will appear here."
              />
            ) : (
              <ul className="mt-4 divide-y divide-line">
                {query.data.latest_videos.map((video) => (
                  <li key={video.id} className="py-3 first:pt-0 last:pb-0">
                    <Link
                      to={`/videos/${video.id}`}
                      className="font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      {video.title}
                    </Link>
                    <p className="mt-1 text-sm text-ink-muted">
                      Published {formatDateTime(video.published_at)}
                    </p>
                    <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Metric
                        label="Views"
                        value={
                          video.views === null ? "—" : formatCompactNumber(Number(video.views))
                        }
                      />
                      <Metric
                        label="Impressions"
                        value={
                          video.impressions === null
                            ? "—"
                            : formatCompactNumber(Number(video.impressions))
                        }
                      />
                      <Metric label="CTR" value={video.ctr === null ? "—" : `${video.ctr}%`} />
                      <Metric
                        label="Avg view duration"
                        value={
                          video.avg_view_duration_s === null
                            ? "—"
                            : `${Math.round(Number(video.avg_view_duration_s))} s`
                        }
                      />
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
