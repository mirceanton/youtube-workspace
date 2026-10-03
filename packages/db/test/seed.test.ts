// The seed helper (test/seed.ts, T15) and the 10 000-row smoke test of the views, the search and the
// activity feed: each must answer well inside a second on a realistic load (asserted at 2 s so a busy CI
// machine does not make it flaky; the real numbers are printed by the test names' timings below).
import { IDEA_STAGES } from "@ytw/shared/constants";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, queryReadOnly } from "../src/client.js";
import { listEvents } from "../src/activity.js";
import { searchAll } from "../src/search.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { listExperimentResults, listIdeaPipeline, listVideoPerformance } from "../src/views.js";
import {
  SEED_WORDS,
  seedLarge,
  seedSmall,
  seedUuid,
  type LargeSeedCounts,
  type SmallSeed,
} from "./seed.js";

const MAX_MS = 2000;

/** Runs `fn` twice (cold, then warm) and returns the slower of the two timings. */
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const first = performance.now();
  const value = await fn();
  const cold = performance.now() - first;
  const second = performance.now();
  await fn();
  return { value, ms: Math.max(cold, performance.now() - second) };
}

async function scalar(db: TestDb, sqlText: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: number }>(sqlText);
  return rows[0]?.n ?? -1;
}

function count(db: TestDb, table: string): Promise<number> {
  return scalar(db, `SELECT count(*)::int AS n FROM ${table}`);
}

const titles = (seed: SmallSeed): string[] => Object.values(seed.ideas).map((idea) => idea.title);

async function bodies(db: TestDb): Promise<string[]> {
  const { rows } = await db.admin.query<{ body_md: string }>(
    "SELECT body_md FROM scripts ORDER BY body_md",
  );
  return rows.map((row) => row.body_md);
}

describe("seedSmall", () => {
  let db: TestDb;
  let seed: SmallSeed;

  beforeAll(async () => {
    db = await createTestDb();
    seed = await seedSmall(db);
  });

  afterAll(async () => {
    await db.drop();
  });

  it("creates the documented records", async () => {
    expect(await count(db, "ideas")).toBe(8);
    expect(await count(db, "videos")).toBe(5);
    expect(await count(db, "experiments")).toBe(3);
    expect(await count(db, "experiment_variants")).toBe(7);
    expect(await count(db, "video_metrics")).toBe(6);
    // scripting: 2 + 1, filming: 1, editing: 1 + 2, published: 1, archived: 1.
    expect(await count(db, "scripts")).toBe(9);
    expect(
      Object.values(seed.ideas)
        .map((idea) => idea.status)
        .toSorted(),
    ).toEqual([...IDEA_STAGES, "inbox"].toSorted());
    expect(seed.ideas.archived.archivedAt).not.toBeNull();
    expect(seed.experiments.concluded.status).toBe("concluded");
    expect(seed.experiments.concluded.winnerVariantId).toBe(
      seed.experiments.concluded.variants.find((variant) => variant.label === "B")?.id,
    );
    expect(seed.experiments.running.status).toBe("running");
    expect(seed.experiments.planned.status).toBe("planned");
    expect(seed.videos.archived.archivedAt).not.toBeNull();
  });

  it("writes real audit events for the functions and the logged actions, by all three actors", async () => {
    const { rows } = await db.admin.query<{ actor: string; actor_type: string; n: number }>(
      `SELECT actor, actor_type, count(*)::int AS n FROM events GROUP BY actor, actor_type ORDER BY actor`,
    );
    expect(rows.map((row) => row.actor)).toEqual(["alice", "seed-analyst", "seed-writer"]);
    expect(rows.every((row) => row.n > 3)).toBe(true);
    const { rows: logged } = await db.admin.query<{ action: string }>(
      `SELECT action FROM events WHERE action LIKE '%.%' ORDER BY created_at, id`,
    );
    expect(logged.map((row) => row.action)).toEqual(["auth.login", "tool.call", "tool.call"]);
  });

  it("is deterministic: a second database gets the same content (ids and times differ)", async () => {
    const other = await createTestDb();
    try {
      const again = await seedSmall(other);
      expect(titles(again)).toEqual(titles(seed));
      expect(await bodies(other)).toEqual(await bodies(db));
    } finally {
      await other.drop();
    }
  });
});

describe("seedLarge", () => {
  let db: TestDb;
  let counts: LargeSeedCounts;
  let seedMs = 0;

  beforeAll(async () => {
    db = await createTestDb();
    const started = performance.now();
    counts = await seedLarge(db);
    seedMs = performance.now() - started;
  });

  afterAll(async () => {
    await db.drop();
  });

  it("writes 10 000 ideas and videos with scripts, metrics, experiments and events, quickly", async () => {
    expect(counts.ideas).toBe(10_000);
    expect(counts.videos).toBe(10_000);
    expect(counts.events).toBe(40_000);
    expect(counts.scripts).toBeGreaterThan(20_000);
    expect(counts.snapshots).toBeGreaterThan(25_000);
    expect(counts.experiments).toBe(1000);
    expect(counts.variants).toBe(3000);
    for (const [table, key] of [
      ["ideas", "ideas"],
      ["scripts", "scripts"],
      ["videos", "videos"],
      ["video_metrics", "snapshots"],
      ["experiments", "experiments"],
      ["experiment_variants", "variants"],
      ["events", "events"],
    ] as const) {
      expect(await count(db, table)).toBe(counts[key]);
    }
    expect(seedMs).toBeLessThan(30_000);
  });

  it("uses fixed ids and content, so another run (or a performance test) can rely on them", async () => {
    const { rows } = await db.admin.query<{ title: string; pitch: string; status: string }>(
      "SELECT title, pitch, status FROM ideas WHERE id = $1",
      [seedUuid("idea", 77)],
    );
    expect(rows[0]?.title).toMatch(/^Idea 77 about /);
    expect(rows[0]?.pitch).toMatch(/Reference code zq77\.$/);
    expect(IDEA_STAGES).toContain(rows[0]?.status);
    const { rows: videos } = await db.admin.query<{ youtube_id: string }>(
      "SELECT youtube_id FROM videos WHERE id = $1",
      [seedUuid("video", 12)],
    );
    expect(videos[0]?.youtube_id).toBe("v0000000012");
    expect(SEED_WORDS).toHaveLength(20);
  });

  it("is consistent without foreign key checks: every reference resolves, every constraint holds", async () => {
    expect(
      await scalar(
        db,
        "SELECT count(*)::int AS n FROM scripts s LEFT JOIN ideas i ON i.id = s.idea_id WHERE i.id IS NULL",
      ),
    ).toBe(0);
    expect(
      await scalar(
        db,
        "SELECT count(*)::int AS n FROM video_metrics m LEFT JOIN videos v ON v.id = m.video_id WHERE v.id IS NULL",
      ),
    ).toBe(0);
    expect(
      await scalar(
        db,
        "SELECT count(*)::int AS n FROM experiments e LEFT JOIN videos v ON v.id = e.video_id WHERE v.id IS NULL",
      ),
    ).toBe(0);
    expect(
      await scalar(
        db,
        `SELECT count(*)::int AS n FROM experiments e
           JOIN experiment_variants x ON x.id = e.winner_variant_id AND x.experiment_id = e.id`,
      ),
    ).toBe(250);
    expect(
      await scalar(
        db,
        "SELECT count(*)::int AS n FROM videos v LEFT JOIN ideas i ON i.id = v.idea_id WHERE v.idea_id IS NOT NULL AND i.id IS NULL",
      ),
    ).toBe(0);
    // Exactly one control per experiment.
    expect(
      await scalar(
        db,
        "SELECT count(*)::int AS n FROM (SELECT experiment_id FROM experiment_variants GROUP BY 1 HAVING count(*) FILTER (WHERE is_control) <> 1) t",
      ),
    ).toBe(0);
  });

  it("covers every stage, archived ideas, videos without metrics and every experiment status", async () => {
    const pipeline = await listIdeaPipeline(db.pool("ytw_web"), { limit: 1000 });
    expect(new Set(pipeline.map((idea) => idea.status))).toEqual(new Set(IDEA_STAGES));
    const all = await listIdeaPipeline(db.pool("ytw_web"), { includeArchived: true, limit: 1000 });
    expect(all.some((idea) => idea.archivedAt !== null)).toBe(true);
    const videos = await listVideoPerformance(db.pool("ytw_web"), { limit: 1000 });
    expect(videos.some((video) => video.latest === null)).toBe(true);
    expect(videos.some((video) => video.latest !== null)).toBe(true);
    const experiments = await listExperimentResults(db.pool("ytw_web"), { limit: 1000 });
    expect(new Set(experiments.map((experiment) => experiment.status))).toEqual(
      new Set(["planned", "running", "concluded", "cancelled"]),
    );
  });

  describe("every view and function answers well under a second on 10 000 rows", () => {
    it("ideas_pipeline and ideas_pipeline_all (all rows, and filtered by stage)", async () => {
      const web = db.pool("ytw_web");
      const everything = await timed(() => listIdeaPipeline(web, { limit: 1000 }));
      expect(everything.value).toHaveLength(1000);
      const stage = await timed(() =>
        listIdeaPipeline(web, { stages: ["scripting"], limit: 1000 }),
      );
      expect(stage.value.length).toBeGreaterThan(500);
      const archived = await timed(() =>
        listIdeaPipeline(web, { includeArchived: true, limit: 1000 }),
      );
      expect(archived.value).toHaveLength(1000);
      for (const ms of [everything.ms, stage.ms, archived.ms]) {
        expect(ms).toBeLessThan(MAX_MS);
      }
      // The whole view, not just a page: aggregate over all 9 500 live ideas.
      const total = await timed(() =>
        db.pool("ytw_mcp").query("SELECT count(*)::int AS n FROM ideas_pipeline"),
      );
      expect(total.value.rows[0]).toEqual({ n: 9500 });
      expect(total.ms).toBeLessThan(MAX_MS);
    });

    it("video_performance_summary (the medians cover 9 800 live videos)", async () => {
      const web = db.pool("ytw_web");
      const page = await timed(() => listVideoPerformance(web, { limit: 1000 }));
      expect(page.value).toHaveLength(1000);
      const one = await timed(() => listVideoPerformance(web, { videoId: seedUuid("video", 7) }));
      expect(one.value).toHaveLength(1);
      const total = await timed(() =>
        db.pool("ytw_mcp").query("SELECT count(*)::int AS n FROM video_performance_summary"),
      );
      expect(total.value.rows[0]).toEqual({ n: 9800 });
      for (const ms of [page.ms, one.ms, total.ms]) {
        expect(ms).toBeLessThan(MAX_MS);
      }
    });

    it("experiment_results", async () => {
      const web = db.pool("ytw_web");
      const all = await timed(() => listExperimentResults(web, { limit: 1000 }));
      expect(all.value).toHaveLength(1000);
      expect(all.value.every((experiment) => experiment.variants.length === 3)).toBe(true);
      expect(all.ms).toBeLessThan(MAX_MS);
    });

    it("the views also answer as ytw_readonly through queryReadOnly (what query_sql runs)", async () => {
      const pool = createPool({ role: "ytw_readonly", connectionString: db.url("ytw_readonly") });
      try {
        for (const view of [
          "ideas_pipeline",
          "ideas_pipeline_all",
          "video_performance_summary",
          "experiment_results",
        ]) {
          const started = performance.now();
          const result = await queryReadOnly(pool, `SELECT count(*)::int AS n FROM ${view}`);
          expect(result.rows[0]?.n).toBeGreaterThan(0);
          expect(performance.now() - started).toBeLessThan(MAX_MS);
        }
      } finally {
        await pool.end();
      }
    });

    it("search_all: a common word, a rare code, a phrase, and scripts only", async () => {
      const web = db.pool("ytw_web");
      const common = await timed(() =>
        searchAll(web, { query: "retention", resources: ["ideas", "scripts"], limit: 50 }),
      );
      expect(common.value).toHaveLength(50);
      const rare = await timed(() => searchAll(web, { query: "zq77", resources: ["ideas"] }));
      expect(rare.value.map((hit) => hit.id)).toEqual([seedUuid("idea", 77)]);
      const scripts = await timed(() =>
        searchAll(web, { query: "today talk", resources: ["scripts"], limit: 50 }),
      );
      expect(scripts.value).toHaveLength(50);
      const phrase = await timed(() =>
        searchAll(web, { query: '"audience" -gear', resources: ["ideas", "scripts"], limit: 50 }),
      );
      expect(phrase.value.length).toBeGreaterThan(0);
      for (const ms of [common.ms, rare.ms, scripts.ms, phrase.ms]) {
        expect(ms).toBeLessThan(MAX_MS);
      }
    });

    it("list_events: the first page, a deep page, every filter and a range", async () => {
      const web = db.pool("ytw_web");
      const first = await timed(() => listEvents(web, { limit: 100 }));
      expect(first.value.events).toHaveLength(100);
      expect(first.value.nextCursor).not.toBeNull();
      // Walk to the last page: 400 pages of 100 events, the keyset keeps each one cheap.
      let cursor = first.value.nextCursor;
      let pages = 1;
      let rows = first.value.events.length;
      const walkStarted = performance.now();
      while (cursor !== null) {
        const page = await listEvents(web, { limit: 100, cursor });
        rows += page.events.length;
        pages += 1;
        cursor = page.nextCursor;
      }
      expect(rows).toBe(40_000);
      expect(pages).toBe(400);
      expect(performance.now() - walkStarted).toBeLessThan(20_000);

      const filtered = await timed(() =>
        listEvents(web, { actor: "alice", actionPrefix: "tool.", entityType: "video", limit: 100 }),
      );
      expect(filtered.value.events.length).toBeGreaterThan(0);
      const range = await timed(() =>
        listEvents(web, {
          from: new Date(Date.now() - 2 * 86_400_000),
          to: new Date(Date.now() - 86_400_000),
          limit: 100,
        }),
      );
      expect(range.value.events.length).toBeGreaterThan(0);
      const entity = await timed(() =>
        listEvents(web, { entityId: seedUuid("idea", 5), limit: 100 }),
      );
      expect(entity.value.events.length).toBeGreaterThan(0);
      const deep = await timed(() => listEvents(web, { actorType: "agent", limit: 100 }));
      expect(deep.value.events.every((event) => event.actorType === "agent")).toBe(true);
      for (const ms of [first.ms, filtered.ms, range.ms, entity.ms, deep.ms]) {
        expect(ms).toBeLessThan(MAX_MS);
      }
    });
  });
});
