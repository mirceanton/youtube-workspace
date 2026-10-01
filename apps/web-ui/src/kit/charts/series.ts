import { formatDate, formatNumber, toDate } from "@/lib/format.ts";

// Pure data helpers behind TimeSeriesChart and Sparkline: normalising points, aligning several
// series on one x axis, and writing the text alternative. No React, no uPlot.

/** An x value: a Date, an ISO string or epoch milliseconds for time charts; a number for linear ones. */
export type ChartX = number | Date | string;

export interface ChartPoint {
  x: ChartX;
  /** `null` leaves a gap (a missing snapshot) instead of drawing a line through it. */
  y: number | null;
}

export interface ChartSeries {
  label: string;
  points: readonly ChartPoint[];
}

/** A labelled vertical line, e.g. "Experiment started". */
export interface ChartMarker {
  x: ChartX;
  label: string;
}

/** `time`: x is a moment (axis shows dates). `linear`: x is a plain number (e.g. percent of a video). */
export type XKind = "time" | "linear";

/** Most series drawn at once: the four validated colours of the data-viz palette. */
export const MAX_PLOTTED_SERIES = 4;

/** The data table shows at most this many rows (the latest ones); the chart itself plots everything. */
export const TABLE_ROW_LIMIT = 200;

/** x as a number: epoch milliseconds for time charts, the number itself for linear ones. Null if invalid. */
export function toX(x: ChartX, kind: XKind): number | null {
  if (kind === "linear") {
    const value = typeof x === "number" ? x : x instanceof Date ? x.getTime() : Number(x);
    return Number.isFinite(value) ? value : null;
  }
  const date = toDate(x);
  return date ? date.getTime() : null;
}

export interface AlignedSeries {
  /** Sorted, de-duplicated x values (epoch ms for time charts). */
  xs: number[];
  /** One column per series, each as long as `xs`, `null` where the series has no point. */
  columns: (number | null)[][];
}

/**
 * Puts every series on the union of their x values. Points with an invalid x or a non-finite y are
 * dropped (a `null` y is kept as a gap); when a series repeats an x, the last point wins.
 */
export function alignSeries(series: readonly ChartSeries[], kind: XKind): AlignedSeries {
  const perSeries = series.map((s) => {
    const byX = new Map<number, number | null>();
    for (const point of s.points) {
      const x = toX(point.x, kind);
      if (x === null) continue;
      if (point.y !== null && !Number.isFinite(point.y)) continue;
      byX.set(x, point.y);
    }
    return byX;
  });
  const xs = [...new Set(perSeries.flatMap((byX) => [...byX.keys()]))].toSorted((a, b) => a - b);
  const columns = perSeries.map((byX) => xs.map((x) => byX.get(x) ?? null));
  return { xs, columns };
}

/** True when no series has a single numeric value. */
export function isEmptyData(aligned: AlignedSeries): boolean {
  return aligned.columns.every((column) => column.every((value) => value === null));
}

export interface Formatters {
  formatX: (x: number) => string;
  formatY: (y: number) => string;
}

export function defaultFormatters(kind: XKind, valueFormat?: (n: number) => string): Formatters {
  return {
    formatX: kind === "time" ? (x) => formatDate(x) : (x) => formatNumber(x),
    formatY: valueFormat ?? formatNumber,
  };
}

/** One sentence per series: how many points, over what range, lowest, highest, latest. */
export function summarizeSeries(
  labels: readonly string[],
  aligned: AlignedSeries,
  { formatX, formatY }: Formatters,
): string {
  return labels
    .map((label, index) => {
      const column = aligned.columns[index] ?? [];
      const present: { x: number; y: number }[] = [];
      column.forEach((y, row) => {
        const x = aligned.xs[row];
        if (y !== null && x !== undefined) present.push({ x, y });
      });
      const first = present[0];
      const last = present.at(-1);
      if (!first || !last) return `${label}: no data.`;
      const values = present.map((p) => p.y);
      const low = Math.min(...values);
      const high = Math.max(...values);
      if (present.length === 1) {
        return `${label}: 1 data point on ${formatX(first.x)}: ${formatY(first.y)}.`;
      }
      return (
        `${label}: ${present.length} data points from ${formatX(first.x)} to ${formatX(last.x)}; ` +
        `lowest ${formatY(low)}, highest ${formatY(high)}, latest ${formatY(last.y)}.`
      );
    })
    .join(" ");
}

export interface TableModel {
  header: string[];
  rows: string[][];
  /** Rows that exist beyond the shown ones (the oldest are left out). */
  omitted: number;
}

/** The data-table fallback: x plus one column per series, newest rows kept when it is long. */
export function buildTable(
  xLabel: string,
  labels: readonly string[],
  aligned: AlignedSeries,
  { formatX, formatY }: Formatters,
): TableModel {
  const total = aligned.xs.length;
  const start = Math.max(0, total - TABLE_ROW_LIMIT);
  const rows: string[][] = [];
  for (let row = start; row < total; row++) {
    const x = aligned.xs[row];
    if (x === undefined) continue;
    rows.push([
      formatX(x),
      ...aligned.columns.map((column) => {
        const value = column[row];
        return value === null || value === undefined ? "—" : formatY(value);
      }),
    ]);
  }
  return { header: [xLabel, ...labels], rows, omitted: start };
}

export interface SparklineSummary {
  count: number;
  first: number | null;
  last: number | null;
  low: number | null;
  high: number | null;
  /** Relative change from first to last in percent; null when the first value is 0 or there is one point. */
  changePercent: number | null;
}

export function summarizeValues(values: readonly (number | null)[]): SparklineSummary {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const first = present[0] ?? null;
  const last = present.at(-1) ?? null;
  const changePercent =
    first !== null && last !== null && present.length > 1 && first !== 0
      ? ((last - first) / Math.abs(first)) * 100
      : null;
  return {
    count: present.length,
    first,
    last,
    low: present.length ? Math.min(...present) : null,
    high: present.length ? Math.max(...present) : null,
    changePercent,
  };
}

/** The sparkline's text alternative, e.g. "12 data points, from 100 to 480, up 380%". */
export function describeValues(
  values: readonly (number | null)[],
  formatY: (n: number) => string = formatNumber,
): string {
  const s = summarizeValues(values);
  if (s.count === 0 || s.first === null || s.last === null) return "no data";
  if (s.count === 1) return `1 data point: ${formatY(s.last)}`;
  const trend =
    s.changePercent === null
      ? ""
      : Math.abs(s.changePercent) < 0.5
        ? ", unchanged"
        : `, ${s.changePercent > 0 ? "up" : "down"} ${formatNumber(Math.round(Math.abs(s.changePercent)))}%`;
  return `${s.count} data points, from ${formatY(s.first)} to ${formatY(s.last)}${trend}`;
}

/** y range with a little headroom; `yMin` pins the bottom. A flat series gets a visible band. */
export function rangeFor(
  min: number | null,
  max: number | null,
  yMin: number | undefined,
): [number, number] {
  let lo = yMin ?? min ?? 0;
  let hi = max ?? lo + 1;
  if (hi === lo) hi = lo + (lo === 0 ? 1 : Math.abs(lo) * 0.1);
  const pad = (hi - lo) * 0.08;
  hi += pad;
  if (yMin === undefined) lo -= pad;
  return [lo, hi];
}
