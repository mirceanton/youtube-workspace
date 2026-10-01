// Audit infrastructure (PRD 4 "events", PRD 5 "functions take the actor and write it to events"):
// ytw_set_actor, the ytw_audit() trigger, ytw_log_event, append-only enforcement and withActor.
// The business tables arrive with T11, so a fixture table and fixture functions written exactly
// like the convention in docs/database.md stand in for them here.
import { randomUUID } from "node:crypto";
import { ACTOR_TYPES } from "@ytw/shared/constants";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVENT_PAYLOAD_MAX_BYTES, sql, withActor, type Actor } from "../src/client.js";
import { ImmutableError, MissingActorError, ValidationError, toDbError } from "../src/errors.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { failure, sqlstate } from "./helpers.js";

let db: TestDb;

const FIXTURE = `
CREATE TABLE public.widgets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  name text NOT NULL,
  api_key_hash text,
  private_note text,
  body text,
  last_used_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT ytw_current_actor(),
  search_text tsvector GENERATED ALWAYS AS (to_tsvector('simple', name)) STORED
);
CREATE TRIGGER widgets_audit AFTER INSERT OR UPDATE OR DELETE ON public.widgets
  FOR EACH ROW EXECUTE FUNCTION ytw_audit('widget', 'private_note', '-search_text');
GRANT SELECT ON public.widgets TO ytw_web, ytw_mcp, ytw_readonly;

CREATE FUNCTION public.save_widget(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_id uuid, p_name text, p_key_hash text, p_note text, p_body text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM ytw_set_actor(p_actor, p_actor_type, p_token_id);
  IF p_id IS NULL THEN
    INSERT INTO widgets (name, api_key_hash, private_note, body)
    VALUES (p_name, p_key_hash, p_note, p_body) RETURNING id INTO v_id;
  ELSE
    UPDATE widgets SET name = p_name, api_key_hash = p_key_hash, private_note = p_note,
                       body = p_body, updated_at = now()
     WHERE id = p_id RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.save_widget(text, text, uuid, uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_widget(text, text, uuid, uuid, text, text, text, text) TO ytw_web, ytw_mcp;

CREATE FUNCTION public.touch_widget(p_actor text, p_actor_type text, p_token_id uuid, p_id uuid, p_rename text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM ytw_set_actor(p_actor, p_actor_type, p_token_id);
  UPDATE widgets SET last_used_at = clock_timestamp(), updated_at = now(),
                     name = coalesce(p_rename, name)
   WHERE id = p_id;
END $$;
REVOKE ALL ON FUNCTION public.touch_widget(text, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_widget(text, text, uuid, uuid, text) TO ytw_web, ytw_mcp;

CREATE FUNCTION public.remove_widget(p_actor text, p_actor_type text, p_token_id uuid, p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM ytw_set_actor(p_actor, p_actor_type, p_token_id);
  DELETE FROM widgets WHERE id = p_id;
END $$;
REVOKE ALL ON FUNCTION public.remove_widget(text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_widget(text, text, uuid, uuid) TO ytw_web;

-- Breaks the convention on purpose: writes without calling ytw_set_actor.
CREATE FUNCTION public.careless_insert(p_name text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$ INSERT INTO widgets (name, created_by) VALUES (p_name, 'nobody') $$;
REVOKE ALL ON FUNCTION public.careless_insert(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.careless_insert(text) TO ytw_web;

CREATE TABLE public.ledger (id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), amount int NOT NULL);
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON public.ledger
  FOR EACH ROW EXECUTE FUNCTION ytw_append_only();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON public.ledger
  FOR EACH STATEMENT EXECUTE FUNCTION ytw_append_only();
`;

const alice: Actor = { name: "alice", type: "human" };
// Generated at run time: a literal id next to a "token" key reads as a credential to the secret scan.
const agent: Actor = { name: "research agent", type: "agent", tokenId: randomUUID() };

interface EventRow {
  actor: string;
  actor_type: string;
  token_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, Record<string, unknown>>;
}

async function eventsFor(entityId: string): Promise<EventRow[]> {
  const { rows } = await db.admin.query<EventRow>(
    `SELECT actor, actor_type, token_id, action, entity_type, entity_id, payload
       FROM events WHERE entity_id = $1 ORDER BY id`,
    [entityId],
  );
  return rows;
}

async function eventCount(): Promise<number> {
  const { rows } = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM events");
  return rows[0]?.n ?? -1;
}

function saveWidget(
  actor: Actor,
  fields: { id?: string; name: string; keyHash?: string; note?: string; body?: string },
) {
  return withActor(db.pool(actor.type === "human" ? "ytw_web" : "ytw_mcp"), actor, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      sql`SELECT save_widget(${tx.actor.name}, ${tx.actor.type}, ${tx.actor.tokenId},
                             ${fields.id ?? null}, ${fields.name}, ${fields.keyHash ?? null},
                             ${fields.note ?? null}, ${fields.body ?? null}) AS id`,
    );
    return rows[0]?.id as string;
  });
}

beforeAll(async () => {
  db = await createTestDb();
  await db.admin.query(FIXTURE);
});

afterAll(async () => {
  await db.drop();
});

describe("ytw_audit trigger", () => {
  it("logs an insert with the caller's actor, redacting secrets", async () => {
    const id = await saveWidget(alice, { name: "first", keyHash: "abc123", note: "do not share" });

    const events = await eventsFor(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "alice",
      actor_type: "human",
      token_id: null,
      action: "insert",
      entity_type: "widget",
      entity_id: id,
    });
    expect(events[0]?.payload.new).toMatchObject({
      id,
      name: "first",
      api_key_hash: "[redacted]",
      private_note: "[redacted]",
      created_by: "alice",
    });
    expect(JSON.stringify(events)).not.toContain("abc123");
    expect(JSON.stringify(events)).not.toContain("do not share");
    // '-search_text' leaves the generated column out entirely.
    expect(events[0]?.payload.new).not.toHaveProperty("search_text");
  });

  it("logs an agent's update with its token id and only the changed columns", async () => {
    const id = await saveWidget(alice, { name: "before", note: "n" });
    await saveWidget(agent, { id, name: "after", note: "n" });

    const update = (await eventsFor(id)).find((event) => event.action === "update");
    expect(update).toMatchObject({
      actor: "research agent",
      actor_type: "agent",
      token_id: agent.tokenId,
      entity_id: id,
    });
    // updated_at changes on every update and is not reported as a change; neither is the omitted
    // search_text, although renaming changed it too.
    expect(update?.payload).toEqual({ old: { name: "before" }, new: { name: "after" } });
  });

  it("logs a delete with the removed row, scrubbed the same way", async () => {
    const id = await saveWidget(alice, { name: "doomed", keyHash: "k-123", note: "secret note" });
    await withActor(db.pool("ytw_web"), alice, (tx) =>
      tx.query(sql`SELECT remove_widget(${alice.name}, 'human', NULL, ${id})`),
    );
    const removal = (await eventsFor(id)).find((event) => event.action === "delete");
    expect(removal).toMatchObject({ actor: "alice", entity_type: "widget", entity_id: id });
    expect(removal?.payload).toEqual({
      old: expect.objectContaining({
        id,
        name: "doomed",
        api_key_hash: "[redacted]",
        private_note: "[redacted]",
      }),
    });
    expect(removal?.payload.old).not.toHaveProperty("search_text");
  });

  it("summarises large values instead of copying them into the log", async () => {
    const body = "x".repeat(20_000);
    const id = await saveWidget(alice, { name: "big", body });
    const [insert] = await eventsFor(id);
    expect(insert?.payload.new?.body).toEqual({ omitted: "too_large", bytes: 20_000 });
  });

  it("skips updates that only touch last_used_at, but not updates that also change data", async () => {
    const id = await saveWidget(alice, { name: "token-like" });
    const before = (await eventsFor(id)).length;

    await withActor(db.pool("ytw_mcp"), agent, (tx) =>
      tx.query(
        sql`SELECT touch_widget(${agent.name}, ${agent.type}, ${agent.tokenId}, ${id}, NULL)`,
      ),
    );
    expect(await eventsFor(id)).toHaveLength(before);

    await withActor(db.pool("ytw_mcp"), agent, (tx) =>
      tx.query(
        sql`SELECT touch_widget(${agent.name}, ${agent.type}, ${agent.tokenId}, ${id}, 'renamed')`,
      ),
    );
    const events = await eventsFor(id);
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)?.payload.new).toMatchObject({ name: "renamed" });
  });

  it("refuses writes without an actor, leaving neither a row nor an event", async () => {
    const before = await eventCount();
    const err = toDbError(
      await failure(db.pool("ytw_web").query("SELECT careless_insert('orphan')")),
    );
    expect(err).toBeInstanceOf(MissingActorError);
    expect((err as MissingActorError).message).toMatch(/call ytw_set_actor/);
    const rows = await db.admin.query("SELECT 1 FROM widgets WHERE name = 'orphan'");
    expect(rows.rowCount).toBe(0);
    expect(await eventCount()).toBe(before);
  });

  it("falls back to the transaction actor that withActor sets", async () => {
    await withActor(db.pool("ytw_web"), alice, (tx) =>
      tx.query("SELECT careless_insert('adopted')"),
    );
    const { rows } = await db.admin.query<{ id: string }>(
      "SELECT id FROM widgets WHERE name = 'adopted'",
    );
    const [insert] = await eventsFor(rows[0]?.id as string);
    expect(insert).toMatchObject({ actor: "alice", actor_type: "human", action: "insert" });
  });

  it("logs nothing for a transaction that rolls back", async () => {
    const before = await eventCount();
    const err = await failure(
      withActor(db.pool("ytw_web"), alice, async (tx) => {
        await tx.query(
          sql`SELECT save_widget(${alice.name}, 'human', NULL, NULL, 'ghost', NULL, NULL, NULL)`,
        );
        throw new Error("changed my mind");
      }),
    );
    expect(err.message).toBe("changed my mind");
    expect(await eventCount()).toBe(before);
    expect((await db.admin.query("SELECT 1 FROM widgets WHERE name = 'ghost'")).rowCount).toBe(0);
  });

  it("refuses to run as a BEFORE trigger, which would silently drop rows", async () => {
    await db.admin.query(`
      CREATE TABLE public.misattached (id uuid PRIMARY KEY DEFAULT uuid_generate_v7());
      CREATE TRIGGER misattached_audit BEFORE INSERT ON public.misattached
        FOR EACH ROW EXECUTE FUNCTION ytw_audit();`);
    const err = await failure(
      withActor(db.admin, alice, (tx) => tx.query("INSERT INTO misattached DEFAULT VALUES")),
    );
    expect(err.message).toMatch(/must be attached AFTER INSERT OR UPDATE/);
  });
});

describe("events", () => {
  it("cannot be updated, deleted or truncated, not even by the owner", async () => {
    await saveWidget(alice, { name: "evidence" });
    const admin = db.admin;
    for (const statement of [
      "UPDATE events SET actor = 'someone else'",
      "DELETE FROM events",
      "TRUNCATE events",
    ]) {
      const err = toDbError(await failure(admin.query(statement)));
      expect({ statement, err }).toMatchObject({ statement, err: expect.any(ImmutableError) });
      expect((err as ImmutableError).message).toMatch(/events is append-only/);
    }
    expect(await eventCount()).toBeGreaterThan(0);
  });

  it("allow exactly the actor types of @ytw/shared", async () => {
    const { rows } = await db.admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.events'::regclass AND conname = 'events_actor_type_check'`,
    );
    const values = [...(rows[0]?.def ?? "").matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]);
    expect(values.toSorted()).toEqual(ACTOR_TYPES.toSorted());

    const err = await failure(db.pool("ytw_web").query("SELECT ytw_set_actor('x', 'robot', NULL)"));
    const typed = toDbError(err) as ValidationError;
    expect(typed).toBeInstanceOf(ValidationError);
    expect(typed.allowed?.toSorted()).toEqual(ACTOR_TYPES.toSorted());
  });
});

describe("ytw_set_actor", () => {
  const cases: [string, string, string | null, string][] = [
    ["", "human", null, "actor is required"],
    ["   ", "agent", null, "actor is required"],
    ["a".repeat(201), "human", null, "at most 200 characters"],
    ["bell\u0007", "human", null, "no control characters"],
    ["alice", "robot", null, 'valid values: "human", "agent"'],
    ["alice", "human", "01890a5d-ac96-774b-bcce-b302099a8057", "token_id must be NULL"],
  ];

  it.each(cases)("rejects actor %j / %s / %s", async (actor, type, token, message) => {
    const err = toDbError(
      await failure(
        db.pool("ytw_web").query("SELECT ytw_set_actor($1, $2, $3)", [actor, type, token]),
      ),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toContain(message);
  });

  it("is not available to ytw_readonly", async () => {
    expect(
      await sqlstate(db.pool("ytw_readonly").query("SELECT ytw_set_actor('x', 'human', NULL)")),
    ).toBe("42501");
  });
});

describe("ytw_log_event", () => {
  it("records non-row events such as MCP tool calls", async () => {
    const entityId = "01890a5d-ac96-774b-bcce-b302099a8058";
    const { rows } = await db
      .pool("ytw_mcp")
      .query<{ id: string }>("SELECT ytw_log_event($1, $2, $3, $4, $5, $6, $7) AS id", [
        agent.name,
        "agent",
        agent.tokenId,
        "tool.call",
        "idea",
        entityId,
        { tool: "create_idea", outcome: "denied" },
      ]);
    expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    const [event] = await eventsFor(entityId);
    expect(event).toEqual({
      actor: "research agent",
      actor_type: "agent",
      token_id: agent.tokenId,
      action: "tool.call",
      entity_type: "idea",
      entity_id: entityId,
      payload: { tool: "create_idea", outcome: "denied" },
    });
  });

  it("accepts a login without an entity", async () => {
    const { rows } = await db
      .pool("ytw_web")
      .query<{ id: string }>(
        "SELECT ytw_log_event('alice', 'human', NULL, 'auth.login', NULL, NULL, '{}') AS id",
      );
    const stored = await db.admin.query(
      "SELECT actor, action, entity_type, entity_id, payload FROM events WHERE id = $1",
      [rows[0]?.id],
    );
    expect(stored.rows).toEqual([
      { actor: "alice", action: "auth.login", entity_type: null, entity_id: null, payload: {} },
    ]);
  });

  const bad: [string, unknown[], string][] = [
    ["a row-change action", ["insert", null, null, {}], "dotted lower-case name"],
    ["an upper-case action", ["Tool.Call", null, null, {}], "dotted lower-case name"],
    ["a bad entity type", ["tool.call", "Idea", null, {}], "entity_type"],
    [
      "an entity id without a type",
      ["tool.call", null, "01890a5d-ac96-774b-bcce-b302099a8059", {}],
      "entity_type is required",
    ],
    ["a non-object payload", ["tool.call", null, null, [1, 2]], "must be a JSON object"],
    [
      "an oversized payload",
      ["tool.call", null, null, { blob: "y".repeat(EVENT_PAYLOAD_MAX_BYTES) }],
      `the limit is ${EVENT_PAYLOAD_MAX_BYTES}`,
    ],
  ];

  it.each(bad)("rejects %s", async (_label, args, message) => {
    const [action, entityType, entityId, payload] = args;
    const err = toDbError(
      await failure(
        db
          .pool("ytw_mcp")
          .query("SELECT ytw_log_event('bot', 'agent', NULL, $1, $2, $3, $4::jsonb)", [
            action,
            entityType,
            entityId,
            JSON.stringify(payload),
          ]),
      ),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toContain(message);
  });

  it("is not available to ytw_readonly", async () => {
    expect(
      await sqlstate(
        db
          .pool("ytw_readonly")
          .query("SELECT ytw_log_event('x', 'human', NULL, 'auth.login', NULL, NULL, '{}')"),
      ),
    ).toBe("42501");
  });
});

describe("ytw_append_only", () => {
  it("guards any table it is attached to", async () => {
    await db.admin.query("INSERT INTO ledger (amount) VALUES (1)");
    for (const statement of [
      "UPDATE ledger SET amount = 2",
      "DELETE FROM ledger",
      "TRUNCATE ledger",
    ]) {
      const err = toDbError(await failure(db.admin.query(statement)));
      expect({ statement, err }).toMatchObject({ statement, err: expect.any(ImmutableError) });
      expect((err as ImmutableError).details).toMatchObject({ table: "ledger" });
    }
  });
});

describe("withActor", () => {
  it("commits the callback's work and returns its result", async () => {
    const id = await saveWidget(alice, { name: "committed" });
    expect((await db.admin.query("SELECT 1 FROM widgets WHERE id = $1", [id])).rowCount).toBe(1);
  });

  it("rejects an unknown actor type before touching the database", async () => {
    const err = await failure(
      withActor(db.pool("ytw_web"), { name: "x", type: "robot" as Actor["type"] }, async () => 1),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/valid values: "human", "agent"/);
  });

  it("surfaces database validation errors as typed errors", async () => {
    const err = await failure(
      withActor(db.pool("ytw_web"), { name: " ", type: "human" }, async () => 1),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).field).toBe("actor");
  });

  it("refuses queries after the transaction has finished", async () => {
    let leaked: { query: (q: string) => Promise<unknown> } | undefined;
    await withActor(db.pool("ytw_web"), alice, async (tx) => {
      leaked = tx;
    });
    const err = await failure(
      (leaked as { query: (q: string) => Promise<unknown> }).query("SELECT 1"),
    );
    expect(err.message).toMatch(/already finished/);
  });
});
