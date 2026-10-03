import { setUserPermission, withActor } from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { SCRIPT_BODY_MAX_BYTES } from "@ytw/shared/constants";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestClient,
  createTestToken,
  startTestServer,
  type CreatedTestToken,
  type TestServer,
} from "../src/testing.js";

const person = (username: string) => ({ name: username, type: "human" as const });

interface ToolResponse {
  isError: boolean;
  text: string;
  json<T = Record<string, unknown>>(): T;
}

describe("MCP write tools: ideas, scripts, notes (T31)", () => {
  let db: TestDb;
  let server: TestServer;
  let admin: { id: string; username: string };

  let tokenWriteAll: CreatedTestToken;
  let tokenReadOnly: CreatedTestToken;
  let tokenNone: CreatedTestToken;
  let tokenLowerable: CreatedTestToken;

  beforeAll(async () => {
    db = await createTestDb();
    server = await startTestServer({ db });

    const adminToken = await createTestToken(db, {}, { isAdmin: true });
    admin = adminToken.owner;

    tokenWriteAll = await createTestToken(db, {
      ideas: "write",
      scripts: "write",
      notes: "write",
    });

    tokenReadOnly = await createTestToken(db, {
      ideas: "read",
      scripts: "read",
      notes: "read",
    });

    tokenNone = await createTestToken(db, {
      videos: "read",
      ideas: "none",
      scripts: "none",
      notes: "none",
    });

    tokenLowerable = await createTestToken(db, {
      ideas: "write",
      scripts: "write",
      notes: "write",
    });
  });

  afterAll(async () => {
    await server.close();
    await db.drop();
  });

  async function callTool(
    tokenSecret: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResponse> {
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

  async function getAuditEvents(toolName: string): Promise<
    {
      actor: string;
      token_id: string;
      payload: {
        tool: string;
        outcome: string;
        token_owner?: string;
        error?: string;
      };
    }[]
  > {
    const { rows } = await db.pool("ytw_mcp").query<{
      actor: string;
      token_id: string;
      payload: {
        tool: string;
        outcome: string;
        token_owner?: string;
        error?: string;
      };
    }>(
      `SELECT actor, token_id, payload FROM events
       WHERE action = 'tool.call' AND payload->>'tool' = $1
       ORDER BY id DESC`,
      [toolName],
    );
    return rows;
  }

  describe("ideas write tools", () => {
    let createdIdeaId: string;
    let ideaVersion: number;

    it("enforces permission matrix on create_idea (None -> denied, Read -> denied, Write -> ok)", async () => {
      // 1. None
      const resNone = await callTool(tokenNone.secret, "create_idea", {
        title: "Idea from none",
      });
      expect(resNone.isError).toBe(true);
      expect(resNone.text).toContain("write access on ideas");

      // 2. Read
      const resRead = await callTool(tokenReadOnly.secret, "create_idea", {
        title: "Idea from read",
      });
      expect(resRead.isError).toBe(true);
      expect(resRead.text).toContain("write access on ideas");

      // 3. Write
      const resWrite = await callTool(tokenWriteAll.secret, "create_idea", {
        title: "Building an Autonomous Agent",
        pitch: "Deep dive into multi-agent systems and MCP.",
        source: "YouTube comments",
        tags: ["agent", "ai", "mcp"],
        score: 85,
      });
      expect(resWrite.isError).toBe(false);
      const idea = resWrite.json<{
        id: string;
        title: string;
        status: string;
        version: number;
        score: number;
        tags: string[];
      }>();
      expect(idea.title).toBe("Building an Autonomous Agent");
      expect(idea.status).toBe("inbox");
      expect(idea.version).toBe(1);
      expect(idea.score).toBe(85);
      expect(idea.tags).toEqual(["agent", "ai", "mcp"]);

      createdIdeaId = idea.id;
      ideaVersion = idea.version;

      // Verify audit rows
      const audits = await getAuditEvents("create_idea");
      expect(audits.length).toBeGreaterThanOrEqual(3);
      expect(audits[0]?.payload.outcome).toBe("ok");
      expect(audits[0]?.actor).toBe(tokenWriteAll.token.name);
    });

    it("denies create_idea immediately when owner access is lowered", async () => {
      // Initially write is allowed
      const res1 = await callTool(tokenLowerable.secret, "create_idea", {
        title: "Before owner lowering",
      });
      expect(res1.isError).toBe(false);

      // Lower owner's ideas level to 'read'
      await withActor(db.pool("ytw_web"), person(admin.username), async (tx) => {
        await setUserPermission(tx, {
          actingUserId: admin.id,
          userId: tokenLowerable.owner.id,
          resource: "ideas",
          level: "read",
        });
      });

      // Subsequent call must be denied immediately!
      const res2 = await callTool(tokenLowerable.secret, "create_idea", {
        title: "After owner lowering",
      });
      expect(res2.isError).toBe(true);
      expect(res2.text).toContain("write access on ideas");

      // Restore owner permission for remaining tests
      await withActor(db.pool("ytw_web"), person(admin.username), async (tx) => {
        await setUserPermission(tx, {
          actingUserId: admin.id,
          userId: tokenLowerable.owner.id,
          resource: "ideas",
          level: "write",
        });
      });
    });

    it("updates idea and handles optimistic concurrency conflict", async () => {
      expect(createdIdeaId).toBeDefined();

      // Successful update
      const updateRes = await callTool(tokenWriteAll.secret, "update_idea", {
        id: createdIdeaId,
        expected_version: ideaVersion,
        fields: {
          title: "Building an Autonomous Agent (Updated)",
          pitch: "Updated pitch text",
          score: 90,
        },
      });
      expect(updateRes.isError).toBe(false);
      const updatedIdea = updateRes.json<{ title: string; version: number }>();
      expect(updatedIdea.title).toBe("Building an Autonomous Agent (Updated)");
      expect(updatedIdea.version).toBe(2);
      ideaVersion = 2;

      // Stale expected_version (passing version 1 when version is 2)
      const conflictRes = await callTool(tokenWriteAll.secret, "update_idea", {
        id: createdIdeaId,
        expected_version: 1,
        fields: {
          title: "Conflicting Update",
        },
      });
      expect(conflictRes.isError).toBe(true);
      expect(conflictRes.text).toContain("has changed since you read it");
      expect(conflictRes.text).toContain("latest version is 2");

      // Verify audit recorded as error
      const audits = await getAuditEvents("update_idea");
      const conflictAudit = audits.find((a) => a.payload.outcome === "error");
      expect(conflictAudit).toBeDefined();
    });

    it("advances idea with stage transition validation", async () => {
      expect(createdIdeaId).toBeDefined();

      // Forward transition: inbox -> shortlisted (no note needed)
      const forwardRes = await callTool(tokenWriteAll.secret, "advance_idea", {
        id: createdIdeaId,
        new_status: "shortlisted",
        expected_version: ideaVersion,
      });
      expect(forwardRes.isError).toBe(false);
      const forwardData = forwardRes.json<{
        idea: { status: string; version: number };
      }>();
      expect(forwardData.idea.status).toBe("shortlisted");
      expect(forwardData.idea.version).toBe(3);
      ideaVersion = 3;

      // Backward transition without note: shortlisted -> inbox (must fail)
      const backwardNoNoteRes = await callTool(tokenWriteAll.secret, "advance_idea", {
        id: createdIdeaId,
        new_status: "inbox",
        expected_version: ideaVersion,
      });
      expect(backwardNoNoteRes.isError).toBe(true);
      expect(backwardNoNoteRes.text).toContain("requires a note");

      // Backward transition with note: shortlisted -> inbox (must succeed and create note)
      const backwardWithNoteRes = await callTool(tokenWriteAll.secret, "advance_idea", {
        id: createdIdeaId,
        new_status: "inbox",
        note: "Needs more research before shortlisting",
        expected_version: ideaVersion,
      });
      expect(backwardWithNoteRes.isError).toBe(false);
      const backwardData = backwardWithNoteRes.json<{
        idea: { status: string; version: number };
        noteId: string;
      }>();
      expect(backwardData.idea.status).toBe("inbox");
      expect(backwardData.noteId).toBeDefined();
      ideaVersion = backwardData.idea.version;

      // Illegal transition: inbox -> editing (must fail with list of valid stages)
      const illegalTransitionRes = await callTool(tokenWriteAll.secret, "advance_idea", {
        id: createdIdeaId,
        new_status: "editing",
        expected_version: ideaVersion,
      });
      expect(illegalTransitionRes.isError).toBe(true);
      expect(illegalTransitionRes.text).toContain('cannot move to "editing"');
      expect(illegalTransitionRes.text).toContain("valid next stages");
    });
  });

  describe("scripts write tools", () => {
    let ideaId: string;
    let savedScriptId: string;

    beforeAll(async () => {
      // Create an idea for script testing
      const res = await callTool(tokenWriteAll.secret, "create_idea", {
        title: "Scripted Video Project",
      });
      const idea = res.json<{ id: string }>();
      ideaId = idea.id;
    });

    it("enforces permission matrix on save_script_version", async () => {
      // None -> denied
      const resNone = await callTool(tokenNone.secret, "save_script_version", {
        idea_id: ideaId,
        kind: "script",
        base_version: 0,
        body_md: "# Intro\nWelcome back!",
      });
      expect(resNone.isError).toBe(true);
      expect(resNone.text).toContain("write access on scripts");

      // Read -> denied
      const resRead = await callTool(tokenReadOnly.secret, "save_script_version", {
        idea_id: ideaId,
        kind: "script",
        base_version: 0,
        body_md: "# Intro\nWelcome back!",
      });
      expect(resRead.isError).toBe(true);
      expect(resRead.text).toContain("write access on scripts");
    });

    it("saves initial script revision and increments revisions sequentially", async () => {
      // Version 1 (base_version = 0)
      const res1 = await callTool(tokenWriteAll.secret, "save_script_version", {
        idea_id: ideaId,
        kind: "script",
        base_version: 0,
        body_md: "# Intro\nThis is version 1 of the script.",
      });
      expect(res1.isError).toBe(false);
      const v1 = res1.json<{
        id: string;
        version: number;
        status: string;
        sizeBytes: number;
      }>();
      expect(v1.version).toBe(1);
      expect(v1.status).toBe("draft");
      expect(v1.sizeBytes).toBeGreaterThan(0);
      savedScriptId = v1.id;

      // Version 2 (base_version = 1)
      const res2 = await callTool(tokenWriteAll.secret, "save_script_version", {
        idea_id: ideaId,
        kind: "script",
        base_version: 1,
        body_md: "# Intro\nThis is version 2 with edits.",
      });
      expect(res2.isError).toBe(false);
      const v2 = res2.json<{ version: number; status: string }>();
      expect(v2.version).toBe(2);
      expect(v2.status).toBe("draft");

      // Stale base_version: saving with base_version 1 when version is 2
      const staleRes = await callTool(tokenWriteAll.secret, "save_script_version", {
        idea_id: ideaId,
        kind: "script",
        base_version: 1,
        body_md: "# Concurrent edit branch",
      });
      expect(staleRes.isError).toBe(true);
      expect(staleRes.text).toContain("the latest is version 2");
    });

    it("enforces 1 MiB body limit on save_script_version", async () => {
      const oversizedBody = "x".repeat(SCRIPT_BODY_MAX_BYTES + 1);

      await expect(
        callTool(tokenWriteAll.secret, "save_script_version", {
          idea_id: ideaId,
          kind: "script",
          base_version: 2,
          body_md: oversizedBody,
        }),
      ).rejects.toThrow(/413|too large/i);
    });

    it("updates script status with set_script_status", async () => {
      // draft -> review
      const resReview = await callTool(tokenWriteAll.secret, "set_script_status", {
        script_id: savedScriptId,
        status: "review",
      });
      expect(resReview.isError).toBe(false);
      const reviewed = resReview.json<{ status: string }>();
      expect(reviewed.status).toBe("review");

      // review -> approved
      const resApproved = await callTool(tokenWriteAll.secret, "set_script_status", {
        script_id: savedScriptId,
        status: "approved",
      });
      expect(resApproved.isError).toBe(false);
      const approved = resApproved.json<{ status: string }>();
      expect(approved.status).toBe("approved");
    });
  });

  describe("notes write tools", () => {
    let ideaId: string;

    beforeAll(async () => {
      const res = await callTool(tokenWriteAll.secret, "create_idea", {
        title: "Idea For Note Tests",
      });
      const idea = res.json<{ id: string }>();
      ideaId = idea.id;
    });

    it("enforces permission matrix on add_note", async () => {
      // None -> denied
      const resNone = await callTool(tokenNone.secret, "add_note", {
        entity_type: "idea",
        entity_id: ideaId,
        body_md: "Comment from none",
      });
      expect(resNone.isError).toBe(true);
      expect(resNone.text).toContain("write access on notes");

      // Read -> denied
      const resRead = await callTool(tokenReadOnly.secret, "add_note", {
        entity_type: "idea",
        entity_id: ideaId,
        body_md: "Comment from read",
      });
      expect(resRead.isError).toBe(true);
      expect(resRead.text).toContain("write access on notes");
    });

    it("adds a note with author matching token name and writes audit event", async () => {
      const noteBody = "Great idea, let's prioritize filming in Q3.";

      const res = await callTool(tokenWriteAll.secret, "add_note", {
        entity_type: "idea",
        entity_id: ideaId,
        body_md: noteBody,
      });
      expect(res.isError).toBe(false);
      const note = res.json<{
        entityType: string;
        entityId: string;
        bodyMd: string;
        author: string;
        actorType: string;
      }>();
      expect(note.entityType).toBe("idea");
      expect(note.entityId).toBe(ideaId);
      expect(note.bodyMd).toBe(noteBody);
      expect(note.author).toBe(tokenWriteAll.token.name);
      expect(note.actorType).toBe("agent");

      // Verify audit
      const audits = await getAuditEvents("add_note");
      expect(audits.length).toBeGreaterThanOrEqual(1);
      expect(audits[0]?.payload.outcome).toBe("ok");
    });

    it("fails when adding note to non-existent entity", async () => {
      const nonExistentUuid = "00000000-0000-4000-8000-000000000000";

      const res = await callTool(tokenWriteAll.secret, "add_note", {
        entity_type: "idea",
        entity_id: nonExistentUuid,
        body_md: "Will fail",
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("does not exist");
    });
  });
});
