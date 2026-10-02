// Helpers shared by the tests of the idea, script and note functions (T12). Not a test file.
import { randomBytes, randomUUID } from "node:crypto";
import type { IdeaStage } from "@ytw/shared/constants";
import type { Pool } from "pg";
import { withActor, type Actor, type ActorTx, type AppRole } from "../src/client.js";
import { createIdea, getIdea, type CreateIdeaInput, type IdeaRecord } from "../src/ideas.js";
import type { TestDb } from "../src/testing.js";

/** A person: acts through the web server's role. */
export const alice: Actor = { name: "alice", type: "human" };

/** An agent with its own (random) token id: acts through the MCP server's role. */
export function newAgent(name = `agent-${unique()}`): Actor & { tokenId: string } {
  // Generated at run time: a literal id next to a "token" key reads as a credential to the secret scan.
  return { name, type: "agent", tokenId: randomUUID() };
}

export const unique = (): string => randomBytes(4).toString("hex");

/**
 * Lets the clock move on. Timestamps come from `now()` with microsecond precision but JavaScript
 * dates have milliseconds, so two quick transactions could otherwise look simultaneous.
 */
export const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Splits the outcomes of `Promise.allSettled` into the values and the failures. */
export function partition<T>(results: PromiseSettledResult<T>[]): { ok: T[]; failed: unknown[] } {
  const ok: T[] = [];
  const failed: unknown[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      ok.push(result.value);
    } else {
      failed.push(result.reason);
    }
  }
  return { ok, failed };
}

/** The pool an actor's calls go through: people use the web role, agents the MCP role. */
export function poolFor(db: TestDb, actor: Actor): Pool {
  return db.pool(actor.type === "human" ? "ytw_web" : "ytw_mcp");
}

/** Runs `fn` in a transaction of the actor's own application role (as the services do). */
export function act<T>(db: TestDb, actor: Actor, fn: (tx: ActorTx) => Promise<T>): Promise<T> {
  return withActor(poolFor(db, actor), actor, fn);
}

/** Creates an idea through the real function. */
export function newIdea(
  db: TestDb,
  input: Partial<CreateIdeaInput> = {},
  actor: Actor = alice,
): Promise<IdeaRecord> {
  return act(db, actor, (tx) => createIdea(tx, { title: `Idea ${unique()}`, ...input }));
}

/**
 * Puts an idea straight into `stage` with the superuser (a fixture: the stage rules are what the
 * tests exercise, so they cannot be used to set the scene).
 */
export async function setStageDirectly(
  db: TestDb,
  ideaId: string,
  stage: IdeaStage,
): Promise<IdeaRecord> {
  await withActor(db.admin, { name: "fixture", type: "human" }, (tx) =>
    tx.query("UPDATE ideas SET status = $2 WHERE id = $1", [ideaId, stage]),
  );
  const idea = await getIdea(db.admin, ideaId);
  if (idea === null) {
    throw new Error(`idea ${ideaId} vanished`);
  }
  return idea;
}

/** An idea in `stage`, made through create_idea and moved there by the fixture. */
export async function ideaInStage(db: TestDb, stage: IdeaStage): Promise<IdeaRecord> {
  const idea = await newIdea(db);
  return stage === "inbox" ? idea : setStageDirectly(db, idea.id, stage);
}

/** A video row (the T13 functions do not exist yet), for notes on videos. */
export async function insertVideo(db: TestDb, ideaId: string | null = null): Promise<string> {
  return withActor(db.admin, { name: "fixture", type: "human" }, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO videos (idea_id, youtube_id, title) VALUES ($1, $2, 'A video') RETURNING id",
      [ideaId, randomBytes(8).toString("base64url")],
    );
    return rows[0]?.id as string;
  });
}

/** An experiment row on a new video, for notes on experiments. */
export async function insertExperiment(db: TestDb): Promise<string> {
  const videoId = await insertVideo(db);
  return withActor(db.admin, { name: "fixture", type: "human" }, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO experiments (video_id, type) VALUES ($1, 'title') RETURNING id",
      [videoId],
    );
    return rows[0]?.id as string;
  });
}

export interface EventRow {
  actor: string;
  actor_type: string;
  token_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: { old?: Record<string, unknown>; new?: Record<string, unknown> };
}

/** The audit rows of one entity, oldest first. */
export async function eventsFor(db: TestDb, entityId: string): Promise<EventRow[]> {
  const { rows } = await db.admin.query<EventRow>(
    `SELECT actor, actor_type, token_id, action, entity_type, entity_id, payload
       FROM events WHERE entity_id = $1 ORDER BY created_at, id`,
    [entityId],
  );
  return rows;
}

/** How many audit rows exist for the entity. */
export async function eventCount(db: TestDb, entityId: string): Promise<number> {
  return (await eventsFor(db, entityId)).length;
}

export interface FunctionPrivileges {
  /** Application roles that can execute the function (directly granted or through PUBLIC). */
  roles: string[];
  /** EXECUTE granted to PUBLIC, explicitly or through a missing ACL. */
  publicExecute: boolean;
  definer: boolean;
  /** `search_path=...` setting, if any. */
  searchPath: string | undefined;
}

/** Who may execute the function(s) called `name` in schema public (all overloads). */
export async function functionPrivileges(
  db: TestDb,
  name: string,
): Promise<Record<string, FunctionPrivileges>> {
  const roles: readonly AppRole[] = ["ytw_web", "ytw_mcp", "ytw_readonly"];
  const { rows } = await db.admin.query<{
    signature: string;
    roles: string[];
    public_execute: boolean;
    definer: boolean;
    config: string[] | null;
  }>(
    `SELECT p.oid::regprocedure::text AS signature,
            coalesce((SELECT array_agg(r ORDER BY r) FROM unnest($2::text[]) AS r
                       WHERE has_function_privilege(r, p.oid, 'EXECUTE')), '{}') AS roles,
            p.proacl IS NULL
              OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_execute,
            p.prosecdef AS definer,
            p.proconfig AS config
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
    [name, roles],
  );
  if (rows.length === 0) {
    throw new Error(`no function public.${name}`);
  }
  return Object.fromEntries(
    rows.map((row) => [
      row.signature,
      {
        roles: row.roles,
        publicExecute: row.public_execute,
        definer: row.definer,
        searchPath: row.config?.find((setting) => setting.startsWith("search_path=")),
      },
    ]),
  );
}

/** Waits until some backend is blocked on a lock while running a statement that contains `text`. */
export async function waitForLockWait(db: TestDb, text: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.admin.query<{ blocked: number }>(
      `SELECT count(*)::int AS blocked FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND pid <> pg_backend_pid() AND query LIKE '%' || $1 || '%'`,
      [text],
    );
    if ((rows[0]?.blocked ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`no backend ever blocked on a lock while running "${text}"`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Runs `run` with the named functions replaced by copies that do not lock the idea row, then puts
 * the originals back. It proves the second line of defence of the write functions (the version
 * predicate of the UPDATE, the unique key of the script versions) on its own. The superuser
 * replaces them in place, so owner and grants stay as they were.
 */
export async function withoutRowLock<T>(
  db: TestDb,
  names: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const originals: string[] = [];
  const copies: string[] = [];
  for (const name of names) {
    const { rows } = await db.admin.query<{ def: string }>(
      `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
      [name],
    );
    const def = rows[0]?.def ?? "";
    const copy = def.replaceAll(" FOR NO KEY UPDATE;", ";");
    if (def === "" || copy === def || copy.includes("FOR NO KEY UPDATE")) {
      throw new Error(`could not build a lock-free copy of ${name}`);
    }
    originals.push(def);
    copies.push(copy);
  }
  try {
    for (const copy of copies) {
      await db.admin.query(copy);
    }
    return await run();
  } finally {
    for (const original of originals) {
      await db.admin.query(original);
    }
  }
}

/** A small seeded random number generator (mulberry32), so a failing random walk can be replayed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The result of a call that may fail, as data, so a test can assert on it without branching. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

/** `"moved"`-style label of an outcome: `ok` for a success, the database error kind otherwise. */
export function outcomeKind<T>(outcome: Settled<T>, ok = "ok"): string {
  if (outcome.ok) {
    return ok;
  }
  const kind: unknown = Reflect.get(outcome.error as object, "kind");
  return typeof kind === "string" ? kind : `not a database error: ${String(outcome.error)}`;
}
