import type { MetricSnapshot } from "@ytw/shared/api/videos";
import type { ChartSeries } from "@/kit/charts/series.ts";

function numeric(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Keep missing values as gaps so the chart never implies measurements that were not recorded. */
export function metricsToChartSeries(metrics: readonly MetricSnapshot[]): ChartSeries[] {
  return [
    {
      label: "Views",
      points: metrics.map((item) => ({ x: item.captured_at, y: numeric(item.views) })),
    },
    {
      label: "CTR",
      points: metrics.map((item) => ({ x: item.captured_at, y: numeric(item.ctr) })),
    },
    {
      label: "Average view duration (seconds)",
      points: metrics.map((item) => ({
        x: item.captured_at,
        y: numeric(item.avg_view_duration_s),
      })),
    },
  ];
}

/** Retention is a curve from a single snapshot; the x-axis is elapsed seconds in the video. */
export function retentionToChartSeries(retention: MetricSnapshot["retention"]): ChartSeries[] {
  return [
    {
      label: "Still watching",
      points: (retention ?? []).map((point) => ({ x: point.t, y: point.pct })),
    },
  ];
}
