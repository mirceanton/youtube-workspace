import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import "@/styles/chart.css";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { formatDateTime, formatNumber } from "@/lib/format.ts";
import { rangeFor, type XKind } from "./series.ts";

// The only module that imports uPlot. It is loaded with React.lazy by TimeSeriesChart and
// Sparkline, so neither uPlot (~50 kB) nor its CSS is part of the initial bundle.

export interface PlotMarker {
  /** Same unit as `xs`. */
  x: number;
  label: string;
}

export interface UPlotChartProps {
  /** x values: epoch milliseconds for `xKind: "time"`, plain numbers for "linear". */
  xs: readonly number[];
  columns: readonly (readonly (number | null)[])[];
  labels: readonly string[];
  xKind: XKind;
  height: number;
  /** Fixed width in px (sparklines); omitted, the chart fills its container and follows resizes. */
  width?: number;
  /** Sparkline mode: no axes, legend, grid or cursor. */
  compact?: boolean;
  markers?: readonly PlotMarker[];
  valueFormat?: (value: number) => string;
  /** Force the lower end of the y axis (e.g. 0 for counts). */
  yMin?: number;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";
const SERIES_VARS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4"] as const;
// Used only when the design tokens are not loaded (the same values as styles/tokens.css).
const FALLBACKS = {
  light: { ink: "#56554f", grid: "#e1e0d9", surface: "#ffffff", series: "#2a78d6" },
  dark: { ink: "#b9b8b0", grid: "#2c2c2a", surface: "#1b1b19", series: "#3987e5" },
} as const;

function subscribeDark(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

/** Canvas colours cannot use CSS variables, so the chart is rebuilt when the system scheme flips. */
function useDarkMode(): boolean {
  return useSyncExternalStore(subscribeDark, isDark, () => false);
}

interface Colors {
  series: string[];
  ink: string;
  grid: string;
  surface: string;
}

function readColors(count: number, dark: boolean): Colors {
  const style = getComputedStyle(document.documentElement);
  const fallback = FALLBACKS[dark ? "dark" : "light"];
  const read = (name: string, otherwise: string) =>
    style.getPropertyValue(name).trim() || otherwise;
  return {
    series: Array.from({ length: count }, (_, i) =>
      read(SERIES_VARS[i % SERIES_VARS.length] ?? "--chart-1", fallback.series),
    ),
    ink: read("--ink-muted", fallback.ink),
    grid: read("--chart-grid", fallback.grid),
    surface: read("--surface", fallback.surface),
  };
}

const dpr = () => window.devicePixelRatio || 1;

function toPlotData(
  xs: readonly number[],
  columns: readonly (readonly (number | null)[])[],
  xKind: XKind,
): uPlot.AlignedData {
  const scale = xKind === "time" ? 1 / 1000 : 1;
  return [xs.map((x) => x * scale), ...columns.map((column) => [...column])];
}

/** Points.filter for sparklines: only the index of the last non-null value gets a dot. */
function lastValueIndex(u: uPlot, seriesIdx: number): number[] | null {
  const ys = u.data[seriesIdx];
  if (!ys) return null;
  for (let index = ys.length - 1; index >= 0; index--) {
    if (ys[index] != null) return [index];
  }
  return null;
}

interface Live {
  markers: readonly PlotMarker[];
  valueFormat: (value: number) => string;
}

interface BuildParams {
  names: string[];
  xKind: XKind;
  height: number;
  width: number;
  compact: boolean;
  yMin: number | undefined;
  dark: boolean;
  /** Read at draw/format time so markers and formatters can change without rebuilding the plot. */
  live: RefObject<Live>;
}

function buildOptions(params: BuildParams): uPlot.Options {
  const { names, xKind, height, width, compact, yMin, dark, live } = params;
  const colors = readColors(names.length, dark);
  const format = (v: number) => live.current.valueFormat(v);
  const formatX = (v: number) => (xKind === "time" ? formatDateTime(v * 1000) : formatNumber(v));
  const font = "12px system-ui, sans-serif";

  const drawMarkers = (u: uPlot) => {
    const marks = live.current.markers;
    if (marks.length === 0) return;
    const scale = xKind === "time" ? 1 / 1000 : 1;
    const { ctx, bbox } = u;
    ctx.save();
    ctx.strokeStyle = colors.ink;
    ctx.fillStyle = colors.ink;
    ctx.lineWidth = dpr();
    ctx.font = `${12 * dpr()}px system-ui, sans-serif`;
    ctx.textBaseline = "top";
    for (const marker of marks) {
      const x = Math.round(u.valToPos(marker.x * scale, "x", true));
      if (x < bbox.left || x > bbox.left + bbox.width) continue;
      ctx.beginPath();
      ctx.moveTo(x, bbox.top);
      ctx.lineTo(x, bbox.top + bbox.height);
      ctx.stroke();
      ctx.fillText(marker.label, x + 4 * dpr(), bbox.top + 2 * dpr());
    }
    ctx.restore();
  };

  const axisBase = {
    stroke: colors.ink,
    font,
    grid: { stroke: colors.grid, width: 1 },
    ticks: { stroke: colors.grid, width: 1 },
  };

  return {
    width,
    height,
    // Room for the 8 px end dot of a sparkline so the canvas edge does not clip it.
    padding: compact ? [6, 6, 6, 6] : [8, 8, 0, 0],
    legend: { show: !compact, live: true },
    cursor: compact ? { show: false } : { points: { size: 8 }, drag: { x: false, y: false } },
    select: { show: false, left: 0, top: 0, width: 0, height: 0 },
    scales: {
      x: { time: xKind === "time" },
      y: { range: (_u, min, max) => rangeFor(min, max, yMin) },
    },
    axes: compact
      ? [{ show: false }, { show: false }]
      : [
          // Time axes keep uPlot's own date formatting. An explicit `values: undefined` would
          // override it and leave the axis without labels, so the key is only set for linear x.
          xKind === "time"
            ? { ...axisBase }
            : { ...axisBase, values: (_u, splits) => splits.map((v) => formatNumber(v)) },
          { ...axisBase, size: 64, values: (_u, splits) => splits.map((v) => format(v)) },
        ],
    series: [
      {
        label: xKind === "time" ? "Date" : "Position",
        value: (_u, v) => (v == null ? "—" : formatX(v)),
      },
      ...names.map((label, i): uPlot.Series => ({
        label,
        stroke: colors.series[i] ?? FALLBACKS.light.series,
        width: 2,
        spanGaps: false,
        points: {
          // Charts: a dot per point while there are few (a single snapshot must be visible), none
          // on dense series. Sparklines: one end dot on the latest value.
          show: compact ? true : (u) => (u.data[0]?.length ?? 0) <= 60,
          ...(compact ? { filter: lastValueIndex } : {}),
          size: 8,
          width: 2,
          fill: colors.series[i] ?? FALLBACKS.light.series,
          stroke: colors.surface,
        },
        value: (_u, v) => (v == null ? "—" : format(v)),
      })),
    ],
    hooks: { draw: [drawMarkers] },
  };
}

const NO_MARKERS: readonly PlotMarker[] = [];

export default function UPlotChart(props: UPlotChartProps) {
  const { xs, columns, labels, xKind, height, width, compact = false, yMin, markers } = props;
  const containerRef = useRef<HTMLSpanElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const dark = useDarkMode();
  const labelsKey = labels.join("\u0000");

  const live = useRef<Live>({
    markers: markers ?? NO_MARKERS,
    valueFormat: props.valueFormat ?? formatNumber,
  });
  const latestData = useRef({ xs, columns });
  // What the plot currently shows, so an effect pass right after (re)building it does not repeat the work.
  const drawn = useRef<{ xs: typeof xs; columns: typeof columns; xKind: XKind } | null>(null);
  useLayoutEffect(() => {
    live.current.valueFormat = props.valueFormat ?? formatNumber;
    latestData.current = { xs, columns };
  });

  // Build the plot when its structure changes (series, size, kind, colour scheme).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const options = buildOptions({
      names: labelsKey === "" ? [] : labelsKey.split("\u0000"),
      xKind,
      height,
      width: width ?? (el.clientWidth || 320),
      compact,
      yMin,
      dark,
      live,
    });
    const { xs: x0, columns: c0 } = latestData.current;
    const plot = new uPlot(options, toPlotData(x0, c0, xKind), el);
    plotRef.current = plot;
    drawn.current = { xs: x0, columns: c0, xKind };

    let observer: ResizeObserver | undefined;
    if (width === undefined && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        if (el.clientWidth > 0) plot.setSize({ width: el.clientWidth, height });
      });
      observer.observe(el);
    }
    return () => {
      observer?.disconnect();
      plot.destroy();
      plotRef.current = null;
      drawn.current = null;
    };
  }, [labelsKey, xKind, height, width, compact, yMin, dark]);

  // New data (the 12 s refresh) updates the existing plot instead of rebuilding it.
  useEffect(() => {
    const shown = drawn.current;
    if (
      !plotRef.current ||
      (shown && shown.xs === xs && shown.columns === columns && shown.xKind === xKind)
    ) {
      return;
    }
    plotRef.current.setData(toPlotData(xs, columns, xKind));
    drawn.current = { xs, columns, xKind };
  }, [xs, columns, xKind]);

  // Markers are drawn from `live` in the draw hook, so a change only needs a repaint. Never call
  // `redraw()` with its default here: it re-applies the x scale's *current* range, and before the
  // plot's first paint that range is still empty, which would wipe the autoscaled one (an empty
  // chart). `redraw(false)` repaints without touching any scale.
  useEffect(() => {
    const next = markers ?? NO_MARKERS;
    if (live.current.markers === next) return;
    live.current.markers = next;
    plotRef.current?.redraw(false);
  }, [markers]);

  // A span, so a sparkline can sit inside a paragraph; uPlot builds its own elements inside it.
  return <span ref={containerRef} className="block w-full" />;
}
