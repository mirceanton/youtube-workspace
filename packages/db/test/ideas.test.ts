import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidTransitionError, ValidationError, VersionConflictError } from "../src/errors.js";
import { advanceIdea, archiveIdea, createIdea, getIdea, updateIdea } from "../src/ideas.js";
import { listNotes } from "../src/notes.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { actAs, alice, failure, newAgent, signIn } from "./helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

const newIdea = (title = "Rust in 100 seconds") =>
  actAs(db, alice, (tx) => createIdea(tx, { title, tags: ["rust"], score: 80 }));

describe("ideas", () => {
  it("are created in the inbox and edited with the version that was read", async () => {
    const idea = await newIdea();
    expect(idea).toMatchObject({ status: "inbox", version: 1, tags: ["rust"], createdBy: "alice" });

    const edited = await actAs(db, alice, (tx) =>
      updateIdea(tx, { id: idea.id, expectedVersion: 1, fields: { pitch: "A fast intro" } }),
    );
    expect(edited).toMatchObject({ version: 2, pitch: "A fast intro", title: idea.title });

    const stale = await failure(
      actAs(db, alice, (tx) =>
        updateIdea(tx, { id: idea.id, expectedVersion: 1, fields: { score: 10 } }),
      ),
    );
    expect(stale).toBeInstanceOf(VersionConflictError);
    expect((stale as VersionConflictError).latestVersion).toBe(2);
    expect((await getIdea(db.pool, idea.id))?.score).toBe(80);

    const blank = await failure(actAs(db, alice, (tx) => createIdea(tx, { title: "  " })));
    expect(blank).toBeInstanceOf(ValidationError);
  });

  it("follow the stage machine: forward, back with a note, drop and restore", async () => {
    const idea = await newIdea();
    const move = (newStatus: Parameters<typeof advanceIdea>[1]["newStatus"], note?: string) =>
      actAs(db, alice, (tx) => advanceIdea(tx, { id: idea.id, newStatus, note }));

    expect((await move("shortlisted")).idea.status).toBe("shortlisted");
    const skip = await failure(move("filming"));
    expect(skip).toBeInstanceOf(InvalidTransitionError);
    expect((skip as InvalidTransitionError).allowed).toEqual(["scripting", "inbox", "dropped"]);

    const noNote = await failure(move("inbox"));
    expect(noNote).toBeInstanceOf(ValidationError);
    expect((noNote as ValidationError).field).toBe("note");
    const back = await move("inbox", "needs a better hook");
    expect(back.idea.status).toBe("inbox");
    const notes = await listNotes(db.pool, { entityType: "idea", entityId: idea.id });
    expect(notes.map((note) => [note.id, note.bodyMd])).toEqual([
      [back.noteId, "needs a better hook"],
    ]);

    expect((await move("dropped")).idea.status).toBe("dropped");
    expect((await move("inbox")).idea.status).toBe("inbox");
  });

  it("are frozen once archived", async () => {
    const idea = await newIdea();
    const archived = await actAs(db, alice, (tx) => archiveIdea(tx, { id: idea.id }));
    expect(archived.archivedAt).not.toBeNull();
    const edit = await failure(
      actAs(db, alice, (tx) =>
        updateIdea(tx, { id: idea.id, expectedVersion: archived.version, fields: { score: 1 } }),
      ),
    );
    expect(edit).toBeInstanceOf(InvalidTransitionError);
  });

  it("record the agent that wrote them in the audit log", async () => {
    const owner = await signIn(db, "owner");
    const agent = await newAgent(db, owner.id, { name: "owner", type: "human" });
    const idea = await actAs(db, agent, (tx) => createIdea(tx, { title: "From an agent" }));
    expect(idea.createdBy).toBe(agent.name);
    const { rows } = await db.pool.query(
      "SELECT actor, actor_type, token_id, action FROM events WHERE entity_id = $1",
      [idea.id],
    );
    expect(rows).toEqual([
      { actor: agent.name, actor_type: "agent", token_id: agent.tokenId, action: "insert" },
    ]);
  });
});
