// Catalog and privilege audit (PRD 5 "Database roles", PRD 9 "Security"). These tests run against
// every migration in the directory, so they keep covering the schema as later tasks add to it.
import { QUERY_SQL_TIMEOUT_MS } from "@ytw/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ROLES } from "../src/client.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { sqlstate } from "./helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

/** Runs `statements` as the superuser inside a transaction that is always rolled back. */
async function violationsAfter(statements: string): Promise<{ rule: string; object: string; detail: string }[]> {
  const client = await db.admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(statements);
    const { rows } = await client.query<{ rule: string; object: string; detail: string }>(
      "SELECT rule, object, detail FROM ytw_catalog_violations()",
    );
    return rows;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("catalog guard", () => {
  it("finds no violation in the migrated schema", async () => {
    const { rows } = await db.admin.query("SELECT * FROM ytw_catalog_violations()");
    expect(rows).toEqual([]);
  });

  // Each scenario is applied in a rolled-back transaction; the guard must name the broken rule.
  const scenarios: [string, string, string][] = [
    ["table_write_privilege", "GRANT INSERT ON events TO ytw_web", "public.events"],
    ["table_write_privilege", "GRANT UPDATE (payload) ON events TO ytw_mcp", "column-level UPDATE"],
    ["table_write_privilege", "GRANT DELETE ON events TO PUBLIC", "ytw_readonly has DELETE"],
    ["table_write_privilege", "GRANT TRUNCATE ON schema_migrations TO ytw_readonly", "TRUNCATE"],
    [
      "table_write_privilege",
      "CREATE VIEW recent AS SELECT id, actor FROM events; GRANT INSERT ON recent TO ytw_web",
      "public.recent",
    ],
    ["sequence_privilege", "CREATE SEQUENCE counter; GRANT USAGE ON counter TO ytw_mcp", "USAGE"],
    ["schema_create", "GRANT CREATE ON SCHEMA public TO ytw_web", "has CREATE"],
    [
      "database_privilege",
      "DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO ytw_mcp', current_database()); END $$",
      "TEMPORARY",
    ],
    ["private_schema_access", "GRANT USAGE ON SCHEMA ytw_private TO ytw_readonly", "USAGE"],
    [
      "private_schema_access",
      "CREATE TABLE ytw_private.vault (secret text); GRANT SELECT ON ytw_private.vault TO ytw_readonly",
      "ytw_private.vault",
    ],
    ["secret_table_location", "CREATE TABLE public.web_sessions (id int)", "public.web_sessions"],
    ["secret_table_location", "CREATE TABLE public.api_tokens (id int)", "public.api_tokens"],
    ["app_role_owns_object", "CREATE TABLE owned (id int); ALTER TABLE owned OWNER TO ytw_web", "public.owned"],
    ["app_role_membership", "GRANT pg_read_all_data TO ytw_readonly", "pg_read_all_data"],
    ["app_role_attributes", "ALTER ROLE ytw_mcp CREATEDB", "ytw_mcp"],
    [
      "function_public_execute",
      "CREATE FUNCTION open_door() RETURNS int LANGUAGE sql AS 'SELECT 1'; GRANT EXECUTE ON FUNCTION open_door() TO PUBLIC",
      "open_door()",
    ],
    [
      "definer_search_path",
      "CREATE FUNCTION loose() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'; REVOKE ALL ON FUNCTION loose() FROM PUBLIC",
      "loose()",
    ],
    [
      "definer_search_path",
      "CREATE FUNCTION almost() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog AS 'SELECT 1'; REVOKE ALL ON FUNCTION almost() FROM PUBLIC",
      "almost()",
    ],
    [
      "readonly_volatile_definer",
      "GRANT EXECUTE ON FUNCTION ytw_log_event(text, text, uuid, text, text, uuid, jsonb) TO ytw_readonly",
      "ytw_log_event",
    ],
  ];

  it.each(scenarios)("reports %s for: %s", async (rule, statements, mention) => {
    const rows = await violationsAfter(statements);
    const hits = rows.filter((row) => row.rule === rule);
    expect(hits.length, JSON.stringify(rows)).toBeGreaterThan(0);
    expect(hits.some((row) => `${row.object} ${row.detail}`.includes(mention)), JSON.stringify(hits)).toBe(true);
  });
});

describe("application roles", () => {
  it("are plain login roles that belong to no other role", async () => {
    const { rows } = await db.admin.query(
      `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolcanlogin,
              (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)::int AS memberships
         FROM pg_roles r WHERE rolname = ANY ($1) ORDER BY rolname`,
      [APP_ROLES],
    );
    expect(rows).toEqual(
      [...APP_ROLES].sort().map((rolname) => ({
        rolname,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
        rolcanlogin: true,
        memberships: 0,
      })),
    );
  });

  it("hold no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER privilege anywhere", async () => {
    // Independent of ytw_catalog_violations(): every relation outside the system schemas.
    const { rows } = await db.admin.query(
      `SELECT r.rolname, c.oid::regclass::text AS relation, p.priv
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN unnest($1::text[]) AS r (rolname)
         CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p (priv)
        WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (has_table_privilege(r.rolname, c.oid, p.priv)
               OR (p.priv IN ('INSERT', 'UPDATE', 'REFERENCES')
                   AND has_any_column_privilege(r.rolname, c.oid, p.priv)))`,
      [APP_ROLES],
    );
    expect(rows).toEqual([]);
  });

  it("cannot write the audit log or create objects, even when they try", async () => {
    const web = db.pool("ytw_web");
    expect(
      await sqlstate(
        web.query("INSERT INTO events (actor, actor_type, action) VALUES ('mallory', 'human', 'insert')"),
      ),
    ).toBe("42501");
    expect(await sqlstate(web.query("UPDATE events SET actor = 'mallory'"))).toBe("42501");
    expect(await sqlstate(web.query("DELETE FROM events"))).toBe("42501");
    expect(await sqlstate(web.query("TRUNCATE events"))).toBe("42501");
    expect(await sqlstate(web.query("CREATE TABLE public.mine (id int)"))).toBe("42501");
    expect(await sqlstate(web.query("CREATE TEMP TABLE scratch (id int)"))).toBe("42501");
    expect(await sqlstate(web.query("CREATE SCHEMA mine"))).toBe("42501");
    expect(await sqlstate(db.pool("ytw_mcp").query("DELETE FROM schema_migrations"))).toBe("42501");
  });

  it("can execute only functions granted to them explicitly", async () => {
    const { rows } = await db.admin.query<{ fn: string; grantees: string[] }>(
      `SELECT p.oid::regprocedure::text AS fn,
              coalesce(array_agg(DISTINCT g.rolname ORDER BY g.rolname)
                       FILTER (WHERE g.rolname IS NOT NULL), '{}') AS grantees
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         LEFT JOIN LATERAL aclexplode(p.proacl) a ON true
         LEFT JOIN pg_roles g ON g.oid = a.grantee AND g.rolname = ANY ($1)
        WHERE n.nspname IN ('public', 'ytw_private')
          AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0))
        GROUP BY 1`,
      [APP_ROLES],
    );
    // No function is executable by PUBLIC (a NULL ACL would mean PUBLIC by default).
    expect(rows).toEqual([]);

    const definers = await db.admin.query<{ fn: string; config: string[] | null }>(
      `SELECT p.oid::regprocedure::text AS fn, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'ytw_private') AND p.prosecdef`,
    );
    expect(definers.rows.length).toBeGreaterThan(0);
    for (const row of definers.rows) {
      expect(row.config, row.fn).toContain("search_path=pg_catalog, public, pg_temp");
    }
  });
});

describe("ytw_readonly", () => {
  it("starts every session read-only with the query_sql statement timeout", async () => {
    const client = await db.pool("ytw_readonly").connect();
    try {
      const readOnly = await client.query<{ default_transaction_read_only: string }>(
        "SHOW default_transaction_read_only",
      );
      const timeout = await client.query<{ statement_timeout: string }>("SHOW statement_timeout");
      expect(readOnly.rows[0]?.default_transaction_read_only).toBe("on");
      expect(timeout.rows[0]?.statement_timeout).toBe(`${QUERY_SQL_TIMEOUT_MS / 1000}s`);
    } finally {
      client.release();
    }
  });

  it("cannot write even after switching the session to read-write", async () => {
    const client = await db.pool("ytw_readonly").connect();
    try {
      expect(
        await sqlstate(
          client.query("INSERT INTO events (actor, actor_type, action) VALUES ('x', 'agent', 'insert')"),
        ),
      ).toBe("25006");
      await client.query("SET default_transaction_read_only = off");
      expect(
        await sqlstate(
          client.query("INSERT INTO events (actor, actor_type, action) VALUES ('x', 'agent', 'insert')"),
        ),
      ).toBe("42501");
      expect(
        await sqlstate(
          client.query("SELECT ytw_log_event('x', 'agent', NULL, 'tool.call', NULL, NULL, '{}')"),
        ),
      ).toBe("42501");
      expect(await sqlstate(client.query("SELECT ytw_set_actor('x', 'agent', NULL)"))).toBe("42501");
    } finally {
      client.release(true);
    }
  });

  it("can read the audit log but nothing in ytw_private, even with a stray table grant", async () => {
    const readonly = db.pool("ytw_readonly");
    await readonly.query("SELECT count(*) FROM events");

    await db.admin.query("CREATE TABLE ytw_private.secret_fixture (token_hash text)");
    try {
      await db.admin.query("GRANT SELECT ON ytw_private.secret_fixture TO ytw_readonly");
      expect(await sqlstate(readonly.query("SELECT * FROM ytw_private.secret_fixture"))).toBe("42501");
      expect(await sqlstate(db.pool("ytw_web").query("SELECT * FROM ytw_private.secret_fixture"))).toBe(
        "42501",
      );
    } finally {
      await db.admin.query("DROP TABLE ytw_private.secret_fixture");
    }
  });

  it("cannot read the secret-bearing tables wherever later migrations create them", async () => {
    // api_tokens and web_sessions arrive with T11; once they exist this checks the real tables.
    const { rows } = await db.admin.query<{ relation: string; schema: string; readable: boolean }>(
      `SELECT c.oid::regclass::text AS relation, n.nspname AS schema,
              has_any_column_privilege('ytw_readonly', c.oid, 'SELECT')
                AND has_schema_privilege('ytw_readonly', n.oid, 'USAGE') AS readable
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname IN ('api_tokens', 'web_sessions') AND c.relkind IN ('r', 'p', 'v', 'm')`,
    );
    for (const row of rows) {
      expect(row, row.relation).toMatchObject({ schema: "ytw_private", readable: false });
      expect(await sqlstate(db.pool("ytw_readonly").query(`SELECT * FROM ${row.relation} LIMIT 1`))).toBe(
        "42501",
      );
    }
    const schema = await db.admin.query<{ usage: boolean }>(
      "SELECT has_schema_privilege('ytw_readonly', 'ytw_private', 'USAGE') AS usage",
    );
    expect(schema.rows[0]?.usage).toBe(false);
  });
});
