// The T11 schema (migrations 0010-0018): PRD 4 tables and integrity rules, the PRD 7 access tables,
// web_sessions, and their agreement with the @ytw/shared constants.
//
// Covered here: placement (public / ytw_private), uuid primary keys, bookkeeping columns, every
// CHECK and its @ytw/shared source, uniques, ON DELETE RESTRICT, the deferrable winner key,
// append-only scripts and video_metrics, ytw_touch() (version, updated_*, status_changed_at,
// immutable identity columns), notes targets, full-text vectors and indexes, privileges of every
// application role, and one audit row per insert and update on every business table.
//
// The SECURITY DEFINER write functions arrive with T12-T14, so rows are written here with the
// superuser pool inside withActor (docs/database.md, "Test harness"); the application roles are
// used only to prove what they cannot do.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ACTOR_TYPES,
  EXPERIMENT_STATUSES,
  EXPERIMENT_TYPES,
  GRANTABLE_LEVELS,
  IDEA_STAGES,
  LEVELS,
  NOTE_ENTITY_TYPES,
  RESOURCES,
  SCRIPT_BODY_MAX_BYTES,
  SCRIPT_KINDS,
  SCRIPT_STATUSES,
} from "@ytw/shared/constants";
import { NOTE_BODY_MAX_BYTES } from "@ytw/shared/api/notes";
import type { QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_ROLES,
  sql,
  withActor,
  type Actor,
  type ActorTx,
  type AppRole,
  type Queryable,
  type SqlQuery,
} from "../src/client.js";
import {
  ImmutableError,
  MissingActorError,
  NotFoundError,
  ValidationError,
  toDbError,
} from "../src/errors.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { failure } from "./helpers.js";

let db: TestDb;

const ISSUER = "https://id.example.test/realms/youtube-workspace";
const alice: Actor = { name: "alice", type: "human" };
/** An agent acting through a real API token (created in beforeAll). */
let bot: Actor;

/** Rows every test may hang its own rows on. */
interface Fixtures {
  userId: string;
  tokenId: string;
  ideaId: string;
  scriptId: string;
  videoId: string;
  experimentId: string;
  variantId: string;
}
let f: Fixtures;

const PUBLIC_TABLES = [
  "experiment_variants",
  "experiments",
  "ideas",
  "notes",
  "scripts",
  "user_permissions",
  "users",
  "video_metrics",
  "videos",
] as const;
const PRIVATE_TABLES = ["api_token_permissions", "api_tokens", "web_sessions"] as const;
const ALL_TABLES = [
  ...PUBLIC_TABLES.map((table) => `public.${table}`),
  ...PRIVATE_TABLES.map((table) => `ytw_private.${table}`),
];
/**
 * Tables that carry updated_at/updated_by (maintained by ytw_touch()). Notes keep them although
 * they are append-only, because the /api/notes contract returns updated_at.
 */
const MUTABLE_TABLES = ALL_TABLES.filter(
  (table) => table !== "public.video_metrics" && table !== "ytw_private.web_sessions",
);
const PERMISSION_TABLES = ["public.user_permissions", "ytw_private.api_token_permissions"] as const;
type PermissionTable = (typeof PERMISSION_TABLES)[number];

// ---------------------------------------------------------------------------------------------
// Helpers

/** Runs `fn` in a transaction whose audit actor is `actor` (the superuser stands in for T12-T14). */
function actAs<T>(actor: Actor, fn: (tx: ActorTx) => Promise<T>): Promise<T> {
  return withActor(db.admin, actor, fn);
}

async function one<R extends QueryResultRow>(q: Queryable, query: SqlQuery | string): Promise<R> {
  const { rows } = await q.query<R>(query);
  const first = rows[0];
  if (first === undefined) {
    throw new Error(`no row returned by: ${typeof query === "string" ? query : query.text}`);
  }
  return first;
}

async function insertId(tx: ActorTx, query: SqlQuery): Promise<string> {
  return (await one<{ id: string }>(tx, query)).id;
}

const unique = (): string => randomBytes(4).toString("hex");
/** An 11-character YouTube-style video id. */
const youtubeId = (): string => randomBytes(8).toString("base64url");
/** SHA-256 of a random secret, as T21 stores it (generated at run time, never a literal). */
const tokenHash = (): string => createHash("sha256").update(randomBytes(32)).digest("hex");
const tokenPrefix = (): string => `ytw_${randomBytes(6).toString("base64url")}`;

function newUser(tx: ActorTx, username = `user-${unique()}`, isAdmin = false): Promise<string> {
  return insertId(
    tx,
    sql`INSERT INTO users (oidc_issuer, oidc_sub, username, is_admin)
        VALUES (${ISSUER}, ${randomUUID()}, ${username}, ${isAdmin}) RETURNING id`,
  );
}

function newToken(tx: ActorTx, userId: string, name = `agent-${unique()}`): Promise<string> {
  return insertId(
    tx,
    sql`INSERT INTO ytw_private.api_tokens (user_id, name, token_prefix, token_hash)
        VALUES (${userId}, ${name}, ${tokenPrefix()}, ${tokenHash()}) RETURNING id`,
  );
}

function newIdea(tx: ActorTx, title = `Idea ${unique()}`): Promise<string> {
  return insertId(tx, sql`INSERT INTO ideas (title) VALUES (${title}) RETURNING id`);
}

function newScript(
  tx: ActorTx,
  ideaId: string,
  { version = 1, kind = "script", body = "# Draft" } = {},
): Promise<string> {
  return insertId(
    tx,
    sql`INSERT INTO scripts (idea_id, kind, version, body_md)
        VALUES (${ideaId}, ${kind}, ${version}, ${body}) RETURNING id`,
  );
}

function newVideo(tx: ActorTx, ideaId: string | null = null): Promise<string> {
  return insertId(
    tx,
    sql`INSERT INTO videos (idea_id, youtube_id, title)
        VALUES (${ideaId}, ${youtubeId()}, 'A video') RETURNING id`,
  );
}

function newMetrics(tx: ActorTx, videoId: string, capturedAt = new Date()): Promise<string> {
  return insertId(
    tx,
    sql`INSERT INTO video_metrics (video_id, captured_at, views)
        VALUES (${videoId}, ${capturedAt}, 100) RETURNING id`,
  );
}

function newExperiment(tx: ActorTx, videoId: string): Promise<string> {
  return insertId(
    tx,
    sql`INSERT INTO experiments (video_id, type) VALUES (${videoId}, 'title') RETURNING id`,
  );
}

function newVariant(
  tx: ActorTx,
  experimentId: string,
  { label = `V-${unique()}`, isControl = false } = {},
): Promise<string> {
  return insertId(
    tx,
    sql`INSERT INTO experiment_variants (experiment_id, label, content, is_control)
        VALUES (${experimentId}, ${label}, 'A better title', ${isControl}) RETURNING id`,
  );
}

function newNote(
  tx: ActorTx,
  entityType: string,
  entityId: string,
  body = "Looks good",
): Promise<string> {
  return insertId(
    tx,
    sql`INSERT INTO notes (entity_type, entity_id, body_md)
        VALUES (${entityType}, ${entityId}, ${body}) RETURNING id`,
  );
}

function newSession(
  tx: ActorTx,
  userId: string,
  { idle = "8 hours", absolute = "7 days" } = {},
): Promise<string> {
  return insertId(
    tx,
    sql`INSERT INTO ytw_private.web_sessions (user_id, refresh_token_encrypted, id_token_hint,
                                              expires_at, absolute_expires_at)
        VALUES (${userId}, ${randomBytes(48)}, 'header.payload.signature',
                now() + ${idle}::interval, now() + ${absolute}::interval)
        RETURNING id`,
  );
}

function insertPermission(
  tx: ActorTx,
  table: PermissionTable,
  ownerId: string,
  resource: string,
  level: string,
): Promise<unknown> {
  return table === "public.user_permissions"
    ? tx.query(
        sql`INSERT INTO user_permissions (user_id, resource, level)
            VALUES (${ownerId}, ${resource}, ${level})`,
      )
    : tx.query(
        sql`INSERT INTO ytw_private.api_token_permissions (token_id, resource, level)
            VALUES (${ownerId}, ${resource}, ${level})`,
      );
}

interface PgFailure {
  code: string;
  constraint: string | undefined;
  message: string;
}

/** Awaits a promise that must fail and returns its SQLSTATE and constraint name. */
async function pgFailure(promise: Promise<unknown>): Promise<PgFailure> {
  const err = await failure(promise);
  const code: unknown = Reflect.get(err, "code") ?? Reflect.get(err, "sqlstate");
  const constraint: unknown = Reflect.get(err, "constraint");
  return {
    code: typeof code === "string" ? code : `no SQLSTATE: ${err.message}`,
    constraint: typeof constraint === "string" ? constraint : undefined,
    message: err.message,
  };
}

/** Runs `fn` on a connection of `role`; ytw_readonly's session is switched to read-write first. */
async function asRole(role: AppRole, fn: (q: Queryable) => Promise<void>): Promise<void> {
  const client = await db.pool(role).connect();
  try {
    if (role === "ytw_readonly") {
      // So that a refusal proves a missing privilege, not just a read-only transaction.
      await client.query("SET default_transaction_read_only = off");
    }
    await fn(client);
  } finally {
    // Discard the connection: its session settings were changed.
    client.release(true);
  }
}

/** Whether @ytw/shared allows storing `level` for `resource` (false for unknown values). */
function grantable(resource: string, level: string): boolean {
  return RESOURCES.some(
    (known) => known === resource && (GRANTABLE_LEVELS[known] as readonly string[]).includes(level),
  );
}

/** How regclass::text prints a table: unqualified in public (on the search path). */
function display(table: string): string {
  return table.startsWith("public.") ? table.slice("public.".length) : table;
}

/** The quoted text literals of a CHECK constraint, optionally only those after `after`. */
async function checkLiterals(table: string, constraint: string, after = ""): Promise<string[]> {
  const { rows } = await db.admin.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = $1::regclass AND conname = $2`,
    [table, constraint],
  );
  const def = rows[0]?.def;
  if (def === undefined) {
    throw new Error(`constraint ${constraint} not found on ${table}`);
  }
  const tail = after === "" ? def : def.slice(def.indexOf(after));
  return [...tail.matchAll(/'([^']*)'::text/g)].map((match) => match[1] ?? "").toSorted();
}

interface EventRow {
  actor: string;
  actor_type: string;
  token_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: { old?: Record<string, unknown>; new?: Record<string, unknown> } & Record<
    string,
    unknown
  >;
}

async function eventsFor(entityId: string): Promise<EventRow[]> {
  const { rows } = await db.admin.query<EventRow>(
    `SELECT actor, actor_type, token_id, action, entity_type, entity_id, payload
       FROM events WHERE entity_id = $1 ORDER BY id`,
    [entityId],
  );
  return rows;
}

// ---------------------------------------------------------------------------------------------

beforeAll(async () => {
  db = await createTestDb();
  f = await actAs(alice, async (tx) => {
    const userId = await newUser(tx, "alice", true);
    const tokenId = await newToken(tx, userId, "research bot");
    const ideaId = await newIdea(tx, "Kangaroo racing in the homelab");
    const scriptId = await newScript(tx, ideaId);
    const videoId = await newVideo(tx, ideaId);
    const experimentId = await newExperiment(tx, videoId);
    const variantId = await newVariant(tx, experimentId, { label: "Control", isControl: true });
    return { userId, tokenId, ideaId, scriptId, videoId, experimentId, variantId };
  });
  bot = { name: "research bot", type: "agent", tokenId: f.tokenId };
});

afterAll(async () => {
  await db.drop();
});

// ---------------------------------------------------------------------------------------------

describe("agreement with @ytw/shared", () => {
  const enumChecks: [string, string, readonly string[]][] = [
    ["ideas", "ideas_status_check", IDEA_STAGES],
    ["scripts", "scripts_kind_check", SCRIPT_KINDS],
    ["scripts", "scripts_status_check", SCRIPT_STATUSES],
    ["experiments", "experiments_type_check", EXPERIMENT_TYPES],
    ["experiments", "experiments_status_check", EXPERIMENT_STATUSES],
    ["notes", "notes_entity_type_check", NOTE_ENTITY_TYPES],
    ["notes", "notes_actor_type_check", ACTOR_TYPES],
    ["user_permissions", "user_permissions_resource_check", RESOURCES],
    ["user_permissions", "user_permissions_level_check", LEVELS],
    ["ytw_private.api_token_permissions", "api_token_permissions_resource_check", RESOURCES],
    ["ytw_private.api_token_permissions", "api_token_permissions_level_check", LEVELS],
  ];

  it.each(enumChecks)(
    "%s %s lists exactly the shared values",
    async (table, constraint, values) => {
      expect(await checkLiterals(table, constraint)).toEqual([...values].toSorted());
    },
  );

  const readOnly = RESOURCES.filter((resource) => !GRANTABLE_LEVELS[resource].includes("write"));

  it.each([...PERMISSION_TABLES])(
    "%s refuses write exactly on the read-only objects",
    async (table) => {
      expect(readOnly).toContain("activity");
      const name = table.split(".")[1] as string;
      expect(await checkLiterals(table, `${name}_read_only_check`, "resource")).toEqual(
        readOnly.toSorted(),
      );
    },
  );

  it.each([...PERMISSION_TABLES])(
    "%s accepts exactly the (object, level) pairs of GRANTABLE_LEVELS",
    async (table) => {
      const resources = [...RESOURCES, "sponsors"];
      const levels = [...LEVELS, "admin"];
      const expected: Record<string, string> = {};
      for (const resource of resources) {
        for (const level of levels) {
          // 23514: check_violation, from the resource, level or read-only CHECK.
          expected[`${resource}:${level}`] = grantable(resource, level) ? "ok" : "23514";
        }
      }

      const actual: Record<string, string> = {};
      await actAs(alice, async (tx) => {
        const userId = await newUser(tx);
        const ownerId = table === "public.user_permissions" ? userId : await newToken(tx, userId);
        for (const resource of resources) {
          for (const level of levels) {
            await tx.query("SAVEPOINT attempt");
            try {
              await insertPermission(tx, table, ownerId, resource, level);
              actual[`${resource}:${level}`] = "ok";
            } catch (err) {
              const code: unknown = Reflect.get(err as object, "code");
              actual[`${resource}:${level}`] = typeof code === "string" ? code : String(err);
            }
            await tx.query("ROLLBACK TO SAVEPOINT attempt");
          }
        }
      });
      expect(actual).toEqual(expected);
    },
  );

  it.each([...PERMISSION_TABLES])(
    "%s stores a row for every object of one owner",
    async (table) => {
      // An admin's rows (PRD 7: Write on everything, the activity log at Read).
      const stored = await actAs(alice, async (tx) => {
        const userId = await newUser(tx, `admin-${unique()}`, true);
        const ownerId = table === "public.user_permissions" ? userId : await newToken(tx, userId);
        for (const resource of RESOURCES) {
          await insertPermission(
            tx,
            table,
            ownerId,
            resource,
            GRANTABLE_LEVELS[resource].at(-1) ?? "none",
          );
        }
        const { rows } = await tx.query<{ resource: string; level: string }>(
          table === "public.user_permissions"
            ? sql`SELECT resource, level FROM user_permissions WHERE user_id = ${ownerId}`
            : sql`SELECT resource, level FROM ytw_private.api_token_permissions WHERE token_id = ${ownerId}`,
        );
        return rows;
      });
      expect(Object.fromEntries(stored.map((r) => [r.resource, r.level]))).toEqual(
        Object.fromEntries(
          RESOURCES.map((resource) => [resource, resource === "activity" ? "read" : "write"]),
        ),
      );
    },
  );

  it.each([
    ["scripts", "scripts_body_md_size_check", SCRIPT_BODY_MAX_BYTES],
    ["notes", "notes_body_md_size_check", NOTE_BODY_MAX_BYTES],
  ] as const)(
    "limits %s bodies to the shared byte limit (%s = %i)",
    async (table, constraint, max) => {
      const { rows } = await db.admin.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = $1::regclass AND conname = $2`,
        [table, constraint],
      );
      expect(rows[0]?.def).toContain(`octet_length(body_md) <= ${max})`);

      // Two bytes per character: the limit counts bytes of UTF-8, not characters.
      const largest = "é".repeat(max / 2);
      const tooLarge = `${largest}x`;
      const write = (tx: ActorTx, ideaId: string, body: string) =>
        table === "scripts" ? newScript(tx, ideaId, { body }) : newNote(tx, "idea", ideaId, body);
      const ideaId = await actAs(alice, (tx) => newIdea(tx));
      const stored = await actAs(alice, (tx) => write(tx, ideaId, largest));
      expect(stored).toMatch(/^[0-9a-f-]{36}$/);
      expect(await pgFailure(actAs(alice, (tx) => write(tx, ideaId, tooLarge)))).toMatchObject({
        code: "23514",
        constraint,
      });
    },
  );

  it("starts new ideas, scripts and experiments in their first stage or status", async () => {
    const { ideaStatus, scriptStatus, experimentStatus } = await actAs(alice, async (tx) => {
      const ideaId = await newIdea(tx);
      const scriptId = await newScript(tx, ideaId);
      const experimentId = await newExperiment(tx, f.videoId);
      return one<{ ideaStatus: string; scriptStatus: string; experimentStatus: string }>(
        tx,
        sql`SELECT (SELECT status FROM ideas WHERE id = ${ideaId}) AS "ideaStatus",
                   (SELECT status FROM scripts WHERE id = ${scriptId}) AS "scriptStatus",
                   (SELECT status FROM experiments WHERE id = ${experimentId}) AS "experimentStatus"`,
      );
    });
    expect(ideaStatus).toBe("inbox");
    expect(IDEA_STAGES[0]).toBe("inbox");
    expect(scriptStatus).toBe(SCRIPT_STATUSES[0]);
    expect(experimentStatus).toBe(EXPERIMENT_STATUSES[0]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("tables", () => {
  it("keep business data in public and secret-bearing tables in ytw_private", async () => {
    const { rows } = await db.admin.query<{ schemaname: string; tablename: string }>(
      `SELECT schemaname, tablename FROM pg_tables
        WHERE schemaname IN ('public', 'ytw_private') ORDER BY 1, 2`,
    );
    const inSchema = (schema: string) =>
      rows.filter((row) => row.schemaname === schema).map((row) => row.tablename);
    expect(inSchema("public")).toEqual(expect.arrayContaining([...PUBLIC_TABLES, "events"]));
    expect(inSchema("ytw_private")).toEqual(expect.arrayContaining([...PRIVATE_TABLES]));
    for (const secret of PRIVATE_TABLES) {
      expect(inSchema("public")).not.toContain(secret);
    }
  });

  it("have uuid primary keys: time-ordered v7, except the random session handle", async () => {
    const { rows } = await db.admin.query<{
      relation: string;
      type: string;
      default: string | null;
      pk: boolean;
    }>(
      `SELECT c.oid::regclass::text AS relation, format_type(a.atttypid, a.atttypmod) AS type,
              pg_get_expr(d.adbin, d.adrelid) AS default,
              EXISTS (SELECT 1 FROM pg_constraint k
                       WHERE k.conrelid = c.oid AND k.contype = 'p' AND k.conkey = ARRAY[a.attnum]) AS pk
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'id'
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE c.oid = ANY ($1::regclass[])`,
      [ALL_TABLES],
    );
    expect(rows).toHaveLength(ALL_TABLES.length);
    for (const row of rows) {
      const expectedDefault =
        row.relation === "ytw_private.web_sessions" ? "gen_random_uuid()" : "uuid_generate_v7()";
      expect(row).toEqual({
        relation: row.relation,
        type: "uuid",
        default: expect.stringContaining(expectedDefault),
        pk: true,
      });
    }

    const session = await actAs(alice, (tx) => newSession(tx, f.userId));
    expect(session[14]).toBe("4");
    const idea = await actAs(alice, (tx) => newIdea(tx));
    expect(idea[14]).toBe("7");
  });

  interface ColumnRow {
    relation: string;
    column: string;
    type: string;
    nullable: boolean;
    default: string | null;
  }

  async function columns(): Promise<ColumnRow[]> {
    const { rows } = await db.admin.query<ColumnRow>(
      `SELECT c.oid::regclass::text AS relation, a.attname AS column,
              format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS default
         FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE c.oid = ANY ($1::regclass[])
        ORDER BY 1, a.attnum`,
      [ALL_TABLES],
    );
    return rows;
  }

  it("carry created_at/updated_at and created_by/updated_by, set to the actor by default", async () => {
    const all = await columns();
    const pick = (table: string, column: string) =>
      all.find((row) => row.relation === display(table) && row.column === column);
    for (const table of MUTABLE_TABLES) {
      expect(pick(table, "created_at")).toMatchObject({
        type: "timestamp with time zone",
        nullable: false,
      });
      expect(pick(table, "updated_at")).toMatchObject({
        type: "timestamp with time zone",
        nullable: false,
      });
      expect(pick(table, "created_by")).toMatchObject({
        type: "text",
        nullable: false,
        default: "ytw_current_actor()",
      });
      expect(pick(table, "updated_by")).toMatchObject({
        type: "text",
        nullable: false,
        default: "ytw_current_actor()",
      });
    }
    // Append-only snapshots never change, so (like events) they have no updated_*.
    expect(pick("public.video_metrics", "created_by")).toMatchObject({ nullable: false });
    expect(pick("public.video_metrics", "updated_at")).toBeUndefined();

    for (const table of ["public.ideas", "public.experiments", "public.videos"]) {
      expect(pick(table, "version")).toMatchObject({
        type: "integer",
        nullable: false,
        default: "1",
      });
    }
    for (const table of ["public.ideas", "public.videos"]) {
      expect(pick(table, "archived_at")).toMatchObject({
        type: "timestamp with time zone",
        nullable: true,
      });
    }
    expect(pick("public.ideas", "status_changed_at")).toMatchObject({
      type: "timestamp with time zone",
      nullable: false,
    });
  });

  it("define web_sessions with exactly the planned columns", async () => {
    const session = (await columns())
      .filter((row) => row.relation === "ytw_private.web_sessions")
      .map((row) => [row.column, row.type, row.nullable]);
    expect(session).toEqual([
      ["id", "uuid", false],
      ["user_id", "uuid", false],
      ["refresh_token_encrypted", "bytea", true],
      ["id_token_hint", "text", true],
      ["created_at", "timestamp with time zone", false],
      ["last_seen_at", "timestamp with time zone", false],
      ["expires_at", "timestamp with time zone", false],
      ["absolute_expires_at", "timestamp with time zone", false],
    ]);
  });

  it("index the ideas filters (stage, tags, score, source) and both search vectors", async () => {
    const { rows } = await db.admin.query<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('ideas', 'scripts')`,
    );
    const defs = rows.map((row) => row.def);
    for (const expected of [
      /ON public\.ideas USING btree \(status/,
      /ON public\.ideas USING gin \(tags\)/,
      /ON public\.ideas USING btree \(score\)/,
      /ON public\.ideas USING btree \(source\)/,
      /ON public\.ideas USING gin \(search_vector\)/,
      /ON public\.scripts USING gin \(search_vector\)/,
    ]) {
      expect(defs).toContainEqual(expect.stringMatching(expected));
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("foreign keys", () => {
  it("all restrict deletes; the circular winner key is deferrable", async () => {
    const { rows } = await db.admin.query<{
      child: string;
      parent: string;
      deletes: string;
      deferrable: boolean;
      deferred: boolean;
      name: string;
    }>(
      `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent,
              confdeltype AS deletes, condeferrable AS deferrable, condeferred AS deferred,
              conname AS name
         FROM pg_constraint
        WHERE contype = 'f' AND connamespace IN ('public'::regnamespace, 'ytw_private'::regnamespace)`,
    );
    for (const row of rows) {
      expect({ name: row.name, deletes: row.deletes }).toEqual({ name: row.name, deletes: "r" });
    }
    expect(rows.map((row) => `${row.child} -> ${row.parent}`).toSorted()).toEqual(
      expect.arrayContaining([
        "experiment_variants -> experiments",
        "experiments -> experiment_variants",
        "experiments -> videos",
        "scripts -> ideas",
        "user_permissions -> users",
        "video_metrics -> videos",
        "videos -> ideas",
        "ytw_private.api_token_permissions -> ytw_private.api_tokens",
        "ytw_private.api_tokens -> users",
        "ytw_private.web_sessions -> users",
      ]),
    );
    const winner = rows.find((row) => row.name === "experiments_winner_variant_fkey");
    expect(winner).toMatchObject({ deferrable: true, deferred: true, deletes: "r" });
  });

  const restricted: [string, (tx: ActorTx) => Promise<unknown>][] = [
    [
      "an idea with a script",
      async (tx) => {
        const ideaId = await newIdea(tx);
        await newScript(tx, ideaId);
        return tx.query(sql`DELETE FROM ideas WHERE id = ${ideaId}`);
      },
    ],
    [
      "an idea with a video",
      async (tx) => {
        const ideaId = await newIdea(tx);
        await newVideo(tx, ideaId);
        return tx.query(sql`DELETE FROM ideas WHERE id = ${ideaId}`);
      },
    ],
    [
      "a video with metrics",
      async (tx) => {
        const videoId = await newVideo(tx);
        await newMetrics(tx, videoId);
        return tx.query(sql`DELETE FROM videos WHERE id = ${videoId}`);
      },
    ],
    [
      "a video with an experiment",
      async (tx) => {
        const videoId = await newVideo(tx);
        await newExperiment(tx, videoId);
        return tx.query(sql`DELETE FROM videos WHERE id = ${videoId}`);
      },
    ],
    [
      "an experiment with variants",
      async (tx) => {
        const experimentId = await newExperiment(tx, f.videoId);
        await newVariant(tx, experimentId);
        return tx.query(sql`DELETE FROM experiments WHERE id = ${experimentId}`);
      },
    ],
    [
      "the winning variant",
      async (tx) => {
        const experimentId = await newExperiment(tx, f.videoId);
        const variantId = await newVariant(tx, experimentId);
        await tx.query(
          sql`UPDATE experiments SET status = 'concluded', winner_variant_id = ${variantId}
               WHERE id = ${experimentId}`,
        );
        return tx.query(sql`DELETE FROM experiment_variants WHERE id = ${variantId}`);
      },
    ],
    [
      "a user with permissions",
      async (tx) => {
        const userId = await newUser(tx);
        await insertPermission(tx, "public.user_permissions", userId, "ideas", "read");
        return tx.query(sql`DELETE FROM users WHERE id = ${userId}`);
      },
    ],
    [
      "a user with an API token",
      async (tx) => {
        const userId = await newUser(tx);
        await newToken(tx, userId);
        return tx.query(sql`DELETE FROM users WHERE id = ${userId}`);
      },
    ],
    [
      "a user with a web session",
      async (tx) => {
        const userId = await newUser(tx);
        await newSession(tx, userId);
        return tx.query(sql`DELETE FROM users WHERE id = ${userId}`);
      },
    ],
    [
      "a token with permissions",
      async (tx) => {
        const tokenId = await newToken(tx, f.userId);
        await insertPermission(tx, "ytw_private.api_token_permissions", tokenId, "ideas", "read");
        return tx.query(sql`DELETE FROM ytw_private.api_tokens WHERE id = ${tokenId}`);
      },
    ],
  ];

  // Postgres reports RESTRICT (like NO ACTION) as foreign_key_violation, 23503; the catalog test
  // above pins the action itself (confdeltype 'r').
  it.each(restricted)("refuse to delete %s (ON DELETE RESTRICT)", async (_label, attempt) => {
    const err = await pgFailure(actAs(alice, attempt));
    expect(err.code).toBe("23503");
    expect(err.message).toMatch(/^update or delete on table .* violates foreign key constraint/);
  });

  it("refuse rows that point at nothing", async () => {
    const missing = randomUUID();
    for (const attempt of [
      (tx: ActorTx) => newScript(tx, missing),
      (tx: ActorTx) => newVideo(tx, missing),
      (tx: ActorTx) => newMetrics(tx, missing),
      (tx: ActorTx) => newVariant(tx, missing),
      (tx: ActorTx) => newToken(tx, missing),
      (tx: ActorTx) => newSession(tx, missing),
    ]) {
      const err = await pgFailure(actAs(alice, attempt));
      expect(err.code).toBe("23503");
      expect(err.message).toMatch(/^insert or update on table .* violates foreign key constraint/);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("unique keys", () => {
  const duplicates: [string, (tx: ActorTx) => Promise<unknown>][] = [
    [
      "scripts_idea_kind_version_key",
      async (tx) => {
        const ideaId = await newIdea(tx);
        await newScript(tx, ideaId, { version: 1, kind: "script" });
        await newScript(tx, ideaId, { version: 1, kind: "packaging" }); // other kind: fine
        return newScript(tx, ideaId, { version: 1, kind: "script" });
      },
    ],
    [
      "video_metrics_video_captured_key",
      async (tx) => {
        const at = new Date("2026-09-01T12:00:00Z");
        await newMetrics(tx, f.videoId, at);
        return newMetrics(tx, f.videoId, at);
      },
    ],
    [
      "videos_youtube_id_key",
      async (tx) => {
        const id = youtubeId();
        await tx.query(sql`INSERT INTO videos (youtube_id, title) VALUES (${id}, 'one')`);
        return tx.query(sql`INSERT INTO videos (youtube_id, title) VALUES (${id}, 'two')`);
      },
    ],
    [
      "users_oidc_identity_key",
      async (tx) => {
        const sub = randomUUID();
        await tx.query(
          sql`INSERT INTO users (oidc_issuer, oidc_sub, username) VALUES ('https://other.test', ${sub}, 'x')`,
        ); // same sub at another issuer: fine
        await tx.query(
          sql`INSERT INTO users (oidc_issuer, oidc_sub, username) VALUES (${ISSUER}, ${sub}, 'y')`,
        );
        return tx.query(
          sql`INSERT INTO users (oidc_issuer, oidc_sub, username) VALUES (${ISSUER}, ${sub}, 'z')`,
        );
      },
    ],
    [
      "user_permissions_user_resource_key",
      async (tx) => {
        const userId = await newUser(tx);
        await insertPermission(tx, "public.user_permissions", userId, "scripts", "read");
        return insertPermission(tx, "public.user_permissions", userId, "scripts", "write");
      },
    ],
    [
      "api_token_permissions_token_resource_key",
      async (tx) => {
        const tokenId = await newToken(tx, f.userId);
        await insertPermission(tx, "ytw_private.api_token_permissions", tokenId, "notes", "none");
        return insertPermission(tx, "ytw_private.api_token_permissions", tokenId, "notes", "read");
      },
    ],
    [
      "api_tokens_token_hash_key",
      async (tx) => {
        const hash = tokenHash();
        const insert = () =>
          tx.query(
            sql`INSERT INTO ytw_private.api_tokens (user_id, name, token_prefix, token_hash)
                VALUES (${f.userId}, 'twin', ${tokenPrefix()}, ${hash})`,
          );
        await insert();
        return insert();
      },
    ],
    [
      "experiment_variants_one_control_idx",
      async (tx) => {
        const experimentId = await newExperiment(tx, f.videoId);
        await newVariant(tx, experimentId, { isControl: true });
        await newVariant(tx, experimentId, { isControl: false });
        return newVariant(tx, experimentId, { isControl: true });
      },
    ],
    [
      "experiment_variants_label_key",
      async (tx) => {
        const experimentId = await newExperiment(tx, f.videoId);
        await newVariant(tx, experimentId, { label: "B" });
        return newVariant(tx, experimentId, { label: "B" });
      },
    ],
  ];

  it.each(duplicates)("%s rejects a duplicate", async (constraint, attempt) => {
    expect(await pgFailure(actAs(alice, attempt))).toMatchObject({ code: "23505", constraint });
  });
});

// ---------------------------------------------------------------------------------------------

describe("append-only tables", () => {
  it("scripts: a revision's content never changes, only its status", async () => {
    const ideaId = await actAs(alice, (tx) => newIdea(tx));
    const scriptId = await actAs(alice, (tx) => newScript(tx, ideaId, { body: "# Version one" }));

    for (const change of [
      sql`UPDATE scripts SET body_md = 'rewritten' WHERE id = ${scriptId}`,
      sql`UPDATE scripts SET version = 2 WHERE id = ${scriptId}`,
      sql`UPDATE scripts SET kind = 'packaging' WHERE id = ${scriptId}`,
      sql`UPDATE scripts SET idea_id = ${f.ideaId} WHERE id = ${scriptId}`,
      sql`UPDATE scripts SET status = 'review', body_md = 'sneaky' WHERE id = ${scriptId}`,
    ]) {
      const err = toDbError(await failure(actAs(alice, (tx) => tx.query(change))));
      expect(err).toBeInstanceOf(ImmutableError);
      expect((err as ImmutableError).message).toMatch(
        /scripts is append-only: .* save a new version/,
      );
    }

    await actAs(bot, (tx) =>
      tx.query(sql`UPDATE scripts SET status = 'review' WHERE id = ${scriptId}`),
    );
    const saved = await one<{
      status: string;
      body_md: string;
      created_by: string;
      updated_by: string;
    }>(
      db.admin,
      sql`SELECT status, body_md, created_by, updated_by FROM scripts WHERE id = ${scriptId}`,
    );
    expect(saved).toEqual({
      status: "review",
      body_md: "# Version one",
      created_by: "alice",
      updated_by: "research bot",
    });

    for (const statement of [
      sql`DELETE FROM scripts WHERE id = ${scriptId}`,
      { text: "TRUNCATE scripts", values: [] },
    ]) {
      const err = toDbError(await failure(actAs(alice, (tx) => tx.query(statement))));
      expect(err).toBeInstanceOf(ImmutableError);
    }
  });

  it("video_metrics: snapshots are never updated, deleted or truncated", async () => {
    const metricId = await actAs(bot, (tx) =>
      newMetrics(tx, f.videoId, new Date("2026-09-02T00:00:00Z")),
    );
    for (const statement of [
      sql`UPDATE video_metrics SET views = 1 WHERE id = ${metricId}`,
      sql`DELETE FROM video_metrics WHERE id = ${metricId}`,
      { text: "TRUNCATE video_metrics", values: [] },
    ]) {
      const err = toDbError(await failure(actAs(alice, (tx) => tx.query(statement))));
      expect(err).toBeInstanceOf(ImmutableError);
      expect((err as ImmutableError).details).toMatchObject({ table: "video_metrics" });
    }
    const kept = await one<{ views: string }>(
      db.admin,
      sql`SELECT views FROM video_metrics WHERE id = ${metricId}`,
    );
    expect(kept.views).toBe("100");
  });
});

// ---------------------------------------------------------------------------------------------

describe("CHECK constraints", () => {
  const tooManyTags = Array.from({ length: 51 }, (_, index) => `tag${index}`);
  const invalid: [string, (fx: Fixtures) => SqlQuery][] = [
    ["ideas_status_check", () => sql`INSERT INTO ideas (title, status) VALUES ('t', 'archived')`],
    ["ideas_title_check", () => sql`INSERT INTO ideas (title) VALUES ('   ')`],
    ["ideas_title_check", () => sql`INSERT INTO ideas (title) VALUES (${"t".repeat(501)})`],
    [
      "ideas_pitch_check",
      () => sql`INSERT INTO ideas (title, pitch) VALUES ('t', ${"p".repeat(20001)})`,
    ],
    ["ideas_score_check", () => sql`INSERT INTO ideas (title, score) VALUES ('t', -1)`],
    ["ideas_score_check", () => sql`INSERT INTO ideas (title, score) VALUES ('t', 101)`],
    ["ideas_source_check", () => sql`INSERT INTO ideas (title, source) VALUES ('t', '')`],
    ["ideas_tags_check", () => sql`INSERT INTO ideas (title, tags) VALUES ('t', ${["a", "a"]})`],
    ["ideas_tags_check", () => sql`INSERT INTO ideas (title, tags) VALUES ('t', ${[""]})`],
    ["ideas_tags_check", () => sql`INSERT INTO ideas (title, tags) VALUES ('t', ${[" padded"]})`],
    [
      "ideas_tags_check",
      () => sql`INSERT INTO ideas (title, tags) VALUES ('t', ARRAY['ok', NULL])`,
    ],
    [
      "ideas_tags_check",
      () => sql`INSERT INTO ideas (title, tags) VALUES ('t', ${["x".repeat(65)]})`,
    ],
    ["ideas_tags_check", () => sql`INSERT INTO ideas (title, tags) VALUES ('t', ${tooManyTags})`],
    ["ideas_tags_check", () => sql`INSERT INTO ideas (title, tags) VALUES ('t', '{{a,b},{c,d}}')`],
    ["ideas_version_check", () => sql`INSERT INTO ideas (title, version) VALUES ('t', 0)`],
    [
      "scripts_kind_check",
      (fx) =>
        sql`INSERT INTO scripts (idea_id, kind, version, body_md) VALUES (${fx.ideaId}, 'outline', 9, '')`,
    ],
    [
      "scripts_status_check",
      (fx) =>
        sql`INSERT INTO scripts (idea_id, kind, version, body_md, status)
            VALUES (${fx.ideaId}, 'script', 9, '', 'published')`,
    ],
    [
      "scripts_version_check",
      (fx) =>
        sql`INSERT INTO scripts (idea_id, kind, version, body_md) VALUES (${fx.ideaId}, 'script', 0, '')`,
    ],
    [
      "videos_youtube_id_check",
      () => sql`INSERT INTO videos (youtube_id, title) VALUES ('short', 't')`,
    ],
    [
      "videos_youtube_id_check",
      () =>
        sql`INSERT INTO videos (youtube_id, title) VALUES ('https://youtu.be/dQw4w9WgXcQ', 't')`,
    ],
    [
      "videos_title_check",
      () => sql`INSERT INTO videos (youtube_id, title) VALUES (${youtubeId()}, '')`,
    ],
    [
      "videos_thumbnail_url_check",
      () =>
        sql`INSERT INTO videos (youtube_id, title, thumbnail_url)
            VALUES (${youtubeId()}, 't', 'javascript:alert(1)')`,
    ],
    [
      "videos_thumbnail_url_check",
      () =>
        sql`INSERT INTO videos (youtube_id, title, thumbnail_url)
            VALUES (${youtubeId()}, 't', 'data:image/png;base64,AAAA')`,
    ],
    [
      "videos_thumbnail_url_check",
      () =>
        sql`INSERT INTO videos (youtube_id, title, thumbnail_url)
            VALUES (${youtubeId()}, 't', 'https://img.example.test/a b.png')`,
    ],
    [
      "video_metrics_views_check",
      (fx) =>
        sql`INSERT INTO video_metrics (video_id, captured_at, views) VALUES (${fx.videoId}, now(), -1)`,
    ],
    [
      "video_metrics_ctr_check",
      (fx) =>
        sql`INSERT INTO video_metrics (video_id, captured_at, ctr) VALUES (${fx.videoId}, now(), 100.5)`,
    ],
    [
      "video_metrics_retention_check",
      (fx) =>
        sql`INSERT INTO video_metrics (video_id, captured_at, retention)
            VALUES (${fx.videoId}, now(), '{"at": 1}')`,
    ],
    [
      "video_metrics_any_metric_check",
      (fx) => sql`INSERT INTO video_metrics (video_id, captured_at) VALUES (${fx.videoId}, now())`,
    ],
    [
      "experiments_type_check",
      (fx) => sql`INSERT INTO experiments (video_id, type) VALUES (${fx.videoId}, 'tags')`,
    ],
    [
      "experiments_status_check",
      (fx) =>
        sql`INSERT INTO experiments (video_id, type, status) VALUES (${fx.videoId}, 'title', 'paused')`,
    ],
    [
      "experiments_period_check",
      (fx) =>
        sql`INSERT INTO experiments (video_id, type, starts_at, ends_at)
            VALUES (${fx.videoId}, 'title', now(), now() - interval '1 day')`,
    ],
    [
      "experiments_winner_concluded_check",
      (fx) =>
        sql`UPDATE experiments SET status = 'running', winner_variant_id = ${fx.variantId}
             WHERE id = ${fx.experimentId}`,
    ],
    [
      "experiment_variants_label_check",
      (fx) =>
        sql`INSERT INTO experiment_variants (experiment_id, label, content) VALUES (${fx.experimentId}, ' ', 'c')`,
    ],
    [
      "experiment_variants_impressions_check",
      (fx) =>
        sql`INSERT INTO experiment_variants (experiment_id, label, content, impressions)
            VALUES (${fx.experimentId}, 'neg', 'c', -5)`,
    ],
    [
      "experiment_variants_ctr_check",
      (fx) =>
        sql`INSERT INTO experiment_variants (experiment_id, label, content, ctr)
            VALUES (${fx.experimentId}, 'big', 'c', 101)`,
    ],
    [
      "notes_body_md_size_check",
      (fx) =>
        sql`INSERT INTO notes (entity_type, entity_id, body_md) VALUES ('idea', ${fx.ideaId}, '  ')`,
    ],
    [
      "users_username_check",
      () =>
        sql`INSERT INTO users (oidc_issuer, oidc_sub, username) VALUES (${ISSUER}, 'sub-1', ' padded')`,
    ],
    [
      "users_username_check",
      () =>
        sql`INSERT INTO users (oidc_issuer, oidc_sub, username) VALUES (${ISSUER}, 'sub-2', ${"bell\u0007"})`,
    ],
    [
      "users_oidc_sub_check",
      () =>
        sql`INSERT INTO users (oidc_issuer, oidc_sub, username) VALUES (${ISSUER}, ${"s".repeat(256)}, 'u')`,
    ],
    [
      "users_oidc_issuer_check",
      () =>
        sql`INSERT INTO users (oidc_issuer, oidc_sub, username) VALUES ('https://bad issuer', 'sub-3', 'u')`,
    ],
    [
      "users_email_check",
      () =>
        sql`INSERT INTO users (oidc_issuer, oidc_sub, username, email) VALUES (${ISSUER}, 'sub-4', 'u', 'a b@c')`,
    ],
    [
      "api_tokens_token_hash_check",
      // A plain-text secret where the hash belongs (generated, so it is never a literal).
      (fx) =>
        sql`INSERT INTO ytw_private.api_tokens (user_id, name, token_prefix, token_hash)
            VALUES (${fx.userId}, 'leaky', ${tokenPrefix()}, ${`ytw_${randomBytes(32).toString("base64url")}`})`,
    ],
    [
      "api_tokens_token_hash_check",
      (fx) =>
        sql`INSERT INTO ytw_private.api_tokens (user_id, name, token_prefix, token_hash)
            VALUES (${fx.userId}, 'upper', ${tokenPrefix()}, ${tokenHash().toUpperCase()})`,
    ],
    [
      "api_tokens_token_prefix_check",
      // The prefix identifies a token; it must never be (most of) the secret.
      (fx) =>
        sql`INSERT INTO ytw_private.api_tokens (user_id, name, token_prefix, token_hash)
            VALUES (${fx.userId}, 'long prefix', ${`ytw_${randomBytes(32).toString("base64url")}`}, ${tokenHash()})`,
    ],
    [
      "api_tokens_name_check",
      (fx) =>
        sql`INSERT INTO ytw_private.api_tokens (user_id, name, token_prefix, token_hash)
            VALUES (${fx.userId}, ${"line\nbreak"}, ${tokenPrefix()}, ${tokenHash()})`,
    ],
    [
      "web_sessions_expiry_check",
      (fx) =>
        sql`INSERT INTO ytw_private.web_sessions (user_id, expires_at, absolute_expires_at)
            VALUES (${fx.userId}, now() + interval '2 days', now() + interval '1 day')`,
    ],
    [
      "web_sessions_refresh_token_encrypted_check",
      (fx) =>
        sql`INSERT INTO ytw_private.web_sessions (user_id, refresh_token_encrypted, expires_at, absolute_expires_at)
            VALUES (${fx.userId}, ''::bytea, now(), now())`,
    ],
  ];

  it.each(invalid)("%s rejects an invalid value (case %#)", async (constraint, query) => {
    expect(await pgFailure(actAs(alice, (tx) => tx.query(query(f))))).toMatchObject({
      code: "23514",
      constraint,
    });
  });

  it("accept the boundary values", async () => {
    const inserted = await actAs(alice, async (tx) => {
      const counts: number[] = [];
      const run = async (query: SqlQuery) => {
        counts.push((await tx.query(query)).rowCount ?? 0);
      };
      await run(
        sql`INSERT INTO ideas (title, pitch, score, source, tags)
            VALUES (${"t".repeat(500)}, '', 0, 'viewer comment', ${Array.from({ length: 50 }, (_, i) => `t${i}`)})`,
      );
      await run(
        sql`INSERT INTO ideas (title, score, tags) VALUES ('Top', 100, ${["x".repeat(64)]})`,
      );
      for (const thumbnail of [
        "https://i.ytimg.com/vi/abc/maxresdefault.jpg",
        "/srv/thumbnails/abc.png",
        "thumbnails/abc.png",
      ]) {
        await run(
          sql`INSERT INTO videos (youtube_id, title, thumbnail_url) VALUES (${youtubeId()}, 't', ${thumbnail})`,
        );
      }
      await run(
        sql`INSERT INTO video_metrics (video_id, captured_at, ctr, avg_view_pct, subs_gained, retention)
            VALUES (${f.videoId}, now() - interval '1 hour', 100, 135.5, -3, '[[0, 100], [1, 42.5]]')`,
      );
      await run(
        sql`INSERT INTO ytw_private.web_sessions (user_id, expires_at, absolute_expires_at)
            VALUES (${f.userId}, now() + interval '1 day', now() + interval '1 day')`,
      );
      return counts;
    });
    expect(inserted).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("row bookkeeping (ytw_touch)", () => {
  interface IdeaState {
    version: number;
    created_by: string;
    updated_by: string;
    created_at: Date;
    updated_at: Date;
    status_changed_at: Date;
    status: string;
  }

  const ideaState = (id: string) =>
    one<IdeaState>(
      db.admin,
      sql`SELECT version, created_by, updated_by, created_at, updated_at, status_changed_at, status
            FROM ideas WHERE id = ${id}`,
    );

  it("record the actor and bump version by exactly one on every change", async () => {
    const id = await actAs(alice, (tx) => newIdea(tx));
    const created = await ideaState(id);
    expect(created).toMatchObject({ version: 1, created_by: "alice", updated_by: "alice" });

    await actAs(bot, (tx) => tx.query(sql`UPDATE ideas SET title = 'Renamed' WHERE id = ${id}`));
    const renamed = await ideaState(id);
    expect(renamed).toMatchObject({ version: 2, created_by: "alice", updated_by: "research bot" });
    expect(renamed.updated_at.getTime()).toBeGreaterThan(created.updated_at.getTime());
    expect(renamed.status_changed_at).toEqual(created.status_changed_at);

    // Whatever the UPDATE writes into version, the stored version is the old one plus one.
    await actAs(alice, (tx) =>
      tx.query(sql`UPDATE ideas SET version = 99, score = 7 WHERE id = ${id}`),
    );
    await actAs(alice, (tx) =>
      tx.query(sql`UPDATE ideas SET version = 1, score = 8 WHERE id = ${id}`),
    );
    expect((await ideaState(id)).version).toBe(4);

    // Two changes in one transaction are two changes.
    await actAs(alice, async (tx) => {
      await tx.query(sql`UPDATE ideas SET score = 9 WHERE id = ${id}`);
      await tx.query(sql`UPDATE ideas SET score = 10 WHERE id = ${id}`);
    });
    expect((await ideaState(id)).version).toBe(6);
  });

  it("leave everything alone when an update changes nothing", async () => {
    const id = await actAs(alice, (tx) => newIdea(tx));
    const before = await ideaState(id);
    await actAs(bot, (tx) =>
      tx.query(
        sql`UPDATE ideas SET title = title, updated_by = 'mallory', updated_at = now() - interval '1 day' WHERE id = ${id}`,
      ),
    );
    expect(await ideaState(id)).toEqual(before);
  });

  it("move status_changed_at only when the stage changes", async () => {
    const id = await actAs(alice, (tx) => newIdea(tx));
    const created = await ideaState(id);
    expect(created.status_changed_at).toEqual(created.created_at);

    await actAs(alice, (tx) =>
      tx.query(sql`UPDATE ideas SET status = 'shortlisted' WHERE id = ${id}`),
    );
    const moved = await ideaState(id);
    expect(moved.status).toBe("shortlisted");
    expect(moved.status_changed_at.getTime()).toBeGreaterThan(created.status_changed_at.getTime());
    expect(moved.status_changed_at).toEqual(moved.updated_at);

    // Editing other fields, or writing status_changed_at directly, keeps the clock.
    await actAs(alice, (tx) =>
      tx.query(
        sql`UPDATE ideas SET pitch = 'more detail', status_changed_at = now() - interval '30 days'
             WHERE id = ${id}`,
      ),
    );
    const edited = await ideaState(id);
    expect(edited.status_changed_at).toEqual(moved.status_changed_at);
    expect(edited.version).toBe(moved.version + 1);
  });

  it("refuse to change id, created_at or created_by", async () => {
    const id = await actAs(alice, (tx) => newIdea(tx));
    for (const statement of [
      sql`UPDATE ideas SET id = ${randomUUID()} WHERE id = ${id}`,
      sql`UPDATE ideas SET created_at = now() - interval '1 year' WHERE id = ${id}`,
      sql`UPDATE ideas SET created_by = 'mallory' WHERE id = ${id}`,
      sql`UPDATE users SET created_by = 'mallory' WHERE id = ${f.userId}`,
      sql`UPDATE ytw_private.api_tokens SET created_at = now() - interval '1 year' WHERE id = ${f.tokenId}`,
    ]) {
      const err = toDbError(await failure(actAs(alice, (tx) => tx.query(statement))));
      expect(err).toBeInstanceOf(ImmutableError);
      expect((err as ImmutableError).message).toMatch(
        /cannot be changed after the row was created/,
      );
    }
  });

  it("maintain every table that has updated_at, and versions where PRD 4 asks for them", async () => {
    const { rows } = await db.admin.query<{ relation: string; def: string }>(
      `SELECT t.tgrelid::regclass::text AS relation, pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE p.proname = 'ytw_touch' AND NOT t.tgisinternal`,
    );
    const touched = rows.map((row) => row.relation);
    const { rows: withUpdatedAt } = await db.admin.query<{ relation: string }>(
      `SELECT c.oid::regclass::text AS relation FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE a.attname = 'updated_at' AND c.relkind = 'r' AND n.nspname IN ('public', 'ytw_private')`,
    );
    expect(touched.toSorted()).toEqual(withUpdatedAt.map((row) => row.relation).toSorted());
    for (const row of rows) {
      expect(row.def).toMatch(/BEFORE UPDATE ON .* FOR EACH ROW EXECUTE FUNCTION ytw_touch\(/);
    }
    const versioned = rows
      .filter((row) => row.def.includes("'version'"))
      .map((row) => row.relation);
    expect(versioned.toSorted()).toEqual(["experiments", "ideas", "videos"]);
  });

  it("do not count API token use as a change, and write no audit row for it", async () => {
    const tokenId = await actAs(alice, (tx) => newToken(tx, f.userId));
    const state = () =>
      one<{ updated_at: Date; updated_by: string; last_used_at: Date | null }>(
        db.admin,
        sql`SELECT updated_at, updated_by, last_used_at FROM ytw_private.api_tokens WHERE id = ${tokenId}`,
      );
    const before = await state();
    const eventsBefore = (await eventsFor(tokenId)).length;

    await actAs({ ...bot, tokenId }, (tx) =>
      tx.query(sql`UPDATE ytw_private.api_tokens SET last_used_at = now() WHERE id = ${tokenId}`),
    );
    const used = await state();
    expect(used.last_used_at).not.toBeNull();
    expect({ at: used.updated_at, by: used.updated_by }).toEqual({
      at: before.updated_at,
      by: "alice",
    });
    expect(await eventsFor(tokenId)).toHaveLength(eventsBefore);

    await actAs(alice, (tx) =>
      tx.query(sql`UPDATE ytw_private.api_tokens SET revoked_at = now() WHERE id = ${tokenId}`),
    );
    expect((await state()).updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(await eventsFor(tokenId)).toHaveLength(eventsBefore + 1);
  });

  it("refuse writes without an audit actor", async () => {
    // Plain statements on the superuser pool: no withActor, so no ytw_set_actor.
    for (const statement of [
      sql`INSERT INTO ideas (title) VALUES ('nobody wrote this')`,
      sql`UPDATE ideas SET title = 'nobody' WHERE id = ${f.ideaId}`,
      sql`INSERT INTO notes (entity_type, entity_id, body_md) VALUES ('idea', ${f.ideaId}, 'anon')`,
      sql`INSERT INTO ytw_private.api_tokens (user_id, name, token_prefix, token_hash)
          VALUES (${f.userId}, 'anon', ${tokenPrefix()}, ${tokenHash()})`,
    ]) {
      expect(toDbError(await failure(db.admin.query(statement)))).toBeInstanceOf(MissingActorError);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("experiment winner", () => {
  it("must be a variant of the same experiment", async () => {
    const other = await actAs(alice, async (tx) => {
      const experimentId = await newExperiment(tx, f.videoId);
      return newVariant(tx, experimentId);
    });
    const experimentId = await actAs(alice, (tx) => newExperiment(tx, f.videoId));
    const failed = await pgFailure(
      actAs(alice, (tx) =>
        tx.query(
          sql`UPDATE experiments SET status = 'concluded', winner_variant_id = ${other}
               WHERE id = ${experimentId}`,
        ),
      ),
    );
    expect(failed).toMatchObject({ code: "23503", constraint: "experiments_winner_variant_fkey" });

    const own = await actAs(alice, (tx) => newVariant(tx, experimentId));
    await actAs(alice, (tx) =>
      tx.query(
        sql`UPDATE experiments SET status = 'concluded', winner_variant_id = ${own}, conclusion = 'B wins'
             WHERE id = ${experimentId}`,
      ),
    );
  });

  it("can be written before the variant within one transaction (deferred check)", async () => {
    const experimentId = randomUUID();
    const variantId = randomUUID();
    await actAs(alice, async (tx) => {
      await tx.query(
        sql`INSERT INTO experiments (id, video_id, type, status, winner_variant_id)
            VALUES (${experimentId}, ${f.videoId}, 'thumbnail', 'concluded', ${variantId})`,
      );
      await tx.query(
        sql`INSERT INTO experiment_variants (id, experiment_id, label, content)
            VALUES (${variantId}, ${experimentId}, 'A', '/thumbs/a.png')`,
      );
    });
    const stored = await one<{ winner_variant_id: string }>(
      db.admin,
      sql`SELECT winner_variant_id FROM experiments WHERE id = ${experimentId}`,
    );
    expect(stored.winner_variant_id).toBe(variantId);
  });
});

// ---------------------------------------------------------------------------------------------

describe("notes", () => {
  it.each([...NOTE_ENTITY_TYPES])(
    "attach to an existing %s and record who wrote them",
    async (entityType) => {
      const target: Record<(typeof NOTE_ENTITY_TYPES)[number], string> = {
        idea: f.ideaId,
        script: f.scriptId,
        video: f.videoId,
        experiment: f.experimentId,
      };
      const noteId = await actAs(bot, (tx) => newNote(tx, entityType, target[entityType]));
      const note = await one<{ author: string; actor_type: string; created_by: string }>(
        db.admin,
        sql`SELECT author, actor_type, created_by FROM notes WHERE id = ${noteId}`,
      );
      expect(note).toEqual({
        author: "research bot",
        actor_type: "agent",
        created_by: "research bot",
      });

      const missing = randomUUID();
      const err = toDbError(await failure(actAs(alice, (tx) => newNote(tx, entityType, missing))));
      expect(err).toBeInstanceOf(NotFoundError);
      const notFound = err as NotFoundError;
      expect({ entity: notFound.entity, id: notFound.id }).toEqual({
        entity: entityType,
        id: missing,
      });
      expect(notFound.message).toContain(`${entityType} ${missing} does not exist`);
    },
  );

  it("refuse an unknown entity type with the valid ones", async () => {
    const err = toDbError(await failure(actAs(alice, (tx) => newNote(tx, "channel", f.ideaId))));
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).allowed?.toSorted()).toEqual([...NOTE_ENTITY_TYPES].toSorted());
  });

  it("are append-only: never edited, moved, deleted or truncated", async () => {
    const noteId = await actAs(alice, (tx) => newNote(tx, "idea", f.ideaId, "First thoughts"));
    for (const statement of [
      sql`UPDATE notes SET body_md = 'Edited' WHERE id = ${noteId}`,
      sql`UPDATE notes SET entity_id = ${f.videoId}, entity_type = 'video' WHERE id = ${noteId}`,
      sql`UPDATE notes SET actor_type = 'agent' WHERE id = ${noteId}`,
      sql`DELETE FROM notes WHERE id = ${noteId}`,
      { text: "TRUNCATE notes", values: [] },
    ]) {
      const err = toDbError(await failure(actAs(alice, (tx) => tx.query(statement))));
      expect(err).toBeInstanceOf(ImmutableError);
      expect((err as ImmutableError).details).toMatchObject({ table: "notes" });
    }
    const note = await one<{ body_md: string; author: string; actor_type: string }>(
      db.admin,
      sql`SELECT body_md, author, actor_type FROM notes WHERE id = ${noteId}`,
    );
    expect(note).toEqual({ body_md: "First thoughts", author: "alice", actor_type: "human" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("privileges of the application roles", () => {
  it.each([...APP_ROLES])(
    "%s cannot insert, update, delete or truncate any table",
    async (role) => {
      const outcomes: Record<string, string> = {};
      await asRole(role, async (q) => {
        for (const table of ALL_TABLES) {
          for (const statement of [
            `INSERT INTO ${table} DEFAULT VALUES`,
            `UPDATE ${table} SET id = id`,
            `DELETE FROM ${table}`,
            `TRUNCATE ${table}`,
          ]) {
            const err = await pgFailure(q.query(statement));
            outcomes[statement] = err.code;
          }
        }
      });
      expect(Object.values(outcomes)).toHaveLength(ALL_TABLES.length * 4);
      expect(Object.entries(outcomes).filter(([, code]) => code !== "42501")).toEqual([]);
    },
  );

  const readers: Record<string, readonly AppRole[]> = {
    ...Object.fromEntries(PUBLIC_TABLES.map((table) => [`public.${table}`, APP_ROLES] as const)),
    // Identities and the access matrix: only the web server (sign-in, /api/me, settings).
    "public.users": ["ytw_web"],
    "public.user_permissions": ["ytw_web"],
    // Secrets: nobody; T14's SECURITY DEFINER functions are the only way in.
    "ytw_private.api_tokens": [],
    "ytw_private.api_token_permissions": [],
    "ytw_private.web_sessions": [],
  };

  it.each([...APP_ROLES])("%s reads exactly the tables granted to it", async (role) => {
    const outcomes: Record<string, string> = {};
    await asRole(role, async (q) => {
      for (const table of ALL_TABLES) {
        try {
          await q.query(`SELECT * FROM ${table} LIMIT 1`);
          outcomes[table] = "read";
        } catch (err) {
          const code: unknown = Reflect.get(err as object, "code");
          outcomes[table] = typeof code === "string" ? code : String(err);
        }
      }
    });
    // 42501: insufficient_privilege (the table, or the ytw_private schema).
    expect(outcomes).toEqual(
      Object.fromEntries(
        ALL_TABLES.map((table) => [table, readers[table]?.includes(role) ? "read" : "42501"]),
      ),
    );
  });

  it("cannot call the schema's helper functions", async () => {
    const helpers = [
      "public.ytw_current_actor_type()",
      "public.ytw_touch()",
      "public.ytw_valid_tags(text[])",
      "public.ytw_body_tsvector(text)",
      "public.ytw_scripts_revision_guard()",
      "public.ytw_notes_entity_guard()",
    ];
    const { rows } = await db.admin.query<{ role: string; fn: string; allowed: boolean }>(
      `SELECT r AS role, fn, has_function_privilege(r, fn, 'EXECUTE') AS allowed
         FROM unnest($1::text[]) r CROSS JOIN unnest($2::text[]) fn`,
      [APP_ROLES, helpers],
    );
    expect(rows).toHaveLength(APP_ROLES.length * helpers.length);
    expect(rows.filter((row) => row.allowed)).toEqual([]);
  });

  it("leave the catalog guard satisfied", async () => {
    expect((await db.admin.query("SELECT * FROM ytw_catalog_violations()")).rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("audit trail", () => {
  it("every business table has an AFTER INSERT OR UPDATE OR DELETE ytw_audit trigger", async () => {
    const { rows } = await db.admin.query<{
      relation: string;
      audited: boolean;
      def: string | null;
    }>(
      `SELECT c.oid::regclass::text AS relation, t.oid IS NOT NULL AS audited,
              pg_get_triggerdef(t.oid) AS def
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_trigger t ON t.tgrelid = c.oid AND NOT t.tgisinternal
                               AND t.tgfoid = 'public.ytw_audit()'::regprocedure
        WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'ytw_private')
          AND c.relname NOT IN ('events', 'schema_migrations', 'web_sessions', 'catalog_allowlist')`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(ALL_TABLES.length - 1);
    for (const row of rows) {
      expect({ relation: row.relation, audited: row.audited }).toEqual({
        relation: row.relation,
        audited: true,
      });
      expect(row.def).toMatch(
        /AFTER INSERT OR DELETE OR UPDATE ON .* FOR EACH ROW EXECUTE FUNCTION ytw_audit\('/,
      );
    }
    // web_sessions is deliberately not audited (0013_web_sessions.sql).
    const sessions = await db.admin.query(
      `SELECT 1 FROM pg_trigger WHERE tgrelid = 'ytw_private.web_sessions'::regclass AND NOT tgisinternal`,
    );
    expect(sessions.rowCount).toBe(0);
  });

  interface AuditCase {
    table: string;
    entity: string;
    insert: (tx: ActorTx) => Promise<string>;
    update?: (tx: ActorTx, id: string) => Promise<unknown>;
  }

  const cases: AuditCase[] = [
    {
      table: "users",
      entity: "user",
      insert: (tx) => newUser(tx),
      update: (tx, id) => tx.query(sql`UPDATE users SET display_name = 'Bob' WHERE id = ${id}`),
    },
    {
      table: "user_permissions",
      entity: "user_permission",
      insert: async (tx) =>
        insertId(
          tx,
          sql`INSERT INTO user_permissions (user_id, resource, level)
              VALUES (${await newUser(tx)}, 'ideas', 'read') RETURNING id`,
        ),
      update: (tx, id) =>
        tx.query(sql`UPDATE user_permissions SET level = 'write' WHERE id = ${id}`),
    },
    {
      table: "api_tokens",
      entity: "api_token",
      insert: (tx) => newToken(tx, f.userId),
      update: (tx, id) =>
        tx.query(sql`UPDATE ytw_private.api_tokens SET name = 'renamed' WHERE id = ${id}`),
    },
    {
      table: "api_token_permissions",
      entity: "api_token_permission",
      insert: async (tx) =>
        insertId(
          tx,
          sql`INSERT INTO ytw_private.api_token_permissions (token_id, resource, level)
              VALUES (${await newToken(tx, f.userId)}, 'scripts', 'none') RETURNING id`,
        ),
      update: (tx, id) =>
        tx.query(sql`UPDATE ytw_private.api_token_permissions SET level = 'read' WHERE id = ${id}`),
    },
    {
      table: "ideas",
      entity: "idea",
      insert: (tx) => newIdea(tx),
      update: (tx, id) => tx.query(sql`UPDATE ideas SET title = 'Better title' WHERE id = ${id}`),
    },
    {
      table: "scripts",
      entity: "script",
      insert: async (tx) => newScript(tx, await newIdea(tx)),
      update: (tx, id) => tx.query(sql`UPDATE scripts SET status = 'approved' WHERE id = ${id}`),
    },
    {
      table: "videos",
      entity: "video",
      insert: (tx) => newVideo(tx),
      update: (tx, id) => tx.query(sql`UPDATE videos SET title = 'Final title' WHERE id = ${id}`),
    },
    {
      table: "video_metrics",
      entity: "video_metric",
      insert: (tx) => newMetrics(tx, f.videoId, new Date(Date.now() - 86_400_000)),
    },
    {
      table: "experiments",
      entity: "experiment",
      insert: (tx) => newExperiment(tx, f.videoId),
      update: (tx, id) =>
        tx.query(sql`UPDATE experiments SET hypothesis = 'Faces win' WHERE id = ${id}`),
    },
    {
      table: "experiment_variants",
      entity: "experiment_variant",
      insert: (tx) => newVariant(tx, f.experimentId),
      update: (tx, id) =>
        tx.query(
          sql`UPDATE experiment_variants SET impressions = 1200, ctr = 4.5 WHERE id = ${id}`,
        ),
    },
    {
      // Append-only: inserts only.
      table: "notes",
      entity: "note",
      insert: (tx) => newNote(tx, "video", f.videoId),
    },
  ];

  it("covers every audited table in these cases", () => {
    expect(cases.map((c) => c.table).toSorted()).toEqual(
      [...PUBLIC_TABLES, "api_token_permissions", "api_tokens"].toSorted(),
    );
  });

  it.each(cases)("$table: one event per insert and per update, with the actor", async (c) => {
    // Inserted by an agent through its token, then (where rows can change) updated by a person.
    const id = await actAs(bot, (tx) => c.insert(tx));
    const update = c.update;
    if (update !== undefined) {
      await actAs(alice, (tx) => update(tx, id));
    }
    const expected = [
      { actor: "research bot", actor_type: "agent", token_id: f.tokenId, action: "insert" },
      ...(update === undefined
        ? []
        : [{ actor: "alice", actor_type: "human", token_id: null, action: "update" }]),
    ];
    expect(await eventsFor(id)).toEqual(
      expected.map((event) =>
        expect.objectContaining({ ...event, entity_type: c.entity, entity_id: id }),
      ),
    );
  });

  it("keeps secrets, personal identifiers and derived data out of payloads", async () => {
    const hash = tokenHash();
    const email = `bob-${unique()}@example.test`;
    const sub = randomUUID();
    const { tokenId, userId } = await actAs(alice, async (tx) => {
      const owner = await insertId(
        tx,
        sql`INSERT INTO users (oidc_issuer, oidc_sub, username, email)
            VALUES (${ISSUER}, ${sub}, ${`bob-${unique()}`}, ${email}) RETURNING id`,
      );
      const token = await insertId(
        tx,
        sql`INSERT INTO ytw_private.api_tokens (user_id, name, token_prefix, token_hash)
            VALUES (${owner}, 'editor bot', ${tokenPrefix()}, ${hash}) RETURNING id`,
      );
      await tx.query(
        sql`UPDATE ytw_private.api_tokens SET token_hash = ${tokenHash()} WHERE id = ${token}`,
      );
      await tx.query(sql`UPDATE users SET email = ${`new-${email}`} WHERE id = ${owner}`);
      return { tokenId: token, userId: owner };
    });
    const tokenEvents = JSON.stringify(await eventsFor(tokenId));
    expect(tokenEvents).not.toContain(hash);
    expect(tokenEvents).not.toMatch(/[0-9a-f]{64}/);
    const userEvents = JSON.stringify(await eventsFor(userId));
    expect(userEvents).not.toContain(email);
    expect(userEvents).not.toContain(sub);

    const ideaEvents = await eventsFor(f.ideaId);
    expect(ideaEvents[0]?.payload.new).toMatchObject({ title: "Kangaroo racing in the homelab" });
    expect(ideaEvents[0]?.payload.new).not.toHaveProperty("search_vector");
    expect(ideaEvents[0]?.payload.new).not.toHaveProperty("updated_by");

    const body = "x".repeat(10_000);
    const scriptId = await actAs(alice, async (tx) => newScript(tx, await newIdea(tx), { body }));
    expect((await eventsFor(scriptId))[0]?.payload.new).toMatchObject({
      body_md: { omitted: "too_large", bytes: body.length },
    });
  });

  it("never records a web session or its id", async () => {
    const before = await one<{ n: number }>(db.admin, "SELECT count(*)::int AS n FROM events");
    const sessionId = await actAs(alice, (tx) => newSession(tx, f.userId));
    await actAs(alice, (tx) =>
      tx.query(
        sql`UPDATE ytw_private.web_sessions SET last_seen_at = now() WHERE id = ${sessionId}`,
      ),
    );
    const after = await one<{ n: number }>(db.admin, "SELECT count(*)::int AS n FROM events");
    expect(after.n).toBe(before.n);
    const mentions = await one<{ n: number }>(
      db.admin,
      sql`SELECT count(*)::int AS n FROM events
           WHERE entity_id = ${sessionId} OR payload::text LIKE '%' || ${sessionId} || '%'`,
    );
    expect(mentions.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("full-text search vectors", () => {
  it("index idea titles (weight A) and pitches (weight B) and follow edits", async () => {
    const id = await actAs(alice, (tx) =>
      insertId(
        tx,
        sql`INSERT INTO ideas (title, pitch) VALUES ('Racing kangaroos', 'A Proxmox cluster story') RETURNING id`,
      ),
    );
    const matches = async (filter: string, words: string) =>
      (
        await one<{ hit: boolean }>(
          db.admin,
          sql`SELECT ts_filter(search_vector, ${filter}::"char"[]) @@ websearch_to_tsquery('english', ${words}) AS hit
                FROM ideas WHERE id = ${id}`,
        )
      ).hit;
    expect(await matches("{a}", "kangaroo")).toBe(true);
    expect(await matches("{b}", "kangaroo")).toBe(false);
    expect(await matches("{b}", "proxmox clusters")).toBe(true);

    await actAs(alice, (tx) =>
      tx.query(sql`UPDATE ideas SET title = 'Racing wallabies' WHERE id = ${id}`),
    );
    expect(await matches("{a,b}", "kangaroo")).toBe(false);
    expect(await matches("{a}", "wallaby")).toBe(true);
  });

  it("index script bodies, even a 1 MiB body of unrelated words", async () => {
    const words: string[] = ["zanzibar"];
    let size = "zanzibar".length;
    while (size < SCRIPT_BODY_MAX_BYTES - 40) {
      const word = randomBytes(16).toString("hex");
      words.push(word);
      size += word.length + 1;
    }
    const body = words.join(" ");
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(SCRIPT_BODY_MAX_BYTES);

    const ideaId = await actAs(alice, (tx) => newIdea(tx));
    const plain = await actAs(alice, (tx) =>
      newScript(tx, ideaId, { body: "# Hook\n\nWe benchmark **Ceph** against ZFS." }),
    );
    const huge = await actAs(alice, (tx) => newScript(tx, ideaId, { version: 2, body }));

    const hits = await db.admin.query<{ id: string }>(
      sql`SELECT id FROM scripts WHERE search_vector @@ websearch_to_tsquery('english', 'ceph benchmarks')
             OR search_vector @@ websearch_to_tsquery('english', 'zanzibar')`,
    );
    expect(hits.rows.map((row) => row.id).toSorted()).toEqual([plain, huge].toSorted());
  });
});
