import {
  addNote,
  createExperiment,
  createIdea,
  registerVideo,
  saveScriptVersion,
  setUserPermission,
  updateExperimentStatus,
  withActor,
} from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import type { Level, Resource } from "@ytw/shared/constants";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestClient,
  createTestToken,
  startTestServer,
  type TestServer,
} from "../../src/testing.js";

const person = (username: string) => ({ name: username, type: "human" as const });

interface ToolResponse {
  isError: boolean;
  text: string;
  json<T = Record<string, unknown>>(): T;
}

interface SeededContext {
  ideaId: string;
  advanceIdeaId: string;
  scriptId: string;
  videoId: string;
  experimentId: string;
  controlVariantId: string;
  noteId: string;
}

interface StandardToolDef {
  name: string;
  resource: Resource;
  level: "read" | "write";
  getArgs: (ctx: SeededContext) => Record<string, unknown>;
}

describe("MCP Phase 2 Gate: Permissions Matrix (T35)", () => {
  let db: TestDb;
  let server: TestServer;
  let admin: { id: string; username: string };
  let seeded: SeededContext;

  beforeAll(async () => {
    db = await createTestDb();
    server = await startTestServer({ db });

    const adminToken = await createTestToken(db, {}, { isAdmin: true });
    admin = adminToken.owner;

    // Seed test entities inside a transaction
    const idea = await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
      createIdea(tx, {
        title: "Gate Permissions Seed Idea",
        pitch: "Seed pitch",
      }),
    );

    const advanceIdea = await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
      createIdea(tx, {
        title: "Gate Advance Seed Idea",
        pitch: "Seed pitch for advancing",
      }),
    );

    const script = await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
      saveScriptVersion(tx, {
        ideaId: idea.id,
        kind: "script",
        baseVersion: 0,
        bodyMd: "# Seed Script Content",
      }),
    );

    const video = await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
      registerVideo(tx, {
        ideaId: idea.id,
        youtubeId: "ytw_vid_001",
        title: "Gate Seed Video",
      }),
    );

    const experiment = await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
      createExperiment(tx, {
        videoId: video.id,
        type: "title",
        hypothesis: "Better title improves CTR",
        variants: [
          { label: "Variant A (Control)", content: "Control Title", isControl: true },
          { label: "Variant B", content: "Test Title", isControl: false },
        ],
      }),
    );

    await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
      updateExperimentStatus(tx, {
        id: experiment.id,
        expectedVersion: experiment.version,
        newStatus: "running",
      }),
    );

    const note = await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
      addNote(tx, {
        entityType: "idea",
        entityId: idea.id,
        bodyMd: "Seed note for permissions testing",
      }),
    );

    const controlVariant = experiment.variants.find((v) => v.isControl) ?? experiment.variants[0];

    seeded = {
      ideaId: idea.id,
      advanceIdeaId: advanceIdea.id,
      scriptId: script.id,
      videoId: video.id,
      experimentId: experiment.id,
      controlVariantId: controlVariant!.id,
      noteId: note.id,
    };
  });

  afterAll(async () => {
    await server.close();
    await db.drop();
  });

  async function callTool(
    tokenSecret: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResponse> {
    const { client, close } = await createTestClient(server.mcpUrl, tokenSecret);
    try {
      const res = await client.callTool({ name: toolName, arguments: args });
      const content = (res.content as [{ type: "text"; text: string }] | undefined) ?? [];
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

  async function verifyDeniedAudit(tokenId: string, toolName: string, ownerUsername: string) {
    const { rows } = await db.admin.query<{
      actor: string;
      token_id: string;
      action: string;
      payload: { tool: string; outcome: string; token_owner: string };
    }>(
      `SELECT actor, token_id, action, payload
         FROM events
        WHERE (action = 'tool.call' OR action = 'mcp_tool_denied')
          AND token_id = $1
          AND payload->>'tool' = $2
        ORDER BY created_at DESC LIMIT 1`,
      [tokenId, toolName],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_id).toBe(tokenId);
    expect(rows[0]!.payload.tool).toBe(toolName);
    expect(rows[0]!.payload.outcome).toBe("denied");
    expect(rows[0]!.payload.token_owner).toBe(ownerUsername);
  }

  let vidCounter = 100;

  const WRITE_TOOLS: StandardToolDef[] = [
    {
      name: "create_idea",
      resource: "ideas",
      level: "write",
      getArgs: () => ({ title: "Matrix Created Idea" }),
    },
    {
      name: "update_idea",
      resource: "ideas",
      level: "write",
      getArgs: (ctx) => ({
        id: ctx.ideaId,
        expected_version: 1,
        fields: { title: "Matrix Updated Idea" },
      }),
    },
    {
      name: "advance_idea",
      resource: "ideas",
      level: "write",
      getArgs: (ctx) => ({
        id: ctx.advanceIdeaId,
        new_status: "shortlisted",
      }),
    },
    {
      name: "save_script_version",
      resource: "scripts",
      level: "write",
      getArgs: (ctx) => ({
        idea_id: ctx.ideaId,
        kind: "packaging",
        base_version: 0,
        body_md: "# Packaging Draft",
      }),
    },
    {
      name: "set_script_status",
      resource: "scripts",
      level: "write",
      getArgs: (ctx) => ({
        script_id: ctx.scriptId,
        status: "review",
      }),
    },
    {
      name: "register_video",
      resource: "videos",
      level: "write",
      getArgs: () => {
        const id = `ytw_v${(vidCounter++).toString().padStart(6, "0")}`;
        return {
          youtube_id: id,
          title: "Matrix Registered Video",
        };
      },
    },
    {
      name: "log_metrics",
      resource: "videos",
      level: "write",
      getArgs: (ctx) => ({
        video_id: ctx.videoId,
        captured_at: new Date().toISOString(),
        metrics: { views: 42 },
      }),
    },
    {
      name: "create_experiment",
      resource: "experiments",
      level: "write",
      getArgs: (ctx) => ({
        video_id: ctx.videoId,
        type: "thumbnail",
        variants: [
          { label: "Thumb A", content: "thumb_a.png", is_control: true },
          { label: "Thumb B", content: "thumb_b.png" },
        ],
      }),
    },
    {
      name: "record_variant_stats",
      resource: "experiments",
      level: "write",
      getArgs: (ctx) => ({
        variant_id: ctx.controlVariantId,
        impressions: 250,
        ctr: 7.5,
      }),
    },
    {
      name: "conclude_experiment",
      resource: "experiments",
      level: "write",
      getArgs: (ctx) => ({
        id: ctx.experimentId,
        conclusion: "Variant A performed solidly.",
      }),
    },
    {
      name: "add_note",
      resource: "notes",
      level: "write",
      getArgs: (ctx) => ({
        entity_type: "idea",
        entity_id: ctx.ideaId,
        body_md: "Matrix test comment",
      }),
    },
  ];

  const READ_TOOLS: StandardToolDef[] = [
    {
      name: "export_script",
      resource: "scripts",
      level: "read",
      getArgs: (ctx) => ({
        idea_id: ctx.ideaId,
        kind: "script",
      }),
    },
    {
      name: "list_ideas",
      resource: "ideas",
      level: "read",
      getArgs: () => ({}),
    },
    {
      name: "get_idea",
      resource: "ideas",
      level: "read",
      getArgs: (ctx) => ({
        id: ctx.ideaId,
      }),
    },
    {
      name: "get_script",
      resource: "scripts",
      level: "read",
      getArgs: (ctx) => ({
        idea_id: ctx.ideaId,
        kind: "script",
      }),
    },
    {
      name: "list_videos",
      resource: "videos",
      level: "read",
      getArgs: () => ({}),
    },
    {
      name: "get_video_performance",
      resource: "videos",
      level: "read",
      getArgs: (ctx) => ({
        video_id: ctx.videoId,
      }),
    },
    {
      name: "list_experiments",
      resource: "experiments",
      level: "read",
      getArgs: () => ({}),
    },
    {
      name: "get_experiment_results",
      resource: "experiments",
      level: "read",
      getArgs: (ctx) => ({
        experiment_id: ctx.experimentId,
      }),
    },
    {
      name: "list_notes",
      resource: "notes",
      level: "read",
      getArgs: (ctx) => ({
        entity_type: "idea",
        entity_id: ctx.ideaId,
      }),
    },
  ];

  describe("write tools permission matrix (11 tools)", () => {
    for (const tool of WRITE_TOOLS) {
      describe(`tool: ${tool.name} (requires write on ${tool.resource})`, () => {
        it("a) rejects call when token has 'none' on required resource and audits denial", async () => {
          const otherResource: Resource = tool.resource === "ideas" ? "videos" : "ideas";
          const { secret, token, owner } = await createTestToken(db, {
            [tool.resource]: "none",
            [otherResource]: "read",
          });

          const res = await callTool(secret, tool.name, tool.getArgs(seeded));
          expect(res.isError).toBe(true);
          expect(res.text).toContain("Permission denied");
          expect(res.text).toContain(tool.resource);

          await verifyDeniedAudit(token.id, tool.name, owner.username);
        });

        it("b) rejects call when token only has 'read' and audits denial", async () => {
          const { secret, token, owner } = await createTestToken(db, {
            [tool.resource]: "read",
          });

          const res = await callTool(secret, tool.name, tool.getArgs(seeded));
          expect(res.isError).toBe(true);
          expect(res.text).toContain("Permission denied");
          expect(res.text).toContain(tool.resource);
          expect(res.text).toContain("write");

          await verifyDeniedAudit(token.id, tool.name, owner.username);
        });

        it("b) allows call when token has 'write'", async () => {
          const { secret } = await createTestToken(db, {
            [tool.resource]: "write",
          });

          const res = await callTool(secret, tool.name, tool.getArgs(seeded));
          expect(res.isError).toBe(false);
        });

        it("b) enforces owner ceiling: rejects write when owner user level is lowered to read or none", async () => {
          const { secret, token, owner } = await createTestToken(db, {
            [tool.resource]: "write",
          });

          // 1. Lower owner level to 'read'
          await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
            setUserPermission(tx, {
              actingUserId: admin.id,
              userId: owner.id,
              resource: tool.resource,
              level: "read",
            }),
          );

          const resRead = await callTool(secret, tool.name, tool.getArgs(seeded));
          expect(resRead.isError).toBe(true);
          expect(resRead.text).toContain("Permission denied");
          await verifyDeniedAudit(token.id, tool.name, owner.username);

          // 2. Lower owner level to 'none'
          await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
            setUserPermission(tx, {
              actingUserId: admin.id,
              userId: owner.id,
              resource: tool.resource,
              level: "none",
            }),
          );

          const resNone = await callTool(secret, tool.name, tool.getArgs(seeded));
          expect(resNone.isError).toBe(true);
          expect(resNone.text).toContain("Permission denied");
          await verifyDeniedAudit(token.id, tool.name, owner.username);
        });
      });
    }
  });

  describe("read tools permission matrix (9 tools)", () => {
    for (const tool of READ_TOOLS) {
      describe(`tool: ${tool.name} (requires read on ${tool.resource})`, () => {
        it("a) rejects call when token has 'none' on required resource and audits denial", async () => {
          const otherResource: Resource = tool.resource === "ideas" ? "videos" : "ideas";
          const { secret, token, owner } = await createTestToken(db, {
            [tool.resource]: "none",
            [otherResource]: "read",
          });

          const res = await callTool(secret, tool.name, tool.getArgs(seeded));
          expect(res.isError).toBe(true);
          expect(res.text).toContain("Permission denied");
          expect(res.text).toContain(tool.resource);

          await verifyDeniedAudit(token.id, tool.name, owner.username);
        });

        it("c) allows call when token has 'read'", async () => {
          const { secret } = await createTestToken(db, {
            [tool.resource]: "read",
          });

          const res = await callTool(secret, tool.name, tool.getArgs(seeded));
          expect(res.isError).toBe(false);
        });

        it("c) enforces owner ceiling: rejects read when owner user level is lowered to none", async () => {
          const { secret, token, owner } = await createTestToken(db, {
            [tool.resource]: "read",
          });

          // Lower owner to none
          await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
            setUserPermission(tx, {
              actingUserId: admin.id,
              userId: owner.id,
              resource: tool.resource,
              level: "none",
            }),
          );

          const res = await callTool(secret, tool.name, tool.getArgs(seeded));
          expect(res.isError).toBe(true);
          expect(res.text).toContain("Permission denied");
          await verifyDeniedAudit(token.id, tool.name, owner.username);
        });
      });
    }
  });

  describe("tool: query_sql (requires Read on ALL 6 resources)", () => {
    const allResources: Resource[] = [
      "ideas",
      "scripts",
      "videos",
      "experiments",
      "notes",
      "activity",
    ];

    it.each(allResources)(
      "d) rejects query_sql when token is missing Read on '%s'",
      async (missingResource) => {
        const perms: Partial<Record<Resource, Level>> = {};
        for (const r of allResources) {
          perms[r] = r === missingResource ? "none" : "read";
        }

        const { secret } = await createTestToken(db, perms);

        // Attempting to call query_sql must fail
        const res = await callTool(secret, "query_sql", { sql: "SELECT 1 AS num" });
        expect(res.isError).toBe(true);
      },
    );

    it("d) allows query_sql when token has Read on all resources", async () => {
      const perms: Partial<Record<Resource, Level>> = {};
      for (const r of allResources) {
        perms[r] = "read";
      }

      const { secret } = await createTestToken(db, perms);
      const res = await callTool(secret, "query_sql", { sql: "SELECT 1 AS num" });
      expect(res.isError).toBe(false);
      const data = res.json<{ rows: { num: number }[] }>();
      expect(data.rows[0]?.num).toBe(1);
    });

    it("d) immediately revokes query_sql when owner access on any resource is lowered", async () => {
      const perms: Partial<Record<Resource, Level>> = {};
      for (const r of allResources) {
        perms[r] = "read";
      }

      const { secret, owner } = await createTestToken(db, perms);

      // Verify initially allowed
      const res1 = await callTool(secret, "query_sql", { sql: "SELECT 1 AS num" });
      expect(res1.isError).toBe(false);

      // Lower owner's activity access to none
      await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
        setUserPermission(tx, {
          actingUserId: admin.id,
          userId: owner.id,
          resource: "activity",
          level: "none",
        }),
      );

      // Call must now fail immediately
      const res2 = await callTool(secret, "query_sql", { sql: "SELECT 1 AS num" });
      expect(res2.isError).toBe(true);
    });
  });

  describe("tool: search (requires Read on ideas or scripts)", () => {
    it("e) rejects search when token has 'none' on both ideas and scripts", async () => {
      const { secret } = await createTestToken(db, {
        ideas: "none",
        scripts: "none",
        videos: "read",
      });

      const res = await callTool(secret, "search", { query: "Seed" });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("Permission denied");
    });

    it("e) allows search when token has Read on ideas", async () => {
      const { secret } = await createTestToken(db, {
        ideas: "read",
        scripts: "none",
      });

      const res = await callTool(secret, "search", { query: "Seed" });
      expect(res.isError).toBe(false);
    });

    it("e) allows search when token has Read on scripts", async () => {
      const { secret } = await createTestToken(db, {
        ideas: "none",
        scripts: "read",
      });

      const res = await callTool(secret, "search", { query: "Seed" });
      expect(res.isError).toBe(false);
    });

    it("e) rejects search when owner access is lowered to none on both", async () => {
      const { secret, owner } = await createTestToken(db, {
        ideas: "read",
        scripts: "read",
      });

      // Lower owner access on both
      await withActor(db.pool("ytw_web"), person(admin.username), async (tx) => {
        await setUserPermission(tx, {
          actingUserId: admin.id,
          userId: owner.id,
          resource: "ideas",
          level: "none",
        });
        await setUserPermission(tx, {
          actingUserId: admin.id,
          userId: owner.id,
          resource: "scripts",
          level: "none",
        });
      });

      const res = await callTool(secret, "search", { query: "Seed" });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("Permission denied");
    });
  });

  describe("tool: whoami", () => {
    it("f) allows call for any authenticated token regardless of permission levels", async () => {
      const { secret, token, owner } = await createTestToken(
        db,
        {
          ideas: "none",
          scripts: "none",
          videos: "none",
          experiments: "none",
          notes: "none",
          activity: "none",
        },
        { isAdmin: true },
      );

      const res = await callTool(secret, "whoami", {});
      expect(res.isError).toBe(false);
      const data = res.json<{
        token: string;
        owner: string;
        effectiveLevels: Record<string, string>;
      }>();
      expect(data.token).toBe(token.name);
      expect(data.owner).toBe(owner.username);
      expect(data.effectiveLevels.ideas).toBe("none");
    });
  });
});
