// The production setup from docs/database.md: a superuser creates the database and its owner role
// and runs sql/superuser-bootstrap.sql once; the migrations then run as that owner, which has
// CREATEROLE and ADMIN on the application roles but is not a superuser. Everything the other tests
// do as a superuser must work here too, including every migration later tasks add.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, migrate, scramSha256Verifier } from "../src/migrate.js";
import { createTestDb, testRolePasswords, testServerUrl } from "../src/testing.js";
import { failure, sqlstate } from "./helpers.js";

const BOOTSTRAP = fileURLToPath(new URL("../sql/superuser-bootstrap.sql", import.meta.url));
const suffix = randomBytes(5).toString("hex");
const owner = `ytw_test_owner_${suffix}`;
const ownerPassword = randomBytes(18).toString("hex");
const databases: string[] = [];
let admin: Client;

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(testServerUrl());
  url.pathname = `/${database}`;
  if (user !== undefined) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

/** A new database owned by the owner role, created by the superuser as production would. */
async function ownedDatabase(): Promise<string> {
  const database = `ytw_test_owned_${suffix}_${databases.length}`;
  databases.push(database);
  await admin.query(
    `CREATE DATABASE ${admin.escapeIdentifier(database)} OWNER ${admin.escapeIdentifier(owner)} TEMPLATE template0`,
  );
  return database;
}

async function asSuperuser<T>(database: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// No role passwords: a non-superuser cannot compare them and would re-set them on every run, which
// is harmless but changes the stored verifiers other test files may be looking at.
function migrateAsOwner(database: string) {
  return migrate({
    databaseUrl: urlFor(database, { name: owner, password: ownerPassword }),
    lockDatabaseUrl: testServerUrl(),
  });
}

beforeAll(async () => {
  // Make sure the application roles exist and carry the test passwords (a fresh cluster has none).
  await (await createTestDb()).drop();
  admin = new Client({ connectionString: testServerUrl() });
  await admin.connect();
  await admin.query(
    `CREATE ROLE ${admin.escapeIdentifier(owner)} LOGIN CREATEROLE PASSWORD ${admin.escapeLiteral(scramSha256Verifier(ownerPassword))}`,
  );
  await admin.query(
    `GRANT ytw_web, ytw_mcp, ytw_readonly TO ${admin.escapeIdentifier(owner)} WITH ADMIN OPTION`,
  );
});

afterAll(async () => {
  for (const database of databases) {
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)} WITH (FORCE)`);
  }
  await admin.query(`DROP ROLE IF EXISTS ${admin.escapeIdentifier(owner)}`);
  await admin.end();
});

describe("migrations run by a non-superuser owner", () => {
  it("stop at 0001 until a superuser has run superuser-bootstrap.sql", async () => {
    const database = await ownedDatabase();
    const err = await failure(migrateAsOwner(database));
    expect(err.message).toMatch(/0001_roles\.sql failed/);
    expect(err.message).toMatch(/executable by PUBLIC in this database: .*lo_create\(oid\)/);
    expect(err.message).toMatch(/run packages\/db\/sql\/superuser-bootstrap\.sql/);
  });

  it("apply cleanly after the bootstrap, own every function and keep the privilege rules", async () => {
    const database = await ownedDatabase();
    const bootstrap = await readFile(BOOTSTRAP, "utf8");
    await asSuperuser(database, (client) => client.query(bootstrap));
    // Idempotent: a second run changes nothing and does not fail.
    await asSuperuser(database, (client) => client.query(bootstrap));

    const result = await migrateAsOwner(database);
    expect(result.applied).toEqual((await loadMigrations()).map((file) => file.filename));

    await asSuperuser(database, async (check) => {
      const violations = await check.query("SELECT * FROM ytw_catalog_violations()");
      expect(violations.rows).toEqual([]);
      const owners = await check.query<{ owner: string }>(
        `SELECT DISTINCT proowner::regrole::text AS owner FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace`,
      );
      expect(owners.rows).toEqual([{ owner }]);
      const locks = await check.query<{ role: string; allowed: boolean }>(
        `SELECT r AS role, has_function_privilege(r, 'pg_advisory_xact_lock(bigint)', 'EXECUTE') AS allowed
           FROM unnest(ARRAY[$1, 'ytw_web', 'ytw_mcp', 'ytw_readonly']) AS r ORDER BY 1`,
        [owner],
      );
      expect(Object.fromEntries(locks.rows.map((row) => [row.role, row.allowed]))).toEqual({
        [owner]: true,
        ytw_mcp: false,
        ytw_readonly: false,
        ytw_web: false,
      });
    });

    // SECURITY DEFINER functions owned by a non-superuser still work for the app roles...
    const passwords = testRolePasswords();
    const mcp = new Client({
      connectionString: urlFor(database, { name: "ytw_mcp", password: passwords.ytw_mcp }),
    });
    await mcp.connect();
    try {
      const { rows } = await mcp.query<{ id: string }>(
        "SELECT ytw_log_event('bot', 'agent', NULL, 'tool.call', NULL, NULL, '{}') AS id",
      );
      expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
      // ... while the app roles themselves cannot take advisory locks or create large objects.
      expect(await sqlstate(mcp.query("SELECT pg_advisory_lock(1)"))).toBe("42501");
      expect(await sqlstate(mcp.query("SELECT lo_from_bytea(0, 'x')"))).toBe("42501");
    } finally {
      await mcp.end();
    }

    // A second run as the owner is a no-op.
    const again = await migrateAsOwner(database);
    expect(again.applied).toEqual([]);
  });
});
