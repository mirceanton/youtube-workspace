// Gate: Adversarial direct DML hardening (PRD 5 "Database roles", PRD 9 "Security").
//
// Verifies that neither ytw_web, ytw_mcp nor ytw_readonly can perform direct table-level DML
// or DDL on any table in the public or ytw_private schemas.
// All writes must flow strictly through SECURITY DEFINER database functions.
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ROLES, type AppRole } from "../../src/client.js";
import { createTestDb, type TestDb } from "../../src/testing.js";
import { sqlstate } from "../helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

const PUBLIC_TABLES = [
  "ideas",
  "scripts",
  "videos",
  "video_metrics",
  "experiments",
  "experiment_variants",
  "notes",
  "events",
  "users",
  "user_permissions",
  "schema_migrations",
];

const PRIVATE_TABLES = ["api_tokens", "api_token_permissions", "web_sessions"];

const ALL_TABLES = [
  { schema: "public", table: "ideas", sampleCol: "title = 'adversarial'" },
  { schema: "public", table: "scripts", sampleCol: "body_md = 'adversarial'" },
  { schema: "public", table: "videos", sampleCol: "title = 'adversarial'" },
  { schema: "public", table: "video_metrics", sampleCol: "views = 999" },
  { schema: "public", table: "experiments", sampleCol: "hypothesis = 'adversarial'" },
  { schema: "public", table: "experiment_variants", sampleCol: "content = 'adversarial'" },
  { schema: "public", table: "notes", sampleCol: "body_md = 'adversarial'" },
  { schema: "public", table: "events", sampleCol: "action = 'adversarial'" },
  { schema: "public", table: "users", sampleCol: "username = 'adversarial'" },
  { schema: "public", table: "user_permissions", sampleCol: "level = 'write'" },
  { schema: "public", table: "schema_migrations", sampleCol: "filename = 'adversarial'" },
  { schema: "ytw_private", table: "api_tokens", sampleCol: "name = 'adversarial'" },
  { schema: "ytw_private", table: "api_token_permissions", sampleCol: "level = 'write'" },
  { schema: "ytw_private", table: "web_sessions", sampleCol: "id_token_hint = 'adversarial'" },
];

async function withRoleClient<T>(
  role: AppRole,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.pool(role).connect();
  try {
    if (role === "ytw_readonly") {
      await client.query("SET default_transaction_read_only = off");
    }
    return await fn(client);
  } finally {
    client.release();
  }
}

describe("gate: direct table-level DML and DDL hardening", () => {
  for (const role of APP_ROLES) {
    describe(`role: ${role}`, () => {
      describe("public tables", () => {
        for (const tableName of PUBLIC_TABLES) {
          const entry = ALL_TABLES.find((t) => t.schema === "public" && t.table === tableName)!;
          const qualified = `public.${tableName}`;

          it(`rejects direct INSERT on ${qualified} with 42501`, async () => {
            const code = await withRoleClient(role, (client) =>
              sqlstate(client.query(`INSERT INTO ${qualified} DEFAULT VALUES`)),
            );
            expect(code).toBe("42501");
          });

          it(`rejects direct UPDATE on ${qualified} with 42501`, async () => {
            const code = await withRoleClient(role, (client) =>
              sqlstate(client.query(`UPDATE ${qualified} SET ${entry.sampleCol}`)),
            );
            expect(code).toBe("42501");
          });

          it(`rejects direct DELETE on ${qualified} with 42501`, async () => {
            const code = await withRoleClient(role, (client) =>
              sqlstate(client.query(`DELETE FROM ${qualified}`)),
            );
            expect(code).toBe("42501");
          });

          it(`rejects direct TRUNCATE on ${qualified} with 42501`, async () => {
            const code = await withRoleClient(role, (client) =>
              sqlstate(client.query(`TRUNCATE TABLE ${qualified}`)),
            );
            expect(code).toBe("42501");
          });

          it(`rejects direct ALTER TABLE on ${qualified} with 42501`, async () => {
            const code = await withRoleClient(role, (client) =>
              sqlstate(client.query(`ALTER TABLE ${qualified} ADD COLUMN evil_col text`)),
            );
            expect(code).toBe("42501");
          });

          it(`rejects direct DROP TABLE on ${qualified} with 42501`, async () => {
            const code = await withRoleClient(role, (client) =>
              sqlstate(client.query(`DROP TABLE ${qualified}`)),
            );
            expect(code).toBe("42501");
          });
        }
      });

      describe("ytw_private tables", () => {
        for (const tableName of PRIVATE_TABLES) {
          const entry = ALL_TABLES.find(
            (t) => t.schema === "ytw_private" && t.table === tableName,
          )!;
          const qualified = `ytw_private.${tableName}`;

          it(`rejects direct INSERT on ${qualified} with 42501`, async () => {
            const code = await withRoleClient(role, (client) =>
              sqlstate(client.query(`INSERT INTO ${qualified} DEFAULT VALUES`)),
            );
            expect(code).toBe("42501");
          });

          it(`rejects direct UPDATE on ${qualified} with 42501`, async () => {
            const code = await withRoleClient(role, (client) =>
              sqlstate(client.query(`UPDATE ${qualified} SET ${entry.sampleCol}`)),
            );
            expect(code).toBe("42501");
          });

          it(`rejects direct DELETE on ${qualified} with 42501`, async () => {
            const code = await withRoleClient(role, (client) =>
              sqlstate(client.query(`DELETE FROM ${qualified}`)),
            );
            expect(code).toBe("42501");
          });

          it(`rejects direct TRUNCATE on ${qualified} with 42501`, async () => {
            const code = await withRoleClient(role, (client) =>
              sqlstate(client.query(`TRUNCATE TABLE ${qualified}`)),
            );
            expect(code).toBe("42501");
          });

          it(`rejects direct ALTER TABLE on ${qualified} with 42501`, async () => {
            const code = await withRoleClient(role, (client) =>
              sqlstate(client.query(`ALTER TABLE ${qualified} ADD COLUMN evil_col text`)),
            );
            expect(code).toBe("42501");
          });

          it(`rejects direct DROP TABLE on ${qualified} with 42501`, async () => {
            const code = await withRoleClient(role, (client) =>
              sqlstate(client.query(`DROP TABLE ${qualified}`)),
            );
            expect(code).toBe("42501");
          });

          it(`rejects direct SELECT on ${qualified} with 42501`, async () => {
            const code = await withRoleClient(role, (client) =>
              sqlstate(client.query(`SELECT * FROM ${qualified}`)),
            );
            expect(code).toBe("42501");
          });
        }
      });

      describe("schema DDL", () => {
        it("rejects CREATE TABLE in schema public with 42501", async () => {
          const code = await withRoleClient(role, (client) =>
            sqlstate(client.query(`CREATE TABLE public.evil_${role} (id int)`)),
          );
          expect(code).toBe("42501");
        });

        it("rejects CREATE TABLE in schema ytw_private with 42501", async () => {
          const code = await withRoleClient(role, (client) =>
            sqlstate(client.query(`CREATE TABLE ytw_private.evil_${role} (id int)`)),
          );
          expect(code).toBe("42501");
        });
      });
    });
  }
});
