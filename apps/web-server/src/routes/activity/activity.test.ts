import {
  addNote,
  createExperiment,
  createIdea,
  registerVideo,
  saveScriptVersion,
  withActor,
  type Actor,
} from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dbBackedFeatureCore,
  type FeatureTestCore,
  type FeatureTestUser,
} from "../../../test/helpers/db-backed-feature-core.js";
import { grantFeatureLevels, signInFeatureUser } from "../../../test/helpers/feature-users.js";
import activityRoutes from "./index.js";

const acting = (username: string): Actor => ({ name: username, type: "human" });

function decodePollCursor(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe("/api/activity and the compact change poll (PostgreSQL integration)", () => {
  let db: TestDb;
  let app: FeatureTestCore;
  let owner: FeatureTestUser;
  let activityReader: FeatureTestUser;
  let ideasOnly: FeatureTestUser;
  let experimentsOnly: FeatureTestUser;
  let resourceReader: FeatureTestUser;
  let notesOnly: FeatureTestUser;
  let overlapReader: FeatureTestUser;
  let ideaId: string;

  beforeAll(async () => {
    db = await createTestDb();
    owner = await signInFeatureUser(db, "t47-activity-owner");
    activityReader = await signInFeatureUser(db, "t47-activity-reader");
    ideasOnly = await signInFeatureUser(db, "t47-activity-ideas");
    experimentsOnly = await signInFeatureUser(db, "t47-activity-experiments");
    resourceReader = await signInFeatureUser(db, "t47-activity-resource-reader");
    notesOnly = await signInFeatureUser(db, "t47-activity-notes");
    overlapReader = await signInFeatureUser(db, "t47-activity-overlap-reader");
    await grantFeatureLevels(db, owner, activityReader, { activity: "read" });
    await grantFeatureLevels(db, owner, ideasOnly, { ideas: "read" });
    await grantFeatureLevels(db, owner, experimentsOnly, { experiments: "read" });
    await grantFeatureLevels(db, owner, resourceReader, { ideas: "read", scripts: "read" });
    await grantFeatureLevels(db, owner, notesOnly, { notes: "read" });
    await grantFeatureLevels(db, owner, overlapReader, { experiments: "read", videos: "read" });

    const idea = await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
      createIdea(tx, { title: "Activity human and agent fixture" }),
    );
    ideaId = idea.id;
    const agent: Actor = { name: "t47-writing-agent", type: "agent", tokenId: randomUUID() };
    await withActor(db.pool("ytw_mcp"), agent, (tx) =>
      saveScriptVersion(tx, {
        ideaId,
        kind: "script",
        baseVersion: 0,
        bodyMd: "A script created by an agent.",
      }),
    );

    app = dbBackedFeatureCore(db, [
      owner,
      activityReader,
      ideasOnly,
      experimentsOnly,
      resourceReader,
      notesOnly,
      overlapReader,
    ]);
    await app.register(activityRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("keeps the audit feed behind activity Read and serves human and agent actions", async () => {
    const denied = await app.inject({
      method: "GET",
      url: "/api/activity",
      headers: { "x-test-user": ideasOnly.username },
    });
    expect(denied.statusCode).toBe(403);

    const response = await app.inject({
      method: "GET",
      url: "/api/activity?limit=100",
      headers: { "x-test-user": activityReader.username },
    });
    expect(response.statusCode).toBe(200);
    const actors = new Set(
      response.json().events.map((event: { actor_type: string }) => event.actor_type),
    );
    expect(actors).toContain("human");
    expect(actors).toContain("agent");

    const agents = await app.inject({
      method: "GET",
      url: "/api/activity?actor_type=agent&entity_type=script",
      headers: { "x-test-user": activityReader.username },
    });
    expect(agents.statusCode).toBe(200);
    expect(agents.json().events.length).toBeGreaterThan(0);
    expect(
      agents.json().events.every((event: { actor_type: string }) => event.actor_type === "agent"),
    ).toBe(true);
  });

  it("paginates with the database cursor and rejects malformed filters", async () => {
    const first = await app.inject({
      method: "GET",
      url: "/api/activity?limit=1",
      headers: { "x-test-user": activityReader.username },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().events).toHaveLength(1);
    expect(first.json().next_cursor).toEqual(expect.any(String));
    const second = await app.inject({
      method: "GET",
      url: `/api/activity?limit=1&cursor=${encodeURIComponent(first.json().next_cursor)}`,
      headers: { "x-test-user": activityReader.username },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().events[0].id).not.toBe(first.json().events[0].id);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/activity?actor_type=robot",
      headers: { "x-test-user": activityReader.username },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("filters activity by actor and an inclusive start/exclusive end date range", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/activity?actor=${encodeURIComponent(owner.username)}&from=1970-01-01T00%3A00%3A00.000Z&to=2999-01-01T00%3A00%3A00.000Z`,
      headers: { "x-test-user": activityReader.username },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().events.length).toBeGreaterThan(0);
    expect(
      response.json().events.every((event: { actor: string }) => event.actor === owner.username),
    ).toBe(true);
  });

  it("gives readable-resource users cache hints without exposing the activity feed", async () => {
    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/activity/changes",
      headers: { "x-test-user": resourceReader.username },
    });
    expect(bootstrap.statusCode).toBe(200);
    const cursor = bootstrap.json().cursor as string;
    const cursorPayload = decodePollCursor(cursor);
    expect(Object.keys(cursorPayload).toSorted()).toEqual(["scan", "through", "watermark"]);
    expect(JSON.stringify(cursorPayload)).not.toContain("entityType");
    const activityBootstrap = await app.inject({
      method: "GET",
      url: "/api/activity/changes",
      headers: { "x-test-user": activityReader.username },
    });
    expect(activityBootstrap.statusCode).toBe(200);
    const activityCursor = activityBootstrap.json().cursor as string;
    const hiddenOnlyBootstrap = await app.inject({
      method: "GET",
      url: "/api/activity/changes",
      headers: { "x-test-user": experimentsOnly.username },
    });
    expect(hiddenOnlyBootstrap.statusCode).toBe(200);

    const nextIdea = await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
      createIdea(tx, { title: "Poll-only visible idea change" }),
    );
    await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
      saveScriptVersion(tx, {
        ideaId: nextIdea.id,
        kind: "script",
        baseVersion: 0,
        bodyMd: "A readable script update for the poll.",
      }),
    );
    await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
      registerVideo(tx, {
        youtubeId: "T47PollV001",
        title: "No video access",
        publishedAt: new Date().toISOString(),
      }),
    );

    const poll = await app.inject({
      method: "GET",
      url: `/api/activity/changes?since=${encodeURIComponent(cursor)}`,
      headers: { "x-test-user": resourceReader.username },
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().changed_resources.toSorted()).toEqual(["ideas", "scripts"]);
    expect(Object.keys(poll.json()).toSorted()).toEqual([
      "changed_resources",
      "cursor",
      "has_more",
    ]);
    expect(JSON.stringify(poll.json())).not.toContain(owner.username);
    expect(JSON.stringify(poll.json())).not.toContain(nextIdea.id);
    const pollCursor = decodePollCursor(poll.json().cursor as string);
    expect(Object.keys(pollCursor).toSorted()).toEqual(["scan", "through", "watermark"]);
    expect(JSON.stringify(pollCursor)).not.toContain("entityType");
    expect(JSON.stringify(pollCursor)).not.toContain("No video access");

    const activityPoll = await app.inject({
      method: "GET",
      url: `/api/activity/changes?since=${encodeURIComponent(activityCursor)}`,
      headers: { "x-test-user": activityReader.username },
    });
    expect(activityPoll.statusCode).toBe(200);
    expect(activityPoll.json().changed_resources).toEqual(["activity"]);
    expect(Object.keys(activityPoll.json()).toSorted()).toEqual([
      "changed_resources",
      "cursor",
      "has_more",
    ]);
    expect(JSON.stringify(activityPoll.json())).not.toContain(owner.username);
    expect(JSON.stringify(activityPoll.json())).not.toContain(nextIdea.id);

    const hiddenOnlyPoll = await app.inject({
      method: "GET",
      url: `/api/activity/changes?since=${encodeURIComponent(hiddenOnlyBootstrap.json().cursor)}`,
      headers: { "x-test-user": experimentsOnly.username },
    });
    expect(hiddenOnlyPoll.statusCode).toBe(200);
    expect(hiddenOnlyPoll.json().changed_resources).toEqual([]);
    const hiddenOnlyCursor = decodePollCursor(hiddenOnlyPoll.json().cursor as string);
    expect(Object.keys(hiddenOnlyCursor).toSorted()).toEqual(["scan", "through", "watermark"]);
    expect(JSON.stringify(hiddenOnlyCursor)).not.toContain("entityType");
    expect(JSON.stringify(hiddenOnlyCursor)).not.toContain("videos");
  });

  it("keeps row-bearing page cursors limited to timestamp and event id", async () => {
    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/activity/changes",
      headers: { "x-test-user": notesOnly.username },
    });
    expect(bootstrap.statusCode).toBe(200);
    const cursor = bootstrap.json().cursor as string;
    const initialPayload = decodePollCursor(cursor);
    expect(initialPayload).toEqual({
      watermark: expect.any(String),
      through: null,
      scan: null,
    });

    const recent = await db.pool("ytw_web").query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM public.events
        WHERE created_at >= ($1::timestamptz - interval '5 minutes')`,
      [initialPayload.watermark],
    );
    const earlierEvents = Number(recent.rows[0]!.count);
    const notesBeforeHiddenEvent = 250 - earlierEvents - 1;
    expect(notesBeforeHiddenEvent).toBeGreaterThan(0);
    await withActor(db.pool("ytw_web"), acting(owner.username), async (tx) => {
      for (let index = 0; index < notesBeforeHiddenEvent; index += 1) {
        await addNote(tx, {
          entityType: "idea",
          entityId: ideaId,
          bodyMd: `Visible note ${index}.`,
        });
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
      registerVideo(tx, {
        youtubeId: "T47HideV001",
        title: "Hidden video event",
        publishedAt: new Date().toISOString(),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
      addNote(tx, { entityType: "idea", entityId: ideaId, bodyMd: "Last page fixture note." }),
    );

    const firstPage = await app.inject({
      method: "GET",
      url: `/api/activity/changes?since=${encodeURIComponent(cursor)}`,
      headers: { "x-test-user": notesOnly.username },
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().has_more).toBe(true);
    expect(firstPage.json().changed_resources).toEqual(["notes"]);
    const pagePayload = decodePollCursor(firstPage.json().cursor as string);
    expect(Object.keys(pagePayload).toSorted()).toEqual(["scan", "through", "watermark"]);
    expect(pagePayload.scan).not.toBeNull();
    expect(Object.keys(pagePayload.scan as Record<string, unknown>).toSorted()).toEqual([
      "createdAt",
      "id",
    ]);
    expect(JSON.stringify(pagePayload)).not.toContain("entityType");
    expect(JSON.stringify(pagePayload)).not.toContain("Hidden video event");

    const lastPage = await app.inject({
      method: "GET",
      url: `/api/activity/changes?since=${encodeURIComponent(firstPage.json().cursor)}`,
      headers: { "x-test-user": notesOnly.username },
    });
    expect(lastPage.statusCode).toBe(200);
    expect(lastPage.json().changed_resources).toEqual(["notes"]);
    expect(lastPage.json().has_more).toBe(false);
  });

  it("finds a late transaction with an older event time and deduplicates resource hints", async () => {
    const experimentVideo = await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
      registerVideo(tx, {
        youtubeId: "T47LateBas1",
        title: "Commit ordering fixture",
        publishedAt: new Date().toISOString(),
      }),
    );
    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/activity/changes",
      headers: { "x-test-user": overlapReader.username },
    });
    expect(bootstrap.statusCode).toBe(200);

    let markStarted!: () => void;
    let releaseLateTransaction!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const holdTransaction = new Promise<void>((resolve) => {
      releaseLateTransaction = resolve;
    });
    let lateExperimentId = "";
    const lateTransaction = withActor(db.pool("ytw_web"), acting(owner.username), async (tx) => {
      const experiment = await createExperiment(tx, {
        videoId: experimentVideo.id,
        type: "title",
        hypothesis: "A held transaction gets polled after a newer event.",
        variants: [
          { label: "Control", content: "Original title", isControl: true },
          { label: "Variant", content: "New title" },
        ],
      });
      lateExperimentId = experiment.id;
      markStarted();
      await holdTransaction;
    }).catch((error: unknown) => {
      markStarted();
      throw error;
    });

    try {
      await started;
      // Give PostgreSQL a later transaction-start timestamp for the event we observe first.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const newerVideo = await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
        registerVideo(tx, {
          youtubeId: "T47LateV001",
          title: "Newer committed event",
          publishedAt: new Date().toISOString(),
        }),
      );

      const newerPoll = await app.inject({
        method: "GET",
        url: `/api/activity/changes?since=${encodeURIComponent(bootstrap.json().cursor)}`,
        headers: { "x-test-user": overlapReader.username },
      });
      expect(newerPoll.statusCode).toBe(200);
      expect(newerPoll.json().changed_resources).toEqual(["videos"]);

      releaseLateTransaction();
      await lateTransaction;
      const timestampOrder = await db.pool("ytw_web").query<{ late_event_is_older: boolean }>(
        `SELECT late_event.created_at < newer_event.created_at AS late_event_is_older
           FROM public.events AS late_event
           JOIN public.events AS newer_event ON newer_event.entity_id = $2::uuid
          WHERE late_event.entity_type = 'experiment'
            AND late_event.entity_id = $1::uuid
            AND newer_event.entity_type = 'video'
          LIMIT 1`,
        [lateExperimentId, newerVideo.id],
      );
      expect(timestampOrder.rows[0]?.late_event_is_older).toBe(true);

      const latePoll = await app.inject({
        method: "GET",
        url: `/api/activity/changes?since=${encodeURIComponent(newerPoll.json().cursor)}`,
        headers: { "x-test-user": overlapReader.username },
      });
      expect(latePoll.statusCode).toBe(200);
      expect(latePoll.json().changed_resources.toSorted()).toEqual(["experiments", "videos"]);
      expect(new Set(latePoll.json().changed_resources).size).toBe(
        latePoll.json().changed_resources.length,
      );
      expect(JSON.stringify(decodePollCursor(latePoll.json().cursor))).not.toContain("entityType");
    } finally {
      releaseLateTransaction();
      await lateTransaction;
    }
  });
});
