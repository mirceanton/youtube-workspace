/**
 * Single-user mode, for a server without `OIDC_*`: nobody signs in, every web request is the local
 * owner, a real user (the first one, so an admin) made through the normal login function. There are
 * no cookies; the CSRF token comes from a secret that lives as long as the process, so it still
 * protects against other sites in the owner's browser, which cannot read `/api/me`.
 */
import { randomBytes } from "node:crypto";
import { getUserAccess, upsertUserOnLogin, withActor } from "@ytw/db";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { toWebAuth, type AuthMode } from "./types.js";

export const LOCAL_OWNER = {
  issuer: "local",
  sub: "owner",
  username: "owner",
  displayName: "Owner",
  // /api/me always carries an email; this one only keeps that contract.
  email: "owner@localhost",
} as const;

/** Stands in for the session id when the CSRF token is derived. */
const LOCAL_SESSION_ID = "local";

export async function createLocalAuth(pool: Pool): Promise<AuthMode> {
  const owner = await withActor(pool, { name: LOCAL_OWNER.username, type: "human" }, (tx) =>
    upsertUserOnLogin(tx, {
      issuer: LOCAL_OWNER.issuer,
      sub: LOCAL_OWNER.sub,
      username: LOCAL_OWNER.username,
      email: LOCAL_OWNER.email,
      displayName: LOCAL_OWNER.displayName,
    }),
  );

  return {
    csrfSecret: randomBytes(32).toString("base64url"),
    origin: undefined,
    async loadSession(request) {
      // The owner's levels are read on every request, like anyone's: they can be edited in Settings.
      request.auth = toWebAuth(await getUserAccess(pool, owner.id));
      request.sessionId = request.auth === undefined ? undefined : LOCAL_SESSION_ID;
    },
    registerRoutes(app: FastifyInstance) {
      // The SPA sends people here when it needs a login or wants to sign out; there is neither.
      app.get("/auth/login", async (_request, reply) => reply.redirect("/", 302));
      app.get("/auth/logout", async (_request, reply) => reply.redirect("/", 302));
    },
  };
}
