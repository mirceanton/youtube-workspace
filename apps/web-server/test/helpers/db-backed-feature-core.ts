import { getUserAccess, withActor as runWithActor, type ActorTx } from "@ytw/db";
import type { TestDb } from "@ytw/db/testing";
import { authorize, DENIAL_HTTP_STATUS, type UserPrincipal } from "@ytw/policy";
import { RESOURCES } from "@ytw/shared/constants";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type preHandlerHookHandler,
} from "fastify";
import type { WebAuth } from "../../src/core/types.js";

export interface FeatureTestUser {
  id: string;
  username: string;
}

export type FeatureTestCore = FastifyInstance & {
  requireLevel(
    resource: (typeof RESOURCES)[number],
    level: "read" | "write",
  ): preHandlerHookHandler;
  requireAnyLevel(level: "read" | "write"): preHandlerHookHandler;
};

/** Small Fastify core whose request auth and guards both reload levels from the real test DB. */
export function dbBackedFeatureCore(testDb: TestDb, users: FeatureTestUser[]): FeatureTestCore {
  const server = Fastify({ logger: false });
  server.decorateRequest("auth", undefined);
  const usersByName = new Map(users.map((user) => [user.username, user]));

  server.addHook("onRequest", async (request, reply) => {
    const username = request.headers["x-test-user"];
    const user = typeof username === "string" ? usersByName.get(username) : undefined;
    if (!user) return reply.code(401).send({ error: "Authentication required." });
    const access = await getUserAccess(testDb.pool("ytw_web"), user.id);
    if (!access) return reply.code(401).send({ error: "Authentication required." });
    const auth: WebAuth = {
      userId: access.id,
      username: access.username,
      isAdmin: access.isAdmin,
      levels: access.levels,
      displayName: access.displayName,
      email: access.email,
    };
    request.auth = auth;
  });

  const core = server as unknown as FeatureTestCore;
  core.db = {
    pool: testDb.pool("ytw_web"),
    withActor<T>(request: FastifyRequest, fn: (tx: ActorTx) => Promise<T>): Promise<T> {
      const auth = request.auth;
      if (!auth) throw new Error("Test route mutation ran without a signed-in user");
      return runWithActor(testDb.pool("ytw_web"), { name: auth.username, type: "human" }, fn);
    },
  };
  core.requireLevel = (resource, level) => async (request, reply) => {
    const auth = request.auth;
    const access = auth ? await getUserAccess(testDb.pool("ytw_web"), auth.userId) : null;
    const decision = authorize(
      access
        ? {
            kind: "user",
            userId: access.id,
            username: access.username,
            isAdmin: access.isAdmin,
            levels: access.levels,
          }
        : undefined,
      { resource, level },
    );
    if (!decision.allowed) {
      return reply.code(DENIAL_HTTP_STATUS[decision.reason]).send({ error: decision.message });
    }
  };
  core.requireAnyLevel = (level) => async (request, reply) => {
    const auth = request.auth;
    const access = auth ? await getUserAccess(testDb.pool("ytw_web"), auth.userId) : null;
    const current: UserPrincipal | undefined = access
      ? {
          kind: "user",
          userId: access.id,
          username: access.username,
          isAdmin: access.isAdmin,
          levels: access.levels,
        }
      : undefined;
    if (!current) return reply.code(401).send({ error: "Authentication required." });
    const readable = RESOURCES.some((resource) => authorize(current, { resource, level }).allowed);
    if (!readable)
      return reply.code(403).send({ error: "Permission denied: read access is required." });
  };
  return core;
}
