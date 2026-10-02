// The note function (migration 0033, T12): add_note, i.e. the comments of PRD 4 "notes" on ideas,
// script revisions, videos and experiments. The target checks belong to the notes trigger of T11
// (add_note relies on it); this file proves that they surface as typed, readable errors and that
// the body rules, the audit trail and the privileges hold.
import { NOTE_BODY_MAX_BYTES } from "@ytw/shared/api/notes";
import { NOTE_ENTITY_TYPES, type NoteEntityType } from "@ytw/shared/constants";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, withActor, type Actor } from "../src/client.js";
import {
  DbError,
  ImmutableError,
  NotFoundError,
  ValidationError,
  toDbError,
} from "../src/errors.js";
import { archiveIdea } from "../src/ideas.js";
import { addNote, listNotes, type NoteRecord } from "../src/notes.js";
import { saveScriptVersion } from "../src/scripts.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import {
  act,
  alice,
  eventsFor,
  functionPrivileges,
  insertExperiment,
  insertVideo,
  newAgent,
  newIdea,
  partition,
  tick,
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

/** One way to make an entity of each kind a note can be attached to. */
const makeEntity: Record<NoteEntityType, () => Promise<string>> = {
  idea: async () => (await newIdea(db)).id,
  script: async () => {
    const idea = await newIdea(db);
    const script = await act(db, alice, (tx) =>
      saveScriptVersion(tx, {
        ideaId: idea.id,
        kind: "script",
        baseVersion: 0,
        bodyMd: "A script",
      }),
    );
    return script.id;
  },
  video: () => insertVideo(db),
  experiment: () => insertExperiment(db),
};

function note(
  actor: Actor,
  entityType: NoteEntityType,
  entityId: string,
  bodyMd: string,
): Promise<NoteRecord> {
  return act(db, actor, (tx) => addNote(tx, { entityType, entityId, bodyMd }));
}

async function noteCount(): Promise<number> {
  const { rows } = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM notes");
  return rows[0]?.n ?? -1;
}

// ---------------------------------------------------------------------------------------------

describe("add_note", () => {
  it.each(NOTE_ENTITY_TYPES)(
    "comments on a %s, as a person and as an agent",
    async (entityType) => {
      const entityId = await makeEntity[entityType]();
      const human = await note(alice, entityType, entityId, "Looks good to me");
      expect(human).toEqual({
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        entityType,
        entityId,
        author: "alice",
        actorType: "human",
        bodyMd: "Looks good to me",
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
      expect(human.updatedAt).toEqual(human.createdAt);

      await tick();
      const agent = newAgent("review bot");
      const robot = await note(agent, entityType, entityId, "Please tighten the intro");
      expect(robot).toMatchObject({
        author: "review bot",
        actorType: "agent",
        entityType,
        entityId,
      });
      expect(robot.createdAt.getTime()).toBeGreaterThan(human.createdAt.getTime());

      expect(await listNotes(db.pool("ytw_readonly"), { entityType, entityId })).toEqual([
        human,
        robot,
      ]);

      expect(await eventsFor(db, robot.id)).toEqual([
        {
          actor: "review bot",
          actor_type: "agent",
          token_id: agent.tokenId,
          action: "insert",
          entity_type: "note",
          entity_id: robot.id,
          payload: {
            new: expect.objectContaining({
              entity_type: entityType,
              entity_id: entityId,
              body_md: "Please tighten the intro",
              actor_type: "agent",
              created_by: "review bot",
            }),
          },
        },
      ]);
      expect(await eventsFor(db, human.id)).toEqual([
        expect.objectContaining({
          actor: "alice",
          actor_type: "human",
          token_id: null,
          action: "insert",
        }),
      ]);
    },
  );

  it("attaches a script note to the revision, not to the idea", async () => {
    const idea = await newIdea(db);
    const first = await act(db, alice, (tx) =>
      saveScriptVersion(tx, { ideaId: idea.id, kind: "script", baseVersion: 0, bodyMd: "v1" }),
    );
    const second = await act(db, alice, (tx) =>
      saveScriptVersion(tx, { ideaId: idea.id, kind: "script", baseVersion: 1, bodyMd: "v2" }),
    );
    await note(alice, "script", second.id, "About version 2");
    await note(alice, "idea", idea.id, "About the idea");
    expect(
      (await listNotes(db.admin, { entityType: "script", entityId: second.id })).map(
        (n) => n.bodyMd,
      ),
    ).toEqual(["About version 2"]);
    expect(await listNotes(db.admin, { entityType: "script", entityId: first.id })).toEqual([]);
    expect(
      (await listNotes(db.admin, { entityType: "idea", entityId: idea.id })).map((n) => n.bodyMd),
    ).toEqual(["About the idea"]);
  });

  it("lists the notes of an entity oldest first and keeps other entities out", async () => {
    const one = await newIdea(db);
    const two = await newIdea(db);
    const bodies = ["first", "second", "third", "fourth"];
    for (const body of bodies) {
      await tick();
      await note(alice, "idea", one.id, body);
    }
    await note(alice, "idea", two.id, "elsewhere");
    expect(
      (await listNotes(db.admin, { entityType: "idea", entityId: one.id })).map((n) => n.bodyMd),
    ).toEqual(bodies);
    expect(await listNotes(db.admin, { entityType: "video", entityId: one.id })).toEqual([]);
  });

  it("stores the markdown exactly as written, hostile or not", async () => {
    const entityId = await makeEntity.idea();
    const bodies = [
      "  leading and trailing spaces  \n",
      "line one\r\nline two\r\n",
      "# Heading\n\n- [ ] task\n\n> quote\n\n`code`",
      "<script>alert(1)</script> <img src=x onerror=alert(2)> [x](javascript:alert(3))",
      "emoji \u{1F3AC} accents é kanji 日本語",
      "$$ ' \" ; -- /* */ \\ $1 %s '); DROP TABLE notes;--",
      "﻿starts with a byte order mark",
    ];
    for (const body of bodies) {
      const saved = await note(alice, "idea", entityId, body);
      expect(saved.bodyMd).toBe(body);
    }
    expect(
      (await listNotes(db.admin, { entityType: "idea", entityId })).map((n) => n.bodyMd),
    ).toEqual(bodies);
  });

  it("is still possible on an archived idea: only edits, moves and new scripts are frozen", async () => {
    const idea = await newIdea(db);
    await act(db, alice, (tx) => archiveIdea(tx, { id: idea.id }));
    expect((await note(alice, "idea", idea.id, "Why it was archived")).bodyMd).toBe(
      "Why it was archived",
    );
  });

  describe("the body", () => {
    it.each([
      ["empty", ""],
      ["a space", " "],
      ["only line breaks", "\n\n"],
      ["only whitespace", "\t \r\n \t"],
    ])("rejects a body that is %s", async (_label, body) => {
      const entityId = await makeEntity.idea();
      const before = await noteCount();
      const err = await rejectedWith(note(alice, "idea", entityId, body), ValidationError);
      expect(err.field).toBe("body_md");
      expect(err.message).toBe("body_md is required: a note cannot be empty or only whitespace");
      expect(await noteCount()).toBe(before);
    });

    it("accepts a body of exactly NOTE_BODY_MAX_BYTES bytes of UTF-8 and refuses one byte more", async () => {
      const entityId = await makeEntity.idea();
      const exactly = "a".repeat(NOTE_BODY_MAX_BYTES);
      expect((await note(alice, "idea", entityId, exactly)).bodyMd).toHaveLength(
        NOTE_BODY_MAX_BYTES,
      );
      const before = await noteCount();
      const err = await rejectedWith(note(alice, "idea", entityId, `${exactly}a`), ValidationError);
      expect(err.field).toBe("body_md");
      expect(err.details).toMatchObject({
        bytes: NOTE_BODY_MAX_BYTES + 1,
        max_bytes: NOTE_BODY_MAX_BYTES,
      });
      expect(err.message).toBe(
        `body_md is too large: ${NOTE_BODY_MAX_BYTES + 1} bytes, the limit is ${NOTE_BODY_MAX_BYTES} (UTF-8)`,
      );
      expect(await noteCount()).toBe(before);
    });

    it.each([
      ["two-byte", "é", 2],
      ["three-byte", "日", 3],
      ["four-byte", "\u{1F3AC}", 4],
    ])("counts bytes, not characters (%s characters)", async (_label, char, bytes) => {
      const entityId = await makeEntity.idea();
      const fits = char.repeat(Math.floor(NOTE_BODY_MAX_BYTES / bytes));
      const fitsBytes = Buffer.byteLength(fits);
      expect(fitsBytes).toBeLessThanOrEqual(NOTE_BODY_MAX_BYTES);
      expect((await note(alice, "idea", entityId, fits)).bodyMd).toBe(fits);
      const err = await rejectedWith(
        note(alice, "idea", entityId, `${fits}${char}`),
        ValidationError,
      );
      expect(err.details).toMatchObject({
        bytes: fitsBytes + bytes,
        max_bytes: NOTE_BODY_MAX_BYTES,
      });
    });

    it("never echoes the body in the error", async () => {
      const entityId = await makeEntity.idea();
      const err = await rejectedWith(
        note(alice, "idea", entityId, `SECRET-MARKER ${"z".repeat(NOTE_BODY_MAX_BYTES)}`),
        ValidationError,
      );
      expect(JSON.stringify(err.toJSON())).not.toContain("SECRET-MARKER");
    });

    it("rejects a NUL character before it reaches the database", async () => {
      const entityId = await makeEntity.idea();
      const err = await rejectedWith(note(alice, "idea", entityId, "a\u0000b"), ValidationError);
      expect(err.field).toBe("body_md");
    });
  });

  describe("the target", () => {
    it.each(NOTE_ENTITY_TYPES)("fails for a %s that does not exist", async (entityType) => {
      const entityId = randomUUID();
      const before = await noteCount();
      const err = await rejectedWith(note(alice, entityType, entityId, "Hello?"), NotFoundError);
      expect(err).toMatchObject({ entity: entityType, id: entityId });
      expect(err.message).toBe(
        `${entityType} ${entityId} does not exist: a note must be attached to an existing ${entityType}`,
      );
      expect(err.status).toBe(404);
      expect(await noteCount()).toBe(before);
    });

    it("does not take the id of one kind of entity for another", async () => {
      const idea = await newIdea(db);
      for (const entityType of NOTE_ENTITY_TYPES.filter((type) => type !== "idea")) {
        const err = await rejectedWith(
          note(alice, entityType, idea.id, "wrong kind"),
          NotFoundError,
        );
        expect(err.entity).toBe(entityType);
      }
    });

    const badTypes: [string, string][] = [
      ["a capitalised name", "Idea"],
      ["the plural", "ideas"],
      ["a table that exists", "users"],
      ["an empty string", ""],
      ["a padded name", " idea"],
      ["SQL injection", "idea'; DROP TABLE notes;--"],
      ["5000 characters", "x".repeat(5000)],
    ];

    it.each(badTypes)(
      "rejects an entity type that is %s and lists the valid ones",
      async (_label, entityType) => {
        const entityId = await makeEntity.idea();
        const err = await rejectedWith(
          note(alice, entityType as NoteEntityType, entityId, "typo"),
          ValidationError,
        );
        expect(err.field).toBe("entity_type");
        expect(err.allowed).toEqual([...NOTE_ENTITY_TYPES]);
        expect(err.message).toContain('valid values: "idea", "script", "video", "experiment"');
        expect(err.message.length).toBeLessThan(400);
      },
    );

    it("rejects a missing target or body, and a malformed id", async () => {
      const entityId = await makeEntity.idea();
      const call = (type: string | null, id: string | null, body: string | null) =>
        db
          .pool("ytw_mcp")
          .query(sql`SELECT * FROM add_note('bot', 'agent', NULL, ${type}, ${id}::uuid, ${body})`);
      expect((await rejectedWith(call("idea", null, "x"), ValidationError)).field).toBe(
        "entity_id",
      );
      expect((await rejectedWith(call(null, entityId, "x"), ValidationError)).field).toBe(
        "entity_type",
      );
      expect((await rejectedWith(call("idea", entityId, null), ValidationError)).field).toBe(
        "body_md",
      );
      const malformed = await rejectedWith(note(alice, "idea", "not-a-uuid", "x"), ValidationError);
      expect(malformed.field).toBe("entity_id");
    });
  });

  describe("append-only", () => {
    it("cannot be edited, deleted or truncated: the trigger refuses even the superuser", async () => {
      const entityId = await makeEntity.idea();
      const saved = await note(alice, "idea", entityId, "Final word");
      for (const statement of [
        "UPDATE notes SET body_md = 'edited' WHERE id = $1",
        "DELETE FROM notes WHERE id = $1",
      ]) {
        const err = await rejectedWith(
          withActor(db.admin, alice, (tx) => tx.query(statement, [saved.id])),
          ImmutableError,
        );
        expect(err.message).toContain("notes is append-only");
        expect(err.status).toBe(422);
      }
      await rejectedWith(
        withActor(db.admin, alice, (tx) => tx.query("TRUNCATE notes")),
        ImmutableError,
      );
      expect((await listNotes(db.admin, { entityType: "idea", entityId }))[0]?.bodyMd).toBe(
        "Final word",
      );
    });
  });

  describe("racing writers", () => {
    it("all succeed: notes never conflict, each is its own row", async () => {
      const entityId = await makeEntity.idea();
      const agent = newAgent("chatty bot");
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          note(i % 2 === 0 ? alice : agent, "idea", entityId, `message ${i}`),
        ),
      );
      const { ok, failed } = partition(results);
      expect(failed).toEqual([]);
      expect(new Set(ok.map((n) => n.id)).size).toBe(8);
      const stored = await listNotes(db.admin, { entityType: "idea", entityId });
      expect(stored.map((n) => n.bodyMd).toSorted()).toEqual(
        Array.from({ length: 8 }, (_, i) => `message ${i}`),
      );
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("privileges and isolation", () => {
  it("add_note is SECURITY DEFINER, pins its search path and is executable by exactly ytw_web and ytw_mcp", async () => {
    const found = Object.values(await functionPrivileges(db, "add_note"));
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      roles: ["ytw_mcp", "ytw_web"],
      publicExecute: false,
      definer: true,
      searchPath: "search_path=pg_catalog, public, pg_temp",
    });
  });

  it("keeps the internal note writer out of reach of every application role", async () => {
    for (const privileges of Object.values(await functionPrivileges(db, "ytw_insert_note"))) {
      expect(privileges).toMatchObject({ roles: [], publicExecute: false });
    }
    const entityId = await makeEntity.idea();
    for (const role of ["ytw_web", "ytw_mcp", "ytw_readonly"] as const) {
      expect(
        await sqlstate(
          db.pool(role).query(`SELECT * FROM ytw_insert_note('idea', '${entityId}', 'sneaky')`),
        ),
      ).toBe("42501");
    }
  });

  it("keeps the catalog guard clean", async () => {
    const { rows } = await db.admin.query("SELECT * FROM ytw_catalog_violations()");
    expect(rows).toEqual([]);
  });

  it("denies direct writes to notes to every application role, and add_note to ytw_readonly", async () => {
    const entityId = await makeEntity.idea();
    for (const role of ["ytw_web", "ytw_mcp", "ytw_readonly"] as const) {
      const pool = db.pool(role);
      expect(
        await sqlstate(
          pool.query(
            "INSERT INTO notes (entity_type, entity_id, body_md) VALUES ('idea', $1, 'x')",
            [entityId],
          ),
        ),
      ).toMatch(/^(42501|25006)$/);
      expect(await sqlstate(pool.query("UPDATE notes SET body_md = 'x'"))).toMatch(
        /^(42501|25006)$/,
      );
      expect(await sqlstate(pool.query("DELETE FROM notes"))).toMatch(/^(42501|25006)$/);
      expect(await sqlstate(pool.query("TRUNCATE notes"))).toMatch(/^(42501|25006)$/);
    }
    expect(
      await sqlstate(
        db
          .pool("ytw_readonly")
          .query(`SELECT * FROM add_note('x', 'human', NULL, 'idea', '${entityId}', 'nope')`),
      ),
    ).toBe("42501");
    expect(await listNotes(db.admin, { entityType: "idea", entityId })).toEqual([]);
  });

  it("is not fooled by a temporary table that shadows notes", async () => {
    const entityId = await makeEntity.idea();
    const client = await db.admin.connect();
    try {
      await client.query(
        "CREATE TEMP TABLE notes (id uuid, entity_type text, entity_id uuid, body_md text)",
      );
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM add_note('mallory', 'human', NULL, 'idea', $1, 'real note')",
        [entityId],
      );
      expect(rows).toHaveLength(1);
      const temp = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_temp.notes",
      );
      expect(temp.rows[0]?.n).toBe(0);
    } finally {
      client.release(true);
    }
    expect(
      (await listNotes(db.admin, { entityType: "idea", entityId })).map((n) => [
        n.author,
        n.bodyMd,
      ]),
    ).toEqual([["mallory", "real note"]]);
  });
});
