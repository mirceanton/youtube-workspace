import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_ROLES } from "../src/client.js";
import { migrationStatus, rolePasswordStatus } from "../src/migrate.js";
import {
  DEFAULT_TEST_DATABASE_URL,
  DEV_ROLE_PASSWORDS,
  DISPOSABLE_TEST_SERVER_ENV,
  createTestDb,
  isLocalServer,
  testRolePasswords,
  testServerUrl,
} from "../src/testing.js";
import { failure } from "./helpers.js";

describe("harness configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses TEST_DATABASE_URL or the local dev default, never MIGRATION_DATABASE_URL", () => {
    vi.stubEnv("MIGRATION_DATABASE_URL", "postgres://ci:secret@prod-db:5432/youtube_workspace");
    vi.stubEnv("TEST_DATABASE_URL", "postgres://admin:pw@localhost:6543/maint");
    expect(testServerUrl()).toBe("postgres://admin:pw@localhost:6543/maint");

    vi.stubEnv("TEST_DATABASE_URL", "");
    expect(testServerUrl()).toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it("recognises servers on this machine", () => {
    for (const url of [
      DEFAULT_TEST_DATABASE_URL,
      "postgres://u:p@127.0.0.1:5432/postgres",
      "postgres://u:p@127.4.5.6/postgres",
      "postgres://u:p@[::1]:5432/postgres",
      "postgres://u@localhost/postgres?host=/var/run/postgresql",
    ]) {
      expect({ url, local: isLocalServer(url) }).toEqual({ url, local: true });
    }
    for (const url of [
      "postgres://u:p@db.example.com:5432/postgres",
      "postgres://u:p@10.0.0.5/postgres",
      "postgres://u:p@localhost.example.com/postgres",
      // A host parameter takes precedence over the URL's host.
      "postgres://u@localhost/postgres?host=db.example.com",
      "not a url",
    ]) {
      expect({ url, local: isLocalServer(url) }).toEqual({ url, local: false });
    }
  });

  it("refuses a server on another machine unless it is declared disposable", async () => {
    vi.stubEnv("TEST_DATABASE_URL", "postgres://postgres:postgres@db.example.com:5432/postgres");
    const err = await failure(createTestDb());
    expect(err.message).toMatch(/refusing to create test databases on db\.example\.com:5432/);
    expect(err.message).toContain(`${DISPOSABLE_TEST_SERVER_ENV}=1`);
  });

  it("never overwrites a role password that differs from the test password", async () => {
    // First make sure the roles have the test passwords (a fresh cluster has none: the harness
    // would set the stubbed value below as the first password, which is allowed).
    await (await createTestDb()).drop();
    const other = "someone-elses-real-password";
    vi.stubEnv("YTW_WEB_PASSWORD", other);

    const err = await failure(createTestDb());

    expect(err.message).toMatch(
      /the test passwords do not match these roles: ytw_web \(different password\)/,
    );
    expect(err.message).not.toContain(other);
    expect(await passwordStatus("ytw_web", DEV_ROLE_PASSWORDS.ytw_web)).toBe("matches");
    expect(await passwordStatus("ytw_web", other)).toBe("differs");
    const name = /migrating test database (ytw_test_\w+) failed/.exec(err.message)?.[1];
    expect(await databaseExists(name as string)).toBe(false);
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

async function passwordStatus(role: string, password: string): Promise<string> {
  const client = new Client({ connectionString: testServerUrl() });
  await client.connect();
  try {
    return await rolePasswordStatus(client, role, password);
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
