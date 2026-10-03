// Gate: Function privileges & catalog access control hardening (PRD 5, PRD 9).
//
// 1. ytw_readonly must NOT be able to execute any mutating functions.
// 2. Roles cannot execute unauthorized functions (e.g. MCP cannot run web-only admin functions,
//    Web cannot run MCP-only token lookup, no role can run internal ytw_% helpers directly).
// 3. Catalog audit: PUBLIC has EXECUTE revoked on ALL functions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ROLES } from "../../src/client.js";
import { createTestDb, type TestDb } from "../../src/testing.js";
import { sqlstate } from "../helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

// Mutating functions across the entire schema
const MUTATING_FUNCTION_CALLS: readonly { name: string; query: string }[] = [
  {
    name: "create_idea",
    query:
      "SELECT * FROM public.create_idea('hacker', 'human', NULL, 'Title', NULL, NULL, ARRAY[]::text[], NULL)",
  },
  {
    name: "update_idea",
    query:
      "SELECT * FROM public.update_idea('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, 1, '{}'::jsonb)",
  },
  {
    name: "advance_idea",
    query:
      "SELECT * FROM public.advance_idea('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, 'shortlisted')",
  },
  {
    name: "archive_idea",
    query:
      "SELECT * FROM public.archive_idea('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid)",
  },
  {
    name: "save_script_version",
    query:
      "SELECT * FROM public.save_script_version('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, 'script', 1, '# Body')",
  },
  {
    name: "set_script_status",
    query:
      "SELECT * FROM public.set_script_status('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, 'approved')",
  },
  {
    name: "register_video",
    query:
      "SELECT * FROM public.register_video('hacker', 'human', NULL, NULL, 'yt123456789', 'Title', now(), NULL)",
  },
  {
    name: "update_video",
    query:
      "SELECT * FROM public.update_video('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, 1, '{}'::jsonb)",
  },
  {
    name: "archive_video",
    query:
      "SELECT * FROM public.archive_video('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid)",
  },
  {
    name: "log_metrics",
    query:
      "SELECT * FROM public.log_metrics('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, now(), '{}'::jsonb)",
  },
  {
    name: "create_experiment",
    query:
      "SELECT * FROM public.create_experiment('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, 'title', 'Hypo', '[]'::jsonb)",
  },
  {
    name: "record_variant_stats",
    query:
      "SELECT * FROM public.record_variant_stats('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, 100, 0.1)",
  },
  {
    name: "conclude_experiment",
    query:
      "SELECT * FROM public.conclude_experiment('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, 1, '00000000-0000-0000-0000-000000000000'::uuid, 'Done')",
  },
  {
    name: "update_experiment_status",
    query:
      "SELECT * FROM public.update_experiment_status('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, 1, 'running')",
  },
  {
    name: "add_note",
    query:
      "SELECT * FROM public.add_note('hacker', 'human', NULL, 'idea', '00000000-0000-0000-0000-000000000000'::uuid, 'Note text')",
  },
  {
    name: "upsert_user_on_login",
    query:
      "SELECT * FROM public.upsert_user_on_login('hacker', 'human', NULL, 'iss', 'sub', 'user', 'email@test.com', 'Display')",
  },
  {
    name: "set_user_permission",
    query:
      "SELECT * FROM public.set_user_permission('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'ideas', 'read')",
  },
  {
    name: "set_user_admin",
    query:
      "SELECT * FROM public.set_user_admin('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, true, false)",
  },
  {
    name: "mark_user_outside_access_group",
    query:
      "SELECT * FROM public.mark_user_outside_access_group('hacker', 'human', NULL, 'iss', 'sub')",
  },
  {
    name: "set_user_access_revoked",
    query:
      "SELECT * FROM public.set_user_access_revoked('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, true)",
  },
  {
    name: "create_api_token",
    query:
      "SELECT * FROM public.create_api_token('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, 'tok', 'prefix', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', NULL, '{}'::jsonb)",
  },
  {
    name: "update_token_permissions",
    query:
      "SELECT * FROM public.update_token_permissions('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, '{}'::jsonb)",
  },
  {
    name: "rotate_api_token",
    query:
      "SELECT * FROM public.rotate_api_token('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'pfx', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', false, NULL)",
  },
  {
    name: "revoke_api_token",
    query:
      "SELECT * FROM public.revoke_api_token('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid)",
  },
  {
    name: "create_web_session",
    query:
      "SELECT * FROM public.create_web_session('00000000-0000-0000-0000-000000000000'::uuid, 'test'::bytea, 'hint', 3600, 86400)",
  },
  {
    name: "touch_web_session",
    query:
      "SELECT * FROM public.touch_web_session('00000000-0000-0000-0000-000000000000'::uuid, 3600)",
  },
  {
    name: "update_web_session_tokens",
    query:
      "SELECT * FROM public.update_web_session_tokens('00000000-0000-0000-0000-000000000000'::uuid, 'test'::bytea, 'hint')",
  },
  {
    name: "delete_web_session",
    query: "SELECT * FROM public.delete_web_session('00000000-0000-0000-0000-000000000000'::uuid)",
  },
  {
    name: "purge_expired_web_sessions",
    query: "SELECT public.purge_expired_web_sessions()",
  },
  {
    name: "touch_token_last_used",
    query:
      "SELECT public.touch_token_last_used('agent', 'agent', '00000000-0000-0000-0000-000000000000'::uuid)",
  },
];

// Web-only functions that ytw_mcp must not be able to execute
const WEB_ONLY_FUNCTION_CALLS: readonly { name: string; query: string }[] = [
  {
    name: "upsert_user_on_login",
    query:
      "SELECT * FROM public.upsert_user_on_login('hacker', 'human', NULL, 'iss', 'sub', 'user', 'email@test.com', 'Display')",
  },
  {
    name: "set_user_permission",
    query:
      "SELECT * FROM public.set_user_permission('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'ideas', 'read')",
  },
  {
    name: "set_user_admin",
    query:
      "SELECT * FROM public.set_user_admin('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, true, false)",
  },
  {
    name: "list_users_with_levels",
    query:
      "SELECT * FROM public.list_users_with_levels('00000000-0000-0000-0000-000000000000'::uuid)",
  },
  {
    name: "get_user_access",
    query: "SELECT * FROM public.get_user_access('00000000-0000-0000-0000-000000000000'::uuid)",
  },
  {
    name: "mark_user_outside_access_group",
    query:
      "SELECT * FROM public.mark_user_outside_access_group('hacker', 'human', NULL, 'iss', 'sub')",
  },
  {
    name: "set_user_access_revoked",
    query:
      "SELECT * FROM public.set_user_access_revoked('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, true)",
  },
  {
    name: "create_api_token",
    query:
      "SELECT * FROM public.create_api_token('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, 'tok', 'prefix', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', NULL, '{}'::jsonb)",
  },
  {
    name: "update_token_permissions",
    query:
      "SELECT * FROM public.update_token_permissions('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, '{}'::jsonb)",
  },
  {
    name: "rotate_api_token",
    query:
      "SELECT * FROM public.rotate_api_token('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'pfx', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', false, NULL)",
  },
  {
    name: "revoke_api_token",
    query:
      "SELECT * FROM public.revoke_api_token('hacker', 'human', NULL, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid)",
  },
  {
    name: "list_api_tokens",
    query: "SELECT * FROM public.list_api_tokens('00000000-0000-0000-0000-000000000000'::uuid)",
  },
  {
    name: "get_api_token",
    query:
      "SELECT * FROM public.get_api_token('00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid)",
  },
  {
    name: "create_web_session",
    query:
      "SELECT * FROM public.create_web_session('00000000-0000-0000-0000-000000000000'::uuid, 'test'::bytea, 'hint', 3600, 86400)",
  },
  {
    name: "touch_web_session",
    query:
      "SELECT * FROM public.touch_web_session('00000000-0000-0000-0000-000000000000'::uuid, 3600)",
  },
  {
    name: "update_web_session_tokens",
    query:
      "SELECT * FROM public.update_web_session_tokens('00000000-0000-0000-0000-000000000000'::uuid, 'test'::bytea, 'hint')",
  },
  {
    name: "delete_web_session",
    query: "SELECT * FROM public.delete_web_session('00000000-0000-0000-0000-000000000000'::uuid)",
  },
  {
    name: "purge_expired_web_sessions",
    query: "SELECT public.purge_expired_web_sessions()",
  },
];

// MCP-only functions that ytw_web must not be able to execute
const MCP_ONLY_FUNCTION_CALLS: readonly { name: string; query: string }[] = [
  {
    name: "lookup_token_by_hash",
    query:
      "SELECT * FROM public.lookup_token_by_hash('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')",
  },
  {
    name: "touch_token_last_used",
    query:
      "SELECT public.touch_token_last_used('agent', 'agent', '00000000-0000-0000-0000-000000000000'::uuid)",
  },
];

// Internal private helper functions in public that NO role may execute directly
const INTERNAL_HELPER_CALLS: readonly { name: string; query: string }[] = [
  { name: "ytw_idea_stages", query: "SELECT public.ytw_idea_stages()" },
  {
    name: "ytw_idea_stage_transitions",
    query: "SELECT * FROM public.ytw_idea_stage_transitions()",
  },
  {
    name: "ytw_check_idea_field",
    query: "SELECT public.ytw_check_idea_field('title', '\"foo\"'::jsonb)",
  },
  {
    name: "ytw_insert_note",
    query:
      "SELECT public.ytw_insert_note('idea', '00000000-0000-0000-0000-000000000000'::uuid, 'body', 'note')",
  },
  { name: "ytw_lock_users", query: "SELECT public.ytw_lock_users()" },
  {
    name: "ytw_user_effective_levels",
    query: "SELECT public.ytw_user_effective_levels('00000000-0000-0000-0000-000000000000'::uuid)",
  },
  {
    name: "ytw_token_own_levels",
    query: "SELECT public.ytw_token_own_levels('00000000-0000-0000-0000-000000000000'::uuid)",
  },
  {
    name: "ytw_effective_levels",
    query: "SELECT public.ytw_effective_levels('{}'::jsonb, '{}'::jsonb)",
  },
  {
    name: "ytw_raise",
    query: "SELECT public.ytw_raise('validation', 'msg', '{}'::jsonb, 'hint')",
  },
  { name: "ytw_resources", query: "SELECT public.ytw_resources()" },
  {
    name: "ytw_session_status",
    query: "SELECT public.ytw_session_status(now(), now())",
  },
  {
    name: "ytw_token_status",
    query: "SELECT public.ytw_token_status(NULL, NULL, NULL)",
  },
];

describe("gate: function privileges hardening", () => {
  describe("ytw_readonly privilege boundaries", () => {
    for (const call of MUTATING_FUNCTION_CALLS) {
      it(`rejects ytw_readonly executing mutating function ${call.name} with 42501`, async () => {
        const client = await db.pool("ytw_readonly").connect();
        try {
          await client.query("SET default_transaction_read_only = off");
          const code = await sqlstate(client.query(call.query));
          expect(code).toBe("42501");
        } finally {
          client.release();
        }
      });
    }
  });

  describe("role segregation between ytw_mcp and ytw_web", () => {
    for (const call of WEB_ONLY_FUNCTION_CALLS) {
      it(`rejects ytw_mcp executing web-only admin function ${call.name} with 42501`, async () => {
        const client = await db.pool("ytw_mcp").connect();
        try {
          const code = await sqlstate(client.query(call.query));
          expect(code).toBe("42501");
        } finally {
          client.release();
        }
      });
    }

    for (const call of MCP_ONLY_FUNCTION_CALLS) {
      it(`rejects ytw_web executing mcp-only function ${call.name} with 42501`, async () => {
        const client = await db.pool("ytw_web").connect();
        try {
          const code = await sqlstate(client.query(call.query));
          expect(code).toBe("42501");
        } finally {
          client.release();
        }
      });
    }
  });

  describe("internal private functions (ytw_%) cannot be called directly", () => {
    for (const role of APP_ROLES) {
      for (const call of INTERNAL_HELPER_CALLS) {
        it(`rejects ${role} executing internal helper ${call.name} with 42501`, async () => {
          const client = await db.pool(role).connect();
          try {
            if (role === "ytw_readonly") {
              await client.query("SET default_transaction_read_only = off");
            }
            const code = await sqlstate(client.query(call.query));
            expect(code).toBe("42501");
          } finally {
            client.release();
          }
        });
      }
    }
  });

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

    it("ytw_readonly has EXECUTE on exactly 0 functions", async () => {
      const { rows } = await db.admin.query<{ proname: string }>(`
        SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'ytw_private')
          AND has_function_privilege('ytw_readonly', p.oid, 'EXECUTE')
      `);
      expect(rows).toEqual([]);
    });

    it("ytw_catalog_violations reports 0 violations across all objects", async () => {
      const { rows } = await db.admin.query("SELECT * FROM public.ytw_catalog_violations()");
      expect(rows).toEqual([]);
    });
  });
});
