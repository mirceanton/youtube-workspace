import { createIdea, registerVideo, saveScriptVersion, withActor, type Actor } from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { randomUUID } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
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
  return JSON.parse(
    inflateRawSync(Buffer.from(cursor.slice(3), "base64url")).toString("utf8"),
  ) as Record<string, unknown>;
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
    expect(Object.keys(cursorPayload).toSorted()).toEqual(["scan", "snapshot", "through"]);
    expect(cursorPayload.snapshot).toMatch(/^\d+:\d+:/);
    expect(cursorPayload.through).toBeNull();
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
    expect(Object.keys(pollCursor).toSorted()).toEqual(["scan", "snapshot", "through"]);
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
    expect(Object.keys(hiddenOnlyCursor).toSorted()).toEqual(["scan", "snapshot", "through"]);
    expect(JSON.stringify(hiddenOnlyCursor)).not.toContain("entityType");
    expect(JSON.stringify(hiddenOnlyCursor)).not.toContain("videos");
  });

  it("rejects malformed and modified snapshot cursors", async () => {
    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/activity/changes",
      headers: { "x-test-user": notesOnly.username },
    });
    expect(bootstrap.statusCode).toBe(200);
    const cursor = bootstrap.json().cursor as string;
    const payload = decodePollCursor(cursor);
    const alteredPayload = { ...payload, entityType: "videos" };
    const alteredCursor =
      "v3_" + deflateRawSync(Buffer.from(JSON.stringify(alteredPayload))).toString("base64url");
    const malformedCursor = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");

    for (const invalidCursor of ["v3_not-a-snapshot", alteredCursor, malformedCursor]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/activity/changes?since=" + encodeURIComponent(invalidCursor),
        headers: { "x-test-user": notesOnly.username },
      });
      expect(response.statusCode).toBe(400);
    }
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
      snapshot: expect.stringMatching(/^\d+:\d+:/),
      through: null,
      scan: null,
    });

    const firstTimestamp = new Date(Date.now() - 1_000).toISOString();
    const entityId = randomUUID();
    await db.admin.query(
      `INSERT INTO public.events (
         created_at, actor, actor_type, action, entity_type, entity_id, payload
       )
       SELECT $1::timestamptz + i * interval '1 millisecond',
              $2, 'human', 'insert',
              CASE WHEN i = 249 THEN 'video' ELSE 'note' END,
              $3::uuid,
              CASE WHEN i = 249 THEN '{"title":"Hidden video event"}'::jsonb ELSE '{}'::jsonb END
         FROM generate_series(0, 251) AS i`,
      [firstTimestamp, owner.username, entityId],
    );

    const deniedPoll = await app.inject({
      method: "GET",
      url: "/api/activity/changes?since=" + encodeURIComponent(cursor),
      headers: { "x-test-user": experimentsOnly.username },
    });
    expect(deniedPoll.statusCode).toBe(200);
    expect(deniedPoll.json().changed_resources).toEqual([]);
    expect(deniedPoll.json().has_more).toBe(false);

    const firstPage = await app.inject({
      method: "GET",
      url: `/api/activity/changes?since=${encodeURIComponent(cursor)}`,
      headers: { "x-test-user": notesOnly.username },
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().has_more).toBe(true);
    expect(firstPage.json().changed_resources).toEqual(["notes"]);
    const pagePayload = decodePollCursor(firstPage.json().cursor as string);
    expect(Object.keys(pagePayload).toSorted()).toEqual(["scan", "snapshot", "through"]);
    expect(pagePayload.through).toMatch(/^\d+:\d+:/);
    expect(pagePayload.scan).toEqual({
      createdAt: expect.any(String),
      id: expect.any(String),
    });
    expect(Object.keys(pagePayload.scan as Record<string, unknown>).toSorted()).toEqual([
      "createdAt",
      "id",
    ]);
    expect(JSON.stringify(pagePayload)).not.toContain("entityType");
    expect(JSON.stringify(pagePayload)).not.toContain("Hidden video event");
    const deniedVideo = await db.admin.query<{ id: string }>(
      `SELECT id::text AS id
         FROM public.events
        WHERE entity_type = 'video' AND entity_id = $1::uuid`,
      [entityId],
    );
    expect((pagePayload.scan as { id: string }).id).not.toBe(deniedVideo.rows[0]?.id);

    const delayedEntityId = randomUUID();
    await db.admin.query(
      `INSERT INTO public.events (
         created_at, actor, actor_type, action, entity_type, entity_id, payload
       )
       VALUES (
         $1::timestamptz - interval '100 milliseconds', $2, 'human', 'insert',
         'note', $3::uuid, '{}'::jsonb
       )`,
      [firstTimestamp, owner.username, delayedEntityId],
    );

    const lastPage = await app.inject({
      method: "GET",
      url: `/api/activity/changes?since=${encodeURIComponent(firstPage.json().cursor)}`,
      headers: { "x-test-user": notesOnly.username },
    });
    expect(lastPage.statusCode).toBe(200);
    expect(lastPage.json().changed_resources).toEqual(["notes"]);
    expect(lastPage.json().has_more).toBe(false);

    const nextPoll = await app.inject({
      method: "GET",
      url: "/api/activity/changes?since=" + encodeURIComponent(lastPage.json().cursor),
      headers: { "x-test-user": notesOnly.username },
    });
    expect(nextPoll.statusCode).toBe(200);
    expect(nextPoll.json().changed_resources).toEqual(["notes"]);
    expect(nextPoll.json().has_more).toBe(false);
  });

  it("finds a six-minute-backdated event after its transaction commits", async () => {
    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/activity/changes",
      headers: { "x-test-user": overlapReader.username },
    });
    expect(bootstrap.statusCode).toBe(200);

    const heldClient = await db.admin.connect();
    let transactionOpen = false;
    const lateEventId = randomUUID();
    try {
      await heldClient.query("BEGIN");
      transactionOpen = true;
      const lateEvent = await heldClient.query<{
        id: string;
        transaction_xid: string;
        created_at: Date;
      }>(
        `INSERT INTO public.events (
           created_at, actor, actor_type, action, entity_type, entity_id, payload
         )
         VALUES (
           clock_timestamp() - interval '6 minutes', $1, 'human', 'insert',
           'experiment', $2::uuid, '{}'::jsonb
         )
         RETURNING id::text AS id, transaction_xid::text AS transaction_xid, created_at`,
        [owner.username, lateEventId],
      );
      expect(lateEvent.rows[0]?.transaction_xid).not.toBe("2");

      const newerVideo = await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
        registerVideo(tx, {
          youtubeId: "T47LateV001",
          title: "Newer committed event",
          publishedAt: new Date().toISOString(),
        }),
      );

      const newerPoll = await app.inject({
        method: "GET",
        url: "/api/activity/changes?since=" + encodeURIComponent(bootstrap.json().cursor),
        headers: { "x-test-user": overlapReader.username },
      });
      expect(newerPoll.statusCode).toBe(200);
      expect(newerPoll.json().changed_resources).toEqual(["videos"]);

      await heldClient.query("COMMIT");
      transactionOpen = false;
      const timestampOrder = await db.pool("ytw_web").query<{
        late_event_is_older: boolean;
        late_event_is_over_five_minutes_old: boolean;
      }>(
        `SELECT late_event.created_at < newer_event.created_at AS late_event_is_older,
                late_event.created_at < clock_timestamp() - interval '5 minutes' AS late_event_is_over_five_minutes_old
           FROM public.events AS late_event
           JOIN public.events AS newer_event ON newer_event.entity_id = $2::uuid
          WHERE late_event.id = $1::uuid`,
        [lateEvent.rows[0]!.id, newerVideo.id],
      );
      expect(timestampOrder.rows[0]?.late_event_is_older).toBe(true);
      expect(timestampOrder.rows[0]?.late_event_is_over_five_minutes_old).toBe(true);

      const latePoll = await app.inject({
        method: "GET",
        url: "/api/activity/changes?since=" + encodeURIComponent(newerPoll.json().cursor),
        headers: { "x-test-user": overlapReader.username },
      });
      expect(latePoll.statusCode).toBe(200);
      expect(latePoll.json().changed_resources).toEqual(["experiments"]);
      expect(new Set(latePoll.json().changed_resources).size).toBe(
        latePoll.json().changed_resources.length,
      );
      expect(JSON.stringify(decodePollCursor(latePoll.json().cursor))).not.toContain("entityType");

      const drainedPoll = await app.inject({
        method: "GET",
        url: "/api/activity/changes?since=" + encodeURIComponent(latePoll.json().cursor),
        headers: { "x-test-user": overlapReader.username },
      });
      expect(drainedPoll.statusCode).toBe(200);
      expect(drainedPoll.json().changed_resources).toEqual([]);
    } finally {
      if (transactionOpen) await heldClient.query("ROLLBACK");
      heldClient.release();
    }
  });
});
