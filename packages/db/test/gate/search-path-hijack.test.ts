// Gate: Search path hijack adversarial hardening (PRD 5, PRD 9).
//
// 1. Sets up an attacker schema `evil` with malicious shadow functions (evil.lower, evil.now,
//    evil.btrim, evil.uuid_generate_v7) and shadow tables (evil.events, evil.ideas).
// 2. Executes `SET search_path = evil, pg_catalog;` in the application role's session.
// 3. Invokes SECURITY DEFINER functions and verifies they do NOT call shadow functions or write
//    to shadow tables.
// 4. Catalog audit: asserts every SECURITY DEFINER function in pg_proc pins its search_path.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor, type Actor } from "../../src/client.js";
import { advanceIdea, createIdea, updateIdea } from "../../src/ideas.js";
import { upsertUserOnLogin } from "../../src/identity.js";
import { addNote } from "../../src/notes.js";
import { saveScriptVersion } from "../../src/scripts.js";
import { createTestDb, type TestDb } from "../../src/testing.js";
import { registerVideo } from "../../src/videos.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();

  // Create attacker schema `evil` with spy/shadow functions and tables
  await db.admin.query(`
    CREATE SCHEMA evil;

    CREATE TABLE evil.hijack_calls (
      fn text NOT NULL,
      called_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE evil.events (
      id uuid,
      actor text,
      action text
    );

    CREATE TABLE evil.ideas (
      id uuid,
      title text
    );

    CREATE FUNCTION evil.lower(text) RETURNS text
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO evil.hijack_calls (fn) VALUES ('lower');
      RETURN 'hijacked_lower';
    END $$;

    CREATE FUNCTION evil.now() RETURNS timestamptz
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO evil.hijack_calls (fn) VALUES ('now');
      RETURN '1970-01-01 00:00:00+00'::timestamptz;
    END $$;

    CREATE FUNCTION evil.btrim(text) RETURNS text
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO evil.hijack_calls (fn) VALUES ('btrim');
      RETURN 'hijacked_btrim';
    END $$;

    CREATE FUNCTION evil.uuid_generate_v7() RETURNS uuid
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO evil.hijack_calls (fn) VALUES ('uuid_generate_v7');
      RETURN '00000000-0000-0000-0000-000000000000'::uuid;
    END $$;

    GRANT USAGE ON SCHEMA evil TO ytw_web, ytw_mcp;
    GRANT ALL ON ALL TABLES IN SCHEMA evil TO ytw_web, ytw_mcp;
    GRANT ALL ON ALL FUNCTIONS IN SCHEMA evil TO ytw_web, ytw_mcp;
  `);
});

afterAll(async () => {
  await db.drop();
});

describe("gate: search-path hijack hardening", () => {
  const alice: Actor = { name: "alice", type: "human" };

  it("SECURITY DEFINER functions resist search_path hijacking from caller session", async () => {
    const client = await db.pool("ytw_web").connect();
    try {
      // Attacker manipulates session search_path to prioritize evil schema
      await client.query("SET search_path = evil, pg_catalog");

      // Verify the session search_path is indeed set to evil
      const { rows: pathRows } = await client.query<{ path: string }>(
        "SELECT current_setting('search_path') as path",
      );
      expect(pathRows[0]?.path).toBe("evil, pg_catalog");

      // Execute SECURITY DEFINER mutating functions
      await withActor(db.pool("ytw_web"), alice, async (tx) => {
        // 1. create_idea
        const idea = await createIdea(tx, {
          title: "Search Path Resilience Idea",
          pitch: "Testing search_path pinning",
          source: "Security Test",
          tags: ["security"],
        });
        expect(idea.id).not.toBe("00000000-0000-0000-0000-000000000000");
        expect(idea.createdAt.getFullYear()).toBeGreaterThan(2020);

        // 2. update_idea
        await updateIdea(tx, {
          id: idea.id,
          expectedVersion: idea.version,
          fields: { pitch: "Updated pitch under hostile search_path" },
        });

        // 3. advance_idea
        await advanceIdea(tx, {
          id: idea.id,
          newStatus: "shortlisted",
          note: "Advancing under hostile search_path",
        });

        // 4. save_script_version
        await saveScriptVersion(tx, {
          ideaId: idea.id,
          kind: "script",
          baseVersion: 0,
          bodyMd: "# Script created under hostile search_path",
        });

        // 5. add_note
        await addNote(tx, {
          entityType: "idea",
          entityId: idea.id,
          bodyMd: "Note under hostile search_path",
        });

        // 6. register_video
        const youtubeId = randomBytes(9).toString("base64url").slice(0, 11);
        await registerVideo(tx, {
          youtubeId,
          title: "Video under hostile search_path",
        });
      });

      // Also test user login
      const username = `u_${randomUUID().slice(0, 8)}`;
      await withActor(db.pool("ytw_web"), { name: username, type: "human" }, async (tx) => {
        await upsertUserOnLogin(tx, {
          issuer: "https://id.example.test",
          sub: `sub_${randomUUID()}`,
          username,
        });
      });

      // Verify that NO malicious shadow function was invoked
      const { rows: callRows } = await db.admin.query<{ fn: string }>(
        "SELECT * FROM evil.hijack_calls",
      );
      expect(callRows).toEqual([]);

      // Verify that NO shadow tables were written to
      const { rows: evilEvents } = await db.admin.query<{ count: string }>(
        "SELECT count(*)::text as count FROM evil.events",
      );
      expect(evilEvents[0]?.count).toBe("0");

      const { rows: evilIdeas } = await db.admin.query<{ count: string }>(
        "SELECT count(*)::text as count FROM evil.ideas",
      );
      expect(evilIdeas[0]?.count).toBe("0");

      // Verify real tables were populated
      const { rows: realIdeas } = await db.admin.query<{ count: string }>(
        "SELECT count(*)::text as count FROM public.ideas WHERE title = 'Search Path Resilience Idea'",
      );
      expect(Number(realIdeas[0]?.count)).toBe(1);

      const { rows: realEvents } = await db.admin.query<{ count: string }>(
        "SELECT count(*)::text as count FROM public.events",
      );
      expect(Number(realEvents[0]?.count)).toBeGreaterThan(0);
    } finally {
      client.release();
    }
  });

  describe("catalog audit: all SECURITY DEFINER functions pin search_path", () => {
    it("asserts 100% of SECURITY DEFINER functions have proconfig with pinned search_path", async () => {
      const { rows } = await db.admin.query<{ proname: string; proconfig: string[] | null }>(`
        SELECT p.proname, p.proconfig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'ytw_private')
          AND p.prosecdef = true
        ORDER BY p.proname
      `);

      expect(rows.length).toBeGreaterThan(20);

      const unpinned = rows.filter((r) => {
        if (!r.proconfig) return true;
        return !r.proconfig.some(
          (setting) => setting === "search_path=pg_catalog, public, pg_temp",
        );
      });

      expect(unpinned).toEqual([]);
    });

    it("asserts no SECURITY DEFINER function allows search_path inheritance", async () => {
      // A SECURITY DEFINER without SET search_path would inherit the caller's search_path
      const { rows } = await db.admin.query<{ count: string }>(`
        SELECT count(*)::text as count
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'ytw_private')
          AND p.prosecdef = true
          AND (p.proconfig IS NULL OR NOT (p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']))
      `);
      expect(rows[0]?.count).toBe("0");
    });
  });
});
