import {
  createExperiment,
  createIdea,
  logMetrics,
  registerVideo,
  updateExperimentStatus,
  withActor,
  type Actor,
} from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dbBackedFeatureCore,
  type FeatureTestCore,
  type FeatureTestUser,
} from "../../../test/helpers/db-backed-feature-core.js";
import { grantFeatureLevels, signInFeatureUser } from "../../../test/helpers/feature-users.js";
import dashboardRoutes from "./index.js";

const acting = (username: string): Actor => ({ name: username, type: "human" });

describe("/api/dashboard (PostgreSQL integration)", () => {
  let db: TestDb;
  let app: FeatureTestCore;
  let owner: FeatureTestUser;
  let ideasOnly: FeatureTestUser;
  let noAccess: FeatureTestUser;
  let ideaId: string;

  beforeAll(async () => {
    db = await createTestDb();
    owner = await signInFeatureUser(db, "t47-dashboard-owner");
    ideasOnly = await signInFeatureUser(db, "t47-dashboard-ideas");
    noAccess = await signInFeatureUser(db, "t47-dashboard-none");
    await grantFeatureLevels(db, owner, ideasOnly, { ideas: "read" });

    const idea = await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
      createIdea(tx, { title: "Dashboard integration idea" }),
    );
    ideaId = idea.id;
    const video = await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
      registerVideo(tx, {
        ideaId,
        youtubeId: "T47Dashbrd1",
        title: "Dashboard integration video",
        publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    );
    await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
      logMetrics(tx, {
        videoId: video.id,
        capturedAt: new Date(Date.now() - 60_000).toISOString(),
        metrics: { views: "1200", impressions: "9000", ctr: "4.2", avgViewDurationS: "154" },
      }),
    );
    const experiment = await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
      createExperiment(tx, {
        videoId: video.id,
        type: "title",
        hypothesis: "The clearer title will get more clicks.",
        variants: [
          { label: "Control", content: "First title", isControl: true },
          { label: "Variant B", content: "Second title" },
        ],
      }),
    );
    await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
      updateExperimentStatus(tx, {
        id: experiment.id,
        expectedVersion: experiment.version,
        newStatus: "running",
      }),
    );

    app = dbBackedFeatureCore(db, [owner, ideasOnly, noAccess]);
    await app.register(dashboardRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("requires some current resource access and returns only readable summary sections", async () => {
    expect((await app.inject({ method: "GET", url: "/api/dashboard" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/dashboard",
          headers: { "x-test-user": noAccess.username },
        })
      ).statusCode,
    ).toBe(403);

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { "x-test-user": ideasOnly.username },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ideas: { total: 1, by_stage: { inbox: 1, shortlisted: 0, published: 0 } },
      running_experiments: null,
      latest_videos: null,
      recent_activity: null,
    });
  });

  it("shows pipeline, a running experiment, published headline metrics and recent activity", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { "x-test-user": owner.username },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ideas: { total: 1, by_stage: { inbox: 1 } },
      running_experiments: [
        {
          video_title: "Dashboard integration video",
          type: "title",
          hypothesis: "The clearer title will get more clicks.",
          variants: [
            { label: "Control", is_control: true },
            { label: "Variant B", is_control: false },
          ],
        },
      ],
      latest_videos: [
        {
          id: expect.any(String),
          title: "Dashboard integration video",
          views: "1200",
          impressions: "9000",
          ctr: "4.2",
          avg_view_duration_s: "154",
        },
      ],
    });
    expect(response.json().recent_activity.length).toBeGreaterThan(0);
    expect(response.json().recent_activity.length).toBeLessThanOrEqual(20);
    expect(
      response
        .json()
        .recent_activity.some((event: { entity_id: string | null }) => event.entity_id === ideaId),
    ).toBe(true);
  });
});
