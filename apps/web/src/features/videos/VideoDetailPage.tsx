import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Edit3, ExternalLink } from "lucide-react";
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LastChangedBy,
  LoadingState,
  PageHeader,
  TimeSeriesChart,
  WriteGuard,
} from "@/kit";
import { describeError } from "@/lib/errors.ts";
import { formatDateTime, formatNumber } from "@/lib/format.ts";
import { VideoEditorDialog } from "./VideoEditorDialog.tsx";
import { fetchVideo, videoWatchUrl, videosQueryKey } from "./api.ts";
import { metricsToChartSeries, retentionToChartSeries } from "./chart-data.ts";

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function performanceText(value: string | null, suffix: string): string {
  const number = numberOrNull(value);
  if (number === null) return "—";
  return `${formatNumber(number)}${suffix}`;
}

export function Component() {
  const { videoId = "" } = useParams();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const query = useQuery({
    queryKey: videosQueryKey.detail(videoId),
    queryFn: ({ signal }) => fetchVideo(videoId, signal),
    enabled: videoId.length > 0,
  });

  if (query.isPending) return <LoadingState label="Loading video" lines={6} />;
  if (query.isError && !query.data) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (!query.data) {
    return <EmptyState title="Video not found" description="This video may have been removed." />;
  }

  const { video, metrics, performance, idea } = query.data;
  const archived = video.archived_at !== null;
  const chartSeries = metricsToChartSeries(metrics);
  const viewsSeries = chartSeries[0];
  const ctrSeries = chartSeries[1];
  const durationSeries = chartSeries[2];
  const retentionSnapshot = metrics.toReversed().find((item) => item.retention?.length);
  const retentionSeries = retentionToChartSeries(retentionSnapshot?.retention ?? null);
  const watchUrl = videoWatchUrl(video.youtube_id);

  return (
    <div className="space-y-5">
      <PageHeader
        title={video.title}
        back={{ to: "/videos", label: "All videos" }}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {video.published_at ? (
              <Badge>{formatDateTime(video.published_at)}</Badge>
            ) : (
              <Badge>Not scheduled</Badge>
            )}
            {archived ? <Badge tone="warn">Archived</Badge> : null}
            <span>Version {video.version}</span>
            <LastChangedBy actor={video.updated_by} at={video.updated_at} />
          </span>
        }
        actions={
          <>
            {watchUrl ? (
              <a
                href={watchUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong px-3 py-2 text-sm font-medium text-link hover:bg-subtle"
              >
                Watch on YouTube <ExternalLink aria-hidden="true" className="size-4" />
              </a>
            ) : null}
            {!archived ? (
              <WriteGuard resource="videos" className="contents">
                <Button onClick={() => setEditOpen(true)}>
                  <Edit3 aria-hidden="true" className="size-4" /> Edit video
                </Button>
              </WriteGuard>
            ) : null}
          </>
        }
      />
      {query.isError && query.data ? (
        <Alert tone="warn" title="Showing the last loaded video">
          {describeError(query.error)}
        </Alert>
      ) : null}
      {archived ? (
        <Alert tone="info" title="Archived video">
          This video is read-only.
        </Alert>
      ) : null}

      {video.idea_id ? (
        <Card className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink-muted">Originating idea</span>
          {idea ? (
            <Link
              to={`/ideas/${idea.id}`}
              className="min-h-11 inline-flex items-center rounded-lg px-2 font-medium text-link hover:bg-subtle hover:underline"
            >
              {idea.title}
            </Link>
          ) : (
            <span className="text-sm text-ink-muted">
              Idea details require Read access to ideas.
            </span>
          )}
        </Card>
      ) : null}

      {performance?.latest ? (
        <section aria-label="Latest performance" className="grid gap-3 sm:grid-cols-3">
          <PerformanceCard
            label="Latest views"
            value={performanceText(performance.latest.views, "")}
            delta={performanceText(performance.vs_median.views, " vs median")}
            capturedAt={performance.latest.captured_at}
          />
          <PerformanceCard
            label="Latest click-through rate"
            value={performanceText(performance.latest.ctr, "%")}
            delta={performanceText(performance.vs_median.ctr, " pp vs median")}
            capturedAt={performance.latest.captured_at}
          />
          <PerformanceCard
            label="Average view duration"
            value={performanceText(performance.latest.avg_view_duration_s, " s")}
            delta={performanceText(performance.vs_median.avg_view_duration_s, " s vs median")}
            capturedAt={performance.latest.captured_at}
          />
        </section>
      ) : null}

      <section aria-label="Video metrics over time" className="grid gap-4 xl:grid-cols-2">
        <Card>
          <TimeSeriesChart
            title="Views over time"
            series={viewsSeries ? [viewsSeries] : []}
            valueFormat={(value) =>
              new Intl.NumberFormat(undefined, { notation: "compact" }).format(value)
            }
            yMin={0}
            emptyMessage="Views appear after the first metric snapshot is recorded."
          />
        </Card>
        <Card>
          <TimeSeriesChart
            title="Click-through rate over time"
            series={ctrSeries ? [ctrSeries] : []}
            valueFormat={(value) => `${formatNumber(value)}%`}
            yMin={0}
            emptyMessage="CTR appears after the first metric snapshot is recorded."
          />
        </Card>
        <Card>
          <TimeSeriesChart
            title="Average view duration over time"
            series={durationSeries ? [durationSeries] : []}
            valueFormat={(value) => `${formatNumber(value)} s`}
            yMin={0}
            emptyMessage="Average view duration appears after the first metric snapshot is recorded."
          />
        </Card>
        <Card>
          <TimeSeriesChart
            title="Audience retention"
            series={retentionSeries}
            xKind="linear"
            xLabel="Video position (seconds)"
            valueFormat={(value) => `${formatNumber(value)}%`}
            yMin={0}
            emptyMessage="A retention curve appears when a snapshot includes audience retention data."
          />
          {retentionSnapshot ? (
            <p className="mt-2 text-xs text-ink-muted">
              Latest curve captured {formatDateTime(retentionSnapshot.captured_at)}.
            </p>
          ) : null}
        </Card>
      </section>

      {metrics.length > 0 ? (
        <p className="text-sm text-ink-muted">
          {metrics.length.toLocaleString()} metric snapshots. Charts show up to 1,000 snapshots.
        </p>
      ) : null}

      <VideoEditorDialog
        open={editOpen}
        video={video}
        onClose={() => setEditOpen(false)}
        onSaved={(saved) => {
          queryClient.setQueryData(videosQueryKey.detail(saved.id), (current) =>
            current ? { ...current, video: saved } : current,
          );
        }}
      />
    </div>
  );
}

function PerformanceCard({
  label,
  value,
  delta,
  capturedAt,
}: {
  label: string;
  value: string;
  delta: string;
  capturedAt: string;
}) {
  return (
    <Card>
      <p className="text-sm text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-sm text-ink-muted">{delta}</p>
      <p className="mt-2 text-xs text-ink-muted">Captured {formatDateTime(capturedAt)}</p>
    </Card>
  );
}
