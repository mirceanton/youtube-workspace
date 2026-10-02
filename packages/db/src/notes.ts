/**
 * Typed wrappers for notes (migration 0033): `add_note`, and `listNotes` to read the comments on
 * one entity. Owned by task T12 (docs/orchestration/PLAN.md section 3); behaviour and error codes:
 * docs/database.md, "Ideas, scripts and notes".
 *
 * Notes are append-only comments by people and agents on an idea, a script revision, a video or an
 * experiment. {@link NoteRecord} carries the same facts as the `/api/notes` contract
 * (`@ytw/shared/api/notes`), in camelCase with real `Date`s; routes map it to that shape.
 */
import type { ActorType, NoteEntityType } from "@ytw/shared/constants";
import { rejectNul, requireUuid } from "./args.js";
import type { ActorTx, Queryable } from "./client.js";

export interface NoteRecord {
  id: string;
  entityType: NoteEntityType;
  /** The id of the idea, script revision, video or experiment. */
  entityId: string;
  /** Who wrote it: a username, or the name of the API token. */
  author: string;
  actorType: ActorType;
  /** Raw markdown: render it sanitised, never as HTML. */
  bodyMd: string;
  createdAt: Date;
  updatedAt: Date;
}

const NOTE_COLUMNS = `id, entity_type AS "entityType", entity_id AS "entityId", author,
       actor_type AS "actorType", body_md AS "bodyMd", created_at AS "createdAt",
       updated_at AS "updatedAt"`;

export interface AddNoteInput {
  entityType: NoteEntityType;
  /** The id of the entity: for a script, the revision's own id. */
  entityId: string;
  /** Not blank, at most 64 KiB of UTF-8 (`NOTE_BODY_MAX_BYTES`). */
  bodyMd: string;
}

/**
 * Adds a comment (`add_note`) and returns it. An unknown `entityType` is a
 * {@link ValidationError} listing the valid ones; an entity that does not exist is a
 * {@link NotFoundError}.
 */
export async function addNote(tx: ActorTx, input: AddNoteInput): Promise<NoteRecord> {
  requireUuid("entity_id", input.entityId);
  rejectNul("entity_type", input.entityType);
  rejectNul("body_md", input.bodyMd);
  const { rows } = await tx.query<NoteRecord>(
    `SELECT ${NOTE_COLUMNS}
       FROM public.add_note($1::text, $2::text, $3::uuid, $4::text, $5::uuid, $6::text)`,
    [
      tx.actor.name,
      tx.actor.type,
      tx.actor.tokenId,
      input.entityType,
      input.entityId,
      input.bodyMd,
    ],
  );
  const note = rows[0];
  if (note === undefined) {
    throw new Error("add_note returned no row");
  }
  return note;
}

export interface ListNotesInput {
  entityType: NoteEntityType;
  entityId: string;
}

/** Every note on the entity, oldest first. Needs only SELECT on `notes`. */
export async function listNotes(db: Queryable, input: ListNotesInput): Promise<NoteRecord[]> {
  requireUuid("entity_id", input.entityId);
  const { rows } = await db.query<NoteRecord>(
    `SELECT ${NOTE_COLUMNS}
       FROM public.notes
      WHERE entity_type = $1::text AND entity_id = $2::uuid
      ORDER BY created_at, id`,
    [input.entityType, input.entityId],
  );
  return rows;
}
