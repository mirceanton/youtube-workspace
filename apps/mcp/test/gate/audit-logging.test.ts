import { createIdea, withActor } from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestClient,
  createTestToken,
  startTestServer,
  type TestServer,
} from "../../src/testing.js";

const person = (username: string) => ({ name: username, type: "human" as const });

describe("MCP Phase 2 Gate: Audit Logging (T35)", () => {
  let db: TestDb;
  let server: TestServer;
  let admin: { id: string; username: string };
  let seededIdeaId: string;

  beforeAll(async () => {
    db = await createTestDb();
    server = await startTestServer({ db });

    const adminToken = await createTestToken(db, {}, { isAdmin: true });
    admin = adminToken.owner;

    const idea = await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
      createIdea(tx, {
        title: "Audit Test Seed Idea",
        pitch: "Pitch for audit testing",
      }),
    );
    seededIdeaId = idea.id;
  });

  afterAll(async () => {
    await server.close();
    await db.drop();
  });

  async function callTool(tokenSecret: string, toolName: string, args: Record<string, unknown>) {
    const { client, close } = await createTestClient(server.mcpUrl, tokenSecret);
    try {
      const res = await client.callTool({ name: toolName, arguments: args });
      const content = (res.content as [{ type: "text"; text: string }] | undefined) ?? [];
      return {
        isError: res.isError === true,
        text: content[0]?.text ?? "",
      };
    } finally {
      await close();
    }
  }

  interface EventRow {
    id: string;
    actor: string;
    actor_type: string;
    token_id: string;
    action: string;
    payload: {
      tool: string;
      outcome: string;
      token_owner: string;
      error?: string;
    };
  }

  async function getLatestEvent(tokenId: string, toolName: string): Promise<EventRow> {
    const { rows } = await db.admin.query<EventRow>(
      `SELECT id, actor, actor_type, token_id, action, payload
         FROM events
        WHERE token_id = $1 AND payload->>'tool' = $2
        ORDER BY created_at DESC LIMIT 1`,
      [tokenId, toolName],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    return rows[0]!;
  }

  describe("successful tool calls write audit records", () => {
    it("audits successful write tool (create_idea) with token name, id, and owner", async () => {
      const { secret, token, owner } = await createTestToken(db, { ideas: "write" });
      const res = await callTool(secret, "create_idea", { title: "Audited Idea" });
      expect(res.isError).toBe(false);

      const event = await getLatestEvent(token.id, "create_idea");
      expect(event.actor).toBe(token.name);
      expect(event.actor_type).toBe("agent");
      expect(event.token_id).toBe(token.id);
      expect(event.action).toBe("tool.call");
      expect(event.payload.tool).toBe("create_idea");
      expect(event.payload.outcome).toBe("ok");
      expect(event.payload.token_owner).toBe(owner.username);
    });

    it("audits successful read tool (list_ideas)", async () => {
      const { secret, token, owner } = await createTestToken(db, { ideas: "read" });
      const res = await callTool(secret, "list_ideas", {});
      expect(res.isError).toBe(false);

      const event = await getLatestEvent(token.id, "list_ideas");
      expect(event.actor).toBe(token.name);
      expect(event.actor_type).toBe("agent");
      expect(event.token_id).toBe(token.id);
      expect(event.payload.outcome).toBe("ok");
      expect(event.payload.token_owner).toBe(owner.username);
    });

    it("audits successful system tool (whoami)", async () => {
      const { secret, token, owner } = await createTestToken(db, { ideas: "read" });
      const res = await callTool(secret, "whoami", {});
      expect(res.isError).toBe(false);

      const event = await getLatestEvent(token.id, "whoami");
      expect(event.actor).toBe(token.name);
      expect(event.token_id).toBe(token.id);
      expect(event.payload.outcome).toBe("ok");
      expect(event.payload.token_owner).toBe(owner.username);
    });

    it("audits successful SQL tool (query_sql)", async () => {
      const { secret, token, owner } = await createTestToken(db, {
        ideas: "read",
        scripts: "read",
        videos: "read",
        experiments: "read",
        notes: "read",
        activity: "read",
      });
      const res = await callTool(secret, "query_sql", { sql: "SELECT 1 AS num" });
      expect(res.isError).toBe(false);

      const event = await getLatestEvent(token.id, "query_sql");
      expect(event.actor).toBe(token.name);
      expect(event.token_id).toBe(token.id);
      expect(event.payload.outcome).toBe("ok");
      expect(event.payload.token_owner).toBe(owner.username);
    });
  });

  describe("denied tool calls write audit records", () => {
    it("preserves actor (token name, id, owner) and records denial outcome when permission is denied", async () => {
      const { secret, token, owner } = await createTestToken(db, { ideas: "read" });
      // create_idea requires 'write', but token only has 'read'
      const res = await callTool(secret, "create_idea", { title: "Denied Idea" });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("Permission denied");

      const event = await getLatestEvent(token.id, "create_idea");
      expect(event.actor).toBe(token.name);
      expect(event.actor_type).toBe("agent");
      expect(event.token_id).toBe(token.id);
      expect(event.payload.tool).toBe("create_idea");
      expect(event.payload.outcome).toBe("denied");
      expect(event.payload.token_owner).toBe(owner.username);
      expect(["tool.call", "mcp_tool_denied"]).toContain(event.action);
    });
  });

  describe("tool failures write audit records with error details", () => {
    it("audits tool failure with error details (validation error)", async () => {
      const { secret, token, owner } = await createTestToken(db, { ideas: "write" });

      // First advance idea to shortlisted
      const advRes = await callTool(secret, "advance_idea", {
        id: seededIdeaId,
        new_status: "shortlisted",
      });
      expect(advRes.isError).toBe(false);

      // Now attempt backward transition to inbox without a note -> database validation error
      const res = await callTool(secret, "advance_idea", {
        id: seededIdeaId,
        new_status: "inbox",
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("requires a note");

      const event = await getLatestEvent(token.id, "advance_idea");
      expect(event.actor).toBe(token.name);
      expect(event.token_id).toBe(token.id);
      expect(event.payload.outcome).toBe("error");
      expect(event.payload.token_owner).toBe(owner.username);
      expect(event.payload.error).toBe("validation");
    });

    it("audits tool failure with error details (version conflict)", async () => {
      const { secret, token } = await createTestToken(db, { ideas: "write" });
      // Call update_idea with wrong expected_version
      const res = await callTool(secret, "update_idea", {
        id: seededIdeaId,
        expected_version: 9999,
        fields: { title: "Conflict Update" },
      });
      expect(res.isError).toBe(true);

      const event = await getLatestEvent(token.id, "update_idea");
      expect(event.actor).toBe(token.name);
      expect(event.token_id).toBe(token.id);
      expect(event.payload.outcome).toBe("error");
      expect(event.payload.error).toBe("version_conflict");
    });
  });

  describe("audit log append-only immutability", () => {
    it("rejects UPDATE on events table with immutable error", async () => {
      const { rows } = await db.admin.query<{ id: string }>("SELECT id FROM events LIMIT 1");
      const eventId = rows[0]?.id;
      expect(eventId).toBeDefined();

      const client = await db.admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT public.ytw_set_actor('admin', 'human', NULL)");
        await expect(
          client.query("UPDATE public.events SET actor = 'tampered' WHERE id = $1", [eventId]),
        ).rejects.toThrow(/append-only/i);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    it("rejects DELETE on events table with immutable error", async () => {
      const { rows } = await db.admin.query<{ id: string }>("SELECT id FROM events LIMIT 1");
      const eventId = rows[0]?.id;
      expect(eventId).toBeDefined();

      const client = await db.admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT public.ytw_set_actor('admin', 'human', NULL)");
        await expect(
          client.query("DELETE FROM public.events WHERE id = $1", [eventId]),
        ).rejects.toThrow(/append-only/i);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });
  });
});
