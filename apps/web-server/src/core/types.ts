import type { ActorTx, UserAccess } from "@ytw/db";
import type { Resource } from "@ytw/shared/constants";
import type { FastifyRequest, preHandlerHookHandler } from "fastify";
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
  /** Plain reads use the process's least-privilege `ytw_web` pool. */
  pool: Pool;
  /** Mutations bind the current human as the transaction's audit actor. */
  withActor<T>(request: FastifyRequest, fn: (client: ActorTx) => Promise<T>): Promise<T>;
}

export interface SecurityRouteRecord {
  method: string;
  url: string;
  guarded: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: WebAuth | undefined;
    sessionId: string | undefined;
  }

  interface FastifyInstance {
    db: WebDatabase;
    requireLevel(resource: Resource, level: "read" | "write"): preHandlerHookHandler;
    /** Snapshot used by the authorization coverage test; feature plugins are included. */
    securityRoutes(): readonly SecurityRouteRecord[];
  }
}

/** Permission level type exported for feature route modules. */
