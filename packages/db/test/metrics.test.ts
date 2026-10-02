// The metric function (migration 0042, T13): log_metrics, i.e. the append-only snapshots of PRD 4
// with their idempotency on (video_id, captured_at): the same call twice is one snapshot, different
// numbers for an existing key are refused with both sets shown, and every range is validated before
// the CHECK constraints could produce a bare 23514.
//
// Real database, typed wrappers, application roles. The races are real too: concurrent transactions
// on separate connections, and a copy of the function without its row lock to prove the unique key
// and ON CONFLICT hold on their own.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, withActor } from "../src/client.js";
import {
  DuplicateError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
} from "../src/errors.js";
import {
  listMetricSnapshots,
  logMetrics,
  type LogMetricsResult,
  type MetricValues,
  type RetentionPoint,
} from "../src/metrics.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { archiveVideo } from "../src/videos.js";
import {
  act,
  alice,
  eventCount,
  eventsFor,
  expectedNullOutcomes,
  functionPrivileges,
  newAgent,
  nullArgumentOutcomes,
  outcomeKind,
  partition,
  seededRandom,
  settle,
  waitForLockWait,
  withoutRowLock,
  type FunctionSpec,
} from "./content-helpers.js";
import { sqlstate } from "./helpers.js";
import { newVideo, rejectedWith } from "./video-helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

/** An instant `hours` ago, whole seconds, as ISO text (tests must not depend on today's date). */
const ago = (hours: number): string =>
  new Date(Math.floor(Date.now() / 1000) * 1000 - hours * 3_600_000).toISOString();

const FULL: MetricValues = {
  views: 12_345,
  impressions: 250_000,
  ctr: 4.94,
  avgViewDurationS: 312.5,
  avgViewPct: 43.7,
  watchTimeMin: 64_000.25,
  subsGained: -3,
  retention: [
    { t: 0, pct: 100 },
    { t: 30, pct: 71.5 },
    { t: 60, pct: 48.25 },
  ],
};

function log(
  videoId: string,
  capturedAt: string | Date,
  metrics: MetricValues,
  actor = alice,
): Promise<LogMetricsResult> {
  return act(db, actor, (tx) => logMetrics(tx, { videoId, capturedAt, metrics }));
}

/** Calls log_metrics with raw JSON text for `metrics` (what an MCP tool sends), bypassing the wrapper. */
function rawLog(videoId: string | null, capturedAt: string | null, metricsJson: string | null) {
  return db
    .pool("ytw_mcp")
    .query(
      sql`SELECT * FROM log_metrics('bot', 'agent', NULL, ${videoId}::uuid, ${capturedAt}::timestamptz, ${metricsJson}::jsonb)`,
    );
}

async function snapshotCount(videoId: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM video_metrics WHERE video_id = $1",
    [videoId],
  );
  return rows[0]?.n ?? 0;
}

/** A snapshot of `metrics` is refused with a validation error for `field` that contains `words`. */
async function expectRefused(metrics: unknown, field: string, words: string) {
  const video = await newVideo(db);
  const err = await rejectedWith(
    rawLog(video.id, ago(60), JSON.stringify(metrics)),
    ValidationError,
  );
  expect(err.field).toBe(field);
  expect(err.message).toContain(words);
  expect(err.message.length).toBeLessThan(500);
  expect(await snapshotCount(video.id)).toBe(0);
}

/** An instant `hours` ahead, as ISO text. */
const hoursAhead = (hours: number): string =>
  new Date(Date.now() + hours * 3_600_000).toISOString();

/** A retention curve of `n` points, 10 seconds apart, falling from 100 %. */
const curve = (n: number): RetentionPoint[] =>
  Array.from({ length: n }, (_, i) => ({ t: i * 10, pct: Math.max(0, 100 - i / 10) }));

// ---------------------------------------------------------------------------------------------

describe("log_metrics: appending a snapshot", () => {
  it("stores every metric, returns the snapshot with created = true, and writes one audit row", async () => {
    const video = await newVideo(db);
    const capturedAt = ago(2);
    const agent = newAgent("analytics bot");
    const { snapshot, created } = await log(video.id, capturedAt, FULL, agent);
    expect(created).toBe(true);
    expect(snapshot).toEqual({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      videoId: video.id,
      capturedAt: new Date(capturedAt),
      views: "12345",
      impressions: "250000",
      ctr: "4.94",
      avgViewDurationS: "312.5",
      avgViewPct: "43.7",
      watchTimeMin: "64000.25",
      subsGained: -3,
      retention: FULL.retention,
      createdAt: expect.any(Date),
      createdBy: "analytics bot",
    });
    expect(await listMetricSnapshots(db.admin, { videoId: video.id })).toEqual([snapshot]);
    const trail = await eventsFor(db, snapshot.id);
    expect(trail).toEqual([
      {
        actor: "analytics bot",
        actor_type: "agent",
        token_id: agent.tokenId,
        action: "insert",
        entity_type: "video_metric",
        entity_id: snapshot.id,
        payload: {
          new: expect.objectContaining({
            video_id: video.id,
            views: 12345,
            ctr: 4.94,
            subs_gained: -3,
            created_by: "analytics bot",
          }),
        },
      },
    ]);
  });

  it("needs only one metric; null and omitted both mean not measured", async () => {
    const video = await newVideo(db);
    const { snapshot } = await log(video.id, ago(3), { views: 5, ctr: null, retention: null });
    expect(snapshot).toMatchObject({
      views: "5",
      impressions: null,
      ctr: null,
      avgViewDurationS: null,
      avgViewPct: null,
      watchTimeMin: null,
      subsGained: null,
      retention: null,
    });
    for (const metrics of [
      { impressions: 0 },
      { ctr: 0 },
      { ctr: 100 },
      { avgViewDurationS: 0 },
      { subsGained: 0 },
      { retention: [{ t: 0, pct: 0 }] },
    ] satisfies MetricValues[]) {
      expect((await log(video.id, ago(4 + Math.random()), metrics)).created).toBe(true);
    }
  });

  it("keeps exact values: strings carry what a double cannot, and come back as the same digits", async () => {
    const video = await newVideo(db);
    const { snapshot } = await log(video.id, ago(5), {
      views: "9007199254740993",
      impressions: 9223372036854775807n,
      ctr: "33.333333333333333333",
      avgViewDurationS: 43.65700483091788,
      watchTimeMin: "1000000000000000",
    });
    expect(snapshot).toMatchObject({
      views: "9007199254740993",
      impressions: "9223372036854775807",
      ctr: "33.333333333333333333",
      avgViewDurationS: "43.65700483091788",
      watchTimeMin: "1000000000000000",
    });
  });

  it("accepts an average percentage viewed above 100 (viewers rewatch), unlike a click-through rate", async () => {
    const video = await newVideo(db);
    expect((await log(video.id, ago(6), { avgViewPct: 150.5 })).snapshot.avgViewPct).toBe("150.5");
    const err = await rejectedWith(log(video.id, ago(7), { ctr: 100.01 }), ValidationError);
    expect(err.field).toBe("metrics.ctr");
  });

  it("keeps a separate line of snapshots per video, newest first", async () => {
    const [one, two] = [await newVideo(db), await newVideo(db)];
    const t1 = ago(30);
    const t2 = ago(20);
    await log(one.id, t2, { views: 20 });
    await log(one.id, t1, { views: 10 });
    await log(two.id, t1, { views: 99 });
    expect((await listMetricSnapshots(db.admin, { videoId: one.id })).map((s) => s.views)).toEqual([
      "20",
      "10",
    ]);
    expect((await listMetricSnapshots(db.admin, { videoId: two.id })).map((s) => s.views)).toEqual([
      "99",
    ]);
    expect(
      (await listMetricSnapshots(db.admin, { videoId: one.id, limit: 1 })).map((s) => s.views),
    ).toEqual(["20"]);
    const bad = await rejectedWith(
      listMetricSnapshots(db.admin, { videoId: one.id, limit: 0 }),
      ValidationError,
    );
    expect(bad.field).toBe("limit");
  });

  it("treats two instants a microsecond apart as two snapshots", async () => {
    const video = await newVideo(db);
    const base = ago(8).replace(".000Z", "");
    const first = await rawLog(video.id, `${base}.000001Z`, '{"views": 1}');
    const second = await rawLog(video.id, `${base}.000002Z`, '{"views": 2}');
    expect(first.rows[0]).toMatchObject({ created: true });
    expect(second.rows[0]).toMatchObject({ created: true });
    expect(await snapshotCount(video.id)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------

describe("log_metrics: idempotency on (video_id, captured_at)", () => {
  it("returns the stored snapshot with created = false when the same call is repeated, and writes nothing", async () => {
    const video = await newVideo(db);
    const capturedAt = ago(10);
    const first = await log(video.id, capturedAt, FULL);
    const events = await eventCount(db, first.snapshot.id);
    const again = await log(video.id, capturedAt, FULL);
    expect(again).toEqual({ snapshot: first.snapshot, created: false });
    expect(await snapshotCount(video.id)).toBe(1);
    expect(await eventCount(db, first.snapshot.id)).toBe(events);
  });

  it("answers a repeat from another actor the same way, and keeps the first writer", async () => {
    const video = await newVideo(db);
    const capturedAt = ago(11);
    const first = await log(video.id, capturedAt, { views: 7 }, newAgent("first bot"));
    const again = await log(video.id, capturedAt, { views: 7 }, newAgent("second bot"));
    expect(again.created).toBe(false);
    expect(again.snapshot.id).toBe(first.snapshot.id);
    expect(again.snapshot.createdBy).toBe("first bot");
    expect(await eventCount(db, first.snapshot.id)).toBe(1);
  });

  it('compares numbers by value: 4.5 equals 4.50 and "4.50", 1000 equals "1000", the same instant in another zone', async () => {
    const video = await newVideo(db);
    const first = await log(video.id, "2026-09-30T10:00:00Z", {
      views: 1000,
      ctr: 4.5,
      retention: [
        { t: 0, pct: 100 },
        { t: 30, pct: 71.5 },
      ],
    });
    const spellings: MetricValues[] = [
      { views: "1000", ctr: "4.50", retention: first.snapshot.retention },
      {
        views: "1000.0",
        ctr: 4.5,
        retention: [
          { pct: 100.0, t: 0 },
          { pct: 71.5, t: 30.0 },
        ],
      },
      { views: 1000, ctr: "4.500", retention: first.snapshot.retention },
    ];
    for (const metrics of spellings) {
      const again = await act(db, alice, (tx) =>
        logMetrics(tx, { videoId: video.id, capturedAt: "2026-09-30T12:00:00+02:00", metrics }),
      );
      expect(again.created).toBe(false);
      expect(again.snapshot.id).toBe(first.snapshot.id);
    }
    expect(await snapshotCount(video.id)).toBe(1);
  });

  it("treats a metric set to null like one that is absent", async () => {
    const video = await newVideo(db);
    const capturedAt = ago(12);
    await log(video.id, capturedAt, { views: 3 });
    expect(
      (await log(video.id, capturedAt, { views: 3, ctr: null, retention: null })).created,
    ).toBe(false);
  });

  it("still answers a repeat after the video was archived, but accepts no new snapshot", async () => {
    const video = await newVideo(db);
    const capturedAt = ago(13);
    const first = await log(video.id, capturedAt, { views: 8 });
    await act(db, alice, (tx) => archiveVideo(tx, { id: video.id }));
    expect(await log(video.id, capturedAt, { views: 8 })).toEqual({
      snapshot: first.snapshot,
      created: false,
    });
    const err = await rejectedWith(log(video.id, ago(14), { views: 9 }), InvalidTransitionError);
    expect(err.details).toMatchObject({ entity: "video", id: video.id, reason: "archived" });
    expect(err.message).toBe(
      `video ${video.id} is archived and cannot be given new metric snapshots`,
    );
    expect(await snapshotCount(video.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("log_metrics: a different payload for an existing key", () => {
  it("is refused with an error that shows both sets of numbers and what to do", async () => {
    const video = await newVideo(db);
    const capturedAt = "2026-09-29T08:30:00Z";
    const stored = await log(video.id, capturedAt, { views: 1000, ctr: 5, retention: curve(3) });
    const events = await eventCount(db, stored.snapshot.id);
    const err = await rejectedWith(
      log(video.id, capturedAt, { views: 1200, ctr: 5, impressions: 40_000 }, newAgent()),
      DuplicateError,
    );
    expect(err.existingId).toBe(stored.snapshot.id);
    expect(err.status).toBe(422);
    expect(err.message).toBe(
      `video ${video.id} already has a snapshot captured at 2026-09-29T08:30:00Z with different numbers, so nothing was saved (stored: views=1000, ctr=5, retention=3 points; submitted: views=1200, impressions=40000, ctr=5): a snapshot never changes; log the new numbers with a later captured_at, or resend exactly the stored numbers to repeat the earlier call`,
    );
    expect(err.details).toMatchObject({
      entity: "video_metric",
      video_id: video.id,
      captured_at: capturedAt,
      stored: { views: 1000, ctr: 5, retention: { points: 3 } },
      submitted: { views: 1200, impressions: 40000, ctr: 5 },
      differing: ["views", "impressions", "retention"],
    });
    expect(err.hint).toBe("To correct numbers, log a snapshot with a different captured_at.");
    expect(await snapshotCount(video.id)).toBe(1);
    expect(await eventCount(db, stored.snapshot.id)).toBe(events);
    expect((await listMetricSnapshots(db.admin, { videoId: video.id }))[0]).toEqual(
      stored.snapshot,
    );
  });

  it.each([
    ["one number changed", { views: 1 }, { views: 2 }],
    ["a number added", { views: 1 }, { views: 1, ctr: 1 }],
    ["a number left out", { views: 1, ctr: 1 }, { views: 1 }],
    ["a number cleared with null", { views: 1, ctr: 1 }, { views: 1, ctr: null }],
    ["a different decimal", { ctr: 4.5 }, { ctr: 4.51 }],
    [
      "a different retention curve",
      { views: 1, retention: curve(3) },
      { views: 1, retention: curve(4) },
    ],
    [
      "a retention curve with one different value",
      { retention: [{ t: 0, pct: 100 }] },
      { retention: [{ t: 0, pct: 99 }] },
    ],
    ["a retention curve left out", { views: 1, retention: curve(2) }, { views: 1 }],
    ["subscribers", { subsGained: 1 }, { subsGained: -1 }],
  ] satisfies [string, MetricValues, MetricValues][])(
    "refuses %s",
    async (_label, first, second) => {
      const video = await newVideo(db);
      const capturedAt = ago(40);
      const stored = await log(video.id, capturedAt, first);
      const err = await rejectedWith(log(video.id, capturedAt, second), DuplicateError);
      expect(err.existingId).toBe(stored.snapshot.id);
      expect(err.details.differing).not.toEqual([]);
      expect(await snapshotCount(video.id)).toBe(1);
    },
  );

  it("does not mind a different payload for a different instant or another video", async () => {
    const [one, two] = [await newVideo(db), await newVideo(db)];
    const capturedAt = ago(50);
    await log(one.id, capturedAt, { views: 1 });
    expect((await log(one.id, ago(51), { views: 2 })).created).toBe(true);
    expect((await log(two.id, capturedAt, { views: 3 })).created).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe("log_metrics: validation", () => {
  it.each([
    ["views", -1, "metrics.views", "a whole number from 0 to 9223372036854775807"],
    ["views", 1.5, "metrics.views", "a whole number"],
    ["views", "abc", "metrics.views", "given as a number or a decimal string"],
    ["views", "", "metrics.views", "given as a number or a decimal string"],
    ["views", " 5", "metrics.views", "given as a number or a decimal string"],
    ["views", "1e3", "metrics.views", "given as a number or a decimal string"],
    ["views", "0x10", "metrics.views", "given as a number or a decimal string"],
    ["views", "NaN", "metrics.views", "given as a number or a decimal string"],
    ["views", "Infinity", "metrics.views", "given as a number or a decimal string"],
    ["views", "-Infinity", "metrics.views", "given as a number or a decimal string"],
    ["views", true, "metrics.views", "not true or false"],
    ["views", [1], "metrics.views", "not a list"],
    ["views", { n: 1 }, "metrics.views", "not an object"],
    ["views", 9223372036854775808, "metrics.views", "from 0 to 9223372036854775807"],
    ["views", "9223372036854775808", "metrics.views", "from 0 to 9223372036854775807"],
    ["impressions", -5, "metrics.impressions", "a whole number"],
    ["impressions", 0.1, "metrics.impressions", "a whole number"],
    ["ctr", -0.01, "metrics.ctr", "a number from 0 to 100 (a percentage"],
    ["ctr", 100.01, "metrics.ctr", "a number from 0 to 100 (a percentage"],
    ["ctr", 450, "metrics.ctr", "4.5 means 4.5 %"],
    ["ctr", "NaN", "metrics.ctr", "given as a number or a decimal string"],
    ["avg_view_duration_s", -1, "metrics.avg_view_duration_s", "seconds"],
    ["avg_view_duration_s", 1e16, "metrics.avg_view_duration_s", "seconds"],
    ["avg_view_pct", -0.5, "metrics.avg_view_pct", "above 100 happens when viewers rewatch"],
    ["avg_view_pct", 10000.5, "metrics.avg_view_pct", "from 0 to 10000"],
    ["watch_time_min", -1, "metrics.watch_time_min", "minutes"],
    ["subs_gained", 2147483648, "metrics.subs_gained", "from -2147483648 to 2147483647"],
    ["subs_gained", -2147483649, "metrics.subs_gained", "from -2147483648 to 2147483647"],
    ["subs_gained", 1.5, "metrics.subs_gained", "a whole number"],
    ["ctr", "4.123456789012345678901", "metrics.ctr", "too many decimal places: at most 20"],
  ])("refuses %s = %j", async (key, value, field, words) => {
    await expectRefused({ [key]: value }, field, words);
  });

  it("refuses a number with an absurd exponent as out of range", async () => {
    const video = await newVideo(db);
    const err = await rejectedWith(rawLog(video.id, ago(61), '{"views": 1e400}'), ValidationError);
    expect(err.field).toBe("metrics.views");
    const small = await rejectedWith(rawLog(video.id, ago(61), '{"ctr": 1e-400}'), ValidationError);
    expect(small.field).toBe("metrics.ctr");
    expect(await snapshotCount(video.id)).toBe(0);
  });

  it("refuses NaN and infinity before they can be turned into null", async () => {
    const video = await newVideo(db);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const err = await rejectedWith(log(video.id, ago(62), { views: value }), ValidationError);
      expect(err.field).toBe("metrics.views");
      expect(err.message).toContain("finite number");
    }
    const point = await rejectedWith(
      log(video.id, ago(62), { retention: [{ t: 0, pct: Number.NaN }] }),
      ValidationError,
    );
    expect(point.field).toBe("metrics.retention");
    expect(await snapshotCount(video.id)).toBe(0);
  });

  it("refuses metrics that are not an object, that are empty, or that name an unknown metric", async () => {
    const video = await newVideo(db);
    for (const metrics of ["[]", '"views"', "5", "null", "true"]) {
      const err = await rejectedWith(rawLog(video.id, ago(63), metrics), ValidationError);
      expect(err.field).toBe("metrics");
      expect(err.message).toContain("metrics must be an object such as");
    }
    const sqlNull = await rejectedWith(rawLog(video.id, ago(63), null), ValidationError);
    expect(sqlNull.field).toBe("metrics");
    for (const metrics of ["{}", '{"views": null}', '{"views": null, "retention": null}']) {
      const err = await rejectedWith(rawLog(video.id, ago(63), metrics), ValidationError);
      expect(err.message).toBe(
        'metrics holds no values: give at least one of "views", "impressions", "ctr", "avg_view_duration_s", "avg_view_pct", "watch_time_min", "subs_gained", "retention"',
      );
      expect(err.allowed).toHaveLength(8);
    }
    const unknown = await rejectedWith(
      rawLog(video.id, ago(63), '{"views": 1, "average_view_duration": 5}'),
      ValidationError,
    );
    expect(unknown.message).toBe(
      'metric "average_view_duration" is not known; metrics: "views", "impressions", "ctr", "avg_view_duration_s", "avg_view_pct", "watch_time_min", "subs_gained", "retention"',
    );
    expect(unknown.allowed).toHaveLength(8);
    const huge = await rejectedWith(
      rawLog(video.id, ago(63), JSON.stringify({ views: 1, note: "x".repeat(100_001) })),
      ValidationError,
    );
    expect(huge.message).toContain("metrics is too large");
    expect(huge.message).not.toContain("xxxxxxxx");
    expect(await snapshotCount(video.id)).toBe(0);
  });

  describe("the retention curve", () => {
    it.each([
      ["an object", { t: 0, pct: 100 }, "must be a list of points"],
      ["text", "high", "must be a list of points"],
      ["a number", 7, "must be a list of points"],
      ["an empty list", [], "is empty"],
      ["a point that is a number", [5], "point 1 must be an object"],
      ["a point that is a list", [[0, 100]], "point 1 must be an object"],
      ["a point without pct", [{ t: 0 }], "point 1 must have"],
      ["a point without t", [{ pct: 5 }], "point 1 must have"],
      ["a text value", [{ t: "0", pct: 100 }], "point 1 must have"],
      ["a null value", [{ t: 0, pct: null }], "point 1 must have"],
      ["an unknown field", [{ t: 0, pct: 1, label: "x" }], 'unknown field "label"'],
      ["a negative t", [{ t: -1, pct: 1 }], "t must be seconds from the start"],
      ["a t beyond 10000000", [{ t: 10000001, pct: 1 }], "from 0 to 10000000"],
      ["a negative pct", [{ t: 0, pct: -1 }], "pct must be a percentage from 0 to 10000"],
      ["a pct beyond 10000", [{ t: 0, pct: 10000.1 }], "pct must be a percentage from 0 to 10000"],
      [
        "points out of order",
        [
          { t: 10, pct: 90 },
          { t: 5, pct: 80 },
        ],
        "point 2 has t 5, not after the previous point's t 10",
      ],
      [
        "a repeated t",
        [
          { t: 10, pct: 90 },
          { t: 10, pct: 80 },
        ],
        "point 2 has t 10",
      ],
    ])("refuses %s", async (_label, retention, words) => {
      await expectRefused({ retention }, "metrics.retention", words);
    });

    it("accepts 1000 points and refuses 1001", async () => {
      const video = await newVideo(db);
      expect(
        (await log(video.id, ago(64), { retention: curve(1000) })).snapshot.retention,
      ).toHaveLength(1000);
      const err = await rejectedWith(
        log(video.id, ago(65), { retention: curve(1001) }),
        ValidationError,
      );
      expect(err.message).toBe(
        "metrics.retention has too many points: 1001, the limit is 1000; downsample the curve",
      );
      expect(err.details).toMatchObject({ count: 1001, max_count: 1000 });
    });

    it("refuses a curve above 64 KiB without echoing it", async () => {
      const video = await newVideo(db);
      const fat = Array.from({ length: 800 }, (_, i) => ({
        t: `${i}.123456789012345678901234567890`,
        pct: `50.123456789012345678901234567890`,
      }));
      const json = JSON.stringify({ retention: fat.map((p) => ({ t: Number(p.t), pct: 1 })) });
      expect(json.length).toBeLessThan(65_536);
      // Digits beyond a double's precision, spelled as JSON numbers: the size is that of the jsonb text.
      const text = `{"retention": [${fat.map((p) => `{"t": ${p.t}, "pct": ${p.pct}}`).join(",")}]}`;
      expect(text.length).toBeGreaterThan(65_536);
      expect(text.length).toBeLessThan(100_000);
      const err = await rejectedWith(rawLog(video.id, ago(66), text), ValidationError);
      expect(err.message).toMatch(
        /^metrics\.retention is too large: \d+ bytes, the limit is 65536/,
      );
      expect(err.message).not.toContain("123456789");
      expect(await snapshotCount(video.id)).toBe(0);
    });
  });

  describe("the video and the instant", () => {
    it("needs an existing video", async () => {
      const id = randomUUID();
      expect(await rejectedWith(log(id, ago(1), { views: 1 }), NotFoundError)).toMatchObject({
        entity: "video",
        id,
      });
      expect(
        (await rejectedWith(rawLog(null, ago(1), '{"views": 1}'), ValidationError)).field,
      ).toBe("video_id");
      const bad = await rejectedWith(
        act(db, alice, (tx) =>
          logMetrics(tx, { videoId: "nope", capturedAt: ago(1), metrics: { views: 1 } }),
        ),
        ValidationError,
      );
      expect(bad.field).toBe("video_id");
    });

    it("keeps captured_at between 2005 and one day ahead", async () => {
      const video = await newVideo(db);
      expect((await log(video.id, hoursAhead(12), { views: 1 })).created).toBe(true);
      const future = await rejectedWith(
        log(video.id, hoursAhead(30), { views: 1 }),
        ValidationError,
      );
      expect(future.field).toBe("captured_at");
      expect(future.message).toContain(
        "is too far ahead: a snapshot records numbers that were already read",
      );
      const far = await rejectedWith(
        log(video.id, "2062-01-01T00:00:00Z", { views: 1 }),
        ValidationError,
      );
      expect(far.field).toBe("captured_at");
      const old = await rejectedWith(
        log(video.id, "2004-12-31T23:59:59Z", { views: 1 }),
        ValidationError,
      );
      expect(old.message).toContain("when YouTube did not exist yet");
      expect((await log(video.id, "2005-01-01T00:00:00Z", { views: 1 })).created).toBe(true);
      expect(await snapshotCount(video.id)).toBe(2);
    });

    it("refuses infinite and missing instants, and times without a time zone", async () => {
      const video = await newVideo(db);
      for (const value of ["infinity", "-infinity"]) {
        const err = await rejectedWith(rawLog(video.id, value, '{"views": 1}'), ValidationError);
        expect(err.message).toContain("must be a real date and time");
      }
      const missing = await rejectedWith(rawLog(video.id, null, '{"views": 1}'), ValidationError);
      expect(missing.message).toContain("captured_at is required");
      for (const value of ["2026-09-30T10:00:00", "2026-09-30", "yesterday", ""]) {
        const err = await rejectedWith(log(video.id, value, { views: 1 }), ValidationError);
        expect(err.field).toBe("captured_at");
        expect(err.message).toContain("time zone");
      }
      const invalid = await rejectedWith(
        log(video.id, new Date(Number.NaN), { views: 1 }),
        ValidationError,
      );
      expect(invalid.field).toBe("captured_at");
      expect(await snapshotCount(video.id)).toBe(0);
    });
  });

  it("never lets a CHECK violation (23514) reach the caller: every refusal is a catalogue error", async () => {
    const video = await newVideo(db);
    const attempts = [
      '{"views": -1}',
      '{"ctr": 101}',
      '{"retention": []}',
      '{"retention": {"t": 1}}',
      '{"subs_gained": 1e12}',
      "{}",
    ];
    for (const metrics of attempts) {
      const outcome = await settle(rawLog(video.id, ago(70), metrics));
      expect(outcomeKind(outcome)).toBe("validation");
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("log_metrics: concurrency", () => {
  it("makes many identical calls for one key one snapshot: one created = true, no errors", async () => {
    const video = await newVideo(db);
    const capturedAt = ago(80);
    const agent = newAgent("racer");
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        log(video.id, capturedAt, FULL, i % 2 === 0 ? alice : agent),
      ),
    );
    const { ok, failed } = partition(results);
    expect(failed).toEqual([]);
    expect(ok.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(ok.map((result) => result.snapshot.id)).size).toBe(1);
    expect(await snapshotCount(video.id)).toBe(1);
    expect(await eventCount(db, ok[0]?.snapshot.id as string)).toBe(1);
  });

  it("lets exactly one of many different payloads for one key win; the others are told what won", async () => {
    const video = await newVideo(db);
    const capturedAt = ago(81);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => log(video.id, capturedAt, { views: 100 + i })),
    );
    const { ok, failed } = partition(results);
    expect(ok).toHaveLength(1);
    expect(ok[0]?.created).toBe(true);
    expect(failed).toHaveLength(11);
    const winner = ok[0]?.snapshot;
    for (const reason of failed) {
      expect(reason).toBeInstanceOf(DuplicateError);
      expect((reason as DuplicateError).existingId).toBe(winner?.id);
      expect((reason as DuplicateError).message).toContain(`stored: views=${winner?.views};`);
    }
    expect(await snapshotCount(video.id)).toBe(1);
  });

  it("appends different instants of one video side by side, and the same instant of different videos", async () => {
    const [one, two] = [await newVideo(db), await newVideo(db)];
    const results = await Promise.allSettled([
      ...Array.from({ length: 6 }, (_, i) => log(one.id, ago(90 + i), { views: i })),
      log(two.id, ago(90), { views: 1 }),
      log(two.id, ago(90), { views: 1 }),
    ]);
    const { ok, failed } = partition(results);
    expect(failed).toEqual([]);
    expect(ok.filter((result) => result.created)).toHaveLength(7);
    expect(await snapshotCount(one.id)).toBe(6);
    expect(await snapshotCount(two.id)).toBe(1);
  });

  it("still makes identical calls one snapshot if the video row lock is taken away: ON CONFLICT decides", async () => {
    const video = await newVideo(db);
    const capturedAt = ago(100);
    const results = await withoutRowLock(db, ["log_metrics"], () =>
      Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          log(video.id, capturedAt, FULL, i % 2 === 0 ? alice : newAgent()),
        ),
      ),
    );
    const { ok, failed } = partition(results);
    expect(failed).toEqual([]);
    expect(ok.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(ok.map((result) => result.snapshot.id)).size).toBe(1);
    expect(await snapshotCount(video.id)).toBe(1);
  });

  it("still lets one different payload win if the lock is taken away; the others get the duplicate error", async () => {
    const video = await newVideo(db);
    const capturedAt = ago(101);
    const results = await withoutRowLock(db, ["log_metrics"], () =>
      Promise.allSettled(
        Array.from({ length: 12 }, (_, i) => log(video.id, capturedAt, { views: i })),
      ),
    );
    const { ok, failed } = partition(results);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(11);
    for (const reason of failed) {
      expect(reason).toBeInstanceOf(DuplicateError);
    }
    expect(await snapshotCount(video.id)).toBe(1);
  });

  it("loses a race against archiving that started first, and makes archiving wait for a snapshot that started first", async () => {
    const lateVideo = await newVideo(db);
    const archiver = await db.pool("ytw_web").connect();
    try {
      await archiver.query("BEGIN");
      await archiver.query(
        sql`SELECT archive_video('alice', 'human', NULL, ${lateVideo.id}::uuid)`,
      );
      const racing = withActor(db.pool("ytw_mcp"), newAgent(), (tx) =>
        logMetrics(tx, { videoId: lateVideo.id, capturedAt: ago(110), metrics: { views: 1 } }),
      );
      const outcome = racing.then(
        () => undefined,
        (err: unknown) => err,
      );
      await waitForLockWait(db, "log_metrics");
      await archiver.query("COMMIT");
      expect(await outcome).toBeInstanceOf(InvalidTransitionError);
      expect(await snapshotCount(lateVideo.id)).toBe(0);
    } finally {
      await archiver.query("ROLLBACK").catch(() => undefined);
      archiver.release();
    }

    const earlyVideo = await newVideo(db);
    const logger = await db.pool("ytw_mcp").connect();
    try {
      await logger.query("BEGIN");
      await logger.query(
        sql`SELECT * FROM log_metrics('bot', 'agent', ${randomUUID()}::uuid, ${earlyVideo.id}::uuid, ${ago(111)}::timestamptz, '{"views": 1}'::jsonb)`,
      );
      const archiving = withActor(db.pool("ytw_web"), alice, (tx) =>
        archiveVideo(tx, { id: earlyVideo.id }),
      );
      const archived = archiving.then(
        (video) => video,
        (err: unknown) => err,
      );
      await waitForLockWait(db, "archive_video");
      await logger.query("COMMIT");
      expect(await archived).toMatchObject({ id: earlyVideo.id, archivedAt: expect.any(Date) });
      expect(await snapshotCount(earlyVideo.id)).toBe(1);
    } finally {
      await logger.query("ROLLBACK").catch(() => undefined);
      logger.release();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("model-based check", () => {
  it.each([1, 2, 3])(
    "random calls with repeats, other numbers and new instants agree with a model of the key space (seed %i)",
    async (seed) => {
      const random = seededRandom(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
      const videos = [await newVideo(db), await newVideo(db)];
      const instants = [ago(200), ago(201), ago(202), ago(203)];
      const payloads: MetricValues[] = [
        { views: 10 },
        { views: 20, ctr: 5 },
        { views: 10, retention: curve(2) },
        { subsGained: -1 },
      ];
      const model = new Map<string, number>();
      let created = 0;

      for (let step = 0; step < 120; step += 1) {
        const video = pick(videos);
        const instant = pick(instants);
        const payloadIndex = Math.floor(random() * payloads.length);
        const key = `${video.id}@${instant}`;
        const stored = model.get(key);
        const outcome = await settle(
          log(
            video.id,
            instant,
            payloads[payloadIndex] as MetricValues,
            pick([alice, newAgent("model")]),
          ),
        );
        const expectedKind =
          stored === undefined ? "created" : stored === payloadIndex ? "replayed" : "duplicate";
        expect(
          outcomeKind(outcome, outcome.ok && !outcome.value.created ? "replayed" : "created"),
        ).toBe(expectedKind);
        if (stored === undefined) {
          model.set(key, payloadIndex);
          created += 1;
        }
      }

      expect(created).toBeGreaterThan(3);
      for (const video of videos) {
        const rows = await listMetricSnapshots(db.admin, { videoId: video.id });
        const expected = [...model.entries()].filter(([key]) => key.startsWith(video.id));
        expect(rows).toHaveLength(expected.length);
        for (const [key, payloadIndex] of expected) {
          const row = rows.find(
            (candidate) => candidate.capturedAt.toISOString() === key.split("@")[1],
          );
          expect(row?.views ?? null).toBe(
            payloads[payloadIndex]?.views === undefined
              ? null
              : String(payloads[payloadIndex]?.views),
          );
        }
      }
      const { rows } = await db.admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM events WHERE entity_type = 'video_metric' AND entity_id = ANY(SELECT id FROM video_metrics WHERE video_id = ANY($1))",
        [videos.map((video) => video.id)],
      );
      expect(rows[0]?.n).toBe(created);
    },
  );
});

// ---------------------------------------------------------------------------------------------

describe("arguments that are NULL", () => {
  // Generated at run time: a literal id next to a "token" key reads as a credential to the secret scan.
  const agentToken = randomUUID();
  const spec: FunctionSpec = {
    name: "log_metrics",
    types: ["text", "text", "uuid", "uuid", "timestamptz", "jsonb"],
    valid: async () => [
      "bot",
      "agent",
      agentToken,
      (await newVideo(db)).id,
      ago(300),
      JSON.stringify({ views: 1 }),
    ],
    optional: [2],
  };

  it("answers a NULL with a validation error wherever a value is required", async () => {
    expect(await nullArgumentOutcomes(db, spec)).toEqual(expectedNullOutcomes(spec));
  });
});

// ---------------------------------------------------------------------------------------------

describe("privileges and isolation", () => {
  it("log_metrics is SECURITY DEFINER, pins its search path and is executable by exactly ytw_web and ytw_mcp", async () => {
    const found = Object.values(await functionPrivileges(db, "log_metrics"));
    expect(found).toEqual([
      {
        roles: ["ytw_mcp", "ytw_web"],
        publicExecute: false,
        definer: true,
        searchPath: "search_path=pg_catalog, public, pg_temp",
      },
    ]);
  });

  it.each([
    "ytw_metric_keys",
    "ytw_metric_summary",
    "ytw_metric_summary_text",
    "ytw_raise_metric_conflict",
  ])("keeps the helper %s out of reach of every application role", async (name) => {
    for (const privileges of Object.values(await functionPrivileges(db, name))) {
      expect(privileges).toMatchObject({ roles: [], publicExecute: false });
    }
  });

  it("keeps the catalog guard clean", async () => {
    const { rows } = await db.admin.query("SELECT * FROM ytw_catalog_violations()");
    expect(rows).toEqual([]);
  });

  it("denies direct writes to video_metrics to every application role, and the function to ytw_readonly", async () => {
    const video = await newVideo(db);
    const { snapshot } = await log(video.id, ago(400), { views: 1 });
    const denied = /^(42501|25006)$/;
    for (const role of ["ytw_web", "ytw_mcp", "ytw_readonly"] as const) {
      const pool = db.pool(role);
      expect(
        await sqlstate(
          pool.query(
            "INSERT INTO video_metrics (video_id, captured_at, views) VALUES ($1, now(), 5)",
            [video.id],
          ),
        ),
      ).toMatch(denied);
      expect(await sqlstate(pool.query("UPDATE video_metrics SET views = 999"))).toMatch(denied);
      expect(await sqlstate(pool.query("DELETE FROM video_metrics"))).toMatch(denied);
      expect(await sqlstate(pool.query("TRUNCATE video_metrics"))).toMatch(denied);
    }
    expect(
      await sqlstate(
        db
          .pool("ytw_readonly")
          .query(
            `SELECT * FROM log_metrics('x', 'human', NULL, '${video.id}', now(), '{"views": 1}')`,
          ),
      ),
    ).toBe("42501");
    expect(await listMetricSnapshots(db.admin, { videoId: video.id })).toEqual([snapshot]);
  });

  it("is not fooled by temporary tables that shadow the real ones", async () => {
    const video = await newVideo(db);
    const client = await db.admin.connect();
    try {
      await client.query(
        "CREATE TEMP TABLE video_metrics (video_id uuid, captured_at timestamptz)",
      );
      await client.query("CREATE TEMP TABLE videos (id uuid, archived_at timestamptz)");
      const { rows } = await client.query<{ created: boolean }>(
        "SELECT created FROM log_metrics('mallory', 'human', NULL, $1, $2, '{\"views\": 1}')",
        [video.id, ago(500)],
      );
      expect(rows).toEqual([{ created: true }]);
      const temp = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_temp.video_metrics",
      );
      expect(temp.rows[0]?.n).toBe(0);
    } finally {
      client.release(true);
    }
    expect(await snapshotCount(video.id)).toBe(1);
  });
});
