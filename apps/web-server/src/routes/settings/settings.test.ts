import {
  getUserAccess,
  setUserPermission,
  upsertUserOnLogin,
  withActor,
  type ActorTx,
  lookupTokenByHash,
} from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { authorize, DENIAL_HTTP_STATUS } from "@ytw/policy";
import { hashToken } from "@ytw/tokens";
import { RESOURCES, type Level, type Resource } from "@ytw/shared/constants";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import adminRoutes from "../admin/index.js";
import settingsRoutes from "./index.js";
import tokenRoutes from "../tokens/index.js";

const person = (username: string) => ({ name: username, type: "human" as const });
const TEST_ISSUER = "https://settings.test/issuer";
const as = (username: string) => ({ "x-test-user": username });

interface User {
  id: string;
  username: string;
}

interface TestAuth {
  userId: string;
  username: string;
  isAdmin: boolean;
  levels: Record<Resource, Level>;
}

type TestCore = FastifyInstance & {
  requireLevel(resource: Resource, level: "read" | "write"): preHandlerHookHandler;
  requireAnyLevel(level: "read" | "write"): preHandlerHookHandler;
  db: {
    pool: ReturnType<TestDb["pool"]>;
    withActor<T>(request: FastifyRequest, fn: (tx: ActorTx) => Promise<T>): Promise<T>;
  };
};

describe("settings APIs (PostgreSQL integration)", () => {
  let db: TestDb;
  let app: FastifyInstance;
  let owner: User;
  let reader: User;
  let noAccess: User;

  beforeAll(async () => {
    db = await createTestDb();
    const first = await signIn("settings-admin");
    owner = { id: first.id, username: first.username };
    const second = await signIn("settings-reader");
    reader = { id: second.id, username: second.username };
    const third = await signIn("settings-none");
    noAccess = { id: third.id, username: third.username };
    await grant(reader, "scripts", "read");

    app = buildDbBackedCore(db, [owner, reader, noAccess]);
    await app.register(settingsRoutes);
    await app.register(tokenRoutes);
    await app.register(adminRoutes);
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
        displayName: `${username} display`,
        email: `${username}@example.test`,
      }),
    );
  }

  async function grant(user: User, resource: Resource, level: Level) {
    await withActor(db.pool("ytw_web"), person(owner.username), (tx) =>
      setUserPermission(tx, {
        actingUserId: owner.id,
        userId: user.id,
        resource,
        level,
      }),
    );
  }

  it("serves the current profile and effective levels, without exposing another identity", async () => {
    const profile = await app.inject({
      method: "GET",
      url: "/api/settings/profile",
      headers: as(reader.username),
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({
      profile: {
        id: reader.id,
        username: reader.username,
        display_name: `${reader.username} display`,
        email: `${reader.username}@example.test`,
        issuer: TEST_ISSUER,
        is_admin: false,
      },
      levels: { scripts: "read", ideas: "none" },
    });
    expect(profile.json().profile.subject).toContain(reader.username);

    const noAccessProfile = await app.inject({
      method: "GET",
      url: "/api/settings/profile",
      headers: as(noAccess.username),
    });
    expect(noAccessProfile.statusCode).toBe(403);
  });

  it("applies token ceilings, keeps secrets one-time, rotates and revokes immediately", async () => {
    const unauthenticated = await app.inject({ method: "GET", url: "/api/settings/tokens" });
    expect(unauthenticated.statusCode).toBe(401);
    const noneList = await app.inject({
      method: "GET",
      url: "/api/settings/tokens",
      headers: as(noAccess.username),
    });
    expect(noneList.statusCode).toBe(403);

    const deniedCreate = await app.inject({
      method: "POST",
      url: "/api/settings/tokens",
      headers: as(reader.username),
      payload: { name: "too much", permissions: { scripts: "write" } },
    });
    expect(deniedCreate.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/api/settings/tokens",
      headers: as(reader.username),
      payload: { name: "script reader", permissions: { scripts: "read" } },
    });
    expect(created.statusCode).toBe(201);
    const issued = created.json<{
      token: { id: string; status: string; expires_at: string };
      secret: string;
    }>();
    expect(issued.secret).toMatch(/^ytw_[A-Za-z0-9_-]{43}$/);
    expect(issued.token.status).toBe("active");
    const expiryDays =
      (new Date(issued.token.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(expiryDays).toBeGreaterThan(89);
    expect(expiryDays).toBeLessThanOrEqual(90);

    const list = await app.inject({
      method: "GET",
      url: "/api/settings/tokens",
      headers: as(reader.username),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ tokens: [{ id: issued.token.id, name: "script reader" }] });
    expect(JSON.stringify(list.json())).not.toContain(issued.secret);
    expect(JSON.stringify(list.json())).not.toContain("token_hash");

    const deniedEdit = await app.inject({
      method: "PATCH",
      url: `/api/settings/tokens/${issued.token.id}`,
      headers: as(reader.username),
      payload: { permissions: { scripts: "write" } },
    });
    expect(deniedEdit.statusCode).toBe(403);

    const oldHash = hashToken(issued.secret);
    const rotated = await app.inject({
      method: "POST",
      url: `/api/settings/tokens/${issued.token.id}/rotate`,
      headers: as(reader.username),
      payload: {},
    });
    expect(rotated.statusCode).toBe(200);
    const rotatedToken = rotated.json<{ token: { id: string }; secret: string }>();
    expect(rotatedToken.token.id).toBe(issued.token.id);
    expect(rotatedToken.secret).not.toBe(issued.secret);
    expect((await lookupTokenByHash(db.pool("ytw_mcp"), oldHash)).status).not.toBe("active");

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/settings/tokens/${issued.token.id}`,
      headers: as(reader.username),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ token: { status: "revoked" } });

    const deniedUserToken = await app.inject({
      method: "PATCH",
      url: `/api/settings/tokens/${issued.token.id}`,
      headers: as(noAccess.username),
      payload: { permissions: { scripts: "none" } },
    });
    expect(deniedUserToken.statusCode).toBe(403);

    const events = await db.admin.query<{ payload: string }>(
      "SELECT payload::text AS payload FROM public.events WHERE entity_type = 'api_token' AND entity_id = $1::uuid",
      [issued.token.id],
    );
    const auditText = events.rows.map((row) => row.payload).join(" ");
    expect(auditText).not.toContain(issued.secret);
    expect(auditText).not.toContain(oldHash);
    expect(auditText).not.toContain(hashToken(rotatedToken.secret));
  });

  it("lowers existing token effective levels with the owner and protects the admin matrix", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/settings/tokens",
      headers: as(reader.username),
      payload: { name: "live ceiling", expires_at: null, permissions: { scripts: "read" } },
    });
    expect(created.statusCode).toBe(201);
    const issued = created.json<{ token: { id: string }; secret: string }>();
    const beforeLowering = await lookupTokenByHash(db.pool("ytw_mcp"), hashToken(issued.secret));
    expect(beforeLowering.status).toBe("active");
    if (beforeLowering.status !== "active")
      throw new Error("The newly created token must be active");
    expect(beforeLowering.effectiveLevels.scripts).toBe("read");

    await grant(reader, "scripts", "none");
    const lowered = await lookupTokenByHash(db.pool("ytw_mcp"), hashToken(issued.secret));
    expect(lowered.status).toBe("active");
    if (lowered.status !== "active") throw new Error("The newly created token must remain active");
    expect(lowered.effectiveLevels.scripts).toBe("none");

    await grant(reader, "activity", "read");
    const nonAdminWrite = await app.inject({
      method: "PATCH",
      url: `/api/settings/users/${reader.id}/permissions`,
      headers: as(reader.username),
      payload: { resource: "scripts", level: "read" },
    });
    expect(nonAdminWrite.statusCode).toBe(403);

    const matrix = await app.inject({
      method: "GET",
      url: "/api/settings/users",
      headers: as(owner.username),
    });
    expect(matrix.statusCode).toBe(200);
    expect(matrix.json()).toMatchObject({
      users: expect.arrayContaining([
        expect.objectContaining({
          id: reader.id,
          levels: expect.objectContaining({ scripts: "none" }),
        }),
      ]),
    });

    const adminGrant = await app.inject({
      method: "PATCH",
      url: `/api/settings/users/${reader.id}/permissions`,
      headers: as(owner.username),
      payload: { resource: "scripts", level: "write" },
    });
    expect(adminGrant.statusCode).toBe(200);
    expect((await getUserAccess(db.pool("ytw_web"), reader.id))?.levels.scripts).toBe("write");

    const nonAdminMatrixRead = await app.inject({
      method: "GET",
      url: "/api/settings/users",
      headers: as(reader.username),
    });
    expect(nonAdminMatrixRead.statusCode).toBe(403);

    const lastAdminDemotion = await app.inject({
      method: "PATCH",
      url: `/api/settings/users/${owner.id}/admin`,
      headers: as(owner.username),
      payload: { is_admin: false },
    });
    expect(lastAdminDemotion.statusCode).toBe(403);
    expect(lastAdminDemotion.json().error).toContain("last admin");
  });

  function buildDbBackedCore(testDb: TestDb, users: User[]): FastifyInstance {
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
      const decision = authorize(
        auth
          ? {
              kind: "user" as const,
              userId: auth.userId,
              username: auth.username,
              isAdmin: auth.isAdmin,
              levels: auth.levels,
            }
          : undefined,
        { resource, level },
      );
      if (!decision.allowed)
        return reply.code(DENIAL_HTTP_STATUS[decision.reason]).send({ error: decision.message });
    };
    core.requireAnyLevel = (level) => async (request, reply) => {
      const auth = (request as FastifyRequest & { auth?: TestAuth }).auth;
      if (!auth) return reply.code(401).send({ error: "Authentication required" });
      const principal = {
        kind: "user" as const,
        userId: auth.userId,
        username: auth.username,
        isAdmin: auth.isAdmin,
        levels: auth.levels,
      };
      if (!RESOURCES.some((resource) => authorize(principal, { resource, level }).allowed)) {
        return reply.code(403).send({ error: "Read access on at least one object is required" });
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
