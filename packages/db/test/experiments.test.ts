// The experiment functions (migration 0043, T13): create_experiment, update_experiment_status,
// record_variant_stats and conclude_experiment, i.e. the packaging tests of PRD 4 with their status
// machine (planned -> running -> concluded | cancelled), their optimistic concurrency and the rule
// that a winner is one of the experiment's own variants, checked before commit.
//
// Real database, typed wrappers, application roles. The races are real too: concurrent transactions
// on separate connections, one of them held open on purpose to prove that the second waits for the
// first and then reads its result.
import { randomUUID } from "node:crypto";
import {
  EXPERIMENT_STATUSES,
  EXPERIMENT_TYPES,
  type ExperimentStatus,
} from "@ytw/shared/constants";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "../src/client.js";
import {
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from "../src/errors.js";
import {
  concludeExperiment,
  createExperiment,
  getExperiment,
  recordVariantStats,
  updateExperimentStatus,
  type VariantInput,
} from "../src/experiments.js";
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
  settle,
  tick,
  waitForLockWait,
  withoutRowLock,
  type FunctionSpec,
} from "./content-helpers.js";
import { sqlstate } from "./helpers.js";
import {
  TWO_VARIANTS,
  experimentIn,
  newExperiment,
  newVideo,
  readExperiment,
  rejectedWith,
  runningExperiment,
  setExperimentStatus,
} from "./video-helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

/** The status machine, repeated here on purpose: the database function is compared with it. */
const NEXT: Record<ExperimentStatus, ExperimentStatus[]> = {
  planned: ["running", "cancelled"],
  running: ["concluded", "cancelled"],
  concluded: [],
  cancelled: [],
};

const TWO_RAW = [
  { label: "A", content: "x", is_control: true },
  { label: "B", content: "y" },
];

function conclude(
  experiment: { id: string; version: number },
  winnerVariantId: string | null,
  conclusion = "B won by a clear margin",
  actor = alice,
) {
  return act(db, actor, (tx) =>
    concludeExperiment(tx, {
      id: experiment.id,
      expectedVersion: experiment.version,
      winnerVariantId,
      conclusion,
    }),
  );
}

function stats(
  variantId: string,
  values: { impressions?: number | string; ctr?: number | string },
  actor = alice,
) {
  return act(db, actor, (tx) => recordVariantStats(tx, { variantId, ...values }));
}

/** Calls create_experiment with raw JSON for `variants` (what an MCP tool sends). */
function rawCreate(
  videoId: string | null,
  type: string | null,
  variants: unknown,
  hypothesis: string | null = "h",
) {
  return db
    .pool("ytw_mcp")
    .query(
      sql`SELECT * FROM create_experiment('bot', 'agent', NULL, ${videoId}::uuid, ${type}, ${hypothesis}, ${JSON.stringify(variants)}::jsonb)`,
    );
}

async function statsRefusal(values: { impressions?: unknown; ctr?: unknown }) {
  const experiment = await runningExperiment(db);
  const variant = experiment.variants[0]?.id as string;
  const before = await readExperiment(db, experiment.id);
  const err = await rejectedWith(
    stats(variant, values as { impressions?: number; ctr?: number }),
    ValidationError,
  );
  expect(await readExperiment(db, experiment.id)).toEqual(before);
  return err;
}

async function experimentCount(videoId: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM experiments WHERE video_id = $1",
    [videoId],
  );
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------

describe("create_experiment", () => {
  it("creates a planned experiment with its variants in one call, control first", async () => {
    const video = await newVideo(db);
    const experiment = await newExperiment(db, {
      videoId: video.id,
      type: "thumbnail",
      hypothesis: "A closer crop of the face wins",
      variants: [
        { label: "New crop", content: "thumbs/crop.png" },
        { label: "Current", content: "thumbs/current.png", isControl: true },
      ],
    });
    expect(experiment).toMatchObject({
      videoId: video.id,
      type: "thumbnail",
      hypothesis: "A closer crop of the face wins",
      status: "planned",
      startsAt: null,
      endsAt: null,
      winnerVariantId: null,
      conclusion: null,
      version: 1,
      createdBy: "alice",
      updatedBy: "alice",
    });
    expect(experiment.variants).toEqual([
      expect.objectContaining({
        experimentId: experiment.id,
        label: "Current",
        content: "thumbs/current.png",
        isControl: true,
        impressions: null,
        ctr: null,
        createdBy: "alice",
      }),
      expect.objectContaining({ label: "New crop", content: "thumbs/crop.png", isControl: false }),
    ]);
    expect(await readExperiment(db, experiment.id)).toEqual(experiment);
  });

  it("accepts every experiment type and an experiment without a hypothesis", async () => {
    for (const type of EXPERIMENT_TYPES) {
      const experiment = await newExperiment(db, { type, hypothesis: null });
      expect(experiment).toMatchObject({ type, hypothesis: null });
    }
    const omitted = await act(db, alice, async (tx) =>
      createExperiment(tx, {
        videoId: (await newVideo(db)).id,
        type: "title",
        variants: TWO_VARIANTS,
      }),
    );
    expect(omitted.hypothesis).toBeNull();
  });

  it("allows several experiments, also of one type, on one video", async () => {
    const video = await newVideo(db);
    await newExperiment(db, { videoId: video.id });
    await newExperiment(db, { videoId: video.id });
    await newExperiment(db, { videoId: video.id, type: "thumbnail" });
    expect(await experimentCount(video.id)).toBe(3);
  });

  it("writes one audit row for the experiment and one per variant, all with the actor and token", async () => {
    const agent = newAgent("packager");
    const experiment = await newExperiment(db, {}, agent);
    const rows = await eventsFor(db, experiment.id);
    expect(rows).toEqual([
      expect.objectContaining({
        actor: "packager",
        actor_type: "agent",
        token_id: agent.tokenId,
        action: "insert",
        entity_type: "experiment",
        payload: {
          new: expect.objectContaining({ status: "planned", type: "title", version: 1 }),
        },
      }),
    ]);
    for (const variant of experiment.variants) {
      expect(await eventsFor(db, variant.id)).toEqual([
        expect.objectContaining({
          actor: "packager",
          token_id: agent.tokenId,
          action: "insert",
          entity_type: "experiment_variant",
          payload: {
            new: expect.objectContaining({
              experiment_id: experiment.id,
              label: variant.label,
              is_control: variant.isControl,
            }),
          },
        }),
      ]);
    }
  });

  it("leaves nothing behind when writing a variant fails: the experiment and its audit rows roll back with it", async () => {
    const video = await newVideo(db);
    await db.admin.query(`
      CREATE FUNCTION t13_fail_on_boom() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN IF NEW.label = 'BOOM' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`);
    await db.admin.query(
      "CREATE TRIGGER fail_on_boom BEFORE INSERT ON experiment_variants FOR EACH ROW EXECUTE FUNCTION t13_fail_on_boom()",
    );
    try {
      const before = (await db.admin.query("SELECT count(*)::int AS n FROM events")).rows[0]?.n;
      await expect(
        newExperiment(db, {
          videoId: video.id,
          variants: [
            { label: "A", content: "x", isControl: true },
            { label: "BOOM", content: "y" },
          ],
        }),
      ).rejects.toThrow(/boom/);
      expect(await experimentCount(video.id)).toBe(0);
      expect((await db.admin.query("SELECT count(*)::int AS n FROM events")).rows[0]?.n).toBe(
        before,
      );
    } finally {
      await db.admin.query("DROP TRIGGER fail_on_boom ON experiment_variants");
      await db.admin.query("DROP FUNCTION t13_fail_on_boom()");
    }
  });

  describe("arguments", () => {
    it("lists the valid types for an unknown one, without echoing a hostile value in full", async () => {
      const video = await newVideo(db);
      for (const type of [
        "Title",
        "titles",
        "",
        " title",
        "title'; DROP TABLE experiments;--",
        "x".repeat(5000),
      ]) {
        const err = await rejectedWith(
          rawCreate(video.id, type, [
            { label: "A", content: "x", is_control: true },
            { label: "B", content: "y" },
          ]),
          ValidationError,
        );
        expect(err.field).toBe("type");
        expect(err.allowed).toEqual([...EXPERIMENT_TYPES]);
        expect(err.message).toContain('valid types: "title", "thumbnail", "description"');
        expect(err.message.length).toBeLessThan(300);
      }
      expect(await experimentCount(video.id)).toBe(0);
    });

    it("limits the hypothesis: not blank, at most 20000 characters", async () => {
      const video = await newVideo(db);
      const ok = await newExperiment(db, { videoId: video.id, hypothesis: "h".repeat(20_000) });
      expect(ok.hypothesis).toHaveLength(20_000);
      for (const hypothesis of ["", "   ", "\n\t"]) {
        const err = await rejectedWith(
          newExperiment(db, { videoId: video.id, hypothesis }),
          ValidationError,
        );
        expect(err.field).toBe("hypothesis");
        expect(err.message).toContain("cannot be empty or only whitespace");
      }
      const long = await rejectedWith(
        newExperiment(db, { videoId: video.id, hypothesis: "h".repeat(20_001) }),
        ValidationError,
      );
      expect(long.message).toBe("hypothesis is too long: 20001 characters, the limit is 20000");
      expect(await experimentCount(video.id)).toBe(1);
    });

    it("loses a race against archiving that started first", async () => {
      const video = await newVideo(db);
      const archiver = await db.pool("ytw_web").connect();
      try {
        await archiver.query("BEGIN");
        await archiver.query(sql`SELECT archive_video('alice', 'human', NULL, ${video.id}::uuid)`);
        const racing = act(db, newAgent(), (tx) =>
          createExperiment(tx, { videoId: video.id, type: "title", variants: TWO_VARIANTS }),
        );
        const outcome = racing.then(
          () => undefined,
          (err: unknown) => err,
        );
        await waitForLockWait(db, "create_experiment");
        await archiver.query("COMMIT");
        expect(await outcome).toBeInstanceOf(InvalidTransitionError);
        expect(await experimentCount(video.id)).toBe(0);
      } finally {
        await archiver.query("ROLLBACK").catch(() => undefined);
        archiver.release();
      }
    });

    it("needs an existing video that is not archived", async () => {
      const missing = randomUUID();
      expect(
        await rejectedWith(newExperiment(db, { videoId: missing }), NotFoundError),
      ).toMatchObject({
        entity: "video",
        id: missing,
      });
      const video = await newVideo(db);
      await act(db, alice, (tx) => archiveVideo(tx, { id: video.id }));
      const err = await rejectedWith(
        newExperiment(db, { videoId: video.id }),
        InvalidTransitionError,
      );
      expect(err.details).toMatchObject({ entity: "video", id: video.id, reason: "archived" });
      expect(err.message).toBe(`video ${video.id} is archived and cannot be given new experiments`);
      expect(await experimentCount(video.id)).toBe(0);
      expect((await rejectedWith(rawCreate(null, "title", TWO_RAW), ValidationError)).field).toBe(
        "video_id",
      );
      const bad = await rejectedWith(newExperiment(db, { videoId: "nope" }), ValidationError);
      expect(bad.field).toBe("video_id");
    });
  });

  describe("the variants", () => {
    const control = { label: "A", content: "Current", is_control: true };
    const other = { label: "B", content: "Bolder" };

    it.each([
      ["not a list", { label: "A" }, "variants must be a list of 2 to 10 objects"],
      ["null", null, "variants must be a list of 2 to 10 objects"],
      ["an empty list", [], "needs at least 2 variants (got 0)"],
      ["a single variant", [control], "needs at least 2 variants (got 1)"],
      [
        "11 variants",
        Array.from({ length: 11 }, (_, i) => ({
          label: `V${i}`,
          content: "c",
          is_control: i === 0,
        })),
        "too many variants: 11, the limit is 10",
      ],
      [
        "no control",
        [other, { label: "C", content: "Louder" }],
        "exactly one variant must be the control",
      ],
      ["two controls", [control, { ...other, is_control: true }], "found 2"],
      [
        "a repeated label",
        [control, { ...other, label: "A" }],
        'variant labels must be unique: "A" is used more than once',
      ],
      [
        "labels that differ in case",
        [control, { ...other, label: "a" }],
        "ignoring case and surrounding spaces",
      ],
      [
        "labels that differ in spaces",
        [control, { ...other, label: " A " }],
        "ignoring case and surrounding spaces",
      ],
      ["a variant that is not an object", [control, "B"], "variant 2 must be an object"],
      ["a null variant", [control, null], "variant 2 must be an object"],
      ["a blank label", [control, { ...other, label: "  " }], "variant 2 needs a label"],
      ["a label that is a number", [control, { ...other, label: 5 }], "variant 2 needs a label"],
      ["a missing label", [control, { content: "x" }], "variant 2 needs a label"],
      [
        "a label of 201 characters",
        [control, { ...other, label: "L".repeat(201) }],
        "label is too long: 201 characters, the limit is 200",
      ],
      ["missing content", [control, { label: "B" }], 'variant 2 ("B") needs content'],
      ["blank content", [control, { label: "B", content: " \n" }], 'variant 2 ("B") needs content'],
      [
        "content of 20001 characters",
        [control, { ...other, content: "c".repeat(20_001) }],
        "content is too long: 20001 characters, the limit is 20000",
      ],
      [
        "an unknown field",
        [control, { ...other, impressions: 5 }],
        'unknown field "impressions"; fields: "label", "content", "is_control"',
      ],
      [
        "is_control as text",
        [control, { ...other, is_control: "no" }],
        "is_control must be true or false",
      ],
      [
        "is_control as null",
        [control, { ...other, is_control: null }],
        "is_control must be true or false",
      ],
    ])("refuses %s", async (_label, variants, words) => {
      const video = await newVideo(db);
      const err = await rejectedWith(rawCreate(video.id, "title", variants), ValidationError);
      expect(err.field).toBe("variants");
      expect(err.message).toContain(words);
      expect(err.message.length).toBeLessThan(600);
      expect(await experimentCount(video.id)).toBe(0);
    });

    it("accepts 10 variants, labels with spaces inside, and content in any script", async () => {
      const variants: VariantInput[] = Array.from({ length: 10 }, (_, i) => ({
        label: i === 0 ? "Control (current)" : `Variant ${i}`,
        content: i % 2 === 0 ? "日本語のタイトル \u{1F3AC}" : "plain",
        isControl: i === 0,
      }));
      const experiment = await newExperiment(db, { variants });
      expect(experiment.variants).toHaveLength(10);
      expect(experiment.variants[0]).toMatchObject({ label: "Control (current)", isControl: true });
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("update_experiment_status", () => {
  const pairs = EXPERIMENT_STATUSES.flatMap((from) =>
    EXPERIMENT_STATUSES.map((to) => [from, to] as const),
  );

  it("is the status machine of the database function, row by row", async () => {
    const { rows } = await db.admin.query<{ from_status: string; to_status: string; via: string }>(
      "SELECT from_status, to_status, via FROM ytw_experiment_status_transitions()",
    );
    const expected = EXPERIMENT_STATUSES.flatMap((from) =>
      NEXT[from].map((to) => ({
        from_status: from,
        to_status: to,
        via: to === "concluded" ? "conclude_experiment" : "update_experiment_status",
      })),
    );
    expect(rows).toEqual(expect.arrayContaining(expected));
    expect(rows).toHaveLength(expected.length);
    const one = await db.admin.query(
      "SELECT ytw_experiment_statuses() AS s, ytw_experiment_types() AS t",
    );
    expect(one.rows[0]).toEqual({ s: [...EXPERIMENT_STATUSES], t: [...EXPERIMENT_TYPES] });
  });

  it.each(pairs)("%s -> %s", async (from, to) => {
    const before = await experimentIn(db, from);
    const events = await eventCount(db, before.id);
    await tick();
    const outcome = await settle(
      act(db, newAgent("lifecycle"), (tx) =>
        updateExperimentStatus(tx, {
          id: before.id,
          expectedVersion: before.version,
          newStatus: to,
        }),
      ),
    );
    const after = await readExperiment(db, before.id);
    const error = outcome.ok ? undefined : outcome.error;

    // What the machine says: a listed move is made, except concluding, which is conclude_experiment's.
    const listed = NEXT[from].includes(to);
    const kind = listed ? (to === "concluded" ? "validation" : "ok") : "invalid_transition";
    const moved = kind === "ok";
    expect({
      kind: outcomeKind(outcome),
      status: after.status,
      version: after.version,
      updatedBy: after.updatedBy,
      events: await eventCount(db, before.id),
      startsAtSet: after.startsAt !== null,
      endsAtSet: after.endsAt !== null,
      allowed: error instanceof InvalidTransitionError ? error.allowed : undefined,
      field: error instanceof ValidationError ? error.field : undefined,
      httpStatus: error instanceof InvalidTransitionError ? error.status : undefined,
    }).toEqual({
      kind,
      status: moved ? to : from,
      version: before.version + (moved ? 1 : 0),
      updatedBy: moved ? "lifecycle" : before.updatedBy,
      events: events + (moved ? 1 : 0),
      startsAtSet: (moved && to === "running") || before.startsAt !== null,
      endsAtSet: (moved && from === "running" && to === "cancelled") || before.endsAt !== null,
      allowed: kind === "invalid_transition" ? NEXT[from] : undefined,
      field: kind === "validation" ? "new_status" : undefined,
      httpStatus: kind === "invalid_transition" ? 422 : undefined,
    });
  });

  it("points to conclude_experiment when asked to set the status concluded", async () => {
    const running = await runningExperiment(db);
    const err = await rejectedWith(
      act(db, alice, (tx) =>
        updateExperimentStatus(tx, {
          id: running.id,
          expectedVersion: running.version,
          newStatus: "concluded",
        }),
      ),
      ValidationError,
    );
    expect(err.message).toBe(
      'the status "concluded" is set with conclude_experiment, which also records the winner and the conclusion: use it to finish this experiment',
    );
    expect(err.allowed).toEqual(["cancelled"]);
  });

  it("starts an experiment at the moment of the call, and cancelling a running one ends the period", async () => {
    const planned = await newExperiment(db);
    const t0 = Date.now();
    const running = await setExperimentStatus(db, planned, "running");
    expect(running.startsAt?.getTime()).toBeGreaterThanOrEqual(t0 - 5000);
    expect(running.startsAt?.getTime()).toBeLessThanOrEqual(Date.now() + 5000);
    expect(running.endsAt).toBeNull();
    await tick();
    const cancelled = await setExperimentStatus(db, running, "cancelled");
    expect(cancelled.startsAt).toEqual(running.startsAt);
    expect(cancelled.endsAt?.getTime()).toBeGreaterThanOrEqual(
      running.startsAt?.getTime() as number,
    );
    expect(cancelled.winnerVariantId).toBeNull();
  });

  it("cancels a planned experiment without a period: it never ran", async () => {
    const cancelled = await setExperimentStatus(db, await newExperiment(db), "cancelled");
    expect(cancelled).toMatchObject({ status: "cancelled", startsAt: null, endsAt: null });
  });

  it("writes the audit row with the old and the new status", async () => {
    const agent = newAgent("starter");
    const planned = await newExperiment(db);
    await setExperimentStatus(db, planned, "running", agent);
    const last = (await eventsFor(db, planned.id)).at(-1);
    expect(last).toMatchObject({
      actor: "starter",
      token_id: agent.tokenId,
      action: "update",
      entity_type: "experiment",
      payload: { old: { status: "planned", version: 1 }, new: { status: "running", version: 2 } },
    });
    expect(last?.payload.new).toHaveProperty("starts_at");
  });

  it("explains each refusal in words an agent can act on", async () => {
    const planned = await newExperiment(db);
    const toConcluded = await rejectedWith(
      act(db, alice, (tx) =>
        updateExperimentStatus(tx, { id: planned.id, expectedVersion: 1, newStatus: "concluded" }),
      ),
      InvalidTransitionError,
    );
    expect(toConcluded.message).toBe(
      'an experiment in status "planned" cannot move to "concluded"; valid next statuses: "running", "cancelled"',
    );
    const same = await rejectedWith(
      act(db, alice, (tx) =>
        updateExperimentStatus(tx, { id: planned.id, expectedVersion: 1, newStatus: "planned" }),
      ),
      InvalidTransitionError,
    );
    expect(same.message).toBe(
      `experiment ${planned.id} is already planned; valid next statuses: "running", "cancelled"`,
    );
    const running = await setExperimentStatus(db, planned, "running");
    const back = await rejectedWith(
      act(db, alice, (tx) =>
        updateExperimentStatus(tx, { id: running.id, expectedVersion: 2, newStatus: "planned" }),
      ),
      InvalidTransitionError,
    );
    expect(back.message).toBe(
      'an experiment in status "running" cannot move to "planned"; valid next statuses: "concluded" (with conclude_experiment), "cancelled"',
    );
    const done = await setExperimentStatus(db, running, "cancelled");
    const final = await rejectedWith(
      act(db, alice, (tx) =>
        updateExperimentStatus(tx, { id: done.id, expectedVersion: 3, newStatus: "running" }),
      ),
      InvalidTransitionError,
    );
    expect(final.message).toBe(
      `experiment ${done.id} is cancelled, which is final: it cannot move to "running"`,
    );
    expect(final.allowed).toEqual([]);
    expect(final.details).toMatchObject({ reason: "terminal" });
    expect(final.hint).toBe(
      "concluded and cancelled are final. Create a new experiment to test again.",
    );
  });

  it("lists the valid statuses for one that does not exist, without echoing a hostile value", async () => {
    const planned = await newExperiment(db);
    for (const status of ["Running", "started", "", "x".repeat(5000)]) {
      const err = await rejectedWith(
        act(db, alice, (tx) =>
          updateExperimentStatus(tx, {
            id: planned.id,
            expectedVersion: 1,
            newStatus: status as ExperimentStatus,
          }),
        ),
        ValidationError,
      );
      expect(err.field).toBe("new_status");
      expect(err.allowed).toEqual([...EXPERIMENT_STATUSES]);
      expect(err.message.length).toBeLessThan(300);
    }
  });

  it("works on the experiments of an archived video, so none is left running for good", async () => {
    const running = await runningExperiment(db);
    await act(db, alice, (tx) => archiveVideo(tx, { id: running.videoId }));
    expect((await setExperimentStatus(db, running, "cancelled")).status).toBe("cancelled");
  });

  describe("optimistic concurrency", () => {
    it("reports a stale expected_version with the latest, before an invalid move", async () => {
      const planned = await newExperiment(db);
      const running = await setExperimentStatus(db, planned, "running");
      for (const newStatus of ["running", "cancelled"] as const) {
        const err = await rejectedWith(
          act(db, alice, (tx) =>
            updateExperimentStatus(tx, { id: planned.id, expectedVersion: 1, newStatus }),
          ),
          VersionConflictError,
        );
        expect(err.latestVersion).toBe(2);
        expect(err.status).toBe(409);
        expect(err.message).toBe(
          `experiment ${planned.id} has changed since you read it: you sent expected_version 1 but the latest version is 2; reload it, apply your change again and retry with expected_version 2`,
        );
      }
      expect(await readExperiment(db, planned.id)).toMatchObject({
        status: "running",
        version: running.version,
      });
    });

    it("lets exactly one of many racing starters win; the others learn the new version", async () => {
      const planned = await newExperiment(db);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          setExperimentStatus(db, planned, "running", i % 2 === 0 ? alice : newAgent()),
        ),
      );
      const { ok, failed } = partition(results);
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(7);
      for (const reason of failed) {
        expect(reason).toBeInstanceOf(VersionConflictError);
        expect((reason as VersionConflictError).latestVersion).toBe(2);
      }
    });

    it("lets exactly one of a start and a cancel that both read version 1 win", async () => {
      const planned = await newExperiment(db);
      const results = await Promise.allSettled([
        setExperimentStatus(db, planned, "running"),
        setExperimentStatus(db, planned, "cancelled", newAgent()),
      ]);
      const { ok, failed } = partition(results);
      expect(ok).toHaveLength(1);
      expect(failed[0]).toBeInstanceOf(VersionConflictError);
      expect(["running", "cancelled"]).toContain((await readExperiment(db, planned.id)).status);
    });

    it("still lets exactly one win if the row lock is taken away: the version predicate decides", async () => {
      const planned = await newExperiment(db);
      const results = await withoutRowLock(db, ["update_experiment_status"], () =>
        Promise.allSettled(
          Array.from({ length: 8 }, () => setExperimentStatus(db, planned, "running")),
        ),
      );
      const { ok, failed } = partition(results);
      expect(ok).toHaveLength(1);
      for (const reason of failed) {
        expect(reason).toBeInstanceOf(VersionConflictError);
      }
      expect((await readExperiment(db, planned.id)).version).toBe(2);
    });
  });

  it("refuses a missing or malformed id or version, and an experiment that does not exist", async () => {
    const planned = await newExperiment(db);
    const call = (id: string | null, version: number | null, status: string | null) =>
      db
        .pool("ytw_mcp")
        .query(
          sql`SELECT * FROM update_experiment_status('bot', 'agent', NULL, ${id}::uuid, ${version}::integer, ${status})`,
        );
    expect((await rejectedWith(call(null, 1, "running"), ValidationError)).field).toBe("id");
    expect((await rejectedWith(call(planned.id, null, "running"), ValidationError)).field).toBe(
      "expected_version",
    );
    expect((await rejectedWith(call(planned.id, 0, "running"), ValidationError)).field).toBe(
      "expected_version",
    );
    expect((await rejectedWith(call(planned.id, 1, null), ValidationError)).field).toBe(
      "new_status",
    );
    const missing = randomUUID();
    expect(await rejectedWith(call(missing, 1, "running"), NotFoundError)).toMatchObject({
      entity: "experiment",
      id: missing,
    });
    const bad = await rejectedWith(
      act(db, alice, (tx) =>
        updateExperimentStatus(tx, { id: "nope", expectedVersion: 1, newStatus: "running" }),
      ),
      ValidationError,
    );
    expect(bad.field).toBe("id");
  });
});

// ---------------------------------------------------------------------------------------------

describe("record_variant_stats", () => {
  it("records impressions and CTR of a variant of a planned or running experiment", async () => {
    for (const status of ["planned", "running"] as const) {
      const experiment = await experimentIn(db, status);
      const [a, b] = experiment.variants;
      const agent = newAgent("stats bot");
      const recorded = await stats(a?.id as string, { impressions: 12_000, ctr: 4.5 }, agent);
      expect(recorded).toMatchObject({
        id: a?.id,
        experimentId: experiment.id,
        label: a?.label,
        isControl: true,
        impressions: "12000",
        ctr: "4.5",
        updatedBy: "stats bot",
        createdBy: "alice",
      });
      expect(await stats(b?.id as string, { impressions: "11500", ctr: "5.25" })).toMatchObject({
        impressions: "11500",
        ctr: "5.25",
      });
      const last = (await eventsFor(db, a?.id as string)).at(-1);
      expect(last).toMatchObject({
        actor: "stats bot",
        token_id: agent.tokenId,
        action: "update",
        entity_type: "experiment_variant",
        payload: { old: { impressions: null, ctr: null }, new: { impressions: 12000, ctr: 4.5 } },
      });
      expect((await readExperiment(db, experiment.id)).version).toBe(experiment.version);
    }
  });

  it("overwrites earlier numbers (the last writer wins) and keeps what is not given", async () => {
    const experiment = await runningExperiment(db);
    const variant = experiment.variants[0]?.id as string;
    await stats(variant, { impressions: 100, ctr: 1 });
    expect(await stats(variant, { ctr: 2.5 })).toMatchObject({ impressions: "100", ctr: "2.5" });
    expect(await stats(variant, { impressions: 250 })).toMatchObject({
      impressions: "250",
      ctr: "2.5",
    });
    expect(await stats(variant, { impressions: 0, ctr: 0 })).toMatchObject({
      impressions: "0",
      ctr: "0",
    });
  });

  it("keeps exact values", async () => {
    const experiment = await runningExperiment(db);
    const recorded = await stats(experiment.variants[0]?.id as string, {
      impressions: "9007199254740993",
      ctr: "12.345678901234567",
    });
    expect(recorded).toMatchObject({ impressions: "9007199254740993", ctr: "12.345678901234567" });
  });

  it("changes nothing when the stored numbers are recorded again: no audit row", async () => {
    const experiment = await runningExperiment(db);
    const variant = experiment.variants[1]?.id as string;
    const first = await stats(variant, { impressions: 10, ctr: 2 });
    const events = await eventCount(db, variant);
    await tick();
    expect(await stats(variant, { impressions: "10", ctr: "2.0" })).toEqual(first);
    expect(await stats(variant, { ctr: 2 })).toEqual(first);
    expect(await eventCount(db, variant)).toBe(events);
  });

  describe("arguments", () => {
    it.each([
      [{ impressions: -1 }, "impressions", "a whole number from 0 to 9223372036854775807"],
      [{ impressions: 1.5 }, "impressions", "a whole number"],
      [{ impressions: "abc" }, "impressions", "a number or a decimal string"],
      [{ impressions: "9223372036854775808" }, "impressions", "from 0 to 9223372036854775807"],
      [{ ctr: -0.1 }, "ctr", "a number from 0 to 100 (a percentage: 4.5 means 4.5 %)"],
      [{ ctr: 100.1 }, "ctr", "a number from 0 to 100"],
      [{ ctr: "x" }, "ctr", "a number or a decimal string"],
      [{ ctr: "4.123456789012345678901" }, "ctr", "too many decimal places"],
    ])("refuses %j", async (values, field, words) => {
      const err = await statsRefusal(values);
      expect(err.field).toBe(field);
      expect(err.message).toContain(words);
    });

    it("refuses NaN and infinity, as numbers and as numerics sent straight to the function", async () => {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
        expect((await statsRefusal({ ctr: value })).message).toContain("finite number");
        expect((await statsRefusal({ impressions: value })).message).toContain("finite number");
      }
      const experiment = await runningExperiment(db);
      const variant = experiment.variants[0]?.id as string;
      for (const [impressions, ctr] of [
        ["NaN", null],
        ["Infinity", null],
        [null, "NaN"],
        [null, "Infinity"],
        [null, "-Infinity"],
      ]) {
        const err = await rejectedWith(
          db
            .pool("ytw_mcp")
            .query(
              sql`SELECT * FROM record_variant_stats('bot', 'agent', NULL, ${variant}::uuid, ${impressions}::numeric, ${ctr}::numeric)`,
            ),
          ValidationError,
        );
        expect(err.message).toContain("given as a number or a decimal string");
      }
    });

    it("needs at least one of the two numbers", async () => {
      const experiment = await runningExperiment(db);
      const err = await rejectedWith(
        stats(experiment.variants[0]?.id as string, {}),
        ValidationError,
      );
      expect(err.message).toBe("give impressions, ctr or both: there is nothing to record");
    });

    it("needs the id of a variant, not of the experiment or of anything else", async () => {
      const experiment = await runningExperiment(db);
      for (const id of [randomUUID(), experiment.id, experiment.videoId]) {
        expect(await rejectedWith(stats(id, { ctr: 1 }), NotFoundError)).toMatchObject({
          entity: "variant",
          id,
        });
      }
      const bad = await rejectedWith(stats("nope", { ctr: 1 }), ValidationError);
      expect(bad.field).toBe("variant_id");
      const missing = await rejectedWith(
        db
          .pool("ytw_mcp")
          .query(sql`SELECT * FROM record_variant_stats('bot', 'agent', NULL, NULL, 5, 5)`),
        ValidationError,
      );
      expect(missing.field).toBe("variant_id");
    });
  });

  it.each(["concluded", "cancelled"] as const)(
    "is refused once the experiment is %s: its numbers are what the outcome was based on",
    async (status) => {
      const experiment = await experimentIn(db, status);
      const variant = experiment.variants[0]?.id as string;
      const before = await readExperiment(db, experiment.id);
      const events = await eventCount(db, variant);
      const err = await rejectedWith(stats(variant, { impressions: 1 }), InvalidTransitionError);
      expect(err.message).toBe(
        `experiment ${experiment.id} is ${status}, so variant stats can no longer be recorded: they can be recorded while an experiment is "planned" or "running"`,
      );
      expect(err.allowed).toEqual([]);
      expect(err.details).toMatchObject({ entity: "experiment", from: status, reason: "terminal" });
      expect(await readExperiment(db, experiment.id)).toEqual(before);
      expect(await eventCount(db, variant)).toBe(events);
    },
  );

  it("works on the experiments of an archived video", async () => {
    const experiment = await runningExperiment(db);
    await act(db, alice, (tx) => archiveVideo(tx, { id: experiment.videoId }));
    expect((await stats(experiment.variants[0]?.id as string, { ctr: 3 })).ctr).toBe("3");
  });

  it("accepts any number of racing writers without errors: the last one decides, nothing is corrupted", async () => {
    const experiment = await runningExperiment(db);
    const variant = experiment.variants[0]?.id as string;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        stats(variant, { impressions: 1000 + i, ctr: i }, i % 2 === 0 ? alice : newAgent()),
      ),
    );
    expect(partition(results).failed).toEqual([]);
    const final = (await readExperiment(db, experiment.id)).variants.find((v) => v.id === variant);
    expect(final?.impressions).toMatch(/^100[0-7]$/);
    expect(Number(final?.ctr)).toBe(Number(final?.impressions) - 1000);
  });

  it("waits for a conclusion that started first and then fails, and a conclusion waits for stats that started first", async () => {
    const early = await runningExperiment(db);
    const concluder = await db.pool("ytw_web").connect();
    try {
      await concluder.query("BEGIN");
      await concluder.query(
        sql`SELECT conclude_experiment('alice', 'human', NULL, ${early.id}::uuid, ${early.version}::integer, ${early.variants[0]?.id}::uuid, 'done')`,
      );
      const racing = act(db, newAgent(), (tx) =>
        recordVariantStats(tx, { variantId: early.variants[1]?.id as string, ctr: 9 }),
      );
      const outcome = racing.then(
        () => undefined,
        (err: unknown) => err,
      );
      await waitForLockWait(db, "record_variant_stats");
      await concluder.query("COMMIT");
      expect(await outcome).toBeInstanceOf(InvalidTransitionError);
      expect((await readExperiment(db, early.id)).variants[1]?.ctr).toBeNull();
    } finally {
      await concluder.query("ROLLBACK").catch(() => undefined);
      concluder.release();
    }

    const late = await runningExperiment(db);
    const recorder = await db.pool("ytw_mcp").connect();
    try {
      await recorder.query("BEGIN");
      await recorder.query(
        sql`SELECT record_variant_stats('bot', 'agent', ${randomUUID()}::uuid, ${late.variants[1]?.id}::uuid, 5000, 7)`,
      );
      const concluding = conclude(late, late.variants[1]?.id as string);
      const done = concluding.then(
        (value) => value,
        (err: unknown) => err,
      );
      await waitForLockWait(db, "conclude_experiment");
      await recorder.query("COMMIT");
      expect(await done).toMatchObject({ status: "concluded" });
      expect((await readExperiment(db, late.id)).variants[1]).toMatchObject({
        impressions: "5000",
        ctr: "7",
      });
    } finally {
      await recorder.query("ROLLBACK").catch(() => undefined);
      recorder.release();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("conclude_experiment", () => {
  it("concludes a running experiment with a winner and a conclusion", async () => {
    const running = await runningExperiment(db);
    const winner = running.variants[1];
    await tick();
    const agent = newAgent("analyst");
    const concluded = await conclude(
      running,
      winner?.id as string,
      "B won by 1.2 points of CTR",
      agent,
    );
    expect(concluded).toMatchObject({
      id: running.id,
      status: "concluded",
      winnerVariantId: winner?.id,
      conclusion: "B won by 1.2 points of CTR",
      version: running.version + 1,
      startsAt: running.startsAt,
      updatedBy: "analyst",
    });
    expect(concluded.endsAt?.getTime()).toBeGreaterThanOrEqual(
      running.startsAt?.getTime() as number,
    );
    expect(await readExperiment(db, running.id)).toMatchObject({
      status: "concluded",
      winnerVariantId: winner?.id,
    });
    const last = (await eventsFor(db, running.id)).at(-1);
    expect(last).toMatchObject({
      actor: "analyst",
      token_id: agent.tokenId,
      action: "update",
      entity_type: "experiment",
      payload: {
        old: { status: "running", winner_variant_id: null, conclusion: null },
        new: {
          status: "concluded",
          winner_variant_id: winner?.id,
          conclusion: "B won by 1.2 points of CTR",
        },
      },
    });
  });

  it("accepts either variant as the winner, and no winner at all", async () => {
    for (const index of [0, 1]) {
      const running = await runningExperiment(db);
      const variant = running.variants[index];
      expect((await conclude(running, variant?.id as string)).winnerVariantId).toBe(variant?.id);
    }
    const noWinner = await conclude(await runningExperiment(db), null, "No significant difference");
    expect(noWinner).toMatchObject({
      status: "concluded",
      winnerVariantId: null,
      conclusion: "No significant difference",
    });
  });

  describe("the winner must be a variant of this experiment", () => {
    it("refuses a variant of another experiment with the valid ids, before anything is written", async () => {
      const mine = await runningExperiment(db);
      const theirs = await runningExperiment(db);
      const foreign = theirs.variants[1]?.id as string;
      const events = await eventCount(db, mine.id);
      const err = await rejectedWith(conclude(mine, foreign), ValidationError);
      expect(err.field).toBe("winner_variant_id");
      expect(err.allowed).toEqual(mine.variants.map((variant) => variant.id));
      expect(err.message).toBe(
        `winner_variant_id ${foreign} is not a variant of experiment ${mine.id}: choose one of its variants, or pass null when no variant won: ${mine.variants[0]?.id} ("A", control), ${mine.variants[1]?.id} ("B")`,
      );
      expect(err.details).toMatchObject({ field: "winner_variant_id", value: foreign });
      expect(await readExperiment(db, mine.id)).toEqual(mine);
      expect(await readExperiment(db, theirs.id)).toEqual(theirs);
      expect(await eventCount(db, mine.id)).toBe(events);
    });

    it("also refuses the control of another experiment on the same video, and an id that exists nowhere", async () => {
      const video = await newVideo(db);
      const mine = await runningExperiment(db, { videoId: video.id });
      const sibling = await runningExperiment(db, { videoId: video.id });
      for (const id of [sibling.variants[0]?.id as string, randomUUID(), mine.videoId, mine.id]) {
        const err = await rejectedWith(conclude(mine, id), ValidationError);
        expect(err.field).toBe("winner_variant_id");
      }
      expect((await readExperiment(db, mine.id)).status).toBe("running");
    });

    it("is not left to the deferred foreign key, which would only fail at COMMIT with a bare 23503", async () => {
      const mine = await runningExperiment(db);
      const theirs = await runningExperiment(db);
      const client = await db.admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT ytw_set_actor('fixture', 'human', NULL)");
        // The foreign winner is accepted by the UPDATE itself ...
        await client.query(
          "UPDATE experiments SET status = 'concluded', winner_variant_id = $2 WHERE id = $1",
          [mine.id, theirs.variants[0]?.id],
        );
        // ... and only the commit notices.
        expect(await sqlstate(client.query("COMMIT"))).toBe("23503");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      expect((await readExperiment(db, mine.id)).status).toBe("running");
    });

    it("refuses a malformed winner id before it reaches the database", async () => {
      const running = await runningExperiment(db);
      const err = await rejectedWith(conclude(running, "not-a-uuid"), ValidationError);
      expect(err.field).toBe("winner_variant_id");
    });
  });

  describe("the conclusion", () => {
    it.each([
      [null, "conclusion is required"],
      ["", "conclusion is required"],
      ["  \n", "conclusion is required"],
      ["c".repeat(20_001), "conclusion is too long: 20001 characters, the limit is 20000"],
    ])("refuses %j", async (conclusion, words) => {
      const running = await runningExperiment(db);
      const err = await rejectedWith(
        db
          .pool("ytw_mcp")
          .query(
            sql`SELECT * FROM conclude_experiment('bot', 'agent', NULL, ${running.id}::uuid, ${running.version}::integer, ${running.variants[0]?.id}::uuid, ${conclusion})`,
          ),
        ValidationError,
      );
      expect(err.field).toBe("conclusion");
      expect(err.message).toContain(words);
      expect(await readExperiment(db, running.id)).toEqual(running);
    });

    it("takes a conclusion of exactly 20000 characters", async () => {
      const running = await runningExperiment(db);
      const concluded = await conclude(running, null, "c".repeat(20_000));
      expect(concluded.conclusion).toHaveLength(20_000);
    });
  });

  describe("an experiment that is not running", () => {
    it("cannot be concluded twice: the conclusion is final", async () => {
      const running = await runningExperiment(db);
      const first = await conclude(running, running.variants[0]?.id as string, "First word");
      const events = await eventCount(db, running.id);
      const err = await rejectedWith(
        conclude(first, running.variants[1]?.id as string, "Second thoughts"),
        InvalidTransitionError,
      );
      expect(err.message).toBe(
        `experiment ${running.id} is concluded, so it cannot be concluded again: a conclusion is final and cannot be repeated or changed`,
      );
      expect(err.allowed).toEqual([]);
      expect(err.details).toMatchObject({ from: "concluded", reason: "terminal" });
      expect(await readExperiment(db, running.id)).toMatchObject({
        winnerVariantId: running.variants[0]?.id,
        conclusion: "First word",
        version: first.version,
      });
      expect(await eventCount(db, running.id)).toBe(events);
    });

    it("cannot be concluded while planned: it must be started first", async () => {
      const planned = await newExperiment(db);
      const err = await rejectedWith(
        conclude(planned, planned.variants[0]?.id as string),
        InvalidTransitionError,
      );
      expect(err.message).toBe(
        'an experiment in status "planned" cannot move to "concluded"; valid next statuses: "running", "cancelled"',
      );
      expect(err.allowed).toEqual(["running", "cancelled"]);
      expect((await readExperiment(db, planned.id)).status).toBe("planned");
    });

    it("cannot be concluded once cancelled", async () => {
      const cancelled = await experimentIn(db, "cancelled");
      const err = await rejectedWith(conclude(cancelled, null), InvalidTransitionError);
      expect(err.message).toBe(
        `experiment ${cancelled.id} is cancelled, so it cannot be concluded`,
      );
      expect((await readExperiment(db, cancelled.id)).status).toBe("cancelled");
    });

    it("reports a stale version before the state of the experiment", async () => {
      const running = await runningExperiment(db);
      const done = await conclude(running, null);
      const err = await rejectedWith(conclude(running, null), VersionConflictError);
      expect(err.latestVersion).toBe(done.version);
    });
  });

  describe("optimistic concurrency", () => {
    it("fails with the latest version when expected_version is stale", async () => {
      const running = await runningExperiment(db);
      const err = await rejectedWith(
        conclude({ id: running.id, version: running.version - 1 }, null),
        VersionConflictError,
      );
      expect(err.latestVersion).toBe(running.version);
      expect(err.message).toContain(`the latest version is ${running.version}`);
      expect((await readExperiment(db, running.id)).status).toBe("running");
    });

    it("lets exactly one of racing conclusions win, whatever the winner they name", async () => {
      const running = await runningExperiment(db);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          conclude(
            running,
            running.variants[i % 2]?.id as string,
            `verdict ${i}`,
            i % 2 === 0 ? alice : newAgent(),
          ),
        ),
      );
      const { ok, failed } = partition(results);
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(7);
      for (const reason of failed) {
        expect(reason).toBeInstanceOf(VersionConflictError);
        expect((reason as VersionConflictError).latestVersion).toBe(running.version + 1);
      }
      expect((await readExperiment(db, running.id)).conclusion).toBe(ok[0]?.conclusion);
    });

    it("lets exactly one of a conclusion and a cancellation that both read the same version win", async () => {
      const running = await runningExperiment(db);
      const results = await Promise.allSettled([
        conclude(running, null),
        setExperimentStatus(db, running, "cancelled", newAgent()),
      ]);
      const { ok, failed } = partition(results);
      expect(ok).toHaveLength(1);
      expect(failed[0]).toBeInstanceOf(VersionConflictError);
    });

    it("still lets exactly one win if the row lock is taken away: the version predicate decides", async () => {
      const running = await runningExperiment(db);
      const results = await withoutRowLock(db, ["conclude_experiment"], () =>
        Promise.allSettled(
          Array.from({ length: 8 }, (_, i) =>
            conclude(running, running.variants[i % 2]?.id as string),
          ),
        ),
      );
      const { ok, failed } = partition(results);
      expect(ok).toHaveLength(1);
      for (const reason of failed) {
        expect(reason).toBeInstanceOf(VersionConflictError);
      }
      expect((await readExperiment(db, running.id)).version).toBe(running.version + 1);
    });
  });

  it("refuses a missing or malformed id or version, and an experiment that does not exist", async () => {
    const running = await runningExperiment(db);
    const call = (id: string | null, version: number | null) =>
      db
        .pool("ytw_mcp")
        .query(
          sql`SELECT * FROM conclude_experiment('bot', 'agent', NULL, ${id}::uuid, ${version}::integer, NULL, 'x')`,
        );
    expect((await rejectedWith(call(null, 1), ValidationError)).field).toBe("id");
    expect((await rejectedWith(call(running.id, null), ValidationError)).field).toBe(
      "expected_version",
    );
    expect((await rejectedWith(call(running.id, 0), ValidationError)).field).toBe(
      "expected_version",
    );
    const missing = randomUUID();
    expect(await rejectedWith(call(missing, 1), NotFoundError)).toMatchObject({
      entity: "experiment",
      id: missing,
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("a whole experiment", () => {
  it("runs from a video to a conclusion, and the audit trail names who did what", async () => {
    const owner = alice;
    const agent = newAgent("packaging bot");
    const video = await newVideo(db, { title: "The test video" }, agent);
    const planned = await newExperiment(db, { videoId: video.id, type: "thumbnail" }, agent);
    const running = await setExperimentStatus(db, planned, "running", owner);
    const [control, challenger] = planned.variants;
    await stats(control?.id as string, { impressions: 5000, ctr: 4.1 }, agent);
    await stats(challenger?.id as string, { impressions: 5100, ctr: 5.3 }, agent);
    const concluded = await conclude(
      running,
      challenger?.id as string,
      "The challenger won",
      owner,
    );

    const finished = await getExperiment(db.pool("ytw_readonly"), planned.id);
    expect(finished).toMatchObject({
      status: "concluded",
      winnerVariantId: challenger?.id,
      version: 3,
    });
    expect(
      finished?.variants.map((variant) => [variant.label, variant.impressions, variant.ctr]),
    ).toEqual([
      ["A", "5000", "4.1"],
      ["B", "5100", "5.3"],
    ]);
    expect(concluded.version).toBe(3);

    const { rows } = await db.admin.query<{ actor: string; entity_type: string; action: string }>(
      `SELECT actor, entity_type, action FROM events
        WHERE entity_id = ANY($1) ORDER BY created_at, id`,
      [[planned.id, control?.id, challenger?.id]],
    );
    expect(rows.map((row) => `${row.actor}:${row.entity_type}:${row.action}`)).toEqual([
      "packaging bot:experiment:insert",
      "packaging bot:experiment_variant:insert",
      "packaging bot:experiment_variant:insert",
      "alice:experiment:update",
      "packaging bot:experiment_variant:update",
      "packaging bot:experiment_variant:update",
      "alice:experiment:update",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("arguments that are NULL", () => {
  // Generated at run time: a literal id next to a "token" key reads as a credential to the secret scan.
  const agentToken = randomUUID();
  const specs: FunctionSpec[] = [
    {
      name: "create_experiment",
      types: ["text", "text", "uuid", "uuid", "text", "text", "jsonb"],
      valid: async () => [
        "bot",
        "agent",
        agentToken,
        (await newVideo(db)).id,
        "title",
        "A hypothesis",
        JSON.stringify(TWO_RAW),
      ],
      optional: [2, 5],
    },
    {
      name: "update_experiment_status",
      types: ["text", "text", "uuid", "uuid", "integer", "text"],
      valid: async () => ["bot", "agent", agentToken, (await newExperiment(db)).id, 1, "running"],
      optional: [2],
    },
    {
      name: "record_variant_stats",
      types: ["text", "text", "uuid", "uuid", "numeric", "numeric"],
      valid: async () => [
        "bot",
        "agent",
        agentToken,
        (await runningExperiment(db)).variants[0]?.id,
        100,
        4.5,
      ],
      // One of impressions and ctr may be NULL, but not both (the matrix nulls one at a time).
      optional: [2, 4, 5],
    },
    {
      name: "conclude_experiment",
      types: ["text", "text", "uuid", "uuid", "integer", "uuid", "text"],
      valid: async () => {
        const running = await runningExperiment(db);
        return [
          "bot",
          "agent",
          agentToken,
          running.id,
          running.version,
          running.variants[0]?.id,
          "Done",
        ];
      },
      optional: [2, 5],
    },
  ];

  it.each(specs)(
    "$name answers a NULL with a validation error wherever a value is required",
    async (spec) => {
      expect(await nullArgumentOutcomes(db, spec)).toEqual(expectedNullOutcomes(spec));
    },
  );
});

// ---------------------------------------------------------------------------------------------

describe("privileges and isolation", () => {
  const WRITERS = [
    "create_experiment",
    "update_experiment_status",
    "record_variant_stats",
    "conclude_experiment",
  ];
  const HELPERS = [
    "ytw_experiment_types",
    "ytw_experiment_statuses",
    "ytw_experiment_status_transitions",
    "ytw_experiment_next_text",
    "ytw_raise_experiment_move",
    "ytw_raise_experiment_final",
    "ytw_check_variants",
  ];

  it.each(WRITERS)(
    "%s is SECURITY DEFINER, pins its search path and is executable by exactly ytw_web and ytw_mcp",
    async (name) => {
      const found = Object.values(await functionPrivileges(db, name));
      expect(found).toEqual([
        {
          roles: ["ytw_mcp", "ytw_web"],
          publicExecute: false,
          definer: true,
          searchPath: "search_path=pg_catalog, public, pg_temp",
        },
      ]);
    },
  );

  it.each(HELPERS)("keeps the helper %s out of reach of every application role", async (name) => {
    for (const privileges of Object.values(await functionPrivileges(db, name))) {
      expect(privileges).toMatchObject({ roles: [], publicExecute: false });
    }
  });

  it("keeps the catalog guard clean", async () => {
    const { rows } = await db.admin.query("SELECT * FROM ytw_catalog_violations()");
    expect(rows).toEqual([]);
  });

  it("denies direct writes to experiments and variants to every application role, and the functions to ytw_readonly", async () => {
    const experiment = await newExperiment(db);
    const denied = /^(42501|25006)$/;
    for (const role of ["ytw_web", "ytw_mcp", "ytw_readonly"] as const) {
      const pool = db.pool(role);
      for (const statement of [
        `INSERT INTO experiments (video_id, type) VALUES ('${experiment.videoId}', 'title')`,
        `INSERT INTO experiment_variants (experiment_id, label, content) VALUES ('${experiment.id}', 'Z', 'z')`,
        "UPDATE experiments SET status = 'concluded'",
        "UPDATE experiments SET winner_variant_id = NULL",
        "UPDATE experiment_variants SET ctr = 99",
        "UPDATE experiment_variants SET is_control = true",
        "DELETE FROM experiments",
        "DELETE FROM experiment_variants",
        "TRUNCATE experiments",
        "TRUNCATE experiment_variants",
      ]) {
        expect(await sqlstate(pool.query(statement))).toMatch(denied);
      }
    }
    const readonly = db.pool("ytw_readonly");
    for (const statement of [
      `SELECT * FROM update_experiment_status('x', 'human', NULL, '${experiment.id}', 1, 'running')`,
      `SELECT * FROM record_variant_stats('x', 'human', NULL, '${experiment.variants[0]?.id}', 1, 1)`,
      `SELECT * FROM conclude_experiment('x', 'human', NULL, '${experiment.id}', 1, NULL, 'x')`,
      `SELECT * FROM create_experiment('x', 'human', NULL, '${experiment.videoId}', 'title', NULL, '[]')`,
    ]) {
      expect(await sqlstate(readonly.query(statement))).toBe("42501");
    }
    expect(await readExperiment(db, experiment.id)).toEqual(experiment);
  });

  it("is not fooled by temporary tables that shadow the real ones", async () => {
    const video = await newVideo(db);
    const client = await db.admin.connect();
    try {
      await client.query("CREATE TEMP TABLE experiments (id uuid, video_id uuid)");
      await client.query("CREATE TEMP TABLE experiment_variants (id uuid, experiment_id uuid)");
      await client.query("CREATE TEMP TABLE videos (id uuid, archived_at timestamptz)");
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM create_experiment('mallory', 'human', NULL, $1, 'title', 'h', $2::jsonb)",
        [video.id, JSON.stringify(TWO_RAW)],
      );
      expect(rows).toHaveLength(1);
      const temp = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_temp.experiments",
      );
      expect(temp.rows[0]?.n).toBe(0);
    } finally {
      client.release(true);
    }
    expect(await experimentCount(video.id)).toBe(1);
  });
});
