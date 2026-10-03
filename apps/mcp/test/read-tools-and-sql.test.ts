import {
  advanceIdea,
  createExperiment,
  createIdea,
  logMetrics,
  registerVideo,
  saveScriptVersion,
  setUserPermission,
  withActor,
} from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
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

describe("MCP read tools and query_sql (T33)", () => {
  let db: TestDb;
  let server: TestServer;
  let admin: { id: string; username: string };

  let tokenAllRead: CreatedTestToken;
  let tokenMissingOneRead: CreatedTestToken; // Missing activity read
  let tokenNone: CreatedTestToken;
  let tokenLowerable: CreatedTestToken;

  let seededIdeaId: string;
  let seededVideoId: string;
  let seededExperimentId: string;

  beforeAll(async () => {
    db = await createTestDb();
    server = await startTestServer({ db });

    const adminToken = await createTestToken(db, {}, { isAdmin: true });
    admin = adminToken.owner;

    // Token with Read on EVERYTHING (including activity log)
    tokenAllRead = await createTestToken(db, {
      ideas: "read",
      scripts: "read",
      videos: "read",
      experiments: "read",
      notes: "read",
      activity: "read",
    });

    // Token with Read on all objects EXCEPT activity
    tokenMissingOneRead = await createTestToken(db, {
      ideas: "read",
      scripts: "read",
      videos: "read",
      experiments: "read",
      notes: "read",
      activity: "none",
    });

    // Token with minimal access
    tokenNone = await createTestToken(db, {
      ideas: "read", // Owner needs at least 1 resource to create token
      scripts: "none",
      videos: "none",
      experiments: "none",
      notes: "none",
      activity: "none",
    });

    // Token for testing dynamic owner permission lowering
    tokenLowerable = await createTestToken(db, {
      ideas: "read",
      scripts: "read",
      videos: "read",
      experiments: "read",
      notes: "read",
      activity: "read",
    });

    // Seed test data via DB functions
    await withActor(db.pool("ytw_web"), person(admin.username), async (tx) => {
      // 1. Seed Idea
      const idea = await createIdea(tx, {
        title: "Seed Idea for Reading",
        pitch: "Great pitch for reading tests",
        source: "Research",
        tags: ["reading", "testing"],
        score: 95,
      });
      seededIdeaId = idea.id;

      // 2. Seed Script
      await saveScriptVersion(tx, {
        ideaId: seededIdeaId,
        kind: "script",
        baseVersion: 0,
        bodyMd: "# Seed Script Body\nContent for full text search keyword serendipity.",
      });

      // 3. Seed Video
      const video = await registerVideo(tx, {
        ideaId: seededIdeaId,
        youtubeId: "seedReadVid",
        title: "Seeded Read Video Title",
        publishedAt: "2026-09-01T10:00:00Z",
      });
      seededVideoId = video.id;

      // 4. Seed Metric Snapshot
      await logMetrics(tx, {
        videoId: seededVideoId,
        capturedAt: "2026-09-02T10:00:00Z",
        metrics: {
          views: 50000,
          impressions: 200000,
          ctr: "5.0",
        },
      });

      // 5. Seed Experiment
      const exp = await createExperiment(tx, {
        videoId: seededVideoId,
        type: "title",
        hypothesis: "A better title wins",
        variants: [
          { label: "Ctrl", content: "Original Title", isControl: true },
          { label: "Var1", content: "Exciting Title", isControl: false },
        ],
      });
      seededExperimentId = exp.id;
    });
  });

  afterAll(async () => {
    await server.close();
    await db.drop();
  });

  async function callTool(
    tokenSecret: string,
    name: string,
    args: Record<string, unknown> = {},
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

  describe("structured read tools", () => {
    it("list_ideas respects permissions and filters by stage", async () => {
      // Permission check: None -> denied
      const resNone = await callTool(tokenNone.secret, "list_ideas", { status: "inbox" });
      // tokenNone has ideas: read so it works
      expect(resNone.isError).toBe(false);

      // Create a token with NO access on ideas
      const tokenNoIdeas = await createTestToken(db, {
        videos: "read",
        ideas: "none",
      });
      const resDenied = await callTool(tokenNoIdeas.secret, "list_ideas");
      expect(resDenied.isError).toBe(true);
      expect(resDenied.text).toContain("read access on ideas");

      // Successful read
      const res = await callTool(tokenAllRead.secret, "list_ideas", { status: "inbox" });
      expect(res.isError).toBe(false);
      const ideas = res.json<{ id: string; title: string; status: string }[]>();
      expect(ideas.length).toBeGreaterThanOrEqual(1);
      const found = ideas.find((i) => i.id === seededIdeaId);
      expect(found).toBeDefined();
      expect(found?.status).toBe("inbox");
    });

    it("get_idea retrieves idea by ID and returns NotFoundError for unknown ID", async () => {
      const res = await callTool(tokenAllRead.secret, "get_idea", { id: seededIdeaId });
      expect(res.isError).toBe(false);
      const idea = res.json<{ id: string; title: string }>();
      expect(idea.id).toBe(seededIdeaId);
      expect(idea.title).toBe("Seed Idea for Reading");

      // Unknown ID
      const notFoundRes = await callTool(tokenAllRead.secret, "get_idea", {
        id: "00000000-0000-4000-8000-000000000000",
      });
      expect(notFoundRes.isError).toBe(true);
      expect(notFoundRes.text).toContain("does not exist");
    });

    it("get_script retrieves script revisions and returns NotFoundError for missing revision", async () => {
      // Permission check
      const tokenNoScripts = await createTestToken(db, {
        ideas: "read",
        scripts: "none",
      });
      const resDenied = await callTool(tokenNoScripts.secret, "get_script", {
        idea_id: seededIdeaId,
        kind: "script",
      });
      expect(resDenied.isError).toBe(true);
      expect(resDenied.text).toContain("read access on scripts");

      // Successful read
      const res = await callTool(tokenAllRead.secret, "get_script", {
        idea_id: seededIdeaId,
        kind: "script",
      });
      expect(res.isError).toBe(false);
      const script = res.json<{ bodyMd: string; version: number }>();
      expect(script.version).toBe(1);
      expect(script.bodyMd).toContain("Seed Script Body");

      // Missing packaging kind
      const notFoundRes = await callTool(tokenAllRead.secret, "get_script", {
        idea_id: seededIdeaId,
        kind: "packaging",
      });
      expect(notFoundRes.isError).toBe(true);
      expect(notFoundRes.text).toContain("does not exist");
    });

    it("list_videos and get_video_performance return performance summary against medians", async () => {
      // Permission check
      const tokenNoVideos = await createTestToken(db, {
        ideas: "read",
        videos: "none",
      });
      const resDenied = await callTool(tokenNoVideos.secret, "list_videos");
      expect(resDenied.isError).toBe(true);
      expect(resDenied.text).toContain("read access on videos");

      // list_videos
      const resList = await callTool(tokenAllRead.secret, "list_videos");
      expect(resList.isError).toBe(false);
      const videos = resList.json<{ id: string; youtubeId: string }[]>();
      expect(videos.some((v) => v.id === seededVideoId)).toBe(true);

      // get_video_performance
      const resPerf = await callTool(tokenAllRead.secret, "get_video_performance", {
        video_id: seededVideoId,
      });
      expect(resPerf.isError).toBe(false);
      const perf = resPerf.json<{
        id: string;
        youtubeId: string;
        latest: { views: string } | null;
        median: { sampleSize: number };
      }>();
      expect(perf.id).toBe(seededVideoId);
      expect(perf.latest?.views).toBe("50000");
      expect(perf.median.sampleSize).toBeGreaterThanOrEqual(1);
    });

    it("list_experiments and get_experiment_results return variant results and statuses", async () => {
      // Permission check
      const tokenNoExp = await createTestToken(db, {
        ideas: "read",
        experiments: "none",
      });
      const resDenied = await callTool(tokenNoExp.secret, "list_experiments");
      expect(resDenied.isError).toBe(true);
      expect(resDenied.text).toContain("read access on experiments");

      // list_experiments
      const resList = await callTool(tokenAllRead.secret, "list_experiments", {
        video_id: seededVideoId,
      });
      expect(resList.isError).toBe(false);
      const exps = resList.json<{ experimentId: string; status: string }[]>();
      expect(exps.some((e) => e.experimentId === seededExperimentId)).toBe(true);

      // get_experiment_results
      const resResults = await callTool(tokenAllRead.secret, "get_experiment_results", {
        experiment_id: seededExperimentId,
      });
      expect(resResults.isError).toBe(false);
      const details = resResults.json<{
        experimentId: string;
        variants: { isControl: boolean; label: string }[];
      }>();
      expect(details.experimentId).toBe(seededExperimentId);
      expect(details.variants).toHaveLength(2);
    });

    it("list_notes retrieves notes for entities", async () => {
      // Add a note via admin actor
      await withActor(db.pool("ytw_web"), person(admin.username), async (tx) => {
        await advanceIdea(tx, {
          id: seededIdeaId,
          newStatus: "shortlisted",
        });
        await advanceIdea(tx, {
          id: seededIdeaId,
          newStatus: "inbox",
          note: "Demoted to inbox for further review.",
        });
      });

      // Permission check
      const tokenNoNotes = await createTestToken(db, {
        ideas: "read",
        notes: "none",
      });
      const resDenied = await callTool(tokenNoNotes.secret, "list_notes", {
        entity_type: "idea",
        entity_id: seededIdeaId,
      });
      expect(resDenied.isError).toBe(true);
      expect(resDenied.text).toContain("read access on notes");

      // Successful read
      const res = await callTool(tokenAllRead.secret, "list_notes", {
        entity_type: "idea",
        entity_id: seededIdeaId,
      });
      expect(res.isError).toBe(false);
      const notes = res.json<{ bodyMd: string; entityId: string }[]>();
      expect(notes.length).toBeGreaterThanOrEqual(1);
      expect(notes[0]?.bodyMd).toContain("Demoted to inbox");
    });

    it("search restricts results to readable resources and masks titles when ideas unreadable", async () => {
      // Search with both ideas and scripts readable
      const resAll = await callTool(tokenAllRead.secret, "search", {
        query: "serendipity",
      });
      expect(resAll.isError).toBe(false);
      const hitsAll =
        resAll.json<{ entityType: string; title: string | null; snippet: string }[]>();
      expect(hitsAll.length).toBeGreaterThanOrEqual(1);
      expect(hitsAll[0]?.entityType).toBe("script");
      expect(hitsAll[0]?.title).toBe("Seed Idea for Reading"); // title included because ideas is readable
      expect(hitsAll[0]?.snippet).toContain("serendipity");

      // Search with only scripts readable (ideas is none)
      const tokenOnlyScripts = await createTestToken(db, {
        scripts: "read",
        ideas: "none",
      });
      const resOnlyScripts = await callTool(tokenOnlyScripts.secret, "search", {
        query: "serendipity",
      });
      expect(resOnlyScripts.isError).toBe(false);
      const hitsOnlyScripts = resOnlyScripts.json<{ entityType: string; title: string | null }[]>();
      expect(hitsOnlyScripts.length).toBeGreaterThanOrEqual(1);
      // Idea title MUST be null because caller cannot read ideas!
      expect(hitsOnlyScripts[0]?.title).toBeNull();

      // Search when neither ideas nor scripts is readable -> Forbidden
      const tokenNoSearch = await createTestToken(db, {
        videos: "read",
        ideas: "none",
        scripts: "none",
      });
      const resDenied = await callTool(tokenNoSearch.secret, "search", {
        query: "serendipity",
      });
      expect(resDenied.isError).toBe(true);
      expect(resDenied.text).toContain("read access on ideas or scripts is required");
    });
  });

  describe("query_sql", () => {
    it("is available to tokens with Read on all objects, but NOT registered for tokens missing any object", async () => {
      // 1. Token with Read on ALL objects: query_sql is offered in tools/list
      const { client: clientAll, close: closeAll } = await createTestClient(
        server.mcpUrl,
        tokenAllRead.secret,
      );
      try {
        const toolsAll = await clientAll.listTools();
        const sqlTool = toolsAll.tools.find((t) => t.name === "query_sql");
        expect(sqlTool).toBeDefined();
      } finally {
        await closeAll();
      }

      // 2. Token missing even ONE object (e.g. activity: none): query_sql is NOT registered
      const { client: clientMissing, close: closeMissing } = await createTestClient(
        server.mcpUrl,
        tokenMissingOneRead.secret,
      );
      try {
        const toolsMissing = await clientMissing.listTools();
        const sqlTool = toolsMissing.tools.find((t) => t.name === "query_sql");
        expect(sqlTool).toBeUndefined(); // Filtered out!

        // Attempting to call query_sql directly must fail
        const callRes = await clientMissing.callTool({
          name: "query_sql",
          arguments: { sql: "SELECT 1" },
        });
        expect(callRes.isError).toBe(true);
      } finally {
        await closeMissing();
      }
    });

    it("immediately revokes query_sql when owner access on any resource is lowered", async () => {
      // Verify initially allowed
      const res1 = await callTool(tokenLowerable.secret, "query_sql", {
        sql: "SELECT 1 AS num",
      });
      expect(res1.isError).toBe(false);

      // Lower owner's activity access to 'none'
      await withActor(db.pool("ytw_web"), person(admin.username), async (tx) => {
        await setUserPermission(tx, {
          actingUserId: admin.id,
          userId: tokenLowerable.owner.id,
          resource: "activity",
          level: "none",
        });
      });

      // Subsequent call must be refused immediately!
      const res2 = await callTool(tokenLowerable.secret, "query_sql", {
        sql: "SELECT 1 AS num",
      });
      expect(res2.isError).toBe(true);

      // Restore owner permission
      await withActor(db.pool("ytw_web"), person(admin.username), async (tx) => {
        await setUserPermission(tx, {
          actingUserId: admin.id,
          userId: tokenLowerable.owner.id,
          resource: "activity",
          level: "read",
        });
      });
    });

    it("runs valid SELECT queries with columns and rows", async () => {
      const res = await callTool(tokenAllRead.secret, "query_sql", {
        sql: "SELECT id, title FROM ideas WHERE id = '" + seededIdeaId + "'",
      });
      expect(res.isError).toBe(false);
      const data = res.json<{
        columns: string[];
        rowCount: number;
        truncated: boolean;
        rows: { id: string; title: string }[];
      }>();
      expect(data.columns).toEqual(["id", "title"]);
      expect(data.rowCount).toBe(1);
      expect(data.truncated).toBe(false);
      expect(data.rows[0]?.id).toBe(seededIdeaId);
      expect(data.rows[0]?.title).toBe("Seed Idea for Reading");
    });

    it("caps rows at 500 with truncated: true", async () => {
      const res = await callTool(tokenAllRead.secret, "query_sql", {
        sql: "SELECT generate_series(1, 750) AS n",
      });
      expect(res.isError).toBe(false);
      const data = res.json<{
        rowCount: number;
        truncated: boolean;
        rows: { n: number }[];
      }>();
      expect(data.rowCount).toBe(500);
      expect(data.truncated).toBe(true);
      expect(data.rows).toHaveLength(500);
      expect(data.rows[0]?.n).toBe(1);
      expect(data.rows[499]?.n).toBe(500);
    });

    it("rejects multi-statement queries", async () => {
      const res = await callTool(tokenAllRead.secret, "query_sql", {
        sql: "SELECT 1; SELECT 2;",
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("multi-statement queries are not allowed");
    });

    it("rejects writes and data mutations", async () => {
      // INSERT attempt
      const insertRes = await callTool(tokenAllRead.secret, "query_sql", {
        sql: "INSERT INTO ideas (title) VALUES ('Should Fail')",
      });
      expect(insertRes.isError).toBe(true);
      expect(insertRes.text).toMatch(
        /the database refused this operation|read-only|permission denied/i,
      );

      // UPDATE attempt
      const updateRes = await callTool(tokenAllRead.secret, "query_sql", {
        sql: "UPDATE ideas SET title = 'Hacked' WHERE id = '" + seededIdeaId + "'",
      });
      expect(updateRes.isError).toBe(true);
      expect(updateRes.text).toMatch(
        /the database refused this operation|read-only|permission denied/i,
      );

      // DROP attempt
      const dropRes = await callTool(tokenAllRead.secret, "query_sql", {
        sql: "DROP TABLE ideas",
      });
      expect(dropRes.isError).toBe(true);
      expect(dropRes.text).toMatch(
        /the database refused this operation|read-only|permission denied/i,
      );
    });

    it("blocks access to private credentials and sessions tables", async () => {
      // api_tokens
      const tokensRes = await callTool(tokenAllRead.secret, "query_sql", {
        sql: "SELECT * FROM ytw_private.api_tokens",
      });
      expect(tokensRes.isError).toBe(true);
      expect(tokensRes.text).toMatch(/the database refused this operation|permission denied/i);

      // web_sessions
      const sessionsRes = await callTool(tokenAllRead.secret, "query_sql", {
        sql: "SELECT * FROM ytw_private.web_sessions",
      });
      expect(sessionsRes.isError).toBe(true);
      expect(sessionsRes.text).toMatch(/the database refused this operation|permission denied/i);
    });

    it("blocks administrative and unsafe functions (pg_read_file, COPY PROGRAM, SET ROLE, lo_import, dblink)", async () => {
      // pg_read_file
      const readFileRes = await callTool(tokenAllRead.secret, "query_sql", {
        sql: "SELECT pg_read_file('postgresql.conf')",
      });
      expect(readFileRes.isError).toBe(true);
      expect(readFileRes.text).toMatch(
        /the database refused this operation|permission denied|must be a superuser/i,
      );

      // COPY PROGRAM
      const copyRes = await callTool(tokenAllRead.secret, "query_sql", {
        sql: "COPY (SELECT 1) TO PROGRAM 'echo evil'",
      });
      expect(copyRes.isError).toBe(true);
      expect(copyRes.text).toMatch(
        /the database refused this operation|permission denied|read-only/i,
      );

      // SET ROLE
      const setRoleRes = await callTool(tokenAllRead.secret, "query_sql", {
        sql: "SET ROLE postgres",
      });
      expect(setRoleRes.isError).toBe(true);
      expect(setRoleRes.text).toMatch(
        /the database refused this operation|permission denied|cannot set transaction/i,
      );

      // lo_import
      const loRes = await callTool(tokenAllRead.secret, "query_sql", {
        sql: "SELECT lo_import('/etc/passwd')",
      });
      expect(loRes.isError).toBe(true);
      expect(loRes.text).toMatch(
        /the database refused this operation|permission denied|must be a superuser/i,
      );
    });

    it("enforces 10-second statement timeout", async () => {
      const timeoutRes = await callTool(tokenAllRead.secret, "query_sql", {
        sql: "SELECT pg_sleep(11)",
      });
      expect(timeoutRes.isError).toBe(true);
      expect(timeoutRes.text).toMatch(/took too long and was cancelled|statement timeout/i);
    }, 15_000);
  });
});
