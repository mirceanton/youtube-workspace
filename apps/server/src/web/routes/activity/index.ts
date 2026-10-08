import { listEvents, toClientError, type Queryable } from "@ytw/db";
import {
  ACTIVITY_CHANGES_PATH,
  ACTIVITY_PATH,
  activityChangesQuerySchema,
  listActivityQuerySchema,
} from "@ytw/shared/api/activity";
import type { Resource } from "@ytw/shared/constants";
import type { FastifyInstance, FastifyReply } from "fastify";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { WebAuth } from "../../types.js";

const POLL_BATCH_SIZE = 250;
const POLL_CURSOR_MAX_LENGTH = 8192;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const PG_SNAPSHOT_PATTERN = /^\d+:\d+:(?:\d+(?:,\d+)*)?$/;

type PollPosition = { createdAt: string; id: string };
type PollRow = PollPosition & { entityType: string | null };
type PollCursor = { snapshot: string; through: string | null; scan: PollPosition | null };
function isPollTime(value: unknown): value is string {
  return (
    typeof value === "string" && POLL_TIME_PATTERN.test(value) && Number.isFinite(Date.parse(value))
  );
}

function isPgSnapshot(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 65_536 || !PG_SNAPSHOT_PATTERN.test(value)) {
    return false;
  }
  try {
    const [xminText, xmaxText, xipText] = value.split(":");
    if (xminText === undefined || xmaxText === undefined || xipText === undefined) return false;
    if (
      xminText.length > 20 ||
      xmaxText.length > 20 ||
      (xipText !== "" && xipText.split(",").some((xidText) => xidText.length > 20))
    ) {
      return false;
    }
    const xmin = BigInt(xminText);
    const xmax = BigInt(xmaxText);
    const xid8Max = 18_446_744_073_709_551_615n;
    if (xmin > xmax || xmax > xid8Max) return false;
    let previous = xmin - 1n;
    for (const xidText of xipText === "" ? [] : xipText.split(",")) {
      const xid = BigInt(xidText);
      if (xid < xmin || xid >= xmax || xid <= previous || xid > xid8Max) return false;
      previous = xid;
    }
    return true;
  } catch {
    return false;
  }
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
  // entityType could disclose events the caller cannot read. Compress snapshot xids so the cursor
  // remains small when several database transactions are active.
  const payload = {
    snapshot: cursor.snapshot,
    through: cursor.through,
    scan: cursor.scan === null ? null : { createdAt: cursor.scan.createdAt, id: cursor.scan.id },
  };
  return `v3_${deflateRawSync(Buffer.from(JSON.stringify(payload), "utf8")).toString("base64url")}`;
}

function decodeCursor(encodedCursor: string): PollCursor | null {
  if (
    encodedCursor.length > POLL_CURSOR_MAX_LENGTH ||
    !/^v3_[A-Za-z0-9_-]{1,8189}$/.test(encodedCursor)
  ) {
    return null;
  }
  const encoded = encodedCursor.slice(3);
  try {
    const compressed = Buffer.from(encoded, "base64url");
    if (compressed.toString("base64url") !== encoded) return null;
    const text = inflateRawSync(compressed, { maxOutputLength: 65_536 }).toString("utf8");
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).toSorted().join(",") !== "scan,snapshot,through" ||
      !isPgSnapshot(row.snapshot) ||
      (row.through !== null && !isPgSnapshot(row.through)) ||
      (row.scan !== null && !isPosition(row.scan)) ||
      (row.through !== null &&
        BigInt(row.through.split(":")[1]!) < BigInt(row.snapshot.split(":")[1]!)) ||
      (row.through === null && row.scan !== null) ||
      (row.through !== null && row.scan === null)
    ) {
      return null;
    }
    return {
      snapshot: row.snapshot,
      through: row.through,
      scan: row.scan,
    } as PollCursor;
  } catch {
    return null;
  }
}

function initialCursor(pool: Queryable): Promise<PollCursor> {
  return pool
    .query<{ snapshot: string }>(`SELECT pg_current_snapshot()::text AS snapshot`)
    .then(({ rows }) => ({ snapshot: rows[0]!.snapshot, through: null, scan: null }));
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

function readableEventTypes(auth: WebAuth): string[] | null {
  if (effectiveCanRead(auth, "activity")) return null;
  const readable: string[] = [];
  if (effectiveCanRead(auth, "ideas")) readable.push("idea", "ideas");
  if (effectiveCanRead(auth, "scripts")) readable.push("script", "scripts");
  if (effectiveCanRead(auth, "videos")) {
    readable.push("video", "videos", "video_metric", "video_metrics");
  }
  if (effectiveCanRead(auth, "experiments")) {
    readable.push("experiment", "experiments", "experiment_variant", "experiment_variants");
  }
  if (effectiveCanRead(auth, "notes")) readable.push("note", "notes");
  return readable;
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
  const app = server;

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
              `SELECT pg_current_snapshot()::text AS through`,
            )
          ).rows[0]!.through;
        const allowedEventTypes = readableEventTypes(auth);
        const scanPredicate = cursor.scan
          ? "AND (created_at, id) > ($4::timestamptz, $5::uuid)"
          : "";
        const params = cursor.scan
          ? [
              cursor.snapshot,
              through,
              allowedEventTypes,
              cursor.scan.createdAt,
              cursor.scan.id,
              POLL_BATCH_SIZE + 1,
            ]
          : [cursor.snapshot, through, allowedEventTypes, POLL_BATCH_SIZE + 1];
        const limitParameter = cursor.scan ? "$6" : "$4";
        const { rows } = await app.db.pool.query<PollRow>(
          `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
                  id::text AS id, entity_type AS "entityType"
             FROM public.events
            WHERE transaction_xid < pg_snapshot_xmax($2::pg_snapshot)
              AND (
                transaction_xid >= pg_snapshot_xmax($1::pg_snapshot)
                OR EXISTS (
                  SELECT 1
                    FROM pg_snapshot_xip($1::pg_snapshot) AS previous_active(xid)
                   WHERE previous_active.xid = events.transaction_xid
                )
              )
              AND NOT pg_visible_in_snapshot(transaction_xid, $1::pg_snapshot)
              AND pg_visible_in_snapshot(transaction_xid, $2::pg_snapshot)
              AND ($3::text[] IS NULL OR entity_type = ANY($3::text[]))
              ${scanPredicate}
            ORDER BY created_at ASC, id ASC
            LIMIT ${limitParameter}::integer`,
          params,
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
              snapshot: cursor.snapshot,
              through,
              scan: last ? { createdAt: last.createdAt, id: last.id } : null,
            }
          : { snapshot: through, through: null, scan: null };
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
