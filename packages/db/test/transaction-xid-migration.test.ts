import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, migrate } from "../src/migrate.js";
import { createTestDb, testRolePasswords, testServerUrl, type TestDb } from "../src/testing.js";
import { copyMigrations } from "./helpers.js";

describe("activity transaction xid migration", () => {
  let db: TestDb | undefined;
  let migrations: Awaited<ReturnType<typeof copyMigrations>> | undefined;

  afterEach(async () => {
    await db?.drop();
    db = undefined;
    await migrations?.remove();
    migrations = undefined;
  });

  it("backfills existing events and exposes snapshot checks to web and MCP roles", async () => {
    migrations = await copyMigrations();
    const migrationName = "0200_event_transaction_xid.sql";
    const migrationPath = join(migrations.dir, migrationName);
    const migrationSql = await readFile(join(defaultMigrationsDir(), migrationName), "utf8");
    await rm(migrationPath);

    db = await createTestDb({ migrationsDir: migrations.dir });
    const oldEvent = await db.admin.query<{ id: string }>(
      `INSERT INTO public.events (actor, actor_type, action, entity_type, payload)
       VALUES ('migration fixture', 'human', 'insert', 'note', '{}'::jsonb)
       RETURNING id::text AS id`,
    );

    await writeFile(migrationPath, migrationSql);
    const result = await migrate({
      databaseUrl: db.url("admin"),
      lockDatabaseUrl: testServerUrl(),
      rolePasswords: testRolePasswords(),
      migrationsDir: migrations.dir,
    });
    expect(result.applied).toEqual([migrationName]);

    const newEvent = await db.admin.query<{ id: string; xid: string }>(
      `INSERT INTO public.events (actor, actor_type, action, entity_type, payload)
       VALUES ('migration fixture', 'human', 'insert', 'note', '{}'::jsonb)
       RETURNING id::text AS id, transaction_xid::text AS xid`,
    );
    expect(newEvent.rows[0]?.xid).not.toBe("2");

    for (const role of ["ytw_web", "ytw_mcp"] as const) {
      const rows = await db.pool(role).query<{ xid: string; visible: boolean }>(
        `SELECT transaction_xid::text AS xid,
                pg_visible_in_snapshot(transaction_xid, pg_current_snapshot()) AS visible
           FROM public.events
          WHERE id IN ($1::uuid, $2::uuid)
          ORDER BY id`,
        [oldEvent.rows[0]!.id, newEvent.rows[0]!.id],
      );
      expect(rows.rows.map((row) => row.xid)).toContain("2");
      expect(rows.rows.map((row) => row.xid)).toContain(newEvent.rows[0]!.xid);
      expect(rows.rows.every((row) => row.visible)).toBe(true);
    }

    const oldRow = await db.admin.query<{ xid: string }>(
      `SELECT transaction_xid::text AS xid FROM public.events WHERE id = $1::uuid`,
      [oldEvent.rows[0]!.id],
    );
    expect(oldRow.rows[0]?.xid).toBe("2");
  });
});
