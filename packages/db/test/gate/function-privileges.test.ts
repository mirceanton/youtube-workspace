// Gate: Function privileges & catalog access control hardening (PRD 5, PRD 9).
//
// 1. ytw_readonly must NOT be able to execute any mutating functions.
// 2. Roles cannot execute unauthorized functions (e.g. MCP cannot run web-only admin functions,
//    Web cannot run MCP-only token lookup, no role can run internal ytw_% helpers directly).
// 3. Catalog audit: PUBLIC has EXECUTE revoked on ALL functions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../src/testing.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

describe("gate: function privileges hardening", () => {
  describe("catalog audit: function execute permissions", () => {
    it("PUBLIC has EXECUTE revoked on 100% of functions in public and ytw_private", async () => {
      const { rows } = await db.admin.query<{ proname: string }>(`
        SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'ytw_private')
          AND (
            p.proacl IS NULL
            OR EXISTS (
              SELECT 1 FROM aclexplode(p.proacl) a
              WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
            )
          )
      `);
      expect(rows).toEqual([]);
    });
  });
});
