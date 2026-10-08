/**
 * Test harness (`@ytw/db/testing`): one throwaway, fully migrated database per test file. There are
 * no database mocks.
 *
 * ```ts
 * import { createTestDb, type TestDb } from "@ytw/db/testing";
 *
 * let db: TestDb;
 * beforeAll(async () => { db = await createTestDb(); });
 * afterAll(async () => { await db.drop(); });
 *
 * it("...", async () => {
 *   await withActor(db.pool, { name: "alice", type: "human" }, async (tx) => { ... });
 * });
 * ```
 *
 * The server is `TEST_DATABASE_URL` (default {@link DEFAULT_TEST_DATABASE_URL}): an admin
 * connection used only to create and drop the throwaway databases. Each database gets a unique name,
 * and so does the plain login role that owns it, so the code under test connects the way it does in
 * production (as the owner of its database, with no other privilege) and test files run in parallel
 * without touching each other. Never use this module outside tests.
 */
import { randomBytes } from "node:crypto";
import { Client, Pool } from "pg";
import { migrate } from "./migrate.js";

/** Used when TEST_DATABASE_URL is unset: the local development server. */
export const DEFAULT_TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/postgres";

export interface CreateTestDbOptions {
  /** Apply the migrations (default true). */
  migrate?: boolean;
}

export interface TestDb {
  /** The database name, unique per call (`ytw_test_...`); the owner role has the same name. */
  readonly name: string;
  /** Connection string of the owner role, e.g. for a server under test. */
  readonly url: string;
  /** Pool on this database as its owner. Ended by `drop()`. */
  readonly pool: Pool;
  /** Ends the pool and drops the database and its role. Safe to call more than once. */
  drop(): Promise<void>;
}

/** Idle connections are terminated when the database is dropped; that is expected here. */
function ignoreIdleError(): void {
  // Nothing to do.
}

function serverUrl(): string {
  const configured = process.env.TEST_DATABASE_URL?.trim();
  return configured === undefined || configured === "" ? DEFAULT_TEST_DATABASE_URL : configured;
}

async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: serverUrl(), application_name: "ytw-test-admin" });
  client.on("error", ignoreIdleError);
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `cannot reach the test Postgres (TEST_DATABASE_URL): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Creates (and by default migrates) a uniquely named database. Call `drop()` in `afterAll`. */
export async function createTestDb(options: CreateTestDbOptions = {}): Promise<TestDb> {
  const name = `ytw_test_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
  const password = randomBytes(18).toString("hex");
  const url = new URL(serverUrl());
  url.username = name;
  url.password = password;
  url.pathname = `/${name}`;

  await withAdminClient(async (admin) => {
    const role = admin.escapeIdentifier(name);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD ${admin.escapeLiteral(password)}`);
    await admin.query(`CREATE DATABASE ${role} OWNER ${role} TEMPLATE template0 ENCODING 'UTF8'`);
  });

  const pool = new Pool({
    connectionString: url.toString(),
    application_name: "ytw-test",
    max: 4,
    idleTimeoutMillis: 5_000,
  });
  pool.on("error", ignoreIdleError);

  let dropped = false;
  const db: TestDb = {
    name,
    url: url.toString(),
    pool,
    async drop() {
      if (dropped) {
        return;
      }
      dropped = true;
      await pool.end().catch(() => undefined);
      await withAdminClient(async (admin) => {
        const role = admin.escapeIdentifier(name);
        await admin.query(`DROP DATABASE IF EXISTS ${role} WITH (FORCE)`);
        await admin.query(`DROP ROLE IF EXISTS ${role}`);
      });
    },
  };

  if (options.migrate !== false) {
    try {
      await migrate({ databaseUrl: db.url });
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
