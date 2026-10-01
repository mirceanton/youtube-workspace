import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_ROLES } from "../src/client.js";
import { migrationStatus } from "../src/migrate.js";
import {
  DEFAULT_TEST_DATABASE_URL,
  DEV_ROLE_PASSWORDS,
  createTestDb,
  testRolePasswords,
  testServerUrl,
} from "../src/testing.js";
import { failure } from "./helpers.js";

describe("harness configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses TEST_DATABASE_URL, else MIGRATION_DATABASE_URL's server, else the dev default", () => {
    vi.stubEnv("TEST_DATABASE_URL", "postgres://admin:pw@db.test:6543/maint");
    vi.stubEnv("MIGRATION_DATABASE_URL", "postgres://ci:secret@ci-db:5432/youtube_workspace");
    expect(testServerUrl()).toBe("postgres://admin:pw@db.test:6543/maint");

    vi.stubEnv("TEST_DATABASE_URL", "");
    expect(testServerUrl()).toBe("postgres://ci:secret@ci-db:5432/postgres");

    vi.stubEnv("MIGRATION_DATABASE_URL", "");
    expect(testServerUrl()).toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it("takes role passwords from YTW_*_PASSWORD, else the .env.example dev values", () => {
    vi.stubEnv("YTW_WEB_PASSWORD", "");
    vi.stubEnv("YTW_MCP_PASSWORD", "mcp-password-from-environment");
    vi.stubEnv("YTW_READONLY_PASSWORD", "");
    expect(testRolePasswords()).toEqual({
      ytw_web: DEV_ROLE_PASSWORDS.ytw_web,
      ytw_mcp: "mcp-password-from-environment",
      ytw_readonly: DEV_ROLE_PASSWORDS.ytw_readonly,
    });
  });
});

async function databaseExists(name: string): Promise<boolean> {
  const client = new Client({ connectionString: testServerUrl() });
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
          const { rows } = await db
            .pool(role)
            .query<{ who: string; db: string }>(
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
