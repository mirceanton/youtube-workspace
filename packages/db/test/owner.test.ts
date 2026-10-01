// The production setup from docs/database.md: migrations run as a database owner that has
// CREATEROLE and ADMIN on the application roles, but is not a superuser. Everything the other tests
// do as a superuser must work here too, including every migration later tasks add.
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, scramSha256Verifier } from "../src/migrate.js";
import { createTestDb, testRolePasswords, testServerUrl } from "../src/testing.js";

describe("migrations run by a non-superuser owner", () => {
  it("apply cleanly, own every function and keep the privilege rules", async () => {
    // Make sure the application roles exist (a fresh cluster has none yet).
    await (await createTestDb()).drop();

    const suffix = randomBytes(5).toString("hex");
    const owner = `ytw_test_owner_${suffix}`;
    const database = `ytw_test_owned_${suffix}`;
    const password = randomBytes(18).toString("hex");

    const admin = new Client({ connectionString: testServerUrl() });
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${admin.escapeIdentifier(owner)} LOGIN CREATEROLE PASSWORD ${admin.escapeLiteral(scramSha256Verifier(password))}`,
      );
      await admin.query(
        `GRANT ytw_web, ytw_mcp, ytw_readonly TO ${admin.escapeIdentifier(owner)} WITH ADMIN OPTION`,
      );
      await admin.query(
        `CREATE DATABASE ${admin.escapeIdentifier(database)} OWNER ${admin.escapeIdentifier(owner)} TEMPLATE template0`,
      );

      const ownerUrl = new URL(testServerUrl());
      ownerUrl.username = owner;
      ownerUrl.password = password;
      ownerUrl.pathname = `/${database}`;
      const result = await migrate({
        databaseUrl: ownerUrl.toString(),
        lockDatabaseUrl: testServerUrl(),
        rolePasswords: testRolePasswords(),
      });
      expect(result.applied).toEqual((await loadMigrations()).map((file) => file.filename));

      const inspect = new URL(testServerUrl());
      inspect.pathname = `/${database}`;
      const check = new Client({ connectionString: inspect.toString() });
      await check.connect();
      try {
        const violations = await check.query("SELECT * FROM ytw_catalog_violations()");
        expect(violations.rows).toEqual([]);
        const owners = await check.query<{ owner: string }>(
          `SELECT DISTINCT proowner::regrole::text AS owner FROM pg_proc
            WHERE pronamespace = 'public'::regnamespace`,
        );
        expect(owners.rows).toEqual([{ owner }]);
      } finally {
        await check.end();
      }

      // SECURITY DEFINER functions owned by a non-superuser still work for the app roles.
      const mcpUrl = new URL(inspect);
      mcpUrl.username = "ytw_mcp";
      mcpUrl.password = testRolePasswords().ytw_mcp;
      const mcp = new Client({ connectionString: mcpUrl.toString() });
      await mcp.connect();
      try {
        const { rows } = await mcp.query<{ id: string }>(
          "SELECT ytw_log_event('bot', 'agent', NULL, 'tool.call', NULL, NULL, '{}') AS id",
        );
        expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
      } finally {
        await mcp.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${admin.escapeIdentifier(owner)}`);
      await admin.end();
    }
  });
});
