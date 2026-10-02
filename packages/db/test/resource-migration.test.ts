// "How to add a new object type to the permission matrix" (docs/policy.md, step 2), executed: a later
// migration that adds `sponsors` (write-capable) and `reports` (read-only) to a database that
// already has users and tokens. The SQL below is the one the guide shows; if the guide's procedure
// stops being enough (a function that spells out the object list, a constraint, a backfill), this
// test fails. The TypeScript wrappers refuse objects @ytw/shared does not know, so the checks use
// the SQL functions directly.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RESOURCES } from "@ytw/shared/constants";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor } from "../src/client.js";
import { migrate } from "../src/migrate.js";
import { createTestDb, testRolePasswords, testServerUrl, type TestDb } from "../src/testing.js";
import { copyMigrations, failure, sqlstate } from "./helpers.js";
import { grant, login, makeToken, newSecret, person, type TestUser } from "./identity-helpers.js";

const NEW_OBJECTS = ["sponsors", "reports"] as const;
const ALL_OBJECTS = [...RESOURCES, ...NEW_OBJECTS];

const MIGRATION = `
-- 0200_resource_sponsors: adds the objects "sponsors" (Write possible) and "reports" (Read at most).

-- 1. Accept the values (both permission tables).
ALTER TABLE public.user_permissions
  DROP CONSTRAINT user_permissions_resource_check,
  ADD CONSTRAINT user_permissions_resource_check
    CHECK (resource IN ('ideas', 'scripts', 'experiments', 'videos', 'notes', 'activity', 'sponsors', 'reports'));
ALTER TABLE ytw_private.api_token_permissions
  DROP CONSTRAINT api_token_permissions_resource_check,
  ADD CONSTRAINT api_token_permissions_resource_check
    CHECK (resource IN ('ideas', 'scripts', 'experiments', 'videos', 'notes', 'activity', 'sponsors', 'reports'));

-- 2. Read-only objects never hold Write ("reports" only; skip this for a write-capable object).
ALTER TABLE public.user_permissions
  DROP CONSTRAINT user_permissions_read_only_check,
  ADD CONSTRAINT user_permissions_read_only_check
    CHECK (level <> 'write' OR resource NOT IN ('activity', 'reports'));
ALTER TABLE ytw_private.api_token_permissions
  DROP CONSTRAINT api_token_permissions_read_only_check,
  ADD CONSTRAINT api_token_permissions_read_only_check
    CHECK (level <> 'write' OR resource NOT IN ('activity', 'reports'));

-- 3. The object list and the maximum level per object: the only two functions that spell them out.
CREATE OR REPLACE FUNCTION public.ytw_resources()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT ARRAY['ideas', 'scripts', 'experiments', 'videos', 'notes', 'activity', 'sponsors', 'reports']::text[]
$$;

CREATE OR REPLACE FUNCTION public.ytw_max_level(p_resource text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_resource = ANY (ARRAY['activity', 'reports']::text[]) THEN 'read'
    WHEN p_resource = ANY (public.ytw_resources()) THEN 'write'
  END
$$;

-- 4. A row for every existing user (admins: the maximum) and every existing token (none).
SELECT public.ytw_set_actor('migration 0200_resource_sponsors', 'human', NULL);

INSERT INTO public.user_permissions (user_id, resource, level)
SELECT u.id, r.resource, CASE WHEN u.is_admin THEN public.ytw_max_level(r.resource) ELSE 'none' END
FROM public.users u
CROSS JOIN (VALUES ('sponsors'), ('reports')) AS r (resource)
ON CONFLICT (user_id, resource) DO NOTHING;

INSERT INTO ytw_private.api_token_permissions (token_id, resource, level)
SELECT t.id, r.resource, 'none'
FROM ytw_private.api_tokens t
CROSS JOIN (VALUES ('sponsors'), ('reports')) AS r (resource)
ON CONFLICT (token_id, resource) DO NOTHING;
`;

let db: TestDb;
let root: TestUser;
let writer: TestUser;
let reader: TestUser;
let oldToken: Awaited<ReturnType<typeof makeToken>>;
let cleanup: () => Promise<void>;
let migrationsDir = "";
let applied: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  root = await login(db, "root");
  writer = await login(db, "writer");
  reader = await login(db, "reader");
  await grant(db, root, writer, { ideas: "write", scripts: "read" });
  oldToken = await makeToken(db, writer, { permissions: { ideas: "write" } });

  // Apply the guide's migration on top of the database as it is.
  const copy = await copyMigrations();
  cleanup = copy.remove;
  migrationsDir = copy.dir;
  await writeFile(join(copy.dir, "0200_resource_sponsors.sql"), MIGRATION);
  const result = await migrate({
    databaseUrl: db.url("admin"),
    lockDatabaseUrl: testServerUrl(),
    rolePasswords: testRolePasswords(),
    migrationsDir: copy.dir,
  });
  applied = result.applied;
});

afterAll(async () => {
  await cleanup();
  await db.drop();
});

async function levelsOf(userId: string): Promise<Record<string, string>> {
  const { rows } = await db
    .pool("ytw_web")
    .query<{ levels: Record<string, string> }>("SELECT levels FROM get_user_access($1)", [userId]);
  return rows[0]?.levels ?? {};
}

describe("a database with users and tokens after the object-type migration", () => {
  it("applied exactly the new file on top of the existing history", () => {
    expect(applied).toEqual(["0200_resource_sponsors.sql"]);
  });

  it("lists the new objects and their maximum levels", async () => {
    const { rows } = await db.admin.query<{ resources: string[] }>(
      "SELECT ytw_resources() AS resources",
    );
    expect(rows[0]?.resources).toEqual(ALL_OBJECTS);
    const max = await db.admin.query<{ resource: string; max: string }>(
      "SELECT r AS resource, ytw_max_level(r) AS max FROM unnest(ytw_resources()) r",
    );
    expect(Object.fromEntries(max.rows.map((row) => [row.resource, row.max]))).toEqual({
      ideas: "write",
      scripts: "write",
      experiments: "write",
      videos: "write",
      notes: "write",
      activity: "read",
      sponsors: "write",
      reports: "read",
    });
  });

  it("gave every existing user a row for each new object: admins the maximum, everyone else none", async () => {
    expect(await levelsOf(root.id)).toMatchObject({ sponsors: "write", reports: "read" });
    expect(await levelsOf(writer.id)).toMatchObject({ sponsors: "none", reports: "none" });
    expect(await levelsOf(reader.id)).toMatchObject({ sponsors: "none", reports: "none" });
    const { rows } = await db.admin.query<{ user_id: string; n: number }>(
      "SELECT user_id, count(*)::int AS n FROM user_permissions GROUP BY user_id",
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.n === ALL_OBJECTS.length)).toBe(true);
    // The stored admin rows are the maximum too, not only the computed levels.
    const stored = await db.admin.query<{ resource: string; level: string }>(
      "SELECT resource, level FROM user_permissions WHERE user_id = $1 AND resource = ANY ($2)",
      [root.id, [...NEW_OBJECTS]],
    );
    expect(Object.fromEntries(stored.rows.map((row) => [row.resource, row.level]))).toEqual({
      sponsors: "write",
      reports: "read",
    });
  });

  it("gave every existing token none on the new objects, so access to them is always granted on purpose", async () => {
    const { rows } = await db.pool("ytw_mcp").query<{
      token_levels: Record<string, string>;
      effective_levels: Record<string, string>;
    }>("SELECT token_levels, effective_levels FROM lookup_token_by_hash($1)", [oldToken.hash]);
    expect(rows[0]?.token_levels).toMatchObject({
      ideas: "write",
      sponsors: "none",
      reports: "none",
    });
    expect(rows[0]?.effective_levels).toMatchObject({
      ideas: "write",
      sponsors: "none",
      reports: "none",
    });
  });

  it("logged the backfill under the migration's actor", async () => {
    const { rows } = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events
        WHERE actor = 'migration 0200_resource_sponsors' AND actor_type = 'human' AND action = 'insert'`,
    );
    // 3 users x 2 objects + 1 token x 2 objects.
    expect(rows[0]?.n).toBe(8);
  });

  it("new users get rows for every object; the first-admin rule and the matrix cover the new objects", async () => {
    const { rows } = await db
      .pool("ytw_web")
      .query<{ levels: Record<string, string> }>(
        "SELECT levels FROM upsert_user_on_login('newbie', 'human', NULL, 'https://id.example.test', 'newbie-sub', 'newbie')",
      );
    expect(Object.keys(rows[0]?.levels ?? {}).toSorted()).toEqual([...ALL_OBJECTS].toSorted());
    expect(Object.values(rows[0]?.levels ?? {}).every((level) => level === "none")).toBe(true);

    const set = await db
      .pool("ytw_web")
      .query<{ resource: string; level: string; changed: boolean }>(
        "SELECT * FROM set_user_permission('root', 'human', NULL, $1, $2, 'sponsors', 'write')",
        [root.id, writer.id],
      );
    expect(set.rows[0]).toMatchObject({ resource: "sponsors", level: "write", changed: true });
    const readOnly = await failure(
      db
        .pool("ytw_web")
        .query(
          "SELECT * FROM set_user_permission('root', 'human', NULL, $1, $2, 'reports', 'write')",
          [root.id, writer.id],
        ),
    );
    expect(readOnly.message).toBe(
      "write is never allowed on reports (the maximum is read); choose one of: none, read",
    );
    expect(
      await sqlstate(
        db
          .pool("ytw_web")
          .query(
            "SELECT * FROM set_user_permission('root', 'human', NULL, $1, $2, 'sponsorz', 'read')",
            [root.id, writer.id],
          ),
      ),
    ).toBe("YT001");
  });

  it("tokens can be given the new objects up to the owner's level, and no further", async () => {
    const create = (owner: TestUser, name: string, permissions: string) => {
      const made = newSecret();
      return db
        .pool("ytw_web")
        .query<{ levels: Record<string, string> }>(
          `SELECT levels FROM create_api_token($1, 'human', NULL, $2, $3, $4, $5, NULL, $6::jsonb)`,
          [owner.username, owner.id, name, made.prefix, made.hash, permissions],
        )
        .then((result) => ({ levels: result.rows[0]?.levels, hash: made.hash }));
    };

    // writer now has Write on sponsors (set above); reader has none.
    const ok = await create(writer, "sponsor bot", '{"sponsors": "write"}');
    expect(ok.levels).toMatchObject({ sponsors: "write", reports: "none", ideas: "none" });
    const found = await db
      .pool("ytw_mcp")
      .query<{ effective_levels: Record<string, string> }>(
        "SELECT effective_levels FROM lookup_token_by_hash($1)",
        [ok.hash],
      );
    expect(found.rows[0]?.effective_levels).toMatchObject({ sponsors: "write", reports: "none" });

    // The admin may hand out the maximum of each: Write on sponsors, Read on reports.
    const admin = await create(root, "admin bot", '{"sponsors": "write", "reports": "read"}');
    expect(admin.levels).toMatchObject({ sponsors: "write", reports: "read", ideas: "none" });

    // Above the owner's level, or Write on a read-only object, is refused with what would be accepted.
    const tooHigh = await failure(create(writer, "too high", '{"reports": "read"}'));
    expect(tooHigh.message).toContain(
      "read on reports is above the owner's own level (none); a token never exceeds its owner; choose one of: none",
    );
    const neverWrite = await failure(create(root, "never write", '{"reports": "write"}'));
    expect(neverWrite.message).toBe(
      "token permissions rejected: write is never allowed on reports (it allows none, read); choose one of: none, read",
    );
  });

  it("the tables themselves accept the new objects, and a read-only object never holds write", async () => {
    const unknownObject = await failure(
      withActor(db.admin, person("fixer"), (tx) =>
        tx.query(
          "INSERT INTO user_permissions (user_id, resource, level) VALUES ($1, 'bogus', 'read')",
          [reader.id],
        ),
      ),
    );
    expect(unknownObject).toMatchObject({ constraint: "user_permissions_resource_check" });

    const writeOnReports = await failure(
      withActor(db.admin, person("fixer"), (tx) =>
        tx.query(
          "UPDATE user_permissions SET level = 'write' WHERE user_id = $1 AND resource = 'reports'",
          [reader.id],
        ),
      ),
    );
    expect(writeOnReports).toMatchObject({ constraint: "user_permissions_read_only_check" });
    const tokenWrite = await failure(
      withActor(db.admin, person("fixer"), (tx) =>
        tx.query(
          "UPDATE ytw_private.api_token_permissions SET level = 'write' WHERE resource = 'reports'",
        ),
      ),
    );
    expect(tokenWrite).toMatchObject({ constraint: "api_token_permissions_read_only_check" });

    // A write-capable object accepts write in both tables.
    await withActor(db.admin, person("fixer"), (tx) =>
      tx.query(
        "UPDATE user_permissions SET level = 'write' WHERE user_id = $1 AND resource = 'sponsors'",
        [reader.id],
      ),
    );
    const { rows } = await db.admin.query<{ level: string }>(
      "SELECT level FROM user_permissions WHERE user_id = $1 AND resource = 'sponsors'",
      [reader.id],
    );
    expect(rows[0]?.level).toBe("write");
  });

  it("the catalog guard is still satisfied and running the migrations again is a no-op", async () => {
    expect((await db.admin.query("SELECT * FROM ytw_catalog_violations()")).rows).toEqual([]);
    const again = await migrate({
      databaseUrl: db.url("admin"),
      lockDatabaseUrl: testServerUrl(),
      rolePasswords: testRolePasswords(),
      migrationsDir,
    });
    expect(again.applied).toEqual([]);
  });
});
