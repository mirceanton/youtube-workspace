import { revokeApiToken, setUserAccessRevoked, withActor } from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { FailureLimiter, generateToken } from "@ytw/tokens";
import { ValidationError } from "@ytw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createTestClient,
  createTestToken,
  startTestServer,
  type TestServer,
} from "../src/testing.js";
import { defineTool } from "../src/tools.js";

const person = (username: string) => ({ name: username, type: "human" as const });

describe("MCP foundation (T30)", () => {
  let db: TestDb;
  let server: TestServer;
  let admin: { id: string; username: string };

  // Custom tool for testing permissions and error mapping
  const testWriteTool = defineTool({
    name: "test_write_tool",
    description: "Requires write on ideas",
    input: z.object({
      failWith: z.enum(["none", "validation", "throw"]).default("none"),
    }),
    requires: { resource: "ideas", level: "write" },
    async handler(args) {
      if (args.failWith === "validation") {
        throw new ValidationError(
          "Title cannot be empty",
          { field: "title" },
          "provide a title between 1 and 500 characters",
        );
      }
      if (args.failWith === "throw") {
        throw new Error("Something broke inside handler");
      }
      return { success: true, received: args };
    },
  });

  beforeAll(async () => {
    db = await createTestDb();
    server = await startTestServer({
      db,
      tools: [testWriteTool],
      // Generous limit for general test server so tests never block each other
      limiter: new FailureLimiter({ maxFailures: 100, windowMs: 60_000 }),
    });

    const adminToken = await createTestToken(db, {}, { isAdmin: true });
    admin = adminToken.owner;
  });

  afterAll(async () => {
    await server.close();
    await db.drop();
  });

  describe("stateless bearer authentication and no-leak responses", () => {
    it("rejects missing, malformed, unknown, revoked, and expired tokens with identical 401s", async () => {
      // 1. Missing header
      const missingRes = await fetch(server.mcpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(missingRes.status).toBe(401);
      const missingBody = await missingRes.json();
      expect(missingBody).toEqual({ error: "unauthorized", message: "Unauthorized" });

      // 2. Malformed header
      const malformedRes = await fetch(server.mcpUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer not_a_real_token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(malformedRes.status).toBe(401);
      expect(await malformedRes.json()).toEqual(missingBody);

      // 3. Unknown token
      const unknownToken = generateToken().secret;
      const unknownRes = await fetch(server.mcpUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${unknownToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(unknownRes.status).toBe(401);
      expect(await unknownRes.json()).toEqual(missingBody);

      // 4. Revoked token
      const testToken = await createTestToken(db, { ideas: "read" });
      await withActor(db.pool("ytw_web"), person(testToken.owner.username), (tx) =>
        revokeApiToken(tx, {
          actingUserId: testToken.owner.id,
          apiTokenId: testToken.token.id,
        }),
      );

      const revokedRes = await fetch(server.mcpUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testToken.secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(revokedRes.status).toBe(401);
      expect(await revokedRes.json()).toEqual(missingBody);

      // 5. Expired token
      const expiredToken = await createTestToken(db, { ideas: "read" });
      const client = await db.admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT ytw_set_actor('test', 'human', NULL)");
        await client.query(
          "UPDATE ytw_private.api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1",
          [expiredToken.token.id],
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      const expiredRes = await fetch(server.mcpUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${expiredToken.secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(expiredRes.status).toBe(401);
      expect(await expiredRes.json()).toEqual(missingBody);

      // 6. Owner removed / access revoked
      const ownerRevokedToken = await createTestToken(db, { ideas: "read" });
      await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
        setUserAccessRevoked(tx, {
          actingUserId: admin.id,
          userId: ownerRevokedToken.owner.id,
          revoked: true,
        }),
      );

      const ownerRevokedRes = await fetch(server.mcpUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerRevokedToken.secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(ownerRevokedRes.status).toBe(401);
      expect(await ownerRevokedRes.json()).toEqual(missingBody);
    });

    it("rate limits repeated authentication failures with 429 and Retry-After", async () => {
      // Use a dedicated server with a tight failure limit
      const rateLimitServer = await startTestServer({
        db,
        limiter: new FailureLimiter({ maxFailures: 3, windowMs: 60_000 }),
      });

      try {
        const clientIp = "192.168.1.100";
        for (let i = 0; i < 3; i++) {
          const res = await fetch(rateLimitServer.mcpUrl, {
            method: "POST",
            headers: {
              "X-Forwarded-For": clientIp,
              Authorization: `Bearer ${generateToken().secret}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          });
          expect(res.status).toBe(401);
        }

        // 4th request from same client should trigger 429
        const blockedRes = await fetch(rateLimitServer.mcpUrl, {
          method: "POST",
          headers: {
            "X-Forwarded-For": clientIp,
            Authorization: `Bearer ${generateToken().secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        expect(blockedRes.status).toBe(429);
        expect(blockedRes.headers.get("retry-after")).toBeDefined();
        expect(Number(blockedRes.headers.get("retry-after"))).toBeGreaterThan(0);
        const json = (await blockedRes.json()) as { error: string };
        expect(json.error).toBe("rate_limited");
      } finally {
        await rateLimitServer.close();
      }
    });
  });

  describe("tool execution, permissions, and audit logging", () => {
    it("executes whoami tool with the official SDK client", async () => {
      const { secret, token, owner } = await createTestToken(db, {
        ideas: "write",
        scripts: "read",
      });
      const { client, close } = await createTestClient(server.mcpUrl, secret);

      try {
        const tools = await client.listTools();
        const whoami = tools.tools.find((t) => t.name === "whoami");
        expect(whoami).toBeDefined();

        const result = await client.callTool({ name: "whoami", arguments: {} });
        expect(result.isError).toBeFalsy();
        const content = result.content as [{ type: "text"; text: string }];
        const parsed = JSON.parse(content[0].text);
        expect(parsed.token).toBe(token.name);
        expect(parsed.owner).toBe(owner.username);
        expect(parsed.effectiveLevels.ideas).toBe("write");
        expect(parsed.effectiveLevels.scripts).toBe("read");
        expect(parsed.effectiveLevels.videos).toBe("none");

        // Verify whoami wrote an event to the events table
        const { rows } = await db.admin.query<{
          actor: string;
          actor_type: string;
          token_id: string;
          action: string;
          payload: { tool: string; outcome: string; token_owner: string };
        }>(
          `SELECT actor, actor_type, token_id, action, payload
             FROM events
            WHERE action = 'tool.call' AND payload->>'tool' = 'whoami' AND token_id = $1
            ORDER BY created_at DESC LIMIT 1`,
          [token.id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.actor).toBe(token.name);
        expect(rows[0]?.actor_type).toBe("agent");
        expect(rows[0]?.payload.outcome).toBe("ok");
        expect(rows[0]?.payload.token_owner).toBe(owner.username);
      } finally {
        await close();
      }
    });

    it("denies call when token lacks required permission and audits denial", async () => {
      // Token only has 'read' on ideas, but test_write_tool requires 'write'
      const { secret, token, owner } = await createTestToken(db, { ideas: "read" });
      const { client, close } = await createTestClient(server.mcpUrl, secret);

      try {
        const result = await client.callTool({
          name: "test_write_tool",
          arguments: { failWith: "none" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as [{ type: "text"; text: string }])[0].text;
        expect(text).toContain("Permission denied");
        expect(text).toContain("ideas");
        expect(text).toContain("write");

        // Verify denial event was audited
        const { rows } = await db.admin.query<{
          actor: string;
          token_id: string;
          payload: { tool: string; outcome: string; token_owner: string };
        }>(
          `SELECT actor, token_id, payload
             FROM events
            WHERE action = 'tool.call' AND payload->>'tool' = 'test_write_tool' AND token_id = $1
            ORDER BY created_at DESC LIMIT 1`,
          [token.id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.actor).toBe(token.name);
        expect(rows[0]?.payload.outcome).toBe("denied");
        expect(rows[0]?.payload.token_owner).toBe(owner.username);
      } finally {
        await close();
      }
    });

    it("audits handler errors and maps to readable error message", async () => {
      const { secret, token } = await createTestToken(db, { ideas: "write" });
      const { client, close } = await createTestClient(server.mcpUrl, secret);

      try {
        const result = await client.callTool({
          name: "test_write_tool",
          arguments: { failWith: "validation" },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as [{ type: "text"; text: string }])[0].text;
        expect(text).toContain("Title cannot be empty");
        expect(text).toContain("Hint: provide a title between 1 and 500 characters");

        // Verify error event was audited
        const { rows } = await db.admin.query<{
          actor: string;
          token_id: string;
          payload: { tool: string; outcome: string };
        }>(
          `SELECT actor, token_id, payload
             FROM events
            WHERE action = 'tool.call' AND payload->>'tool' = 'test_write_tool' AND token_id = $1
            ORDER BY created_at DESC LIMIT 1`,
          [token.id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.payload.outcome).toBe("error");
      } finally {
        await close();
      }
    });
  });

  describe("observability and HTTP metrics", () => {
    it("increments mcp_tool_calls_total metric", async () => {
      const { secret } = await createTestToken(db, { ideas: "read" });
      const { client, close } = await createTestClient(server.mcpUrl, secret);

      try {
        await client.callTool({ name: "whoami", arguments: {} });

        const metricsRes = await fetch(`${server.url}/metrics`);
        expect(metricsRes.status).toBe(200);
        const text = await metricsRes.text();
        expect(text).toContain("mcp_tool_calls_total");
        expect(text).toContain('tool="whoami"');
      } finally {
        await close();
      }
    });

    it("enforces 1 MB body limit", async () => {
      const { secret } = await createTestToken(db, { ideas: "read" });
      const hugeString = "x".repeat(1_100_000);

      const res = await server.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        payload: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "whoami", arguments: { data: hugeString } },
        }),
      });

      expect(res.statusCode).toBe(413);
    });

    it("rejects GET and DELETE on /mcp with 405", async () => {
      const getRes = await fetch(server.mcpUrl, { method: "GET" });
      expect(getRes.status).toBe(405);

      const deleteRes = await fetch(server.mcpUrl, { method: "DELETE" });
      expect(deleteRes.status).toBe(405);
    });
  });
});
