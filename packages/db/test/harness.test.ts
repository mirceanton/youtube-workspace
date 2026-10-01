import pg from "pg";
import { describe, expect, it } from "vitest";
import { APP_ROLES } from "../src/client.js";
import { migrationStatus } from "../src/migrate.js";
import { createTestDb, testServerUrl } from "../src/testing.js";
import { failure } from "./helpers.js";

async function databaseExists(name: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: testServerUrl() });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    return rowCount === 1;
  } finally {
    await client.end();
  }
}

describe("createTestDb", () => {
  it("migrates 8 databases concurrently, each with working role logins, and drops them", async () => {
    const dbs = await Promise.all(Array.from({ length: 8 }, () => createTestDb()));
    try {
      expect(new Set(dbs.map((db) => db.name)).size).toBe(8);
      for (const db of dbs) {
        expect(db.name).toMatch(/^ytw_test_[a-z0-9]+_[0-9a-f]{10}$/);
        expect(await migrationStatus(db.admin)).toMatchObject({ upToDate: true, pending: [] });
        const violations = await db.admin.query("SELECT * FROM ytw_catalog_violations()");
        expect(violations.rows).toEqual([]);
        for (const role of APP_ROLES) {
          const { rows } = await db.pool(role).query<{ who: string; db: string }>(
            "SELECT current_user AS who, current_database() AS db",
          );
          expect(rows[0]).toEqual({ who: role, db: db.name });
        }
      }
    } finally {
      await Promise.all(dbs.map((db) => db.drop()));
    }
    for (const db of dbs) {
      expect(await databaseExists(db.name)).toBe(false);
    }
  });

  it("can skip migrations, and drop() is idempotent and closes the pools", async () => {
    const db = await createTestDb({ migrate: false });
    const tables = await db.admin.query("SELECT to_regclass('public.schema_migrations') AS t");
    expect(tables.rows[0]?.t).toBeNull();
    expect(new URL(db.url("ytw_mcp")).username).toBe("ytw_mcp");
    expect(new URL(db.url("ytw_mcp")).pathname).toBe(`/${db.name}`);

    await db.drop();
    await db.drop();

    expect(await databaseExists(db.name)).toBe(false);
    expect(() => db.admin).toThrow(/already dropped/);
  });

  it("drops the database again when its migrations fail", async () => {
    const err = await failure(createTestDb({ migrationsDir: "/nonexistent/ytw-migrations" }));
    const name = /migrating test database (ytw_test_\w+) failed/.exec(err.message)?.[1];
    expect(name).toBeDefined();
    expect(err.message).toMatch(/ENOENT/);
    expect(await databaseExists(name as string)).toBe(false);
  });
});
