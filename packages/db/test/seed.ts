// Reusable seed data for the tests and for performance work (T15). Not a test file.
//
//   seedSmall(db)  a handful of records with known content, built through the real functions (so the
//                  audit log holds real events) and a few direct inserts where a stage or a timestamp
//                  has to be backdated. Every value the tests of the views, the search and the
//                  activity feed rely on is documented next to it.
//   seedLarge(db)  thousands of rows in a few seconds: one transaction of bulk INSERT ... SELECT
//                  generate_series(...) on the admin connection, with the row triggers switched off
//                  (session_replication_role = replica) and the events written synthetically, so the
//                  load costs milliseconds per thousand rows instead of an audit trigger per row.
//                  The data is deterministic: the same options give the same rows, with fixed ids
//                  (seedUuid) and times relative to the moment of seeding.
//
// Both leave the database analysed, so query plans match what a real, busy database would use.
import type { IdeaStage } from "@ytw/shared/constants";
import { withActor, type Actor } from "../src/client.js";
import {
  concludeExperiment,
  createExperiment,
  recordVariantStats,
  updateExperimentStatus,
  type ExperimentWithVariants,
} from "../src/experiments.js";
import { archiveIdea, getIdea, type IdeaRecord } from "../src/ideas.js";
import { logMetrics } from "../src/metrics.js";
import { saveScriptVersion, setScriptStatus, type ScriptRecord } from "../src/scripts.js";
import type { TestDb } from "../src/testing.js";
import { archiveVideo, registerVideo, type VideoRecord } from "../src/videos.js";
import { act, alice, newAgent } from "./content-helpers.js";

// ---------------------------------------------------------------------------------------------
// The small, deterministic dataset

/** The idea of each stage plus an archived one, and what each was seeded with. */
export interface SmallSeed {
  /** The moment the seed started: ages and times below are relative to it. */
  startedAt: Date;
  actors: {
    /** A person (web role). */
    alice: Actor;
    /** An agent that writes scripts (MCP role). */
    writer: Actor & { tokenId: string };
    /** An agent that logs metrics and runs experiments (MCP role). */
    analyst: Actor & { tokenId: string };
  };
  /**
   * One idea per stage, in the stage for the number of days given, plus an archived one (in
   * `inbox`, archived at seeding time):
   *
   * | key | stage | in stage for | scripts (latest) | packaging (latest) |
   * | --- | --- | --- | --- | --- |
   * | inbox | inbox | 2 hours | none | none |
   * | shortlisted | shortlisted | 3 days | none | none |
   * | scripting | scripting | 5 days 3 hours | v2, review | v1, draft |
   * | filming | filming | 12 days | v1, approved | none |
   * | editing | editing | 20 days | v1, draft | v2, review |
   * | published | published | 40 days | v1, approved | none |
   * | dropped | dropped | 60 days | none | none |
   * | archived | inbox | 1 day | v1, draft | none |
   */
  ideas: Record<
    | "inbox"
    | "shortlisted"
    | "scripting"
    | "filming"
    | "editing"
    | "published"
    | "dropped"
    | "archived",
    IdeaRecord
  >;
  /** Every saved revision by idea key, oldest first (the scripting idea has v1 and v2). */
  scripts: Partial<
    Record<keyof SmallSeed["ideas"], { script: ScriptRecord[]; packaging: ScriptRecord[] }>
  >;
  /**
   * Videos. The latest snapshots of the three that are live and measured, which the channel
   * medians are computed over:
   *
   * | video | views | impressions | ctr | avg duration s | avg % | watch min | subs |
   * | --- | --- | --- | --- | --- | --- | --- | --- |
   * | explained | 3000 | 60000 | 5.0 | 240 | 50 | 12000 | 30 |
   * | gear | 500 | 20000 | 2.5 | 120 | 35 | 1000 | 2 |
   * | editing | 8000 | 100000 (no ctr) | none | 300 | 60 | 40000 | 100 |
   *
   * `explained` also has two older snapshots (views 1000 and 2000). `scheduled` has no snapshot;
   * `archived` has one with 1 000 000 views and is left out of the views.
   */
  videos: Record<"explained" | "gear" | "editing" | "scheduled" | "archived", VideoRecord>;
  /**
   * Experiments: `concluded` on `explained` (A control ctr 4.0, B ctr 5.0 and the winner, C ctr 4.0,
   * a tie with the control; impressions 10000, 10000 and 9000), `running` on `gear` (no stats yet),
   * `planned` on the archived video (created before it was archived).
   */
  experiments: Record<"concluded" | "running" | "planned", ExperimentWithVariants>;
}

// Hours, not days: an interval of days follows the calendar of the session time zone (a day can have 23
// or 25 hours around a clock change), so a stage clock set in days is not an exact number of days.
const DAY = "24 hours";

/** Inserts an idea with a backdated stage clock (the functions cannot: ytw_touch owns it). */
async function insertIdea(
  db: TestDb,
  actor: Actor,
  idea: { title: string; pitch: string; status: IdeaStage; inStage: string; score?: number },
): Promise<IdeaRecord> {
  const id = await withActor(db.admin, actor, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO ideas (title, pitch, status, status_changed_at, created_at, score, tags)
       VALUES ($1, $2, $3, now() - $4::interval, now() - $4::interval - $5::interval, $6::integer,
               ARRAY['seed']::text[])
       RETURNING id`,
      [idea.title, idea.pitch, idea.status, idea.inStage, DAY, idea.score ?? null],
    );
    return rows[0]?.id as string;
  });
  const record = await getIdea(db.admin, id);
  if (record === null) {
    throw new Error(`idea ${id} vanished`);
  }
  return record;
}

/** Variants A, B, C, ... with the first as the control. */
const variants = (...contents: string[]) =>
  contents.map((content, index) => ({
    label: String.fromCharCode(65 + index),
    content,
    isControl: index === 0,
  }));

export async function seedSmall(db: TestDb): Promise<SmallSeed> {
  const startedAt = new Date();
  const writer = newAgent("seed-writer");
  const analyst = newAgent("seed-analyst");
  const now = Date.now();
  const ago = (days: number): string => new Date(now - days * 86_400_000).toISOString();
  const ahead = (days: number): string => new Date(now + days * 86_400_000).toISOString();

  const ideas = {
    inbox: await insertIdea(db, alice, {
      title: "Why retention beats clicks",
      pitch:
        "A deep dive into audience retention curves and why thumbnails matter less than you think.",
      status: "inbox",
      inStage: "2 hours",
    }),
    shortlisted: await insertIdea(db, alice, {
      title: "Thumbnail experiments that failed",
      pitch:
        "Five thumbnails I tested and what the click-through rate told me. Retention is only a side effect.",
      status: "shortlisted",
      inStage: "72 hours",
      score: 70,
    }),
    scripting: await insertIdea(db, alice, {
      title: "How I plan a video from idea to upload",
      pitch: "My planning workflow: research, outline, script, packaging.",
      status: "scripting",
      inStage: "123 hours",
      score: 85,
    }),
    filming: await insertIdea(db, alice, {
      title: "Camera gear after two years",
      pitch: "Cameras, microphones and lights I still use, and what I would skip.",
      status: "filming",
      inStage: "288 hours",
    }),
    editing: await insertIdea(db, alice, {
      title: "Editing workflow with AI",
      pitch: "Cutting a video faster with AI assisted editing, step by step.",
      status: "editing",
      inStage: "480 hours",
      score: 60,
    }),
    published: await insertIdea(db, alice, {
      title: "The audience retention curve explained",
      pitch: "How to read the audience retention graph in YouTube Studio.",
      status: "published",
      inStage: "960 hours",
      score: 90,
    }),
    dropped: await insertIdea(db, alice, {
      title: "A dropped idea about gear",
      pitch: "Not worth a video.",
      status: "dropped",
      inStage: "1440 hours",
    }),
    archived: await insertIdea(db, alice, {
      title: "An archived retention idea",
      pitch: "Retention retention retention.",
      status: "inbox",
      inStage: DAY,
    }),
  };

  // Scripts: saved by the writer agent through the real function, in the order of the table above.
  const scripts: SmallSeed["scripts"] = {};
  const save = async (
    key: keyof SmallSeed["ideas"],
    kind: "script" | "packaging",
    body: string,
    status?: "review" | "approved",
  ): Promise<void> => {
    const bucket = (scripts[key] ??= { script: [], packaging: [] });
    const saved = await act(db, writer, async (tx) => {
      const revision = await saveScriptVersion(tx, {
        ideaId: ideas[key].id,
        kind,
        baseVersion: bucket[kind].length,
        bodyMd: body,
      });
      return status === undefined
        ? revision
        : setScriptStatus(tx, { scriptId: revision.id, status });
    });
    bucket[kind].push(saved);
  };
  await save("scripting", "script", "# Plan\n\nResearch the topic first, then outline the hook.");
  await save(
    "scripting",
    "script",
    "# Plan\n\nResearch the topic first, then outline a stronger hook and a few thumbnail ideas.",
    "review",
  );
  await save("scripting", "packaging", "Title: How I plan videos\n\nThumbnail: a whiteboard");
  await save(
    "filming",
    "script",
    "# Gear\n\nCamera, lens and microphone for a talking head video.",
    "approved",
  );
  await save("editing", "script", "# Editing\n\nCut the silences first, then add the b-roll.");
  await save("editing", "packaging", "Title: Edit faster with AI");
  await save("editing", "packaging", "Title: Edit faster with AI, step by step", "review");
  await save(
    "published",
    "script",
    "# Retention\n\nThe retention curve shows where viewers leave.",
    "approved",
  );
  await save("archived", "script", "An old script that mentions retention.");
  await withActor(db.admin, alice, (tx) => archiveIdea(tx, { id: ideas.archived.id }));
  ideas.archived = (await getIdea(db.admin, ideas.archived.id)) as IdeaRecord;

  // Videos and their snapshots, by the analyst agent.
  const video = (youtubeId: string, title: string, publishedAt: string, ideaId?: string) =>
    act(db, analyst, (tx) =>
      registerVideo(tx, { youtubeId, title, publishedAt, ideaId: ideaId ?? null }),
    );
  const explained = await video(
    "seedvideo01",
    "The audience retention curve explained",
    ago(30),
    ideas.published.id,
  );
  const gear = await video("seedvideo02", "Camera gear after two years", ago(20), ideas.filming.id);
  const editing = await video("seedvideo03", "Editing workflow with AI", ago(10), ideas.editing.id);
  const scheduled = await video("seedvideo04", "A scheduled video", ahead(7));
  const archivedVideo = await video("seedvideo05", "An archived video", ago(100));
  const snapshot = (
    videoId: string,
    days: number,
    metrics: Parameters<typeof logMetrics>[1]["metrics"],
  ) => act(db, analyst, (tx) => logMetrics(tx, { videoId, capturedAt: ago(days), metrics }));
  await snapshot(explained.id, 14, { views: 1000, impressions: 20000, ctr: 4.0 });
  await snapshot(explained.id, 7, { views: 2000, impressions: 40000, ctr: 4.5 });
  await snapshot(explained.id, 1, {
    views: 3000,
    impressions: 60000,
    ctr: 5.0,
    avgViewDurationS: 240,
    avgViewPct: 50,
    watchTimeMin: 12000,
    subsGained: 30,
  });
  await snapshot(gear.id, 1, {
    views: 500,
    impressions: 20000,
    ctr: 2.5,
    avgViewDurationS: 120,
    avgViewPct: 35,
    watchTimeMin: 1000,
    subsGained: 2,
  });
  await snapshot(editing.id, 1, {
    views: 8000,
    impressions: 100000,
    avgViewDurationS: 300,
    avgViewPct: 60,
    watchTimeMin: 40000,
    subsGained: 100,
  });
  await snapshot(archivedVideo.id, 1, { views: 1_000_000, impressions: 9_000_000, ctr: 9.0 });

  // Experiments.
  const concludedStart = await act(db, analyst, (tx) =>
    createExperiment(tx, {
      videoId: explained.id,
      type: "title",
      hypothesis: "A question in the title raises the click-through rate",
      variants: variants(
        "The audience retention curve explained",
        "Why viewers leave your videos",
        "Fix your retention",
      ),
    }),
  );
  const running = await act(db, analyst, async (tx) => {
    const planned = await createExperiment(tx, {
      videoId: gear.id,
      type: "thumbnail",
      hypothesis: "A close-up of the camera beats the studio shot",
      variants: variants("thumbs/studio.png", "thumbs/closeup.png"),
    });
    const started = await updateExperimentStatus(tx, {
      id: planned.id,
      expectedVersion: planned.version,
      newStatus: "running",
    });
    return { ...started, variants: planned.variants };
  });
  const planned = await act(db, analyst, (tx) =>
    createExperiment(tx, {
      videoId: archivedVideo.id,
      type: "description",
      hypothesis: "A shorter description helps",
      variants: variants("Long description", "Short description"),
    }),
  );
  const archivedVideoDone = await act(db, analyst, (tx) =>
    archiveVideo(tx, { id: archivedVideo.id }),
  );

  const concluded = await act(db, analyst, async (tx) => {
    const started = await updateExperimentStatus(tx, {
      id: concludedStart.id,
      expectedVersion: concludedStart.version,
      newStatus: "running",
    });
    const variantId = (label: string): string => {
      const found = concludedStart.variants.find((variant) => variant.label === label);
      if (found === undefined) {
        throw new Error(`seed experiment has no variant ${label}`);
      }
      return found.id;
    };
    await recordVariantStats(tx, { variantId: variantId("A"), impressions: 10000, ctr: 4.0 });
    await recordVariantStats(tx, { variantId: variantId("B"), impressions: 10000, ctr: 5.0 });
    await recordVariantStats(tx, { variantId: variantId("C"), impressions: 9000, ctr: 4.0 });
    const done = await concludeExperiment(tx, {
      id: started.id,
      expectedVersion: started.version,
      winnerVariantId: variantId("B"),
      conclusion: "B wins: a clear lift over the control",
    });
    return { ...done, variants: concludedStart.variants };
  });

  // A few events that are not row changes (what the services log), one per kind of actor.
  const log = (actor: Actor, action: string, payload: Record<string, unknown>) =>
    act(db, actor, (tx) =>
      tx.query("SELECT public.ytw_log_event($1, $2, $3, $4, NULL, NULL, $5::jsonb)", [
        tx.actor.name,
        tx.actor.type,
        tx.actor.tokenId,
        action,
        JSON.stringify(payload),
      ]),
    );
  await log(alice, "auth.login", { method: "oidc" });
  await log(writer, "tool.call", { tool: "save_script_version", outcome: "ok" });
  await log(analyst, "tool.call", { tool: "log_metrics", outcome: "error", error: "validation" });

  await db.admin.query("ANALYZE");
  return {
    startedAt,
    actors: { alice, writer, analyst },
    ideas,
    scripts,
    videos: { explained, gear, editing, scheduled, archived: archivedVideoDone },
    experiments: { concluded, running, planned },
  };
}

// ---------------------------------------------------------------------------------------------
// The large dataset

export interface LargeSeedOptions {
  /** Ideas (default 10 000). One in 20 is archived; scripts are generated for every idea. */
  ideas?: number;
  /** Videos (default 10 000). One in 50 is archived; every 11th has no snapshot. */
  videos?: number;
  /** Snapshots per video, 1 to 9 (default 3). */
  snapshotsPerVideo?: number;
  /** Events (default 40 000). */
  events?: number;
}

/** How many rows of each table `seedLarge` wrote. */
export interface LargeSeedCounts {
  ideas: number;
  scripts: number;
  videos: number;
  snapshots: number;
  experiments: number;
  variants: number;
  events: number;
}

/** The fixed id of row `n` (from 1) of a kind in the large dataset. */
export function seedUuid(
  kind: "idea" | "script" | "video" | "snapshot" | "experiment" | "variant" | "event",
  n: number,
): string {
  const prefix = {
    idea: "7000",
    script: "7001",
    video: "7002",
    snapshot: "7003",
    experiment: "7004",
    variant: "7005",
    event: "7006",
  }[kind];
  return `00000000-0000-${prefix}-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * Vocabulary of the generated text. Idea `n` is titled `Idea n about <word> and <word>`, its pitch
 * ends with the reference code `zq<n>` (a word that exists nowhere else, so searching for it finds
 * that idea alone) and the scripts of idea `n` talk about the vocabulary words and carry the code
 * `zs<n>`.
 */
export const SEED_WORDS = [
  "retention",
  "thumbnail",
  "title",
  "hook",
  "intro",
  "editing",
  "camera",
  "lighting",
  "audio",
  "script",
  "pacing",
  "broll",
  "storytelling",
  "analytics",
  "algorithm",
  "audience",
  "community",
  "shorts",
  "collab",
  "gear",
] as const;

/**
 * Writes the large deterministic dataset (see the head of this file). Run it once per test file in
 * `beforeAll` (a few seconds for the defaults).
 *
 * Shape: ideas cycle through the seven stages and sit in their stage for 0 to 119 days; every idea
 * has a script, a third have a second version, a tenth a third; every second idea has packaging; one
 * video in two links to the idea with the same number. Metrics are a few snapshots a week apart
 * (`ctr` is missing on every seventh video). Every tenth video has an experiment with three variants
 * whose status cycles through planned, running, concluded and cancelled. Events are synthetic: two
 * people (`alice`, `bob`) and five agents (`agent-a` to `agent-e`) doing inserts, updates, tool calls
 * and logins on every kind of record, 150 seconds apart, newest first by number.
 */
export async function seedLarge(
  db: TestDb,
  options: LargeSeedOptions = {},
): Promise<LargeSeedCounts> {
  const ideas = options.ideas ?? 10_000;
  const videos = options.videos ?? 10_000;
  const snapshots = options.snapshotsPerVideo ?? 3;
  const events = options.events ?? 40_000;
  if (!Number.isInteger(snapshots) || snapshots < 1 || snapshots > 9) {
    throw new Error("snapshotsPerVideo must be a whole number from 1 to 9");
  }
  for (const [name, value] of Object.entries({ ideas, videos, events })) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive whole number`);
    }
  }
  const experiments = Math.floor(videos / 10);

  const client = await db.admin.connect();
  const counts: LargeSeedCounts = {
    ideas: 0,
    scripts: 0,
    videos: 0,
    snapshots: 0,
    experiments: 0,
    variants: 0,
    events: 0,
  };
  try {
    await client.query("BEGIN");
    // Triggers (audit, bookkeeping, append-only guards) and foreign key checks are skipped: the
    // rows are consistent by construction, and the events are generated below.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("SELECT public.ytw_set_actor('seed', 'human', NULL)");
    await client.query(
      `CREATE TEMP TABLE seed_words (w text[], a text[], stages text[], tags text[], sources text[])
         ON COMMIT DROP`,
    );
    await client.query(
      `INSERT INTO seed_words
       VALUES ($1::text[],
               ARRAY['alpha','beta','gamma','delta','epsilon','zeta','eta','theta','iota','kappa']::text[],
               ARRAY['inbox','shortlisted','scripting','filming','editing','published','dropped']::text[],
               ARRAY['tutorial','review','vlog','essay','interview','challenge']::text[],
               ARRAY['owner','agent','comment','newsletter']::text[])`,
      [[...SEED_WORDS]],
    );
    const run = async (name: keyof LargeSeedCounts, text: string, values: unknown[]) => {
      const result = await client.query(text, values);
      counts[name] += result.rowCount ?? 0;
    };

    await run(
      "ideas",
      `INSERT INTO ideas (id, title, pitch, status, status_changed_at, score, source, tags, version,
                          archived_at, created_at, updated_at, created_by, updated_by)
       SELECT ('00000000-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              format('Idea %s about %s and %s', n, s.w[1 + n % 20], s.w[1 + (n * 7) % 20]),
              format('A pitch for idea %s: why %s matters for %s, with a focus on %s. %sReference code zq%s.',
                     n, s.w[1 + (n * 3) % 20], s.w[1 + (n * 11) % 20], s.a[1 + n % 10],
                     repeat(format('More detail about %s. ', s.w[1 + (n * 5) % 20]), 1 + n % 4), n),
              s.stages[1 + n % 7],
              now() - make_interval(secs => (n % 120) * 86400 + (n % 86400)),
              CASE WHEN n % 5 = 0 THEN NULL ELSE n % 101 END,
              s.sources[1 + n % 4],
              ARRAY[s.tags[1 + n % 6]] || CASE WHEN n % 3 = 0 THEN ARRAY[s.tags[1 + (n + 1) % 6]] ELSE '{}'::text[] END,
              1,
              CASE WHEN n % 20 = 0 THEN now() - interval '1 day' END,
              now() - make_interval(secs => (n % 200) * 86400 + 3600),
              now() - make_interval(secs => (n % 120) * 86400),
              'seed', 'seed'
         FROM generate_series(1, $1::integer) n, seed_words s`,
      [ideas],
    );
    await run(
      "scripts",
      `INSERT INTO scripts (id, idea_id, kind, version, body_md, status, created_at, updated_at,
                           created_by, updated_by)
       SELECT ('00000000-0000-7001-8000-' || lpad(to_hex(n * 10 + k.ord * 3 + v), 12, '0'))::uuid,
              ('00000000-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              k.kind, v,
              format(E'# %s %s v%s\\n\\n%s Reference code zs%s.', k.kind, n, v,
                     repeat(format('Today we talk about %s and %s in the style of %s. ',
                                   s.w[1 + (n * 3 + v) % 20], s.w[1 + (n * 13 + v) % 20], s.a[1 + (n + v) % 10]),
                            4 + n % 6),
                     n),
              (ARRAY['draft','review','approved'])[1 + (n + v) % 3],
              now() - make_interval(secs => (n % 100) * 86400 - v * 600),
              now() - make_interval(secs => (n % 100) * 86400 - v * 600),
              'seed', 'seed'
         FROM generate_series(1, $1::integer) n,
              (VALUES ('script', 0), ('packaging', 1)) AS k (kind, ord),
              generate_series(1, 3) v,
              seed_words s
        WHERE (k.kind = 'script' AND (v = 1 OR (v = 2 AND n % 3 = 0) OR (v = 3 AND n % 10 = 0)))
           OR (k.kind = 'packaging' AND n % 2 = 0 AND (v = 1 OR (v = 2 AND n % 5 = 0)))`,
      [ideas],
    );
    await run(
      "videos",
      `INSERT INTO videos (id, idea_id, youtube_id, title, published_at, thumbnail_url, version,
                          archived_at, created_at, updated_at, created_by, updated_by)
       SELECT ('00000000-0000-7002-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              CASE WHEN n % 2 = 0 AND n <= $2::integer THEN ('00000000-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid END,
              'v' || lpad(n::text, 10, '0'),
              format('Video %s: %s', n, s.w[1 + (n * 7) % 20]),
              now() - make_interval(secs => (n % 365) * 86400),
              'https://example.com/thumb/' || n || '.jpg',
              1,
              CASE WHEN n % 50 = 0 THEN now() END,
              now() - make_interval(secs => (n % 365) * 86400 + 3600),
              now() - make_interval(secs => (n % 365) * 86400),
              'seed', 'seed'
         FROM generate_series(1, $1::integer) n, seed_words s`,
      [videos, ideas],
    );
    await run(
      "snapshots",
      `INSERT INTO video_metrics (id, video_id, captured_at, views, impressions, ctr,
                                 avg_view_duration_s, avg_view_pct, watch_time_min, subs_gained,
                                 created_by)
       SELECT ('00000000-0000-7003-8000-' || lpad(to_hex(n * 10 + k), 12, '0'))::uuid,
              ('00000000-0000-7002-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              now() - make_interval(days => ($2::integer - k) * 7),
              (n * 37 % 5000 + 100) * k,
              (n * 91 % 50000 + 1000) * k,
              CASE WHEN n % 7 = 0 THEN NULL ELSE round((2 + (n % 90) / 10.0)::numeric, 2) END,
              100 + n % 300,
              20 + n % 60,
              (n * 37 % 5000 + 100) * k * 2.5,
              n % 40 - 5,
              'seed'
         FROM generate_series(1, $1::integer) n, generate_series(1, $2::integer) k
        WHERE n % 11 <> 0`,
      [videos, snapshots],
    );
    await run(
      "experiments",
      `INSERT INTO experiments (id, video_id, type, hypothesis, status, starts_at, ends_at,
                               winner_variant_id, conclusion, version, created_at, updated_at,
                               created_by, updated_by)
       SELECT ('00000000-0000-7004-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              ('00000000-0000-7002-8000-' || lpad(to_hex(n * 10), 12, '0'))::uuid,
              (ARRAY['title','thumbnail','description'])[1 + n % 3],
              format('Hypothesis %s', n),
              (ARRAY['planned','running','concluded','cancelled'])[1 + n % 4],
              CASE WHEN n % 4 IN (1, 2) THEN now() - interval '20 days' END,
              CASE WHEN n % 4 = 2 THEN now() - interval '5 days' END,
              CASE WHEN n % 4 = 2 THEN ('00000000-0000-7005-8000-' || lpad(to_hex(n * 3 + 1), 12, '0'))::uuid END,
              CASE WHEN n % 4 = 2 THEN 'The second variant won' END,
              1, now() - make_interval(secs => n * 60), now() - make_interval(secs => n * 30),
              'seed', 'seed'
         FROM generate_series(1, $1::integer) n`,
      [experiments],
    );
    await run(
      "variants",
      `INSERT INTO experiment_variants (id, experiment_id, label, content, is_control, impressions,
                                       ctr, created_at, updated_at, created_by, updated_by)
       SELECT ('00000000-0000-7005-8000-' || lpad(to_hex(n * 3 + j), 12, '0'))::uuid,
              ('00000000-0000-7004-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              (ARRAY['A','B','C'])[1 + j],
              format('Variant %s of experiment %s', (ARRAY['A','B','C'])[1 + j], n),
              j = 0,
              CASE WHEN n % 4 IN (1, 2) THEN 1000 + n * j END,
              CASE WHEN n % 4 IN (1, 2) THEN round((3 + j * 0.5 + (n % 10) / 10.0)::numeric, 2) END,
              now() - interval '30 days', now() - interval '5 days', 'seed', 'seed'
         FROM generate_series(1, $1::integer) n, generate_series(0, 2) j`,
      [experiments],
    );
    await run(
      "events",
      `INSERT INTO events (id, created_at, actor, actor_type, token_id, action, entity_type,
                          entity_id, payload)
       SELECT ('00000000-0000-7006-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
              now() - make_interval(secs => n * 150 + (n % 7)),
              CASE WHEN n % 5 < 3 THEN (ARRAY['alice','bob'])[1 + n % 2]
                   ELSE 'agent-' || (ARRAY['a','b','c','d','e'])[1 + (n / 5) % 5] END,
              CASE WHEN n % 5 < 3 THEN 'human' ELSE 'agent' END,
              CASE WHEN n % 5 >= 3 THEN ('00000000-0000-7007-8000-' || lpad(to_hex(1 + (n / 5) % 5), 12, '0'))::uuid END,
              (ARRAY['insert','update','tool.call','auth.login'])[1 + n % 4],
              (ARRAY['idea','script','video','video_metric','experiment','note'])[1 + (n / 4) % 6],
              ('00000000-0000-7000-8000-' || lpad(to_hex(1 + n % $2::integer), 12, '0'))::uuid,
              jsonb_build_object('new', jsonb_build_object('title', 'Event ' || n, 'n', n))
         FROM generate_series(1, $1::integer) n`,
      [events, ideas],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await db.admin.query("ANALYZE");
  return counts;
}
