import { createIdea, registerVideo, saveScriptVersion, withActor, type Actor } from "@ytw/db";
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

describe("/api/activity and the compact change poll (PostgreSQL integration)", () => {
  let db: TestDb;
  let app: FeatureTestCore;
  let owner: FeatureTestUser;
  let activityReader: FeatureTestUser;
  let ideasOnly: FeatureTestUser;
  let resourceReader: FeatureTestUser;
  let ideaId: string;

  beforeAll(async () => {
    db = await createTestDb();
    owner = await signInFeatureUser(db, "t47-activity-owner");
    activityReader = await signInFeatureUser(db, "t47-activity-reader");
    ideasOnly = await signInFeatureUser(db, "t47-activity-ideas");
    resourceReader = await signInFeatureUser(db, "t47-activity-resource-reader");
    await grantFeatureLevels(db, owner, activityReader, { activity: "read" });
    await grantFeatureLevels(db, owner, ideasOnly, { ideas: "read" });
    await grantFeatureLevels(db, owner, resourceReader, { ideas: "read", scripts: "read" });

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

    app = dbBackedFeatureCore(db, [owner, activityReader, ideasOnly, resourceReader]);
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
    const activityBootstrap = await app.inject({
      method: "GET",
      url: "/api/activity/changes",
      headers: { "x-test-user": activityReader.username },
    });
    expect(activityBootstrap.statusCode).toBe(200);
    const activityCursor = activityBootstrap.json().cursor as string;

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
  });
});
