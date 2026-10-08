// Scripts, notes, videos, metrics and experiments: one happy path and the key rule of each.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorTx } from "../src/client.js";
import {
  DuplicateError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from "../src/errors.js";
import {
  concludeExperiment,
  createExperiment,
  recordVariantStats,
  updateExperimentStatus,
} from "../src/experiments.js";
import { createIdea } from "../src/ideas.js";
import { listMetricSnapshots, logMetrics } from "../src/metrics.js";
import { addNote, listNotes } from "../src/notes.js";
import { getScriptVersion, saveScriptVersion, setScriptStatus } from "../src/scripts.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { archiveVideo, registerVideo, updateVideo } from "../src/videos.js";
import { actAs, alice, failure, newAgent, signIn } from "./helpers.js";

let db: TestDb;
let ideaId: string;
let agent: Awaited<ReturnType<typeof newAgent>>;

beforeAll(async () => {
  db = await createTestDb();
  agent = await newAgent(db, (await signIn(db, "alice")).id, alice);
  ideaId = (await act((tx) => createIdea(tx, { title: "Content" }))).id;
});

afterAll(async () => {
  await db.drop();
});

const act = <T>(fn: (tx: ActorTx) => Promise<T>) => actAs(db, alice, fn);
const youtubeId = () => randomBytes(8).toString("base64url");
const newVideo = () =>
  act((tx) => registerVideo(tx, { ideaId, youtubeId: youtubeId(), title: "V" }));

describe("scripts", () => {
  it("are append-only revisions saved against the version that was edited", async () => {
    const save = (baseVersion: number, bodyMd: string) =>
      act((tx) => saveScriptVersion(tx, { ideaId, kind: "script", baseVersion, bodyMd }));
    expect(await save(0, "# One")).toMatchObject({ version: 1, status: "draft" });
    const second = await save(1, "# Two");
    expect(second.version).toBe(2);

    const stale = await failure(save(1, "# Lost"));
    expect(stale).toBeInstanceOf(VersionConflictError);
    expect((stale as VersionConflictError).latestVersion).toBe(2);

    await act((tx) => setScriptStatus(tx, { scriptId: second.id, status: "approved" }));
    expect(await getScriptVersion(db.pool, { ideaId, kind: "script" })).toMatchObject({
      version: 2,
      status: "approved",
      bodyMd: "# Two",
    });
    const edit = await failure(
      act((tx) => tx.query("UPDATE scripts SET body_md = 'x' WHERE id = $1", [second.id])),
    );
    expect(edit.message).toContain("append-only");
  });
});

describe("notes", () => {
  it("are comments on existing records, written by people and agents", async () => {
    const entity = { entityType: "idea", entityId: ideaId } as const;
    const note = await actAs(db, agent, (tx) => addNote(tx, { ...entity, bodyMd: "Looks good" }));
    expect(note).toMatchObject({ author: agent.name, actorType: "agent" });
    expect((await listNotes(db.pool, entity)).map((n) => n.id)).toContain(note.id);

    const unknown = { entityType: "video", entityId: randomUUID(), bodyMd: "Hi" } as const;
    expect(await failure(act((tx) => addNote(tx, unknown)))).toBeInstanceOf(NotFoundError);
  });
});

describe("videos and metrics", () => {
  it("register once per YouTube id and are edited with the version that was read", async () => {
    const id = youtubeId();
    const video = await act((tx) => registerVideo(tx, { ideaId, youtubeId: id, title: "T" }));
    const again = await failure(act((tx) => registerVideo(tx, { youtubeId: id, title: "Again" })));
    expect(again).toBeInstanceOf(DuplicateError);
    expect((again as DuplicateError).existingId).toBe(video.id);

    const edit = (expectedVersion: number) =>
      act((tx) => updateVideo(tx, { id: video.id, expectedVersion, fields: { title: "New" } }));
    expect(await edit(1)).toMatchObject({ title: "New", version: 2 });
    expect(await failure(edit(1))).toBeInstanceOf(VersionConflictError);
  });

  it("log snapshots idempotently and refuse different numbers for the same instant", async () => {
    const video = await newVideo();
    const log = (views: number, capturedAt = "2026-10-01T12:00:00Z") =>
      actAs(db, agent, (tx) =>
        logMetrics(tx, { videoId: video.id, capturedAt, metrics: { views, ctr: 4.5 } }),
      );
    expect(await log(100)).toMatchObject({ created: true, snapshot: { views: "100", ctr: "4.5" } });
    expect(await log(100)).toMatchObject({ created: false });
    expect(await failure(log(101))).toBeInstanceOf(DuplicateError);
    expect(await listMetricSnapshots(db.pool, { videoId: video.id })).toHaveLength(1);

    await act((tx) => archiveVideo(tx, { id: video.id }));
    const archived = await failure(log(1, "2026-10-02T12:00:00Z"));
    expect(archived).toBeInstanceOf(InvalidTransitionError);
  });
});

describe("experiments", () => {
  it("run planned, running, concluded with a winner that belongs to them", async () => {
    const video = await newVideo();
    const variants = [
      { label: "A", content: "Old title", isControl: true },
      { label: "B", content: "New title" },
    ];
    const create = () =>
      act((tx) => createExperiment(tx, { videoId: video.id, type: "title", variants }));
    const [experiment, other] = [await create(), await create()];
    expect(experiment).toMatchObject({ status: "planned", version: 1 });
    const variant = experiment.variants[1];

    const running = await act((tx) =>
      updateExperimentStatus(tx, { id: experiment.id, expectedVersion: 1, newStatus: "running" }),
    );
    const stats = { variantId: variant?.id ?? "", impressions: 1000, ctr: 5 };
    expect(await actAs(db, agent, (tx) => recordVariantStats(tx, stats))).toMatchObject({
      impressions: "1000",
      ctr: "5",
    });

    const conclude = (winnerVariantId: string | null, expectedVersion = running.version) =>
      act((tx) =>
        concludeExperiment(tx, {
          id: experiment.id,
          expectedVersion,
          winnerVariantId,
          conclusion: "B",
        }),
      );
    const foreign = await failure(conclude(other.variants[0]?.id ?? ""));
    expect(foreign).toBeInstanceOf(ValidationError);
    expect((foreign as ValidationError).field).toBe("winner_variant_id");

    const concluded = await conclude(variant?.id ?? null);
    expect(concluded).toMatchObject({ status: "concluded", winnerVariantId: variant?.id });
    const again = await failure(conclude(null, concluded.version));
    expect(again).toBeInstanceOf(InvalidTransitionError);
  });
});
