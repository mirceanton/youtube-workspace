// The activity feed (migration 0064, T15): list_events over the audit log. Filters (actor, actor type,
// entity type and id, action prefix, time range), keyset pagination that stays stable while events
// arrive, hostile cursors and filter values, the limit, payloads as stored, privileges and the
// caller's own rights.
import { ACTOR_TYPES } from "@ytw/shared/constants";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor } from "../src/client.js";
import { ValidationError } from "../src/errors.js";
import {
  EVENTS_LIMIT_DEFAULT,
  EVENTS_LIMIT_MAX,
  listEvents,
  type EventPage,
  type EventRecord,
  type ListEventsInput,
} from "../src/activity.js";
import { upsertUserOnLogin } from "../src/identity.js";
import { saveScriptVersion } from "../src/scripts.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import {
  act,
  alice,
  expectedNullOutcomes,
  functionPrivileges,
  newAgent,
  newIdea,
  nullArgumentOutcomes,
  tick,
  type FunctionSpec,
} from "./content-helpers.js";
import { sqlstate } from "./helpers.js";
import { rejectedWith } from "./video-helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

const web = () => db.pool("ytw_web");
const hex = (): string => randomBytes(4).toString("hex");
/** An entity type nobody else uses, so a test sees exactly the events it wrote. */
const scope = (): string => `feed_${hex()}`;

interface NewEvent {
  id?: string;
  /** An ISO time with a zone; microseconds allowed. */
  at: string;
  actor?: string;
  actorType?: "human" | "agent";
  tokenId?: string | null;
  action?: string;
  entityType?: string | null;
  entityId?: string | null;
  payload?: Record<string, unknown>;
}

/** The base of the synthetic times: a fixed instant well before anything the real functions write. */
const BASE = Date.UTC(2026, 5, 1, 12, 0, 0);
const at = (seconds: number, micros = 0): string =>
  `${new Date(BASE + seconds * 1000).toISOString().slice(0, 19)}.${String(micros).padStart(6, "0")}Z`;

/** Writes events with exact times straight into the log (as the superuser) and returns their ids. */
async function insertEvents(events: NewEvent[]): Promise<string[]> {
  const { rows } = await db.admin.query<{ id: string }>(
    `INSERT INTO events (id, created_at, actor, actor_type, token_id, action, entity_type, entity_id, payload)
     SELECT coalesce(x.id, public.uuid_generate_v7()), x.at::timestamptz, coalesce(x.actor, 'feed-actor'),
            coalesce(x."actorType", 'human'), x."tokenId", coalesce(x.action, 'insert'), x."entityType",
            x."entityId", coalesce(x.payload, '{}'::jsonb)
       FROM jsonb_to_recordset($1::jsonb)
            AS x (id uuid, at text, actor text, "actorType" text, "tokenId" uuid, action text,
                  "entityType" text, "entityId" uuid, payload jsonb)
     RETURNING id`,
    [JSON.stringify(events)],
  );
  return rows.map((row) => row.id);
}

/** Follows nextCursor to the end; returns every page. */
async function walk(input: ListEventsInput): Promise<EventPage[]> {
  const pages: EventPage[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard += 1) {
    const page = await listEvents(web(), { ...input, ...(cursor === undefined ? {} : { cursor }) });
    pages.push(page);
    if (page.nextCursor === null) {
      return pages;
    }
    cursor = page.nextCursor;
  }
  throw new Error("the cursor never ended");
}

const ids = (events: EventRecord[]): string[] => events.map((event) => event.id);

/** A cursor payload as the function expects it on the wire: base64url of the text. */
const encode = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/** Ten events, one second apart, oldest = 0. */
async function tenEvents(): Promise<{ entityType: string; written: string[] }> {
  const entityType = scope();
  const written = await insertEvents(
    Array.from({ length: 10 }, (_, second) => ({
      at: at(second),
      entityType,
      payload: { second },
    })),
  );
  return { entityType, written };
}

// ---------------------------------------------------------------------------------------------
describe("what an event looks like", () => {
  it("returns the stored row with real dates, nullable entity and token, and the payload as stored", async () => {
    const entityType = scope();
    const entityId = "00000000-0000-7000-8000-00000000f001";
    const token = "00000000-0000-7000-8000-00000000f0f0";
    const payload = {
      new: { title: "Unicode é日本", n: 3, nested: { list: [1, 2.5, null, "x", true] } },
      note: "[redacted]",
      empty: {},
      arr: [],
    };
    const [withEntity, withoutEntity] = await insertEvents([
      {
        at: at(10, 123456),
        actor: "agent-detail",
        actorType: "agent",
        tokenId: token,
        action: "tool.call",
        entityType,
        entityId,
        payload,
      },
      { at: at(5), actor: "alice-detail", action: "auth.login", payload: { method: "oidc" } },
    ]);
    const { events } = await listEvents(web(), { entityType });
    expect(events).toEqual([
      {
        id: withEntity,
        createdAt: new Date("2026-06-01T12:00:10.123Z"),
        actor: "agent-detail",
        actorType: "agent",
        tokenId: token,
        action: "tool.call",
        entityType,
        entityId,
        payload,
      },
    ]);
    const login = (await listEvents(web(), { actor: "alice-detail" })).events[0];
    expect(login).toMatchObject({
      id: withoutEntity,
      actorType: "human",
      tokenId: null,
      entityType: null,
      entityId: null,
      payload: { method: "oidc" },
    });
  });

  it("returns exactly what is stored: a payload of 64 KiB, and redactions left as they are", async () => {
    const entityType = scope();
    const big = { text: "x".repeat(60_000), secret: "[redacted]", token_hash: "[redacted]" };
    await insertEvents([
      { at: at(1), entityType, entityId: "00000000-0000-7000-8000-00000000f002", payload: big },
    ]);
    const [event] = (await listEvents(web(), { entityType })).events;
    expect(event?.payload).toEqual(big);
    const { rows } = await db.admin.query<{ payload: unknown }>(
      "SELECT payload FROM events WHERE entity_type = $1",
      [entityType],
    );
    expect(rows[0]?.payload).toEqual(event?.payload);
  });

  it("shows what the audit layer stored for a user: the profile fields are redacted already", async () => {
    const name = `redacted-${hex()}`;
    await withActor(web(), { name, type: "human" }, (tx) =>
      upsertUserOnLogin(tx, {
        issuer: "https://issuer.example",
        sub: `sub-${hex()}`,
        username: name,
        email: `${name}@example.com`,
        displayName: "Redacted Person",
      }),
    );
    const events = (await listEvents(web(), { actor: name, entityType: "user" })).events;
    expect(events.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(`${name}@example.com`);
    expect(serialized).toContain("[redacted]");
  });

  it("lists agent and human actions side by side, with the actor and the token of the writer", async () => {
    const agent = newAgent(`agent-${hex()}`);
    const idea = await newIdea(db, { title: "Written by a person" }, alice);
    const agentIdea = await newIdea(db, { title: "Written by an agent" }, agent);
    await act(db, agent, (tx) =>
      tx.query("SELECT public.ytw_log_event($1, $2, $3, 'tool.call', NULL, NULL, $4::jsonb)", [
        agent.name,
        agent.type,
        agent.tokenId,
        JSON.stringify({ tool: "create_idea", outcome: "ok" }),
      ]),
    );
    const mine = await listEvents(web(), { entityId: idea.id });
    expect(mine.events).toHaveLength(1);
    expect(mine.events[0]).toMatchObject({
      actor: "alice",
      actorType: "human",
      tokenId: null,
      action: "insert",
      entityType: "idea",
      entityId: idea.id,
    });
    expect(mine.events[0]?.payload).toMatchObject({ new: { title: "Written by a person" } });
    const theirs = await listEvents(web(), { actor: agent.name });
    expect(theirs.events.map((event) => event.action)).toEqual(["tool.call", "insert"]); // newest first
    expect(
      theirs.events.every(
        (event) => event.actorType === "agent" && event.tokenId === agent.tokenId,
      ),
    ).toBe(true);
    expect(theirs.events[1]?.entityId).toBe(agentIdea.id);
    // Without a filter both kinds of actor are in the same feed.
    const feed = (await listEvents(web(), { limit: 100 })).events;
    expect(feed.map((event) => event.actorType)).toEqual(expect.arrayContaining([...ACTOR_TYPES]));
  });
});

// ---------------------------------------------------------------------------------------------
describe("filters", () => {
  it("filters by actor with an exact match: case, wildcards and quotes mean nothing", async () => {
    const entityType = scope();
    await insertEvents([
      { at: at(1), actor: "a_b", entityType },
      { at: at(2), actor: "axb", entityType },
      { at: at(3), actor: "A_B", entityType },
      { at: at(4), actor: "a%", entityType },
      { at: at(5), actor: "o'brien", entityType },
    ]);
    const actors = async (actor: string) =>
      (await listEvents(web(), { entityType, actor })).events.map((event) => event.actor);
    expect(await actors("a_b")).toEqual(["a_b"]);
    expect(await actors("A_B")).toEqual(["A_B"]);
    expect(await actors("a%")).toEqual(["a%"]);
    expect(await actors("o'brien")).toEqual(["o'brien"]);
    expect(await actors("a")).toEqual([]);
    expect(await actors("%")).toEqual([]);
    expect(await actors("' OR 1=1 --")).toEqual([]);
    expect(await actors("")).toEqual([]); // the empty name is a name: nobody has it
  });

  it("filters by actor type", async () => {
    const entityType = scope();
    const token = "00000000-0000-7000-8000-00000000f0f1";
    await insertEvents([
      { at: at(1), actor: "p", actorType: "human", entityType },
      { at: at(2), actor: "q", actorType: "agent", tokenId: token, entityType },
      { at: at(3), actor: "r", actorType: "human", entityType },
    ]);
    const types = async (actorType: "human" | "agent") =>
      (await listEvents(web(), { entityType, actorType })).events.map((event) => event.actor);
    expect(await types("human")).toEqual(["r", "p"]);
    expect(await types("agent")).toEqual(["q"]);
  });

  it("filters by entity type and by entity id, alone or together", async () => {
    const [typeA, typeB] = [scope(), scope()];
    const [one, two] = [
      "00000000-0000-7000-8000-00000000f011",
      "00000000-0000-7000-8000-00000000f012",
    ];
    await insertEvents([
      { at: at(1), entityType: typeA, entityId: one },
      { at: at(2), entityType: typeA, entityId: two },
      { at: at(3), entityType: typeB, entityId: one },
      { at: at(4), entityType: typeB, entityId: null },
    ]);
    const count = async (input: ListEventsInput) => (await listEvents(web(), input)).events.length;
    expect(await count({ entityType: typeA })).toBe(2);
    expect(await count({ entityType: typeB })).toBe(2);
    expect(await count({ entityType: typeA, entityId: one })).toBe(1);
    expect(await count({ entityType: typeB, entityId: one })).toBe(1);
    expect(await count({ entityType: typeB, entityId: two })).toBe(0);
    const everywhere = (await listEvents(web(), { entityId: one, limit: 100 })).events.filter(
      (event) => [typeA, typeB].includes(event.entityType ?? ""),
    );
    expect(everywhere.map((event) => event.entityType)).toEqual([typeB, typeA]); // the id alone spans types
  });

  it("follows one record through its whole history, written by the real functions", async () => {
    const owner = newAgent(`agent-${hex()}`);
    const created = await newIdea(db, { title: "History" }, alice);
    await act(db, owner, (tx) =>
      saveScriptVersion(tx, {
        ideaId: created.id,
        kind: "script",
        baseVersion: 0,
        bodyMd: "first",
      }),
    );
    await tick();
    await withActor(db.admin, alice, (tx) =>
      tx.query("UPDATE ideas SET pitch = 'with a pitch' WHERE id = $1", [created.id]),
    );
    const history = await listEvents(web(), { entityId: created.id });
    expect(history.events.map((event) => [event.action, event.actor])).toEqual([
      ["update", "alice"],
      ["insert", "alice"],
    ]);
    const update = history.events[0]?.payload as {
      old: Record<string, unknown>;
      new: Record<string, unknown>;
    };
    expect(update.old).toMatchObject({ pitch: null });
    expect(update.new).toMatchObject({ pitch: "with a pitch" });
    // The script revision is its own entity with its own id.
    const scripts = await listEvents(web(), { entityType: "script", actor: owner.name });
    expect(scripts.events).toHaveLength(1);
    expect(scripts.events[0]?.payload).toMatchObject({ new: { idea_id: created.id } });
  });

  it("filters by action prefix: a plain prefix, not a pattern", async () => {
    const entityType = scope();
    await insertEvents([
      { at: at(1), action: "tool.call", entityType },
      { at: at(2), action: "tool.error", entityType },
      { at: at(3), action: "tools.list", entityType },
      { at: at(4), action: "toolbox", entityType },
      { at: at(5), action: "ab.go", entityType },
      { at: at(6), action: "a_b.go", entityType },
      { at: at(7), action: "insert", entityType },
      { at: at(8), action: "auth.login", entityType },
    ]);
    const actions = async (actionPrefix: string) =>
      (await listEvents(web(), { entityType, actionPrefix })).events
        .map((event) => event.action)
        .toSorted();
    expect(await actions("tool.")).toEqual(["tool.call", "tool.error"]);
    expect(await actions("tool")).toEqual(["tool.call", "tool.error", "toolbox", "tools.list"]);
    expect(await actions("tool.call")).toEqual(["tool.call"]);
    expect(await actions("a_")).toEqual(["a_b.go"]); // LIKE would match "ab.go" too
    expect(await actions("a")).toEqual(["a_b.go", "ab.go", "auth.login"]);
    expect(await actions("%")).toEqual([]);
    expect(await actions("t%")).toEqual([]);
    expect(await actions("_")).toEqual([]);
    expect(await actions("Tool.")).toEqual([]); // case matters
    expect(await actions("x".repeat(500))).toEqual([]);
    expect((await actions("")).length).toBe(8); // the empty prefix is no filter
    expect(await actions("'; DROP TABLE events; --")).toEqual([]);
    expect(await actions("insert")).toEqual(["insert"]);
  });

  it("filters by time: from included, to excluded, either alone, to the microsecond", async () => {
    const entityType = scope();
    const written = await insertEvents(
      [0, 1, 2, 3, 4].map((second) => ({ at: at(second), entityType, payload: { second } })),
    );
    const seconds = async (input: ListEventsInput) =>
      (await listEvents(web(), { entityType, ...input })).events.map(
        (event) => event.payload.second,
      );
    expect(await seconds({})).toEqual([4, 3, 2, 1, 0]);
    expect(await seconds({ from: new Date(BASE + 1000), to: new Date(BASE + 3000) })).toEqual([
      2, 1,
    ]);
    expect(await seconds({ from: new Date(BASE + 3000) })).toEqual([4, 3]);
    expect(await seconds({ to: new Date(BASE + 2000) })).toEqual([1, 0]);
    expect(await seconds({ from: new Date(BASE + 1000), to: new Date(BASE + 1000) })).toEqual([]);
    expect(await seconds({ from: "2026-06-01T12:00:02Z", to: "2026-06-01T12:00:03Z" })).toEqual([
      2,
    ]);
    // The same instant written in another zone.
    expect(
      await seconds({ from: "2026-06-01T14:00:02+02:00", to: "2026-06-01T07:00:03-05:00" }),
    ).toEqual([2]);
    expect(await seconds({ from: new Date(BASE + 10_000) })).toEqual([]);
    expect(written).toHaveLength(5);

    // Microsecond precision, which a JavaScript Date cannot express: ask the function directly.
    const [early, late] = await insertEvents([
      { at: at(20, 1), entityType },
      { at: at(20, 2), entityType },
    ]);
    const { rows } = await web().query<{ id: string }>(
      `SELECT id FROM list_events(p_entity_type => $1, p_from => $2::timestamptz, p_to => $3::timestamptz)`,
      [entityType, "2026-06-01T12:00:20.000002Z", "2026-06-01T12:00:20.000003Z"],
    );
    expect(rows.map((row) => row.id)).toEqual([late]);
    const exclusive = await web().query<{ id: string }>(
      `SELECT id FROM list_events(p_entity_type => $1, p_to => $2::timestamptz)
        WHERE id IN ($3, $4)`,
      [entityType, "2026-06-01T12:00:20.000002Z", early, late],
    );
    expect(exclusive.rows.map((row) => row.id)).toEqual([early]);
  });

  it("does not depend on the time zone of the session", async () => {
    const entityType = scope();
    await insertEvents([{ at: at(30), entityType }]);
    const client = await web().connect();
    try {
      for (const zone of ["UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
        await client.query(`SET TIME ZONE '${zone}'`);
        const { rows } = await client.query(
          "SELECT id FROM list_events(p_entity_type => $1, p_from => $2::timestamptz, p_to => $3::timestamptz)",
          [entityType, "2026-06-01T12:00:30Z", "2026-06-01T12:00:31Z"],
        );
        expect(rows).toHaveLength(1);
      }
    } finally {
      await client.query("RESET TIME ZONE");
      client.release();
    }
  });

  it("refuses a range that runs backwards, with an error that says so", async () => {
    const err = await rejectedWith(
      listEvents(web(), { from: "2026-06-02T00:00:00Z", to: "2026-06-01T00:00:00Z" }),
      ValidationError,
    );
    expect(err.field).toBe("from");
    expect(err.message).toContain("includes from and excludes to");
  });

  it("combines every filter with AND", async () => {
    const entityType = scope();
    const entityId = "00000000-0000-7000-8000-00000000f021";
    const token = "00000000-0000-7000-8000-00000000f0f2";
    const match = {
      actor: "combo",
      actorType: "agent",
      tokenId: token,
      action: "tool.call",
      entityType,
      entityId,
    } as const;
    const [hit] = await insertEvents([
      { ...match, at: at(100) },
      { ...match, at: at(100), actor: "other" },
      { ...match, at: at(100), actorType: "human", tokenId: null },
      { ...match, at: at(100), action: "insert" },
      { ...match, at: at(100), entityId: "00000000-0000-7000-8000-00000000f022" },
      { ...match, at: at(100), entityType: scope() },
      { ...match, at: at(200) },
      { ...match, at: at(50) },
    ]);
    const { events } = await listEvents(web(), {
      actor: "combo",
      actorType: "agent",
      entityType,
      entityId,
      actionPrefix: "tool.",
      from: new Date(BASE + 90_000),
      to: new Date(BASE + 110_000),
    });
    expect(ids(events)).toEqual([hit]);
  });

  it("answers an empty page, not an error, for values nothing matches", async () => {
    for (const input of [
      { entityType: "no_such_entity_type" },
      { actor: "nobody" },
      { entityId: "00000000-0000-7000-8000-000000000000" },
      { entityType: "x'; DROP TABLE events; --" },
      { entityType: "x".repeat(5000) },
      { actor: "\u{1F600}".repeat(300) },
      { from: new Date(Date.UTC(2999, 0, 1)) },
    ] satisfies ListEventsInput[]) {
      expect(await listEvents(web(), input)).toEqual({ events: [], nextCursor: null });
    }
    const { rows } = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM events");
    expect(rows[0]?.n).toBeGreaterThan(0); // the log is still there
  });

  it("refuses malformed filters with readable errors (never a driver error)", async () => {
    const actorType = await rejectedWith(
      listEvents(web(), { actorType: "robot" as never }),
      ValidationError,
    );
    expect(actorType.field).toBe("actor_type");
    expect(actorType.allowed).toEqual([...ACTOR_TYPES]);
    expect(
      (await rejectedWith(listEvents(web(), { entityId: "nope" }), ValidationError)).field,
    ).toBe("entity_id");
    expect(
      (await rejectedWith(listEvents(web(), { from: "2026-06-01T12:00:00" }), ValidationError))
        .field,
    ).toBe("from"); // no time zone
    expect(
      (await rejectedWith(listEvents(web(), { to: new Date(Number.NaN) }), ValidationError)).field,
    ).toBe("to");
    for (const field of ["actor", "entityType", "actionPrefix", "cursor"] as const) {
      await rejectedWith(
        listEvents(web(), { [field]: "a\u0000b" } as ListEventsInput),
        ValidationError,
      );
    }
    // The database says the same when it is called directly.
    expect(await sqlstate(web().query("SELECT * FROM list_events(p_actor_type => 'robot')"))).toBe(
      "YT001",
    );
    expect(
      await sqlstate(
        web().query("SELECT * FROM list_events(p_from => 'infinity', p_to => '-infinity')"),
      ),
    ).toBe("YT001");
  });
});

// ---------------------------------------------------------------------------------------------
describe("pagination", () => {
  it("walks the log newest first, every event exactly once, with no empty last page", async () => {
    const { entityType, written } = await tenEvents();
    const pages = await walk({ entityType, limit: 3 });
    expect(pages.map((page) => page.events.length)).toEqual([3, 3, 3, 1]);
    expect(pages.map((page) => page.nextCursor !== null)).toEqual([true, true, true, false]);
    expect(pages.flatMap((page) => ids(page.events))).toEqual(written.toReversed());
    // A page size that divides the total exactly ends on a full page without a cursor.
    const exact = await walk({ entityType, limit: 5 });
    expect(exact.map((page) => page.events.length)).toEqual([5, 5]);
    expect(exact.at(-1)?.nextCursor).toBeNull();
    const single = await walk({ entityType, limit: 10 });
    expect(single).toHaveLength(1);
    expect(single[0]?.nextCursor).toBeNull();
    const one = await walk({ entityType, limit: 1 });
    expect(one).toHaveLength(10);
  });

  it("gives opaque, URL-safe cursors and takes them from any role", async () => {
    const { entityType, written } = await tenEvents();
    const first = await listEvents(web(), { entityType, limit: 4 });
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{20,200}$/);
    const second = await listEvents(db.pool("ytw_mcp"), {
      entityType,
      limit: 4,
      cursor: first.nextCursor ?? "",
    });
    expect(ids(second.events)).toEqual(written.toReversed().slice(4, 8));
  });

  it("is stable while events arrive: nothing repeats, nothing is skipped, new events stay in front", async () => {
    const { entityType, written } = await tenEvents();
    const original = written.toReversed();
    const first = await listEvents(web(), { entityType, limit: 4 });
    expect(ids(first.events)).toEqual(original.slice(0, 4));
    // Three events arrive after the first page was read: they are newer than everything.
    const arrived = await insertEvents([
      { at: at(100), entityType },
      { at: at(101), entityType },
      { at: at(102), entityType },
    ]);
    const second = await listEvents(web(), {
      entityType,
      limit: 4,
      cursor: first.nextCursor ?? "",
    });
    expect(ids(second.events)).toEqual(original.slice(4, 8)); // not shifted by the newcomers
    const third = await listEvents(web(), {
      entityType,
      limit: 4,
      cursor: second.nextCursor ?? "",
    });
    expect(ids(third.events)).toEqual(original.slice(8));
    expect(third.nextCursor).toBeNull();
    // A new walk from the top sees them, newest first.
    expect(ids((await listEvents(web(), { entityType, limit: 3 })).events)).toEqual(
      arrived.toReversed(),
    );
  });

  it("shows an event that arrives behind the cursor when the walk gets there (a late committer)", async () => {
    const { entityType, written } = await tenEvents();
    const original = written.toReversed();
    const first = await listEvents(web(), { entityType, limit: 4 });
    // An event with a time between the 6th and 7th event of the original walk arrives late.
    const [late] = await insertEvents([{ at: at(3, 500_000), entityType }]);
    const rest = await walk({ entityType, limit: 4, cursor: first.nextCursor ?? "" });
    const seen = [...first.events, ...rest.flatMap((page) => page.events)];
    expect(new Set(ids(seen)).size).toBe(seen.length); // no repeats
    expect(ids(seen)).toEqual([...original.slice(0, 6), late, ...original.slice(6)]);
  });

  it("splits a group of events with the same time by id, also across a page boundary", async () => {
    const entityType = scope();
    const written = await insertEvents(
      Array.from({ length: 25 }, () => ({ at: at(0), entityType })),
    );
    const expected = written.toSorted().toReversed(); // id descending
    const pages = await walk({ entityType, limit: 10 });
    expect(pages.map((page) => page.events.length)).toEqual([10, 10, 5]);
    expect(pages.flatMap((page) => ids(page.events))).toEqual(expected);
    // An event of the same time but a smaller id than the cursor row still shows up; a larger one does not.
    const first = await listEvents(web(), { entityType, limit: 10 });
    const boundary = first.events.at(-1)?.id ?? "";
    const [smaller] = await insertEvents([
      {
        id: `${boundary.slice(0, -1)}${boundary.endsWith("0") ? "1" : "0"}`,
        at: at(0),
        entityType,
      },
    ]);
    expect(smaller).toBeDefined();
    const after = await walk({ entityType, limit: 10, cursor: first.nextCursor ?? "" });
    const tail = after.flatMap((page) => ids(page.events));
    expect(tail.includes(smaller as string)).toBe((smaller as string) < boundary);
    expect(new Set(tail).size).toBe(tail.length);
  });

  it("keeps the cursor exact to the microsecond when two events of a page boundary are 1 µs apart", async () => {
    const entityType = scope();
    const written = await insertEvents([
      { at: at(0, 1), entityType },
      { at: at(0, 2), entityType },
      { at: at(0, 3), entityType },
      { at: at(0, 4), entityType },
    ]);
    const pages = await walk({ entityType, limit: 2 });
    expect(pages.flatMap((page) => ids(page.events))).toEqual(written.toReversed());
    const odd = await walk({ entityType, limit: 1 });
    expect(odd.flatMap((page) => ids(page.events))).toEqual(written.toReversed());
  });

  it("continues under other filters from the same position when the caller changes them", async () => {
    const entityType = scope();
    await insertEvents(
      Array.from({ length: 8 }, (_, second) => ({
        at: at(second),
        entityType,
        actor: second % 2 === 0 ? "even" : "odd",
        payload: { second },
      })),
    );
    const first = await listEvents(web(), { entityType, limit: 3 }); // 7, 6, 5
    const evens = await listEvents(web(), {
      entityType,
      actor: "even",
      cursor: first.nextCursor ?? "",
    });
    expect(evens.events.map((event) => event.payload.second)).toEqual([4, 2, 0]);
  });

  it("walks a filtered feed with the same guarantees", async () => {
    const entityType = scope();
    const mine = await insertEvents(
      Array.from({ length: 7 }, (_, second) => ({
        at: at(second * 2),
        entityType,
        actor: "walker",
      })),
    );
    await insertEvents(
      Array.from({ length: 7 }, (_, second) => ({
        at: at(second * 2 + 1),
        entityType,
        actor: "other",
      })),
    );
    const pages = await walk({ entityType, actor: "walker", limit: 3 });
    expect(pages.flatMap((page) => ids(page.events))).toEqual(mine.toReversed());
  });

  it("starts at the top for no cursor, NULL and the empty string", async () => {
    const { entityType, written } = await tenEvents();
    const top = ids((await listEvents(web(), { entityType, limit: 2 })).events);
    expect(top).toEqual(written.toReversed().slice(0, 2));
    expect(ids((await listEvents(web(), { entityType, limit: 2, cursor: "" })).events)).toEqual(
      top,
    );
    const { rows } = await web().query<{ id: string }>(
      "SELECT id FROM list_events(p_entity_type => $1, p_limit => 2, p_cursor => NULL)",
      [entityType],
    );
    expect(rows.map((row) => row.id)).toEqual(top);
  });
});

// ---------------------------------------------------------------------------------------------
describe("hostile cursors", () => {
  const uuid = "00000000-0000-7000-8000-00000000f0aa";

  const hostile: Record<string, string> = {
    garbage: "garbage!!",
    "valid base64, wrong content": encode("foo"),
    "right shape, wrong version": encode(`v2|2026-06-01T12:00:00.000000Z|${uuid}`),
    "month 13": encode(`v1|2026-13-01T12:00:00.000000Z|${uuid}`),
    "day 99": encode(`v1|2026-06-99T12:00:00.000000Z|${uuid}`),
    "hour 25": encode(`v1|2026-06-01T25:00:00.000000Z|${uuid}`),
    "no microseconds": encode(`v1|2026-06-01T12:00:00Z|${uuid}`),
    "no zone": encode(`v1|2026-06-01T12:00:00.000000|${uuid}`),
    "short uuid": encode("v1|2026-06-01T12:00:00.000000Z|0000"),
    "upper case uuid": encode(`v1|2026-06-01T12:00:00.000000Z|${uuid.toUpperCase()}`),
    "extra part": encode(`v1|2026-06-01T12:00:00.000000Z|${uuid}|more`),
    "sql in the time": encode(`v1|2026-06-01'; DROP TABLE events; --|${uuid}`),
    padded: `${encode(`v1|2026-06-01T12:00:00.000000Z|${uuid}`)}==`,
    "standard base64 alphabet": "ab+/cd==",
    "a space": "abcd efgh",
    "very long": "A".repeat(100_000),
    "just over the limit": "A".repeat(201),
    unicode: "日本語",
    "sql injection": "'; DROP TABLE events; --",
    "a single character": "A",
    "a newline": `${encode(`v1|2026-06-01T12:00:00.000000Z|${uuid}`)}\n`,
  };

  for (const [name, cursor] of Object.entries(hostile)) {
    it(`is a validation error about the cursor, not a driver error: ${name}`, async () => {
      const err = await rejectedWith(listEvents(web(), { cursor }), ValidationError);
      expect(err.field).toBe("cursor");
      expect(err.message).toContain("cursor");
      // And straight through the function, for a service that skipped the wrapper.
      expect(
        await sqlstate(web().query("SELECT * FROM list_events(p_cursor => $1)", [cursor])),
      ).toBe("YT001");
    });
  }

  it("accepts a well-formed cursor that someone made up, and just continues from that position", async () => {
    const entityType = scope();
    const written = await insertEvents([
      { at: at(1), entityType },
      { at: at(2), entityType },
      { at: at(3), entityType },
    ]);
    const handmade = encode(`v1|${at(3)}|ffffffff-ffff-7fff-bfff-ffffffffffff`); // after the third event, any id
    expect(ids((await listEvents(web(), { entityType, cursor: handmade })).events)).toEqual([
      written[2],
      written[1],
      written[0],
    ]);
    const older = encode(`v1|${at(2)}|00000000-0000-7000-8000-000000000000`); // before the second event
    expect(ids((await listEvents(web(), { entityType, cursor: older })).events)).toEqual([
      written[0],
    ]);
    const future = encode(`v1|2999-01-01T00:00:00.000000Z|${uuid}`);
    expect((await listEvents(web(), { entityType, cursor: future })).events).toHaveLength(3);
    const past = encode(`v1|1970-01-01T00:00:00.000000Z|${uuid}`);
    expect((await listEvents(web(), { entityType, cursor: past })).events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the limit", () => {
  it("defaults to 50 and stops at 100", async () => {
    const entityType = scope();
    await insertEvents(
      Array.from({ length: 120 }, (_, second) => ({ at: at(second), entityType })),
    );
    const byDefault = await listEvents(web(), { entityType });
    expect(byDefault.events).toHaveLength(EVENTS_LIMIT_DEFAULT);
    expect(byDefault.nextCursor).not.toBeNull();
    const biggest = await listEvents(web(), { entityType, limit: EVENTS_LIMIT_MAX });
    expect(biggest.events).toHaveLength(EVENTS_LIMIT_MAX);
    expect((await listEvents(web(), { entityType, limit: 1 })).events).toHaveLength(1);
    const pages = await walk({ entityType, limit: EVENTS_LIMIT_MAX });
    expect(pages.map((page) => page.events.length)).toEqual([100, 20]);
  });

  it("refuses limits outside 1 to 100 and names the range", async () => {
    for (const limit of [0, -1, 101, 1000, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = await rejectedWith(listEvents(web(), { limit }), ValidationError);
      expect(err.field).toBe("limit");
      expect(err.message).toContain("1 to 100");
    }
    const failure = await web()
      .query("SELECT * FROM list_events(p_limit => 101)")
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "YT001" });
    expect(JSON.parse((failure as { detail: string }).detail)).toMatchObject({
      field: "limit",
      value: 101,
      min: 1,
      max: EVENTS_LIMIT_MAX,
    });
    expect(await sqlstate(web().query("SELECT * FROM list_events(p_limit => 0)"))).toBe("YT001");
    expect(
      (await web().query("SELECT * FROM list_events(p_limit => NULL)")).rows.length,
    ).toBeLessThanOrEqual(EVENTS_LIMIT_DEFAULT);
  });
});

// ---------------------------------------------------------------------------------------------
describe("privileges and the caller's own rights", () => {
  it("is executable by ytw_web and ytw_mcp only, and is a pinned, stable, invoker function", async () => {
    const [entry] = Object.values(await functionPrivileges(db, "list_events"));
    expect(entry).toMatchObject({
      roles: ["ytw_mcp", "ytw_web"],
      publicExecute: false,
      definer: false,
      searchPath: "search_path=pg_catalog, public, pg_temp",
    });
    const { rows } = await db.admin.query<{ volatility: string; config: string[] }>(
      "SELECT provolatile AS volatility, proconfig AS config FROM pg_proc WHERE proname = 'list_events'",
    );
    expect(rows[0]?.volatility).toBe("s");
    expect(rows[0]?.config).toContain("plan_cache_mode=force_custom_plan");
    expect(await sqlstate(db.pool("ytw_readonly").query("SELECT * FROM list_events()"))).toBe(
      "42501",
    );
  });

  it("runs with the caller's rights: no SELECT on events, no feed", async () => {
    for (const role of ["ytw_web", "ytw_mcp"] as const) {
      const run = () => listEvents(db.pool(role), { limit: 1 });
      expect((await run()).events).toHaveLength(1);
      await db.admin.query(`REVOKE SELECT ON public.events FROM ${role}`);
      try {
        const err = await run().catch((error: unknown) => error);
        expect(err).toMatchObject({ code: "42501" });
      } finally {
        await db.admin.query(`GRANT SELECT ON public.events TO ${role}`);
      }
      expect((await run()).events).toHaveLength(1);
    }
  });

  it("only reads: it works in a read-only transaction and writes no event of its own", async () => {
    const before = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM events");
    const client = await web().connect();
    try {
      await client.query("BEGIN READ ONLY");
      const { rows } = await client.query("SELECT * FROM list_events(p_limit => 5)");
      expect(rows.length).toBeLessThanOrEqual(5);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    await listEvents(web(), { limit: 5 });
    const after = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM events");
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("accepts NULL for every argument (all are optional filters)", async () => {
    const spec: FunctionSpec = {
      name: "list_events",
      types: [
        "text",
        "text",
        "text",
        "uuid",
        "text",
        "timestamptz",
        "timestamptz",
        "integer",
        "text",
      ],
      valid: () =>
        Promise.resolve([
          "alice",
          "human",
          "idea",
          "00000000-0000-7000-8000-000000000001",
          "insert",
          "2026-01-01T00:00:00Z",
          "2027-01-01T00:00:00Z",
          10,
          null,
        ]),
      optional: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    };
    const outcomes = await nullArgumentOutcomes(db, spec);
    expect(outcomes).toEqual(expectedNullOutcomes(spec));
    expect(Object.values(outcomes).every((outcome) => outcome === "ok")).toBe(true);
  });

  it("is not callable by ytw_readonly or PUBLIC (checked against the grants themselves)", async () => {
    const { rows } = await db.admin.query<{ role: string; allowed: boolean }>(
      `SELECT r AS role,
              has_function_privilege(r, 'public.list_events(text, text, text, uuid, text, timestamptz, timestamptz, integer, text)', 'EXECUTE') AS allowed
         FROM unnest(ARRAY['ytw_web', 'ytw_mcp', 'ytw_readonly']) AS r`,
    );
    expect(Object.fromEntries(rows.map((row) => [row.role, row.allowed]))).toEqual({
      ytw_web: true,
      ytw_mcp: true,
      ytw_readonly: false,
    });
  });
});
