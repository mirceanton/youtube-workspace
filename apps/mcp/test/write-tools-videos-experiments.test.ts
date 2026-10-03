import { setUserPermission, updateExperimentStatus, withActor } from "@ytw/db";
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

describe("MCP write tools: videos and experiments (T32)", () => {
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
      videos: "write",
      experiments: "write",
    });

    tokenReadOnly = await createTestToken(db, {
      ideas: "read",
      videos: "read",
      experiments: "read",
    });

    tokenNone = await createTestToken(db, {
      ideas: "read", // Owner needs some access to create tokens
      videos: "none",
      experiments: "none",
    });

    tokenLowerable = await createTestToken(db, {
      videos: "write",
      experiments: "write",
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

  describe("videos write tools", () => {
    let createdVideoId: string;
    let createdIdeaId: string;

    beforeAll(async () => {
      // Create an idea to link videos to
      const res = await callTool(tokenWriteAll.secret, "create_idea", {
        title: "Video Source Idea",
      });
      const idea = res.json<{ id: string }>();
      createdIdeaId = idea.id;
    });

    it("enforces permission matrix on register_video (None -> denied, Read -> denied, Write -> ok)", async () => {
      // 1. None
      const resNone = await callTool(tokenNone.secret, "register_video", {
        youtube_id: "dQw4w9WgXcQ",
        title: "Never Gonna Give You Up",
      });
      expect(resNone.isError).toBe(true);
      expect(resNone.text).toContain("write access on videos");

      // 2. Read
      const resRead = await callTool(tokenReadOnly.secret, "register_video", {
        youtube_id: "dQw4w9WgXcQ",
        title: "Never Gonna Give You Up",
      });
      expect(resRead.isError).toBe(true);
      expect(resRead.text).toContain("write access on videos");

      // 3. Write
      const resWrite = await callTool(tokenWriteAll.secret, "register_video", {
        idea_id: createdIdeaId,
        youtube_id: "dQw4w9WgXcQ",
        title: "Rick Astley - Never Gonna Give You Up",
        published_at: "2009-10-25T06:57:33Z",
        thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
      });
      expect(resWrite.isError).toBe(false);
      const video = resWrite.json<{
        id: string;
        youtubeId: string;
        title: string;
        ideaId: string;
        thumbnailUrl: string;
        version: number;
      }>();
      expect(video.youtubeId).toBe("dQw4w9WgXcQ");
      expect(video.title).toBe("Rick Astley - Never Gonna Give You Up");
      expect(video.ideaId).toBe(createdIdeaId);
      expect(video.thumbnailUrl).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg");
      expect(video.version).toBe(1);

      createdVideoId = video.id;

      // Verify audit
      const audits = await getAuditEvents("register_video");
      expect(audits.length).toBeGreaterThanOrEqual(3);
      expect(audits[0]?.payload.outcome).toBe("ok");
      expect(audits[0]?.actor).toBe(tokenWriteAll.token.name);
    });

    it("denies register_video immediately when owner access is lowered", async () => {
      // Verify initial write works
      const res1 = await callTool(tokenLowerable.secret, "register_video", {
        youtube_id: "lowerable01",
        title: "Before Lowering",
      });
      expect(res1.isError).toBe(false);

      // Lower owner's videos access to 'read'
      await withActor(db.pool("ytw_web"), person(admin.username), async (tx) => {
        await setUserPermission(tx, {
          actingUserId: admin.id,
          userId: tokenLowerable.owner.id,
          resource: "videos",
          level: "read",
        });
      });

      // Subsequent call must be denied immediately
      const res2 = await callTool(tokenLowerable.secret, "register_video", {
        youtube_id: "lowerable02",
        title: "After Lowering",
      });
      expect(res2.isError).toBe(true);
      expect(res2.text).toContain("write access on videos");

      // Restore
      await withActor(db.pool("ytw_web"), person(admin.username), async (tx) => {
        await setUserPermission(tx, {
          actingUserId: admin.id,
          userId: tokenLowerable.owner.id,
          resource: "videos",
          level: "write",
        });
      });
    });

    it("rejects duplicate youtube_id with clear error", async () => {
      const res = await callTool(tokenWriteAll.secret, "register_video", {
        youtube_id: "dQw4w9WgXcQ", // Already registered above
        title: "Duplicate Registration",
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("already registered");
    });

    it("rejects non-existent idea_id with NotFoundError", async () => {
      const res = await callTool(tokenWriteAll.secret, "register_video", {
        idea_id: "00000000-0000-4000-8000-000000000000",
        youtube_id: "uniqueVid01",
        title: "Non-existent Idea",
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("does not exist");
    });

    it("enforces permission matrix on log_metrics (None -> denied, Read -> denied, Write -> ok)", async () => {
      const capturedAt = "2026-10-01T12:00:00Z";

      // 1. None
      const resNone = await callTool(tokenNone.secret, "log_metrics", {
        video_id: createdVideoId,
        captured_at: capturedAt,
        metrics: { views: 100 },
      });
      expect(resNone.isError).toBe(true);
      expect(resNone.text).toContain("write access on videos");

      // 2. Read
      const resRead = await callTool(tokenReadOnly.secret, "log_metrics", {
        video_id: createdVideoId,
        captured_at: capturedAt,
        metrics: { views: 100 },
      });
      expect(resRead.isError).toBe(true);
      expect(resRead.text).toContain("write access on videos");
    });

    it("logs metrics and surfaces idempotency (created: true then created: false)", async () => {
      const capturedAt = "2026-10-02T15:30:00Z";
      const metricsPayload = {
        views: 125000,
        impressions: 1500000,
        ctr: "8.33",
        avg_view_duration_s: 245,
        avg_view_pct: "55.4",
        watch_time_min: 510416,
        subs_gained: 1420,
        retention: [
          { t: 0, pct: 100 },
          { t: 30, pct: 75 },
          { t: 120, pct: 50 },
        ],
      };

      // Initial call -> created: true
      const res1 = await callTool(tokenWriteAll.secret, "log_metrics", {
        video_id: createdVideoId,
        captured_at: capturedAt,
        metrics: metricsPayload,
      });
      expect(res1.isError).toBe(false);
      const data1 = res1.json<{
        created: boolean;
        snapshot: {
          videoId: string;
          views: string;
          impressions: string;
          ctr: string;
          subsGained: number;
          retention: { t: number; pct: number }[];
        };
      }>();
      expect(data1.created).toBe(true);
      expect(data1.snapshot.videoId).toBe(createdVideoId);
      expect(data1.snapshot.views).toBe("125000");
      expect(data1.snapshot.impressions).toBe("1500000");
      expect(data1.snapshot.ctr).toBe("8.33");
      expect(data1.snapshot.subsGained).toBe(1420);
      expect(data1.snapshot.retention).toHaveLength(3);

      // Repeated identical call -> created: false (idempotent, unchanged snapshot)
      const res2 = await callTool(tokenWriteAll.secret, "log_metrics", {
        video_id: createdVideoId,
        captured_at: capturedAt,
        metrics: metricsPayload,
      });
      expect(res2.isError).toBe(false);
      const data2 = res2.json<{ created: boolean; snapshot: { views: string } }>();
      expect(data2.created).toBe(false);
      expect(data2.snapshot.views).toBe("125000");

      // Repeated call with CONFLICTING numbers for the same captured_at -> must fail
      const conflictRes = await callTool(tokenWriteAll.secret, "log_metrics", {
        video_id: createdVideoId,
        captured_at: capturedAt,
        metrics: {
          views: 999999, // Conflicting views!
        },
      });
      expect(conflictRes.isError).toBe(true);
      expect(conflictRes.text).toContain("already has a snapshot");
    });
  });

  describe("experiments write tools", () => {
    let videoId: string;
    let experimentId: string;
    let controlVariantId: string;
    let treatmentVariantId: string;
    let experimentVersion: number;

    beforeAll(async () => {
      // Register a video for experiment tests
      const res = await callTool(tokenWriteAll.secret, "register_video", {
        youtube_id: "expVideo001",
        title: "Video for Experiments",
      });
      const video = res.json<{ id: string }>();
      videoId = video.id;
    });

    it("enforces permission matrix on create_experiment (None -> denied, Read -> denied, Write -> ok)", async () => {
      const expPayload = {
        video_id: videoId,
        type: "title",
        hypothesis: "A punchy title will increase CTR by 2%",
        variants: [
          { label: "Control", content: "Original Video Title", is_control: true },
          { label: "Variant B", content: "Shocking Video Title!", is_control: false },
        ],
      };

      // 1. None
      const resNone = await callTool(tokenNone.secret, "create_experiment", expPayload);
      expect(resNone.isError).toBe(true);
      expect(resNone.text).toContain("write access on experiments");

      // 2. Read
      const resRead = await callTool(tokenReadOnly.secret, "create_experiment", expPayload);
      expect(resRead.isError).toBe(true);
      expect(resRead.text).toContain("write access on experiments");

      // 3. Write
      const resWrite = await callTool(tokenWriteAll.secret, "create_experiment", expPayload);
      expect(resWrite.isError).toBe(false);
      const exp = resWrite.json<{
        id: string;
        videoId: string;
        type: string;
        status: string;
        version: number;
        variants: { id: string; label: string; isControl: boolean }[];
      }>();
      expect(exp.videoId).toBe(videoId);
      expect(exp.type).toBe("title");
      expect(exp.status).toBe("planned");
      expect(exp.version).toBe(1);
      expect(exp.variants).toHaveLength(2);

      const control = exp.variants.find((v) => v.isControl);
      const treatment = exp.variants.find((v) => !v.isControl);
      expect(control).toBeDefined();
      expect(treatment).toBeDefined();

      experimentId = exp.id;
      controlVariantId = control!.id;
      treatmentVariantId = treatment!.id;
      experimentVersion = exp.version;

      // Verify audit
      const audits = await getAuditEvents("create_experiment");
      expect(audits.length).toBeGreaterThanOrEqual(3);
      expect(audits[0]?.payload.outcome).toBe("ok");
    });

    it("validates control variant requirement on create_experiment", async () => {
      // 0 controls -> must fail
      const noControlRes = await callTool(tokenWriteAll.secret, "create_experiment", {
        video_id: videoId,
        type: "thumbnail",
        variants: [
          { label: "V1", content: "thumb1.jpg", is_control: false },
          { label: "V2", content: "thumb2.jpg", is_control: false },
        ],
      });
      expect(noControlRes.isError).toBe(true);
      expect(noControlRes.text).toContain("exactly one variant must be the control");

      // 2 controls -> must fail
      const multiControlRes = await callTool(tokenWriteAll.secret, "create_experiment", {
        video_id: videoId,
        type: "thumbnail",
        variants: [
          { label: "V1", content: "thumb1.jpg", is_control: true },
          { label: "V2", content: "thumb2.jpg", is_control: true },
        ],
      });
      expect(multiControlRes.isError).toBe(true);
      expect(multiControlRes.text).toContain("exactly one variant must be the control");
    });

    it("records variant stats with record_variant_stats", async () => {
      // Permission check: None -> denied
      const resNone = await callTool(tokenNone.secret, "record_variant_stats", {
        variant_id: treatmentVariantId,
        impressions: 1000,
        ctr: "5.5",
      });
      expect(resNone.isError).toBe(true);
      expect(resNone.text).toContain("write access on experiments");

      // Write on control
      const resControl = await callTool(tokenWriteAll.secret, "record_variant_stats", {
        variant_id: controlVariantId,
        impressions: 5000,
        ctr: "4.2",
      });
      expect(resControl.isError).toBe(false);
      const cStats = resControl.json<{ impressions: string; ctr: string }>();
      expect(cStats.impressions).toBe("5000");
      expect(cStats.ctr).toBe("4.2");

      // Write on treatment
      const resTreatment = await callTool(tokenWriteAll.secret, "record_variant_stats", {
        variant_id: treatmentVariantId,
        impressions: 5200,
        ctr: "6.8",
      });
      expect(resTreatment.isError).toBe(false);
      const tStats = resTreatment.json<{ impressions: string; ctr: string }>();
      expect(tStats.impressions).toBe("5200");
      expect(tStats.ctr).toBe("6.8");

      // Audit row check
      const audits = await getAuditEvents("record_variant_stats");
      expect(audits.length).toBeGreaterThanOrEqual(1);
      expect(audits[0]?.payload.outcome).toBe("ok");
    });

    it("concludes a running experiment, rejects planned, and enforces concurrency", async () => {
      // Attempting to conclude a planned experiment must fail (must be running)
      const plannedConcludeRes = await callTool(tokenWriteAll.secret, "conclude_experiment", {
        id: experimentId,
        winner_variant_id: treatmentVariantId,
        conclusion: "Variant B won decisively.",
        expected_version: experimentVersion,
      });
      expect(plannedConcludeRes.isError).toBe(true);
      expect(plannedConcludeRes.text).toContain('cannot move to "concluded"');

      // Start the experiment (move from planned -> running) via database helper
      const runningExp = await withActor(db.pool("ytw_web"), person(admin.username), async (tx) => {
        return updateExperimentStatus(tx, {
          id: experimentId,
          expectedVersion: experimentVersion,
          newStatus: "running",
        });
      });
      expect(runningExp.status).toBe("running");
      experimentVersion = runningExp.version;

      // Permission check: None -> denied
      const resNone = await callTool(tokenNone.secret, "conclude_experiment", {
        id: experimentId,
        winner_variant_id: treatmentVariantId,
        conclusion: "Should be denied",
        expected_version: experimentVersion,
      });
      expect(resNone.isError).toBe(true);
      expect(resNone.text).toContain("write access on experiments");

      // Version conflict test (passing stale version)
      const conflictRes = await callTool(tokenWriteAll.secret, "conclude_experiment", {
        id: experimentId,
        winner_variant_id: treatmentVariantId,
        conclusion: "Stale version test",
        expected_version: 1, // Stale! Current version is at least 2
      });
      expect(conflictRes.isError).toBe(true);
      expect(conflictRes.text).toContain("has changed since you read it");

      // Foreign winner variant id -> must fail
      const foreignWinnerRes = await callTool(tokenWriteAll.secret, "conclude_experiment", {
        id: experimentId,
        winner_variant_id: "00000000-0000-4000-8000-000000000000",
        conclusion: "Foreign winner should fail",
        expected_version: experimentVersion,
      });
      expect(foreignWinnerRes.isError).toBe(true);
      expect(foreignWinnerRes.text).toContain("winner_variant_id");

      // Successful conclusion
      const concludeRes = await callTool(tokenWriteAll.secret, "conclude_experiment", {
        id: experimentId,
        winner_variant_id: treatmentVariantId,
        conclusion: "Variant B title outperformed control with 6.8% vs 4.2% CTR.",
        expected_version: experimentVersion,
      });
      expect(concludeRes.isError).toBe(false);
      const concluded = concludeRes.json<{
        id: string;
        status: string;
        winnerVariantId: string;
        conclusion: string;
      }>();
      expect(concluded.status).toBe("concluded");
      expect(concluded.winnerVariantId).toBe(treatmentVariantId);
      expect(concluded.conclusion).toContain("Variant B title outperformed");

      // Concluding twice must fail
      const doubleConcludeRes = await callTool(tokenWriteAll.secret, "conclude_experiment", {
        id: experimentId,
        winner_variant_id: treatmentVariantId,
        conclusion: "Second conclusion attempt",
      });
      expect(doubleConcludeRes.isError).toBe(true);
      expect(doubleConcludeRes.text).toContain("cannot be concluded again");

      // Audit row check
      const audits = await getAuditEvents("conclude_experiment");
      expect(audits.length).toBeGreaterThanOrEqual(1);
    });
  });
});
