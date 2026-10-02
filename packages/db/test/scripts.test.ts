// The script functions (migration 0032, T12): save_script_version and set_script_status, i.e. the
// append-only revisions of PRD 4 with their optimistic concurrency ("insert the next version only
// if base_version is the latest") and the review status.
//
// Real database, typed wrappers, application roles. The races are real too: concurrent
// transactions on separate connections, one of them held open on purpose to prove that the second
// waits for the first and then reads its result.
import { randomUUID } from "node:crypto";
import {
  SCRIPT_BODY_MAX_BYTES,
  SCRIPT_KINDS,
  SCRIPT_STATUSES,
  type ScriptKind,
  type ScriptStatus,
} from "@ytw/shared/constants";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, withActor, type Actor } from "../src/client.js";
import {
  DbError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
  toDbError,
} from "../src/errors.js";
import { archiveIdea } from "../src/ideas.js";
import {
  getScriptVersion,
  saveScriptVersion,
  setScriptStatus,
  type ScriptRecord,
  type ScriptRecordWithBody,
} from "../src/scripts.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import {
  act,
  alice,
  eventCount,
  eventsFor,
  expectedNullOutcomes,
  functionPrivileges,
  newAgent,
  newIdea,
  nullArgumentOutcomes,
  outcomeKind,
  partition,
  seededRandom,
  settle,
  tick,
  waitForLockWait,
  withoutRowLock,
  type FunctionSpec,
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

function save(
  actor: Actor,
  ideaId: string,
  baseVersion: number,
  bodyMd: string,
  kind: ScriptKind = "script",
): Promise<ScriptRecord> {
  return act(db, actor, (tx) => saveScriptVersion(tx, { ideaId, kind, baseVersion, bodyMd }));
}

function setStatus(actor: Actor, scriptId: string, status: ScriptStatus) {
  return act(db, actor, (tx) => setScriptStatus(tx, { scriptId, status }));
}

/** A saved revision already in status `from`, with its row before the call. */
async function revisionIn(from: ScriptStatus) {
  const idea = await newIdea(db);
  const saved = await save(alice, idea.id, 0, "Body text");
  if (from !== "draft") {
    await setStatus(alice, saved.id, from);
  }
  const before = (await getScriptVersion(db.admin, {
    ideaId: idea.id,
    kind: "script",
  })) as ScriptRecordWithBody;
  await tick();
  return { idea, saved, before, eventsBefore: await eventCount(db, saved.id) };
}

async function scriptRows(ideaId: string, kind: ScriptKind = "script") {
  const { rows } = await db.admin.query<{ version: number; body_md: string; created_by: string }>(
    "SELECT version, body_md, created_by FROM scripts WHERE idea_id = $1 AND kind = $2 ORDER BY version",
    [ideaId, kind],
  );
  return rows;
}

// ---------------------------------------------------------------------------------------------

describe("save_script_version", () => {
  it("saves the first version with base 0, as a draft, and the next with the latest as base", async () => {
    const idea = await newIdea(db);
    const first = await save(alice, idea.id, 0, "# Cold open\n\nHello.");
    expect(first).toMatchObject({
      ideaId: idea.id,
      kind: "script",
      version: 1,
      status: "draft",
      sizeBytes: Buffer.byteLength("# Cold open\n\nHello."),
      createdBy: "alice",
      updatedBy: "alice",
    });
    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.updatedAt).toEqual(first.createdAt);

    const agent = newAgent("script bot");
    const second = await save(agent, idea.id, 1, "# Cold open\n\nHello, world.");
    const third = await save(alice, idea.id, 2, "# Cold open\n\nHello, world!");
    expect([second.version, third.version]).toEqual([2, 3]);
    expect(second.createdBy).toBe("script bot");
    expect(await scriptRows(idea.id)).toEqual([
      { version: 1, body_md: "# Cold open\n\nHello.", created_by: "alice" },
      { version: 2, body_md: "# Cold open\n\nHello, world.", created_by: "script bot" },
      { version: 3, body_md: "# Cold open\n\nHello, world!", created_by: "alice" },
    ]);
  });

  it("keeps a separate version line per kind and per idea", async () => {
    const one = await newIdea(db);
    const two = await newIdea(db);
    await save(alice, one.id, 0, "a1");
    await save(alice, one.id, 1, "a2");
    // Packaging has no version yet: its first version is 1 although the script is at 2.
    const packaging = await save(alice, one.id, 0, "p1", "packaging");
    expect(packaging).toMatchObject({ kind: "packaging", version: 1 });
    expect((await save(alice, two.id, 0, "b1")).version).toBe(1);
    for (const kind of SCRIPT_KINDS) {
      expect((await getScriptVersion(db.admin, { ideaId: one.id, kind }))?.kind).toBe(kind);
    }
    expect((await getScriptVersion(db.admin, { ideaId: one.id, kind: "script" }))?.bodyMd).toBe(
      "a2",
    );
    expect((await getScriptVersion(db.admin, { ideaId: one.id, kind: "packaging" }))?.bodyMd).toBe(
      "p1",
    );
  });

  it("stores the body exactly as given, whatever it contains", async () => {
    const idea = await newIdea(db);
    const bodies = [
      "",
      "   \n\n  ",
      "line one\r\nline two\r\n",
      "﻿starts with a byte order mark",
      "emoji \u{1F3AC}, accents éè, kanji 日本語, RTL שלום",
      "---\nidea_id: not front matter here\n---\nbody",
      "tab\tseparated\tcolumns",
      "trailing spaces   ",
      "$$ ' \" ; -- /* */ \\ $1 %s '); DROP TABLE scripts;--",
      "<script>alert(1)</script> <img src=x onerror=alert(2)>",
      "x".repeat(50_000),
    ];
    let base = 0;
    for (const body of bodies) {
      const saved = await save(alice, idea.id, base, body);
      base = saved.version;
      expect(saved.sizeBytes).toBe(Buffer.byteLength(body));
      const stored = await getScriptVersion(db.admin, {
        ideaId: idea.id,
        kind: "script",
        version: saved.version,
      });
      expect(stored?.bodyMd).toBe(body);
    }
    expect(base).toBe(bodies.length);
  });

  it("writes an audit row for the actor, with the token of an agent and no body in the log", async () => {
    const idea = await newIdea(db);
    const agent = newAgent("scribe");
    const small = await save(agent, idea.id, 0, "short body");
    const big = await save(alice, idea.id, 1, "word ".repeat(10_000));
    const [smallEvent] = await eventsFor(db, small.id);
    expect(smallEvent).toMatchObject({
      actor: "scribe",
      actor_type: "agent",
      token_id: agent.tokenId,
      action: "insert",
      entity_type: "script",
      entity_id: small.id,
      payload: {
        new: expect.objectContaining({
          idea_id: idea.id,
          kind: "script",
          version: 1,
          status: "draft",
          body_md: "short body",
        }),
      },
    });
    expect(smallEvent?.payload.new).not.toHaveProperty("search_vector");
    const [bigEvent] = await eventsFor(db, big.id);
    expect(bigEvent).toMatchObject({ actor: "alice", actor_type: "human", token_id: null });
    expect(bigEvent?.payload.new?.body_md).toEqual({ omitted: "too_large", bytes: 50_000 });
  });

  describe("conflicts", () => {
    it("fails when base_version is behind the latest and says which version to merge into", async () => {
      const idea = await newIdea(db);
      await save(alice, idea.id, 0, "v1");
      await save(alice, idea.id, 1, "v2");
      const events = await eventCount(db, idea.id);
      for (const base of [0, 1]) {
        const err = await rejectedWith(
          save(alice, idea.id, base, "stale edit"),
          VersionConflictError,
        );
        expect(err.latestVersion).toBe(2);
        expect(err.details).toMatchObject({
          entity: "script",
          idea_id: idea.id,
          kind: "script",
          expected_version: base,
          latest_version: 2,
        });
        expect(err.message).toBe(
          `base_version ${base} is not the latest script version of idea ${idea.id}: the latest is version 2; fetch version 2, merge your changes into it and save again with base_version 2`,
        );
        expect(err.status).toBe(409);
      }
      expect(await scriptRows(idea.id)).toHaveLength(2);
      expect(await eventCount(db, idea.id)).toBe(events);
    });

    it("fails when base_version is ahead of the latest", async () => {
      const idea = await newIdea(db);
      await save(alice, idea.id, 0, "v1");
      const err = await rejectedWith(
        save(alice, idea.id, 5, "from the future"),
        VersionConflictError,
      );
      expect(err.latestVersion).toBe(1);
      expect(await scriptRows(idea.id)).toHaveLength(1);
    });

    it("fails with latest_version 0 when nothing is saved yet and the caller claims otherwise", async () => {
      const idea = await newIdea(db);
      const err = await rejectedWith(
        save(alice, idea.id, 3, "edit of nothing"),
        VersionConflictError,
      );
      expect(err.latestVersion).toBe(0);
      expect(err.message).toBe(
        `idea ${idea.id} has no saved script yet, so base_version must be 0 (you sent 3): save the first version with base_version 0`,
      );
      expect(await scriptRows(idea.id)).toEqual([]);
    });

    it("judges each kind by its own latest version", async () => {
      const idea = await newIdea(db);
      await save(alice, idea.id, 0, "script v1");
      await save(alice, idea.id, 1, "script v2");
      const err = await rejectedWith(
        save(alice, idea.id, 2, "packaging?", "packaging"),
        VersionConflictError,
      );
      expect(err.latestVersion).toBe(0);
      expect(err.details).toMatchObject({ kind: "packaging" });
    });

    it("rejects a repeated save: the second of two identical uploads is told the latest version", async () => {
      const idea = await newIdea(db);
      await save(alice, idea.id, 0, "same");
      const err = await rejectedWith(save(alice, idea.id, 0, "same"), VersionConflictError);
      expect(err.latestVersion).toBe(1);
    });
  });

  describe("arguments", () => {
    const badKinds: [string, string][] = [
      ["capitalised", "Script"],
      ["upper case", "SCRIPT"],
      ["another word", "notes"],
      ["empty", ""],
      ["leading space", " script"],
      ["trailing space", "script "],
      ["SQL injection", "script'; DROP TABLE scripts;--"],
      ["5000 characters", "x".repeat(5000)],
    ];

    it.each(badKinds)(
      "rejects the kind that is %s and lists the valid ones",
      async (_label, kind) => {
        const idea = await newIdea(db);
        const err = await rejectedWith(
          act(db, alice, (tx) =>
            saveScriptVersion(tx, {
              ideaId: idea.id,
              kind: kind as ScriptKind,
              baseVersion: 0,
              bodyMd: "x",
            }),
          ),
          ValidationError,
        );
        expect(err.field).toBe("kind");
        expect(err.allowed).toEqual([...SCRIPT_KINDS]);
        expect(err.message).toContain('valid kinds: "script", "packaging"');
        expect(err.message.length).toBeLessThan(300);
        expect(await scriptRows(idea.id)).toEqual([]);
      },
    );

    it("rejects a missing kind, idea, base version or body", async () => {
      const idea = await newIdea(db);
      const call = (
        ideaId: string | null,
        kind: string | null,
        base: number | null,
        body: string | null,
      ) =>
        db
          .pool("ytw_mcp")
          .query(
            sql`SELECT * FROM save_script_version('bot', 'agent', NULL, ${ideaId}::uuid, ${kind}, ${base}::integer, ${body})`,
          );
      expect((await rejectedWith(call(null, "script", 0, "x"), ValidationError)).field).toBe(
        "idea_id",
      );
      expect((await rejectedWith(call(idea.id, null, 0, "x"), ValidationError)).field).toBe("kind");
      expect((await rejectedWith(call(idea.id, "script", null, "x"), ValidationError)).field).toBe(
        "base_version",
      );
      expect((await rejectedWith(call(idea.id, "script", -1, "x"), ValidationError)).field).toBe(
        "base_version",
      );
      const noBody = await rejectedWith(call(idea.id, "script", 0, null), ValidationError);
      expect(noBody.field).toBe("body_md");
      expect(noBody.message).toContain("empty string is allowed");
      expect(await scriptRows(idea.id)).toEqual([]);
    });

    it("rejects values that are not what they claim before they reach the database", async () => {
      const idea = await newIdea(db);
      const attempt = (input: Partial<Parameters<typeof saveScriptVersion>[1]>) =>
        act(db, alice, (tx) =>
          saveScriptVersion(tx, {
            ideaId: idea.id,
            kind: "script",
            baseVersion: 0,
            bodyMd: "x",
            ...input,
          }),
        );
      expect((await rejectedWith(attempt({ ideaId: "not-a-uuid" }), ValidationError)).field).toBe(
        "idea_id",
      );
      expect((await rejectedWith(attempt({ baseVersion: 1.5 }), ValidationError)).field).toBe(
        "base_version",
      );
      expect(
        (await rejectedWith(attempt({ baseVersion: Number.NaN }), ValidationError)).field,
      ).toBe("base_version");
      expect((await rejectedWith(attempt({ baseVersion: 2 ** 31 }), ValidationError)).field).toBe(
        "base_version",
      );
      const nul = await rejectedWith(attempt({ bodyMd: "a\u0000b" }), ValidationError);
      expect(nul.field).toBe("body_md");
      expect(await scriptRows(idea.id)).toEqual([]);
    });

    it("fails for an idea that does not exist", async () => {
      const ideaId = randomUUID();
      const err = await rejectedWith(save(alice, ideaId, 0, "orphan"), NotFoundError);
      expect(err).toMatchObject({ entity: "idea", id: ideaId });
      expect(err.status).toBe(404);
    });
  });

  describe("the size limit", () => {
    it("accepts a body of exactly SCRIPT_BODY_MAX_BYTES bytes of UTF-8 and refuses one byte more", async () => {
      const idea = await newIdea(db);
      const exactly = "a".repeat(SCRIPT_BODY_MAX_BYTES);
      const saved = await save(alice, idea.id, 0, exactly);
      expect(saved.sizeBytes).toBe(SCRIPT_BODY_MAX_BYTES);

      const err = await rejectedWith(save(alice, idea.id, 1, `${exactly}a`), ValidationError);
      expect(err.field).toBe("body_md");
      expect(err.details).toMatchObject({
        bytes: SCRIPT_BODY_MAX_BYTES + 1,
        max_bytes: SCRIPT_BODY_MAX_BYTES,
      });
      expect(err.message).toBe(
        `body_md is too large: ${SCRIPT_BODY_MAX_BYTES + 1} bytes, the limit is ${SCRIPT_BODY_MAX_BYTES} (1 MiB of UTF-8)`,
      );
      expect(await scriptRows(idea.id)).toHaveLength(1);
      // The refusal did not use up a version: the next save still has base 1.
      expect((await save(alice, idea.id, 1, "small again")).version).toBe(2);
    });

    it.each([
      ["two-byte characters", "é", 2],
      ["three-byte characters", "日", 3],
      ["four-byte characters", "\u{1F3AC}", 4],
    ])("counts bytes, not characters: %s", async (_name, char, bytes) => {
      const idea = await newIdea(db);
      const fits = char.repeat(Math.floor(SCRIPT_BODY_MAX_BYTES / bytes));
      const fitsBytes = Buffer.byteLength(fits);
      expect(fitsBytes).toBeLessThanOrEqual(SCRIPT_BODY_MAX_BYTES);
      expect(fitsBytes + bytes).toBeGreaterThan(SCRIPT_BODY_MAX_BYTES);
      expect((await save(alice, idea.id, 0, fits)).sizeBytes).toBe(fitsBytes);
      // One more character crosses the limit, although the body is far below it in characters.
      const err = await rejectedWith(save(alice, idea.id, 1, `${fits}${char}`), ValidationError);
      expect(err.field).toBe("body_md");
      expect(err.details).toMatchObject({
        bytes: fitsBytes + bytes,
        max_bytes: SCRIPT_BODY_MAX_BYTES,
      });
    });

    it("never echoes the body in the error", async () => {
      const idea = await newIdea(db);
      const err = await rejectedWith(
        save(alice, idea.id, 0, `SECRET-MARKER ${"z".repeat(SCRIPT_BODY_MAX_BYTES)}`),
        ValidationError,
      );
      expect(err.message).not.toContain("SECRET-MARKER");
      expect(JSON.stringify(err.toJSON())).not.toContain("SECRET-MARKER");
    });
  });

  describe("status and history", () => {
    it("always saves a draft, even on top of an approved version, and leaves older versions alone", async () => {
      const idea = await newIdea(db);
      const v1 = await save(alice, idea.id, 0, "approved text");
      await act(db, alice, (tx) => setScriptStatus(tx, { scriptId: v1.id, status: "approved" }));
      const v2 = await save(alice, idea.id, 1, "next draft");
      expect(v2.status).toBe("draft");
      const { rows } = await db.admin.query<{ version: number; status: string; body_md: string }>(
        "SELECT version, status, body_md FROM scripts WHERE idea_id = $1 ORDER BY version",
        [idea.id],
      );
      expect(rows).toEqual([
        { version: 1, status: "approved", body_md: "approved text" },
        { version: 2, status: "draft", body_md: "next draft" },
      ]);
    });

    it("does not let the status of a version change what base_version means", async () => {
      const idea = await newIdea(db);
      const v1 = await save(alice, idea.id, 0, "one");
      await act(db, alice, (tx) => setScriptStatus(tx, { scriptId: v1.id, status: "review" }));
      expect((await save(alice, idea.id, 1, "two")).version).toBe(2);
    });
  });

  describe("an archived idea", () => {
    it("gets no new script versions, but keeps and serves the old ones", async () => {
      const idea = await newIdea(db);
      await save(alice, idea.id, 0, "before archiving");
      await act(db, alice, (tx) => archiveIdea(tx, { id: idea.id }));
      for (const kind of SCRIPT_KINDS) {
        const err = await rejectedWith(
          save(alice, idea.id, kind === "script" ? 1 : 0, "too late", kind),
          InvalidTransitionError,
        );
        expect(err.details).toMatchObject({ entity: "idea", id: idea.id, reason: "archived" });
        expect(err.message).toBe(
          `idea ${idea.id} is archived and cannot be given new script versions`,
        );
      }
      expect(await scriptRows(idea.id)).toHaveLength(1);
      expect((await getScriptVersion(db.admin, { ideaId: idea.id, kind: "script" }))?.bodyMd).toBe(
        "before archiving",
      );
    });

    it("loses a race against archiving that started first", async () => {
      const idea = await newIdea(db);
      const archiver = await db.pool("ytw_web").connect();
      try {
        await archiver.query("BEGIN");
        await archiver.query(sql`SELECT archive_idea('alice', 'human', NULL, ${idea.id}::uuid)`);
        const racing = withActor(db.pool("ytw_mcp"), newAgent(), (tx) =>
          saveScriptVersion(tx, {
            ideaId: idea.id,
            kind: "script",
            baseVersion: 0,
            bodyMd: "late",
          }),
        );
        const outcome = racing.then(
          () => undefined,
          (err: unknown) => err,
        );
        await waitForLockWait(db, "save_script_version");
        await archiver.query("COMMIT");
        const err = await outcome;
        expect(err).toBeInstanceOf(InvalidTransitionError);
        expect(await scriptRows(idea.id)).toEqual([]);
      } finally {
        await archiver.query("ROLLBACK").catch(() => undefined);
        archiver.release();
      }
    });

    it("makes archiving wait for a save that started first", async () => {
      const idea = await newIdea(db);
      const saver = await db.pool("ytw_mcp").connect();
      try {
        await saver.query("BEGIN");
        await saver.query(
          sql`SELECT save_script_version('bot', 'agent', ${randomUUID()}::uuid, ${idea.id}::uuid, 'script', 0, 'first')`,
        );
        const archiving = withActor(db.pool("ytw_web"), alice, (tx) =>
          archiveIdea(tx, { id: idea.id }),
        );
        const outcome = archiving.then(
          (archived) => archived,
          (err: unknown) => err,
        );
        await waitForLockWait(db, "archive_idea");
        await saver.query("COMMIT");
        expect(await outcome).toMatchObject({ id: idea.id, archivedAt: expect.any(Date) });
        expect(await scriptRows(idea.id)).toHaveLength(1);
      } finally {
        await saver.query("ROLLBACK").catch(() => undefined);
        saver.release();
      }
    });
  });

  describe("concurrent saves with the same base_version", () => {
    it("make the second wait for the first, then fail with the version the first saved", async () => {
      const idea = await newIdea(db);
      const winner = await db.pool("ytw_mcp").connect();
      const loser = await db.pool("ytw_web").connect();
      try {
        await winner.query("BEGIN");
        await winner.query(
          sql`SELECT save_script_version('winner bot', 'agent', ${randomUUID()}::uuid, ${idea.id}::uuid, 'script', 0, 'the winner')`,
        );
        await loser.query("BEGIN");
        const racing = loser.query(
          sql`SELECT save_script_version('alice', 'human', NULL, ${idea.id}::uuid, 'script', 0, 'the loser')`,
        );
        const outcome = racing.then(
          () => undefined,
          (err: unknown) => err,
        );
        // The loser really is queued behind the winner (and has not simply run first or after).
        await waitForLockWait(db, "save_script_version");
        await winner.query("COMMIT");
        const err = toDbError(await outcome);
        expect(err).toBeInstanceOf(VersionConflictError);
        expect((err as VersionConflictError).latestVersion).toBe(1);
        expect((err as VersionConflictError).message).toContain("the latest is version 1");
      } finally {
        await loser.query("ROLLBACK").catch(() => undefined);
        winner.release();
        loser.release();
      }
      expect(await scriptRows(idea.id)).toEqual([
        { version: 1, body_md: "the winner", created_by: "winner bot" },
      ]);
    });

    it("produce exactly one winner among many, and every loser learns the latest version", async () => {
      const idea = await newIdea(db);
      const agent = newAgent("racer");
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          save(i % 2 === 0 ? alice : agent, idea.id, 0, `attempt ${i}`),
        ),
      );
      const { ok, failed } = partition(results);
      expect(ok).toHaveLength(1);
      expect(ok[0]).toMatchObject({ version: 1, status: "draft" });
      expect(failed).toHaveLength(7);
      for (const reason of failed) {
        expect(reason).toBeInstanceOf(VersionConflictError);
        expect((reason as VersionConflictError).latestVersion).toBe(1);
      }
      const rows = await scriptRows(idea.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.body_md).toMatch(/^attempt [0-7]$/);
    });

    it("keep the history gap-free over rounds of racing writers, one winner per round", async () => {
      const idea = await newIdea(db);
      const agent = newAgent("rounds");
      for (let round = 0; round < 5; round += 1) {
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, (_, i) =>
            save(i % 2 === 0 ? alice : agent, idea.id, round, `round ${round} attempt ${i}`),
          ),
        );
        const { ok, failed } = partition(results);
        expect(ok).toHaveLength(1);
        expect(ok[0]?.version).toBe(round + 1);
        expect(failed).toHaveLength(5);
        for (const reason of failed) {
          expect((reason as VersionConflictError).latestVersion).toBe(round + 1);
        }
      }
      expect((await scriptRows(idea.id)).map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    });

    it("are not confused with saves for another kind or another idea", async () => {
      const one = await newIdea(db);
      const two = await newIdea(db);
      const results = await Promise.allSettled([
        save(alice, one.id, 0, "one script"),
        save(newAgent(), one.id, 0, "one packaging", "packaging"),
        save(alice, two.id, 0, "two script"),
        save(newAgent(), two.id, 0, "two packaging", "packaging"),
      ]);
      const { ok, failed } = partition(results);
      expect(failed).toEqual([]);
      expect(ok.map((row) => row.version)).toEqual([1, 1, 1, 1]);
    });

    it("still produce one winner if the idea row lock is taken away: the unique key decides", async () => {
      const idea = await newIdea(db);
      const agent = newAgent("unlocked");
      const results = await withoutRowLock(db, ["save_script_version"], () =>
        Promise.allSettled(
          Array.from({ length: 8 }, (_, i) =>
            save(i % 2 === 0 ? alice : agent, idea.id, 0, `attempt ${i}`),
          ),
        ),
      );
      const { ok, failed } = partition(results);
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(7);
      for (const reason of failed) {
        expect(reason).toBeInstanceOf(VersionConflictError);
        expect((reason as VersionConflictError).latestVersion).toBe(1);
      }
      expect(await scriptRows(idea.id)).toHaveLength(1);
    });

    it("turn a duplicate version written behind the function's back into the same conflict", async () => {
      // A writer that skips the idea lock (here: a superuser insert that is still uncommitted)
      // cannot be seen by the check, so the unique key catches it when it commits.
      const idea = await newIdea(db);
      const sneaky = await db.admin.connect();
      try {
        await sneaky.query("BEGIN");
        await sneaky.query("SELECT ytw_set_actor('fixture', 'human', NULL)");
        await sneaky.query(
          "INSERT INTO scripts (idea_id, kind, version, body_md) VALUES ($1, 'script', 1, 'sneaky')",
          [idea.id],
        );
        const racing = act(db, alice, (tx) =>
          saveScriptVersion(tx, {
            ideaId: idea.id,
            kind: "script",
            baseVersion: 0,
            bodyMd: "honest",
          }),
        );
        const outcome = racing.then(
          () => undefined,
          (err: unknown) => err,
        );
        await waitForLockWait(db, "save_script_version");
        await sneaky.query("COMMIT");
        const err = await outcome;
        expect(err).toBeInstanceOf(VersionConflictError);
        expect((err as VersionConflictError).latestVersion).toBe(1);
      } finally {
        await sneaky.query("ROLLBACK").catch(() => undefined);
        sneaky.release();
      }
      expect(await scriptRows(idea.id)).toEqual([
        { version: 1, body_md: "sneaky", created_by: "fixture" },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("set_script_status", () => {
  const transitions = SCRIPT_STATUSES.flatMap((from) =>
    SCRIPT_STATUSES.map((to) => [from, to] as const),
  );
  const unchanged = transitions.filter(([from, to]) => from === to);
  const changing = transitions.filter(([from, to]) => from !== to);

  it("covers all nine pairs of statuses", () => {
    expect(transitions).toHaveLength(SCRIPT_STATUSES.length ** 2);
    expect(unchanged.length + changing.length).toBe(transitions.length);
  });

  it.each(changing)("%s -> %s changes the status and nothing else", async (from, to) => {
    const { idea, saved, before } = await revisionIn(from);
    const agent = newAgent("reviewer");
    const after = await setStatus(agent, saved.id, to);
    expect(after).toMatchObject({
      id: saved.id,
      ideaId: idea.id,
      kind: "script",
      version: 1,
      status: to,
      sizeBytes: before.sizeBytes,
      createdBy: "alice",
      updatedBy: "reviewer",
    });
    expect(after.createdAt).toEqual(before.createdAt);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect((await getScriptVersion(db.admin, { ideaId: idea.id, kind: "script" }))?.bodyMd).toBe(
      "Body text",
    );
    const trail = await eventsFor(db, saved.id);
    expect(trail.at(-1)).toMatchObject({
      actor: "reviewer",
      actor_type: "agent",
      token_id: agent.tokenId,
      action: "update",
      entity_type: "script",
      payload: { old: { status: from }, new: { status: to } },
    });
  });

  it.each(unchanged)("%s -> %s is a no-op: same row, no audit row", async (status) => {
    const { saved, before, eventsBefore } = await revisionIn(status);
    const after = await setStatus(newAgent("reviewer"), saved.id, status);
    expect(after).toEqual({ ...before, bodyMd: undefined });
    expect(await eventCount(db, saved.id)).toBe(eventsBefore);
  });

  it("can set any revision, not only the latest", async () => {
    const idea = await newIdea(db);
    const v1 = await save(alice, idea.id, 0, "one");
    await save(alice, idea.id, 1, "two");
    expect((await setStatus(alice, v1.id, "approved")).version).toBe(1);
    expect((await getScriptVersion(db.admin, { ideaId: idea.id, kind: "script" }))?.status).toBe(
      "draft",
    );
  });

  it("changes nothing but the status, whatever the revision holds", async () => {
    const idea = await newIdea(db);
    const body = "x".repeat(300_000);
    const saved = await save(alice, idea.id, 0, body);
    await setStatus(alice, saved.id, "review");
    const stored = await getScriptVersion(db.admin, {
      ideaId: idea.id,
      kind: "script",
      version: 1,
    });
    expect(stored).toMatchObject({
      status: "review",
      version: 1,
      kind: "script",
      sizeBytes: 300_000,
    });
    expect(stored?.bodyMd).toBe(body);
    const last = (await eventsFor(db, saved.id)).at(-1);
    expect(last?.payload).toEqual({ old: { status: "draft" }, new: { status: "review" } });
  });

  const badStatuses: [string, string][] = [
    ["capitalised", "Draft"],
    ["upper case", "APPROVED"],
    ["a stage name", "published"],
    ["empty", ""],
    ["leading space", " review"],
    ["trailing space", "approved "],
    ["SQL injection", "review'; --"],
    ["5000 characters", "x".repeat(5000)],
  ];

  it.each(badStatuses)(
    "rejects the status that is %s and lists the valid ones",
    async (_label, status) => {
      const idea = await newIdea(db);
      const saved = await save(alice, idea.id, 0, "text");
      const err = await rejectedWith(
        setStatus(alice, saved.id, status as ScriptStatus),
        ValidationError,
      );
      expect(err.field).toBe("status");
      expect(err.allowed).toEqual([...SCRIPT_STATUSES]);
      expect(err.message).toContain('valid statuses: "draft", "review", "approved"');
      expect(err.message.length).toBeLessThan(300);
      expect((await getScriptVersion(db.admin, { ideaId: idea.id, kind: "script" }))?.status).toBe(
        "draft",
      );
    },
  );

  it("rejects a missing status or script id", async () => {
    const idea = await newIdea(db);
    const saved = await save(alice, idea.id, 0, "text");
    const call = (scriptId: string | null, status: string | null) =>
      db
        .pool("ytw_web")
        .query(
          sql`SELECT * FROM set_script_status('alice', 'human', NULL, ${scriptId}::uuid, ${status})`,
        );
    expect((await rejectedWith(call(saved.id, null), ValidationError)).field).toBe("status");
    const noId = await rejectedWith(call(null, "review"), ValidationError);
    expect(noId.field).toBe("script_id");
    expect(noId.message).toContain("not the idea id");
  });

  it("fails for a script that does not exist, and for an idea id used by mistake", async () => {
    const idea = await newIdea(db);
    await save(alice, idea.id, 0, "text");
    for (const id of [randomUUID(), idea.id]) {
      const err = await rejectedWith(setStatus(alice, id, "review"), NotFoundError);
      expect(err).toMatchObject({ entity: "script", id });
      expect(err.message).toBe(`script ${id} does not exist: check the id`);
    }
    const malformed = await rejectedWith(setStatus(alice, "v1", "review"), ValidationError);
    expect(malformed.field).toBe("script_id");
  });

  it("works on the scripts of an archived idea (only new versions are refused)", async () => {
    const idea = await newIdea(db);
    const saved = await save(alice, idea.id, 0, "text");
    await act(db, alice, (tx) => archiveIdea(tx, { id: idea.id }));
    expect((await setStatus(alice, saved.id, "approved")).status).toBe("approved");
  });

  it("lets exactly the last of racing writers decide, and never corrupts the revision", async () => {
    const idea = await newIdea(db);
    const saved = await save(alice, idea.id, 0, "text");
    const results = await Promise.allSettled(
      (["review", "approved", "draft", "review", "approved", "draft"] as const).map((status, i) =>
        setStatus(i % 2 === 0 ? alice : newAgent(), saved.id, status),
      ),
    );
    const { failed } = partition(results);
    expect(failed).toEqual([]);
    const stored = await getScriptVersion(db.admin, { ideaId: idea.id, kind: "script" });
    expect(SCRIPT_STATUSES).toContain(stored?.status);
    expect(stored).toMatchObject({ version: 1, sizeBytes: 4, bodyMd: "text" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("model-based check", () => {
  type Revision = { id: string; body: string; status: ScriptStatus };

  it.each([1, 2, 3])(
    "random saves and status changes agree with a model of the version lines (seed %i)",
    async (seed) => {
      const random = seededRandom(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
      const people = [alice, newAgent("model bot")];
      const ideas = [await newIdea(db), await newIdea(db)];
      const lines = new Map<string, Revision[]>();
      let saved = 0;

      for (let step = 0; step < 100; step += 1) {
        const idea = pick(ideas);
        const kind = pick(SCRIPT_KINDS);
        const key = `${idea.id}:${kind}`;
        const line = lines.get(key) ?? [];
        const latest = line.length;
        const actor = pick(people);

        // Either change the review status of a saved revision, or save with the right base, a
        // stale one or one from the future. The plan is data, so the checks below do not branch.
        const roll = random();
        const target = latest > 0 && random() < 0.25 ? pick(line) : undefined;
        const status = pick(SCRIPT_STATUSES);
        const base =
          roll < 0.6
            ? latest
            : roll < 0.8
              ? Math.max(0, latest - 1 - Math.floor(random() * 2))
              : latest + 1 + Math.floor(random() * 3);
        const body = `step ${step} ${"x".repeat(Math.floor(random() * 40))}`;
        const outcome = await settle(
          target === undefined
            ? save(actor, idea.id, base, body, kind)
            : setStatus(actor, target.id, status),
        );

        const expectedKind = target !== undefined || base === latest ? "ok" : "version_conflict";
        const expectedVersion = target === undefined ? latest + 1 : line.indexOf(target) + 1;
        expect(outcomeKind(outcome)).toBe(expectedKind);
        expect(
          outcome.ok || !(outcome.error instanceof VersionConflictError)
            ? latest
            : outcome.error.latestVersion,
        ).toBe(latest);
        expect(outcome.ok ? outcome.value.version : expectedVersion).toBe(expectedVersion);

        if (outcome.ok && target === undefined) {
          line.push({ id: outcome.value.id, body, status: "draft" });
          lines.set(key, line);
          saved += 1;
        } else if (outcome.ok && target !== undefined) {
          target.status = status;
        }
      }

      expect(saved).toBeGreaterThan(10);
      for (const idea of ideas) {
        for (const kind of SCRIPT_KINDS) {
          const { rows } = await db.admin.query<{
            id: string;
            version: number;
            body_md: string;
            status: string;
          }>(
            "SELECT id, version, body_md, status FROM scripts WHERE idea_id = $1 AND kind = $2 ORDER BY version",
            [idea.id, kind],
          );
          expect(rows).toEqual(
            (lines.get(`${idea.id}:${kind}`) ?? []).map((revision, index) => ({
              id: revision.id,
              version: index + 1,
              body_md: revision.body,
              status: revision.status,
            })),
          );
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------

describe("getScriptVersion", () => {
  it("returns the latest revision by default, a given one on request, and null for none", async () => {
    const idea = await newIdea(db);
    expect(await getScriptVersion(db.admin, { ideaId: idea.id, kind: "script" })).toBeNull();
    await save(alice, idea.id, 0, "one");
    await save(alice, idea.id, 1, "two");
    await save(alice, idea.id, 2, "three");
    const latest = await getScriptVersion(db.pool("ytw_readonly"), {
      ideaId: idea.id,
      kind: "script",
    });
    expect(latest).toMatchObject({ version: 3, bodyMd: "three", status: "draft", sizeBytes: 5 });
    expect(
      (await getScriptVersion(db.admin, { ideaId: idea.id, kind: "script", version: 2 }))?.bodyMd,
    ).toBe("two");
    expect(
      await getScriptVersion(db.admin, { ideaId: idea.id, kind: "script", version: 4 }),
    ).toBeNull();
    expect(await getScriptVersion(db.admin, { ideaId: idea.id, kind: "packaging" })).toBeNull();
  });

  it("rejects malformed arguments with a validation error", async () => {
    const err = await rejectedWith(
      getScriptVersion(db.admin, { ideaId: "x", kind: "script" }),
      ValidationError,
    );
    expect(err.field).toBe("idea_id");
    const version = await rejectedWith(
      getScriptVersion(db.admin, { ideaId: randomUUID(), kind: "script", version: 1.5 }),
      ValidationError,
    );
    expect(version.field).toBe("version");
  });
});

// ---------------------------------------------------------------------------------------------

describe("arguments that are NULL", () => {
  // Generated at run time: a literal id next to a "token" key reads as a credential to the secret scan.
  const agentToken = randomUUID();
  const specs: FunctionSpec[] = [
    {
      name: "save_script_version",
      types: ["text", "text", "uuid", "uuid", "text", "integer", "text"],
      valid: async () => [
        "bot",
        "agent",
        agentToken,
        (await newIdea(db)).id,
        "script",
        0,
        "# Body",
      ],
      optional: [2],
    },
    {
      name: "set_script_status",
      types: ["text", "text", "uuid", "uuid", "text"],
      valid: async () => {
        const idea = await newIdea(db);
        const script = await save(alice, idea.id, 0, "# Body");
        return ["bot", "agent", agentToken, script.id, "review"];
      },
      optional: [2],
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
  const WRITERS = ["save_script_version", "set_script_status"];

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

  it("keeps the helper that raises the conflict out of reach of every application role", async () => {
    for (const privileges of Object.values(
      await functionPrivileges(db, "ytw_raise_script_conflict"),
    )) {
      expect(privileges).toMatchObject({ roles: [], publicExecute: false });
    }
  });

  it("keeps the catalog guard clean", async () => {
    const { rows } = await db.admin.query("SELECT * FROM ytw_catalog_violations()");
    expect(rows).toEqual([]);
  });

  it("denies direct writes to scripts to every application role, and the functions to ytw_readonly", async () => {
    const idea = await newIdea(db);
    const saved = await save(alice, idea.id, 0, "protected");
    for (const role of ["ytw_web", "ytw_mcp", "ytw_readonly"] as const) {
      const pool = db.pool(role);
      expect(
        await sqlstate(
          pool.query(
            "INSERT INTO scripts (idea_id, kind, version, body_md) VALUES ($1, 'script', 9, 'x')",
            [idea.id],
          ),
        ),
      ).toMatch(/^(42501|25006)$/);
      expect(await sqlstate(pool.query("UPDATE scripts SET body_md = 'tampered'"))).toMatch(
        /^(42501|25006)$/,
      );
      expect(await sqlstate(pool.query("UPDATE scripts SET status = 'approved'"))).toMatch(
        /^(42501|25006)$/,
      );
      expect(await sqlstate(pool.query("DELETE FROM scripts"))).toMatch(/^(42501|25006)$/);
      expect(await sqlstate(pool.query("TRUNCATE scripts"))).toMatch(/^(42501|25006)$/);
    }
    expect(
      await sqlstate(
        db
          .pool("ytw_readonly")
          .query(
            `SELECT * FROM save_script_version('x', 'human', NULL, '${idea.id}', 'script', 1, 'x')`,
          ),
      ),
    ).toBe("42501");
    expect(
      await sqlstate(
        db
          .pool("ytw_readonly")
          .query(`SELECT * FROM set_script_status('x', 'human', NULL, '${saved.id}', 'approved')`),
      ),
    ).toBe("42501");
    expect((await getScriptVersion(db.admin, { ideaId: idea.id, kind: "script" }))?.bodyMd).toBe(
      "protected",
    );
  });

  it("is not fooled by temporary tables that shadow the real ones", async () => {
    const idea = await newIdea(db);
    const client = await db.admin.connect();
    try {
      await client.query("CREATE TEMP TABLE scripts (id uuid, idea_id uuid)");
      await client.query("CREATE TEMP TABLE ideas (id uuid, archived_at timestamptz)");
      const { rows } = await client.query<{ id: string; version: number }>(
        "SELECT id, version FROM save_script_version('mallory', 'human', NULL, $1, 'script', 0, 'real')",
        [idea.id],
      );
      expect(rows[0]?.version).toBe(1);
      const temp = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_temp.scripts",
      );
      expect(temp.rows[0]?.n).toBe(0);
    } finally {
      client.release(true);
    }
    expect(await scriptRows(idea.id)).toEqual([
      { version: 1, body_md: "real", created_by: "mallory" },
    ]);
  });
});
