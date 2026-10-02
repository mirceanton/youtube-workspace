/**
 * Typed wrappers for scripts (migration 0032): `save_script_version`, `set_script_status`, and
 * `getScriptVersion` to read a revision back. Owned by task T12 (docs/orchestration/PLAN.md
 * section 3); behaviour and error codes: docs/database.md, "Ideas, scripts and notes".
 *
 * A script (or packaging doc) is an append-only list of revisions per idea and kind. Saving always
 * appends a `draft` and needs the version the caller edited: when somebody saved in between, the
 * call fails with a {@link VersionConflictError} whose `latestVersion` says what to merge into.
 */
import type { ScriptKind, ScriptStatus } from "@ytw/shared/constants";
import { rejectNul, requireInteger, requireUuid } from "./args.js";
import type { ActorTx, Queryable } from "./client.js";

/** One saved revision, without its body. */
export interface ScriptRecord {
  /** The revision's own id: what {@link setScriptStatus} and notes on a script refer to. */
  id: string;
  ideaId: string;
  kind: ScriptKind;
  /** 1, 2, 3, ... per (idea, kind). */
  version: number;
  status: ScriptStatus;
  /** Size of the body in UTF-8 bytes. */
  sizeBytes: number;
  createdAt: Date;
  /** When the status last changed (equals `createdAt` until then). */
  updatedAt: Date;
  createdBy: string;
  /** Who last changed the status (equals `createdBy` until then). */
  updatedBy: string;
}

/** A revision with its markdown body. */
export interface ScriptRecordWithBody extends ScriptRecord {
  bodyMd: string;
}

const SCRIPT_COLUMNS = `id, idea_id AS "ideaId", kind, version, status,
       octet_length(body_md) AS "sizeBytes", created_at AS "createdAt", updated_at AS "updatedAt",
       created_by AS "createdBy", updated_by AS "updatedBy"`;

export interface SaveScriptVersionInput {
  ideaId: string;
  kind: ScriptKind;
  /** The version the caller edited: the latest one, or 0 when no version exists yet. */
  baseVersion: number;
  /** The markdown, at most 1 MiB of UTF-8, stored exactly as given. */
  bodyMd: string;
}

/**
 * Appends the next revision as a `draft` (`save_script_version`). It is saved only when
 * `baseVersion` is the latest version of (idea, kind); otherwise a {@link VersionConflictError}
 * carries `latestVersion`. The idea must exist and not be archived. The body is not returned: its
 * size is.
 */
export async function saveScriptVersion(
  tx: ActorTx,
  input: SaveScriptVersionInput,
): Promise<ScriptRecord> {
  requireUuid("idea_id", input.ideaId);
  requireInteger("base_version", input.baseVersion);
  rejectNul("kind", input.kind);
  rejectNul("body_md", input.bodyMd);
  const { rows } = await tx.query<ScriptRecord>(
    `SELECT ${SCRIPT_COLUMNS}
       FROM public.save_script_version($1::text, $2::text, $3::uuid, $4::uuid, $5::text,
                                       $6::integer, $7::text)`,
    [
      tx.actor.name,
      tx.actor.type,
      tx.actor.tokenId,
      input.ideaId,
      input.kind,
      input.baseVersion,
      input.bodyMd,
    ],
  );
  return firstRow(rows, "save_script_version");
}

export interface SetScriptStatusInput {
  /** The id of the saved revision (a {@link ScriptRecord} `id`), not of the idea. */
  scriptId: string;
  status: ScriptStatus;
}

/** Sets the review status of one saved revision (`set_script_status`); nothing else changes. */
export async function setScriptStatus(
  tx: ActorTx,
  input: SetScriptStatusInput,
): Promise<ScriptRecord> {
  requireUuid("script_id", input.scriptId);
  rejectNul("status", input.status);
  const { rows } = await tx.query<ScriptRecord>(
    `SELECT ${SCRIPT_COLUMNS}
       FROM public.set_script_status($1::text, $2::text, $3::uuid, $4::uuid, $5::text)`,
    [tx.actor.name, tx.actor.type, tx.actor.tokenId, input.scriptId, input.status],
  );
  return firstRow(rows, "set_script_status");
}

export interface GetScriptVersionInput {
  ideaId: string;
  kind: ScriptKind;
  /** The revision to read; omitted means the latest one. */
  version?: number;
}

/** One revision with its body (the latest unless `version` is given), or null. Needs SELECT on `scripts`. */
export async function getScriptVersion(
  db: Queryable,
  input: GetScriptVersionInput,
): Promise<ScriptRecordWithBody | null> {
  requireUuid("idea_id", input.ideaId);
  if (input.version !== undefined) {
    requireInteger("version", input.version);
  }
  const { rows } = await db.query<ScriptRecordWithBody>(
    `SELECT ${SCRIPT_COLUMNS}, body_md AS "bodyMd"
       FROM public.scripts
      WHERE idea_id = $1::uuid AND kind = $2::text AND ($3::integer IS NULL OR version = $3::integer)
      ORDER BY version DESC
      LIMIT 1`,
    [input.ideaId, input.kind, input.version ?? null],
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
