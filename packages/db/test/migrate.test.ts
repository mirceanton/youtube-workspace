import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findTransactionControl,
  loadMigrations,
  migrate,
  migrationStatus,
  MigrationError,
} from "../src/migrate.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { failure } from "./helpers.js";

let db: TestDb;
let bare: TestDb;
let dir: string;

const file = (name: string, sql: string) => writeFile(join(dir, name), sql);

beforeAll(async () => {
  [db, bare] = await Promise.all([createTestDb(), createTestDb({ migrate: false })]);
  dir = await mkdtemp(join(tmpdir(), "ytw-migrations-"));
});

afterAll(async () => {
  await Promise.all([db.drop(), bare.drop(), rm(dir, { recursive: true, force: true })]);
});

describe("the baseline", () => {
  it("applies as a plain database owner and is a no-op the second time", async () => {
    const { rows } = await db.pool.query(
      "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0]).toEqual({ rolsuper: false });
    expect((await loadMigrations()).map((migration) => migration.filename)).toEqual([
      "0001_init.sql",
    ]);
    expect(await migrate({ databaseUrl: db.url })).toEqual({ applied: [], alreadyApplied: 1 });
    expect(await migrationStatus(db.pool)).toMatchObject({
      upToDate: true,
      applied: 1,
      pending: [],
    });
  });
});

describe("the runner", () => {
  it("applies files in order, once, even when two runs start together", async () => {
    await file("0001_first.sql", "CREATE TABLE public.first (id integer);");
    await file("0002_second.sql", "CREATE TABLE public.second (id integer);");
    const runs = await Promise.all([
      migrate({ databaseUrl: bare.url, migrationsDir: dir }),
      migrate({ databaseUrl: bare.url, migrationsDir: dir }),
    ]);
    expect(runs.flatMap((run) => run.applied)).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect((await migrationStatus(bare.pool, dir)).upToDate).toBe(true);
  });

  it("refuses an applied file that was edited, and a pending file older than the newest", async () => {
    await appendFile(join(dir, "0001_first.sql"), "\n-- edited");
    const edited = await failure(migrate({ databaseUrl: bare.url, migrationsDir: dir }));
    expect(edited).toBeInstanceOf(MigrationError);
    expect(edited.message).toContain("0001_first.sql was changed after it was applied");
    expect((await migrationStatus(bare.pool, dir)).changed).toEqual(["0001_first.sql"]);

    await file("0001_first.sql", "CREATE TABLE public.first (id integer);");
    await file("0000_older.sql", "SELECT 1;");
    const older = await failure(migrate({ databaseUrl: bare.url, migrationsDir: dir }));
    expect(older.message).toContain("0000_older.sql is pending but older than the newest");
  });

  it("rolls a failing file back completely and names the line", async () => {
    await rm(join(dir, "0000_older.sql"));
    await file("0003_bad.sql", "CREATE TABLE public.third (id integer);\nSELEKT 1;");
    const failed = await failure(migrate({ databaseUrl: bare.url, migrationsDir: dir }));
    expect(failed.message).toMatch(/0003_bad.sql failed at line 2: syntax error/);
    const { rows } = await bare.pool.query("SELECT to_regclass('public.third') AS third");
    expect(rows[0]).toEqual({ third: null });
    expect((await migrationStatus(bare.pool, dir)).pending).toEqual(["0003_bad.sql"]);
  });

  it("rejects files with transaction control before running anything", async () => {
    await file("0003_bad.sql", "CREATE TABLE public.third (id integer);\nCOMMIT;");
    await expect(loadMigrations(dir)).rejects.toThrow(
      "0003_bad.sql: line 2: COMMIT is not allowed",
    );
    expect(
      findTransactionControl("SELECT 'COMMIT;'; -- ROLLBACK;\nDO $$ BEGIN COMMIT; END $$;\nBEGIN;"),
    ).toEqual([{ statement: "BEGIN", line: 3 }]);
  });
});
