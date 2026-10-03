import { createIdea, registerVideo, saveScriptVersion, withActor } from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestClient,
  createTestToken,
  startTestServer,
  type TestServer,
} from "../../src/testing.js";

const person = (username: string) => ({ name: username, type: "human" as const });

describe("MCP Phase 2 Gate: Concurrency & Optimistic Locking (T35)", () => {
  let db: TestDb;
  let server: TestServer;
  let admin: { id: string; username: string };
  let tokenSecret: string;

  beforeAll(async () => {
    db = await createTestDb();
    server = await startTestServer({ db });

    const adminToken = await createTestToken(db, {}, { isAdmin: true });
    admin = adminToken.owner;

    const token = await createTestToken(db, {
      ideas: "write",
      scripts: "write",
      videos: "write",
    });
    tokenSecret = token.secret;
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

  describe("concurrent save_script_version calls", () => {
    it("allows exactly one save to succeed and fails the other with a latest_version conflict", async () => {
      // 1. Seed an idea with script revision 1
      const idea = await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
        createIdea(tx, { title: "Concurrent Script Idea" }),
      );

      const v1 = await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
        saveScriptVersion(tx, {
          ideaId: idea.id,
          kind: "script",
          baseVersion: 0,
          bodyMd: "# Initial Script Version 1",
        }),
      );
      expect(v1.version).toBe(1);

      // 2. Fire two concurrent save_script_version requests with the SAME base_version: 1
      const [resA, resB] = await Promise.all([
        callTool("save_script_version", {
          idea_id: idea.id,
          kind: "script",
          base_version: 1,
          body_md: "# Revision from Worker A",
        }),
        callTool("save_script_version", {
          idea_id: idea.id,
          kind: "script",
          base_version: 1,
          body_md: "# Revision from Worker B",
        }),
      ]);

      const successes = [resA, resB].filter((r) => !r.isError);
      const failures = [resA, resB].filter((r) => r.isError);

      // Exactly 1 succeeds and 1 fails
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      // Failure includes latest_version conflict information
      const failure = failures[0]!;
      expect(failure.text).toContain("latest_version");
      expect(failure.text).toMatch(/not the latest script version|conflict/i);

      // Verify DB state: exactly 2 versions exist (version 1 and version 2)
      const { rows } = await db.admin.query<{ version: number }>(
        "SELECT version FROM scripts WHERE idea_id = $1 ORDER BY version ASC",
        [idea.id],
      );
      expect(rows.map((r) => r.version)).toEqual([1, 2]);
    });
  });

  describe("concurrent update_idea calls", () => {
    it("allows exactly one update to succeed and fails the other with a version conflict", async () => {
      // 1. Seed an idea at version 1
      const idea = await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
        createIdea(tx, { title: "Concurrent Update Idea" }),
      );
      expect(idea.version).toBe(1);

      // 2. Fire two concurrent update_idea requests with the SAME expected_version: 1
      const [resA, resB] = await Promise.all([
        callTool("update_idea", {
          id: idea.id,
          expected_version: 1,
          fields: { title: "Title from Worker A" },
        }),
        callTool("update_idea", {
          id: idea.id,
          expected_version: 1,
          fields: { title: "Title from Worker B" },
        }),
      ]);

      const successes = [resA, resB].filter((r) => !r.isError);
      const failures = [resA, resB].filter((r) => r.isError);

      // Exactly 1 succeeds and 1 fails
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      // Failure reports version conflict
      const failure = failures[0]!;
      expect(failure.text).toMatch(/version_conflict|modified concurrently|expected_version/i);

      // Verify DB state: idea version incremented to 2
      const { rows } = await db.admin.query<{ version: number }>(
        "SELECT version FROM ideas WHERE id = $1",
        [idea.id],
      );
      expect(rows[0]?.version).toBe(2);
    });
  });

  describe("concurrent log_metrics calls", () => {
    it("is idempotent on (video_id, captured_at), allowing concurrent snapshot appends", async () => {
      // 1. Seed a video
      const video = await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
        registerVideo(tx, {
          youtubeId: "ytw_concur1",
          title: "Concurrent Metrics Video",
        }),
      );

      const capturedAt = new Date().toISOString();

      // 2. Fire 3 concurrent log_metrics calls for the exact same video_id, captured_at, and metrics
      const results = await Promise.all([
        callTool("log_metrics", {
          video_id: video.id,
          captured_at: capturedAt,
          metrics: { views: 100, ctr: 4.5 },
        }),
        callTool("log_metrics", {
          video_id: video.id,
          captured_at: capturedAt,
          metrics: { views: 100, ctr: 4.5 },
        }),
        callTool("log_metrics", {
          video_id: video.id,
          captured_at: capturedAt,
          metrics: { views: 100, ctr: 4.5 },
        }),
      ]);

      // All 3 calls succeed idempotently
      for (const res of results) {
        expect(res.isError).toBe(false);
      }

      // Verify DB state: exactly 1 metrics row was created for this snapshot timestamp
      const { rows } = await db.admin.query<{ count: string }>(
        "SELECT count(*) AS count FROM video_metrics WHERE video_id = $1 AND captured_at = $2",
        [video.id, capturedAt],
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });
  });
});
