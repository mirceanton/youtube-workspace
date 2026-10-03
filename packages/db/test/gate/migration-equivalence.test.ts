// Gate: Migration Equivalence, Idempotence & Schema Reproducibility (PRD 9).
//
// 1. Verifies that migrating a fresh database in one go applies every migration in order
//    and registers all checksums.
// 2. Verifies that re-running `migrate()` on an up-to-date database is a strict, idempotent no-op.
// 3. Verifies that applying migrations step-by-step (one file at a time) produces an identical
//    database catalog (tables, columns, constraints, indexes, triggers, functions, privileges)
//    to migrating in a single run.
// 4. Verifies intermediate migration states: schema is valid and incrementally extended.
// 5. Verifies checksum verification and post-apply immutability safeguards against tampering.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MigrationError,
  defaultMigrationsDir,
  loadMigrations,
  migrate,
  migrationStatus,
  type MigrationFile,
} from "../../src/migrate.js";
import { createTestDb, testRolePasswords, testServerUrl, type TestDb } from "../../src/testing.js";
import { copyMigrations, failure } from "../helpers.js";

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((fn) => fn()));
});

interface CatalogSnapshot {
  tables: Array<{ table_schema: string; table_name: string; table_type: string }>;
  columns: Array<{
    table_schema: string;
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>;
  constraints: Array<{
    schema: string;
    table_name: string;
    conname: string;
    contype: string;
    definition: string;
  }>;
  indexes: Array<{
    schemaname: string;
    tablename: string;
    indexname: string;
    indexdef: string;
  }>;
  triggers: Array<{
    trigger_schema: string;
    event_object_table: string;
    trigger_name: string;
    action_timing: string;
    event_manipulation: string;
    action_statement: string;
  }>;
  functions: Array<{
    schema: string;
    proname: string;
    identity_arguments: string;
    return_type: string;
    is_security_definer: boolean;
    volatility: string;
  }>;
  tablePrivileges: Array<{
    grantee: string;
    table_schema: string;
    table_name: string;
    privilege_type: string;
  }>;
  routinePrivileges: Array<{
    grantee: string;
    specific_schema: string;
    routine_name: string;
    privilege_type: string;
  }>;
}

async function dumpCatalog(db: TestDb): Promise<CatalogSnapshot> {
  const schemas = ["public", "ytw_private"];

  // 1. Tables and views
  const { rows: tables } = await db.admin.query<{
    table_schema: string;
    table_name: string;
    table_type: string;
  }>(
    `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
      WHERE table_schema = ANY($1)
      ORDER BY table_schema, table_name`,
    [schemas],
  );

  // 2. Columns
  const { rows: columns } = await db.admin.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = ANY($1)
      ORDER BY table_schema, table_name, ordinal_position`,
    [schemas],
  );

  // 3. Constraints
  const { rows: constraints } = await db.admin.query<{
    schema: string;
    table_name: string;
    conname: string;
    contype: string;
    definition: string;
  }>(
    `SELECT n.nspname AS schema, c.relname AS table_name, con.conname, con.contype,
            pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1)
      ORDER BY n.nspname, c.relname, con.conname`,
    [schemas],
  );

  // 4. Indexes
  const { rows: indexes } = await db.admin.query<{
    schemaname: string;
    tablename: string;
    indexname: string;
    indexdef: string;
  }>(
    `SELECT schemaname, tablename, indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = ANY($1)
      ORDER BY schemaname, tablename, indexname`,
    [schemas],
  );

  // 5. Triggers
  const { rows: triggers } = await db.admin.query<{
    trigger_schema: string;
    event_object_table: string;
    trigger_name: string;
    action_timing: string;
    event_manipulation: string;
    action_statement: string;
  }>(
    `SELECT trigger_schema, event_object_table, trigger_name, action_timing,
            event_manipulation, action_statement
       FROM information_schema.triggers
      WHERE trigger_schema = ANY($1)
      ORDER BY trigger_schema, event_object_table, trigger_name, event_manipulation`,
    [schemas],
  );

  // 6. Functions / procedures
  const { rows: functions } = await db.admin.query<{
    schema: string;
    proname: string;
    identity_arguments: string;
    return_type: string;
    is_security_definer: boolean;
    volatility: string;
  }>(
    `SELECT n.nspname AS schema, p.proname,
            pg_get_function_identity_arguments(p.oid) AS identity_arguments,
            pg_get_function_result(p.oid) AS return_type,
            p.prosecdef AS is_security_definer,
            p.provolatile AS volatility
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ANY($1)
      ORDER BY n.nspname, p.proname, identity_arguments`,
    [schemas],
  );

  // 7. Table privileges
  const { rows: tablePrivileges } = await db.admin.query<{
    grantee: string;
    table_schema: string;
    table_name: string;
    privilege_type: string;
  }>(
    `SELECT grantee, table_schema, table_name, privilege_type
       FROM information_schema.table_privileges
      WHERE table_schema = ANY($1)
        AND grantee IN ('ytw_web', 'ytw_mcp', 'ytw_readonly', 'PUBLIC')
      ORDER BY grantee, table_schema, table_name, privilege_type`,
    [schemas],
  );

  // 8. Routine privileges
  const { rows: routinePrivileges } = await db.admin.query<{
    grantee: string;
    specific_schema: string;
    routine_name: string;
    privilege_type: string;
  }>(
    `SELECT grantee, specific_schema, routine_name, privilege_type
       FROM information_schema.routine_privileges
      WHERE specific_schema = ANY($1)
        AND grantee IN ('ytw_web', 'ytw_mcp', 'ytw_readonly', 'PUBLIC')
      ORDER BY grantee, specific_schema, routine_name, privilege_type`,
    [schemas],
  );

  return {
    tables,
    columns,
    constraints,
    indexes,
    triggers,
    functions,
    tablePrivileges,
    routinePrivileges,
  };
}

describe("gate: migration equivalence and reproducibility", () => {
  let allFiles: MigrationFile[];

  beforeAll(async () => {
    allFiles = await loadMigrations(defaultMigrationsDir());
  });

  it("applies all migrations in one go on fresh DB and records accurate checksums", async () => {
    expect(allFiles.length).toBeGreaterThanOrEqual(30);
    const db = await createTestDb({ migrate: false });
    cleanups.push(() => db.drop());

    const result = await migrate({
      databaseUrl: db.url("admin"),
      lockDatabaseUrl: testServerUrl(),
      rolePasswords: testRolePasswords(),
    });

    expect(result.applied).toEqual(allFiles.map((f) => f.filename));
    expect(result.alreadyApplied).toBe(0);

    const { rows: applied } = await db.admin.query<{
      version: string;
      filename: string;
      checksum: string;
    }>("SELECT version, filename, checksum FROM public.schema_migrations ORDER BY version");

    expect(applied).toEqual(
      allFiles.map((f) => ({
        version: f.version,
        filename: f.filename,
        checksum: f.checksum,
      })),
    );

    const status = await migrationStatus(db.admin);
    expect(status.upToDate).toBe(true);
    expect(status.pending).toHaveLength(0);
    expect(status.changed).toHaveLength(0);
    expect(status.unknown).toHaveLength(0);
  });

  it("is strictly idempotent: repeated migrate() call makes zero changes", async () => {
    const db = await createTestDb({ migrate: true });
    cleanups.push(() => db.drop());

    const catalogBefore = await dumpCatalog(db);
    const { rows: appliedBefore } = await db.admin.query(
      "SELECT * FROM public.schema_migrations ORDER BY version",
    );

    // Second run
    const secondResult = await migrate({
      databaseUrl: db.url("admin"),
      lockDatabaseUrl: testServerUrl(),
      rolePasswords: testRolePasswords(),
    });

    expect(secondResult.applied).toEqual([]);
    expect(secondResult.alreadyApplied).toBe(allFiles.length);

    const catalogAfter = await dumpCatalog(db);
    const { rows: appliedAfter } = await db.admin.query(
      "SELECT * FROM public.schema_migrations ORDER BY version",
    );

    expect(appliedAfter).toEqual(appliedBefore);
    expect(catalogAfter).toEqual(catalogBefore);
  });

  it("matches catalog exactly between one-go migration and step-by-step migration", async () => {
    // DB 1: migrated in one single run
    const dbOneGo = await createTestDb({ migrate: false });
    cleanups.push(() => dbOneGo.drop());
    await migrate({
      databaseUrl: dbOneGo.url("admin"),
      lockDatabaseUrl: testServerUrl(),
      rolePasswords: testRolePasswords(),
    });

    // DB 2: migrated step-by-step (1 file at a time)
    const dbStepByStep = await createTestDb({ migrate: false });
    cleanups.push(() => dbStepByStep.drop());

    const stepDir = mkdtempSync(join(tmpdir(), "ytw-step-gate-"));
    cleanups.push(async () => rmSync(stepDir, { recursive: true, force: true }));

    for (const file of allFiles) {
      copyFileSync(file.path, join(stepDir, file.filename));
      const stepResult = await migrate({
        databaseUrl: dbStepByStep.url("admin"),
        lockDatabaseUrl: testServerUrl(),
        rolePasswords: testRolePasswords(),
        migrationsDir: stepDir,
      });
      expect(stepResult.applied).toEqual([file.filename]);
    }

    // Comprehensive catalog comparison
    const catOneGo = await dumpCatalog(dbOneGo);
    const catStepByStep = await dumpCatalog(dbStepByStep);

    expect(catStepByStep.tables).toEqual(catOneGo.tables);
    expect(catStepByStep.columns).toEqual(catOneGo.columns);
    expect(catStepByStep.constraints).toEqual(catOneGo.constraints);
    expect(catStepByStep.indexes).toEqual(catOneGo.indexes);
    expect(catStepByStep.triggers).toEqual(catOneGo.triggers);
    expect(catStepByStep.functions).toEqual(catOneGo.functions);
    expect(catStepByStep.tablePrivileges).toEqual(catOneGo.tablePrivileges);
    expect(catStepByStep.routinePrivileges).toEqual(catOneGo.routinePrivileges);
  });

  it("validates intermediate migration state compatibility", async () => {
    const db = await createTestDb({ migrate: false });
    cleanups.push(() => db.drop());

    const intermediateDir = mkdtempSync(join(tmpdir(), "ytw-inter-gate-"));
    cleanups.push(async () => rmSync(intermediateDir, { recursive: true, force: true }));

    // Apply only first 4 migrations (up to 0004_audit.sql)
    const earlyFiles = allFiles.filter((f) => f.version <= "0004");
    for (const file of earlyFiles) {
      copyFileSync(file.path, join(intermediateDir, file.filename));
    }

    const earlyResult = await migrate({
      databaseUrl: db.url("admin"),
      lockDatabaseUrl: testServerUrl(),
      rolePasswords: testRolePasswords(),
      migrationsDir: intermediateDir,
    });
    expect(earlyResult.applied).toHaveLength(earlyFiles.length);

    // Audit log table exists
    const eventsTable = await db.admin.query("SELECT to_regclass('public.events') AS tbl");
    expect(eventsTable.rows[0]?.tbl).toBe("events");

    // Later tables like experiments (0014) or api_tokens (0012) do NOT exist yet
    const expTable = await db.admin.query("SELECT to_regclass('public.experiments') AS tbl");
    expect(expTable.rows[0]?.tbl).toBeNull();

    // Now apply the remaining migrations to complete the migration
    for (const file of allFiles) {
      copyFileSync(file.path, join(intermediateDir, file.filename));
    }
    const finalResult = await migrate({
      databaseUrl: db.url("admin"),
      lockDatabaseUrl: testServerUrl(),
      rolePasswords: testRolePasswords(),
      migrationsDir: intermediateDir,
    });
    expect(finalResult.alreadyApplied).toBe(earlyFiles.length);
    expect(finalResult.applied).toHaveLength(allFiles.length - earlyFiles.length);

    // Now experiments table exists
    const expTableNow = await db.admin.query("SELECT to_regclass('public.experiments') AS tbl");
    expect(expTableNow.rows[0]?.tbl).toBe("experiments");
  });

  it("safeguards against post-apply file editing and checksum tampering", async () => {
    const copy = await copyMigrations();
    cleanups.push(copy.remove);

    const db = await createTestDb({ migrate: false });
    cleanups.push(() => db.drop());

    await migrate({
      databaseUrl: db.url("admin"),
      lockDatabaseUrl: testServerUrl(),
      rolePasswords: testRolePasswords(),
      migrationsDir: copy.dir,
    });

    // Tamper with an applied file
    const targetFile = join(copy.dir, "0004_audit.sql");
    const originalContent = await readFile(targetFile, "utf8");
    await writeFile(targetFile, `${originalContent}\n-- malicious tampered comment\n`);

    // Runner must abort and refuse to migrate
    const err = await failure(
      migrate({
        databaseUrl: db.url("admin"),
        lockDatabaseUrl: testServerUrl(),
        rolePasswords: testRolePasswords(),
        migrationsDir: copy.dir,
      }),
    );

    expect(err).toBeInstanceOf(MigrationError);
    expect(err.message).toMatch(/0004_audit\.sql was changed after it was applied/);
    expect(err.message).toMatch(/immutable/);
  });
});
