import { createIdea, saveScriptVersion, setUserPermission, withActor } from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { parseScriptFile, SCRIPT_FILE_MAX_INPUT_BYTES } from "@ytw/script-md";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestClient,
  createTestToken,
  startTestServer,
  type CreatedTestToken,
  type TestServer,
} from "../src/testing.js";

const person = (username: string) => ({ name: username, type: "human" as const });

async function jsonRes<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("MCP file export/import (T34)", () => {
  let db: TestDb;
  let server: TestServer;
  let admin: { id: string; username: string };

  let tokenWriteAll: CreatedTestToken;
  let tokenReadOnly: CreatedTestToken;
  let tokenNone: CreatedTestToken;
  let tokenLowerable: CreatedTestToken;

  let testIdeaId: string;

  beforeAll(async () => {
    db = await createTestDb();
    server = await startTestServer({ db });

    const adminToken = await createTestToken(db, {}, { isAdmin: true });
    admin = adminToken.owner;

    tokenWriteAll = await createTestToken(db, {
      ideas: "write",
      scripts: "write",
    });

    tokenReadOnly = await createTestToken(db, {
      ideas: "read",
      scripts: "read",
    });

    tokenNone = await createTestToken(db, {
      ideas: "read", // Owner needs some access to create tokens
      scripts: "none",
    });

    tokenLowerable = await createTestToken(db, {
      ideas: "write",
      scripts: "write",
    });

    // Create an initial idea and initial script revision
    await withActor(db.pool("ytw_web"), person(admin.username), async (tx) => {
      const idea = await createIdea(tx, {
        title: "File Roundtrip Video Idea",
        pitch: "Testing script markdown round trips",
      });
      testIdeaId = idea.id;

      await saveScriptVersion(tx, {
        ideaId: testIdeaId,
        kind: "script",
        baseVersion: 0,
        bodyMd: "# Initial Script\nLine 1 of content.",
      });
    });
  });

  afterAll(async () => {
    await server.close();
    await db.drop();
  });

  async function callMcpTool(
    tokenSecret: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ isError: boolean; text: string; json<T>(): T }> {
    const { client, close } = await createTestClient(server.mcpUrl, tokenSecret);
    try {
      const res = await client.callTool({ name, arguments: args });
      const content = res.content as [{ type: "text"; text: string }];
      const text = content[0]?.text ?? "";
      return {
        isError: res.isError === true,
        text,
        json: <T>() => JSON.parse(text) as T,
      };
    } finally {
      await close();
    }
  }

  describe("export_script MCP tool", () => {
    it("enforces permission matrix (None -> denied, Read -> ok)", async () => {
      // 1. None
      const resNone = await callMcpTool(tokenNone.secret, "export_script", {
        idea_id: testIdeaId,
        kind: "script",
      });
      expect(resNone.isError).toBe(true);
      expect(resNone.text).toContain("read access on scripts");

      // 2. Read
      const resRead = await callMcpTool(tokenReadOnly.secret, "export_script", {
        idea_id: testIdeaId,
        kind: "script",
      });
      expect(resRead.isError).toBe(false);
      expect(resRead.text).toContain("idea_id: " + testIdeaId);
      expect(resRead.text).toContain("kind: script");
      expect(resRead.text).toContain("version: 1");
      expect(resRead.text).toContain("# Initial Script");
    });

    it("immediately denies export_script when owner access is lowered", async () => {
      // Verify initial read
      const res1 = await callMcpTool(tokenLowerable.secret, "export_script", {
        idea_id: testIdeaId,
        kind: "script",
      });
      expect(res1.isError).toBe(false);

      // Lower owner's scripts level to none
      await withActor(db.pool("ytw_web"), person(admin.username), async (tx) => {
        await setUserPermission(tx, {
          actingUserId: admin.id,
          userId: tokenLowerable.owner.id,
          resource: "scripts",
          level: "none",
        });
      });

      // Subsequent call must be denied immediately
      const res2 = await callMcpTool(tokenLowerable.secret, "export_script", {
        idea_id: testIdeaId,
        kind: "script",
      });
      expect(res2.isError).toBe(true);
      expect(res2.text).toContain("read access on scripts");

      // Restore owner permission
      await withActor(db.pool("ytw_web"), person(admin.username), async (tx) => {
        await setUserPermission(tx, {
          actingUserId: admin.id,
          userId: tokenLowerable.owner.id,
          resource: "scripts",
          level: "write",
        });
      });
    });

    it("returns NotFoundError when exporting non-existent idea or script kind", async () => {
      const res = await callMcpTool(tokenReadOnly.secret, "export_script", {
        idea_id: testIdeaId,
        kind: "packaging", // No packaging script exists yet
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("does not exist");
    });
  });

  describe("HTTP GET /files/scripts/:idea_id/:kind", () => {
    it("returns 401 without bearer token or with invalid token", async () => {
      const res = await fetch(`${server.url}/files/scripts/${testIdeaId}/script`);
      expect(res.status).toBe(401);

      const resBad = await fetch(`${server.url}/files/scripts/${testIdeaId}/script`, {
        headers: { Authorization: "Bearer bad_token" },
      });
      expect(resBad.status).toBe(401);
    });

    it("returns 403 when token lacks Read access on scripts", async () => {
      const res = await fetch(`${server.url}/files/scripts/${testIdeaId}/script`, {
        headers: { Authorization: `Bearer ${tokenNone.secret}` },
      });
      expect(res.status).toBe(403);
      const body = await jsonRes<{ error: string }>(res);
      expect(body.error).toBe("forbidden");
    });

    it("validates path parameters and rejects path traversal attempts with 400", async () => {
      // Malformed / path traversal idea_id
      const resBadId = await fetch(`${server.url}/files/scripts/not-a-uuid/script`, {
        headers: { Authorization: `Bearer ${tokenReadOnly.secret}` },
      });
      expect(resBadId.status).toBe(400);
      const badIdBody = await jsonRes<{ message: string }>(resBadId);
      expect(badIdBody.message).toContain("not a valid UUID");

      // Invalid kind
      const resBadKind = await fetch(`${server.url}/files/scripts/${testIdeaId}/invalid_kind`, {
        headers: { Authorization: `Bearer ${tokenReadOnly.secret}` },
      });
      expect(resBadKind.status).toBe(400);

      // Malformed version query
      const resBadVer = await fetch(
        `${server.url}/files/scripts/${testIdeaId}/script?version=invalid`,
        {
          headers: { Authorization: `Bearer ${tokenReadOnly.secret}` },
        },
      );
      expect(resBadVer.status).toBe(400);
    });

    it("returns 404 when script does not exist", async () => {
      const res = await fetch(`${server.url}/files/scripts/${testIdeaId}/packaging`, {
        headers: { Authorization: `Bearer ${tokenReadOnly.secret}` },
      });
      expect(res.status).toBe(404);
    });

    it("returns 200 with text/markdown and YAML front matter on valid request", async () => {
      const res = await fetch(`${server.url}/files/scripts/${testIdeaId}/script`, {
        headers: { Authorization: `Bearer ${tokenReadOnly.secret}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");

      const text = await res.text();
      const parsed = parseScriptFile(text);
      expect(parsed.hasFrontMatter).toBe(true);
      expect(parsed.frontMatter.ideaId).toBe(testIdeaId);
      expect(parsed.frontMatter.kind).toBe("script");
      expect(parsed.frontMatter.version).toBe(1);
      expect(parsed.frontMatter.status).toBe("draft");
      expect(parsed.body).toBe("# Initial Script\nLine 1 of content.");
    });
  });

  describe("HTTP PUT /files/scripts/:idea_id/:kind", () => {
    it("returns 401 without bearer token", async () => {
      const res = await fetch(`${server.url}/files/scripts/${testIdeaId}/script`, {
        method: "PUT",
        headers: { "Content-Type": "text/markdown" },
        body: "# Some body",
      });
      expect(res.status).toBe(401);
    });

    it("returns 403 when token has only Read access on scripts", async () => {
      const res = await fetch(`${server.url}/files/scripts/${testIdeaId}/script?base_version=1`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokenReadOnly.secret}`,
          "Content-Type": "text/markdown",
        },
        body: "# Attempted edit",
      });
      expect(res.status).toBe(403);
    });

    it("returns 400 on front matter mismatch (wrong idea_id or wrong kind)", async () => {
      // Wrong idea_id in front matter
      const wrongIdeaMd = `---
idea_id: 00000000-0000-4000-8000-000000000000
kind: script
version: 1
---

# Edited content`;

      const resWrongIdea = await fetch(`${server.url}/files/scripts/${testIdeaId}/script`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokenWriteAll.secret}`,
          "Content-Type": "text/markdown",
        },
        body: wrongIdeaMd,
      });
      expect(resWrongIdea.status).toBe(400);
      const wrongIdeaBody = await jsonRes<{ error: string }>(resWrongIdea);
      expect(wrongIdeaBody.error).toBe("idea_id_mismatch");

      // Wrong kind in front matter
      const wrongKindMd = `---
idea_id: ${testIdeaId}
kind: packaging
version: 1
---

# Edited content`;

      const resWrongKind = await fetch(`${server.url}/files/scripts/${testIdeaId}/script`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokenWriteAll.secret}`,
          "Content-Type": "text/markdown",
        },
        body: wrongKindMd,
      });
      expect(resWrongKind.status).toBe(400);
      const wrongKindBody = await jsonRes<{ error: string }>(resWrongKind);
      expect(wrongKindBody.error).toBe("kind_mismatch");
    });

    it("returns 400 when base_version in query disagrees with front matter", async () => {
      const disagreeMd = `---
idea_id: ${testIdeaId}
kind: script
version: 1
---

# Content`;

      const res = await fetch(`${server.url}/files/scripts/${testIdeaId}/script?base_version=2`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokenWriteAll.secret}`,
          "Content-Type": "text/markdown",
        },
        body: disagreeMd,
      });
      expect(res.status).toBe(400);
      const body = await jsonRes<{ error: string }>(res);
      expect(body.error).toBe("base_version_mismatch");
    });

    it("returns 413 when uploaded body exceeds size limit", async () => {
      const oversized = "x".repeat(SCRIPT_FILE_MAX_INPUT_BYTES + 10);
      const promise = fetch(`${server.url}/files/scripts/${testIdeaId}/script?base_version=1`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokenWriteAll.secret}`,
          "Content-Type": "text/markdown",
        },
        body: oversized,
      }).then((res) => String(res.status));

      // Either Fastify returns 413 or closes socket immediately (ECONNRESET / fetch failed)
      const result = await promise.catch((err: Error) => err.message);
      expect(result).toMatch(/413|ECONNRESET|fetch failed/i);
    });

    it("returns 409 with latest_version when base_version is stale", async () => {
      // Stale base_version: passing base_version 0 when latest is 1
      const res = await fetch(`${server.url}/files/scripts/${testIdeaId}/script?base_version=0`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokenWriteAll.secret}`,
          "Content-Type": "text/markdown",
        },
        body: "# Concurrent attempt",
      });
      expect(res.status).toBe(409);
      const body = await jsonRes<{ error: string; latest_version: number }>(res);
      expect(body.error).toBe("version_conflict");
      expect(body.latest_version).toBe(1);
    });
  });

  describe("scripted round trip across tools and HTTP routes", () => {
    it("completes full round-trip: download -> edit -> upload -> concurrent conflict -> re-download -> merge -> upload", async () => {
      // Step 1: Download latest script revision via HTTP GET
      const getRes = await fetch(`${server.url}/files/scripts/${testIdeaId}/script`, {
        headers: { Authorization: `Bearer ${tokenWriteAll.secret}` },
      });
      expect(getRes.status).toBe(200);
      const downloadedMd = await getRes.text();

      // Step 2: Agent edits file locally, preserving front matter version (version: 1)
      const editedMd = downloadedMd.replace("Line 1 of content.", "Line 1 edited by agent.");

      // Step 3: Agent uploads edited file via HTTP PUT
      const putRes1 = await fetch(`${server.url}/files/scripts/${testIdeaId}/script`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokenWriteAll.secret}`,
          "Content-Type": "text/markdown",
        },
        body: editedMd,
      });
      expect(putRes1.status).toBe(201);
      const v2Data = await jsonRes<{ version: number; status: string }>(putRes1);
      expect(v2Data.version).toBe(2);
      expect(v2Data.status).toBe("draft");

      // Step 4: Concurrent edit: Another actor advances script to version 3
      await withActor(db.pool("ytw_web"), person(admin.username), async (tx) => {
        await saveScriptVersion(tx, {
          ideaId: testIdeaId,
          kind: "script",
          baseVersion: 2,
          bodyMd: "# Script Revision 3\nIntervening changes.",
        });
      });

      // Step 5: Agent tries to upload changes based on old version 1 -> gets 409 Conflict with latest_version: 3
      const stalePutRes = await fetch(`${server.url}/files/scripts/${testIdeaId}/script`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokenWriteAll.secret}`,
          "Content-Type": "text/markdown",
        },
        body: editedMd, // still has version: 1 in front matter!
      });
      expect(stalePutRes.status).toBe(409);
      const conflictBody = await jsonRes<{ error: string; latest_version: number }>(stalePutRes);
      expect(conflictBody.error).toBe("version_conflict");
      expect(conflictBody.latest_version).toBe(3);

      // Step 6: Agent re-downloads version 3 via MCP tool export_script
      const exportToolRes = await callMcpTool(tokenWriteAll.secret, "export_script", {
        idea_id: testIdeaId,
        kind: "script",
      });
      expect(exportToolRes.isError).toBe(false);
      const v3ExportedMd = exportToolRes.text;
      expect(v3ExportedMd).toContain("version: 3");
      expect(v3ExportedMd).toContain("Intervening changes.");

      // Step 7: Agent merges changes and uploads merged revision (version 4) via HTTP PUT
      const mergedMd = `---
idea_id: ${testIdeaId}
kind: script
version: 3
---

# Merged Script
Combined content from intervening changes and agent edits.`;

      const putRes2 = await fetch(`${server.url}/files/scripts/${testIdeaId}/script`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokenWriteAll.secret}`,
          "Content-Type": "text/markdown",
        },
        body: mergedMd,
      });
      expect(putRes2.status).toBe(201);
      const v4Data = await jsonRes<{ version: number }>(putRes2);
      expect(v4Data.version).toBe(4);

      // Step 8: Verify audit rows were logged for the tool and file operations
      const { rows: auditRows } = await db.pool("ytw_mcp").query<{
        actor: string;
        payload: { tool: string; outcome: string };
      }>(
        `SELECT actor, payload FROM events
         WHERE action = 'tool.call' AND payload->>'tool' IN ('export_script', 'save_script_version')
         ORDER BY id DESC LIMIT 10`,
      );
      expect(auditRows.length).toBeGreaterThanOrEqual(2);
      expect(auditRows.some((r) => r.payload.tool === "export_script")).toBe(true);
      expect(auditRows.some((r) => r.payload.tool === "save_script_version")).toBe(true);
    });
  });
});
