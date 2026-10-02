import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MIGRATION_LOCK_KEY,
  MigrationError,
  defaultMigrationsDir,
  loadMigrations,
  migrate,
  migrationStatus,
  rolePasswordStatus,
  scramSha256Verifier,
} from "../src/migrate.js";
import { createTestDb, testRolePasswords, testServerUrl, type TestDb } from "../src/testing.js";
import { copyMigrations, failure } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  // The harness checks that the roles' passwords are the test passwords (setting them only on a
  // fresh cluster), so the runner calls below that pass the same passwords change nothing.
  await (await createTestDb()).drop();
});

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** An empty database plus a private copy of the migrations, both removed after the file. */
async function scenario(): Promise<{ db: TestDb; dir: string }> {
  const db = await createTestDb({ migrate: false });
  const copy = await copyMigrations();
  cleanups.push(() => db.drop(), copy.remove);
  return { db, dir: copy.dir };
}

/** A temporary directory holding exactly `files`, removed after the file. */
async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ytw-db-files-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

function run(db: TestDb, dir: string, extra: { lockTimeoutMs?: number } = {}) {
  return migrate({
    databaseUrl: db.url("admin"),
    lockDatabaseUrl: testServerUrl(),
    rolePasswords: testRolePasswords(),
    migrationsDir: dir,
    ...extra,
  });
}

async function appliedRows(db: TestDb) {
  const { rows } = await db.admin.query<{
    version: string;
    filename: string;
    checksum: string;
    applied_at: Date;
  }>("SELECT version, filename, checksum, applied_at FROM schema_migrations ORDER BY version");
  return rows;
}

describe("migrate", () => {
  it("applies every file in order on a fresh database and records checksums", async () => {
    const { db, dir } = await scenario();
    const files = await loadMigrations(dir);
    expect(files.length).toBeGreaterThanOrEqual(4);

    const lines: string[] = [];
    const result = await migrate({
      databaseUrl: db.url("admin"),
      lockDatabaseUrl: testServerUrl(),
      rolePasswords: testRolePasswords(),
      migrationsDir: dir,
      log: (line) => lines.push(line),
    });

    expect(result.applied).toEqual(files.map((file) => file.filename));
    expect(result.alreadyApplied).toBe(0);
    // The passwords already match (beforeAll), so the runner leaves them alone.
    expect(result.passwordsSet).toEqual([]);
    expect(lines).toEqual(
      expect.arrayContaining([
        "ytw_web: password already current",
        "ytw_mcp: password already current",
        "ytw_readonly: password already current",
      ]),
    );
    const rows = await appliedRows(db);
    expect(
      rows.map(({ version, filename, checksum }) => ({ version, filename, checksum })),
    ).toEqual(files.map(({ version, filename, checksum }) => ({ version, filename, checksum })));
    expect(await migrationStatus(db.admin, dir)).toMatchObject({ upToDate: true, pending: [] });
    // Progress lines never carry a password.
    for (const password of Object.values(testRolePasswords())) {
      expect(lines.join("\n")).not.toContain(password);
    }
  });

  it("is a no-op when run again", async () => {
    const { db, dir } = await scenario();
    await run(db, dir);
    const before = await appliedRows(db);
    const objects = async () =>
      (await db.admin.query<{ n: string }>("SELECT count(*) AS n FROM pg_class")).rows[0]?.n;
    const objectsBefore = await objects();

    const second = await run(db, dir);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(before.length);
    expect(await appliedRows(db)).toEqual(before);
    expect(await objects()).toBe(objectsBefore);
  });

  it("applies each file once when two runs race on the same database", async () => {
    const { db, dir } = await scenario();
    const files = await loadMigrations(dir);
    // No shared lock database and no passwords: only the per-database lock serialises these two.
    const bare = () => migrate({ databaseUrl: db.url("admin"), migrationsDir: dir });
    const results = await Promise.all([bare(), bare()]);
    const counts = results.map((result) => result.applied.length).toSorted((a, b) => a - b);
    expect(counts).toEqual([0, files.length]);
    expect(await appliedRows(db)).toHaveLength(files.length);
  });

  it("rejects an applied file that was edited, and then applies nothing at all", async () => {
    const { db, dir } = await scenario();
    await run(db, dir);
    const target = join(dir, "0003_core_functions.sql");
    await writeFile(target, `${await readFile(target, "utf8")}\n-- an innocent-looking edit\n`);
    await writeFile(join(dir, "9001_new_feature.sql"), "CREATE TABLE new_feature (id int);");

    const err = await failure(run(db, dir));

    expect(err).toBeInstanceOf(MigrationError);
    expect(err.message).toMatch(/0003_core_functions\.sql was changed after it was applied/);
    expect(err.message).toMatch(/immutable/);
    expect((await appliedRows(db)).map((row) => row.version)).not.toContain("9001");
    const table = await db.admin.query("SELECT to_regclass('public.new_feature') AS t");
    expect(table.rows[0]?.t).toBeNull();
    expect(await migrationStatus(db.admin, dir)).toMatchObject({
      upToDate: false,
      changed: ["0003_core_functions.sql"],
      pending: ["9001_new_feature.sql"],
    });
  });

  it("rejects renamed and deleted applied files", async () => {
    const { db, dir } = await scenario();
    await run(db, dir);
    await rename(join(dir, "0002_catalog_guard.sql"), join(dir, "0002_renamed_guard.sql"));
    await unlink(join(dir, "0004_audit.sql"));

    const err = await failure(run(db, dir));

    expect(err.message).toMatch(
      /0002_catalog_guard\.sql was applied but is now named 0002_renamed_guard\.sql/,
    );
    expect(err.message).toMatch(/0004_audit\.sql is recorded as applied but is missing/);
    expect(await migrationStatus(db.admin, dir)).toMatchObject({
      upToDate: false,
      changed: ["0002_catalog_guard.sql"],
      unknown: ["0004_audit.sql"],
    });
  });

  it("rejects a pending file numbered below the newest applied one", async () => {
    const { db, dir } = await scenario();
    await writeFile(join(dir, "9500_later.sql"), "SELECT 1;");
    await run(db, dir);
    await writeFile(join(dir, "9400_earlier.sql"), "SELECT 1;");

    const err = await failure(run(db, dir));

    expect(err.message).toMatch(
      /9400_earlier\.sql is pending but older than the newest applied migration \(9500\)/,
    );
  });

  it("rolls a failing file back completely and reports the file and line", async () => {
    const { db, dir } = await scenario();
    await writeFile(
      join(dir, "9001_broken.sql"),
      "CREATE TABLE half_done (id int);\nSELECT 1;\nSELEC oops;\n",
    );

    const err = await failure(run(db, dir));

    expect(err).toBeInstanceOf(MigrationError);
    expect(err.message).toMatch(/9001_broken\.sql failed at line 3: syntax error/);
    expect(err.message).toMatch(/SQLSTATE 42601/);
    const table = await db.admin.query("SELECT to_regclass('public.half_done') AS t");
    expect(table.rows[0]?.t).toBeNull();
    const versions = (await appliedRows(db)).map((row) => row.version);
    expect(versions).toContain("0004");
    expect(versions).not.toContain("9001");
  });

  it("rolls back a file that would give an application role a write privilege", async () => {
    const { db, dir } = await scenario();
    await writeFile(
      join(dir, "9001_leaky.sql"),
      "CREATE TABLE leaky (id int);\nGRANT SELECT, INSERT ON leaky TO ytw_web;\n",
    );

    const err = await failure(run(db, dir));

    expect(err.message).toMatch(/9001_leaky\.sql breaks the privilege rules/);
    expect(err.message).toMatch(/table_write_privilege: public\.leaky ytw_web has INSERT/);
    const table = await db.admin.query("SELECT to_regclass('public.leaky') AS t");
    expect(table.rows[0]?.t).toBeNull();
  });

  it("fails with a clear error when another run holds the lock too long", async () => {
    const { db, dir } = await scenario();
    const holder = new Client({ connectionString: db.url("admin") });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
      const err = await failure(run(db, dir, { lockTimeoutMs: 300 }));
      expect(err).toBeInstanceOf(MigrationError);
      expect(err.message).toMatch(/another migration run held the lock/);
    } finally {
      await holder.end();
    }
    expect(await appliedRows(db).catch(() => [])).toEqual([]);
  });

  it("restores role settings that drifted before it applies anything", async () => {
    const { db, dir } = await scenario();
    await run(db, dir);
    // A setting stored for this database only, so no other database of the cluster sees it.
    await db.admin.query(
      `ALTER ROLE ytw_readonly IN DATABASE ${db.name} SET default_transaction_read_only = off`,
    );
    const drift = await db.admin.query("SELECT rule FROM ytw_catalog_violations()");
    expect(drift.rows).toEqual([{ rule: "app_role_settings" }]);

    const result = await run(db, dir);

    expect(result.roleSettingsRestored).toEqual([
      `ytw_readonly: settings for database ${db.name} removed`,
    ]);
    const left = await db.admin.query(
      "SELECT 1 FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = $1)",
      [db.name],
    );
    expect(left.rowCount).toBe(0);
  });

  it("refuses to run on a database that already breaks the privilege rules", async () => {
    const { db, dir } = await scenario();
    await run(db, dir);
    await writeFile(join(dir, "9001_next.sql"), "CREATE TABLE next_feature (id int);");
    await db.admin.query("GRANT INSERT ON events TO ytw_web");
    try {
      const err = await failure(run(db, dir));
      expect(err.message).toMatch(/already breaks the privilege rules .*nothing was applied/);
      expect(err.message).toMatch(/table_write_privilege: public\.events ytw_web has INSERT/);
      expect((await appliedRows(db)).map((row) => row.version)).not.toContain("9001");
    } finally {
      await db.admin.query("REVOKE INSERT ON events FROM ytw_web");
    }
  });
});

describe("the catalog guard during migrations", () => {
  let db: TestDb;
  let dir: string;

  beforeAll(async () => {
    ({ db, dir } = await scenario());
    await run(db, dir);
  });

  const vault = "CREATE TABLE ytw_private.vault (owner text, secret text);\n";
  // Each file tries one way around the privilege rules; the runner must roll it back.
  const evasions: [string, string, RegExp][] = [
    [
      "a view over a ytw_private table",
      `${vault}CREATE VIEW public.token_view AS SELECT * FROM ytw_private.vault;
       GRANT SELECT ON public.token_view TO ytw_readonly;`,
      /private_data_exposure: public\.token_view ytw_readonly can read ytw_private data/,
    ],
    [
      "a view over such a view",
      `${vault}CREATE VIEW public.inner_view AS SELECT * FROM ytw_private.vault;
       CREATE VIEW public.outer_view AS SELECT owner, secret FROM public.inner_view;
       GRANT SELECT ON public.outer_view TO ytw_mcp;`,
      /private_data_exposure: public\.outer_view ytw_mcp can read/,
    ],
    [
      "a materialized view over a ytw_private table",
      `${vault}CREATE MATERIALIZED VIEW public.vault_copy AS SELECT * FROM ytw_private.vault;
       GRANT SELECT ON public.vault_copy TO ytw_readonly;`,
      /private_data_exposure: public\.vault_copy ytw_readonly can read/,
    ],
    [
      "a STABLE SECURITY DEFINER function that reads ytw_private",
      `${vault}CREATE FUNCTION public.peek() RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER
         SET search_path = pg_catalog, public, pg_temp AS 'SELECT secret FROM ytw_private.vault';
       GRANT EXECUTE ON FUNCTION public.peek() TO ytw_readonly;`,
      /readonly_function_execute: public\.peek\(\) ytw_readonly must not execute SECURITY DEFINER/,
    ],
    [
      "a STABLE SECURITY DEFINER function that writes events",
      `CREATE FUNCTION public.sneaky_log() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
         SET search_path = pg_catalog, public, pg_temp
         AS $$ SELECT ytw_log_event('x', 'agent', NULL, 'tool.call', NULL, NULL, '{}') $$;
       GRANT EXECUTE ON FUNCTION public.sneaky_log() TO ytw_readonly;`,
      /readonly_function_execute: public\.sneaky_log\(\)/,
    ],
    [
      "an invoker function for ytw_readonly that is not allowlisted",
      `CREATE FUNCTION public.helper() RETURNS integer LANGUAGE sql STABLE AS 'SELECT 1';
       GRANT EXECUTE ON FUNCTION public.helper() TO ytw_readonly;`,
      /readonly_function_execute: public\.helper\(\) ytw_readonly may execute only functions listed/,
    ],
    [
      "a SECURITY DEFINER function owned by another role",
      `CREATE FUNCTION public.borrowed() RETURNS integer LANGUAGE sql SECURITY DEFINER
         SET search_path = pg_catalog, public, pg_temp AS 'SELECT 1';
       ALTER FUNCTION public.borrowed() OWNER TO pg_database_owner;`,
      /definer_owner: public\.borrowed\(\) SECURITY DEFINER function owned by pg_database_owner/,
    ],
    [
      "a grant on a large-object function",
      "GRANT EXECUTE ON FUNCTION lo_create(oid) TO ytw_web;",
      /builtin_function_access: lo_create\(oid\) ytw_web can execute it/,
    ],
    [
      "giving advisory locks back to PUBLIC",
      "GRANT EXECUTE ON FUNCTION pg_advisory_lock(bigint) TO PUBLIC;",
      /builtin_function_access: pg_advisory_lock\(bigint\) ytw_readonly can execute it/,
    ],
    [
      "a role setting that turns read-only off",
      "ALTER ROLE ytw_readonly SET default_transaction_read_only = off;",
      /app_role_settings: ytw_readonly has an unexpected setting: default_transaction_read_only=off/,
    ],
    [
      "a guard replaced by one that reports nothing",
      `CREATE OR REPLACE FUNCTION public.ytw_catalog_violations()
         RETURNS TABLE (rule text, object text, detail text) LANGUAGE sql STABLE
         SET search_path = pg_catalog, public, pg_temp
         AS $$ SELECT NULL::text, NULL::text, NULL::text WHERE false $$;`,
      /no longer reports table_write_privilege, private_data_exposure, readonly_function_execute/,
    ],
    [
      "a dropped guard",
      "DROP FUNCTION public.ytw_catalog_violations();",
      /ytw_catalog_violations\(\) no longer exists/,
    ],
  ];

  it.each(evasions)("rolls back %s", async (_label, statements, expected) => {
    await writeFile(join(dir, "9001_evasion.sql"), statements);

    const err = await failure(run(db, dir));

    expect(err).toBeInstanceOf(MigrationError);
    expect(err.message).toMatch(/^9001_evasion\.sql/);
    expect(err.message).toMatch(expected);
    // Nothing of the file survived, and the guard is intact and clean.
    expect(await migrationStatus(db.admin, dir)).toMatchObject({ pending: ["9001_evasion.sql"] });
    const leftovers = await db.admin.query<{ vault: string | null }>(
      "SELECT to_regclass('ytw_private.vault')::text AS vault",
    );
    expect(leftovers.rows[0]?.vault).toBeNull();
    const guard = await db.admin.query("SELECT * FROM ytw_catalog_violations()");
    expect(guard.rows).toEqual([]);
  });

  it("accepts reviewed exceptions listed in ytw_private.catalog_allowlist", async () => {
    const own = await scenario();
    await run(own.db, own.dir);
    await writeFile(
      join(own.dir, "9001_reviewed.sql"),
      `${vault}CREATE VIEW public.vault_owners AS SELECT owner FROM ytw_private.vault;
       GRANT SELECT ON public.vault_owners TO ytw_web;
       CREATE FUNCTION public.helper() RETURNS integer LANGUAGE sql STABLE AS 'SELECT 1';
       GRANT EXECUTE ON FUNCTION public.helper() TO ytw_readonly;
       INSERT INTO ytw_private.catalog_allowlist (rule, object, reason) VALUES
         ('private_data_exposure', 'public.vault_owners', 'exposes only the owner column'),
         ('readonly_function_execute', 'public.helper()', 'pure helper used by a view');`,
    );

    const result = await run(own.db, own.dir);

    expect(result.applied).toEqual(["9001_reviewed.sql"]);
  });
});

describe("transaction control in migration files", () => {
  it.each([
    [
      "COMMIT",
      "CREATE TABLE partly (id int);\nCOMMIT;\nCREATE TABLE later (id int);\nSELECT 1/0;\n",
      /9001_tx\.sql: line 2: COMMIT is not allowed/,
    ],
    ["ROLLBACK", "CREATE TABLE ghost (id int);\n  ROLLBACK;\n", /line 2: ROLLBACK is not allowed/],
    [
      "BEGIN ATOMIC bodies",
      "CREATE FUNCTION public.answer() RETURNS integer LANGUAGE sql\nBEGIN ATOMIC SELECT 42;\nEND;",
      /line 3: END is not allowed/,
    ],
  ])("rejects %s before running anything", async (_label, statements, expected) => {
    const { db, dir } = await scenario();
    await run(db, dir);
    await writeFile(join(dir, "9001_tx.sql"), statements);

    const err = await failure(run(db, dir));

    expect(err).toBeInstanceOf(MigrationError);
    expect(err.message).toMatch(expected);
    for (const table of ["partly", "later", "ghost"]) {
      const exists = await db.admin.query<{ t: string | null }>(
        "SELECT to_regclass($1)::text AS t",
        [`public.${table}`],
      );
      expect(exists.rows[0]?.t).toBeNull();
    }
    expect((await appliedRows(db)).map((row) => row.version)).not.toContain("9001");
  });
});

describe("role passwords", () => {
  it("are left alone when the stored verifier already matches", async () => {
    const { db, dir } = await scenario();
    const lines: string[] = [];

    const result = await migrate({
      databaseUrl: db.url("admin"),
      lockDatabaseUrl: testServerUrl(),
      rolePasswords: testRolePasswords(),
      migrationsDir: dir,
      log: (line) => lines.push(line),
    });

    expect(result.passwordsSet).toEqual([]);
    expect(lines.filter((line) => line.includes("password"))).toEqual([
      "ytw_web: password already current",
      "ytw_mcp: password already current",
      "ytw_readonly: password already current",
    ]);
    for (const role of ["ytw_web", "ytw_mcp", "ytw_readonly"] as const) {
      const client = new Client({ connectionString: db.url(role) });
      await client.connect();
      const { rows } = await client.query<{ user: string }>('SELECT current_user AS "user"');
      await client.end();
      expect(rows[0]?.user).toBe(role);
    }
  });

  it("are compared through SCRAM verifiers that Postgres accepts", async () => {
    const role = `ytw_test_pw_${randomBytes(4).toString("hex")}`;
    const password = "scratch-role-password-0123";
    const admin = new Client({ connectionString: testServerUrl() });
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD ${admin.escapeLiteral(scramSha256Verifier(password))}`,
      );
      expect(await rolePasswordStatus(admin, role, password)).toBe("matches");
      expect(await rolePasswordStatus(admin, role, `${password}-other`)).toBe("differs");
      expect(await rolePasswordStatus(admin, "ytw_no_such_role", password)).toBe("unknown");

      // Postgres logs the role in with the verifier the runner computed.
      const url = new URL(testServerUrl());
      url.username = role;
      url.password = password;
      const login = new Client({ connectionString: url.toString() });
      await login.connect();
      const { rows } = await login.query<{ user: string }>('SELECT current_user AS "user"');
      // A non-superuser cannot read pg_authid, so it cannot tell.
      expect(await rolePasswordStatus(login, role, password)).toBe("unknown");
      await login.end();
      expect(rows[0]?.user).toBe(role);

      await admin.query(`ALTER ROLE ${role} PASSWORD NULL`);
      expect(await rolePasswordStatus(admin, role, password)).toBe("unset");
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });

  it("are validated before anything is touched, without echoing the value", async () => {
    const weak = "short pw";
    const err = await failure(
      migrate({
        databaseUrl: "postgres://nobody@127.0.0.1:1/none",
        rolePasswords: { ytw_web: weak },
      }),
    );
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.message).toMatch(/YTW_WEB_PASSWORD\) must be 16 to 256 printable ASCII characters/);
    expect(err.message).not.toContain(weak);
  });

  it("produce well-formed, salted SCRAM-SHA-256 verifiers", () => {
    const salt = Buffer.from("0123456789abcdef");
    const a = scramSha256Verifier("correct-horse-battery", salt);
    expect(a).toBe(scramSha256Verifier("correct-horse-battery", salt));
    expect(a).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/,
    );
    expect(scramSha256Verifier("correct-horse-battery")).not.toBe(a);
  });
});

describe("migration files", () => {
  it("must be named NNNN_lower_snake_case.sql with unique numbers", async () => {
    const badName = await dirWith({ "0001_ok.sql": "", "1_short.sql": "", "0002_Mixed.sql": "" });
    const err = await failure(loadMigrations(badName));
    expect(err.message).toMatch(/1_short\.sql: migration files must be named/);
    expect(err.message).toMatch(/0002_Mixed\.sql: migration files must be named/);

    const duplicate = await dirWith({ "0005_a.sql": "", "0005_b.sql": "" });
    expect((await failure(loadMigrations(duplicate))).message).toMatch(
      /version 0005 is already used by 0005_a\.sql/,
    );
  });

  it("are sorted by number, ignore non-SQL files and hash CRLF and a BOM like plain LF", async () => {
    const bom = String.fromCharCode(0xfeff);
    const dir = await dirWith({
      "0010_b.sql": "SELECT 1;\r\nSELECT 2;\r\n",
      "0002_a.sql": `${bom}SELECT 1;\nSELECT 2;\n`,
      "0003_c.sql": "SELECT 1;\nSELECT 2;\n",
      "README.md": "not a migration",
    });
    const files = await loadMigrations(dir);
    expect(files.map((file) => file.filename)).toEqual(["0002_a.sql", "0003_c.sql", "0010_b.sql"]);
    const checksums = new Set(files.map((file) => file.checksum));
    expect(checksums.size).toBe(1);
    expect(files[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(files[0]?.sql.charCodeAt(0)).toBe("S".charCodeAt(0));
  });

  it("keep their sources plain ASCII, so no invisible character hides in code or SQL", async () => {
    const roots = [
      fileURLToPath(new URL("../src", import.meta.url)),
      fileURLToPath(new URL("../sql", import.meta.url)),
      defaultMigrationsDir(),
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && /\.(ts|sql)$/.test(entry.name)) {
          const path = join(entry.parentPath, entry.name);
          const text = await readFile(path, "utf8");
          if (/\P{ASCII}/u.test(text)) {
            offenders.push(path);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
