import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowDown, ArrowUp, ExternalLink, Plus } from "lucide-react";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SelectField,
  WriteGuard,
  useWideLayout,
  useWriteGuard,
} from "@/kit";
import { formatDate, formatNumber } from "@/lib/format.ts";
import { describeError } from "@/lib/errors.ts";
import { VideoEditorDialog } from "./VideoEditorDialog.tsx";
import { fetchVideos, videoWatchUrl, videosQueryKey } from "./api.ts";
import { latestValue, metricFields, sortVideos } from "./sorting.ts";
import type { MetricField, SortField, SortOrder } from "./sorting.ts";

const percentageFields = new Set<MetricField>(["ctr", "avg_view_pct"]);
const VIDEO_LIST_LIMIT = 1000;

function integer(value: string): bigint | null {
  return /^-?\d+$/.test(value) ? BigInt(value) : null;
}

function decimal(value: string | null): number | null {
  if (value === null) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function metric(value: string | null, field: MetricField): string {
  if (value === null) return "—";
  if (field === "views" || field === "impressions" || field === "subs_gained") {
    const count = integer(value);
    return count === null ? value : new Intl.NumberFormat().format(count);
  }
  const number = decimal(value);
  if (number === null) return "—";
  if (percentageFields.has(field)) return `${formatNumber(number)}%`;
  if (field === "avg_view_duration_s") return `${formatNumber(number)} s`;
  if (field === "watch_time_min") return `${formatNumber(number)} min`;
  return formatNumber(number);
}

function delta(value: string | null, field: MetricField): string {
  if (value === null) return "No channel median";
  const number = decimal(value);
  if (number === null || number === 0)
    return `Median ${value === "0" ? "match" : "difference"}: ${value}`;
  const prefix = number > 0 ? "+" : "";
  if (field === "views" || field === "impressions" || field === "subs_gained") {
    const count = integer(value);
    return `vs median ${count !== null && count > 0n ? "+" : ""}${count?.toLocaleString() ?? value}`;
  }
  const suffix = percentageFields.has(field)
    ? " pp"
    : field === "avg_view_duration_s"
      ? " s"
      : field === "watch_time_min"
        ? " min"
        : "";
  return `vs median ${prefix}${formatNumber(number)}${suffix}`;
}

function SortHeader({
  label,
  field,
  sortBy,
  sortOrder,
  onSort,
}: {
  label: string;
  field: SortField;
  sortBy: SortField;
  sortOrder: SortOrder;
  onSort: (field: SortField) => void;
}) {
  const active = field === sortBy;
  return (
    <th
      scope="col"
      aria-sort={active ? (sortOrder === "asc" ? "ascending" : "descending") : "none"}
      className="whitespace-nowrap px-3 py-2 text-start"
    >
      <Button variant="ghost" className="-ms-2" onClick={() => onSort(field)}>
        {label}
        {active ? (
          sortOrder === "asc" ? (
            <ArrowUp aria-hidden="true" className="size-3.5" />
          ) : (
            <ArrowDown aria-hidden="true" className="size-3.5" />
          )
        ) : null}
      </Button>
    </th>
  );
}

export function Component() {
  useWideLayout(true);
  const writeGuard = useWriteGuard("videos");
  const [sortBy, setSortBy] = useState<SortField>("published_at");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [createOpen, setCreateOpen] = useState(false);
  const query = useQuery({
    queryKey: videosQueryKey.list(VIDEO_LIST_LIMIT),
    queryFn: ({ signal }) => fetchVideos(VIDEO_LIST_LIMIT, signal),
  });
  const videos = useMemo(
    () => sortVideos(query.data?.videos ?? [], sortBy, sortOrder),
    [query.data?.videos, sortBy, sortOrder],
  );

  if (query.isPending) return <LoadingState label="Loading videos" lines={5} />;
  if (query.isError && !query.data) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }

  const actions = (
    <WriteGuard resource="videos" className="contents">
      <Button variant="primary" onClick={() => setCreateOpen(true)}>
        <Plus aria-hidden="true" className="size-4" /> Register video
      </Button>
    </WriteGuard>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Videos"
        description="Published videos, their latest performance and differences from the channel median."
        actions={actions}
      />
      {!writeGuard.allowed && writeGuard.message ? (
        <Alert tone="info" title="Videos are read-only">
          {writeGuard.message}
        </Alert>
      ) : null}
      {query.isError && query.data ? (
        <Alert tone="warn" title="Showing the last loaded list">
          {describeError(query.error)}
        </Alert>
      ) : null}
      {videos.length === VIDEO_LIST_LIMIT ? (
        <Alert tone="info" title="Video list reached its limit">
          Showing the first 1,000 videos. Additional videos may be hidden.
        </Alert>
      ) : null}
      {videos.length === 0 ? (
        <Card>
          <EmptyState
            title="No videos yet"
            description="Register a published or scheduled YouTube video to track its metrics over time."
            action={
              writeGuard.allowed ? (
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Register video
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <div className="flex items-center gap-3 md:hidden">
            <SelectField
              label="Sort videos"
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value as SortField)}
              className="min-w-0 flex-1"
            >
              <option value="published_at">Published date</option>
              <option value="title">Title</option>
              {metricFields.map(({ field, label }) => (
                <option key={field} value={field}>
                  {label}
                </option>
              ))}
            </SelectField>
            <Button
              aria-label={`Sort ${sortOrder === "desc" ? "ascending" : "descending"}`}
              onClick={() => setSortOrder((current) => (current === "asc" ? "desc" : "asc"))}
            >
              {sortOrder === "asc" ? (
                <ArrowUp aria-hidden="true" className="size-4" />
              ) : (
                <ArrowDown aria-hidden="true" className="size-4" />
              )}
            </Button>
          </div>

          <div className="grid gap-3 md:hidden">
            {videos.map((video) => (
              <Card key={video.id} className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      to={`/videos/${video.id}`}
                      className="font-semibold text-link hover:underline"
                    >
                      {video.title}
                    </Link>
                    <p className="mt-1 text-sm text-ink-muted">
                      {video.published_at ? formatDate(video.published_at) : "Not scheduled"}
                    </p>
                  </div>
                  <a
                    href={videoWatchUrl(video.youtube_id) ?? "https://www.youtube.com/"}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${video.title} on YouTube`}
                    className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-sm text-link hover:bg-subtle"
                  >
                    <ExternalLink aria-hidden="true" className="size-4" /> YouTube
                  </a>
                </div>
                <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                  {metricFields.map(({ field, label }) => (
                    <MetricCell
                      key={field}
                      label={label}
                      value={metric(latestValue(video, field), field)}
                      change={delta(video.vs_median[field], field)}
                    />
                  ))}
                </dl>
              </Card>
            ))}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border border-line md:block">
            <table className="min-w-full border-collapse text-sm">
              <caption className="sr-only">
                Video performance with latest metrics and differences from the channel median
              </caption>
              <thead className="bg-subtle">
                <tr>
                  <SortHeader
                    label="Video"
                    field="title"
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSort={toggleSort}
                  />
                  <SortHeader
                    label="Published"
                    field="published_at"
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSort={toggleSort}
                  />
                  {metricFields.map(({ field, label }) => (
                    <SortHeader
                      key={field}
                      label={label}
                      field={field}
                      sortBy={sortBy}
                      sortOrder={sortOrder}
                      onSort={toggleSort}
                    />
                  ))}
                  <th scope="col" className="px-3 py-2 text-start">
                    YouTube
                  </th>
                </tr>
              </thead>
              <tbody>
                {videos.map((video) => (
                  <tr key={video.id} className="border-t border-line align-top">
                    <th scope="row" className="max-w-72 px-3 py-3 text-start font-medium">
                      <Link
                        to={`/videos/${video.id}`}
                        className="break-words text-link hover:underline"
                      >
                        {video.title}
                      </Link>
                    </th>
                    <td className="whitespace-nowrap px-3 py-3">
                      {video.published_at ? formatDate(video.published_at) : "—"}
                    </td>
                    {metricFields.map(({ field }) => (
                      <td key={field} className="whitespace-nowrap px-3 py-3 tabular-nums">
                        {metric(latestValue(video, field), field)}
                        <span className="mt-1 block text-xs text-ink-muted">
                          {delta(video.vs_median[field], field)}
                        </span>
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-3 py-3">
                      <a
                        href={videoWatchUrl(video.youtube_id) ?? "https://www.youtube.com/"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-link hover:bg-subtle"
                      >
                        Open <ExternalLink aria-hidden="true" className="size-4" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <VideoEditorDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );

  function toggleSort(field: SortField) {
    if (field === sortBy) setSortOrder((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortBy(field);
      setSortOrder(field === "title" ? "asc" : "desc");
    }
  }
}

function MetricCell({ label, value, change }: { label: string; value: string; change: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="truncate font-medium tabular-nums">{value}</dd>
      <dd className="truncate text-xs text-ink-muted">{change}</dd>
    </div>
  );
}
