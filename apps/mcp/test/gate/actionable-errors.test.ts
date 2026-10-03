import { createIdea, saveScriptVersion, withActor } from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestClient,
  createTestToken,
  startTestServer,
  type TestServer,
} from "../../src/testing.js";

const person = (username: string) => ({ name: username, type: "human" as const });

describe("MCP Phase 2 Gate: Actionable LLM-Readable Error Messages (T35)", () => {
  let db: TestDb;
  let server: TestServer;
  let admin: { id: string; username: string };
  let tokenSecret: string;
  let seededIdeaId: string;
  let seededScriptRevisionId: string;

  beforeAll(async () => {
    db = await createTestDb();
    server = await startTestServer({ db });

    const adminToken = await createTestToken(db, {}, { isAdmin: true });
    admin = adminToken.owner;

    const fullToken = await createTestToken(db, {
      ideas: "write",
      scripts: "write",
      videos: "write",
      experiments: "write",
      notes: "write",
    });
    tokenSecret = fullToken.secret;

    const idea = await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
      createIdea(tx, {
        title: "Actionable Errors Test Idea",
        pitch: "Pitch for actionable errors",
      }),
    );
    seededIdeaId = idea.id;

    const script = await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
      saveScriptVersion(tx, {
        ideaId: idea.id,
        kind: "script",
        baseVersion: 0,
        bodyMd: "# Version 1 Body",
      }),
    );
    seededScriptRevisionId = script.id;
  });

  afterAll(async () => {
    await server.close();
    await db.drop();
  });

  async function callTool(toolName: string, args: Record<string, unknown>) {
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

  describe("invalid stage transition errors", () => {
    it("explains why transition is invalid and lists valid next stages", async () => {
      // Trying to move idea directly from 'inbox' to 'filming' (skipping shortlisted/scripting)
      const res = await callTool("advance_idea", {
        id: seededIdeaId,
        new_status: "filming",
      });

      expect(res.isError).toBe(true);
      // Explains what failed
      expect(res.text).toMatch(/cannot move to "filming"/i);
      expect(res.text).toContain("valid next stages");
      // Lists valid next stages
      expect(res.text).toContain("shortlisted");
      expect(res.text).toContain("dropped");
      expect(res.text).toContain("allowed");
    });
  });

  describe("stage transition backward without note", () => {
    it("explains that moving backward requires an explanatory note", async () => {
      // First move idea from inbox to shortlisted
      const fwd = await callTool("advance_idea", {
        id: seededIdeaId,
        new_status: "shortlisted",
      });
      expect(fwd.isError).toBe(false);

      // Now move backward from shortlisted to inbox without note
      const backward = await callTool("advance_idea", {
        id: seededIdeaId,
        new_status: "inbox",
      });

      expect(backward.isError).toBe(true);
      expect(backward.text).toMatch(
        /moving an idea back from "shortlisted" to "inbox" requires a note explaining why/i,
      );
      expect(backward.text).toContain("note");
    });
  });

  describe("concurrency conflict on script version", () => {
    it("reports conflict and returns latest_version so agent can merge and retry", async () => {
      // Latest version is 1; call save_script_version with stale base_version 0
      const res = await callTool("save_script_version", {
        idea_id: seededIdeaId,
        kind: "script",
        base_version: 0,
        body_md: "# Stale Revision",
      });

      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/not the latest script version/i);
      expect(res.text).toContain("latest_version");
      expect(res.text).toContain("latest is version 1");
    });
  });

  describe("concurrency conflict on idea update", () => {
    it("reports conflict and specifies expected version mismatch", async () => {
      // Call update_idea with an expected_version of 999 (actual version is 2 after advance)
      const res = await callTool("update_idea", {
        id: seededIdeaId,
        expected_version: 999,
        fields: { title: "Concurrent Edit Attempt" },
      });

      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/conflict|modified concurrently|version/i);
      expect(res.text).toContain("expected_version");
    });
  });

  describe("invalid enum values list valid options", () => {
    it("advance_idea lists valid stage options when an invalid stage is passed", async () => {
      const res = await callTool("advance_idea", {
        id: seededIdeaId,
        new_status: "flying",
      });

      expect(res.isError).toBe(true);
      expect(res.text).toContain("Invalid option");
      expect(res.text).toContain("inbox");
      expect(res.text).toContain("shortlisted");
      expect(res.text).toContain("scripting");
      expect(res.text).toContain("dropped");
    });

    it("save_script_version lists valid kinds when an invalid kind is passed", async () => {
      const res = await callTool("save_script_version", {
        idea_id: seededIdeaId,
        kind: "novel",
        base_version: 1,
        body_md: "# Content",
      });

      expect(res.isError).toBe(true);
      expect(res.text).toContain("Invalid option");
      expect(res.text).toContain("script");
      expect(res.text).toContain("packaging");
    });

    it("set_script_status lists valid statuses when an invalid status is passed", async () => {
      const res = await callTool("set_script_status", {
        script_id: seededScriptRevisionId,
        status: "published",
      });

      expect(res.isError).toBe(true);
      expect(res.text).toContain("Invalid option");
      expect(res.text).toContain("draft");
      expect(res.text).toContain("review");
      expect(res.text).toContain("approved");
    });

    it("create_experiment lists valid types when an invalid experiment type is passed", async () => {
      const res = await callTool("create_experiment", {
        video_id: "0199a80b-f350-7000-8812-4e0078170001",
        type: "duration",
        variants: [
          { label: "A", content: "A", is_control: true },
          { label: "B", content: "B" },
        ],
      });

      expect(res.isError).toBe(true);
      expect(res.text).toContain("Invalid option");
      expect(res.text).toContain("title");
      expect(res.text).toContain("thumbnail");
    });

    it("add_note lists valid entity types when an invalid entity type is passed", async () => {
      const res = await callTool("add_note", {
        entity_type: "comment",
        entity_id: seededIdeaId,
        body_md: "Test note",
      });

      expect(res.isError).toBe(true);
      expect(res.text).toContain("Invalid option");
      expect(res.text).toContain("idea");
      expect(res.text).toContain("script");
      expect(res.text).toContain("video");
      expect(res.text).toContain("experiment");
    });
  });
});
