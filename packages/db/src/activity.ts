/**
 * Typed wrapper for the activity feed (migration 0064): `list_events`. Owned by task T15
 * (docs/orchestration/PLAN.md section 3); behaviour: docs/database.md, "Views, search and activity
 * (T15)".
 *
 * Events come newest first. A page ends with an opaque `nextCursor`; pass it back unchanged, with the
 * same filters, to get the events right behind the page. Events written between two calls never make
 * a page repeat or skip a row, because they sort in front of every cursor. Payloads are returned as
 * stored: the audit layer redacted them when it wrote them. The service checks the `activity`
 * level before it calls this.
 */
import type { ActorType } from "@ytw/shared/constants";
import { ACTOR_TYPES } from "@ytw/shared/constants";
import { rejectNul, requireUuid } from "./args.js";
import type { Queryable } from "./client.js";
import { formatAllowed, toDbError, ValidationError } from "./errors.js";
import { instantText } from "./value-args.js";

/** Events per page when no limit is given. */
export const EVENTS_LIMIT_DEFAULT = 50;
/** The largest page; a bigger limit is a validation error. */
export const EVENTS_LIMIT_MAX = 100;

/** One row of the audit log (PRD 4 "events"). */
export interface EventRecord {
  id: string;
  /** When the writing transaction started. */
  createdAt: Date;
  /** The username (people) or the API token's name (agents). */
  actor: string;
  actorType: ActorType;
  /** The API token of an agent's action; null for people. */
  tokenId: string | null;
  /** `insert`, `update`, `delete`, or a dotted name such as `tool.call`. */
  action: string;
  entityType: string | null;
  entityId: string | null;
  /** The payload as stored (already redacted by the audit layer). */
  payload: Record<string, unknown>;
}

export interface ListEventsInput {
  /** Only events of this actor (exact name). */
  actor?: string;
  /** Only events of people (`human`) or of agents (`agent`). */
  actorType?: ActorType;
  /** Only events about this kind of record, e.g. `idea` (exact). */
  entityType?: string;
  /** Only events about this record. */
  entityId?: string;
  /** Only events whose action starts with this text, e.g. `tool.` (a plain prefix, no wildcards). */
  actionPrefix?: string;
  /** Only events at or after this time (a `Date`, or ISO text with a time zone). */
  from?: Date | string;
  /** Only events before this time. */
  to?: Date | string;
  /** 1 to {@link EVENTS_LIMIT_MAX} (default {@link EVENTS_LIMIT_DEFAULT}). */
  limit?: number;
  /** The `nextCursor` of the previous page, with the same filters. */
  cursor?: string;
}

export interface EventPage {
  /** Newest first. */
  events: EventRecord[];
  /** Pass as `cursor` for the next page; null when this was the last. */
  nextCursor: string | null;
}

interface EventRow extends EventRecord {
  nextCursor: string | null;
}

/** One page of the audit log, newest first, optionally filtered. */
export async function listEvents(db: Queryable, input: ListEventsInput = {}): Promise<EventPage> {
  if (input.actorType !== undefined && !ACTOR_TYPES.includes(input.actorType)) {
    throw new ValidationError(
      `actor_type must be one of ${formatAllowed(ACTOR_TYPES)} (got ${JSON.stringify(String(input.actorType).slice(0, 60))})`,
      { field: "actor_type", allowed: [...ACTOR_TYPES] },
    );
  }
  if (input.entityId !== undefined) {
    requireUuid("entity_id", input.entityId);
  }
  const limit = input.limit ?? EVENTS_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > EVENTS_LIMIT_MAX) {
    throw new ValidationError(
      `limit must be a whole number from 1 to ${String(EVENTS_LIMIT_MAX)} (got ${String(limit)})`,
      { field: "limit", value: String(limit), min: 1, max: EVENTS_LIMIT_MAX },
    );
  }
  rejectNul("actor", input.actor);
  rejectNul("entity_type", input.entityType);
  rejectNul("action_prefix", input.actionPrefix);
  rejectNul("cursor", input.cursor);
  const from = input.from === undefined ? null : instantText("from", input.from);
  const to = input.to === undefined ? null : instantText("to", input.to);
  try {
    const { rows } = await db.query<EventRow>(
      `SELECT id, created_at AS "createdAt", actor, actor_type AS "actorType",
              token_id AS "tokenId", action, entity_type AS "entityType",
              entity_id AS "entityId", payload, next_cursor AS "nextCursor"
         FROM public.list_events($1::text, $2::text, $3::text, $4::uuid, $5::text,
                                 $6::timestamptz, $7::timestamptz, $8::integer, $9::text)`,
      [
        input.actor ?? null,
        input.actorType ?? null,
        input.entityType ?? null,
        input.entityId ?? null,
        input.actionPrefix ?? null,
        from,
        to,
        limit,
        input.cursor ?? null,
      ],
    );
    return {
      events: rows.map(({ nextCursor: _next, ...event }) => event),
      nextCursor: rows[0]?.nextCursor ?? null,
    };
  } catch (err) {
    throw toDbError(err);
  }
}
