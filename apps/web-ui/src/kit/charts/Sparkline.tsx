import { lazy, Suspense, useMemo } from "react";
import { cx } from "@/lib/cx.ts";
import { formatNumber } from "@/lib/format.ts";
import { describeValues } from "./series.ts";

const UPlotChart = lazy(() => import("./UPlotChart.tsx"));

export interface SparklineProps {
  /** The values in time order; `null` leaves a gap. */
  values: readonly (number | null)[];
  /** What the numbers are, for the text alternative: "Views, last 30 snapshots". */
  label: string;
  width?: number;
  height?: number;
  valueFormat?: (value: number) => string;
  className?: string;
}

/**
 * A tiny trend line for table rows and stat tiles, built on uPlot and lazy-loaded. It has no axes,
 * legend or hover. Its text alternative is generated from the data ("Views, last 30 snapshots: 12
 * data points, from 100 to 480, up 380%"), so the trend is available without seeing the line.
 */
export function Sparkline({
  values,
  label,
  width = 96,
  height = 28,
  valueFormat = formatNumber,
  className,
}: SparklineProps) {
  const description = useMemo(() => describeValues(values, valueFormat), [values, valueFormat]);
  const columns = useMemo(() => [[...values]], [values]);
  const xs = useMemo(() => values.map((_, index) => index), [values]);
  const hasData = values.some((v) => v !== null && Number.isFinite(v));
  const box = { width, height };

  if (!hasData) {
    return (
      <span
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a canvas chart has no semantic element; the label and description are its text alternative
        role="img"
        aria-label={`${label}: no data`}
        className={cx("inline-flex items-center justify-center text-ink-muted", className)}
        style={box}
      >
        {"—"}
      </span>
    );
  }

  return (
    <span
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a canvas chart has no semantic element; the label and description are its text alternative
      role="img"
      aria-label={`${label}: ${description}`}
      className={cx("inline-block align-middle", className)}
      style={box}
    >
      <Suspense
        fallback={
          <span
            aria-hidden="true"
            className="block animate-pulse rounded bg-subtle motion-reduce:animate-none"
            style={box}
          />
        }
      >
        <UPlotChart
          compact
          xs={xs}
          columns={columns}
          labels={[label]}
          xKind="linear"
          width={width}
          height={height}
          valueFormat={valueFormat}
        />
      </Suspense>
    </span>
  );
}
