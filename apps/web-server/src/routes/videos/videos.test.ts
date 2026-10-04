import {
  createIdea,
  getUserAccess,
  logMetrics,
  registerVideo,
  setUserPermission,
  upsertUserOnLogin,
  withActor,
  type ActorTx,
  type Queryable,
} from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { authorize, DENIAL_HTTP_STATUS, type UserPrincipal } from "@ytw/policy";
import type { WebAuth } from "../../core/types.js";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type preHandlerHookHandler,
} from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import videosRoutes from "./index.js";

type TestUser = { id: string; username: string };
type TestCore = FastifyInstance & {
  requireLevel(resource: "videos", level: "read" | "write"): preHandlerHookHandler;
  db: {
    pool: Queryable;
    withActor<T>(request: FastifyRequest, fn: (tx: ActorTx) => Promise<T>): Promise<T>;
  };
};

const ISSUER = "https://videos-api.test/issuer";
const UNKNOWN_ID = "0199c2a4-7b1e-7c3a-9d2f-000000000099";
const actor = (username: string) => ({ name: username, type: "human" as const });

describe("/api/videos (PostgreSQL integration)", () => {
  let db: TestDb;
  let app: TestCore;
  let owner: TestUser;
  let none: TestUser;
  let reader: TestUser;
  let writer: TestUser;
  let ideaId: string;
  let videoId: string;

  beforeAll(async () => {
    db = await createTestDb();
    owner = await signIn("videos-owner");
    none = await signIn("videos-none");
    reader = await signIn("videos-reader");
    writer = await signIn("videos-writer");
    await grant(reader, "videos", "read");
    await grant(reader, "ideas", "read");
    await grant(writer, "videos", "write");

    const idea = await withActor(db.pool("ytw_web"), actor(owner.username), (tx) =>
      createIdea(tx, { title: "Videos route idea link" }),
    );
    ideaId = idea.id;
    const video = await withActor(db.pool("ytw_web"), actor(owner.username), (tx) =>
      registerVideo(tx, {
        ideaId,
        youtubeId: "dQw4w9WgXcQ",
        title: "Registered video for API coverage",
        publishedAt: new Date(Date.now() - 86_400_000),
      }),
    );
    videoId = video.id;
    await withActor(db.pool("ytw_web"), actor(owner.username), (tx) =>
      logMetrics(tx, {
        videoId,
        capturedAt: new Date(Date.now() - 60_000),
        metrics: {
          views: 1280,
          ctr: 4.5,
          avgViewDurationS: 132,
          retention: [
            { t: 0, pct: 100 },
            { t: 60, pct: 51 },
          ],
        },
      }),
    );
    app = await makeApp(db, [owner, none, reader, writer]);
    app.register(videosRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  async function signIn(username: string): Promise<TestUser> {
    const user = await withActor(db.pool("ytw_web"), actor(username), (tx) =>
      upsertUserOnLogin(tx, {
        issuer: ISSUER,
        sub: `${username}-${randomUUID()}`,
        username,
      }),
    );
    return { id: user.id, username: user.username };
  }

  async function grant(user: TestUser, resource: "videos" | "ideas", level: "read" | "write") {
    await withActor(db.pool("ytw_web"), actor(owner.username), (tx) =>
      setUserPermission(tx, {
        actingUserId: owner.id,
        userId: user.id,
        resource,
        level,
      }),
    );
  }

  it("enforces current None, Read and Write levels on list, detail and mutation routes", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/api/videos" });
    const denied = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { "x-test-user": none.username },
    });
    const read = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { "x-test-user": reader.username },
    });
    const readDetail = await app.inject({
      method: "GET",
      url: `/api/videos/${videoId}`,
      headers: { "x-test-user": reader.username },
    });
    const readCreate = await app.inject({
      method: "POST",
      url: "/api/videos",
      headers: { "x-test-user": reader.username },
      payload: { youtube_id: "abcdefghijk", title: "Reader cannot create" },
    });
    const readUpdate = await app.inject({
      method: "PATCH",
      url: `/api/videos/${videoId}`,
      headers: { "x-test-user": reader.username },
      payload: { expected_version: 1, title: "Reader cannot update" },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(denied.statusCode).toBe(403);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      videos: [{ id: videoId, latest: { views: "1280", ctr: "4.5" }, vs_median: { views: "0" } }],
    });
    expect(readDetail.statusCode).toBe(200);
    expect(readDetail.json()).toMatchObject({
      video: { id: videoId, idea_id: ideaId },
      idea: { id: ideaId, title: "Videos route idea link" },
      metrics: [
        {
          video_id: videoId,
          retention: [
            { t: 0, pct: 100 },
            { t: 60, pct: 51 },
          ],
        },
      ],
    });
    expect(readCreate.statusCode).toBe(403);
    expect(readUpdate.statusCode).toBe(403);
  });

  it("creates and edits videos through actor-bound functions with optimistic concurrency", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/videos",
      headers: { "x-test-user": writer.username },
      payload: {
        idea_id: ideaId,
        youtube_id: "abcdefghijk",
        title: "Created through route",
        published_at: new Date(Date.now() - 120_000).toISOString(),
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<{ video: { id: string; version: number; created_by: string } }>()
      .video;
    expect(created).toMatchObject({ version: 1, created_by: writer.username });

    const update = await app.inject({
      method: "PATCH",
      url: `/api/videos/${created.id}`,
      headers: { "x-test-user": writer.username },
      payload: {
        expected_version: 1,
        title: "Updated through route",
        thumbnail_url: "https://img.example.test/thumb.jpg",
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({
      video: { title: "Updated through route", version: 2, updated_by: writer.username },
    });

    const conflict = await app.inject({
      method: "PATCH",
      url: `/api/videos/${created.id}`,
      headers: { "x-test-user": writer.username },
      payload: { expected_version: 1, title: "Stale edit" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      latest: { id: created.id, version: 2, title: "Updated through route" },
    });

    const event = await db.admin.query<{ actor: string; action: string }>(
      "SELECT actor, action FROM public.events WHERE entity_type = 'video' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1",
      [created.id],
    );
    expect(event.rows[0]).toEqual({ actor: writer.username, action: "update" });
  });

  it("validates IDs and request bodies and returns 404 for missing records", async () => {
    const invalidId = await app.inject({
      method: "GET",
      url: "/api/videos/nope",
      headers: { "x-test-user": reader.username },
    });
    const missing = await app.inject({
      method: "GET",
      url: `/api/videos/${UNKNOWN_ID}`,
      headers: { "x-test-user": reader.username },
    });
    const invalidCreate = await app.inject({
      method: "POST",
      url: "/api/videos",
      headers: { "x-test-user": writer.username },
      payload: { youtube_id: "https://youtu.be/invalid", title: "Bad id" },
    });
    const invalidUpdate = await app.inject({
      method: "PATCH",
      url: `/api/videos/${videoId}`,
      headers: { "x-test-user": writer.username },
      payload: { expected_version: 1 },
    });
    expect(invalidId.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
    expect(invalidCreate.statusCode).toBe(400);
    expect(invalidUpdate.statusCode).toBe(400);
  });
});

async function makeApp(testDb: TestDb, users: TestUser[]): Promise<TestCore> {
  const server = Fastify({ logger: false });
  server.decorateRequest("auth", undefined);
  const usersByName = new Map(users.map((user) => [user.username, user]));
  server.addHook("onRequest", async (request, reply) => {
    const username = request.headers["x-test-user"];
    const user = typeof username === "string" ? usersByName.get(username) : undefined;
    if (!user) return reply.code(401).send({ error: "Authentication required" });
    const access = await getUserAccess(testDb.pool("ytw_web"), user.id);
    if (!access) return reply.code(401).send({ error: "Authentication required" });
    const auth: WebAuth = {
      userId: access.id,
      username: access.username,
      isAdmin: access.isAdmin,
      levels: access.levels,
      displayName: null,
      email: null,
    };
    Object.assign(request, { auth });
  });

  const core = server as unknown as TestCore;
  core.requireLevel = (resource, level) => async (request, reply) => {
    const auth = request.auth as WebAuth | undefined;
    const principal: UserPrincipal | undefined = auth
      ? {
          kind: "user",
          userId: auth.userId,
          username: auth.username,
          isAdmin: auth.isAdmin,
          levels: auth.levels,
        }
      : undefined;
    const decision = authorize(principal, { resource, level });
    if (!decision.allowed)
      return reply.code(DENIAL_HTTP_STATUS[decision.reason]).send({ error: decision.message });
  };
  core.db = {
    pool: testDb.pool("ytw_web"),
    withActor<T>(request: FastifyRequest, fn: (tx: ActorTx) => Promise<T>) {
      const auth = request.auth as WebAuth | undefined;
      if (!auth) throw new Error("Video route mutation ran without an authenticated user");
      return withActor(testDb.pool("ytw_web"), actor(auth.username), fn);
    },
  };
  return core;
}
