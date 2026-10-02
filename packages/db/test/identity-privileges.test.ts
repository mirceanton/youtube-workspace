// Privileges of the identity, permission, token and session functions (migrations 0050-0054, T14):
// who may EXECUTE what, and that nothing can be done around the functions.
//
// PRD 5: no application role holds INSERT/UPDATE on anything, every write is a SECURITY DEFINER
// function. The grants are the access policy of this area:
//   * token authentication (lookup_token_by_hash, touch_token_last_used): ytw_mcp and ytw_web;
//   * login, access management, token management and sessions: ytw_web only;
//   * helpers: nobody (they run inside the functions above, as the migration owner);
//   * ytw_readonly (query_sql): nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ROLES, type AppRole } from "../src/client.js";
import { loadMigrations } from "../src/migrate.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { sqlstate } from "./helpers.js";

const WEB: readonly AppRole[] = ["ytw_web"];
const WEB_AND_MCP: readonly AppRole[] = ["ytw_mcp", "ytw_web"];
const NOBODY: readonly AppRole[] = [];

/** Every function of migrations 0050-0054 with the roles that may execute it. */
const GRANTS: Readonly<Record<string, readonly AppRole[]>> = {
  // 0051 identity
  "upsert_user_on_login(text,text,uuid,text,text,text,text,text)": WEB,
  "get_user_access(uuid)": WEB,
  // 0052 permissions
  "set_user_permission(text,text,uuid,uuid,uuid,text,text)": WEB,
  "set_user_admin(text,text,uuid,uuid,uuid,boolean,boolean)": WEB,
  "list_users_with_levels(uuid)": WEB,
  // 0053 tokens
  "create_api_token(text,text,uuid,uuid,text,text,text,timestamp with time zone,jsonb)": WEB,
  "update_token_permissions(text,text,uuid,uuid,uuid,jsonb)": WEB,
  "rotate_api_token(text,text,uuid,uuid,uuid,text,text,boolean,timestamp with time zone)": WEB,
  "revoke_api_token(text,text,uuid,uuid,uuid)": WEB,
  "list_api_tokens(uuid)": WEB,
  "get_api_token(uuid,uuid)": WEB,
  "lookup_token_by_hash(text)": WEB_AND_MCP,
  "touch_token_last_used(text,text,uuid)": WEB_AND_MCP,
  // 0054 sessions
  "create_web_session(uuid,bytea,text,integer,integer)": WEB,
  "touch_web_session(uuid,integer)": WEB,
  "get_web_session(uuid)": WEB,
  "update_web_session_tokens(uuid,bytea,text)": WEB,
  "delete_web_session(uuid)": WEB,
  "purge_expired_web_sessions()": WEB,
  // Helpers (0050, 0053, 0054): called by the functions above, never by a role.
  "ytw_resources()": NOBODY,
  "ytw_level_rank(text)": NOBODY,
  "ytw_max_level(text)": NOBODY,
  "ytw_least_level(text,text)": NOBODY,
  "ytw_cap_level(text,text)": NOBODY,
  "ytw_lock_users()": NOBODY,
  "ytw_user_effective_levels(uuid)": NOBODY,
  "ytw_token_own_levels(uuid)": NOBODY,
  "ytw_effective_levels(jsonb,jsonb)": NOBODY,
  "ytw_clean_text(text,integer)": NOBODY,
  "ytw_clean_email(text)": NOBODY,
  "ytw_acting_user(text,text,uuid,text,boolean)": NOBODY,
  "ytw_sync_user_rows(uuid,boolean)": NOBODY,
  "ytw_check_token_grant(text,jsonb,jsonb)": NOBODY,
  "ytw_token_status(timestamp with time zone,timestamp with time zone)": NOBODY,
  "ytw_api_token_info_of(uuid)": NOBODY,
  "ytw_check_token_secret(text,text)": NOBODY,
  "ytw_session_status(timestamp with time zone,timestamp with time zone)": NOBODY,
  "ytw_check_session_args(integer,integer,bytea,text)": NOBODY,
};

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

interface FunctionInfo {
  signature: string;
  security_definer: boolean;
  config: string[] | null;
  owner: string;
  public_execute: boolean;
  grantees: string[];
}

async function functionInfo(signature: string): Promise<FunctionInfo | undefined> {
  const { rows } = await db.admin.query<FunctionInfo>(
    `SELECT $1::text AS signature, p.prosecdef AS security_definer, p.proconfig AS config,
            pg_get_userbyid(p.proowner) AS owner,
            coalesce(p.proacl IS NULL OR EXISTS (
              SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
            ), true) AS public_execute,
            coalesce((SELECT array_agg(r.rolname::text ORDER BY r.rolname)
                        FROM aclexplode(p.proacl) a
                        JOIN pg_roles r ON r.oid = a.grantee
                       WHERE a.privilege_type = 'EXECUTE' AND r.rolname = ANY ($2)), '{}') AS grantees
       FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
    [`public.${signature}`, [...APP_ROLES]],
  );
  return rows[0];
}

describe("EXECUTE grants", () => {
  const entries = Object.entries(GRANTS);

  it.each(entries)("%s is executable by exactly: %j", async (signature, roles) => {
    const info = await functionInfo(signature);
    expect(info, `${signature} does not exist`).toBeDefined();
    expect(info?.grantees).toEqual([...roles].toSorted());
    expect(info?.public_execute).toBe(false);
  });

  it("covers every function the migrations 0050-0054 create (a new function must be listed with its grants)", async () => {
    const created = (await loadMigrations())
      .filter((file) => file.version >= "0050" && file.version <= "0059")
      .flatMap((file) =>
        [...file.sql.matchAll(/^CREATE FUNCTION public\.(\w+)\(/gm)].map((match) => match[1] ?? ""),
      );
    expect(created.length).toBeGreaterThan(30);
    const listed = new Set(Object.keys(GRANTS).map((signature) => signature.split("(")[0]));
    expect(new Set(created)).toEqual(listed);
  });

  it("every function an application role may execute is SECURITY DEFINER with the pinned search_path, owned by the migration owner", async () => {
    const owner = await db.admin.query<{ owner: string }>(
      "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'schema_migrations'",
    );
    for (const [signature, roles] of Object.entries(GRANTS)) {
      if (roles.length === 0) {
        continue;
      }
      const info = await functionInfo(signature);
      expect({ signature, definer: info?.security_definer, config: info?.config }).toEqual({
        signature,
        definer: true,
        config: expect.arrayContaining(["search_path=pg_catalog, public, pg_temp"]),
      });
      expect(info?.owner).toBe(owner.rows[0]?.owner);
    }
  });

  it("ytw_readonly executes none of them, and no SECURITY DEFINER function at all", async () => {
    const { rows } = await db.admin.query<{ fn: string }>(
      `SELECT p.oid::regprocedure::text AS fn
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'ytw_private') AND p.prosecdef
          AND has_function_privilege('ytw_readonly', p.oid, 'EXECUTE')`,
    );
    expect(rows).toEqual([]);
  });

  it("the catalog guard is satisfied", async () => {
    expect((await db.admin.query("SELECT * FROM ytw_catalog_violations()")).rows).toEqual([]);
  });
});

describe("calling the functions as the application roles", () => {
  const web = () => db.pool("ytw_web");
  const mcp = () => db.pool("ytw_mcp");
  const readonly = () => db.pool("ytw_readonly");
  const nobody = "00000000-0000-4000-8000-0000000000aa";
  const hash = "0".repeat(64);

  it("ytw_mcp authenticates tokens but cannot do anything else in this area", async () => {
    expect((await mcp().query("SELECT * FROM lookup_token_by_hash($1)", [hash])).rowCount).toBe(0);
    expect(
      (await mcp().query("SELECT touch_token_last_used('bot', 'agent', $1) AS touched", [nobody]))
        .rows[0],
    ).toEqual({ touched: false });

    const denied: [string, unknown[]][] = [
      ["SELECT * FROM upsert_user_on_login('a', 'human', NULL, 'https://i', 's', 'a')", []],
      ["SELECT * FROM get_user_access($1)", [nobody]],
      ["SELECT * FROM list_users_with_levels($1)", [nobody]],
      ["SELECT * FROM list_api_tokens($1)", [nobody]],
      ["SELECT * FROM get_api_token($1, $1)", [nobody]],
      ["SELECT * FROM get_web_session($1)", [nobody]],
      ["SELECT delete_web_session($1)", [nobody]],
      ["SELECT purge_expired_web_sessions()", []],
      ["SELECT ytw_lock_users()", []],
    ];
    for (const [statement, params] of denied) {
      expect(await sqlstate(mcp().query(statement, params)), statement).toBe("42501");
    }
  });

  it("ytw_readonly (query_sql) can call none of them", async () => {
    const attempts: [string, unknown[]][] = [
      ["SELECT * FROM lookup_token_by_hash($1)", [hash]],
      ["SELECT touch_token_last_used('bot', 'agent', $1)", [nobody]],
      ["SELECT * FROM get_user_access($1)", [nobody]],
      ["SELECT * FROM list_api_tokens($1)", [nobody]],
      ["SELECT * FROM get_web_session($1)", [nobody]],
      ["SELECT ytw_resources()", []],
      ["SELECT ytw_user_effective_levels($1)", [nobody]],
    ];
    for (const [statement, params] of attempts) {
      expect(await sqlstate(readonly().query(statement, params)), statement).toBe("42501");
    }
  });

  it("the helpers are out of reach of every application role", async () => {
    const attempts = [
      "SELECT ytw_resources()",
      "SELECT ytw_level_rank('read')",
      "SELECT ytw_max_level('ideas')",
      "SELECT ytw_least_level('read', 'write')",
      "SELECT ytw_cap_level('activity', 'write')",
      "SELECT ytw_lock_users()",
      "SELECT ytw_effective_levels('{}', '{}')",
      "SELECT ytw_clean_text('x', 10)",
      "SELECT ytw_clean_email('a@b.c')",
      "SELECT ytw_check_token_grant('u', '{}', '{}')",
      "SELECT ytw_token_status(NULL, NULL)",
    ];
    for (const role of ["ytw_web", "ytw_mcp"] as const) {
      for (const statement of attempts) {
        expect(await sqlstate(db.pool(role).query(statement)), `${role}: ${statement}`).toBe(
          "42501",
        );
      }
    }
  });

  it("the advisory lock behind the first-login race and the last-admin guard is out of reach: nobody can hold it to stall logins", async () => {
    for (const role of APP_ROLES) {
      expect(
        await sqlstate(db.pool(role).query("SELECT pg_advisory_lock(1498699553, 1)")),
        role,
      ).toBe("42501");
      expect(
        await sqlstate(db.pool(role).query("SELECT pg_advisory_xact_lock(1498699553, 1)")),
        role,
      ).toBe("42501");
    }
  });
});

describe("nothing goes around the functions", () => {
  const writes = [
    "INSERT INTO users (oidc_issuer, oidc_sub, username) VALUES ('https://i', 's', 'mallory')",
    "UPDATE users SET is_admin = true",
    "DELETE FROM users",
    "UPDATE user_permissions SET level = 'write'",
    "INSERT INTO user_permissions (user_id, resource, level) VALUES (gen_random_uuid(), 'ideas', 'write')",
    "INSERT INTO ytw_private.api_tokens (user_id, name, token_prefix, token_hash) VALUES (gen_random_uuid(), 'x', 'ytw_', repeat('a', 64))",
    "UPDATE ytw_private.api_tokens SET revoked_at = NULL",
    "UPDATE ytw_private.api_token_permissions SET level = 'write'",
    "DELETE FROM ytw_private.web_sessions",
    "INSERT INTO ytw_private.web_sessions (user_id, expires_at, absolute_expires_at) VALUES (gen_random_uuid(), now(), now())",
    "TRUNCATE users CASCADE",
  ];

  it.each(APP_ROLES)("%s cannot write any of the tables directly", async (role) => {
    const outcomes: Record<string, string> = {};
    const client = await db.pool(role).connect();
    try {
      if (role === "ytw_readonly") {
        await client.query("SET default_transaction_read_only = off");
      }
      for (const statement of writes) {
        try {
          await client.query(statement);
          outcomes[statement] = "executed";
        } catch (err) {
          const code: unknown = Reflect.get(err as object, "code");
          outcomes[statement] = typeof code === "string" ? code : String(err);
        }
      }
    } finally {
      client.release(true);
    }
    expect(Object.fromEntries(writes.map((statement) => [statement, "42501"]))).toEqual(outcomes);
  });

  it("the secret tables and the access matrix are unreadable to the MCP and query_sql roles", async () => {
    const reads = [
      "SELECT * FROM ytw_private.api_tokens",
      "SELECT * FROM ytw_private.api_token_permissions",
      "SELECT * FROM ytw_private.web_sessions",
      "SELECT * FROM users",
      "SELECT * FROM user_permissions",
    ];
    for (const role of ["ytw_mcp", "ytw_readonly"] as const) {
      for (const statement of reads) {
        expect(await sqlstate(db.pool(role).query(statement)), `${role}: ${statement}`).toBe(
          "42501",
        );
      }
    }
    // The web role reads identities and the matrix (sign-in, /api/me) but never the secret tables.
    expect(await sqlstate(db.pool("ytw_web").query("SELECT * FROM ytw_private.api_tokens"))).toBe(
      "42501",
    );
    expect(await sqlstate(db.pool("ytw_web").query("SELECT * FROM ytw_private.web_sessions"))).toBe(
      "42501",
    );
    await db.pool("ytw_web").query("SELECT count(*) FROM users");
  });

  it("a caller cannot shadow the tables the functions use: no temporary tables, no objects, search_path ignored", async () => {
    const client = await db.pool("ytw_web").connect();
    try {
      expect(await sqlstate(client.query("CREATE TEMP TABLE users (id uuid)"))).toBe("42501");
      expect(await sqlstate(client.query("CREATE TABLE public.user_permissions (id int)"))).toBe(
        "42501",
      );
      expect(
        await sqlstate(
          client.query(
            "CREATE FUNCTION public.ytw_resources() RETURNS text[] LANGUAGE sql AS $$ SELECT '{}'::text[] $$",
          ),
        ),
      ).toBe("42501");
      // Even with pg_temp first, the pinned search_path of the function wins.
      await client.query("SET search_path = pg_temp, public");
      const { rows } = await client.query("SELECT * FROM get_user_access($1)", [
        "00000000-0000-4000-8000-0000000000ab",
      ]);
      expect(rows).toEqual([]);
    } finally {
      client.release(true);
    }
  });
});
