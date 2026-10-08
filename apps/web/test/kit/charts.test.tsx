import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type uPlot from "uplot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sparkline } from "../../src/kit/charts/Sparkline.tsx";
import { TimeSeriesChart } from "../../src/kit/charts/TimeSeriesChart.tsx";
import type { ChartSeries } from "../../src/kit/charts/series.ts";
import { expectNoA11yViolations } from "../helpers/a11y.ts";

// jsdom has no canvas, so uPlot is replaced by a recorder; what is under test is the wrapper:
// lazy loading, data conversion, rebuild-versus-update, text alternative and data table.
const fake = vi.hoisted(() => {
  interface Instance {
    opts: uPlot.Options;
    data: unknown[][];
    el: HTMLElement;
    destroyed: boolean;
    setDataCalls: unknown[][][];
    setSizeCalls: { width: number; height: number }[];
    /** The argument of every redraw() call, in order. */
    redraws: (boolean | undefined)[];
  }
  const instances: Instance[] = [];
  class FakePlot {
    instance: Instance;
    constructor(opts: uPlot.Options, data: unknown[][], el: HTMLElement) {
      this.instance = {
        opts,
        data,
        el,
        destroyed: false,
        setDataCalls: [],
        setSizeCalls: [],
        redraws: [],
      };
      instances.push(this.instance);
      el.setAttribute("data-fake-uplot", "");
    }
    setData(data: unknown[][]) {
      this.instance.setDataCalls.push(data);
      this.instance.data = data;
    }
    setSize(size: { width: number; height: number }) {
      this.instance.setSizeCalls.push(size);
    }
    redraw(rebuildPaths?: boolean) {
      this.instance.redraws.push(rebuildPaths);
    }
    destroy() {
      this.instance.destroyed = true;
    }
  }
  return { instances, FakePlot };
});

vi.mock("uplot", () => ({ default: fake.FakePlot }));

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);

function views(n = 3): ChartSeries {
  return {
    label: "Views",
    points: Array.from({ length: n }, (_, i) => ({ x: T0 + i * DAY, y: [10, 500, 120][i] ?? i })),
  };
}

function last() {
  const instance = fake.instances.at(-1);
  if (!instance) throw new Error("no chart was built");
  return instance;
}

beforeEach(() => {
  fake.instances.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TimeSeriesChart", () => {
  it("shows an empty state, and never loads the chart library, when there is no data", () => {
    render(<TimeSeriesChart title="Views" series={[]} />);
    expect(screen.getByText("No data yet")).toBeInTheDocument();
    render(
      <TimeSeriesChart
        title="CTR"
        series={[{ label: "CTR", points: [{ x: T0, y: null }] }]}
        emptyMessage="No snapshots."
      />,
    );
    expect(screen.getByText("No snapshots.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /data table/ })).toBeNull();
    expect(fake.instances).toHaveLength(0);
  });

  it("holds the space with a placeholder while the chart code loads, then builds the plot", async () => {
    const { container } = render(<TimeSeriesChart title="Views" series={[views()]} height={200} />);
    // Synchronously after render the lazy chunk has not resolved yet.
    expect(container.querySelector("[data-fake-uplot]")).toBeNull();
    expect(container.querySelector('[aria-hidden="true"].animate-pulse')).not.toBeNull();
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    expect(container.querySelector('[aria-hidden="true"].animate-pulse')).toBeNull();
    expect(last().opts.height).toBe(200);
  });

  it("gives the figure a name and a generated text alternative", async () => {
    render(<TimeSeriesChart title="Daily views" series={[views()]} />);
    const chart = screen.getByRole("img", { name: "Daily views" });
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    const description = chart.getAttribute("aria-describedby");
    expect(description).toBeTruthy();
    const summary = document.getElementById(description as string);
    expect(summary).toHaveTextContent("Views: 3 data points from");
    expect(summary).toHaveTextContent("lowest 10, highest 500, latest 120.");
    expect(chart).toHaveAccessibleDescription(/lowest 10, highest 500, latest 120/);
  });

  it("hands uPlot seconds for time axes, keeps gaps as nulls and labels the series", async () => {
    const second: ChartSeries = { label: "Impressions", points: [{ x: T0 + DAY, y: 900 }] };
    render(<TimeSeriesChart title="Reach" series={[views(), second]} />);
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    const { data, opts } = last();
    expect(data[0]).toEqual([T0 / 1000, (T0 + DAY) / 1000, (T0 + 2 * DAY) / 1000]);
    expect(data[1]).toEqual([10, 500, 120]);
    expect(data[2]).toEqual([null, 900, null]);
    expect(opts.series?.slice(1).map((s) => s.label)).toEqual(["Views", "Impressions"]);
    expect(opts.scales?.x?.time).toBe(true);
    expect(opts.legend?.show).toBe(true);
    expect(opts.series?.[1]?.spanGaps).toBe(false);
    expect(opts.series?.[1]?.width).toBe(2);
  });

  it("formats the legend values and axis ticks with the value formatter", async () => {
    render(<TimeSeriesChart title="CTR" series={[views()]} valueFormat={(v) => `${v} clicks`} />);
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    const { opts } = last();
    const formatLegend = opts.series?.[1]?.value as (u: unknown, v: number | null) => string;
    expect(formatLegend(null, 5)).toBe("5 clicks");
    expect(formatLegend(null, null)).toBe("—");
    const yAxis = opts.axes?.[1]?.values as (u: unknown, splits: number[]) => string[];
    expect(yAxis(null, [1, 2])).toEqual(["1 clicks", "2 clicks"]);
  });

  it("supports a non-time x axis (retention curve) with its own table heading", async () => {
    const retention: ChartSeries = {
      label: "Retention",
      points: [0, 25, 50, 75, 100].map((x, i) => ({ x, y: 100 - i * 20 })),
    };
    render(
      <TimeSeriesChart
        title="Audience retention"
        series={[retention]}
        xKind="linear"
        xLabel="Percent of video"
      />,
    );
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    expect(last().data[0]).toEqual([0, 25, 50, 75, 100]);
    expect(last().opts.scales?.x?.time).toBe(false);
    await userEvent.setup().click(screen.getByRole("button", { name: "Show data table" }));
    expect(screen.getByRole("columnheader", { name: "Percent of video" })).toBeInTheDocument();
  });

  it("updates the existing plot when the data changes, and rebuilds when its structure changes", async () => {
    const { rerender } = render(<TimeSeriesChart title="Views" series={[views(2)]} height={200} />);
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    const first = last();

    rerender(<TimeSeriesChart title="Views" series={[views(3)]} height={200} />);
    await waitFor(() => expect(first.setDataCalls.length).toBeGreaterThan(0));
    expect(fake.instances).toHaveLength(1);
    expect(first.destroyed).toBe(false);
    expect(first.data[0]).toHaveLength(3);

    rerender(<TimeSeriesChart title="Views" series={[views(3)]} height={320} />);
    await waitFor(() => expect(fake.instances).toHaveLength(2));
    expect(first.destroyed).toBe(true);
    expect(last().opts.height).toBe(320);
  });

  it("destroys the plot on unmount", async () => {
    const { unmount } = render(<TimeSeriesChart title="Views" series={[views()]} />);
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    unmount();
    expect(last().destroyed).toBe(true);
  });

  it("rebuilds with fresh colours when the system colour scheme changes", async () => {
    const listeners = new Set<() => void>();
    let dark = false;
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          get matches() {
            return dark;
          },
          media: query,
          addEventListener: (_: string, fn: () => void) => listeners.add(fn),
          removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
        }) as unknown as MediaQueryList,
    );
    render(<TimeSeriesChart title="Views" series={[views()]} />);
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    dark = true;
    act(() => listeners.forEach((fn) => fn()));
    await waitFor(() => expect(fake.instances).toHaveLength(2));
    expect(fake.instances[0]?.destroyed).toBe(true);
  });

  it("shows dots on sparse series (even a single snapshot) and none on dense ones", async () => {
    render(<TimeSeriesChart title="One" series={[views(1)]} />);
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    const points = last().opts.series?.[1]?.points as { show: (u: uPlot, si: number) => boolean };
    expect(points.show({ data: [[1]] } as unknown as uPlot, 1)).toBe(true);
    expect(
      points.show({ data: [Array.from({ length: 500 }, (_, i) => i)] } as unknown as uPlot, 1),
    ).toBe(false);
  });

  it("plots a large series once and caps the data table", async () => {
    const big: ChartSeries = {
      label: "Views",
      points: Array.from({ length: 10_000 }, (_, i) => ({ x: T0 + i * 3_600_000, y: i % 977 })),
    };
    render(<TimeSeriesChart title="Hourly views" series={[big]} />);
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    expect(last().data[0]).toHaveLength(10_000);
    await userEvent.setup().click(screen.getByRole("button", { name: "Show data table" }));
    const table = screen.getByRole("table", { name: "Hourly views: data" });
    expect(within(table).getAllByRole("row")).toHaveLength(201); // header + 200
    expect(screen.getByText("Showing the latest 200 of 10000 rows.")).toBeInTheDocument();
  });

  it("draws at most four series but keeps every series in the table", async () => {
    const many = Array.from({ length: 6 }, (_, i): ChartSeries => ({
      label: `S${i + 1}`,
      points: [
        { x: T0, y: i },
        { x: T0 + DAY, y: i + 1 },
      ],
    }));
    render(<TimeSeriesChart title="Many" series={many} />);
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    expect(last().opts.series?.slice(1)).toHaveLength(4);
    expect(
      screen.getByText(/Only the first 4 series are drawn; all are in the data table/),
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show data table" }));
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Date",
      "S1",
      "S2",
      "S3",
      "S4",
      "S5",
      "S6",
    ]);
  });

  it("lists markers as text and passes them to the plot", async () => {
    render(
      <TimeSeriesChart
        title="CTR"
        series={[views()]}
        markers={[
          { x: T0 + DAY, label: "Experiment started" },
          { x: "not a date", label: "Broken marker" },
        ]}
      />,
    );
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    const list = screen.getByRole("list", { name: "Chart markers" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(list).toHaveTextContent("Experiment started:");
    expect(typeof last().opts.hooks?.draw?.[0]).toBe("function");
  });

  it("repaints changed markers with redraw(false), never with the default redraw()", async () => {
    // uPlot's redraw() re-applies the x scale's *current* range; right after the plot is built that
    // range is still empty, and the default call replaces the autoscaled range with it: the chart
    // paints axes and no lines (found in a real browser, invisible to jsdom). redraw(false)
    // repaints without touching any scale.
    const { rerender } = render(
      <TimeSeriesChart title="CTR" series={[views()]} markers={[{ x: T0, label: "Start" }]} />,
    );
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    expect(last().redraws).toEqual([]); // nothing to repaint right after building the plot

    rerender(
      <TimeSeriesChart
        title="CTR"
        series={[views()]}
        markers={[
          { x: T0, label: "Start" },
          { x: T0 + DAY, label: "End" },
        ]}
      />,
    );
    await waitFor(() => expect(last().redraws.length).toBeGreaterThan(0));
    expect(last().redraws.every((argument) => argument === false)).toBe(true);
    expect(fake.instances).toHaveLength(1);
  });

  it("does not repeat work right after building the plot (no setData, no redraw on mount)", async () => {
    render(<TimeSeriesChart title="Views" series={[views()]} />);
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    expect(last().setDataCalls).toEqual([]);
    expect(last().redraws).toEqual([]);
  });

  it("offers the data as a table that can be shown and hidden, with null values as dashes", async () => {
    const user = userEvent.setup();
    const gappy: ChartSeries = {
      label: "Views",
      points: [
        { x: T0, y: 5 },
        { x: T0 + DAY, y: null },
        { x: T0 + 2 * DAY, y: 7 },
      ],
    };
    render(<TimeSeriesChart title="Gappy" series={[gappy]} />);
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    const toggle = screen.getByRole("button", { name: "Show data table" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table")).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Hide data table");
    const table = screen.getByRole("table", { name: "Gappy: data" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(
      within(rows[2] as HTMLElement)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["—"]);
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Date", "Views"]);
    expect(within(table).getAllByRole("rowheader")).toHaveLength(3);

    await user.click(toggle);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("has no accessibility violations, with the table open or closed", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TimeSeriesChart title="Views" series={[views()]} markers={[{ x: T0, label: "Start" }]} />,
    );
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "Show data table" }));
    await expectNoA11yViolations(container);
  });
});

describe("Sparkline", () => {
  it("describes the trend in text and draws a compact plot of fixed size", async () => {
    render(
      <Sparkline values={[4, 6, 9, 22]} label="Views, last 4 snapshots" width={96} height={28} />,
    );
    expect(
      screen.getByRole("img", {
        name: "Views, last 4 snapshots: 4 data points, from 4 to 22, up 450%",
      }),
    ).toBeInTheDocument();
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    const { opts, data } = last();
    expect(opts.width).toBe(96);
    expect(opts.height).toBe(28);
    expect(opts.legend?.show).toBe(false);
    expect(opts.cursor?.show).toBe(false);
    expect(opts.axes?.every((axis) => axis.show === false)).toBe(true);
    expect(data).toEqual([
      [0, 1, 2, 3],
      [4, 6, 9, 22],
    ]);
  });

  it("puts one dot on the latest value only", async () => {
    render(<Sparkline values={[4, 6, null, 22, null]} label="Views" />);
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    const points = last().opts.series?.[1]?.points as {
      show: boolean;
      filter: (u: uPlot, seriesIdx: number) => number[] | null;
    };
    expect(points.show).toBe(true);
    const plot = {
      data: [
        [0, 1, 2, 3, 4],
        [4, 6, null, 22, null],
      ],
    } as unknown as uPlot;
    expect(points.filter(plot, 1)).toEqual([3]);
    expect(points.filter({ data: [[0], [null]] } as unknown as uPlot, 1)).toBeNull();
    expect(points.filter({ data: [[0]] } as unknown as uPlot, 1)).toBeNull();
  });

  it("falls back to a dash with a text alternative when there is nothing to draw", () => {
    render(<Sparkline values={[null, null]} label="CTR" />);
    expect(screen.getByRole("img", { name: "CTR: no data" })).toHaveTextContent("—");
    expect(fake.instances).toHaveLength(0);
  });

  it("copes with a single value", async () => {
    render(<Sparkline values={[12]} label="Views" />);
    expect(screen.getByRole("img", { name: "Views: 1 data point: 12" })).toBeInTheDocument();
    await waitFor(() => expect(fake.instances).toHaveLength(1));
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} label="Views" />);
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    await expectNoA11yViolations(container);
  });
});
