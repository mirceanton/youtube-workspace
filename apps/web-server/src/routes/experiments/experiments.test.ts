import {
  createExperiment,
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
import { authorize, DENIAL_HTTP_STATUS } from "@ytw/policy";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import experimentsRoutes from "./index.js";

const person = (username: string) => ({ name: username, type: "human" as const });
const TEST_ISSUER = "https://experiments-api.test/issuer";
const as = (username: string) => ({ "x-test-user": username });

type TestUser = { id: string; username: string };
type TestAuth = {
  userId: string;
  username: string;
  isAdmin: boolean;
  levels: Record<string, string>;
};
type TestCore = FastifyInstance & {
  requireLevel(resource: "experiments" | "videos", level: "read" | "write"): preHandlerHookHandler;
  db: {
    pool: Queryable;
    withActor<T>(request: FastifyRequest, fn: (tx: ActorTx) => Promise<T>): Promise<T>;
  };
};

describe("/api/experiments (PostgreSQL integration)", () => {
  let db: TestDb;
  let app: FastifyInstance;
  let owner: TestUser;
  let noneUser: TestUser;
  let reader: TestUser;
  let writer: TestUser;
  let experimentWriterWithoutVideos: TestUser;
  let videoId: string;

  beforeAll(async () => {
    db = await createTestDb();
    owner = await signIn("experiments-owner");
    noneUser = await signIn("experiments-none");
    reader = await signIn("experiments-reader");
    writer = await signIn("experiments-writer");
    experimentWriterWithoutVideos = await signIn("experiments-writer-no-videos");
    await grant(reader, "experiments", "read");
    await grant(writer, "experiments", "write");
    await grant(writer, "videos", "read");
    await grant(experimentWriterWithoutVideos, "experiments", "write");

    const video = await withActor(db.pool("ytw_web"), person(owner.username), (tx) =>
      registerVideo(tx, { youtubeId: "t45Video001", title: "Experiments API target" }),
    );
    videoId = video.id;
    await withActor(db.pool("ytw_web"), person(owner.username), (tx) =>
      logMetrics(tx, {
        videoId,
        capturedAt: new Date(Date.now() - 60_000),
        metrics: { ctr: "4.5", impressions: 1000 },
      }),
    );

    app = buildDbBackedCore(db, [owner, noneUser, reader, writer, experimentWriterWithoutVideos]);
    app.register(experimentsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  async function signIn(username: string): Promise<TestUser> {
    const user = await withActor(db.pool("ytw_web"), person(username), (tx) =>
      upsertUserOnLogin(tx, {
        issuer: TEST_ISSUER,
        sub: `${username}-${randomUUID()}`,
        username,
      }),
    );
    return { id: user.id, username: user.username };
  }

  async function grant(
    user: TestUser,
    resource: "experiments" | "videos",
    level: "read" | "write",
  ) {
    await withActor(db.pool("ytw_web"), person(owner.username), (tx) =>
      setUserPermission(tx, {
        actingUserId: owner.id,
        userId: user.id,
        resource,
        level,
      }),
    );
  }

  it("enforces experiment and video-metric permissions independently", async () => {
    expect((await app.inject({ method: "GET", url: "/api/experiments" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/experiments",
          headers: as(noneUser.username),
        })
      ).statusCode,
    ).toBe(DENIAL_HTTP_STATUS.forbidden);

    const readerList = await app.inject({
      method: "GET",
      url: "/api/experiments",
      headers: as(reader.username),
    });
    expect(readerList.statusCode).toBe(200);
    expect(readerList.json()).toEqual({ experiments: [] });

    const readerCreate = await app.inject({
      method: "POST",
      url: "/api/experiments",
      headers: as(reader.username),
      payload: { video_id: videoId, type: "title", variants: [] },
    });
    expect(readerCreate.statusCode).toBe(DENIAL_HTTP_STATUS.forbidden);

    const noVideoAccess = await app.inject({
      method: "GET",
      url: "/api/experiments/videos",
      headers: as(experimentWriterWithoutVideos.username),
    });
    expect(noVideoAccess.statusCode).toBe(DENIAL_HTTP_STATUS.forbidden);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/experiments/videos",
          headers: as(writer.username),
        })
      ).statusCode,
    ).toBe(200);
  });

  it("creates, starts, records, compares and concludes with the authenticated actor", async () => {
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/experiments",
      headers: as(writer.username),
      payload: {
        video_id: videoId,
        type: "title",
        hypothesis: "A more specific title raises CTR.",
        variants: [
          { label: "Current", content: "The current title", is_control: true },
          { label: "Specific", content: "A more specific title", is_control: false },
        ],
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json<{
      experiment: {
        id: string;
        version: number;
        created_by: string;
        variants: { id: string; is_control: boolean }[];
      };
    }>().experiment;
    expect(created.created_by).toBe(writer.username);
    expect(created.variants).toHaveLength(2);

    const readerDetail = await app.inject({
      method: "GET",
      url: `/api/experiments/${created.id}`,
      headers: as(reader.username),
    });
    expect(readerDetail.statusCode).toBe(200);
    expect(readerDetail.json()).toMatchObject({
      experiment: { id: created.id, variants: [{ is_control: true }, { is_control: false }] },
    });

    const videoCtr = await app.inject({
      method: "GET",
      url: `/api/experiments/${created.id}/ctr-history`,
      headers: as(writer.username),
    });
    expect(videoCtr.statusCode).toBe(200);
    expect(videoCtr.json()).toMatchObject({ history: [{ ctr: "4.5" }] });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/experiments/${created.id}/ctr-history`,
          headers: as(experimentWriterWithoutVideos.username),
        })
      ).statusCode,
    ).toBe(403);

    const started = await app.inject({
      method: "PATCH",
      url: `/api/experiments/${created.id}/status`,
      headers: as(writer.username),
      payload: { expected_version: created.version, status: "running" },
    });
    expect(started.statusCode).toBe(200);
    const running = started.json<{ experiment: { version: number; starts_at: string } }>()
      .experiment;
    expect(running.starts_at).toBeTruthy();

    const view = await withActor(db.pool("ytw_web"), person(writer.username), (tx) =>
      createExperiment(tx, {
        videoId,
        type: "thumbnail",
        variants: [
          { label: "Other control", content: "control.jpg", isControl: true },
          { label: "Other test", content: "test.jpg" },
        ],
      }),
    );
    const foreignVariantStats = await app.inject({
      method: "PATCH",
      url: `/api/experiments/${created.id}/variants/${view.variants[0]?.id}/stats`,
      headers: as(writer.username),
      payload: { ctr: 6 },
    });
    expect(foreignVariantStats.statusCode).toBe(404);

    for (const [variant, impressions, ctr] of [
      [created.variants[0], 1200, 4],
      [created.variants[1], 900, 5],
    ] as const) {
      const result = await app.inject({
        method: "PATCH",
        url: `/api/experiments/${created.id}/variants/${variant?.id}/stats`,
        headers: as(writer.username),
        payload: { impressions, ctr },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ variant: { updated_by: writer.username } });
    }

    const detail = await app.inject({
      method: "GET",
      url: `/api/experiments/${created.id}`,
      headers: as(reader.username),
    });
    expect(detail.json()).toMatchObject({
      experiment: {
        variants: [
          { is_control: true, impressions: "1200", ctr_vs_control: "0" },
          { is_control: false, impressions: "900", ctr: "5", ctr_vs_control: "1" },
        ],
      },
    });

    const staleConclusion = await app.inject({
      method: "POST",
      url: `/api/experiments/${created.id}/conclude`,
      headers: as(writer.username),
      payload: {
        expected_version: created.version,
        winner_variant_id: created.variants[1]?.id,
        conclusion: "The specific title won.",
      },
    });
    expect(staleConclusion.statusCode).toBe(409);
    expect(staleConclusion.json()).toMatchObject({ latest: { version: running.version } });

    const concluded = await app.inject({
      method: "POST",
      url: `/api/experiments/${created.id}/conclude`,
      headers: as(writer.username),
      payload: {
        expected_version: running.version,
        winner_variant_id: created.variants[1]?.id,
        conclusion: "The specific title won.",
      },
    });
    expect(concluded.statusCode).toBe(200);
    expect(concluded.json()).toMatchObject({
      experiment: {
        status: "concluded",
        winner_variant_id: created.variants[1]?.id,
        conclusion: "The specific title won.",
        updated_by: writer.username,
      },
    });

    const finalDetail = await app.inject({
      method: "GET",
      url: `/api/experiments/${created.id}`,
      headers: as(reader.username),
    });
    expect(finalDetail.json()).toMatchObject({
      experiment: {
        variants: [{ is_winner: false }, { is_winner: true }],
      },
    });

    const audit = await db.admin.query<{ actor: string; action: string; entity_id: string }>(
      `SELECT actor, action, entity_id FROM public.events
        WHERE entity_type = 'experiment' AND entity_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [created.id],
    );
    expect(audit.rows[0]).toEqual({
      actor: writer.username,
      action: "update",
      entity_id: created.id,
    });
  });

  it("returns validation and not-found errors and leaves a planned experiment cancellable", async () => {
    const invalid = await app.inject({
      method: "POST",
      url: "/api/experiments",
      headers: as(writer.username),
      payload: { video_id: "bad", type: "other", variants: [] },
    });
    expect(invalid.statusCode).toBe(400);

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/experiments/018f0f9f-cc8a-7b2a-9a0d-111111111111",
          headers: as(reader.username),
        })
      ).statusCode,
    ).toBe(404);

    const planned = await withActor(db.pool("ytw_web"), person(owner.username), (tx) =>
      createExperiment(tx, {
        videoId,
        type: "description",
        variants: [
          { label: "Control", content: "Original description", isControl: true },
          { label: "Test", content: "Updated description" },
        ],
      }),
    );
    const cancel = await app.inject({
      method: "PATCH",
      url: `/api/experiments/${planned.id}/status`,
      headers: as(writer.username),
      payload: { expected_version: planned.version, status: "cancelled" },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ experiment: { status: "cancelled", ends_at: null } });
  });

  function buildDbBackedCore(testDb: TestDb, users: TestUser[]): FastifyInstance {
    const server = Fastify({ logger: false });
    const usersByName = new Map(users.map((user) => [user.username, user]));
    server.addHook("onRequest", async (request, reply) => {
      const username = request.headers["x-test-user"];
      const user = typeof username === "string" ? usersByName.get(username) : undefined;
      if (user === undefined) return reply.code(401).send({ error: "Authentication required" });
      const access = await getUserAccess(testDb.pool("ytw_web"), user.id);
      if (access === null) return reply.code(401).send({ error: "Authentication required" });
      Object.assign(request, {
        auth: {
          userId: access.id,
          username: access.username,
          isAdmin: access.isAdmin,
          levels: access.levels,
        } satisfies TestAuth,
      });
    });

    const core = server as unknown as TestCore;
    core.requireLevel = (resource, level) => async (request, reply) => {
      const auth = (request as FastifyRequest & { auth: TestAuth }).auth;
      const access = await getUserAccess(testDb.pool("ytw_web"), auth.userId);
      const principal =
        access === null
          ? undefined
          : {
              kind: "user" as const,
              userId: access.id,
              username: access.username,
              isAdmin: access.isAdmin,
              levels: access.levels,
            };
      const decision = authorize(principal, { resource, level });
      if (!decision.allowed) {
        return reply.code(DENIAL_HTTP_STATUS[decision.reason]).send({ error: decision.message });
      }
    };
    core.db = {
      pool: testDb.pool("ytw_web"),
      withActor: (request, fn) => {
        const auth = (request as FastifyRequest & { auth: TestAuth }).auth;
        return withActor(testDb.pool("ytw_web"), person(auth.username), fn);
      },
    };
    return server;
  }
});
