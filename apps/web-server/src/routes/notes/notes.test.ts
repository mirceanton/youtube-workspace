import {
  createIdea,
  getUserAccess,
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
import notesRoutes from "./index.js";

const person = (username: string) => ({ name: username, type: "human" as const });
const TEST_ISSUER = "https://notes-api.test/issuer";
const UNKNOWN_ENTITY_ID = "018f0f9f-cc8a-7b2a-9a0d-111111111111";
const as = (username: string) => ({ "x-test-user": username });

type TestUser = { id: string; username: string };
type TestAuth = {
  userId: string;
  username: string;
  isAdmin: boolean;
  levels: Record<string, string>;
};
type TestCore = FastifyInstance & {
  requireLevel(resource: "notes", level: "read" | "write"): preHandlerHookHandler;
  db: {
    pool: Queryable;
    withActor<T>(request: FastifyRequest, fn: (tx: ActorTx) => Promise<T>): Promise<T>;
  };
};

describe("/api/notes (PostgreSQL integration)", () => {
  let db: TestDb;
  let app: FastifyInstance;
  let owner: TestUser;
  let noneUser: TestUser;
  let reader: TestUser;
  let writer: TestUser;
  let ideaId: string;

  beforeAll(async () => {
    db = await createTestDb();

    const first = await signIn("notes-owner");
    owner = { id: first.id, username: first.username };
    const noAccess = await signIn("notes-none");
    noneUser = { id: noAccess.id, username: noAccess.username };
    const readOnly = await signIn("notes-reader");
    reader = { id: readOnly.id, username: readOnly.username };
    const writeAccess = await signIn("notes-writer");
    writer = { id: writeAccess.id, username: writeAccess.username };

    await grant(reader, "read");
    await grant(writer, "write");
    const idea = await withActor(db.pool("ytw_web"), person(owner.username), (tx) =>
      createIdea(tx, { title: "Notes route integration target" }),
    );
    ideaId = idea.id;

    app = buildDbBackedCore(db, [owner, noneUser, reader, writer]);
    app.register(notesRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  async function signIn(username: string) {
    return withActor(db.pool("ytw_web"), person(username), (tx) =>
      upsertUserOnLogin(tx, {
        issuer: TEST_ISSUER,
        sub: `${username}-${randomUUID()}`,
        username,
      }),
    );
  }

  async function grant(user: TestUser, level: "read" | "write") {
    await withActor(db.pool("ytw_web"), person(owner.username), (tx) =>
      setUserPermission(tx, {
        actingUserId: owner.id,
        userId: user.id,
        resource: "notes",
        level,
      }),
    );
  }

  it("enforces live None/Read/Write levels and reads persisted notes", async () => {
    const noneGet = await app.inject({
      method: "GET",
      url: `/api/notes?entity_type=idea&entity_id=${ideaId}`,
      headers: as(noneUser.username),
    });
    expect(noneGet.statusCode).toBe(403);

    const readerGet = await app.inject({
      method: "GET",
      url: `/api/notes?entity_type=idea&entity_id=${ideaId}`,
      headers: as(reader.username),
    });
    expect(readerGet.statusCode).toBe(200);
    expect(readerGet.json()).toEqual({ notes: [] });

    const readerPost = await app.inject({
      method: "POST",
      url: "/api/notes",
      headers: as(reader.username),
      payload: { entity_type: "idea", entity_id: ideaId, body_md: "readers cannot write" },
    });
    expect(readerPost.statusCode).toBe(403);

    const nonePost = await app.inject({
      method: "POST",
      url: "/api/notes",
      headers: as(noneUser.username),
      payload: { entity_type: "idea", entity_id: ideaId, body_md: "no access" },
    });
    expect(nonePost.statusCode).toBe(403);

    const writerPost = await app.inject({
      method: "POST",
      url: "/api/notes",
      headers: as(writer.username),
      payload: {
        entity_type: "idea",
        entity_id: ideaId,
        body_md: "Stored as **raw markdown**",
        author: "forged-author",
      },
    });
    expect(writerPost.statusCode).toBe(201);
    const { note } = writerPost.json<{
      note: {
        id: string;
        entity_type: string;
        entity_id: string;
        author: string;
        actor_type: string;
        body_md: string;
      };
    }>();
    expect(note).toMatchObject({
      entity_type: "idea",
      entity_id: ideaId,
      author: writer.username,
      actor_type: "human",
      body_md: "Stored as **raw markdown**",
    });

    const readerAfterWrite = await app.inject({
      method: "GET",
      url: `/api/notes?entity_type=idea&entity_id=${ideaId}`,
      headers: as(reader.username),
    });
    expect(readerAfterWrite.statusCode).toBe(200);
    expect(readerAfterWrite.json()).toMatchObject({
      notes: [{ id: note.id, author: writer.username }],
    });

    const stored = await db.admin.query<{
      author: string;
      actor_type: string;
      entity_type: string;
      entity_id: string;
      body_md: string;
    }>(
      "SELECT author, actor_type, entity_type, entity_id, body_md FROM public.notes WHERE id = $1",
      [note.id],
    );
    expect(stored.rows[0]).toEqual({
      author: writer.username,
      actor_type: "human",
      entity_type: "idea",
      entity_id: ideaId,
      body_md: "Stored as **raw markdown**",
    });

    const audit = await db.admin.query<{
      actor: string;
      entity_type: string;
      entity_id: string;
      action: string;
    }>(
      `SELECT actor, entity_type, entity_id, action
         FROM public.events
        WHERE entity_type = 'note' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [note.id],
    );
    expect(audit.rows[0]).toEqual({
      actor: writer.username,
      entity_type: "note",
      entity_id: note.id,
      action: "insert",
    });
  });

  it("validates input and returns 404 for missing targets on both routes", async () => {
    const malformedQuery = await app.inject({
      method: "GET",
      url: "/api/notes?entity_type=person",
      headers: as(reader.username),
    });
    expect(malformedQuery.statusCode).toBe(400);

    const missingGet = await app.inject({
      method: "GET",
      url: `/api/notes?entity_type=idea&entity_id=${UNKNOWN_ENTITY_ID}`,
      headers: as(reader.username),
    });
    expect(missingGet.statusCode).toBe(404);

    const invalidPost = await app.inject({
      method: "POST",
      url: "/api/notes",
      headers: as(writer.username),
      payload: { entity_type: "idea", entity_id: ideaId, body_md: "  " },
    });
    expect(invalidPost.statusCode).toBe(400);

    const missingPost = await app.inject({
      method: "POST",
      url: "/api/notes",
      headers: as(writer.username),
      payload: { entity_type: "idea", entity_id: UNKNOWN_ENTITY_ID, body_md: "missing target" },
    });
    expect(missingPost.statusCode).toBe(404);
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
      const auth: TestAuth = {
        userId: access.id,
        username: access.username,
        isAdmin: access.isAdmin,
        levels: access.levels,
      };
      Object.assign(request, { auth });
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
