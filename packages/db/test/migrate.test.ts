import { mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  MIGRATION_LOCK_KEY,
  MigrationError,
  loadMigrations,
  migrate,
  migrationStatus,
  scramSha256Verifier,
} from "../src/migrate.js";
import { createTestDb, testRolePasswords, testServerUrl, type TestDb } from "../src/testing.js";
import { copyMigrations, failure } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];

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
    expect(result.passwordsSet).toEqual(["ytw_web", "ytw_mcp", "ytw_readonly"]);
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
});

describe("role passwords", () => {
  it("are set so each application role can log in, stored as SCRAM verifiers", async () => {
    const { db, dir } = await scenario();
    await run(db, dir);
    for (const role of ["ytw_web", "ytw_mcp", "ytw_readonly"] as const) {
      const client = new Client({ connectionString: db.url(role) });
      await client.connect();
      const { rows } = await client.query<{ user: string }>('SELECT current_user AS "user"');
      await client.end();
      expect(rows[0]?.user).toBe(role);
    }
    const stored = await db.admin.query<{ rolpassword: string }>(
      "SELECT rolpassword FROM pg_authid WHERE rolname = 'ytw_web'",
    );
    expect(stored.rows[0]?.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
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

  it("are sorted by number, ignore non-SQL files and hash CRLF like LF", async () => {
    const dir = await dirWith({
      "0010_b.sql": "SELECT 1;\r\nSELECT 2;\r\n",
      "0002_a.sql": "﻿SELECT 1;\nSELECT 2;\n",
      "README.md": "not a migration",
    });
    const files = await loadMigrations(dir);
    expect(files.map((file) => file.filename)).toEqual(["0002_a.sql", "0010_b.sql"]);
    expect(files[0]?.checksum).toBe(files[1]?.checksum);
    expect(files[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
