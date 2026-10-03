import { setUserAccessRevoked, withActor } from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { revokeToken, rotateToken } from "@ytw/tokens";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestClient,
  createTestToken,
  startTestServer,
  type TestServer,
} from "../../src/testing.js";

const person = (username: string) => ({ name: username, type: "human" as const });

describe("MCP Phase 2 Gate: Token Lifecycle (T35)", () => {
  let db: TestDb;
  let server: TestServer;
  let admin: { id: string; username: string };

  beforeAll(async () => {
    db = await createTestDb();
    server = await startTestServer({ db });

    const adminToken = await createTestToken(db, {}, { isAdmin: true });
    admin = adminToken.owner;
  });

  afterAll(async () => {
    await server.close();
    await db.drop();
  });

  async function callWhoami(tokenSecret: string) {
    const { client, close } = await createTestClient(server.mcpUrl, tokenSecret);
    try {
      const res = await client.callTool({ name: "whoami", arguments: {} });
      return { isError: res.isError === true, res };
    } finally {
      await close();
    }
  }

  async function rawMcpPost(tokenSecret: string) {
    const response = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "whoami", arguments: {} },
      }),
    });
    const status = response.status;
    const body = (await response.json()) as { error?: string; message?: string };
    return { status, body };
  }

  describe("immediate token revocation", () => {
    it("calling with revoked token fails with 401 on the very next call", async () => {
      const { secret, token, owner } = await createTestToken(db, { ideas: "read" });

      // 1. Initial call succeeds
      const initial = await callWhoami(secret);
      expect(initial.isError).toBe(false);

      // 2. Revoke token
      await revokeToken(db.pool("ytw_web"), owner, token.id);

      // 3. Very next call fails immediately with 401
      const revokedRes = await rawMcpPost(secret);
      expect(revokedRes.status).toBe(401);
      expect(revokedRes.body).toEqual({ error: "unauthorized", message: "Unauthorized" });

      // Also via MCP client
      await expect(callWhoami(secret)).rejects.toThrow(/401|unauthorized|failed/i);
    });

    it("calling with token whose owner user access was revoked fails immediately with 401", async () => {
      const { secret, owner } = await createTestToken(db, { ideas: "read" });

      // 1. Initial call succeeds
      const initial = await callWhoami(secret);
      expect(initial.isError).toBe(false);

      // 2. Revoke owner access in DB
      await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
        setUserAccessRevoked(tx, {
          actingUserId: admin.id,
          userId: owner.id,
          revoked: true,
        }),
      );

      // 3. Very next call fails immediately with 401
      const res = await rawMcpPost(secret);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "unauthorized", message: "Unauthorized" });
    });
  });

  describe("immediate token expiration", () => {
    it("calling with expired token fails with 401 on the very next call", async () => {
      const { secret, token } = await createTestToken(db, { ideas: "read" });

      // 1. Initial call succeeds
      const initial = await callWhoami(secret);
      expect(initial.isError).toBe(false);

      // 2. Expire token in DB immediately via admin connection with actor
      const client = await db.admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT public.ytw_set_actor('admin', 'human', NULL)");
        await client.query(
          "UPDATE ytw_private.api_tokens SET expires_at = now() - INTERVAL '10 seconds' WHERE id = $1",
          [token.id],
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      // 3. Very next call fails immediately with 401
      const res = await rawMcpPost(secret);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "unauthorized", message: "Unauthorized" });
    });
  });

  describe("token secret rotation", () => {
    it("old secret fails immediately with 401 while new secret succeeds immediately", async () => {
      const { secret: oldSecret, token, owner } = await createTestToken(db, { ideas: "read" });

      // 1. Initial call with old secret succeeds
      const initial = await callWhoami(oldSecret);
      expect(initial.isError).toBe(false);

      // 2. Rotate token
      const rotation = await rotateToken(db.pool("ytw_web"), owner, token.id);
      const newSecret = rotation.secret;
      expect(newSecret).not.toBe(oldSecret);

      // 3. Old secret fails immediately with 401
      const oldRes = await rawMcpPost(oldSecret);
      expect(oldRes.status).toBe(401);
      expect(oldRes.body).toEqual({ error: "unauthorized", message: "Unauthorized" });

      // 4. New secret succeeds immediately
      const newRes = await callWhoami(newSecret);
      expect(newRes.isError).toBe(false);
    });
  });

  describe("last_used_at tracking and throttling", () => {
    it("updates last_used_at on call and throttles updates within 1 minute", async () => {
      const { secret, token } = await createTestToken(db, { ideas: "read" });

      // 1. Initially last_used_at is NULL
      const { rows: initialRows } = await db.admin.query<{ last_used_at: Date | null }>(
        "SELECT last_used_at FROM ytw_private.api_tokens WHERE id = $1",
        [token.id],
      );
      expect(initialRows[0]?.last_used_at).toBeNull();

      // 2. First call updates last_used_at
      const res1 = await callWhoami(secret);
      expect(res1.isError).toBe(false);

      const { rows: firstCallRows } = await db.admin.query<{ last_used_at: Date | null }>(
        "SELECT last_used_at FROM ytw_private.api_tokens WHERE id = $1",
        [token.id],
      );
      const t1 = firstCallRows[0]?.last_used_at;
      expect(t1).not.toBeNull();
      expect(t1).toBeInstanceOf(Date);

      // 3. Second call immediately afterwards (< 60s)
      const res2 = await callWhoami(secret);
      expect(res2.isError).toBe(false);

      const { rows: secondCallRows } = await db.admin.query<{ last_used_at: Date | null }>(
        "SELECT last_used_at FROM ytw_private.api_tokens WHERE id = $1",
        [token.id],
      );
      const t2 = secondCallRows[0]?.last_used_at;

      // Because of <= 1/min throttling, last_used_at remains identical to t1
      expect(t2?.getTime()).toBe(t1?.getTime());
    });
  });
});
