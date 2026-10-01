/**
 * Test harness (`@ytw/db/testing`): one throwaway, fully migrated database per test file, with a
 * pool per application role. Integration tests in every package use it; there are no database
 * mocks (PLAN.md section 3).
 *
 * ```ts
 * import { createTestDb, type TestDb } from "@ytw/db/testing";
 *
 * let db: TestDb;
 * beforeAll(async () => { db = await createTestDb(); });
 * afterAll(async () => { await db.drop(); });
 *
 * it("...", async () => {
 *   await withActor(db.pool("ytw_web"), { name: "alice", type: "human" }, async (tx) => { ... });
 * });
 * ```
 *
 * The server is `TEST_DATABASE_URL` (a superuser connection), else the one in
 * `MIGRATION_DATABASE_URL`, else the local dev cluster of `scripts/pg-local.sh` / docker compose
 * (see {@link testServerUrl}). Each database gets a unique name and is created from
 * template0, so files and workers run in parallel safely. Migrations run under the cluster-wide
 * migration lock because the application roles are shared by every database in the cluster.
 * Never use this module outside tests.
 */
import { randomBytes } from "node:crypto";
import { Client, Pool } from "pg";
import { APP_ROLES, type AppRole } from "./client.js";
import { ROLE_PASSWORD_ENV, migrate } from "./migrate.js";

/** Used when TEST_DATABASE_URL is unset: the dev superuser of pg-local.sh and docker-compose.yml. */
export const DEFAULT_TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/postgres";

/**
 * Role passwords the harness uses when YTW_*_PASSWORD are unset. They equal the dev values in
 * .env.example, so running tests never changes the passwords a local dev server relies on.
 */
export const DEV_ROLE_PASSWORDS: Readonly<Record<AppRole, string>> = {
  ytw_web: "ytw-web-dev-password",
  ytw_mcp: "ytw-mcp-dev-password",
  ytw_readonly: "ytw-readonly-dev-password",
};

export interface CreateTestDbOptions {
  /** Apply the migrations (default true). Without them the application roles may not exist yet. */
  migrate?: boolean;
  /** Migrations directory (default: this package's). */
  migrationsDir?: string;
}

export interface TestDb {
  /** The database name, unique per call (`ytw_test_...`). */
  readonly name: string;
  /** Superuser pool on this database, for fixtures and assertions only (never for code under test). */
  readonly admin: Pool;
  /** Pool that logs in as an application role (created on first use). */
  pool(role: AppRole): Pool;
  /** Connection string for an application role or the superuser, e.g. for a server under test. */
  url(role: AppRole | "admin"): string;
  /** Ends every pool and drops the database. Safe to call more than once. */
  drop(): Promise<void>;
}

/**
 * The superuser connection string the harness uses: `TEST_DATABASE_URL`; otherwise the server and
 * credentials of `MIGRATION_DATABASE_URL` (as CI exports it) with the `postgres` maintenance
 * database; otherwise {@link DEFAULT_TEST_DATABASE_URL}. The maintenance database doubles as the
 * shared lock database, so every harness on one cluster must resolve to the same database name.
 */
export function testServerUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL?.trim();
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  const migration = process.env.MIGRATION_DATABASE_URL?.trim();
  if (migration !== undefined && migration !== "") {
    const url = new URL(migration);
    url.pathname = "/postgres";
    return url.toString();
  }
  return DEFAULT_TEST_DATABASE_URL;
}

/** Role passwords for test databases: YTW_*_PASSWORD when set, otherwise {@link DEV_ROLE_PASSWORDS}. */
export function testRolePasswords(): Record<AppRole, string> {
  const result = { ...DEV_ROLE_PASSWORDS };
  for (const role of APP_ROLES) {
    const value = process.env[ROLE_PASSWORD_ENV[role]];
    if (value !== undefined && value !== "") {
      result[role] = value;
    }
  }
  return result;
}

/** Creates (and by default migrates) a uniquely named database. Call `drop()` in `afterAll`. */
export async function createTestDb(options: CreateTestDbOptions = {}): Promise<TestDb> {
  const serverUrl = testServerUrl();
  const name = `ytw_test_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
  const passwords = testRolePasswords();

  await withAdminClient(serverUrl, async (client) => {
    await client.query(
      `CREATE DATABASE ${client.escapeIdentifier(name)} TEMPLATE template0 ENCODING 'UTF8'`,
    );
  });

  const db = new TestDatabase(serverUrl, name, passwords);
  if (options.migrate !== false) {
    try {
      await migrate({
        databaseUrl: db.url("admin"),
        lockDatabaseUrl: serverUrl,
        rolePasswords: passwords,
        ...(options.migrationsDir === undefined ? {} : { migrationsDir: options.migrationsDir }),
      });
    } catch (err) {
      await db.drop();
      throw new Error(
        `migrating test database ${name} failed (it was dropped again): ` +
          (err instanceof Error ? err.message : String(err)),
        { cause: err },
      );
    }
  }
  return db;
}

class TestDatabase implements TestDb {
  readonly name: string;
  readonly #serverUrl: string;
  readonly #passwords: Record<AppRole, string>;
  readonly #pools = new Map<AppRole | "admin", Pool>();
  #dropped = false;

  constructor(serverUrl: string, name: string, passwords: Record<AppRole, string>) {
    this.#serverUrl = serverUrl;
    this.name = name;
    this.#passwords = passwords;
  }

  get admin(): Pool {
    return this.#poolFor("admin");
  }

  pool(role: AppRole): Pool {
    if (!(APP_ROLES as readonly string[]).includes(role)) {
      throw new TypeError(`unknown application role: ${String(role)}`);
    }
    return this.#poolFor(role);
  }

  url(role: AppRole | "admin"): string {
    const url = new URL(this.#serverUrl);
    url.pathname = `/${this.name}`;
    if (role !== "admin") {
      url.username = role;
      url.password = this.#passwords[role];
    }
    return url.toString();
  }

  async drop(): Promise<void> {
    if (this.#dropped) {
      return;
    }
    this.#dropped = true;
    const pools = [...this.#pools.values()];
    this.#pools.clear();
    await Promise.allSettled(pools.map((pool) => pool.end()));
    await withAdminClient(this.#serverUrl, async (client) => {
      await client.query(
        `DROP DATABASE IF EXISTS ${client.escapeIdentifier(this.name)} WITH (FORCE)`,
      );
    });
  }

  #poolFor(role: AppRole | "admin"): Pool {
    if (this.#dropped) {
      throw new Error(`test database ${this.name} was already dropped`);
    }
    let pool = this.#pools.get(role);
    if (pool === undefined) {
      pool = new Pool({
        connectionString: this.url(role),
        application_name: `ytw-test-${role}`,
        max: 4,
        idleTimeoutMillis: 5_000,
      });
      // Idle connections are terminated when the database is dropped; that is expected here.
      pool.on("error", () => undefined);
      this.#pools.set(role, pool);
    }
    return pool;
  }
}

async function withAdminClient(
  serverUrl: string,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: serverUrl, application_name: "ytw-test-admin" });
  try {
    await client.connect();
  } catch (err) {
    const target = (() => {
      try {
        return new URL(serverUrl).host;
      } catch {
        return "the configured server";
      }
    })();
    throw new Error(
      `cannot reach the test Postgres at ${target} (TEST_DATABASE_URL): ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        "Start it with scripts/pg-local.sh start or docker compose up -d.",
      { cause: err },
    );
  }
  try {
    await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
