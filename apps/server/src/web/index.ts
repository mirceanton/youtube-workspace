/**
 * The web group: everything the single-page app talks to (`/api/*`, `/auth/*`) and the app's own
 * files. Callers are people, identified by a session (OIDC) or taken to be the local owner
 * (single-user mode, see `AuthMode`); mutations also need the CSRF header the SPA reads from
 * `GET /api/me`. Feature routes are loaded from `routes/<feature>/index.ts`.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withActor, type ActorTx } from "@ytw/db";
import { authorize, DENIAL_HTTP_STATUS, type AccessRule } from "@ytw/policy";
import { GRANTABLE_LEVELS, RESOURCES, type Resource } from "@ytw/shared/constants";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import type { Pool } from "pg";
import type { Env } from "../env.js";
import { CSRF_HEADER, csrfToken, sameToken } from "./csrf.js";
import { createLocalAuth } from "./local-auth.js";
import { contentSecurityPolicy, createOidcAuth } from "./oidc-auth.js";
import type { OidcFetch } from "./oidc.js";
import { registerFeatureRoutes } from "./routes.js";
import { installSpaFallback } from "./static.js";
import type { WebAuth } from "./types.js";

export interface WebOptions {
  env: Env;
  pool: Pool;
  /** Replaces outbound OIDC requests, so tests can run a provider in-process. */
  oidcFetch?: OidcFetch | undefined;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isAppPath(url: string): boolean {
  const path = url.split("?", 1)[0] ?? url;
  return (
    path === "/api" || path.startsWith("/api/") || path === "/auth" || path.startsWith("/auth/")
  );
}

function userPrincipal(auth: WebAuth) {
  return {
    kind: "user" as const,
    userId: auth.userId,
    username: auth.username,
    isAdmin: auth.isAdmin,
    levels: auth.levels,
  };
}

function denyUnless(
  reply: FastifyReply,
  rule: AccessRule,
  auth: WebAuth | undefined,
): FastifyReply | undefined {
  const decision = authorize(auth === undefined ? undefined : userPrincipal(auth), rule);
  if (decision.allowed) return undefined;
  return reply.code(DENIAL_HTTP_STATUS[decision.reason]).send({ error: decision.message });
}

function guard(rule: AccessRule): preHandlerHookHandler {
  return async (request, reply) => denyUnless(reply, rule, request.auth);
}

export const webPlugin: FastifyPluginAsync<WebOptions> = async (app, { env, pool, oidcFetch }) => {
  const mode =
    env.oidc === null ? await createLocalAuth(pool) : createOidcAuth(env.oidc, pool, oidcFetch);

  app.decorateRequest("auth", null as unknown as WebAuth | undefined);
  app.decorateRequest("sessionId", null as unknown as string | undefined);

  app.decorate("requireAuthenticated", guard("authenticated"));
  app.decorate("requireLevel", (resource: Resource, level: "read" | "write") =>
    guard({ resource, level }),
  );
  app.decorate("requireAnyLevel", (level: "read" | "write"): preHandlerHookHandler => {
    return async (request, reply) => {
      const auth = request.auth;
      if (auth === undefined) {
        return reply.code(401).send({ error: "Authentication required." });
      }
      const user = userPrincipal(auth);
      const allowed = RESOURCES.some(
        (resource) =>
          GRANTABLE_LEVELS[resource].includes(level) &&
          authorize(user, { resource, level }).allowed,
      );
      if (allowed) return undefined;
      const label = level === "read" ? "Read" : "Write";
      return reply.code(403).send({ error: `${label} access on at least one object is required.` });
    };
  });
  app.decorate("db", {
    pool,
    withActor<T>(request: FastifyRequest, fn: (tx: ActorTx) => Promise<T>) {
      if (request.auth === undefined) throw new Error("withActor requires an authenticated user");
      return withActor(pool, { name: request.auth.username, type: "human" }, fn);
    },
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (isAppPath(request.url)) reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (reply.getHeader("content-security-policy") === undefined) {
      reply.header("Content-Security-Policy", contentSecurityPolicy());
    }
    if (!/^(localhost|\[?::1\]?|127(\.\d{1,3}){3})$/i.test(request.hostname)) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });

  app.addHook("onRequest", async (request, reply) => {
    request.auth = undefined;
    request.sessionId = undefined;
    // Pages and files load the session only if they need it (see the fallback below).
    if (!isAppPath(request.url)) return;
    const origin = request.headers.origin;
    // Refused before the session loads, so a hostile page cannot extend or refresh anything.
    if (
      request.method === "OPTIONS" ||
      (origin !== undefined && mode.origin !== undefined && origin !== mode.origin)
    ) {
      return reply.code(403).send({ error: "Cross-origin request denied." });
    }
    await mode.loadSession(request, reply);
    if (!MUTATING_METHODS.has(request.method)) return;

    if (request.auth === undefined || request.sessionId === undefined) {
      return reply.code(401).send({ error: "Authentication required." });
    }
    const supplied = request.headers[CSRF_HEADER];
    if (
      (mode.origin !== undefined && origin !== mode.origin) ||
      !sameToken(
        csrfToken(mode.csrfSecret, request.sessionId),
        Array.isArray(supplied) ? undefined : supplied,
      )
    ) {
      return reply.code(403).send({ error: "CSRF validation failed." });
    }
  });

  app.get("/api/me", { preHandler: app.requireAuthenticated }, async (request, reply) => {
    const auth = request.auth;
    if (auth === undefined || request.sessionId === undefined) {
      return reply.code(401).send({ error: "Authentication required." });
    }
    reply.header("X-CSRF-Token", csrfToken(mode.csrfSecret, request.sessionId));
    return {
      user: {
        id: auth.userId,
        username: auth.username,
        displayName: auth.displayName ?? "",
        email: auth.email ?? "",
        isAdmin: auth.isAdmin,
      },
      levels: auth.levels,
    };
  });

  mode.registerRoutes(app);
  await registerFeatureRoutes(app, resolve(dirname(fileURLToPath(import.meta.url)), "routes"));
  installSpaFallback(app, env.staticWebDir, mode.loadSession);
};
