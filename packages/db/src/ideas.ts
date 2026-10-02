/**
 * Typed wrappers for ideas (migration 0031): `create_idea`, `update_idea`, `advance_idea`,
 * `archive_idea`, and `getIdea` to read one back. Owned by task T12 (docs/orchestration/PLAN.md
 * section 3); behaviour and error codes: docs/database.md, "Ideas, scripts and notes".
 *
 * Writes take the transaction of {@link withActor} and pass the actor to the database function, so
 * the audit log names who did it. Database errors arrive typed (errors.ts): a stale
 * `expectedVersion` is a {@link VersionConflictError} whose `latestVersion` is the current version,
 * a stage move the rules forbid is an {@link InvalidTransitionError} listing the valid next stages
 * in `allowed`, a missing note for a move back is a {@link ValidationError} with `field` "note".
 */
import type { IdeaStage } from "@ytw/shared/constants";
import { rejectNul, requireInteger, requireUuid } from "./args.js";
import type { ActorTx, Queryable } from "./client.js";
import { ValidationError } from "./errors.js";

/** An idea as stored (PRD 4 "ideas"). */
export interface IdeaRecord {
  id: string;
  title: string;
  pitch: string | null;
  /** The stage. Changed only by {@link advanceIdea}. */
  status: IdeaStage;
  /** When the idea entered its current stage ("age in stage"). */
  statusChangedAt: Date;
  /** Priority from 0 to 100, higher is better; null when not scored. */
  score: number | null;
  source: string | null;
  tags: string[];
  /** Optimistic-concurrency version: pass it as `expectedVersion` when editing. */
  version: number;
  /** Set when the idea was archived (soft delete); an archived idea is read-only. */
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}

/** Column list of the `ideas` composite, aliased to {@link IdeaRecord}; `from` qualifies the columns. */
function ideaColumns(from: string): string {
  const columns: readonly (readonly [string, string])[] = [
    ["id", "id"],
    ["title", "title"],
    ["pitch", "pitch"],
    ["status", "status"],
    ["status_changed_at", "statusChangedAt"],
    ["score", "score"],
    ["source", "source"],
    ["tags", "tags"],
    ["version", "version"],
    ["archived_at", "archivedAt"],
    ["created_at", "createdAt"],
    ["updated_at", "updatedAt"],
    ["created_by", "createdBy"],
    ["updated_by", "updatedBy"],
  ];
  return columns.map(([column, alias]) => `${from}${column} AS "${alias}"`).join(", ");
}

const IDEA_COLUMNS = ideaColumns("");

export interface CreateIdeaInput {
  /** 1-500 characters. */
  title: string;
  /** Up to 20 000 characters. */
  pitch?: string | null;
  /** Where the idea came from (1-200 characters); null when unknown. */
  source?: string | null;
  /** At most 50 distinct tags of 1-64 characters, without surrounding spaces. */
  tags?: readonly string[];
  /** Whole number from 0 to 100. */
  score?: number | null;
}

/** Inserts an idea in the `inbox` (`create_idea`). */
export async function createIdea(tx: ActorTx, input: CreateIdeaInput): Promise<IdeaRecord> {
  const score = input.score ?? null;
  if (score !== null) {
    requireScore(score);
  }
  rejectNul("title", input.title);
  rejectNul("pitch", input.pitch);
  rejectNul("source", input.source);
  input.tags?.forEach((tag) => rejectNul("tags", tag));
  const { rows } = await tx.query<IdeaRecord>(
    `SELECT ${IDEA_COLUMNS}
       FROM public.create_idea($1::text, $2::text, $3::uuid, $4::text, $5::text, $6::text,
                               $7::text[], $8::integer)`,
    [
      tx.actor.name,
      tx.actor.type,
      tx.actor.tokenId,
      input.title,
      input.pitch ?? null,
      input.source ?? null,
      [...(input.tags ?? [])],
      score,
    ],
  );
  return firstRow(rows, "create_idea");
}

/** The editable fields. A field that is present is set; `null` clears pitch, source and score. */
export interface IdeaFields {
  title?: string;
  pitch?: string | null;
  source?: string | null;
  /** Replaces the whole list. */
  tags?: readonly string[];
  score?: number | null;
}

export interface UpdateIdeaInput {
  id: string;
  /** The `version` of the idea the caller read. */
  expectedVersion: number;
  fields: IdeaFields;
}

/**
 * Edits the non-status fields of an idea (`update_idea`). Fails with {@link VersionConflictError}
 * (`latestVersion`) when the idea changed since `expectedVersion`. Saving the stored values again
 * changes nothing: the same record comes back, with the same version.
 */
export async function updateIdea(tx: ActorTx, input: UpdateIdeaInput): Promise<IdeaRecord> {
  requireUuid("id", input.id);
  requireInteger("expected_version", input.expectedVersion);
  const { title, pitch, source, tags, score } = input.fields;
  if (typeof score === "number") {
    requireScore(score);
  }
  rejectNul("title", title);
  rejectNul("pitch", pitch);
  rejectNul("source", source);
  tags?.forEach((tag) => rejectNul("tags", tag));
  const { rows } = await tx.query<IdeaRecord>(
    `SELECT ${IDEA_COLUMNS}
       FROM public.update_idea($1::text, $2::text, $3::uuid, $4::uuid, $5::integer, $6::jsonb)`,
    [
      tx.actor.name,
      tx.actor.type,
      tx.actor.tokenId,
      input.id,
      input.expectedVersion,
      JSON.stringify(input.fields),
    ],
  );
  return firstRow(rows, "update_idea");
}

export interface ArchiveIdeaInput {
  id: string;
  /** Fail with a version conflict unless the idea is still at this version. */
  expectedVersion?: number;
}

/** Archives an idea (`archive_idea`, soft delete). Archiving an archived idea changes nothing. */
export async function archiveIdea(tx: ActorTx, input: ArchiveIdeaInput): Promise<IdeaRecord> {
  requireUuid("id", input.id);
  if (input.expectedVersion !== undefined) {
    requireInteger("expected_version", input.expectedVersion);
  }
  const { rows } = await tx.query<IdeaRecord>(
    `SELECT ${IDEA_COLUMNS}
       FROM public.archive_idea($1::text, $2::text, $3::uuid, $4::uuid, $5::integer)`,
    [tx.actor.name, tx.actor.type, tx.actor.tokenId, input.id, input.expectedVersion ?? null],
  );
  return firstRow(rows, "archive_idea");
}

export interface AdvanceIdeaInput {
  id: string;
  /** The stage to move to; the stage rules (PRD 4) decide whether that is allowed. */
  newStatus: IdeaStage;
  /**
   * Why: required for a move back one stage, welcome for any other move. Saved as a note on the
   * idea in the same transaction.
   */
  note?: string | null;
  /** Fail with a version conflict unless the idea is still at this version. */
  expectedVersion?: number;
}

export interface AdvanceIdeaResult {
  /** The idea after the move. */
  idea: IdeaRecord;
  /** The note written with the move, or null when none was given. */
  noteId: string | null;
}

/**
 * Moves an idea to another stage (`advance_idea`). Forward one stage, back one stage with a note,
 * any stage to `dropped`, `dropped` to `inbox`; anything else fails with an
 * {@link InvalidTransitionError} that lists the valid next stages.
 */
export async function advanceIdea(
  tx: ActorTx,
  input: AdvanceIdeaInput,
): Promise<AdvanceIdeaResult> {
  requireUuid("id", input.id);
  if (input.expectedVersion !== undefined) {
    requireInteger("expected_version", input.expectedVersion);
  }
  rejectNul("new_status", input.newStatus);
  rejectNul("note", input.note);
  const { rows } = await tx.query<IdeaRecord & { noteId: string | null }>(
    `SELECT ${ideaColumns("(a.idea).")}, a.note_id AS "noteId"
       FROM public.advance_idea($1::text, $2::text, $3::uuid, $4::uuid, $5::text, $6::text,
                                $7::integer) AS a`,
    [
      tx.actor.name,
      tx.actor.type,
      tx.actor.tokenId,
      input.id,
      input.newStatus,
      input.note ?? null,
      input.expectedVersion ?? null,
    ],
  );
  const { noteId, ...idea } = firstRow(rows, "advance_idea");
  return { idea, noteId };
}

/** One idea by id (archived ones included), or null. Needs only SELECT on `ideas`. */
export async function getIdea(db: Queryable, id: string): Promise<IdeaRecord | null> {
  requireUuid("id", id);
  const { rows } = await db.query<IdeaRecord>(
    `SELECT ${IDEA_COLUMNS} FROM public.ideas WHERE id = $1::uuid`,
    [id],
  );
  return rows[0] ?? null;
}

function firstRow<R>(rows: R[], fn: string): R {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`${fn} returned no row`);
  }
  return row;
}

/** A score that would reach the database as something other than a whole 32-bit integer. */
function requireScore(score: number): void {
  if (!Number.isInteger(score) || Math.abs(score) > 2_147_483_647) {
    throw new ValidationError(`score must be a whole number from 0 to 100 (got ${String(score)})`, {
      field: "score",
      value: String(score),
    });
  }
}
