// Gate: Stage machine exhaustive fuzzing & transition verification (PRD 4 "Idea stages", PRD 5 "advance_idea").
//
// 1. Exhaustively tests all 49 pairwise combinations of the 7 idea stages:
//    - 5 valid forward transitions (no note required)
//    - 5 valid backward transitions (note strictly required)
//    - 6 valid drop transitions (any stage -> dropped)
//    - 1 valid undrop/restore transition (dropped -> inbox)
//    - 7 invalid same-stage transitions (rejected with InvalidTransitionError)
//    - 25 invalid skip/jump transitions (rejected with InvalidTransitionError)
// 2. Fuzzing with invalid strings, whitespace, null bytes, casing, injection payloads.
// 3. Verifies that backward transitions without a non-empty note are rejected with ValidationError (field: note).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor, type Actor } from "../../src/client.js";
import { InvalidTransitionError, ValidationError } from "../../src/errors.js";
import { advanceIdea, createIdea, getIdea, type IdeaRecord } from "../../src/ideas.js";
import { listNotes } from "../../src/notes.js";
import { createTestDb, type TestDb } from "../../src/testing.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

const STAGES = [
  "inbox",
  "shortlisted",
  "scripting",
  "filming",
  "editing",
  "published",
  "dropped",
] as const;

type Stage = (typeof STAGES)[number];

const FORWARD_PAIRS: readonly [Stage, Stage][] = [
  ["inbox", "shortlisted"],
  ["shortlisted", "scripting"],
  ["scripting", "filming"],
  ["filming", "editing"],
  ["editing", "published"],
];

const BACKWARD_PAIRS: readonly [Stage, Stage][] = [
  ["shortlisted", "inbox"],
  ["scripting", "shortlisted"],
  ["filming", "scripting"],
  ["editing", "filming"],
  ["published", "editing"],
];

const DROP_PAIRS: readonly [Stage, Stage][] = [
  ["inbox", "dropped"],
  ["shortlisted", "dropped"],
  ["scripting", "dropped"],
  ["filming", "dropped"],
  ["editing", "dropped"],
  ["published", "dropped"],
];

const UNDROP_PAIRS: readonly [Stage, Stage][] = [["dropped", "inbox"]];

function isPair(list: readonly [Stage, Stage][], from: Stage, to: Stage): boolean {
  return list.some(([f, t]) => f === from && t === to);
}

const JUMP_PAIRS: readonly [Stage, Stage][] = STAGES.flatMap((from) =>
  STAGES.filter(
    (to) =>
      from !== to &&
      !isPair(FORWARD_PAIRS, from, to) &&
      !isPair(BACKWARD_PAIRS, from, to) &&
      !isPair(DROP_PAIRS, from, to) &&
      !isPair(UNDROP_PAIRS, from, to),
  ).map((to) => [from, to] as [Stage, Stage]),
);

const alice: Actor = { name: "alice", type: "human" };

/** Helper to place an idea into an arbitrary stage via fixture superuser query */
async function placeIdeaInStage(stage: Stage): Promise<IdeaRecord> {
  const idea = await withActor(db.pool("ytw_web"), alice, (tx) =>
    createIdea(tx, { title: `Idea in stage ${stage}` }),
  );
  if (stage !== "inbox") {
    await withActor(db.admin, { name: "fixture", type: "human" }, (tx) =>
      tx.query("UPDATE public.ideas SET status = $2 WHERE id = $1", [idea.id, stage]),
    );
  }
  const placed = await getIdea(db.admin, idea.id);
  return placed!;
}

describe("gate: stage-machine fuzzing & 49 pairwise transition matrix", () => {
  describe("valid forward moves", () => {
    for (const [from, to] of FORWARD_PAIRS) {
      it(`valid forward: ${from} -> ${to} succeeds without a note`, async () => {
        const idea = await placeIdeaInStage(from);
        const result = await withActor(db.pool("ytw_web"), alice, (tx) =>
          advanceIdea(tx, { id: idea.id, newStatus: to }),
        );
        expect(result.idea.status).toBe(to);
        expect(result.noteId).toBeNull();
      });

      it(`valid forward: ${from} -> ${to} succeeds with an optional note`, async () => {
        const idea = await placeIdeaInStage(from);
        const result = await withActor(db.pool("ytw_web"), alice, (tx) =>
          advanceIdea(tx, {
            id: idea.id,
            newStatus: to,
            note: `Forward move from ${from} to ${to}`,
          }),
        );
        expect(result.idea.status).toBe(to);
        expect(result.noteId).toBeDefined();

        const notes = await listNotes(db.admin, { entityType: "idea", entityId: idea.id });
        expect(notes.some((n) => n.id === result.noteId)).toBe(true);
      });
    }
  });

  describe("valid backward moves with note", () => {
    for (const [from, to] of BACKWARD_PAIRS) {
      it(`valid backward: ${from} -> ${to} succeeds when note is provided`, async () => {
        const idea = await placeIdeaInStage(from);
        const result = await withActor(db.pool("ytw_web"), alice, (tx) =>
          advanceIdea(tx, {
            id: idea.id,
            newStatus: to,
            note: `Need more work: moving back from ${from} to ${to}`,
          }),
        );
        expect(result.idea.status).toBe(to);
        expect(result.noteId).toBeDefined();

        const notes = await listNotes(db.admin, { entityType: "idea", entityId: idea.id });
        expect(notes.some((n) => n.id === result.noteId)).toBe(true);
      });

      it(`invalid backward: ${from} -> ${to} rejected with ValidationError when note is omitted`, async () => {
        const idea = await placeIdeaInStage(from);
        const promise = withActor(db.pool("ytw_web"), alice, (tx) =>
          advanceIdea(tx, { id: idea.id, newStatus: to, note: null }),
        );
        await expect(promise).rejects.toBeInstanceOf(ValidationError);
        await expect(promise).rejects.toMatchObject({ field: "note" });
      });

      it(`invalid backward: ${from} -> ${to} rejected with ValidationError when note is empty or whitespace`, async () => {
        const idea = await placeIdeaInStage(from);
        for (const emptyNote of ["", "   ", "\t\n  "]) {
          const promise = withActor(db.pool("ytw_web"), alice, (tx) =>
            advanceIdea(tx, { id: idea.id, newStatus: to, note: emptyNote }),
          );
          await expect(promise).rejects.toBeInstanceOf(ValidationError);
          await expect(promise).rejects.toMatchObject({ field: "note" });
        }
      });
    }
  });

  describe("valid drop moves", () => {
    for (const [from, to] of DROP_PAIRS) {
      it(`valid drop: ${from} -> ${to} succeeds without a note`, async () => {
        const idea = await placeIdeaInStage(from);
        const result = await withActor(db.pool("ytw_web"), alice, (tx) =>
          advanceIdea(tx, { id: idea.id, newStatus: to }),
        );
        expect(result.idea.status).toBe(to);
      });

      it(`valid drop: ${from} -> ${to} succeeds with a reason note`, async () => {
        const idea = await placeIdeaInStage(from);
        const result = await withActor(db.pool("ytw_web"), alice, (tx) =>
          advanceIdea(tx, {
            id: idea.id,
            newStatus: to,
            note: `Dropping idea from ${from}`,
          }),
        );
        expect(result.idea.status).toBe(to);
        expect(result.noteId).toBeDefined();
      });
    }
  });

  describe("valid restore moves", () => {
    for (const [from, to] of UNDROP_PAIRS) {
      it(`valid restore: ${from} -> ${to} succeeds`, async () => {
        const idea = await placeIdeaInStage(from);
        const result = await withActor(db.pool("ytw_web"), alice, (tx) =>
          advanceIdea(tx, { id: idea.id, newStatus: to, note: "Restoring idea" }),
        );
        expect(result.idea.status).toBe(to);
      });
    }
  });

  describe("invalid same-stage moves", () => {
    for (const stage of STAGES) {
      it(`invalid same-stage transition: ${stage} -> ${stage} rejected with InvalidTransitionError`, async () => {
        const idea = await placeIdeaInStage(stage);
        const promise = withActor(db.pool("ytw_web"), alice, (tx) =>
          advanceIdea(tx, { id: idea.id, newStatus: stage, note: "no-op move" }),
        );
        await expect(promise).rejects.toBeInstanceOf(InvalidTransitionError);
      });
    }
  });

  describe("forbidden jump transitions", () => {
    for (const [from, to] of JUMP_PAIRS) {
      it(`forbidden jump transition: ${from} -> ${to} rejected with InvalidTransitionError`, async () => {
        const idea = await placeIdeaInStage(from);
        const promise = withActor(db.pool("ytw_web"), alice, (tx) =>
          advanceIdea(tx, { id: idea.id, newStatus: to, note: "illegal jump" }),
        );
        await expect(promise).rejects.toBeInstanceOf(InvalidTransitionError);
      });
    }
  });

  describe("stage argument fuzzing and arbitrary input rejection", () => {
    const MALFORMED_STAGES = [
      "",
      "   ",
      "inbox ",
      " shortlisted",
      "INBOX",
      "Scripting",
      "FILMING",
      "archived",
      "deleted",
      "finished",
      "null",
      "undefined",
      "0",
      "1",
      "true",
      "false",
      "inbox\0",
      "'; DROP TABLE ideas; --",
      "inbox,shortlisted",
      "inbox/shortlisted",
    ];

    for (const malformed of MALFORMED_STAGES) {
      it(`rejects malformed stage "${malformed}" with ValidationError`, async () => {
        const idea = await placeIdeaInStage("inbox");
        const promise = withActor(db.pool("ytw_web"), alice, (tx) =>
          advanceIdea(tx, { id: idea.id, newStatus: malformed as unknown as Stage }),
        );
        await expect(promise).rejects.toBeInstanceOf(ValidationError);
      });
    }
  });
});
