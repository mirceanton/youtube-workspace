// The idea functions (migration 0031, T12): create_idea, update_idea, archive_idea and advance_idea,
// i.e. the stage machine of PRD 4 and the optimistic concurrency of PRD 4 "Integrity rules".
//
// Everything runs against a real, fully migrated database through the typed wrappers and the
// application roles (ytw_web for a person, ytw_mcp for an agent). Fixtures that the functions
// themselves would refuse (an idea in an arbitrary stage) are set up with the superuser.
import { NOTE_BODY_MAX_BYTES } from "@ytw/shared/api/notes";
import {
  IDEA_STAGE_TRANSITIONS,
  IDEA_STAGES,
  allowedNextStages,
  findIdeaStageTransition,
  type IdeaStage,
} from "@ytw/shared/constants";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, withActor, type Actor } from "../src/client.js";
import {
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
  toDbError,
  type DbError,
} from "../src/errors.js";
import {
  advanceIdea,
  archiveIdea,
  createIdea,
  getIdea,
  updateIdea,
  type CreateIdeaInput,
  type IdeaFields,
} from "../src/ideas.js";
import { addNote, listNotes } from "../src/notes.js";
import { getScriptVersion, saveScriptVersion } from "../src/scripts.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import {
  act,
  alice,
  eventCount,
  eventsFor,
  functionPrivileges,
  ideaInStage,
  newAgent,
  newIdea,
  outcomeKind,
  partition,
  seededRandom,
  setStageDirectly,
  settle,
  tick,
  withoutRowLock,
} from "./content-helpers.js";
import { failure, sqlstate } from "./helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

/** Awaits a promise that must fail with `type` (raw driver errors are mapped first). */
async function rejectedWith<T extends DbError>(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => T,
): Promise<T> {
  const err = toDbError(await failure(promise));
  expect(err).toBeInstanceOf(type);
  return err as T;
}

function edit(actor: Actor, id: string, expectedVersion: number, fields: IdeaFields) {
  return act(db, actor, (tx) => updateIdea(tx, { id, expectedVersion, fields }));
}

/** An idea sitting in `from`, and the move to `to` by a person or an agent. */
async function stageMove(from: IdeaStage, to: IdeaStage) {
  const actor: Actor = IDEA_STAGES.indexOf(from) % 2 === 0 ? alice : newAgent();
  const idea = await ideaInStage(db, from);
  await tick();
  return {
    actor,
    idea,
    move: (note?: string) =>
      act(db, actor, (tx) => advanceIdea(tx, { id: idea.id, newStatus: to, note: note ?? null })),
    /** The idea and its notes are exactly as they were. */
    async untouched() {
      return {
        idea: await getIdea(db.admin, idea.id),
        notes: await listNotes(db.admin, { entityType: "idea", entityId: idea.id }),
      };
    },
  };
}

async function ideaCount(): Promise<number> {
  const { rows } = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM ideas");
  return rows[0]?.n ?? -1;
}

/** How a stage's valid moves are listed in an error message. */
function describeMoves(from: IdeaStage): string {
  return IDEA_STAGE_TRANSITIONS.filter((t) => t.from === from)
    .map((t) => `"${t.to}" (${t.kind === "backward" ? "backward, note required" : t.kind})`)
    .join(", ");
}

// ---------------------------------------------------------------------------------------------

describe("create_idea", () => {
  it("inserts the idea in the inbox at version 1, created by the caller", async () => {
    const idea = await newIdea(db, {
      title: "Why Rust is fast",
      pitch: "A deep dive into zero-cost abstractions",
      source: "viewer comment",
      tags: ["rust", "performance"],
      score: 80,
    });
    expect(idea).toMatchObject({
      title: "Why Rust is fast",
      pitch: "A deep dive into zero-cost abstractions",
      source: "viewer comment",
      tags: ["rust", "performance"],
      score: 80,
      status: "inbox",
      version: 1,
      archivedAt: null,
      createdBy: "alice",
      updatedBy: "alice",
    });
    expect(idea.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(idea.statusChangedAt).toEqual(idea.createdAt);
    expect(await getIdea(db.pool("ytw_readonly"), idea.id)).toEqual(idea);

    expect(await eventsFor(db, idea.id)).toEqual([
      {
        actor: "alice",
        actor_type: "human",
        token_id: null,
        action: "insert",
        entity_type: "idea",
        entity_id: idea.id,
        payload: {
          new: expect.objectContaining({
            title: "Why Rust is fast",
            status: "inbox",
            version: 1,
            tags: ["rust", "performance"],
          }),
        },
      },
    ]);
  });

  it("works for an agent through the MCP role and records its token", async () => {
    const agent = newAgent("research bot");
    const idea = await newIdea(db, { title: "Agent idea" }, agent);
    expect(idea).toMatchObject({ createdBy: "research bot", status: "inbox", version: 1 });
    expect(await eventsFor(db, idea.id)).toEqual([
      expect.objectContaining({
        actor: "research bot",
        actor_type: "agent",
        token_id: agent.tokenId,
        action: "insert",
        entity_type: "idea",
      }),
    ]);
  });

  it("needs only a title", async () => {
    const idea = await act(db, alice, (tx) => createIdea(tx, { title: "Just a title" }));
    expect(idea).toMatchObject({
      pitch: null,
      source: null,
      tags: [],
      score: null,
      status: "inbox",
    });
  });

  const invalid: [string, CreateIdeaInput, string, RegExp][] = [
    ["an empty title", { title: "" }, "title", /title is required/],
    ["a blank title", { title: "   " }, "title", /title is required/],
    ["a title of only line breaks and tabs", { title: "\n\t\r\n" }, "title", /title is required/],
    [
      "a title of 501 characters",
      { title: "x".repeat(501) },
      "title",
      /501 characters.*limit is 500/,
    ],
    [
      "a pitch of 20001 characters",
      { title: "t", pitch: "x".repeat(20_001) },
      "pitch",
      /20001 characters.*limit is 20000/,
    ],
    ["an empty source", { title: "t", source: "" }, "source", /source cannot be empty.*null/],
    ["a blank source", { title: "t", source: " \n " }, "source", /source cannot be empty/],
    [
      "a source of 201 characters",
      { title: "t", source: "x".repeat(201) },
      "source",
      /201 characters.*limit is 200/,
    ],
    ["a score above 100", { title: "t", score: 101 }, "score", /from 0 to 100 \(got 101\)/],
    ["a negative score", { title: "t", score: -1 }, "score", /from 0 to 100 \(got -1\)/],
    ["a fractional score", { title: "t", score: 7.5 }, "score", /from 0 to 100 \(got 7\.5\)/],
    ["a score that is not a number", { title: "t", score: Number.NaN }, "score", /got NaN/],
    ["a score beyond 32 bits", { title: "t", score: 3e10 }, "score", /from 0 to 100/],
    [
      "a duplicated tag",
      { title: "t", tags: ["rust", "rust"] },
      "tags",
      /tags must be distinct: "rust" appears more than once/,
    ],
    [
      "a tag with surrounding spaces",
      { title: "t", tags: [" rust"] },
      "tags",
      /starts or ends with spaces/,
    ],
    ["an empty tag", { title: "t", tags: [""] }, "tags", /tag number 1 is empty/],
    [
      "a tag of 65 characters",
      { title: "t", tags: ["x".repeat(65)] },
      "tags",
      /65 characters, the limit is 64/,
    ],
    ["a tag with a line break", { title: "t", tags: ["a\nb"] }, "tags", /control characters/],
    [
      "51 tags",
      { title: "t", tags: Array.from({ length: 51 }, (_, i) => `tag${i}`) },
      "tags",
      /too many tags: 51, the limit is 50/,
    ],
    ["a NUL character in the title", { title: "a\u0000b" }, "title", /NUL character/],
  ];

  it.each(invalid)(
    "rejects %s with a readable validation error",
    async (_name, input, field, text) => {
      const before = await ideaCount();
      const err = await rejectedWith(
        act(db, alice, (tx) => createIdea(tx, input)),
        ValidationError,
      );
      expect(err.field).toBe(field);
      expect(err.message).toMatch(text);
      expect(err.message.length).toBeLessThan(400);
      expect(await ideaCount()).toBe(before);
    },
  );

  it("accepts every value exactly at its limit", async () => {
    const idea = await newIdea(db, {
      title: "t".repeat(500),
      pitch: "p".repeat(20_000),
      source: "s".repeat(200),
      tags: Array.from({ length: 50 }, (_, i) => `tag-${i}`.padEnd(64, "x")),
      score: 100,
    });
    expect(idea.title).toHaveLength(500);
    expect(idea.pitch).toHaveLength(20_000);
    expect(idea.source).toHaveLength(200);
    expect(idea.tags).toHaveLength(50);
    expect(idea.score).toBe(100);
    expect((await newIdea(db, { score: 0 })).score).toBe(0);
  });

  it("counts characters, not bytes or UTF-16 units", async () => {
    const emoji = "\u{1F3AC}"; // one character, four bytes, two UTF-16 units
    const idea = await newIdea(db, { title: emoji.repeat(500), tags: [emoji.repeat(64)] });
    expect([...idea.title]).toHaveLength(500);
    const err = await rejectedWith(
      act(db, alice, (tx) => createIdea(tx, { title: emoji.repeat(501) })),
      ValidationError,
    );
    expect(err.message).toMatch(/501 characters, the limit is 500/);
  });

  it("stores hostile text literally and still has its tables", async () => {
    const hostile = "Robert'); DROP TABLE ideas;--";
    const idea = await newIdea(db, {
      title: hostile,
      pitch: "$$ \\ ' \" ; -- /* */ $1 %s",
      source: "'; DELETE FROM events;--",
      tags: ["\"'; --", "<script>alert(1)</script>"],
    });
    expect(idea.title).toBe(hostile);
    expect(idea.pitch).toBe("$$ \\ ' \" ; -- /* */ $1 %s");
    expect(idea.tags).toEqual(["\"'; --", "<script>alert(1)</script>"]);
    expect(await getIdea(db.admin, idea.id)).toEqual(idea);
    expect(await ideaCount()).toBeGreaterThan(0);
  });

  it("refuses a call that names no valid actor", async () => {
    const web = db.pool("ytw_web");
    const call = (actor: string, type: string, token: string | null) =>
      web.query(
        sql`SELECT * FROM create_idea(${actor}, ${type}, ${token}::uuid, 'Anonymous idea')`,
      );
    expect((await rejectedWith(call("", "human", null), ValidationError)).field).toBe("actor");
    expect((await rejectedWith(call("alice", "robot", null), ValidationError)).field).toBe(
      "actor_type",
    );
    expect((await rejectedWith(call("alice", "human", randomUUID()), ValidationError)).field).toBe(
      "token_id",
    );
  });

  it("writes the audit row for the actor passed to the function", async () => {
    const tokenId = randomUUID();
    // The transaction says alice, the function call says bob: the call is what counts.
    const idea = await withActor(db.pool("ytw_web"), alice, async (tx) => {
      const { rows } = await tx.query<{ id: string; created_by: string }>(
        sql`SELECT id, created_by FROM create_idea('bob', 'agent', ${tokenId}::uuid, 'Direct call')`,
      );
      return rows[0];
    });
    expect(idea?.created_by).toBe("bob");
    expect(await eventsFor(db, idea?.id ?? "")).toEqual([
      expect.objectContaining({ actor: "bob", actor_type: "agent", token_id: tokenId }),
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("update_idea", () => {
  it("edits the named fields, bumps the version and leaves the rest alone", async () => {
    const idea = await newIdea(db, {
      title: "Old",
      pitch: "Pitch",
      source: "me",
      tags: ["a"],
      score: 5,
    });
    await tick();
    const updated = await edit(alice, idea.id, 1, { title: "New" });
    expect(updated).toMatchObject({
      title: "New",
      pitch: "Pitch",
      source: "me",
      tags: ["a"],
      score: 5,
      status: "inbox",
      version: 2,
      createdBy: "alice",
    });
    expect(updated.statusChangedAt).toEqual(idea.statusChangedAt);
    expect(updated.updatedAt.getTime()).toBeGreaterThan(idea.updatedAt.getTime());

    const events = await eventsFor(db, idea.id);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      actor: "alice",
      actor_type: "human",
      token_id: null,
      action: "update",
      entity_type: "idea",
      payload: { old: { title: "Old", version: 1 }, new: { title: "New", version: 2 } },
    });
  });

  it("sets every editable field at once and replaces the tags", async () => {
    const idea = await newIdea(db, { title: "Old", tags: ["a", "b"] });
    const agent = newAgent("editor bot");
    const updated = await edit(agent, idea.id, 1, {
      title: "Every field",
      pitch: "New pitch",
      source: "an agent",
      tags: ["c"],
      score: 42,
    });
    expect(updated).toMatchObject({
      title: "Every field",
      pitch: "New pitch",
      source: "an agent",
      tags: ["c"],
      score: 42,
      version: 2,
      createdBy: "alice",
      updatedBy: "editor bot",
    });
    const last = (await eventsFor(db, idea.id)).at(-1);
    expect(last).toMatchObject({
      actor: "editor bot",
      actor_type: "agent",
      token_id: agent.tokenId,
    });
  });

  it("clears pitch, source and score with null and all tags with an empty list", async () => {
    const idea = await newIdea(db, { pitch: "p", source: "s", tags: ["x", "y"], score: 9 });
    await tick();
    const cleared = await edit(alice, idea.id, 1, {
      pitch: null,
      source: null,
      score: null,
      tags: [],
    });
    expect(cleared).toMatchObject({ pitch: null, source: null, score: null, tags: [], version: 2 });
  });

  it("keeps the order of the tags it is given", async () => {
    const idea = await newIdea(db, { tags: ["a", "b"] });
    expect((await edit(alice, idea.id, 1, { tags: ["b", "a"] })).tags).toEqual(["b", "a"]);
  });

  it("does not move status_changed_at", async () => {
    const idea = await ideaInStage(db, "scripting");
    const updated = await edit(alice, idea.id, idea.version, { title: "Retitled" });
    expect(updated.statusChangedAt).toEqual(idea.statusChangedAt);
    expect(updated.status).toBe("scripting");
  });

  it("fails on a stale expected_version and reports the latest one", async () => {
    const idea = await newIdea(db, { title: "Contested" });
    await edit(alice, idea.id, 1, { title: "First edit" });
    const err = await rejectedWith(
      edit(alice, idea.id, 1, { title: "Second edit" }),
      VersionConflictError,
    );
    expect(err.latestVersion).toBe(2);
    expect(err.details).toMatchObject({
      entity: "idea",
      id: idea.id,
      expected_version: 1,
      latest_version: 2,
    });
    expect(err.message).toContain("latest version is 2");
    expect(err.message).toContain("expected_version 2");
    expect(err.status).toBe(409);
    const stored = await getIdea(db.admin, idea.id);
    expect(stored).toMatchObject({ title: "First edit", version: 2 });
    expect(await eventCount(db, idea.id)).toBe(2);
  });

  it("fails when the caller is ahead of the stored version too", async () => {
    const idea = await newIdea(db);
    const err = await rejectedWith(
      edit(alice, idea.id, 7, { title: "From the future" }),
      VersionConflictError,
    );
    expect(err.latestVersion).toBe(1);
  });

  it("lets exactly one of several racing edits with the same version win", async () => {
    const idea = await newIdea(db, { title: "Race" });
    const agent = newAgent();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        edit(i % 2 === 0 ? alice : agent, idea.id, 1, { title: `Edit ${i}` }),
      ),
    );
    const { ok, failed } = partition(results);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(7);
    for (const reason of failed) {
      expect(reason).toBeInstanceOf(VersionConflictError);
      expect((reason as VersionConflictError).latestVersion).toBe(2);
    }
    const stored = await getIdea(db.admin, idea.id);
    expect(stored?.version).toBe(2);
    expect(stored?.title).toBe(ok[0]?.title);
  });

  it("does nothing when the values are the stored ones: same version, no audit row", async () => {
    const idea = await newIdea(db, { title: "Same", pitch: "p", tags: ["a", "b"], score: 3 });
    const before = await eventCount(db, idea.id);
    const again = await edit(alice, idea.id, 1, {
      title: "Same",
      pitch: "p",
      tags: ["a", "b"],
      score: 3,
    });
    expect(again).toEqual(idea);
    expect(await eventCount(db, idea.id)).toBe(before);
    // ... and it did not use up the version the caller holds.
    expect((await edit(alice, idea.id, 1, { title: "Different" })).version).toBe(2);
  });

  it("checks the version even when nothing would change", async () => {
    const idea = await newIdea(db, { title: "Quiet" });
    await edit(alice, idea.id, 1, { title: "Loud" });
    const err = await rejectedWith(
      edit(alice, idea.id, 1, { title: "Loud" }),
      VersionConflictError,
    );
    expect(err.latestVersion).toBe(2);
  });

  it("refuses to change the stage and points to advance_idea", async () => {
    const idea = await newIdea(db);
    const err = await rejectedWith(
      act(db, alice, (tx) =>
        tx.query(
          sql`SELECT * FROM update_idea('alice', 'human', NULL, ${idea.id}::uuid, 1, '{"status": "published"}'::jsonb)`,
        ),
      ),
      ValidationError,
    );
    expect(err.field).toBe("status");
    expect(err.message).toContain("advance_idea");
    expect(err.message).toContain('"inbox", "shortlisted"');
    expect((await getIdea(db.admin, idea.id))?.status).toBe("inbox");
  });

  const fieldCases: [string, Record<string, unknown>, string, RegExp][] = [
    [
      "the id",
      { id: randomUUID() },
      "id",
      /field "id" cannot be edited; editable fields: "title", "pitch", "source", "tags", "score"/,
    ],
    ["the version", { version: 99 }, "version", /cannot be edited/],
    ["archived_at", { archived_at: null }, "archived_at", /cannot be edited/],
    ["an unknown field", { colour: "red" }, "colour", /field "colour" cannot be edited/],
    ["a numeric title", { title: 12 }, "title", /title is required.*got a number/],
    ["a null title", { title: null }, "title", /title is required/],
    ["an empty title", { title: "" }, "title", /title is required/],
    ["a title of 501 characters", { title: "x".repeat(501) }, "title", /501 characters/],
    ["a boolean pitch", { pitch: true }, "pitch", /pitch must be text.*got true or false/],
    ["a pitch of 20001 characters", { pitch: "p".repeat(20_001) }, "pitch", /20001 characters/],
    ["a list source", { source: ["a"] }, "source", /source must be text.*got a list/],
    ["a blank source", { source: " " }, "source", /source cannot be empty/],
    ["tags as text", { tags: "rust" }, "tags", /tags must be a list.*got text/],
    ["tags as null", { tags: null }, "tags", /tags must be a list.*got null/],
    [
      "a number among the tags",
      { tags: ["a", 2] },
      "tags",
      /tag number 2 must be text, not a number/,
    ],
    ["a null among the tags", { tags: [null] }, "tags", /tag number 1 must be text, not null/],
    ["nested tags", { tags: [["a"]] }, "tags", /tag number 1 must be text, not a list/],
    ["duplicate tags", { tags: ["a", "a"] }, "tags", /distinct/],
    [
      "a text score",
      { score: "7" },
      "score",
      /score must be a whole number from 0 to 100.*got text/,
    ],
    ["a fractional score", { score: 7.5 }, "score", /from 0 to 100 \(got 7\.5\)/],
    ["a score of 101", { score: 101 }, "score", /got 101/],
    ["a negative score", { score: -5 }, "score", /got -5/],
    ["an astronomically large score", { score: 1e300 }, "score", /from 0 to 100/],
    ["an object as the field value", { pitch: { a: 1 } }, "pitch", /got an object/],
  ];

  it.each(fieldCases)("rejects %s", async (_name, fields, field, text) => {
    const idea = await newIdea(db, { title: "Untouched" });
    const err = await rejectedWith(
      act(db, alice, (tx) =>
        tx.query(
          sql`SELECT * FROM update_idea('alice', 'human', NULL, ${idea.id}::uuid, 1, ${JSON.stringify(fields)}::jsonb)`,
        ),
      ),
      ValidationError,
    );
    expect(err.field).toBe(field);
    expect(err.message).toMatch(text);
    expect(err.message.length).toBeLessThan(500);
    expect(await getIdea(db.admin, idea.id)).toEqual(idea);
  });

  it("rejects a fields argument that is not an object, or is empty", async () => {
    const idea = await newIdea(db);
    const call = (fields: string | null, version: number | null = 1, id: string | null = idea.id) =>
      act(db, alice, (tx) =>
        tx.query(
          sql`SELECT * FROM update_idea('alice', 'human', NULL, ${id}::uuid, ${version}::integer, ${fields}::jsonb)`,
        ),
      );
    for (const fields of [null, "[]", '"title"', "42", "null"]) {
      const err = await rejectedWith(call(fields), ValidationError);
      expect(err.field).toBe("fields");
      expect(err.allowed).toEqual(["title", "pitch", "source", "tags", "score"]);
    }
    expect((await rejectedWith(call("{}"), ValidationError)).message).toMatch(/fields is empty/);
    expect((await rejectedWith(call('{"title":"x"}', null), ValidationError)).field).toBe(
      "expected_version",
    );
    expect((await rejectedWith(call('{"title":"x"}', 0), ValidationError)).field).toBe(
      "expected_version",
    );
    expect((await rejectedWith(call('{"title":"x"}', 1, null), ValidationError)).field).toBe("id");
  });

  it("does not echo a huge or hostile field name back unbounded", async () => {
    const idea = await newIdea(db);
    const name = `"; DROP TABLE ideas; --${"x".repeat(10_000)}`;
    const err = await rejectedWith(
      act(db, alice, (tx) =>
        tx.query(
          sql`SELECT * FROM update_idea('alice', 'human', NULL, ${idea.id}::uuid, 1, ${JSON.stringify({ [name]: 1 })}::jsonb)`,
        ),
      ),
      ValidationError,
    );
    expect(err.message.length).toBeLessThan(300);
    expect(err.message).toContain('\\"; DROP TABLE ideas; --');
    expect(await ideaCount()).toBeGreaterThan(0);
  });

  it("fails for an idea that does not exist", async () => {
    const id = randomUUID();
    const err = await rejectedWith(edit(alice, id, 1, { title: "Ghost" }), NotFoundError);
    expect(err).toMatchObject({ entity: "idea", id });
    expect(err.message).toContain(id);
    expect(err.status).toBe(404);
  });

  it("rejects ids that are not UUIDs before they reach the database", async () => {
    const err = await rejectedWith(edit(alice, "idea-1", 1, { title: "x" }), ValidationError);
    expect(err.field).toBe("id");
    expect(err.message).toContain('"idea-1"');
  });

  it("refuses numbers that JSON cannot carry instead of quietly turning them into null", async () => {
    const idea = await newIdea(db, { score: 50 });
    for (const score of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const err = await rejectedWith(edit(alice, idea.id, 1, { score }), ValidationError);
      expect(err.field).toBe("score");
    }
    const version = await rejectedWith(
      edit(alice, idea.id, 2 ** 31, { title: "x" }),
      ValidationError,
    );
    expect(version.field).toBe("expected_version");
    // Nothing was cleared or changed on the way.
    expect(await getIdea(db.admin, idea.id)).toEqual(idea);
  });

  it("refuses to edit an archived idea", async () => {
    const idea = await newIdea(db);
    await act(db, alice, (tx) => archiveIdea(tx, { id: idea.id }));
    const err = await rejectedWith(
      edit(alice, idea.id, 2, { title: "Zombie" }),
      InvalidTransitionError,
    );
    expect(err.details).toMatchObject({ entity: "idea", id: idea.id, reason: "archived" });
    expect(err.message).toContain("archived");
    expect(err.status).toBe(422);
    expect((await getIdea(db.admin, idea.id))?.title).toBe(idea.title);
  });
});

// ---------------------------------------------------------------------------------------------

describe("archive_idea", () => {
  it("soft-deletes: archived_at set, version bumped, audited, row kept", async () => {
    const idea = await newIdea(db, { title: "To archive" });
    const agent = newAgent("tidy bot");
    const archived = await act(db, agent, (tx) =>
      archiveIdea(tx, { id: idea.id, expectedVersion: 1 }),
    );
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(archived).toMatchObject({
      version: 2,
      status: "inbox",
      title: "To archive",
      updatedBy: "tidy bot",
    });
    expect(await getIdea(db.admin, idea.id)).toEqual(archived);

    const last = (await eventsFor(db, idea.id)).at(-1);
    expect(last).toMatchObject({
      actor: "tidy bot",
      actor_type: "agent",
      token_id: agent.tokenId,
      action: "update",
      entity_type: "idea",
      payload: { old: { archived_at: null, version: 1 }, new: { version: 2 } },
    });
    expect(last?.payload.new?.archived_at).toEqual(expect.any(String));
  });

  it("is idempotent: archiving twice changes nothing the second time", async () => {
    const idea = await newIdea(db);
    const first = await act(db, alice, (tx) => archiveIdea(tx, { id: idea.id }));
    const events = await eventCount(db, idea.id);
    const second = await act(db, alice, (tx) => archiveIdea(tx, { id: idea.id }));
    expect(second).toEqual(first);
    expect(await eventCount(db, idea.id)).toBe(events);
  });

  it("works from every stage", async () => {
    for (const stage of IDEA_STAGES) {
      const idea = await ideaInStage(db, stage);
      const archived = await act(db, alice, (tx) => archiveIdea(tx, { id: idea.id }));
      expect(archived).toMatchObject({ status: stage, version: idea.version + 1 });
      expect(archived.archivedAt).toBeInstanceOf(Date);
    }
  });

  it("honours expected_version when given", async () => {
    const idea = await newIdea(db);
    await act(db, alice, (tx) =>
      updateIdea(tx, { id: idea.id, expectedVersion: 1, fields: { title: "Edited" } }),
    );
    const err = await rejectedWith(
      act(db, alice, (tx) => archiveIdea(tx, { id: idea.id, expectedVersion: 1 })),
      VersionConflictError,
    );
    expect(err.latestVersion).toBe(2);
    expect((await getIdea(db.admin, idea.id))?.archivedAt).toBeNull();
    const archived = await act(db, alice, (tx) =>
      archiveIdea(tx, { id: idea.id, expectedVersion: 2 }),
    );
    expect(archived.version).toBe(3);
  });

  it("reports a stale version even for an idea that is already archived", async () => {
    const idea = await newIdea(db);
    await act(db, alice, (tx) => archiveIdea(tx, { id: idea.id }));
    const err = await rejectedWith(
      act(db, alice, (tx) => archiveIdea(tx, { id: idea.id, expectedVersion: 1 })),
      VersionConflictError,
    );
    expect(err.latestVersion).toBe(2);
  });

  it("fails for an unknown idea and for a malformed id", async () => {
    const id = randomUUID();
    const err = await rejectedWith(
      act(db, alice, (tx) => archiveIdea(tx, { id })),
      NotFoundError,
    );
    expect(err.id).toBe(id);
    expect(
      (
        await rejectedWith(
          act(db, alice, (tx) => archiveIdea(tx, { id: "nope" })),
          ValidationError,
        )
      ).field,
    ).toBe("id");
    const nullId = db
      .pool("ytw_web")
      .query(sql`SELECT * FROM archive_idea('alice', 'human', NULL, NULL::uuid)`);
    expect((await rejectedWith(nullId, ValidationError)).field).toBe("id");
    const zero = act(db, alice, (tx) => archiveIdea(tx, { id, expectedVersion: 0 }));
    expect((await rejectedWith(zero, ValidationError)).field).toBe("expected_version");
  });

  it("freezes the idea: it cannot be moved to another stage either", async () => {
    const idea = await newIdea(db);
    await act(db, alice, (tx) => archiveIdea(tx, { id: idea.id }));
    for (const newStatus of ["shortlisted", "dropped"] as const) {
      const err = await rejectedWith(
        act(db, alice, (tx) => advanceIdea(tx, { id: idea.id, newStatus })),
        InvalidTransitionError,
      );
      expect(err.details).toMatchObject({ reason: "archived", id: idea.id });
    }
    expect((await getIdea(db.admin, idea.id))?.status).toBe("inbox");
  });
});

// ---------------------------------------------------------------------------------------------

describe("advance_idea: the stage machine", () => {
  it("is the same table as IDEA_STAGE_TRANSITIONS, row for row and in the same order", async () => {
    const { rows } = await db.admin.query(
      `SELECT from_stage AS "from", to_stage AS "to", kind, requires_note AS "requiresNote"
         FROM ytw_idea_stage_transitions()`,
    );
    expect(rows).toEqual(
      IDEA_STAGE_TRANSITIONS.map(({ from, to, kind, requiresNote }) => ({
        from,
        to,
        kind,
        requiresNote,
      })),
    );
    const stages = await db.admin.query<{ stages: string[] }>("SELECT ytw_idea_stages() AS stages");
    expect(stages.rows[0]?.stages).toEqual([...IDEA_STAGES]);
    const check = await db.admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'ideas'::regclass AND conname = 'ideas_status_check'`,
    );
    for (const stage of IDEA_STAGES) {
      expect(check.rows[0]?.def).toContain(`'${stage}'`);
    }
  });

  /** Every (from, to) pair of the seven stages, whether the table allows it or not. */
  const pairs = IDEA_STAGES.flatMap((from) => IDEA_STAGES.map((to) => [from, to] as const));
  const forbidden = pairs.filter(([from, to]) => findIdeaStageTransition(from, to) === undefined);
  const needsNote = pairs.filter(
    ([from, to]) => findIdeaStageTransition(from, to)?.requiresNote === true,
  );
  const plain = pairs.filter(
    ([from, to]) => findIdeaStageTransition(from, to)?.requiresNote === false,
  );

  it("splits the seven by seven pairs into the moves the shared table forbids, allows and gates", () => {
    expect(pairs).toHaveLength(IDEA_STAGES.length * IDEA_STAGES.length);
    expect(forbidden.length + needsNote.length + plain.length).toBe(pairs.length);
    expect(needsNote.length + plain.length).toBe(IDEA_STAGE_TRANSITIONS.length);
    expect(needsNote).toHaveLength(
      IDEA_STAGE_TRANSITIONS.filter((t) => t.kind === "backward").length,
    );
  });

  it.each(forbidden)(
    "%s -> %s is refused, with the valid next stages in the message",
    async (from, to) => {
      expect(findIdeaStageTransition(from, to)).toBeUndefined();
      const { idea, move, untouched } = await stageMove(from, to);
      // Whatever the caller adds, a move the table does not list stays refused.
      for (const note of [undefined, "A very good reason"]) {
        const err = await rejectedWith(move(note), InvalidTransitionError);
        expect(err.allowed).toEqual(allowedNextStages(from));
        expect(err.details).toMatchObject({ entity: "idea", id: idea.id, from, to });
        expect(err.message).toBe(
          from === to
            ? `idea ${idea.id} is already in stage "${from}"; valid next stages: ${describeMoves(from)}`
            : `an idea in stage "${from}" cannot move to "${to}"; valid next stages: ${describeMoves(from)}`,
        );
        expect(err.hint).toContain("back one stage with a note");
        expect(err.status).toBe(422);
        expect(await untouched()).toEqual({ idea, notes: [] });
      }
    },
  );

  it.each(needsNote)("%s -> %s needs a note, and links it to the idea", async (from, to) => {
    expect(findIdeaStageTransition(from, to)).toMatchObject({
      kind: "backward",
      requiresNote: true,
    });
    const { actor, idea, move, untouched } = await stageMove(from, to);
    // A missing, empty or blank note fails and nothing is written.
    for (const note of [undefined, "", "   \n\t "]) {
      const err = await rejectedWith(move(note), ValidationError);
      expect(err.field).toBe("note");
      expect(err.details).toMatchObject({ from, to, requires_note: true, kind: "backward" });
      expect(err.message).toBe(
        `moving an idea back from "${from}" to "${to}" requires a note explaining why: pass note`,
      );
      expect(await untouched()).toEqual({ idea, notes: [] });
    }
    const moved = await move("It needs another pass");
    expect(moved.idea).toMatchObject({ status: to, version: idea.version + 1 });
    expect(moved.noteId).toEqual(expect.any(String));
    expect((await untouched()).notes).toEqual([
      expect.objectContaining({
        id: moved.noteId,
        entityType: "idea",
        entityId: idea.id,
        bodyMd: "It needs another pass",
        author: actor.name,
        actorType: actor.type,
      }),
    ]);
  });

  it.each(plain)("%s -> %s is allowed without a note", async (from, to) => {
    expect(findIdeaStageTransition(from, to)?.requiresNote).toBe(false);
    const { idea, move, untouched } = await stageMove(from, to);
    const moved = await move();
    expect(moved.idea).toMatchObject({ status: to, version: idea.version + 1, archivedAt: null });
    expect(moved.idea.statusChangedAt.getTime()).toBeGreaterThan(idea.statusChangedAt.getTime());
    expect(moved.noteId).toBeNull();
    expect(await untouched()).toEqual({ idea: moved.idea, notes: [] });
  });

  it("rejects a stage that does not exist and lists the real ones", async () => {
    const idea = await newIdea(db);
    for (const bad of [
      "archived",
      "Inbox",
      " inbox",
      "",
      "inbox'; DROP TABLE ideas;--",
      "x".repeat(5000),
    ]) {
      const err = await rejectedWith(
        act(db, alice, (tx) => advanceIdea(tx, { id: idea.id, newStatus: bad as IdeaStage })),
        ValidationError,
      );
      expect(err.field).toBe("new_status");
      expect(err.allowed).toEqual([...IDEA_STAGES]);
      expect(err.message).toContain(
        '"inbox", "shortlisted", "scripting", "filming", "editing", "published", "dropped"',
      );
      expect(err.message.length).toBeLessThan(400);
    }
    const nullStage = db
      .pool("ytw_web")
      .query(sql`SELECT * FROM advance_idea('alice', 'human', NULL, ${idea.id}::uuid, NULL)`);
    expect((await rejectedWith(nullStage, ValidationError)).field).toBe("new_status");
    expect((await getIdea(db.admin, idea.id))?.status).toBe("inbox");
  });

  it("walks an idea through the whole pipeline, back, dropped and restored", async () => {
    const idea = await newIdea(db, { title: "Journey" });
    const agent = newAgent("pipeline bot");
    const steps: [IdeaStage, string | undefined][] = [
      ["shortlisted", undefined],
      ["scripting", undefined],
      ["filming", undefined],
      ["editing", "Ready for the edit"],
      ["published", undefined],
      ["editing", "Found a mistake after publishing"],
      ["dropped", "Cancelled"],
      ["inbox", undefined],
      ["shortlisted", undefined],
    ];
    let current = idea;
    let version = 1;
    for (const [stage, note] of steps) {
      await tick();
      const result = await act(db, agent, (tx) =>
        advanceIdea(tx, { id: idea.id, newStatus: stage, note, expectedVersion: version }),
      );
      version += 1;
      expect(result.idea).toMatchObject({ status: stage, version, title: "Journey" });
      expect(result.idea.statusChangedAt.getTime()).toBeGreaterThan(
        current.statusChangedAt.getTime(),
      );
      expect(result.noteId === null).toBe(note === undefined);
      current = result.idea;
    }
    const notes = await listNotes(db.pool("ytw_mcp"), { entityType: "idea", entityId: idea.id });
    expect(notes.map((n) => n.bodyMd)).toEqual([
      "Ready for the edit",
      "Found a mistake after publishing",
      "Cancelled",
    ]);
    expect(new Set(notes.map((n) => n.author))).toEqual(new Set(["pipeline bot"]));
  });

  it("restores a dropped idea to the inbox, with or without a note", async () => {
    for (const note of [undefined, "Changed my mind"]) {
      const dropped = await ideaInStage(db, "dropped");
      const restored = await act(db, alice, (tx) =>
        advanceIdea(tx, { id: dropped.id, newStatus: "inbox", note }),
      );
      expect(restored.idea).toMatchObject({ status: "inbox", version: dropped.version + 1 });
      expect(restored.idea.statusChangedAt.getTime()).toBeGreaterThan(
        dropped.statusChangedAt.getTime(),
      );
      expect(restored.noteId === null).toBe(note === undefined);
    }
  });

  it("only restores a dropped idea to the inbox, not further", async () => {
    const dropped = await ideaInStage(db, "dropped");
    for (const stage of IDEA_STAGES.filter((s) => s !== "inbox")) {
      const err = await rejectedWith(
        act(db, alice, (tx) =>
          advanceIdea(tx, { id: dropped.id, newStatus: stage, note: "please" }),
        ),
        InvalidTransitionError,
      );
      expect(err.allowed).toEqual(["inbox"]);
    }
  });

  it("keeps a note given with a forward move or a drop, as a note on the idea", async () => {
    const idea = await ideaInStage(db, "scripting");
    const forward = await act(db, alice, (tx) =>
      advanceIdea(tx, { id: idea.id, newStatus: "filming", note: "Script approved" }),
    );
    const drop = await act(db, alice, (tx) =>
      advanceIdea(tx, { id: idea.id, newStatus: "dropped", note: "Sponsor pulled out" }),
    );
    const notes = await listNotes(db.admin, { entityType: "idea", entityId: idea.id });
    expect(notes.map((n) => [n.id, n.bodyMd])).toEqual([
      [forward.noteId, "Script approved"],
      [drop.noteId, "Sponsor pulled out"],
    ]);
  });

  it("writes the move and its note as audit rows of the same actor", async () => {
    const idea = await ideaInStage(db, "filming");
    const agent = newAgent("director bot");
    const moved = await act(db, agent, (tx) =>
      advanceIdea(tx, { id: idea.id, newStatus: "scripting", note: "Re-shoot needs a new script" }),
    );
    const ideaEvents = await eventsFor(db, idea.id);
    expect(ideaEvents.at(-1)).toMatchObject({
      actor: "director bot",
      actor_type: "agent",
      token_id: agent.tokenId,
      action: "update",
      entity_type: "idea",
      payload: {
        old: { status: "filming", version: idea.version },
        new: { status: "scripting", version: idea.version + 1 },
      },
    });
    expect(ideaEvents.at(-1)?.payload.new).toHaveProperty("status_changed_at");
    expect(await eventsFor(db, moved.noteId ?? "")).toEqual([
      expect.objectContaining({
        actor: "director bot",
        actor_type: "agent",
        token_id: agent.tokenId,
        action: "insert",
        entity_type: "note",
        payload: {
          new: expect.objectContaining({
            entity_type: "idea",
            entity_id: idea.id,
            body_md: "Re-shoot needs a new script",
            actor_type: "agent",
          }),
        },
      }),
    ]);
  });

  it("writes nothing when the move is refused, even with a note", async () => {
    const idea = await ideaInStage(db, "inbox");
    const events = await eventCount(db, idea.id);
    await rejectedWith(
      act(db, alice, (tx) =>
        advanceIdea(tx, { id: idea.id, newStatus: "published", note: "Skip ahead" }),
      ),
      InvalidTransitionError,
    );
    expect(await getIdea(db.admin, idea.id)).toEqual(idea);
    expect(await eventCount(db, idea.id)).toBe(events);
    expect(await listNotes(db.admin, { entityType: "idea", entityId: idea.id })).toEqual([]);
  });

  it("writes nothing when the note cannot be written: the move and its note are one unit", async () => {
    await db.admin.query(
      `CREATE FUNCTION public.t12_refuse_notes() RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RAISE EXCEPTION 'the notes table is closed'; END $$`,
    );
    await db.admin.query(
      `CREATE TRIGGER t12_refuse_notes BEFORE INSERT ON public.notes
         FOR EACH ROW EXECUTE FUNCTION public.t12_refuse_notes()`,
    );
    try {
      const idea = await ideaInStage(db, "scripting");
      const events = await eventCount(db, idea.id);
      const err = await failure(
        act(db, alice, (tx) =>
          advanceIdea(tx, { id: idea.id, newStatus: "shortlisted", note: "why" }),
        ),
      );
      expect(err.message).toContain("the notes table is closed");
      expect(await getIdea(db.admin, idea.id)).toEqual(idea);
      expect(await eventCount(db, idea.id)).toBe(events);
    } finally {
      await db.admin.query("DROP TRIGGER t12_refuse_notes ON public.notes");
      await db.admin.query("DROP FUNCTION public.t12_refuse_notes()");
    }
  });

  it("rolls the move back with the caller's transaction", async () => {
    const idea = await ideaInStage(db, "scripting");
    const err = await failure(
      act(db, alice, async (tx) => {
        await advanceIdea(tx, { id: idea.id, newStatus: "shortlisted", note: "temporary" });
        throw new Error("the caller changed its mind");
      }),
    );
    expect(err.message).toBe("the caller changed its mind");
    expect(await getIdea(db.admin, idea.id)).toEqual(idea);
    expect(await listNotes(db.admin, { entityType: "idea", entityId: idea.id })).toEqual([]);
  });

  it("bounds the note by NOTE_BODY_MAX_BYTES (UTF-8 bytes) with a readable error", async () => {
    const idea = await ideaInStage(db, "scripting");
    const fits = "é".repeat(NOTE_BODY_MAX_BYTES / 2);
    const tooBig = `${fits}x`;
    const err = await rejectedWith(
      act(db, alice, (tx) =>
        advanceIdea(tx, { id: idea.id, newStatus: "shortlisted", note: tooBig }),
      ),
      ValidationError,
    );
    expect(err.field).toBe("note");
    expect(err.message).toBe(
      `note is too large: ${NOTE_BODY_MAX_BYTES + 1} bytes, the limit is ${NOTE_BODY_MAX_BYTES} (UTF-8)`,
    );
    expect(await getIdea(db.admin, idea.id)).toEqual(idea);
    const moved = await act(db, alice, (tx) =>
      advanceIdea(tx, { id: idea.id, newStatus: "shortlisted", note: fits }),
    );
    expect(moved.idea.status).toBe("shortlisted");
    const [note] = await listNotes(db.admin, { entityType: "idea", entityId: idea.id });
    expect(Buffer.byteLength(note?.bodyMd ?? "")).toBe(NOTE_BODY_MAX_BYTES);
  });

  it("checks expected_version before the move and reports the latest version", async () => {
    const idea = await newIdea(db);
    await act(db, alice, (tx) =>
      updateIdea(tx, { id: idea.id, expectedVersion: 1, fields: { score: 5 } }),
    );
    const err = await rejectedWith(
      act(db, alice, (tx) =>
        advanceIdea(tx, { id: idea.id, newStatus: "shortlisted", expectedVersion: 1 }),
      ),
      VersionConflictError,
    );
    expect(err.latestVersion).toBe(2);
    // A stale version wins over an invalid move: the caller must reload first.
    const stale = await rejectedWith(
      act(db, alice, (tx) =>
        advanceIdea(tx, { id: idea.id, newStatus: "published", expectedVersion: 1 }),
      ),
      VersionConflictError,
    );
    expect(stale.latestVersion).toBe(2);
    expect((await getIdea(db.admin, idea.id))?.status).toBe("inbox");
    const ok = await act(db, alice, (tx) =>
      advanceIdea(tx, { id: idea.id, newStatus: "shortlisted", expectedVersion: 2 }),
    );
    expect(ok.idea).toMatchObject({ status: "shortlisted", version: 3 });
  });

  it("lets exactly one of several racing moves with the same version win", async () => {
    const idea = await newIdea(db);
    const agent = newAgent();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        act(db, i % 2 === 0 ? alice : agent, (tx) =>
          advanceIdea(tx, { id: idea.id, newStatus: "shortlisted", expectedVersion: 1 }),
        ),
      ),
    );
    const { ok, failed } = partition(results);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(5);
    for (const reason of failed) {
      expect(reason).toBeInstanceOf(VersionConflictError);
      expect((reason as VersionConflictError).latestVersion).toBe(2);
    }
    expect(await getIdea(db.admin, idea.id)).toMatchObject({ status: "shortlisted", version: 2 });
  });

  it("serialises racing moves without a version: the loser is told the idea already moved", async () => {
    const idea = await newIdea(db);
    const agent = newAgent();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        act(db, i % 2 === 0 ? alice : agent, (tx) =>
          advanceIdea(tx, { id: idea.id, newStatus: "shortlisted" }),
        ),
      ),
    );
    const { ok, failed } = partition(results);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(5);
    for (const reason of failed) {
      expect(reason).toBeInstanceOf(InvalidTransitionError);
      expect((reason as InvalidTransitionError).message).toContain("already in stage");
    }
    expect((await getIdea(db.admin, idea.id))?.version).toBe(2);
  });

  it("fails for an unknown idea and for a malformed id", async () => {
    const id = randomUUID();
    const err = await rejectedWith(
      act(db, alice, (tx) => advanceIdea(tx, { id, newStatus: "shortlisted" })),
      NotFoundError,
    );
    expect(err).toMatchObject({ entity: "idea", id });
    const bad = await rejectedWith(
      act(db, alice, (tx) => advanceIdea(tx, { id: "1", newStatus: "shortlisted" })),
      ValidationError,
    );
    expect(bad.field).toBe("id");
    const zero = await rejectedWith(
      act(db, alice, (tx) => advanceIdea(tx, { id, newStatus: "shortlisted", expectedVersion: 0 })),
      ValidationError,
    );
    expect(zero.field).toBe("expected_version");
  });

  it("rejects a NUL character in the note before it reaches the database", async () => {
    const idea = await ideaInStage(db, "scripting");
    const err = await rejectedWith(
      act(db, alice, (tx) =>
        advanceIdea(tx, { id: idea.id, newStatus: "shortlisted", note: "a\u0000b" }),
      ),
      ValidationError,
    );
    expect(err.field).toBe("note");
  });
});

// ---------------------------------------------------------------------------------------------

describe("optimistic concurrency without the row lock", () => {
  // The write functions lock the idea row, then check the version they read. The UPDATE names that
  // version too, so the guarantee does not rest on the lock alone: these tests take the lock away
  // (superuser copies of the functions) and expect the same outcome.
  const names = ["update_idea", "advance_idea", "archive_idea"];

  it("update_idea: exactly one of several racing edits wins", async () => {
    const idea = await newIdea(db, { title: "Unlocked race" });
    const results = await withoutRowLock(db, names, () =>
      Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          edit(i % 2 === 0 ? alice : newAgent(), idea.id, 1, { title: `Edit ${i}` }),
        ),
      ),
    );
    const { ok, failed } = partition(results);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(7);
    for (const reason of failed) {
      expect(reason).toBeInstanceOf(VersionConflictError);
      expect((reason as VersionConflictError).latestVersion).toBe(2);
    }
    expect(await getIdea(db.admin, idea.id)).toMatchObject({ version: 2, title: ok[0]?.title });
  });

  it("advance_idea with a version: exactly one of several racing moves wins", async () => {
    const idea = await newIdea(db);
    const results = await withoutRowLock(db, names, () =>
      Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          act(db, i % 2 === 0 ? alice : newAgent(), (tx) =>
            advanceIdea(tx, { id: idea.id, newStatus: "shortlisted", expectedVersion: 1 }),
          ),
        ),
      ),
    );
    const { ok, failed } = partition(results);
    expect(ok).toHaveLength(1);
    for (const reason of failed) {
      expect(reason).toBeInstanceOf(VersionConflictError);
      expect((reason as VersionConflictError).latestVersion).toBe(2);
    }
    expect(await getIdea(db.admin, idea.id)).toMatchObject({ status: "shortlisted", version: 2 });
  });

  it("advance_idea without a version: the stage is moved once, the others are told", async () => {
    const idea = await newIdea(db);
    const results = await withoutRowLock(db, names, () =>
      Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          act(db, i % 2 === 0 ? alice : newAgent(), (tx) =>
            advanceIdea(tx, { id: idea.id, newStatus: "shortlisted", note: `move ${i}` }),
          ),
        ),
      ),
    );
    const { ok, failed } = partition(results);
    expect(ok).toHaveLength(1);
    for (const reason of failed) {
      // A late caller sees the new stage (invalid move); an early one finds the idea changed.
      expect(
        [VersionConflictError, InvalidTransitionError].some((type) => reason instanceof type),
      ).toBe(true);
    }
    expect(await getIdea(db.admin, idea.id)).toMatchObject({ status: "shortlisted", version: 2 });
    // Only the winner's note was written.
    expect(await listNotes(db.admin, { entityType: "idea", entityId: idea.id })).toHaveLength(1);
  });

  it("archive_idea: exactly one of several racing archivals wins", async () => {
    const idea = await newIdea(db);
    const results = await withoutRowLock(db, names, () =>
      Promise.allSettled(
        Array.from({ length: 6 }, () =>
          act(db, alice, (tx) => archiveIdea(tx, { id: idea.id, expectedVersion: 1 })),
        ),
      ),
    );
    const { ok, failed } = partition(results);
    expect(ok).toHaveLength(1);
    for (const reason of failed) {
      expect(reason).toBeInstanceOf(VersionConflictError);
      expect((reason as VersionConflictError).latestVersion).toBe(2);
    }
    expect(await getIdea(db.admin, idea.id)).toMatchObject({ version: 2 });
  });

  it("puts the original functions back", async () => {
    const { rows } = await db.admin.query<{ locks: boolean }>(
      `SELECT pg_get_functiondef(p.oid) LIKE '%FOR NO KEY UPDATE%' AS locks FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY ($1)`,
      [["update_idea", "advance_idea", "archive_idea", "save_script_version"]],
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.locks)).toBe(true);
    expect((await db.admin.query("SELECT * FROM ytw_catalog_violations()")).rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("model-based checks", () => {
  /** Replayable: a failing seed can be run again on its own. */
  it.each([1, 2, 3, 4])(
    "a random walk through the stages agrees with IDEA_STAGE_TRANSITIONS at every step (seed %i)",
    async (seed) => {
      const random = seededRandom(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
      const people = [alice, newAgent("walker")];
      const idea = await newIdea(db, { title: `Walk ${seed}` });
      let status: IdeaStage = "inbox";
      let version = 1;
      let moves = 0;
      let notes = 0;

      for (let step = 0; step < 120; step += 1) {
        const to = pick(IDEA_STAGES);
        const note = random() < 0.4 ? `reason ${step}` : undefined;
        const stale = version > 1 && random() < 0.1;
        const expectedVersion = stale ? version - 1 : random() < 0.5 ? version : undefined;
        const rule = findIdeaStageTransition(status, to);
        // The order the function checks in: version, then the stage rule, then the note.
        const expected = stale
          ? "version_conflict"
          : rule === undefined
            ? "invalid_transition"
            : rule.requiresNote && note === undefined
              ? "validation"
              : "ok";

        const outcome = await settle(
          act(db, pick(people), (tx) =>
            advanceIdea(tx, { id: idea.id, newStatus: to, note, expectedVersion }),
          ),
        );
        expect(outcomeKind(outcome)).toBe(expected);
        expect(
          outcome.ok || !(outcome.error instanceof VersionConflictError)
            ? version
            : outcome.error.latestVersion,
        ).toBe(version);
        if (outcome.ok) {
          status = to;
          version += 1;
          moves += 1;
          notes += note === undefined ? 0 : 1;
        }
        expect(await getIdea(db.admin, idea.id)).toMatchObject({ status, version });
      }

      expect(moves).toBeGreaterThan(10);
      const { rows } = await db.admin.query<{
        from: string | null;
        to: string | null;
        version: number;
      }>(
        `SELECT payload->'old'->>'status' AS "from", payload->'new'->>'status' AS "to",
                (payload->'new'->>'version')::int AS version
           FROM events WHERE entity_id = $1 AND action = 'update' ORDER BY 3`,
        [idea.id],
      );
      // One audit row per move, a gap-free chain of versions, and every logged move is in the table.
      expect(rows.map((row) => row.version)).toEqual(
        Array.from({ length: moves }, (_, i) => i + 2),
      );
      expect(
        rows.every(
          (row) =>
            findIdeaStageTransition(row.from as IdeaStage, row.to as IdeaStage) !== undefined,
        ),
      ).toBe(true);
      expect(await listNotes(db.admin, { entityType: "idea", entityId: idea.id })).toHaveLength(
        notes,
      );
    },
  );

  it("survives a storm of mixed concurrent writers without a gap, a duplicate or an illegal move", async () => {
    const random = seededRandom(2026);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const people = [alice, newAgent("storm a"), newAgent("storm b")];
    const idea = await newIdea(db, { title: "Storm" });
    const tally = { updates: 0, moves: 0, moveNotes: 0, notes: 0, script: 0, packaging: 0 };
    const failures: string[] = [];

    for (let round = 0; round < 10; round += 1) {
      // Everyone reads the same state, so the writers of a round collide with each other.
      const seen = (await getIdea(db.admin, idea.id)) as NonNullable<
        Awaited<ReturnType<typeof getIdea>>
      >;
      const latest = {
        script:
          (await getScriptVersion(db.admin, { ideaId: idea.id, kind: "script" }))?.version ?? 0,
        packaging:
          (await getScriptVersion(db.admin, { ideaId: idea.id, kind: "packaging" }))?.version ?? 0,
      };
      const calls = Array.from({ length: 12 }, (_, i) => {
        const actor = people[i % people.length] as Actor;
        const type = pick(["update", "advance", "advance", "save", "save", "note"] as const);
        const kind = pick(["script", "packaging"] as const);
        const note = random() < 0.5 ? `storm note ${round}.${i}` : undefined;
        const to = pick(IDEA_STAGES);
        const run: () => Promise<unknown> = {
          update: () =>
            act(db, actor, (tx) =>
              updateIdea(tx, {
                id: idea.id,
                expectedVersion: seen.version,
                fields: { title: `Storm ${round}.${i}` },
              }),
            ),
          advance: () =>
            act(db, actor, (tx) =>
              advanceIdea(tx, {
                id: idea.id,
                newStatus: to,
                note,
                expectedVersion: random() < 0.5 ? seen.version : undefined,
              }),
            ),
          save: () =>
            act(db, actor, (tx) =>
              saveScriptVersion(tx, {
                ideaId: idea.id,
                kind,
                baseVersion: latest[kind],
                bodyMd: `storm ${round}.${i}`,
              }),
            ),
          note: () =>
            act(db, actor, (tx) =>
              addNote(tx, {
                entityType: "idea",
                entityId: idea.id,
                bodyMd: `chatter ${round}.${i}`,
              }),
            ),
        }[type];
        return { type, kind, note, run };
      });

      const outcomes = await Promise.all(
        calls.map(async (call) => ({ call, outcome: await settle(call.run()) })),
      );
      for (const { call, outcome } of outcomes) {
        if (outcome.ok) {
          tally.updates += call.type === "update" ? 1 : 0;
          tally.moves += call.type === "advance" ? 1 : 0;
          tally.moveNotes += call.type === "advance" && call.note !== undefined ? 1 : 0;
          tally.notes += call.type === "note" ? 1 : 0;
          tally.script += call.type === "save" && call.kind === "script" ? 1 : 0;
          tally.packaging += call.type === "save" && call.kind === "packaging" ? 1 : 0;
        } else {
          failures.push(outcomeKind(outcome));
        }
      }
    }

    // Losers fail with the errors the contract names: never a deadlock, a unique violation or a raw error.
    expect(new Set(failures).size).toBeGreaterThan(0);
    expect(
      failures.filter(
        (kind) => !["version_conflict", "invalid_transition", "validation"].includes(kind),
      ),
    ).toEqual([]);

    // The idea: one version per successful change, and the audit trail is the same chain.
    const version = 1 + tally.updates + tally.moves;
    expect(await getIdea(db.admin, idea.id)).toMatchObject({ version, archivedAt: null });
    const { rows } = await db.admin.query<{
      old: number;
      new: number;
      from: string | null;
      to: string | null;
    }>(
      `SELECT (payload->'old'->>'version')::int AS old, (payload->'new'->>'version')::int AS new,
              payload->'old'->>'status' AS "from", payload->'new'->>'status' AS "to"
         FROM events WHERE entity_id = $1 AND action = 'update' ORDER BY 2`,
      [idea.id],
    );
    expect(rows.map((row) => row.new)).toEqual(
      Array.from({ length: version - 1 }, (_, i) => i + 2),
    );
    expect(rows.every((row) => row.old === row.new - 1)).toBe(true);
    expect(
      rows.every(
        (row) =>
          row.from === null ||
          findIdeaStageTransition(row.from as IdeaStage, row.to as IdeaStage) !== undefined,
      ),
    ).toBe(true);
    expect(await listNotes(db.admin, { entityType: "idea", entityId: idea.id })).toHaveLength(
      tally.moveNotes + tally.notes,
    );

    // The scripts: every version line is 1..n, exactly as many as were saved.
    for (const kind of ["script", "packaging"] as const) {
      const lines = await db.admin.query<{ version: number }>(
        "SELECT version FROM scripts WHERE idea_id = $1 AND kind = $2 ORDER BY version",
        [idea.id, kind],
      );
      expect(lines.rows.map((row) => row.version)).toEqual(
        Array.from({ length: tally[kind] }, (_, i) => i + 1),
      );
    }
    expect(tally.updates + tally.moves + tally.script + tally.packaging).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------------------------

describe("privileges and isolation", () => {
  const WRITERS = ["create_idea", "update_idea", "archive_idea", "advance_idea"];
  const INTERNAL = [
    "ytw_idea_stages",
    "ytw_idea_stage_transitions",
    "ytw_check_idea_field",
    "ytw_fmt_value",
    "ytw_fmt_list",
    "ytw_raise_not_found",
    "ytw_raise_version_conflict",
    "ytw_raise_idea_archived",
  ];

  it.each(WRITERS)(
    "%s is SECURITY DEFINER, pins its search path and is executable by exactly ytw_web and ytw_mcp",
    async (name) => {
      const found = Object.values(await functionPrivileges(db, name));
      expect(found).toHaveLength(1);
      expect(found[0]).toEqual({
        roles: ["ytw_mcp", "ytw_web"],
        publicExecute: false,
        definer: true,
        searchPath: "search_path=pg_catalog, public, pg_temp",
      });
    },
  );

  it.each(INTERNAL)("the helper %s is not executable by any application role", async (name) => {
    for (const privileges of Object.values(await functionPrivileges(db, name))) {
      expect(privileges.roles).toEqual([]);
      expect(privileges.publicExecute).toBe(false);
      expect(privileges.searchPath).toBe("search_path=pg_catalog, public, pg_temp");
    }
  });

  it("keeps the catalog guard clean: no DML for any application role, no open EXECUTE", async () => {
    const { rows } = await db.admin.query("SELECT * FROM ytw_catalog_violations()");
    expect(rows).toEqual([]);
  });

  it("denies direct writes to ideas to every application role", async () => {
    const idea = await newIdea(db);
    for (const role of ["ytw_web", "ytw_mcp", "ytw_readonly"] as const) {
      const pool = db.pool(role);
      expect(await sqlstate(pool.query("INSERT INTO ideas (title) VALUES ('sneaky')"))).toMatch(
        /^(42501|25006)$/,
      );
      expect(await sqlstate(pool.query("UPDATE ideas SET status = 'published'"))).toMatch(
        /^(42501|25006)$/,
      );
      expect(await sqlstate(pool.query("DELETE FROM ideas"))).toMatch(/^(42501|25006)$/);
      expect(await sqlstate(pool.query("TRUNCATE ideas"))).toMatch(/^(42501|25006)$/);
    }
    expect(await getIdea(db.admin, idea.id)).toEqual(idea);
  });

  it("denies the write functions and the helpers to ytw_readonly and the helpers to the writers", async () => {
    const readonly = db.pool("ytw_readonly");
    expect(
      await sqlstate(readonly.query("SELECT * FROM create_idea('x', 'human', NULL, 'Nope')")),
    ).toBe("42501");
    expect(
      await sqlstate(
        readonly.query(
          `SELECT * FROM advance_idea('x', 'human', NULL, '${randomUUID()}', 'dropped')`,
        ),
      ),
    ).toBe("42501");
    for (const role of ["ytw_web", "ytw_mcp"] as const) {
      expect(
        await sqlstate(db.pool(role).query(`SELECT ytw_check_idea_field('title', '"x"'::jsonb)`)),
      ).toBe("42501");
      expect(await sqlstate(db.pool(role).query(`SELECT ytw_idea_stage_transitions()`))).toBe(
        "42501",
      );
    }
  });

  it("is not fooled by temporary tables that shadow the real ones", async () => {
    const client = await db.admin.connect();
    try {
      await client.query("CREATE TEMP TABLE ideas (id uuid, title text)");
      await client.query("CREATE TEMP TABLE events (id uuid)");
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM create_idea('mallory', 'human', NULL, 'Hijack?')",
      );
      const id = rows[0]?.id ?? "";
      const temp = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_temp.ideas",
      );
      expect(temp.rows[0]?.n).toBe(0);
      expect(await getIdea(db.admin, id)).toMatchObject({ title: "Hijack?", createdBy: "mallory" });
      expect(await eventsFor(db, id)).toHaveLength(1);
    } finally {
      client.release(true);
    }
  });

  it("works for both application roles, and reads need only SELECT", async () => {
    const asWeb = await newIdea(db, { title: "From the web" });
    const asMcp = await newIdea(db, { title: "From MCP" }, newAgent());
    expect(asWeb).toMatchObject({ status: "inbox", createdBy: "alice" });
    expect(asMcp.status).toBe("inbox");
    expect(await getIdea(db.pool("ytw_readonly"), asMcp.id)).toEqual(asMcp);
    expect(await setStageDirectly(db, asWeb.id, "dropped")).toMatchObject({ status: "dropped" });
  });
});
