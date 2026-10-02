// Helpers shared by the tests of the video, metric and experiment functions (T13). Not a test file.
import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import type { Actor } from "../src/client.js";
import { toDbError, type DbError } from "../src/errors.js";
import {
  concludeExperiment,
  createExperiment,
  getExperiment,
  updateExperimentStatus,
  type CreateExperimentInput,
  type ExperimentRecord,
  type ExperimentWithVariants,
  type VariantInput,
} from "../src/experiments.js";
import type { TestDb } from "../src/testing.js";
import { registerVideo, type RegisterVideoInput, type VideoRecord } from "../src/videos.js";
import { act, alice } from "./content-helpers.js";
import { failure } from "./helpers.js";

/** A valid, unused YouTube id: 8 random bytes are exactly 11 base64url characters. */
export const youtubeId = (): string => randomBytes(8).toString("base64url");

/** Awaits a promise that must fail with `type` (raw driver errors are mapped first). */
export async function rejectedWith<T extends DbError>(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => T,
): Promise<T> {
  const err = toDbError(await failure(promise));
  expect(err).toBeInstanceOf(type);
  return err as T;
}

/** Registers a video through the real function. */
export function newVideo(
  db: TestDb,
  input: Partial<RegisterVideoInput> = {},
  actor: Actor = alice,
): Promise<VideoRecord> {
  return act(db, actor, (tx) =>
    registerVideo(tx, { youtubeId: youtubeId(), title: "A video", ...input }),
  );
}

/** The two variants most tests use: a control and an alternative. */
export const TWO_VARIANTS: readonly VariantInput[] = [
  { label: "A", content: "Current title", isControl: true },
  { label: "B", content: "A bolder title" },
];

/** Creates a planned experiment (on a new video unless one is given) through the real function. */
export async function newExperiment(
  db: TestDb,
  input: Partial<CreateExperimentInput> = {},
  actor: Actor = alice,
): Promise<ExperimentWithVariants> {
  const videoId = input.videoId ?? (await newVideo(db)).id;
  return act(db, actor, (tx) =>
    createExperiment(tx, {
      videoId,
      type: "title",
      hypothesis: "A bolder title raises the CTR",
      variants: TWO_VARIANTS,
      ...input,
    }),
  );
}

/** Moves an experiment through the real status function. */
export function setExperimentStatus(
  db: TestDb,
  experiment: Pick<ExperimentRecord, "id" | "version">,
  newStatus: "running" | "cancelled",
  actor: Actor = alice,
): Promise<ExperimentRecord> {
  return act(db, actor, (tx) =>
    updateExperimentStatus(tx, {
      id: experiment.id,
      expectedVersion: experiment.version,
      newStatus,
    }),
  );
}

/** An experiment that is running (created, then started). */
export async function runningExperiment(
  db: TestDb,
  input: Partial<CreateExperimentInput> = {},
): Promise<ExperimentWithVariants> {
  const planned = await newExperiment(db, input);
  const running = await setExperimentStatus(db, planned, "running");
  return { ...running, variants: planned.variants };
}

/** An experiment in the given status, reached through the real functions. */
export async function experimentIn(
  db: TestDb,
  status: ExperimentRecord["status"],
): Promise<ExperimentWithVariants> {
  if (status === "planned") {
    return newExperiment(db);
  }
  const running = await runningExperiment(db);
  if (status === "running") {
    return running;
  }
  if (status === "cancelled") {
    return { ...(await setExperimentStatus(db, running, "cancelled")), variants: running.variants };
  }
  const control = running.variants.find((variant) => variant.isControl);
  const concluded = await act(db, alice, (tx) =>
    concludeExperiment(tx, {
      id: running.id,
      expectedVersion: running.version,
      winnerVariantId: control?.id ?? null,
      conclusion: "The control stays",
    }),
  );
  return { ...concluded, variants: running.variants };
}

/** Reads an experiment back as the superuser, failing the test when it is missing. */
export async function readExperiment(db: TestDb, id: string): Promise<ExperimentWithVariants> {
  const experiment = await getExperiment(db.admin, id);
  if (experiment === null) {
    throw new Error(`experiment ${id} vanished`);
  }
  return experiment;
}
