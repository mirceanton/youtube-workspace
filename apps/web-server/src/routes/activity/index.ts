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
// events.created_at defaults to transaction-start `now()`. A transaction can therefore commit
// after a newer event has already been polled. Rescan a bounded five-minute overlap so those late
// commits are found; event rows inside each response are collapsed to resource names below.
const POLL_OVERLAP = "5 minutes";

type PollPosition = { createdAt: string; id: string };
type PollRow = PollPosition & { entityType: string | null };
type PollCursor = { watermark: string; through: string | null; scan: PollPosition | null };
type ActivityCore = FastifyInstance & {
  requireLevel(resource: "activity", level: "read"): preHandlerHookHandler;
  requireAnyLevel(level: "read" | "write"): preHandlerHookHandler;
  db: { pool: Queryable };
};

function isPollTime(value: unknown): value is string {
  return (
    typeof value === "string" && POLL_TIME_PATTERN.test(value) && Number.isFinite(Date.parse(value))
  );
}

function isPosition(value: unknown): value is PollPosition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).toSorted().join(",") === "createdAt,id" &&
    isPollTime(row.createdAt) &&
    typeof row.id === "string" &&
    UUID_PATTERN.test(row.id)
  );
}

function encodeCursor(cursor: PollCursor): string {
  // Project every field explicitly. In particular, never serialize a runtime PollRow, whose
  // entityType could disclose events the caller cannot read.
  const payload = {
    watermark: cursor.watermark,
    through: cursor.through,
    scan: cursor.scan === null ? null : { createdAt: cursor.scan.createdAt, id: cursor.scan.id },
  };
  return `v2_${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function decodeCursor(encodedCursor: string): PollCursor | null {
  if (!/^v2_[A-Za-z0-9_-]{1,480}$/.test(encodedCursor)) return null;
  const encoded = encodedCursor.slice(3);
  try {
    const text = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(text, "utf8").toString("base64url") !== encoded) return null;
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).toSorted().join(",") !== "scan,through,watermark" ||
      !isPollTime(row.watermark) ||
      (row.through !== null && !isPollTime(row.through)) ||
      (row.scan !== null && !isPosition(row.scan)) ||
      (row.through !== null && Date.parse(row.through as string) < Date.parse(row.watermark)) ||
      (row.through === null && row.scan !== null)
    ) {
      return null;
    }
    return {
      watermark: row.watermark,
      through: row.through,
      scan: row.scan,
    } as PollCursor;
  } catch {
    return null;
  }
}

function initialCursor(pool: Queryable): Promise<PollCursor> {
  return pool
    .query<{ watermark: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS watermark`,
    )
    .then(({ rows }) => ({ watermark: rows[0]!.watermark, through: null, scan: null }));
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
          return reply.send({
            changed_resources: [],
            cursor: encodeCursor(await initialCursor(app.db.pool)),
            has_more: false,
          });
        }
        const cursor = decodeCursor(since);
        if (!cursor) return reply.code(400).send({ error: "since is not a valid event cursor" });
        const through =
          cursor.through ??
          (
            await app.db.pool.query<{ through: string }>(
              `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS through`,
            )
          ).rows[0]!.through;
        const { rows } = cursor.scan
          ? await app.db.pool.query<PollRow>(
              `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
                      id::text AS id, entity_type AS "entityType"
                 FROM public.events
                WHERE (created_at, id) > ($1::timestamptz, $2::uuid)
                  AND created_at <= $3::timestamptz
                ORDER BY created_at ASC, id ASC
                LIMIT $4::integer`,
              [cursor.scan.createdAt, cursor.scan.id, through, POLL_BATCH_SIZE + 1],
            )
          : await app.db.pool.query<PollRow>(
              `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
                      id::text AS id, entity_type AS "entityType"
                 FROM public.events
                WHERE created_at >= ($1::timestamptz - interval '${POLL_OVERLAP}')
                  AND created_at <= $2::timestamptz
                ORDER BY created_at ASC, id ASC
                LIMIT $3::integer`,
              [cursor.watermark, through, POLL_BATCH_SIZE + 1],
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
        const nextCursor: PollCursor = hasMore
          ? {
              watermark: cursor.watermark,
              through,
              scan: last ? { createdAt: last.createdAt, id: last.id } : null,
            }
          : { watermark: through, through: null, scan: null };
        return reply.send({
          changed_resources: [...changed],
          cursor: encodeCursor(nextCursor),
          has_more: hasMore,
        });
      } catch (error) {
        return sendFailure(reply, error);
      }
    },
  );
}
