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
import { SCRIPT_FILE_MAX_INPUT_BYTES, serializeScriptFile } from "@ytw/script-md";
import { SCRIPT_BODY_MAX_BYTES } from "@ytw/shared/constants";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import scriptsRoutes from "./index.js";

const person = (username: string) => ({ name: username, type: "human" as const });
const TEST_ISSUER = "https://scripts-api.test/issuer";
const as = (username: string) => ({ "x-test-user": username });

type TestUser = { id: string; username: string };
type TestAuth = {
  userId: string;
  username: string;
  isAdmin: boolean;
  levels: Record<string, string>;
};
type TestCore = FastifyInstance & {
  requireLevel(resource: "scripts", level: "read" | "write"): preHandlerHookHandler;
  db: {
    pool: Queryable;
    withActor<T>(request: FastifyRequest, fn: (tx: ActorTx) => Promise<T>): Promise<T>;
  };
};

describe("/api/scripts (PostgreSQL integration)", () => {
  let db: TestDb;
  let app: FastifyInstance;
  let owner: TestUser;
  let noneUser: TestUser;
  let reader: TestUser;
  let writer: TestUser;
  let lateGrantUser: TestUser;

  beforeAll(async () => {
    db = await createTestDb();
    const first = await signIn("scripts-owner");
    owner = { id: first.id, username: first.username };
    const noAccess = await signIn("scripts-none");
    noneUser = { id: noAccess.id, username: noAccess.username };
    const readOnly = await signIn("scripts-reader");
    reader = { id: readOnly.id, username: readOnly.username };
    const writeAccess = await signIn("scripts-writer");
    writer = { id: writeAccess.id, username: writeAccess.username };
    const lateAccess = await signIn("scripts-late-grant");
    lateGrantUser = { id: lateAccess.id, username: lateAccess.username };
    await grant(reader, "read");
    await grant(writer, "write");
    app = buildDbBackedCore(db, [owner, noneUser, reader, writer, lateGrantUser]);
    app.register(scriptsRoutes);
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
        resource: "scripts",
        level,
      }),
    );
  }

  async function newTargetIdea(title: string): Promise<string> {
    const idea = await withActor(db.pool("ytw_web"), person(owner.username), (tx) =>
      createIdea(tx, { title }),
    );
    return idea.id;
  }

  it("enforces live access levels and returns history and revision bodies", async () => {
    const ideaId = await newTargetIdea("Scripts route integration target");
    const created = await app.inject({
      method: "POST",
      url: "/api/scripts",
      headers: as(writer.username),
      payload: {
        idea_id: ideaId,
        kind: "script",
        base_version: 0,
        body_md: "# First version\n\nHello.",
      },
    });
    expect(created.statusCode).toBe(201);
    const script = created.json<{ script: { id: string; version: number; created_by: string } }>()
      .script;
    expect(script).toMatchObject({ version: 1, created_by: writer.username });

    const readerHistory = await app.inject({
      method: "GET",
      url: `/api/scripts/history?idea_id=${ideaId}&kind=script`,
      headers: as(reader.username),
    });
    expect(readerHistory.statusCode).toBe(200);
    expect(readerHistory.json()).toMatchObject({
      idea_id: ideaId,
      idea_title: "Scripts route integration target",
      kind: "script",
      versions: [{ id: script.id, version: 1 }],
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/scripts/${script.id}`,
      headers: as(reader.username),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ script: { body_md: "# First version\n\nHello." } });

    const list = await app.inject({
      method: "GET",
      url: "/api/scripts",
      headers: as(reader.username),
    });
    expect(list.statusCode).toBe(200);
    expect(
      list.json<{ scripts: { idea_id: string; idea_title: string; version: number }[] }>().scripts,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idea_id: ideaId,
          idea_title: "Scripts route integration target",
          version: 1,
        }),
      ]),
    );

    const readerWrite = await app.inject({
      method: "POST",
      url: "/api/scripts",
      headers: as(reader.username),
      payload: { idea_id: ideaId, kind: "script", base_version: 1, body_md: "no" },
    });
    expect(readerWrite.statusCode).toBe(403);

    const noneRead = await app.inject({
      method: "GET",
      url: `/api/scripts/history?idea_id=${ideaId}&kind=script`,
      headers: as(noneUser.username),
    });
    expect(noneRead.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/scripts" })).statusCode).toBe(401);

    const audit = await db.admin.query<{ actor: string; action: string; entity_id: string }>(
      `SELECT actor, action, entity_id FROM public.events
        WHERE entity_type = 'script' AND entity_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [script.id],
    );
    expect(audit.rows[0]).toEqual({
      actor: writer.username,
      action: "insert",
      entity_id: script.id,
    });
  });

  it("changes status and downloads a canonical markdown file", async () => {
    const ideaId = await newTargetIdea("Scripts file export target");
    const created = await app.inject({
      method: "POST",
      url: "/api/scripts",
      headers: as(writer.username),
      payload: { idea_id: ideaId, kind: "packaging", base_version: 0, body_md: "# Titles" },
    });
    const script = created.json<{ script: { id: string; version: number } }>().script;

    const readerStatus = await app.inject({
      method: "PATCH",
      url: `/api/scripts/${script.id}/status`,
      headers: as(reader.username),
      payload: { status: "review" },
    });
    expect(readerStatus.statusCode).toBe(403);

    const status = await app.inject({
      method: "PATCH",
      url: `/api/scripts/${script.id}/status`,
      headers: as(writer.username),
      payload: { status: "review" },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      script: { status: "review", updated_by: writer.username },
    });

    const download = await app.inject({
      method: "GET",
      url: `/api/scripts/${script.id}/file`,
      headers: as(reader.username),
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("text/markdown");
    expect(download.headers["content-disposition"]).toContain("-packaging-v1.md");
    expect(download.body).toBe(
      serializeScriptFile({
        ideaId,
        kind: "packaging",
        version: 1,
        status: "review",
        body: "# Titles",
      }),
    );
  });

  it("returns clear upload mismatch and oversize errors, and rejects stale bases", async () => {
    const ideaId = await newTargetIdea("Scripts upload target");
    const first = await app.inject({
      method: "POST",
      url: "/api/scripts",
      headers: as(writer.username),
      payload: { idea_id: ideaId, kind: "script", base_version: 0, body_md: "first" },
    });
    expect(first.statusCode).toBe(201);

    const mismatch = await app.inject({
      method: "POST",
      url: `/api/scripts/upload?idea_id=${ideaId}&kind=script&base_version=1`,
      headers: { ...as(writer.username), "content-type": "text/markdown" },
      payload: `---\nidea_id: ${ideaId}\nkind: packaging\nversion: 1\nstatus: draft\n---\n\nbody`,
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ code: "kind_mismatch" });

    const oversized = await app.inject({
      method: "POST",
      url: "/api/scripts",
      headers: as(writer.username),
      payload: {
        idea_id: ideaId,
        kind: "packaging",
        base_version: 0,
        body_md: "x".repeat(SCRIPT_BODY_MAX_BYTES + 1),
      },
    });
    expect(oversized.statusCode).toBe(413);

    const second = await app.inject({
      method: "POST",
      url: "/api/scripts",
      headers: as(writer.username),
      payload: { idea_id: ideaId, kind: "script", base_version: 1, body_md: "second" },
    });
    expect(second.statusCode).toBe(201);

    const stale = await app.inject({
      method: "POST",
      url: `/api/scripts/upload?idea_id=${ideaId}&kind=script&base_version=1`,
      headers: { ...as(writer.username), "content-type": "text/markdown" },
      payload: `---\nidea_id: ${ideaId}\nkind: script\nversion: 1\nstatus: draft\n---\n\nold local copy`,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ latest: { version: 2 } });

    const tooLargeFile = await app.inject({
      method: "POST",
      url: `/api/scripts/upload?idea_id=${ideaId}&kind=packaging&base_version=0`,
      headers: { ...as(writer.username), "content-type": "text/markdown" },
      payload: Buffer.alloc(SCRIPT_FILE_MAX_INPUT_BYTES + 1, 120),
    });
    expect(tooLargeFile.statusCode).toBe(413);
  });

  it("accepts a body at the byte limit when JSON escaping expands its transport size", async () => {
    const ideaId = await newTargetIdea("Scripts escaped JSON size target");
    const body = '"'.repeat(SCRIPT_BODY_MAX_BYTES);
    const payload = JSON.stringify({
      idea_id: ideaId,
      kind: "script",
      base_version: 0,
      body_md: body,
    });
    expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(SCRIPT_BODY_MAX_BYTES + 16_384);

    const response = await app.inject({
      method: "POST",
      url: "/api/scripts",
      headers: { ...as(writer.username), "content-type": "application/json" },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ script: { size_bytes: number } }>().script.size_bytes).toBe(
      SCRIPT_BODY_MAX_BYTES,
    );
  });

  it("allows only one concurrent save for the same base version", async () => {
    const ideaId = await newTargetIdea("Scripts concurrent edit target");
    const request = (body: string) =>
      app.inject({
        method: "POST",
        url: "/api/scripts",
        headers: as(owner.username),
        payload: { idea_id: ideaId, kind: "packaging", base_version: 0, body_md: body },
      });
    const results = await Promise.all([request("left edit"), request("right edit")]);
    expect(results.map((response) => response.statusCode).toSorted()).toEqual([201, 409]);
    const history = await app.inject({
      method: "GET",
      url: `/api/scripts/history?idea_id=${ideaId}&kind=packaging`,
      headers: as(reader.username),
    });
    expect(history.json<{ versions: unknown[] }>().versions).toHaveLength(1);
  });

  it("applies permission changes on the next request", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/api/scripts",
      headers: as(lateGrantUser.username),
    });
    expect(before.statusCode).toBe(403);
    await grant(lateGrantUser, "read");
    const after = await app.inject({
      method: "GET",
      url: "/api/scripts",
      headers: as(lateGrantUser.username),
    });
    expect(after.statusCode).toBe(200);
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
