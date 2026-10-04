import { listEvents, toClientError, type Queryable } from "@ytw/db";
import {
  ACTIVITY_CHANGES_PATH,
  ACTIVITY_PATH,
  activityChangesQuerySchema,
  listActivityQuerySchema,
} from "@ytw/shared/api/activity";
import type { Resource } from "@ytw/shared/constants";
import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from "fastify";
import type { WebAuth } from "../../core/types.js";

const POLL_BATCH_SIZE = 250;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const FIRST_POSITION = {
  createdAt: "1970-01-01T00:00:00.000000Z",
  id: "00000000-0000-0000-0000-000000000000",
};

type PollPosition = { createdAt: string; id: string };
type PollRow = PollPosition & { entityType: string | null };
type ActivityCore = FastifyInstance & {
  requireLevel(resource: "activity", level: "read"): preHandlerHookHandler;
  requireAnyLevel(level: "read" | "write"): preHandlerHookHandler;
  db: { pool: Queryable };
};

function encodePosition(position: PollPosition): string {
  return `v1_${Buffer.from(JSON.stringify(position), "utf8").toString("base64url")}`;
}

function decodePosition(cursor: string): PollPosition | null {
  if (!/^v1_[A-Za-z0-9_-]{1,480}$/.test(cursor)) return null;
  const encoded = cursor.slice(3);
  try {
    const text = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(text, "utf8").toString("base64url") !== encoded) return null;
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { createdAt, id } = value as { createdAt?: unknown; id?: unknown };
    if (
      typeof createdAt !== "string" ||
      !POLL_TIME_PATTERN.test(createdAt) ||
      !Number.isFinite(Date.parse(createdAt)) ||
      typeof id !== "string" ||
      !UUID_PATTERN.test(id)
    ) {
      return null;
    }
    return { createdAt, id };
  } catch {
    return null;
  }
}

function cursorFor(row: PollPosition): string {
  return encodePosition(row);
}

function initialCursor(pool: Queryable): Promise<PollPosition | null> {
  return pool
    .query<PollPosition>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
              id::text AS id
         FROM public.events
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    )
    .then(({ rows }) => rows[0] ?? null);
}

function eventResource(entityType: string | null): Resource {
  switch (entityType) {
    case "ideas":
    case "idea":
      return "ideas";
    case "scripts":
    case "script":
      return "scripts";
    case "videos":
    case "video":
    case "video_metric":
    case "video_metrics":
      return "videos";
    case "experiment":
    case "experiments":
    case "experiment_variant":
    case "experiment_variants":
      return "experiments";
    case "note":
    case "notes":
      return "notes";
    default:
      // Identity, permission and token events are activity metadata. Only activity readers learn
      // that such an event exists; its actor, entity id and payload are never in this response.
      return "activity";
  }
}

function effectiveCanRead(auth: WebAuth, resource: Resource): boolean {
  return auth.isAdmin || auth.levels[resource] !== "none";
}

function sendFailure(reply: FastifyReply, error: unknown) {
  const clientError = toClientError(error);
  return reply.code(clientError.status).send({
    error: clientError.message,
    code: clientError.error,
    ...(clientError.hint === undefined ? {} : { hint: clientError.hint }),
    details: clientError.details,
  });
}

/** Activity listing and compact, permission-filtered change hints for the SPA's live poll. */
export default async function activityRoutes(server: FastifyInstance): Promise<void> {
  const app = server as ActivityCore;

  app.get(
    ACTIVITY_PATH,
    { preHandler: app.requireLevel("activity", "read") },
    async (request, reply) => {
      const parsed = listActivityQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message ?? "Invalid filters" });
      }
      try {
        const result = await listEvents(app.db.pool, {
          ...(parsed.data.actor === undefined ? {} : { actor: parsed.data.actor }),
          ...(parsed.data.actor_type === undefined ? {} : { actorType: parsed.data.actor_type }),
          ...(parsed.data.entity_type === undefined ? {} : { entityType: parsed.data.entity_type }),
          ...(parsed.data.entity_id === undefined ? {} : { entityId: parsed.data.entity_id }),
          ...(parsed.data.from === undefined ? {} : { from: parsed.data.from }),
          ...(parsed.data.to === undefined ? {} : { to: parsed.data.to }),
          limit: parsed.data.limit,
          ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
        });
        return reply.send({
          events: result.events.map((event) => ({
            id: event.id,
            created_at: event.createdAt.toISOString(),
            actor: event.actor,
            actor_type: event.actorType,
            token_id: event.tokenId,
            action: event.action,
            entity_type: event.entityType,
            entity_id: event.entityId,
            payload: event.payload,
          })),
          next_cursor: result.nextCursor,
        });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );

  app.get(
    ACTIVITY_CHANGES_PATH,
    { preHandler: app.requireAnyLevel("read") },
    async (request, reply) => {
      const parsedQuery = activityChangesQuerySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        return reply
          .code(400)
          .send({ error: parsedQuery.error.issues[0]?.message ?? "Invalid poll cursor" });
      }
      const since = parsedQuery.data.since;
      const auth = request.auth;
      if (!auth) return reply.code(401).send({ error: "Authentication required." });

      try {
        if (since === undefined) {
          const latest = await initialCursor(app.db.pool);
          return reply.send({
            changed_resources: [],
            cursor: latest ? cursorFor(latest) : cursorFor(FIRST_POSITION),
            has_more: false,
          });
        }
        const position = decodePosition(since);
        if (!position) return reply.code(400).send({ error: "since is not a valid event cursor" });
        const { rows } = await app.db.pool.query<PollRow>(
          `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
                  id::text AS id, entity_type AS "entityType"
             FROM public.events
            WHERE (created_at, id) > ($1::timestamptz, $2::uuid)
            ORDER BY created_at ASC, id ASC
            LIMIT $3::integer`,
          [position.createdAt, position.id, POLL_BATCH_SIZE + 1],
        );
        const hasMore = rows.length > POLL_BATCH_SIZE;
        const page = rows.slice(0, POLL_BATCH_SIZE);
        const changed = new Set<Resource>();
        for (const row of page) {
          const resource = eventResource(row.entityType);
          if (effectiveCanRead(auth, resource)) changed.add(resource);
          if (effectiveCanRead(auth, "activity")) changed.add("activity");
        }
        const last = page.at(-1);
        return reply.send({
          changed_resources: [...changed],
          cursor: last ? cursorFor(last) : since,
          has_more: hasMore,
        });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );
}
