import { describe, expect, it } from "vitest";
import {
  TABLE_ROW_LIMIT,
  alignSeries,
  buildTable,
  defaultFormatters,
  describeValues,
  isEmptyData,
  rangeFor,
  summarizeSeries,
  summarizeValues,
  toX,
} from "../../src/kit/charts/series.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
const fmt = defaultFormatters("time");

describe("toX", () => {
  it("converts dates, ISO strings and numbers to epoch milliseconds for time axes", () => {
    expect(toX(new Date(T0), "time")).toBe(T0);
    expect(toX("2026-09-01T00:00:00Z", "time")).toBe(T0);
    expect(toX(T0, "time")).toBe(T0);
  });

  it("rejects invalid times and keeps linear numbers", () => {
    expect(toX("not a date", "time")).toBeNull();
    expect(toX(Number.NaN, "time")).toBeNull();
    expect(toX(42, "linear")).toBe(42);
    expect(toX("12", "linear")).toBe(12);
    expect(toX(Number.POSITIVE_INFINITY, "linear")).toBeNull();
  });
});

describe("alignSeries", () => {
  it("puts series on the union of their x values, with nulls where one has no point", () => {
    const aligned = alignSeries(
      [
        {
          label: "A",
          points: [
            { x: T0, y: 1 },
            { x: T0 + 2 * DAY, y: 3 },
          ],
        },
        {
          label: "B",
          points: [
            { x: T0 + DAY, y: 20 },
            { x: T0 + 2 * DAY, y: 30 },
          ],
        },
      ],
      "time",
    );
    expect(aligned.xs).toEqual([T0, T0 + DAY, T0 + 2 * DAY]);
    expect(aligned.columns).toEqual([
      [1, null, 3],
      [null, 20, 30],
    ]);
  });

  it("sorts, de-duplicates (last wins) and drops invalid points but keeps explicit gaps", () => {
    const aligned = alignSeries(
      [
        {
          label: "A",
          points: [
            { x: T0 + DAY, y: 2 },
            { x: T0, y: 1 },
            { x: T0, y: 9 },
            { x: "garbage", y: 5 },
            { x: T0 + 3 * DAY, y: Number.NaN },
            { x: T0 + 2 * DAY, y: null },
          ],
        },
      ],
      "time",
    );
    expect(aligned.xs).toEqual([T0, T0 + DAY, T0 + 2 * DAY]);
    expect(aligned.columns).toEqual([[9, 2, null]]);
  });

  it("handles empty input", () => {
    expect(alignSeries([], "time")).toEqual({ xs: [], columns: [] });
    expect(isEmptyData(alignSeries([{ label: "A", points: [] }], "time"))).toBe(true);
    expect(isEmptyData(alignSeries([{ label: "A", points: [{ x: T0, y: null }] }], "time"))).toBe(
      true,
    );
    expect(isEmptyData(alignSeries([{ label: "A", points: [{ x: T0, y: 0 }] }], "time"))).toBe(
      false,
    );
  });

  it("scales to large series", () => {
    const points = Array.from({ length: 50_000 }, (_, i) => ({ x: T0 + i * 60_000, y: i }));
    const aligned = alignSeries([{ label: "A", points }], "time");
    expect(aligned.xs).toHaveLength(50_000);
    expect(aligned.columns[0]?.at(-1)).toBe(49_999);
  });
});

describe("summarizeSeries", () => {
  it("describes range, lowest, highest and latest per series", () => {
    const aligned = alignSeries(
      [
        {
          label: "Views",
          points: [
            { x: T0, y: 10 },
            { x: T0 + DAY, y: 500 },
            { x: T0 + 2 * DAY, y: 120 },
          ],
        },
      ],
      "time",
    );
    const text = summarizeSeries(["Views"], aligned, fmt);
    expect(text).toContain("Views: 3 data points from");
    expect(text).toContain("lowest 10, highest 500, latest 120.");
  });

  it("handles a single point and an empty series", () => {
    const aligned = alignSeries(
      [
        { label: "One", points: [{ x: T0, y: 7 }] },
        { label: "None", points: [] },
      ],
      "time",
    );
    const text = summarizeSeries(["One", "None"], aligned, fmt);
    expect(text).toContain("One: 1 data point on");
    expect(text).toContain(": 7.");
    expect(text).toContain("None: no data.");
  });

  it("uses the value formatter", () => {
    const aligned = alignSeries(
      [
        {
          label: "CTR",
          points: [
            { x: 1, y: 0.052 },
            { x: 2, y: 0.061 },
          ],
        },
      ],
      "linear",
    );
    const text = summarizeSeries(
      ["CTR"],
      aligned,
      defaultFormatters("linear", (v) => `${(v * 100).toFixed(1)}%`),
    );
    expect(text).toContain("lowest 5.2%, highest 6.1%, latest 6.1%.");
  });
});

describe("buildTable", () => {
  const aligned = alignSeries(
    [
      {
        label: "A",
        points: [
          { x: T0, y: 1 },
          { x: T0 + DAY, y: 2 },
        ],
      },
      { label: "B", points: [{ x: T0 + DAY, y: 20 }] },
    ],
    "time",
  );

  it("has the x column, one column per series and a dash for missing values", () => {
    const table = buildTable("Date", ["A", "B"], aligned, fmt);
    expect(table.header).toEqual(["Date", "A", "B"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]?.slice(1)).toEqual(["1", "—"]);
    expect(table.rows[1]?.slice(1)).toEqual(["2", "20"]);
    expect(table.omitted).toBe(0);
  });

  it("keeps only the latest rows of a long series and says how many were left out", () => {
    const points = Array.from({ length: TABLE_ROW_LIMIT + 50 }, (_, i) => ({ x: i, y: i }));
    const long = alignSeries([{ label: "A", points }], "linear");
    const table = buildTable("x", ["A"], long, defaultFormatters("linear"));
    expect(table.rows).toHaveLength(TABLE_ROW_LIMIT);
    expect(table.omitted).toBe(50);
    expect(table.rows.at(-1)?.[1]).toBe(String(TABLE_ROW_LIMIT + 49));
  });
});

describe("sparkline text", () => {
  it("summarises values", () => {
    expect(summarizeValues([null, 4, 9, null, 22])).toEqual({
      count: 3,
      first: 4,
      last: 22,
      low: 4,
      high: 22,
      changePercent: 450,
    });
    expect(summarizeValues([]).count).toBe(0);
    expect(summarizeValues([0, 5]).changePercent).toBeNull();
  });

  it.each([
    [[], "no data"],
    [[null, null], "no data"],
    [[7], "1 data point: 7"],
    [[4, 6, 22], "3 data points, from 4 to 22, up 450%"],
    [[20, 10], "2 data points, from 20 to 10, down 50%"],
    [[10, 10.01], "2 data points, from 10 to 10.01, unchanged"],
    [[0, 5], "2 data points, from 0 to 5"],
  ])("describes %j as %s", (values, expected) => {
    expect(describeValues(values)).toBe(expected);
  });
});

describe("rangeFor", () => {
  it("adds headroom and pins the bottom when asked", () => {
    const [lo, hi] = rangeFor(10, 110, undefined);
    expect(lo).toBeLessThan(10);
    expect(hi).toBeGreaterThan(110);
    const [pinned, top] = rangeFor(10, 110, 0);
    expect(pinned).toBe(0);
    expect(top).toBeGreaterThan(110);
  });

  it("gives a flat series a visible band and survives missing bounds", () => {
    const [lo, hi] = rangeFor(5, 5, undefined);
    expect(hi - lo).toBeGreaterThan(0);
    const [zlo, zhi] = rangeFor(0, 0, undefined);
    expect(zhi - zlo).toBeGreaterThan(0);
    const [nlo, nhi] = rangeFor(null, null, undefined);
    expect(nhi).toBeGreaterThan(nlo);
  });
});
