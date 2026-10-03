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
 * The server is `TEST_DATABASE_URL`, a superuser connection (default: the local dev cluster of
 * `scripts/pg-local.sh` and docker compose). It must be on this machine unless
 * `YTW_DISPOSABLE_TEST_SERVER=1` declares it disposable. Each database gets a unique name and is
 * created from template0, so files and workers run in parallel safely. Migrations run under the
 * cluster-wide migration lock because the application roles are shared by every database in the
 * cluster. The harness gives a role a password only when it has none (or the server is declared
 * disposable); it never overwrites a different one. Never use this module outside tests.
 */
import { randomBytes } from "node:crypto";
import { Client, Pool } from "pg";
import { APP_ROLES, createPool, type AppRole } from "./client.js";
import { ROLE_PASSWORD_ENV, migrate, rolePasswordStatus } from "./migrate.js";

/** Used when TEST_DATABASE_URL is unset: the dev superuser of pg-local.sh and docker-compose.yml. */
export const DEFAULT_TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/postgres";

/**
 * Set to `1` to declare the test server disposable: tests may then use a server that is not on
 * this machine, and the harness may overwrite the application roles' passwords there.
 */
export const DISPOSABLE_TEST_SERVER_ENV = "YTW_DISPOSABLE_TEST_SERVER";

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

export interface CreateTestPoolOptions {
  /** Maximum connections in the pool (default 4). */
  max?: number;
  /** Overrides application_name in pg_stat_activity. */
  applicationName?: string;
  /** Connection startup options, e.g. -c default_transaction_isolation=... */
  options?: string;
}

export interface TestDb {
  /** The database name, unique per call (`ytw_test_...`). */
  readonly name: string;
  /** Superuser pool on this database, for fixtures and assertions only (never for code under test). */
  readonly admin: Pool;
  /** Pool that logs in as an application role, created like the services' pools (lazily, max 4). */
  pool(role: AppRole): Pool;
  /**
   * Creates an auxiliary pool for this test database with an idle error handler attached,
   * tracked so that `drop()` ends it automatically without leaking connections or errors.
   */
  createPool(role: AppRole, options?: CreateTestPoolOptions): Pool;
  /** Registers an externally created pool so that errors are caught and `drop()` ends it. */
  registerPool(pool: Pool): Pool;
  /** Connection string for an application role or the superuser, e.g. for a server under test. */
  url(role: AppRole | "admin"): string;
  /** Ends every pool and drops the database. Safe to call more than once. */
  drop(): Promise<void>;
}

/**
 * The superuser connection string the harness uses: `TEST_DATABASE_URL`, else
 * {@link DEFAULT_TEST_DATABASE_URL}. `MIGRATION_DATABASE_URL` is deliberately ignored, so that an
 * operator who migrated a real database never points the tests at it by accident. The database in
 * the URL (normally `postgres`) also holds the cluster-wide migration lock.
 */
export function testServerUrl(): string {
  const configured = process.env.TEST_DATABASE_URL?.trim();
  return configured === undefined || configured === "" ? DEFAULT_TEST_DATABASE_URL : configured;
}

/** True for localhost, 127.0.0.0/8, ::1 and Unix-socket connection strings. */
export function isLocalServer(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const socketHost = parsed.searchParams.get("host");
  if (socketHost !== null) {
    return socketHost.startsWith("/");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "" || host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
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
  if (!isLocalServer(serverUrl) && !isDisposable()) {
    throw new Error(
      `refusing to create test databases on ${describeHost(serverUrl)}: TEST_DATABASE_URL is not ` +
        `on this machine. Set ${DISPOSABLE_TEST_SERVER_ENV}=1 only if that server is disposable.`,
    );
  }
  const name = `ytw_test_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
  const passwords = testRolePasswords();

  await withAdminClient(serverUrl, async (client) => {
    await client.query(
      `CREATE DATABASE ${client.escapeIdentifier(name)} TEMPLATE template0 ENCODING 'UTF8'`,
    );
  });

  const db = new TestDatabase(serverUrl, name, passwords);
  if (options.migrate !== false) {
    const dir = options.migrationsDir === undefined ? {} : { migrationsDir: options.migrationsDir };
    try {
      await migrate({ databaseUrl: db.url("admin"), lockDatabaseUrl: serverUrl, ...dir });
      const missing = await passwordsToSet(serverUrl, passwords);
      if (Object.keys(missing).length > 0) {
        await migrate({
          databaseUrl: db.url("admin"),
          lockDatabaseUrl: serverUrl,
          rolePasswords: missing,
          ...dir,
        });
      }
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
  readonly #extraPools: Pool[] = [];
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

  registerPool(pool: Pool): Pool {
    pool.on("error", ignoreIdleError);
    this.#extraPools.push(pool);
    return pool;
  }

  createPool(role: AppRole, options: CreateTestPoolOptions = {}): Pool {
    if (this.#dropped) {
      throw new Error(`test database ${this.name} was already dropped`);
    }
    if (!(APP_ROLES as readonly string[]).includes(role)) {
      throw new TypeError(`unknown application role: ${String(role)}`);
    }
    const pool = new Pool({
      connectionString: this.url(role),
      application_name: options.applicationName ?? `ytw-test-${role}`,
      max: options.max ?? 4,
      idleTimeoutMillis: 5_000,
      ...(options.options === undefined ? {} : { options: options.options }),
    });
    return this.registerPool(pool);
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
    const pools = [...this.#pools.values(), ...this.#extraPools];
    this.#pools.clear();
    this.#extraPools.length = 0;
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
      pool =
        role === "admin"
          ? new Pool({
              connectionString: this.url(role),
              application_name: "ytw-test-admin",
              max: 4,
              idleTimeoutMillis: 5_000,
            }).on("error", ignoreIdleError)
          : createPool({
              role,
              connectionString: this.url(role),
              applicationName: `ytw-test-${role}`,
              max: 4,
              onError: ignoreIdleError,
            });
      this.#pools.set(role, pool);
    }
    return pool;
  }
}

/** Idle connections are terminated when the database is dropped; that is expected here. */
export function ignoreIdleError(): void {
  // Nothing to do.
}

function isDisposable(): boolean {
  return process.env[DISPOSABLE_TEST_SERVER_ENV] === "1";
}

/**
 * The roles whose password the harness may set: those without a password, or every role whose
 * password differs when the server is declared disposable. A different password on a server that
 * is not disposable is an error, so the harness never overwrites one somebody relies on.
 */
async function passwordsToSet(
  serverUrl: string,
  passwords: Record<AppRole, string>,
): Promise<Partial<Record<AppRole, string>>> {
  const toSet: Partial<Record<AppRole, string>> = {};
  const blocked: string[] = [];
  await withAdminClient(serverUrl, async (client) => {
    for (const role of APP_ROLES) {
      const status = await rolePasswordStatus(client, role, passwords[role]);
      if (status === "unset" || (status !== "matches" && isDisposable())) {
        toSet[role] = passwords[role];
      } else if (status !== "matches") {
        blocked.push(`${role} (${status === "unknown" ? "unreadable" : "different password"})`);
      }
    }
  });
  if (blocked.length > 0) {
    throw new Error(
      `the test passwords do not match these roles: ${blocked.join(", ")}. Export ` +
        `${APP_ROLES.map((role) => ROLE_PASSWORD_ENV[role]).join(", ")} with the roles' real ` +
        `passwords (TEST_DATABASE_URL must be a superuser to compare them), or set ` +
        `${DISPOSABLE_TEST_SERVER_ENV}=1 if the server is disposable and may be changed.`,
    );
  }
  return toSet;
}

function describeHost(url: string): string {
  try {
    return new URL(url).host || "a local socket";
  } catch {
    return "the configured server";
  }
}

async function withAdminClient(
  serverUrl: string,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: serverUrl, application_name: "ytw-test-admin" });
  client.on("error", ignoreIdleError);
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `cannot reach the test Postgres at ${describeHost(serverUrl)} (TEST_DATABASE_URL): ` +
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
