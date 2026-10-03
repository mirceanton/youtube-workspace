// The three views for agents and the UI (migrations 0060-0062, T15): ideas_pipeline (and its
// archived-included twin), video_performance_summary and experiment_results. Each is checked on seeded
// data, on empty and edge-case data (no scripts, no metrics, a single video, ties, null ctr, extreme
// numbers) and for what it must never do: show more than the caller may read, expose users or
// ytw_private, or break the guard.
import { EXPERIMENT_STATUSES, IDEA_STAGES, SCRIPT_KINDS } from "@ytw/shared/constants";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { APP_ROLES, withActor, type AppRole } from "../src/client.js";
import { ValidationError } from "../src/errors.js";
import { listEvents } from "../src/activity.js";
import { concludeExperiment, recordVariantStats } from "../src/experiments.js";
import { advanceIdea, archiveIdea, updateIdea } from "../src/ideas.js";
import { logMetrics, type MetricValues } from "../src/metrics.js";
import { saveScriptVersion, setScriptStatus } from "../src/scripts.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { archiveVideo } from "../src/videos.js";
import {
  countIdeasByStage,
  listExperimentResults,
  listIdeaPipeline,
  listVideoPerformance,
  type ExperimentResultRecord,
  type VideoPerformanceRecord,
} from "../src/views.js";
import { act, alice, newAgent, newIdea, tick } from "./content-helpers.js";
import { sqlstate } from "./helpers.js";
import { seedSmall, type SmallSeed } from "./seed.js";
import {
  newExperiment,
  newVideo,
  rejectedWith,
  runningExperiment,
  setExperimentStatus,
} from "./video-helpers.js";

const VIEWS = [
  "ideas_pipeline",
  "ideas_pipeline_all",
  "video_performance_summary",
  "experiment_results",
] as const;

const analyst = newAgent("views-analyst");

/** A decimal string without trailing zeros, so "0.020" and "0.02" (and "-0.0" and "0") compare equal. */
function dec(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
  return trimmed === "-0" ? "0" : trimmed;
}

/** The seconds between a point in time and now (positive for the past). */
function secondsSince(time: Date): number {
  return (Date.now() - time.getTime()) / 1000;
}

/** Column name -> data type of a table or view in the public schema. */
async function tableColumns(db: TestDb, table: string): Promise<Record<string, string>> {
  const { rows } = await db.admin.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return Object.fromEntries(rows.map((row) => [row.column_name, row.data_type]));
}

/** The variant of an experiment result with this label. */
function byLabel(result: ExperimentResultRecord, label: string) {
  const variant = result.variants.find((v) => v.label === label);
  if (variant === undefined) {
    throw new Error(`no variant ${label}`);
  }
  return variant;
}

async function pipelineIds(db: TestDb): Promise<string[]> {
  return (await listIdeaPipeline(db.pool("ytw_web"), { limit: 1000 })).map((idea) => idea.id);
}

// ---------------------------------------------------------------------------------------------
describe("empty database", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.drop();
  });

  it("every view exists and has no rows", async () => {
    for (const view of VIEWS) {
      for (const role of APP_ROLES) {
        const { rows } = await db
          .pool(role)
          .query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${view}`);
        expect(rows[0]).toEqual({ n: 0 });
      }
    }
  });

  it("the readers return empty lists", async () => {
    const web = db.pool("ytw_web");
    expect(await listIdeaPipeline(web)).toEqual([]);
    expect(await listIdeaPipeline(web, { includeArchived: true })).toEqual([]);
    expect(await listVideoPerformance(web)).toEqual([]);
    expect(await listExperimentResults(web)).toEqual([]);
    expect(await countIdeasByStage(web)).toEqual(
      Object.fromEntries(IDEA_STAGES.map((stage) => [stage, 0])),
    );
  });

  it("a channel with no snapshot at all has NULL medians (and a sample size of 0), not an error", async () => {
    await newVideo(db);
    const [video] = await listVideoPerformance(db.pool("ytw_web"));
    expect(video?.latest).toBeNull();
    expect(video?.median.sampleSize).toBe(0);
    expect(Object.values({ ...video?.median, sampleSize: null }).every((v) => v === null)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("ideas_pipeline on the small seed", () => {
  let db: TestDb;
  let seed: SmallSeed;

  beforeAll(async () => {
    db = await createTestDb();
    seed = await seedSmall(db);
  });

  afterAll(async () => {
    await db.drop();
  });

  it("lists the seven live ideas, in the order of the stage clock, and leaves the archived one out", async () => {
    const live = await listIdeaPipeline(db.pool("ytw_web"));
    expect(live.map((idea) => idea.title)).toEqual([
      "Why retention beats clicks", // 2 hours
      "Thumbnail experiments that failed", // 3 days
      "How I plan a video from idea to upload", // 5 days
      "Camera gear after two years", // 12 days
      "Editing workflow with AI", // 20 days
      "The audience retention curve explained", // 40 days
      "A dropped idea about gear", // 60 days
    ]);
    expect(live.map((idea) => idea.id)).not.toContain(seed.ideas.archived.id);
    expect(live.every((idea) => idea.archivedAt === null)).toBe(true);
  });

  it("shows stage, age in stage and the latest revision of each kind, as seeded", async () => {
    const live = await listIdeaPipeline(db.pool("ytw_web"));
    const byId = new Map(live.map((idea) => [idea.id, idea]));
    const get = (key: keyof SmallSeed["ideas"]) => {
      const row = byId.get(seed.ideas[key].id);
      if (row === undefined) {
        throw new Error(`${key} is not in the pipeline`);
      }
      return row;
    };
    const summary = (key: keyof SmallSeed["ideas"]) => {
      const row = get(key);
      return {
        status: row.status,
        days: row.daysInStage,
        script: row.latestScript && [row.latestScript.version, row.latestScript.status],
        packaging: row.latestPackaging && [row.latestPackaging.version, row.latestPackaging.status],
      };
    };
    expect(summary("inbox")).toEqual({ status: "inbox", days: 0, script: null, packaging: null });
    expect(summary("shortlisted")).toEqual({
      status: "shortlisted",
      days: 3,
      script: null,
      packaging: null,
    });
    expect(summary("scripting")).toEqual({
      status: "scripting",
      days: 5,
      script: [2, "review"],
      packaging: [1, "draft"],
    });
    expect(summary("filming")).toEqual({
      status: "filming",
      days: 12,
      script: [1, "approved"],
      packaging: null,
    });
    expect(summary("editing")).toEqual({
      status: "editing",
      days: 20,
      script: [1, "draft"],
      packaging: [2, "review"],
    });
    expect(summary("published")).toEqual({
      status: "published",
      days: 40,
      script: [1, "approved"],
      packaging: null,
    });
    expect(summary("dropped")).toEqual({
      status: "dropped",
      days: 60,
      script: null,
      packaging: null,
    });
    // The revision summaries point at the stored revisions.
    expect(get("scripting").latestScript?.id).toBe(seed.scripts.scripting?.script[1]?.id);
    expect(get("scripting").latestPackaging?.id).toBe(seed.scripts.scripting?.packaging[0]?.id);
    expect(get("scripting").latestScript?.savedAt).toEqual(
      seed.scripts.scripting?.script[1]?.createdAt,
    );
    // Age in stage in seconds: 5 days 3 hours (plus the little time the seeding took).
    const expected = 5 * 86_400 + 3 * 3600;
    expect(get("scripting").ageInStageSeconds).toBeGreaterThanOrEqual(expected);
    expect(get("scripting").ageInStageSeconds).toBeLessThan(expected + 600);
  });

  it("carries the idea's own fields unchanged", async () => {
    const live = await listIdeaPipeline(db.pool("ytw_web"), { stages: ["scripting"] });
    expect(live).toHaveLength(1);
    const row = live[0];
    if (row === undefined) {
      throw new Error("the scripting idea is missing");
    }
    const { latestScript, latestPackaging, ageInStageSeconds, daysInStage, ...idea } = row;
    expect(latestScript).not.toBeNull();
    expect(latestPackaging).not.toBeNull();
    expect(typeof ageInStageSeconds).toBe("number");
    expect(daysInStage).toBe(5);
    expect(idea).toEqual(seed.ideas.scripting);
  });

  it("ideas_pipeline_all (includeArchived) adds the archived idea with its scripts", async () => {
    const all = await listIdeaPipeline(db.pool("ytw_web"), { includeArchived: true });
    expect(all).toHaveLength(8);
    const archived = all.find((idea) => idea.id === seed.ideas.archived.id);
    expect(archived?.archivedAt).not.toBeNull();
    expect(archived?.status).toBe("inbox");
    expect(archived?.latestScript?.version).toBe(1);
  });

  it("filters by stage (one, several, none) in the database", async () => {
    const web = db.pool("ytw_web");
    expect(
      (await listIdeaPipeline(web, { stages: ["editing"] })).map((idea) => idea.status),
    ).toEqual(["editing"]);
    expect(
      (await listIdeaPipeline(web, { stages: ["inbox", "dropped"] }))
        .map((idea) => idea.status)
        .toSorted(),
    ).toEqual(["dropped", "inbox"]);
    // inbox + archived: the archived idea only with includeArchived.
    expect(await listIdeaPipeline(web, { stages: ["inbox"] })).toHaveLength(1);
    expect(await listIdeaPipeline(web, { stages: ["inbox"], includeArchived: true })).toHaveLength(
      2,
    );
    expect(await listIdeaPipeline(web, { stages: [] })).toHaveLength(7);
  });

  it("answers the dashboard rows of PRD 6: ideas per stage, running experiments, latest videos, last events", async () => {
    const web = db.pool("ytw_web");
    // The archived idea sits in the inbox but is not counted.
    expect(await countIdeasByStage(web)).toEqual({
      inbox: 1,
      shortlisted: 1,
      scripting: 1,
      filming: 1,
      editing: 1,
      published: 1,
      dropped: 1,
    });
    const running = await listExperimentResults(web, { statuses: ["running"] });
    expect(running.map((experiment) => experiment.experimentId)).toEqual([
      seed.experiments.running.id,
    ]);
    // Newest publication first; the scheduled video (in the future) leads, the archived one is absent.
    const latest = await listVideoPerformance(web, { limit: 3 });
    expect(latest.map((video) => video.id)).toEqual([
      seed.videos.scheduled.id,
      seed.videos.editing.id,
      seed.videos.gear.id,
    ]);
    expect(latest[1]?.latest?.views).toBe("8000");
    const feed = await listEvents(web, { limit: 20 });
    expect(feed.events).toHaveLength(20);
    expect(feed.nextCursor).not.toBeNull();
  });

  it("answers the same through every application role", async () => {
    const counts = await Promise.all(
      APP_ROLES.map(async (role: AppRole) => {
        const { rows } = await db.pool(role).query<{ n: number; archived: number }>(
          `SELECT (SELECT count(*) FROM ideas_pipeline)::int AS n,
                  (SELECT count(*) FROM ideas_pipeline_all WHERE archived_at IS NOT NULL)::int AS archived`,
        );
        return rows[0];
      }),
    );
    expect(counts).toEqual([
      { n: 7, archived: 1 },
      { n: 7, archived: 1 },
      { n: 7, archived: 1 },
    ]);
  });

  it("rejects unknown stages and bad limits with an error that names the valid values", async () => {
    const web = db.pool("ytw_web");
    const stage = await rejectedWith(
      listIdeaPipeline(web, { stages: ["inbox", "nonsense" as never] }),
      ValidationError,
    );
    expect(stage.field).toBe("stages");
    expect(stage.allowed).toEqual([...IDEA_STAGES]);
    for (const limit of [0, -1, 1001, 1.5, Number.NaN]) {
      const err = await rejectedWith(listIdeaPipeline(web, { limit }), ValidationError);
      expect(err.field).toBe("limit");
    }
    expect(await listIdeaPipeline(web, { limit: 1 })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("ideas_pipeline edge cases and experiment_results", () => {
  let db: TestDb;
  const writer = newAgent("views-writer");
  const web = () => db.pool("ytw_web");
  const stats = (variantId: string, impressions: number | null, ctr: number | string | null) =>
    act(db, analyst, (tx) => recordVariantStats(tx, { variantId, impressions, ctr }));
  const find = async (id: string): Promise<ExperimentResultRecord> => {
    const found = (await listExperimentResults(web(), { experimentId: id }))[0];
    if (found === undefined) {
      throw new Error(`experiment ${id} is not in the results`);
    }
    return found;
  };

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.drop();
  });

  describe("the latest revision of each kind", () => {
    it("is the highest version, not the last one touched, and follows its own status", async () => {
      const idea = await newIdea(db);
      const saved = await act(db, writer, async (tx) => {
        const v1 = await saveScriptVersion(tx, {
          ideaId: idea.id,
          kind: "script",
          baseVersion: 0,
          bodyMd: "one",
        });
        const v2 = await saveScriptVersion(tx, {
          ideaId: idea.id,
          kind: "script",
          baseVersion: 1,
          bodyMd: "two",
        });
        const v3 = await saveScriptVersion(tx, {
          ideaId: idea.id,
          kind: "script",
          baseVersion: 2,
          bodyMd: "three",
        });
        return { v1, v2, v3 };
      });
      // Touching an OLD revision (its status) must not make it "latest".
      await act(db, writer, (tx) =>
        setScriptStatus(tx, { scriptId: saved.v1.id, status: "approved" }),
      );
      let row = (await listIdeaPipeline(db.pool("ytw_web"), { limit: 1000 })).find(
        (r) => r.id === idea.id,
      );
      expect(row?.latestScript).toMatchObject({ id: saved.v3.id, version: 3, status: "draft" });
      expect(row?.latestPackaging).toBeNull();
      // The status of the latest follows set_script_status.
      await act(db, writer, (tx) =>
        setScriptStatus(tx, { scriptId: saved.v3.id, status: "review" }),
      );
      row = (await listIdeaPipeline(db.pool("ytw_web"), { limit: 1000 })).find(
        (r) => r.id === idea.id,
      );
      expect(row?.latestScript).toMatchObject({ version: 3, status: "review" });
      // A new version replaces it.
      await act(db, writer, (tx) =>
        saveScriptVersion(tx, { ideaId: idea.id, kind: "script", baseVersion: 3, bodyMd: "four" }),
      );
      row = (await listIdeaPipeline(db.pool("ytw_web"), { limit: 1000 })).find(
        (r) => r.id === idea.id,
      );
      expect(row?.latestScript).toMatchObject({ version: 4, status: "draft" });
    });

    it("is tracked per kind: packaging only, script only, and both", async () => {
      const onlyPackaging = await newIdea(db);
      const both = await newIdea(db);
      await act(db, writer, async (tx) => {
        await saveScriptVersion(tx, {
          ideaId: onlyPackaging.id,
          kind: "packaging",
          baseVersion: 0,
          bodyMd: "p",
        });
        await saveScriptVersion(tx, {
          ideaId: both.id,
          kind: "script",
          baseVersion: 0,
          bodyMd: "s1",
        });
        await saveScriptVersion(tx, {
          ideaId: both.id,
          kind: "script",
          baseVersion: 1,
          bodyMd: "s2",
        });
        await saveScriptVersion(tx, {
          ideaId: both.id,
          kind: "packaging",
          baseVersion: 0,
          bodyMd: "p1",
        });
      });
      const rows = await listIdeaPipeline(db.pool("ytw_web"), { limit: 1000 });
      const only = rows.find((r) => r.id === onlyPackaging.id);
      expect(only?.latestScript).toBeNull();
      expect(only?.latestPackaging?.version).toBe(1);
      const other = rows.find((r) => r.id === both.id);
      expect(other?.latestScript?.version).toBe(2);
      expect(other?.latestPackaging?.version).toBe(1);
    });

    it("has exactly one row per idea however many revisions exist", async () => {
      const idea = await newIdea(db);
      await act(db, writer, async (tx) => {
        for (let base = 0; base < 5; base += 1) {
          await saveScriptVersion(tx, {
            ideaId: idea.id,
            kind: "script",
            baseVersion: base,
            bodyMd: `v${base + 1}`,
          });
          await saveScriptVersion(tx, {
            ideaId: idea.id,
            kind: "packaging",
            baseVersion: base,
            bodyMd: `p${base + 1}`,
          });
        }
      });
      const ids = await pipelineIds(db);
      expect(ids.filter((id) => id === idea.id)).toHaveLength(1);
    });

    it("mirrors SCRIPT_KINDS: one id/version/status/at column set per kind and no others", async () => {
      const { rows } = await db.admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'ideas_pipeline' AND column_name LIKE 'latest\\_%'
          ORDER BY column_name`,
      );
      const expected = SCRIPT_KINDS.flatMap((kind) =>
        ["id", "version", "status", "at"].map((part) => `latest_${kind}_${part}`),
      ).toSorted();
      expect(rows.map((row) => row.column_name).toSorted()).toEqual(expected);
    });
  });

  describe("age in stage", () => {
    it("starts at the stage change, resets with a move and ignores other edits", async () => {
      const idea = await newIdea(db);
      // Backdate the clock the way a fixture can: the row is replaced by one with an old stage time.
      const old = await withActor(db.admin, alice, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO ideas (title, status, status_changed_at, created_at)
           VALUES ('Aged idea', 'scripting', now() - interval '221 hours', now() - interval '720 hours')
           RETURNING id`,
        );
        return rows[0]?.id as string;
      });
      const row = async (id: string) =>
        (await listIdeaPipeline(db.pool("ytw_web"), { limit: 1000 })).find((r) => r.id === id);
      expect((await row(old))?.daysInStage).toBe(9);
      expect((await row(idea.id))?.daysInStage).toBe(0);

      // Editing a field does not restart the clock ...
      const edited = await act(db, alice, (tx) =>
        updateIdea(tx, { id: old, expectedVersion: 1, fields: { pitch: "now with a pitch" } }),
      );
      expect((await row(old))?.daysInStage).toBe(9);
      expect((await row(old))?.statusChangedAt).toEqual(edited.statusChangedAt);
      // ... a stage change does.
      await act(db, alice, (tx) => advanceIdea(tx, { id: old, newStatus: "filming" }));
      const moved = await row(old);
      expect(moved?.status).toBe("filming");
      expect(moved?.daysInStage).toBe(0);
      expect(secondsSince(moved?.statusChangedAt as Date)).toBeLessThan(60);
      expect(moved?.ageInStageSeconds).toBeLessThan(60);
    });

    it("is never negative, even for a stage clock in the future", async () => {
      const id = await withActor(db.admin, alice, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO ideas (title, status_changed_at) VALUES ('From the future', now() + interval '48 hours')
           RETURNING id`,
        );
        return rows[0]?.id as string;
      });
      const row = (await listIdeaPipeline(db.pool("ytw_web"), { limit: 1000 })).find(
        (r) => r.id === id,
      );
      expect(row?.ageInStageSeconds).toBe(0);
      expect(row?.daysInStage).toBe(0);
      const { rows } = await db
        .pool("ytw_readonly")
        .query<{ age: string; days: number }>(
          `SELECT age_in_stage::text AS age, days_in_stage AS days FROM ideas_pipeline WHERE id = $1`,
          [id],
        );
      expect(rows[0]).toEqual({ age: "00:00:00", days: 0 });
    });

    it("counts whole days: 23 hours is day 0, 24 hours is day 1, 49 hours is day 2", async () => {
      const ids = await withActor(db.admin, alice, async (tx) => {
        const made: Record<string, string> = {};
        for (const hours of [23, 25, 49]) {
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO ideas (title, status_changed_at) VALUES ($1, now() - make_interval(hours => $2::integer))
             RETURNING id`,
            [`${String(hours)} hours old`, hours],
          );
          made[String(hours)] = rows[0]?.id as string;
        }
        return made;
      });
      const rows = await listIdeaPipeline(db.pool("ytw_web"), { limit: 1000 });
      const days = (hours: string) => rows.find((r) => r.id === ids[hours])?.daysInStage;
      expect([days("23"), days("25"), days("49")]).toEqual([0, 1, 2]);
    });
  });

  describe("ties, passthrough and ordering", () => {
    it("lists ideas with an identical stage clock, each once, in a fixed order", async () => {
      const ids = await withActor(db.admin, alice, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO ideas (title, status, status_changed_at)
           SELECT 'Tied ' || g, 'filming', timestamptz '2026-01-01 12:00:00+00' FROM generate_series(1, 4) g
           RETURNING id`,
        );
        return rows.map((row) => row.id);
      });
      const tied = (
        await listIdeaPipeline(db.pool("ytw_web"), { stages: ["filming"], limit: 1000 })
      ).filter((row) => ids.includes(row.id));
      expect(tied.map((row) => row.id)).toEqual(ids.toSorted().toReversed());
    });

    it("passes score, source, tags and hostile text through untouched", async () => {
      const nasty = `Robert'); DROP TABLE ideas;-- <script>alert(1)</script> \u{1F3AC} ${"x".repeat(400)}`;
      const idea = await newIdea(db, {
        title: nasty.slice(0, 500),
        pitch: "multi\nline\tpitch with <b>markup</b> & entities",
        source: "an agent",
        tags: ["alpha", "beta gamma"],
        score: 0,
      });
      const row = (await listIdeaPipeline(db.pool("ytw_web"), { limit: 1000 })).find(
        (r) => r.id === idea.id,
      );
      expect(row).toMatchObject({
        title: nasty.slice(0, 500),
        source: "an agent",
        tags: ["alpha", "beta gamma"],
        score: 0,
        createdBy: "alice",
        updatedBy: "alice",
        version: 1,
      });
      const unscored = await newIdea(db);
      const rows = await listIdeaPipeline(db.pool("ytw_web"), { limit: 1000 });
      expect(rows.find((r) => r.id === unscored.id)?.score).toBeNull();
    });

    it("is a superset of the ideas table: the same columns with the same types, minus search_vector", async () => {
      const { search_vector: _derived, ...ideas } = await tableColumns(db, "ideas");
      expect(Object.keys(ideas)).toContain("title");
      for (const view of ["ideas_pipeline", "ideas_pipeline_all"]) {
        const viewColumns = await tableColumns(db, view);
        expect(viewColumns).toMatchObject(ideas);
        expect(viewColumns).not.toHaveProperty("search_vector");
        expect(Object.keys(viewColumns)).toEqual(
          expect.arrayContaining(["age_in_stage", "days_in_stage"]),
        );
      }
    });

    it("hides an idea that is archived later, and shows it again through the _all view", async () => {
      const idea = await newIdea(db);
      expect(await pipelineIds(db)).toContain(idea.id);
      await act(db, alice, (tx) => archiveIdea(tx, { id: idea.id }));
      expect(await pipelineIds(db)).not.toContain(idea.id);
      const all = await listIdeaPipeline(db.pool("ytw_web"), {
        includeArchived: true,
        limit: 1000,
      });
      expect(all.find((row) => row.id === idea.id)?.archivedAt).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("experiment_results", () => {
    it("lists the variants side by side, the control first, with nothing computed before stats exist", async () => {
      const experiment = await newExperiment(db, {
        variants: [
          { label: "Alpha", content: "a" },
          { label: "Zeta", content: "z", isControl: true },
          { label: "Beta", content: "b" },
        ],
      });
      const result = await find(experiment.id);
      expect(result).toMatchObject({
        experimentId: experiment.id,
        videoId: experiment.videoId,
        videoTitle: "A video",
        type: "title",
        status: "planned",
        hypothesis: "A bolder title raises the CTR",
        winnerVariantId: null,
        conclusion: null,
        controlVariantId: byLabel(result, "Zeta").variantId,
      });
      expect(result.variants.map((variant) => variant.label)).toEqual(["Zeta", "Alpha", "Beta"]);
      for (const variant of result.variants) {
        expect(variant).toMatchObject({
          impressions: null,
          ctr: null,
          ctrVsControl: null,
          ctrLiftPct: null,
          isWinner: false,
        });
      }
      expect(result.variants.map((variant) => variant.isControl)).toEqual([true, false, false]);
      expect(result.variants.map((variant) => variant.content)).toEqual(["z", "a", "b"]);
    });

    it("computes the CTR difference and lift against the control, for every variant", async () => {
      const experiment = await runningExperiment(db, {
        variants: [
          { label: "A", content: "control", isControl: true },
          { label: "B", content: "better" },
          { label: "C", content: "worse" },
          { label: "D", content: "same" },
        ],
      });
      const id = (label: string) =>
        experiment.variants.find((v) => v.label === label)?.id as string;
      await stats(id("A"), 10000, 4.0);
      await stats(id("B"), 10500, 5.0);
      await stats(id("C"), 9800, 3.0);
      await stats(id("D"), 10100, 4.0);
      const result = await find(experiment.id);
      const row = (label: string) => {
        const v = byLabel(result, label);
        return [dec(v.ctr), dec(v.ctrVsControl), dec(v.ctrLiftPct), v.impressions];
      };
      expect(row("A")).toEqual(["4", "0", "0", "10000"]); // the control against itself
      expect(row("B")).toEqual(["5", "1", "25", "10500"]);
      expect(row("C")).toEqual(["3", "-1", "-25", "9800"]);
      expect(row("D")).toEqual(["4", "0", "0", "10100"]); // a tie with the control
      expect(result.variants.map((variant) => variant.isWinner)).toEqual([
        false,
        false,
        false,
        false,
      ]);
    });

    it("rounds the lift to 4 decimals and keeps the difference exact", async () => {
      const experiment = await runningExperiment(db);
      const [control, other] = experiment.variants;
      await stats(control?.id as string, 1000, 3);
      await stats(other?.id as string, 1000, 4);
      const third = byLabel(await find(experiment.id), "B");
      expect(dec(third.ctrVsControl)).toBe("1");
      expect(third.ctrLiftPct).toBe("33.3333");

      const exact = await runningExperiment(db);
      await stats(exact.variants[0]?.id as string, 1000, "4.50");
      await stats(exact.variants[1]?.id as string, 1000, "4.52");
      const b = byLabel(await find(exact.id), "B");
      expect(dec(b.ctrVsControl)).toBe("0.02"); // not 0.0200000000000000177...
      expect(dec(b.ctrLiftPct)).toBe("0.4444");
    });

    it("leaves the lift undefined when the control's CTR is 0, and the difference too when it is unknown", async () => {
      const zero = await runningExperiment(db);
      await stats(zero.variants[0]?.id as string, 100, 0);
      await stats(zero.variants[1]?.id as string, 100, 2.5);
      const b = byLabel(await find(zero.id), "B");
      expect(dec(b.ctrVsControl)).toBe("2.5");
      expect(b.ctrLiftPct).toBeNull();

      const unknownControl = await runningExperiment(db);
      await stats(unknownControl.variants[1]?.id as string, 100, 2.5);
      const result = await find(unknownControl.id);
      expect(byLabel(result, "B")).toMatchObject({
        ctr: "2.5",
        ctrVsControl: null,
        ctrLiftPct: null,
      });
      expect(byLabel(result, "A")).toMatchObject({ ctr: null, ctrVsControl: null });

      const unknownVariant = await runningExperiment(db);
      await stats(unknownVariant.variants[0]?.id as string, 100, 2.5);
      const second = await find(unknownVariant.id);
      expect(byLabel(second, "B")).toMatchObject({
        ctr: null,
        ctrVsControl: null,
        ctrLiftPct: null,
      });
      expect(dec(byLabel(second, "A").ctrVsControl)).toBe("0");
    });

    it("flags the winner that conclude_experiment named, only that one, and nobody otherwise", async () => {
      const experiment = await runningExperiment(db, {
        variants: [
          { label: "A", content: "control", isControl: true },
          { label: "B", content: "b" },
          { label: "C", content: "c" },
        ],
      });
      const id = (label: string) =>
        experiment.variants.find((v) => v.label === label)?.id as string;
      expect((await find(experiment.id)).variants.some((variant) => variant.isWinner)).toBe(false);
      await act(db, analyst, (tx) =>
        concludeExperiment(tx, {
          id: experiment.id,
          expectedVersion: experiment.version,
          winnerVariantId: id("C"),
          conclusion: "C wins",
        }),
      );
      const result = await find(experiment.id);
      expect(result).toMatchObject({
        status: "concluded",
        conclusion: "C wins",
        winnerVariantId: id("C"),
      });
      expect(result.variants.map((v) => [v.label, v.isWinner])).toEqual([
        ["A", false],
        ["B", false],
        ["C", true],
      ]);

      // Concluded without a winner (the control stays): nobody is flagged.
      const none = await runningExperiment(db);
      await act(db, analyst, (tx) =>
        concludeExperiment(tx, {
          id: none.id,
          expectedVersion: none.version,
          winnerVariantId: null,
          conclusion: "No clear winner",
        }),
      );
      const noWinner = await find(none.id);
      expect(noWinner.status).toBe("concluded");
      expect(noWinner.variants.some((variant) => variant.isWinner)).toBe(false);

      // Cancelled experiments are listed too, with no winner.
      const cancelled = await newExperiment(db);
      await setExperimentStatus(db, cancelled, "cancelled");
      const gone = await find(cancelled.id);
      expect(gone.status).toBe("cancelled");
      expect(gone.variants.some((variant) => variant.isWinner)).toBe(false);
    });

    it("is_winner agrees with winner_variant_id on every row, and every experiment has one control row", async () => {
      const { rows } = await db.admin.query<{ bad: number; controls_off: number }>(
        `SELECT (SELECT count(*) FROM experiment_results
                  WHERE is_winner IS DISTINCT FROM (winner_variant_id IS NOT NULL AND variant_id = winner_variant_id))::int AS bad,
                (SELECT count(*) FROM (SELECT experiment_id FROM experiment_results GROUP BY experiment_id
                                       HAVING count(*) FILTER (WHERE is_control) <> 1) t)::int AS controls_off`,
      );
      expect(rows[0]).toEqual({ bad: 0, controls_off: 0 });
    });

    it("includes the experiments of an archived video, newest first, and filters by video, status and id", async () => {
      const video = await newVideo(db, { title: "Archive me" });
      const first = await newExperiment(db, { videoId: video.id });
      await tick();
      const second = await newExperiment(db, { videoId: video.id, type: "thumbnail" });
      await act(db, analyst, (tx) => archiveVideo(tx, { id: video.id }));
      await setExperimentStatus(db, second, "running");

      const forVideo = await listExperimentResults(web(), { videoId: video.id });
      expect(forVideo.map((e) => e.experimentId)).toEqual([second.id, first.id]);
      expect(forVideo.every((e) => e.videoTitle === "Archive me")).toBe(true);
      expect(forVideo.map((e) => e.status)).toEqual(["running", "planned"]);
      expect(forVideo.flatMap((e) => e.variants)).toHaveLength(4);

      expect(
        (await listExperimentResults(web(), { videoId: video.id, statuses: ["running"] })).map(
          (e) => e.experimentId,
        ),
      ).toEqual([second.id]);
      expect(
        await listExperimentResults(web(), {
          videoId: video.id,
          statuses: ["concluded", "cancelled"],
        }),
      ).toEqual([]);
      expect((await listExperimentResults(web(), { experimentId: first.id }))[0]?.type).toBe(
        "title",
      );
      // The limit counts experiments, not variant rows: one experiment with all of its variants.
      const limited = await listExperimentResults(web(), { videoId: video.id, limit: 1 });
      expect(limited.map((e) => e.experimentId)).toEqual([second.id]);
      expect(limited[0]?.variants).toHaveLength(2);
    });

    it("keeps an experiment without a control (not possible through the functions) with undefined differences", async () => {
      const video = await newVideo(db);
      const id = await withActor(db.admin, alice, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          "INSERT INTO experiments (video_id, type) VALUES ($1, 'title') RETURNING id",
          [video.id],
        );
        const experimentId = rows[0]?.id as string;
        await tx.query(
          `INSERT INTO experiment_variants (experiment_id, label, content, ctr)
           VALUES ($1, 'X', 'x', 3.0), ($1, 'Y', 'y', 4.0)`,
          [experimentId],
        );
        return experimentId;
      });
      const result = await find(id);
      expect(result.controlVariantId).toBeNull();
      expect(result.variants.map((v) => [v.ctrVsControl, v.ctrLiftPct])).toEqual([
        [null, null],
        [null, null],
      ]);
    });

    it("rejects malformed filters with readable validation errors", async () => {
      const bad = await rejectedWith(
        listExperimentResults(web(), { experimentId: "nope" }),
        ValidationError,
      );
      expect(bad.field).toBe("experiment_id");
      expect(
        (await rejectedWith(listExperimentResults(web(), { videoId: "nope" }), ValidationError))
          .field,
      ).toBe("video_id");
      const status = await rejectedWith(
        listExperimentResults(web(), { statuses: ["running", "done" as never] }),
        ValidationError,
      );
      expect(status.allowed).toEqual([...EXPERIMENT_STATUSES]);
      for (const limit of [0, 1001]) {
        expect(
          (await rejectedWith(listExperimentResults(web(), { limit }), ValidationError)).field,
        ).toBe("limit");
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe("video_performance_summary", () => {
  let db: TestDb;
  const web = () => db.pool("ytw_web");

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.drop();
  });

  /** Every test starts from an empty channel: archived videos are out of the rows and the medians. */
  afterEach(async () => {
    await withActor(db.admin, alice, (tx) =>
      tx.query("UPDATE videos SET archived_at = now() WHERE archived_at IS NULL"),
    );
  });

  const video = (title = "A video", publishedAt?: string) =>
    newVideo(db, { title, ...(publishedAt === undefined ? {} : { publishedAt }) }, analyst);

  const snapshot = (videoId: string, daysAgo: number, metrics: MetricValues) =>
    act(db, analyst, (tx) =>
      logMetrics(tx, {
        videoId,
        capturedAt: new Date(Date.now() - daysAgo * 86_400_000),
        metrics,
      }),
    );

  /** Creates one video per entry with a latest snapshot of those metrics. */
  async function channel(metrics: MetricValues[]): Promise<VideoPerformanceRecord[]> {
    const ids: string[] = [];
    for (const [index, values] of metrics.entries()) {
      const created = await video(`Video ${String(index + 1)}`);
      await snapshot(created.id, 1, values);
      ids.push(created.id);
    }
    const rows = await listVideoPerformance(web(), { limit: 1000 });
    return ids.map((id) => {
      const row = rows.find((r) => r.id === id);
      if (row === undefined) {
        throw new Error(`video ${id} is not in the summary`);
      }
      return row;
    });
  }

  it("shows a video without any snapshot with NULL metrics and NULL differences", async () => {
    const created = await video("No metrics yet");
    const [row] = await listVideoPerformance(web());
    expect(row).toMatchObject({
      id: created.id,
      youtubeId: created.youtubeId,
      title: "No metrics yet",
      latest: null,
      median: { sampleSize: 0, views: null, ctr: null },
      vsMedian: {
        views: null,
        impressions: null,
        ctr: null,
        avgViewDurationS: null,
        avgViewPct: null,
        watchTimeMin: null,
        subsGained: null,
      },
    });
  });

  it("with a single video the channel median is that video itself, so every difference is 0", async () => {
    const [row] = await channel([
      {
        views: 1234,
        impressions: 50000,
        ctr: 4.52,
        avgViewDurationS: 210.5,
        avgViewPct: 47.25,
        watchTimeMin: 4321.5,
        subsGained: -3,
      },
    ]);
    expect(row?.median.sampleSize).toBe(1);
    expect(row?.latest).toMatchObject({
      views: "1234",
      impressions: "50000",
      ctr: "4.52",
      avgViewDurationS: "210.5",
      avgViewPct: "47.25",
      watchTimeMin: "4321.5",
      subsGained: -3,
    });
    expect(
      [
        row?.median.views,
        row?.median.ctr,
        row?.median.avgViewDurationS,
        row?.median.subsGained,
      ].map(dec),
    ).toEqual(["1234", "4.52", "210.5", "-3"]);
    for (const delta of Object.values(row?.vsMedian ?? {})) {
      expect(dec(delta)).toBe("0");
    }
  });

  it("computes the median and the differences over the latest snapshots (odd count)", async () => {
    const rows = await channel([
      {
        views: 100,
        impressions: 1000,
        ctr: 4,
        avgViewDurationS: 60,
        avgViewPct: 30.5,
        watchTimeMin: 10,
        subsGained: -5,
      },
      {
        views: 200,
        impressions: 3000,
        ctr: 5,
        avgViewDurationS: 120,
        avgViewPct: 45.25,
        watchTimeMin: 20,
        subsGained: 10,
      },
      {
        views: 600,
        impressions: 2000,
        ctr: 6,
        avgViewDurationS: 90,
        avgViewPct: 120,
        watchTimeMin: 30,
        subsGained: 20,
      },
    ]);
    const medians = rows[0]?.median;
    expect(medians?.sampleSize).toBe(3);
    expect(
      [
        medians?.views,
        medians?.impressions,
        medians?.ctr,
        medians?.avgViewDurationS,
        medians?.avgViewPct,
        medians?.watchTimeMin,
        medians?.subsGained,
      ].map(dec),
    ).toEqual(["200", "2000", "5", "90", "45.25", "20", "10"]);
    const deltas = (metric: keyof VideoPerformanceRecord["vsMedian"]) =>
      rows.map((row) => dec(row.vsMedian[metric]));
    expect(deltas("views")).toEqual(["-100", "0", "400"]);
    expect(deltas("impressions")).toEqual(["-1000", "1000", "0"]);
    expect(deltas("ctr")).toEqual(["-1", "0", "1"]);
    expect(deltas("avgViewDurationS")).toEqual(["-30", "30", "0"]);
    expect(deltas("avgViewPct")).toEqual(["-14.75", "0", "74.75"]);
    expect(deltas("watchTimeMin")).toEqual(["-10", "0", "10"]);
    expect(deltas("subsGained")).toEqual(["-15", "0", "10"]);
  });

  it("interpolates between the two middle values for an even count", async () => {
    const rows = await channel([
      { views: 100, subsGained: 1 },
      { views: 200, subsGained: 2 },
      { views: 300, subsGained: 4 },
      { views: 600, subsGained: 8 },
    ]);
    expect(dec(rows[0]?.median.views ?? null)).toBe("250");
    expect(rows.map((row) => dec(row.vsMedian.views))).toEqual(["-150", "-50", "50", "350"]);
    expect(dec(rows[0]?.median.subsGained ?? null)).toBe("3"); // (2 + 4) / 2
  });

  it("medians of whole numbers can be fractional", async () => {
    const half = await channel([{ subsGained: 1 }, { subsGained: 2 }]);
    expect(dec(half[0]?.median.subsGained ?? null)).toBe("1.5");
    expect(half.map((row) => dec(row.vsMedian.subsGained))).toEqual(["-0.5", "0.5"]);
  });

  it("copes with ties: equal values share the median and give a difference of 0", async () => {
    const rows = await channel([{ views: 500 }, { views: 500 }, { views: 500 }, { views: 900 }]);
    expect(dec(rows[0]?.median.views ?? null)).toBe("500");
    expect(rows.map((row) => dec(row.vsMedian.views))).toEqual(["0", "0", "0", "400"]);
    const allTied = await channel([{ ctr: 3.5 }, { ctr: 3.5 }]);
    expect(allTied.map((row) => dec(row.vsMedian.ctr))).toEqual(["0", "0"]);
  });

  it("skips what was not measured: the median of a metric covers only the videos that have it", async () => {
    const rows = await channel([
      { views: 100, ctr: 4 },
      { views: 200 }, // no ctr
      { views: 300, ctr: 6 },
    ]);
    expect(rows[0]?.median.sampleSize).toBe(3);
    expect(dec(rows[0]?.median.views ?? null)).toBe("200");
    expect(dec(rows[0]?.median.ctr ?? null)).toBe("5"); // over 4 and 6 only
    expect(rows[1]?.latest?.ctr).toBeNull();
    expect(rows[1]?.vsMedian.ctr).toBeNull();
    expect(rows.map((row) => dec(row.vsMedian.ctr))).toEqual(["-1", null, "1"]);
    // A metric that nobody measured has a NULL median.
    expect(rows[0]?.median.impressions).toBeNull();
    expect(rows[0]?.vsMedian.impressions).toBeNull();
  });

  it("uses the latest snapshot as stored: by capture time, not by insertion, and never carries an older value over", async () => {
    const created = await video();
    // Inserted newest first: the latest is still the one with the greatest captured_at.
    await snapshot(created.id, 1, { views: 900, ctr: 5 });
    await snapshot(created.id, 10, { views: 10, ctr: 1 });
    await snapshot(created.id, 5, { views: 400, ctr: 3 });
    let [row] = await listVideoPerformance(web(), { videoId: created.id });
    expect(row?.latest).toMatchObject({ views: "900", ctr: "5" });
    // A newer snapshot that did not measure ctr has no ctr, although older snapshots did.
    await snapshot(created.id, 0.5, { views: 950 });
    [row] = await listVideoPerformance(web(), { videoId: created.id });
    expect(row?.latest?.views).toBe("950");
    expect(row?.latest?.ctr).toBeNull();
    expect(row?.vsMedian.ctr).toBeNull();
  });

  it("keeps videos without snapshots out of the median and counts only measured videos in the sample", async () => {
    await video("Unmeasured one");
    await video("Unmeasured two");
    const rows = await channel([{ views: 10 }, { views: 30 }]);
    expect(rows[0]?.median.sampleSize).toBe(2);
    expect(dec(rows[0]?.median.views ?? null)).toBe("20");
    const all = await listVideoPerformance(web(), { limit: 1000 });
    expect(all).toHaveLength(4);
    expect(all.filter((row) => row.latest === null)).toHaveLength(2);
    expect(all.every((row) => row.median.sampleSize === 2)).toBe(true);
  });

  it("leaves archived videos out of the rows and out of the median", async () => {
    const rows = await channel([{ views: 100 }, { views: 200 }, { views: 300 }]);
    expect(dec(rows[0]?.median.views ?? null)).toBe("200");
    const outlier = await video("Outlier");
    await snapshot(outlier.id, 1, { views: 1_000_000 });
    expect(dec((await listVideoPerformance(web(), { limit: 1000 }))[0]?.median.views ?? null)).toBe(
      "250",
    );
    await act(db, analyst, (tx) => archiveVideo(tx, { id: outlier.id }));
    const after = await listVideoPerformance(web(), { limit: 1000 });
    expect(after.map((row) => row.id)).not.toContain(outlier.id);
    expect(after).toHaveLength(3);
    expect(dec(after[0]?.median.views ?? null)).toBe("200");
    expect(after[0]?.median.sampleSize).toBe(3);
  });

  it("keeps exact values exact, and survives the extremes of every column", async () => {
    const rows = await channel([
      {
        views: "9007199254740993",
        impressions: "9223372036854775807",
        ctr: 100,
        avgViewPct: 10000,
        subsGained: 2147483647,
      },
      { views: 0, impressions: 0, ctr: 0, avgViewPct: 0, subsGained: -2147483648 },
    ]);
    expect(rows[0]?.latest).toMatchObject({
      views: "9007199254740993", // 2^53 + 1: a double would round it
      impressions: "9223372036854775807",
      ctr: "100",
      avgViewPct: "10000",
      subsGained: 2147483647,
    });
    expect(rows[1]?.latest).toMatchObject({ views: "0", ctr: "0", subsGained: -2147483648 });
    expect(rows[0]?.median.sampleSize).toBe(2);
    // Medians and differences are defined and finite (no overflow in the double precision step).
    expect(Math.abs(Number(rows[0]?.median.impressions) / 4.611686018427388e18 - 1)).toBeLessThan(
      1e-12,
    );
    expect(dec(rows[0]?.median.ctr ?? null)).toBe("50");
    expect(dec(rows[1]?.vsMedian.ctr ?? null)).toBe("-50");
    expect(dec(rows[0]?.median.subsGained ?? null)).toBe("-0.5");
  });

  it("does not show floating point noise: the median of 4.1 and 4.2 is 4.15", async () => {
    const rows = await channel([{ ctr: "4.1" }, { ctr: "4.2" }]);
    expect(rows[0]?.median.ctr).toBe("4.15");
    expect(rows.map((row) => dec(row.vsMedian.ctr))).toEqual(["-0.05", "0.05"]);
  });

  it("nor for 0.1, 0.2 and 0.3", async () => {
    const thirds = await channel([{ ctr: "0.1" }, { ctr: "0.2" }, { ctr: "0.3" }]);
    expect(thirds[0]?.median.ctr).toBe("0.2");
  });

  it("lists scheduled and unscheduled videos too, newest publication first and unscheduled last", async () => {
    const past = await video("Past", new Date(Date.now() - 10 * 86_400_000).toISOString());
    const scheduled = await video("Scheduled", new Date(Date.now() + 5 * 86_400_000).toISOString());
    const unscheduled = await video("Unscheduled");
    const recent = await video("Recent", new Date(Date.now() - 86_400_000).toISOString());
    const rows = await listVideoPerformance(web());
    expect(rows.map((row) => row.id)).toEqual([scheduled.id, recent.id, past.id, unscheduled.id]);
    expect(rows[0]?.publishedAt?.getTime()).toBeGreaterThan(Date.now());
    expect(rows[3]?.publishedAt).toBeNull();
  });

  it("filters one video but keeps the channel-wide median, and checks its arguments", async () => {
    const rows = await channel([{ views: 10 }, { views: 20 }, { views: 90 }]);
    const only = await listVideoPerformance(web(), { videoId: rows[2]?.id as string });
    expect(only).toHaveLength(1);
    expect(dec(only[0]?.median.views ?? null)).toBe("20"); // not 90: the median of all three
    expect(dec(only[0]?.vsMedian.views ?? null)).toBe("70");
    expect(
      await listVideoPerformance(web(), { videoId: "00000000-0000-7000-8000-000000000000" }),
    ).toEqual([]);
    expect(
      (await rejectedWith(listVideoPerformance(web(), { videoId: "x" }), ValidationError)).field,
    ).toBe("video_id");
    expect(await listVideoPerformance(web(), { limit: 2 })).toHaveLength(2);
    expect(
      (await rejectedWith(listVideoPerformance(web(), { limit: 0 }), ValidationError)).field,
    ).toBe("limit");
  });

  it("computes the median with percentile_cont (the contract of the card)", async () => {
    const { rows } = await db.admin.query<{ definition: string }>(
      "SELECT pg_get_viewdef('public.video_performance_summary'::regclass) AS definition",
    );
    expect(rows[0]?.definition).toContain("percentile_cont");
  });
});

// ---------------------------------------------------------------------------------------------
describe("access: grants, invoker rights and what the views must never expose", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await seedSmall(db);
  });

  afterAll(async () => {
    await db.drop();
  });

  it("every application role can SELECT each view, and nobody can write to it or inherit it from PUBLIC", async () => {
    const { rows } = await db.admin.query<{
      role: string;
      view: string;
      priv: string;
      granted: boolean;
    }>(
      `SELECT r AS role, v AS view, p AS priv, has_table_privilege(r, ('public.' || v)::regclass, p) AS granted
         FROM unnest($1::text[]) AS r, unnest($2::text[]) AS v,
              unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p`,
      [[...APP_ROLES], [...VIEWS]],
    );
    expect(rows).toHaveLength(APP_ROLES.length * VIEWS.length * 7);
    // Only SELECT is granted: list every (role, view, privilege) that deviates.
    expect(rows.filter((row) => row.granted !== (row.priv === "SELECT"))).toEqual([]);
    const { rows: publicRows } = await db.admin.query<{ view: string }>(
      `SELECT c.relname AS view FROM pg_class c, aclexplode(c.relacl) a
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[]) AND a.grantee = 0`,
      [[...VIEWS]],
    );
    expect(publicRows).toEqual([]);
  });

  it("every view is security_invoker and documented", async () => {
    const { rows } = await db.admin.query<{
      relname: string;
      options: string[] | null;
      comment: string | null;
    }>(
      `SELECT c.relname, c.reloptions AS options, obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])
        ORDER BY c.relname`,
      [[...VIEWS]],
    );
    expect(rows.map((row) => row.relname).toSorted()).toEqual([...VIEWS].toSorted());
    for (const row of rows) {
      expect(row.options).toContain("security_invoker=true");
      expect((row.comment ?? "").length).toBeGreaterThan(20);
    }
  });

  it("the views really run with the caller's rights: no SELECT on a table means no rows from the view", async () => {
    const cases = [
      { role: "ytw_web", table: "scripts", view: "ideas_pipeline" },
      { role: "ytw_mcp", table: "ideas", view: "ideas_pipeline_all" },
      { role: "ytw_readonly", table: "video_metrics", view: "video_performance_summary" },
      { role: "ytw_web", table: "videos", view: "video_performance_summary" },
      { role: "ytw_mcp", table: "experiment_variants", view: "experiment_results" },
      { role: "ytw_readonly", table: "experiments", view: "experiment_results" },
    ] as const;
    for (const { role, table, view } of cases) {
      const query = () => db.pool(role).query(`SELECT count(*) FROM public.${view}`);
      expect((await query()).rows).toHaveLength(1);
      await db.admin.query(`REVOKE SELECT ON public.${table} FROM ${role}`);
      try {
        expect(await sqlstate(query())).toBe("42501");
      } finally {
        await db.admin.query(`GRANT SELECT ON public.${table} TO ${role}`);
      }
      expect((await query()).rows).toHaveLength(1);
    }
  });

  it("the views read only the content tables: no users, user_permissions or ytw_private relation, directly or through another view", async () => {
    const { rows } = await db.admin.query<{ name: string }>(
      `WITH RECURSIVE walk (oid) AS (
         SELECT ('public.' || v)::regclass::oid FROM unnest($1::text[]) AS v
         UNION
         SELECT d.refobjid
           FROM walk w
           JOIN pg_rewrite r ON r.ev_class = w.oid
           JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
                           AND d.refclassid = 'pg_class'::regclass AND d.refobjid <> w.oid
       )
       SELECT n.nspname || '.' || c.relname AS name
         FROM walk w JOIN pg_class c ON c.oid = w.oid JOIN pg_namespace n ON n.oid = c.relnamespace
        ORDER BY 1`,
      [[...VIEWS]],
    );
    expect(rows.map((row) => row.name).toSorted()).toEqual(
      [
        "public.experiment_results",
        "public.experiment_variants",
        "public.experiments",
        "public.ideas",
        "public.ideas_pipeline",
        "public.ideas_pipeline_all",
        "public.scripts",
        "public.video_metrics",
        "public.video_performance_summary",
        "public.videos",
      ].toSorted(),
    );
  });

  it("no column of any view carries identity or secret data", async () => {
    const { rows } = await db.admin.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
          AND column_name ~* '(token|secret|hash|password|email|oidc|cookie|credential|session|user)'`,
      [[...VIEWS]],
    );
    expect(rows).toEqual([]);
  });

  it("ytw_readonly reads the views but not users, user_permissions or ytw_private", async () => {
    const readonly = db.pool("ytw_readonly");
    for (const view of VIEWS) {
      const { rows } = await readonly.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.${view}`,
      );
      expect(rows[0]?.n).toBeGreaterThan(0);
    }
    for (const relation of [
      "public.users",
      "public.user_permissions",
      "ytw_private.api_tokens",
      "ytw_private.api_token_permissions",
      "ytw_private.web_sessions",
    ]) {
      expect(await sqlstate(readonly.query(`SELECT count(*) FROM ${relation}`))).toBe("42501");
    }
    // The views cannot be changed through any role either (the guard checks the privileges; try it).
    for (const role of APP_ROLES) {
      expect(await sqlstate(db.pool(role).query("DELETE FROM public.ideas_pipeline_all"))).toMatch(
        /^(42501|25006|55000)$/,
      );
      expect(
        await sqlstate(
          db.pool(role).query("UPDATE public.video_performance_summary SET title = 'x'"),
        ),
      ).toMatch(/^(42501|25006|55000)$/);
    }
  });

  it("the catalog guard is clean after the migrations of T15, and none of them needed an allowlist row", async () => {
    const { rows } = await db.admin.query("SELECT * FROM public.ytw_catalog_violations()");
    expect(rows).toEqual([]);
    const { rows: allowlisted } = await db.admin.query<{ object: string }>(
      `SELECT object FROM ytw_private.catalog_allowlist
        WHERE object ~ '(ideas_pipeline|video_performance_summary|experiment_results|search_all|list_events)'`,
    );
    expect(allowlisted).toEqual([]);
  });
});
