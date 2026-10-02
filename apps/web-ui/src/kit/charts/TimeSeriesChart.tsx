import { lazy, Suspense, useId, useMemo, useState } from "react";
import { LineChart } from "lucide-react";
import { cx } from "@/lib/cx.ts";
import { Button } from "../Button.tsx";
import { EmptyState } from "../states.tsx";
import {
  alignSeries,
  buildTable,
  defaultFormatters,
  isEmptyData,
  MAX_PLOTTED_SERIES,
  summarizeSeries,
  toX,
  type ChartMarker,
  type ChartSeries,
  type XKind,
} from "./series.ts";

// uPlot is fetched on first render of a chart with data; until then a same-size placeholder holds
// the space, so the page does not jump.
const UPlotChart = lazy(() => import("./UPlotChart.tsx"));

export interface TimeSeriesChartProps {
  /** Names the chart: shown above it and used as its accessible name. */
  title: string;
  /**
   * One line per series (up to four are drawn, in the validated palette order; further series
   * stay in the data table). Memoise this array: the chart updates when its identity changes.
   */
  series: readonly ChartSeries[];
  /** `time` (default): x is a moment. `linear`: x is a plain number, e.g. percent of a video. */
  xKind?: XKind;
  /** Column title for x in the data table. Defaults to "Date" / "Position". */
  xLabel?: string;
  /** Formats values on the axis, in the hover read-out and in the table. */
  valueFormat?: (value: number) => string;
  /** Vertical reference lines such as "Experiment started"; listed under the chart as text too. */
  markers?: readonly ChartMarker[];
  /** Plot height in px (default 240). */
  height?: number;
  /** Pins the bottom of the y axis, e.g. `0` for counts. */
  yMin?: number;
  /** Shown instead of the chart when no series has a value. */
  emptyMessage?: string;
  className?: string;
}

/**
 * Line chart over time (or over any numeric x) built on uPlot and lazy-loaded.
 *
 * Accessibility: the canvas is not readable by assistive technology, so the figure always carries
 * a text alternative (a generated summary: range, lowest, highest, latest per series) and a
 * "Show data table" disclosure with every value. Markers are listed as text. Colours are never the
 * only identity channel: the legend names each series.
 */
export function TimeSeriesChart({
  title,
  series,
  xKind = "time",
  xLabel,
  valueFormat,
  markers,
  height = 240,
  yMin,
  emptyMessage = "There is no data to chart yet.",
  className,
}: TimeSeriesChartProps) {
  const captionId = useId();
  const summaryId = useId();
  const tableId = useId();
  const [tableOpen, setTableOpen] = useState(false);

  const model = useMemo(() => {
    const aligned = alignSeries(series, xKind);
    const labels = series.map((s) => s.label);
    const formatters = defaultFormatters(xKind, valueFormat);
    const plotted = Math.min(series.length, MAX_PLOTTED_SERIES);
    return {
      aligned,
      labels,
      formatters,
      plotted,
      empty: isEmptyData(aligned),
      summary: summarizeSeries(labels, aligned, formatters),
    };
  }, [series, xKind, valueFormat]);

  const plotMarkers = useMemo(
    () =>
      (markers ?? []).flatMap((marker) => {
        const x = toX(marker.x, xKind);
        return x === null ? [] : [{ x, label: marker.label, text: model.formatters.formatX(x) }];
      }),
    [markers, xKind, model.formatters],
  );

  const table = useMemo(
    () =>
      tableOpen
        ? buildTable(
            xLabel ?? (xKind === "time" ? "Date" : "Position"),
            model.labels,
            model.aligned,
            model.formatters,
          )
        : null,
    [tableOpen, xLabel, xKind, model],
  );

  return (
    <figure className={cx("flex min-w-0 flex-col gap-2", className)}>
      <figcaption id={captionId} className="font-medium">
        {title}
      </figcaption>

      {model.empty ? (
        <EmptyState compact icon={LineChart} title="No data yet" description={emptyMessage} />
      ) : (
        <>
          <div
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a canvas chart has no semantic element; the label and description are its text alternative
            role="img"
            aria-labelledby={captionId}
            aria-describedby={summaryId}
            className="relative w-full min-w-0 overflow-hidden"
            style={{ minHeight: height }}
          >
            <Suspense
              fallback={
                <div
                  aria-hidden="true"
                  className="w-full animate-pulse rounded-lg bg-subtle motion-reduce:animate-none"
                  style={{ height }}
                />
              }
            >
              <UPlotChart
                xs={model.aligned.xs}
                columns={model.aligned.columns.slice(0, model.plotted)}
                labels={model.labels.slice(0, model.plotted)}
                xKind={xKind}
                height={height}
                markers={plotMarkers}
                {...(valueFormat ? { valueFormat } : {})}
                {...(yMin !== undefined ? { yMin } : {})}
              />
            </Suspense>
          </div>

          <p id={summaryId} className="text-sm text-ink-muted">
            {model.summary}
            {series.length > MAX_PLOTTED_SERIES
              ? ` Only the first ${MAX_PLOTTED_SERIES} series are drawn; all are in the data table.`
              : ""}
          </p>

          {plotMarkers.length > 0 ? (
            <ul className="text-sm text-ink-muted" aria-label="Chart markers">
              {plotMarkers.map((marker) => (
                <li key={`${marker.x}:${marker.label}`}>
                  {marker.label}: {marker.text}
                </li>
              ))}
            </ul>
          ) : null}

          <div>
            <Button
              aria-expanded={tableOpen}
              aria-controls={tableId}
              onClick={() => setTableOpen((open) => !open)}
            >
              {tableOpen ? "Hide data table" : "Show data table"}
            </Button>
          </div>
          <div id={tableId}>
            {table ? (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="min-w-full border-collapse text-sm">
                  <caption className="sr-only">{`${title}: data`}</caption>
                  <thead className="bg-subtle">
                    <tr>
                      {table.header.map((name, index) => (
                        <th
                          key={`${name}:${index}`}
                          scope="col"
                          className="px-3 py-2 text-start font-semibold"
                        >
                          {name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-t border-line">
                        {row.map((cell, cellIndex) =>
                          cellIndex === 0 ? (
                            <th
                              key={cellIndex}
                              scope="row"
                              className="px-3 py-1.5 text-start font-normal"
                            >
                              {cell}
                            </th>
                          ) : (
                            <td key={cellIndex} className="px-3 py-1.5 tabular-nums">
                              {cell}
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {table.omitted > 0 ? (
                  <p className="border-t border-line px-3 py-2 text-sm text-ink-muted">
                    Showing the latest {table.rows.length} of {table.rows.length + table.omitted}{" "}
                    rows.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </>
      )}
    </figure>
  );
}
