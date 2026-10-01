import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ActorType } from "@ytw/shared";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Logger } from "./logger.js";

/** Name of the request-id header, accepted on the way in and echoed on the way out. */
export const REQUEST_ID_HEADER = "x-request-id";

/** What an incoming `X-Request-Id` must look like to be reused; anything else is replaced. */
const VALID_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Fastify `genReqId`: reuses a well-formed `X-Request-Id` (so a request can be followed across a
 * proxy, the web server and the MCP server) and otherwise generates a UUID. A malformed value is
 * dropped rather than logged: the header is attacker-controlled and ends up in every log line.
 */
export function generateRequestId(request: IncomingMessage): string {
  const header = request.headers[REQUEST_ID_HEADER];
  if (typeof header === "string" && VALID_REQUEST_ID.test(header)) return header;
  return randomUUID();
}

/**
 * Fastify constructor options that wire the shared logger and request ids:
 * `Fastify({ ...fastifyLoggingOptions(logger), bodyLimit })`. They cannot be set from a plugin,
 * which is why this is a function of its own instead of part of {@link observabilityPlugin}.
 */
export function fastifyLoggingOptions(logger: Logger): {
  loggerInstance: FastifyBaseLogger;
  genReqId: typeof generateRequestId;
  requestIdHeader: false;
} {
  // Typed as FastifyBaseLogger so the resulting app is a plain `FastifyInstance`; with the narrower
  // pino `Logger` type it would not be assignable to the type apps and plugins declare.
  return { loggerInstance: logger, genReqId: generateRequestId, requestIdHeader: false };
}

/** Echoes the request id as `X-Request-Id` on every response, including errors and 404s. */
export const requestIdPlugin = fp(
  async (app) => {
    app.addHook("onRequest", async (request, reply) => {
      reply.header(REQUEST_ID_HEADER, request.id);
    });
  },
  { name: "ytw-request-id", fastify: "5.x" },
);

/**
 * Who is acting, for the audit-style fields on every log line after authentication. Mirrors the
 * `events` table (PRD 4): the actor name, human or agent, and for agents the token's id and name.
 * Never put the token itself in here.
 */
export interface LogActor {
  /** Username for humans, token name for agents (the `events.actor` value). */
  actor: string;
  actorType: ActorType;
  /** Agent calls: id and name of the API token, and the owner it acts for. */
  tokenId?: string;
  tokenName?: string;
  ownerId?: string;
  ownerUsername?: string;
  /** Human calls: id of the signed-in user. */
  userId?: string;
}

/** The fields a {@link LogActor} adds to a log line, without `undefined` entries. */
export function actorLogFields(actor: LogActor): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(actor)) {
    if (typeof value === "string" && value.length > 0) fields[key] = value;
  }
  return fields;
}

/** A child logger that stamps the actor on every line, usable outside Fastify as well. */
export function withActor<L extends FastifyBaseLogger | Logger>(logger: L, actor: LogActor): L {
  return logger.child(actorLogFields(actor)) as L;
}

const baseLoggers = new WeakMap<FastifyRequest, FastifyBaseLogger>();

/**
 * Binds the authenticated actor to the request: every later line from `request.log` and
 * `reply.log`, including Fastify's own "request completed" line, carries the actor fields.
 * Calling it again (for example after the actor is resolved more precisely) replaces the fields
 * instead of repeating them.
 */
export function bindActor(request: FastifyRequest, reply: FastifyReply, actor: LogActor): void {
  const base = baseLoggers.get(request) ?? request.log;
  baseLoggers.set(request, base);
  const bound = withActor(base, actor);
  request.log = bound;
  reply.log = bound;
}
