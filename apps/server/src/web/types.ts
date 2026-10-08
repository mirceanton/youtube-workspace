import type { ActorTx, UserAccess } from "@ytw/db";
import type { Resource } from "@ytw/shared/constants";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Pool } from "pg";

/** Authenticated human and the current database view of their permissions. */
export interface WebAuth {
  userId: string;
  username: string;
  isAdmin: boolean;
  levels: UserAccess["levels"];
  displayName: string | null;
  email: string | null;
}

export interface WebDatabase {
  /** Plain reads. */
  pool: Pool;
  /** Mutations bind the current human as the transaction's audit actor. */
  withActor<T>(request: FastifyRequest, fn: (client: ActorTx) => Promise<T>): Promise<T>;
}

/**
 * How the web group learns who is calling. OIDC login and single-user mode differ only here; the
 * guards, CSRF check, `/api/me` and the feature routes work on what these return.
 */
export interface AuthMode {
  /** Secret the CSRF tokens are derived from. */
  readonly csrfSecret: string;
  /**
   * The one origin browsers may call from. When set, a request that names another origin is
   * refused and mutations must name this one. Single-user mode has none: its CSRF token, which a
   * foreign site cannot read, is the protection.
   */
  readonly origin: string | undefined;
  /** Sets `request.auth` and `request.sessionId` from the request's credentials, or leaves them unset. */
  loadSession(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** Registers the `/auth/*` routes. */
  registerRoutes(app: FastifyInstance): void;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: WebAuth | undefined;
    sessionId: string | undefined;
  }

  interface FastifyInstance {
    db: WebDatabase;
    /** Require a signed-in user, whatever their levels. */
    requireAuthenticated: preHandlerHookHandler;
    requireLevel(resource: Resource, level: "read" | "write"): preHandlerHookHandler;
    /** Require a level on at least one resource, using this request's current database-backed auth. */
    requireAnyLevel(level: "read" | "write"): preHandlerHookHandler;
  }
}

/** Turns the database's view of a user into the request's identity (none for revoked access). */
export function toWebAuth(user: UserAccess | null): WebAuth | undefined {
  if (user === null || user.accessRevokedAt !== null) return undefined;
  return {
    userId: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    levels: user.levels,
    displayName: user.displayName,
    email: user.email,
  };
}
