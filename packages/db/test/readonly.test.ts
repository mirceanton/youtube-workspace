// ytw_readonly, the role behind the MCP query_sql tool (PRD 5). What protects it, in layers:
// no privileges at all; settings pinned on every connection the services open; a READ ONLY
// transaction whose snapshot is taken before the client's statement; exactly one statement; the
// connection thrown away afterwards. These tests try each way around those layers.
import { QUERY_SQL_TIMEOUT_MS } from "@ytw/shared/constants";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ROLES, createPool, queryReadOnly, roleConnectionOptions } from "../src/client.js";
import { ValidationError } from "../src/errors.js";
import { migrate } from "../src/migrate.js";
import { createTestDb, testServerUrl, type TestDb } from "../src/testing.js";
import { failure, sqlstate } from "./helpers.js";

let db: TestDb;
let readonly: Pool;

beforeAll(async () => {
  db = await createTestDb();
  readonly = db.pool("ytw_readonly");
});

afterAll(async () => {
  await db.drop();
});

async function settingsOf(client: Pool | Client) {
  const { rows } = await client.query<{ name: string; setting: string; source: string }>(
    `SELECT name, setting, source FROM pg_settings
      WHERE name IN ('default_transaction_read_only', 'statement_timeout') ORDER BY name`,
  );
  return rows;
}

describe("pinned connection settings", () => {
  it("are sent by every ytw_readonly pool, and only there", () => {
    expect(roleConnectionOptions("ytw_readonly")).toBe(
      `-c default_transaction_read_only=on -c statement_timeout=${QUERY_SQL_TIMEOUT_MS}`,
    );
    expect(roleConnectionOptions("ytw_web")).toBeUndefined();
    expect(roleConnectionOptions("ytw_mcp")).toBeUndefined();
  });

  it("override settings stored for the role, which the role can change itself", async () => {
    // Drift stored for this test database only, so no other database of the cluster sees it.
    await db.admin.query(
      `ALTER ROLE ytw_readonly IN DATABASE ${db.name} SET default_transaction_read_only = off`,
    );
    await db.admin.query(
      `ALTER ROLE ytw_readonly IN DATABASE ${db.name} SET statement_timeout = 0`,
    );
    try {
      const unpinned = new Client({ connectionString: db.url("ytw_readonly") });
      await unpinned.connect();
      const drifted = await settingsOf(unpinned);
      await unpinned.end();
      expect(drifted).toEqual([
        { name: "default_transaction_read_only", setting: "off", source: "database user" },
        { name: "statement_timeout", setting: "0", source: "database user" },
      ]);

      const pinned = createPool({
        role: "ytw_readonly",
        connectionString: db.url("ytw_readonly"),
        onError: () => undefined,
      });
      try {
        expect(await settingsOf(pinned)).toEqual([
          { name: "default_transaction_read_only", setting: "on", source: "client" },
          { name: "statement_timeout", setting: String(QUERY_SQL_TIMEOUT_MS), source: "client" },
        ]);
      } finally {
        await pinned.end();
      }

      // The next migration run puts the role's settings back and reports it.
      const result = await migrate({
        databaseUrl: db.url("admin"),
        lockDatabaseUrl: testServerUrl(),
      });
      expect(result.roleSettingsRestored).toEqual([
        `ytw_readonly: settings for database ${db.name} removed`,
      ]);
    } finally {
      await db.admin.query(`ALTER ROLE ytw_readonly IN DATABASE ${db.name} RESET ALL`);
    }
  });

  it("cannot stop ytw_readonly from changing its own role settings, which the guard reports", async () => {
    // Postgres lets every role ALTER its own settings; shown here and rolled back.
    const self = new Client({ connectionString: db.url("ytw_readonly") });
    await self.connect();
    try {
      await self.query("BEGIN READ WRITE");
      await self.query("ALTER ROLE ytw_readonly SET statement_timeout = 0");
      await self.query("ROLLBACK");
    } finally {
      await self.end();
    }

    // Seen by the guard and undone by ytw_enforce_role_settings(), here in a rolled-back
    // transaction so that no other test sees the drift.
    const admin = await db.admin.connect();
    try {
      await admin.query("BEGIN");
      await admin.query("ALTER ROLE ytw_readonly SET statement_timeout = 0");
      const drift = await admin.query<{ rule: string; detail: string }>(
        "SELECT rule, detail FROM ytw_catalog_violations() ORDER BY detail",
      );
      expect(drift.rows).toEqual([
        { rule: "app_role_settings", detail: "has an unexpected setting: statement_timeout=0" },
        { rule: "app_role_settings", detail: "is missing the setting statement_timeout=10s" },
      ]);
      const restored = await admin.query<{ line: string }>(
        "SELECT line FROM ytw_enforce_role_settings() AS line",
      );
      expect(restored.rows).toEqual([
        {
          line: "ytw_readonly: role settings restored (they were {default_transaction_read_only=on,statement_timeout=0})",
        },
      ]);
      expect((await admin.query("SELECT * FROM ytw_catalog_violations()")).rows).toEqual([]);
    } finally {
      await admin.query("ROLLBACK");
      admin.release();
    }
  });
});

describe("restricted built-in functions", () => {
  it("are not executable by any application role, even in a read-write session", async () => {
    for (const role of APP_ROLES) {
      const client = new Client({ connectionString: db.url(role) });
      await client.connect();
      try {
        await client.query("BEGIN READ WRITE");
        for (const call of [
          "SELECT lo_create(0)",
          "SELECT lo_from_bytea(0, 'x')",
          "SELECT pg_advisory_lock(42)",
          "SELECT pg_try_advisory_xact_lock(42)",
        ]) {
          await client.query("SAVEPOINT s");
          expect({ role, call, code: await sqlstate(client.query(call)) }).toEqual({
            role,
            call,
            code: "42501",
          });
          await client.query("ROLLBACK TO SAVEPOINT s");
        }
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    }
  });

  it("stay available to SECURITY DEFINER functions, which run as their owner", async () => {
    await db.admin.query(`
      CREATE FUNCTION public.locked_answer() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp
        AS $$ BEGIN PERFORM pg_advisory_xact_lock(4242); RETURN 42; END $$;
      REVOKE ALL ON FUNCTION public.locked_answer() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.locked_answer() TO ytw_web;`);
    const { rows } = await db
      .pool("ytw_web")
      .query<{ answer: number }>("SELECT locked_answer() AS answer");
    expect(rows[0]?.answer).toBe(42);
  });
});

describe("queryReadOnly", () => {
  it("returns the rows of one statement", async () => {
    const result = await queryReadOnly<{ n: number; who: string }>(
      readonly,
      "SELECT 41 + 1 AS n, current_user AS who",
    );
    expect(result.rows).toEqual([{ n: 42, who: "ytw_readonly" }]);
  });

  it("runs with the query_sql timeout by default", async () => {
    const result = await queryReadOnly<{ timeout: string; ro: string }>(
      readonly,
      "SELECT current_setting('statement_timeout') AS timeout, current_setting('transaction_read_only') AS ro",
    );
    expect(result.rows).toEqual([{ timeout: `${QUERY_SQL_TIMEOUT_MS / 1000}s`, ro: "on" }]);
  });

  it.each([
    ["two statements", "SELECT 1; SELECT 2", "42601"],
    ["a statement followed by a write", "SELECT 1; INSERT INTO events DEFAULT VALUES", "42601"],
    ["switching the transaction to read-write", "SET TRANSACTION READ WRITE", "25001"],
    [
      "switching it through set_config",
      "SELECT set_config('transaction_read_only', 'off', true)",
      "25001",
    ],
    [
      "a write",
      "INSERT INTO events (actor, actor_type, action) VALUES ('x', 'agent', 'insert')",
      "25006",
    ],
    [
      "changing its own role settings",
      "ALTER ROLE ytw_readonly SET statement_timeout = 0",
      "25006",
    ],
    ["creating a large object", "SELECT lo_create(0)", "42501"],
    ["taking an advisory lock", "SELECT pg_advisory_lock(8751751227628939122)", "42501"],
    ["reading a server file", "SELECT pg_read_file('/etc/passwd')", "42501"],
    ["running a program", "COPY (SELECT 1) TO PROGRAM 'id'", "42501"],
    ["switching role", "SET ROLE postgres", "42501"],
    ["reading ytw_private", "SELECT * FROM ytw_private.catalog_allowlist", "42501"],
    [
      "calling a database function",
      "SELECT ytw_log_event('x', 'agent', NULL, 'tool.call')",
      "42501",
    ],
  ])("refuses %s", async (_label, statement, code) => {
    expect(await sqlstate(queryReadOnly(readonly, statement))).toBe(code);
  });

  it("cancels a statement that runs past the timeout", async () => {
    expect(await sqlstate(queryReadOnly(readonly, "SELECT pg_sleep(5)", { timeoutMs: 200 }))).toBe(
      "57014",
    );
  });

  it("throws the connection away, so nothing a statement changed in its session survives", async () => {
    const first = await queryReadOnly<{ pid: number }>(
      readonly,
      "SELECT pg_backend_pid() AS pid, set_config('statement_timeout', '0', false)",
    );
    const second = await queryReadOnly<{ pid: number; timeout: string }>(
      readonly,
      "SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS timeout",
    );
    expect(second.rows[0]?.pid).not.toBe(first.rows[0]?.pid);
    expect(second.rows[0]?.timeout).toBe(`${QUERY_SQL_TIMEOUT_MS / 1000}s`);
    // The backend exits asynchronously after the client closes the connection.
    const deadline = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      const backends = await db.admin.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [
        first.rows[0]?.pid,
      ]);
      alive = backends.rowCount !== 0;
      if (alive) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(alive).toBe(false);
  });

  it("only runs on a ytw_readonly pool", async () => {
    const err = await failure(queryReadOnly(db.pool("ytw_web"), "SELECT 1"));
    expect(err.message).toMatch(/needs a ytw_readonly pool, but this connection is ytw_web/);
  });

  it("validates its arguments", async () => {
    expect(await failure(queryReadOnly(readonly, "  "))).toBeInstanceOf(ValidationError);
    expect(
      (await failure(queryReadOnly(readonly, "SELECT 1", { timeoutMs: QUERY_SQL_TIMEOUT_MS + 1 })))
        .message,
    ).toMatch(/timeoutMs must be an integer from 1 to/);
  });
});
