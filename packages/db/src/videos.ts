/**
 * Typed wrappers for videos: `register_video`, `update_video`, `archive_video`, and `getVideo`
 * to read one back.
 *
 * Writes take the transaction of {@link withActor} and pass the actor to the database function, so
 * the audit log names who did it. Database errors arrive typed (errors.ts): registering a YouTube id
 * twice is a {@link DuplicateError} whose `existingId` is the video that holds it, a stale
 * `expectedVersion` is a {@link VersionConflictError} whose `latestVersion` is the current version,
 * and an archived video refuses edits with an {@link InvalidTransitionError}.
 */
import { rejectNul, requireInteger, requireUuid } from "./args.js";
import type { ActorTx, Queryable } from "./client.js";
import { instantText } from "./value-args.js";

/** A video as stored. */
export interface VideoRecord {
  id: string;
  /** The idea the video came from, or null. */
  ideaId: string | null;
  /** YouTube's 11-character video id, unique. */
  youtubeId: string;
  title: string;
  /** Publication time (in the future for a scheduled video); null while not scheduled. */
  publishedAt: Date | null;
  thumbnailUrl: string | null;
  /** Optimistic-concurrency version: pass it as `expectedVersion` when editing. */
  version: number;
  /** Set when the video was archived (soft delete); an archived video is read-only. */
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}

const VIDEO_COLUMNS = `id, idea_id AS "ideaId", youtube_id AS "youtubeId", title,
       published_at AS "publishedAt", thumbnail_url AS "thumbnailUrl", version,
       archived_at AS "archivedAt", created_at AS "createdAt", updated_at AS "updatedAt",
       created_by AS "createdBy", updated_by AS "updatedBy"`;

export interface RegisterVideoInput {
  /** The idea the video came from; it must exist. Registering a video does not move the idea. */
  ideaId?: string | null;
  /** The 11-character id (the part after `v=`), not a URL. */
  youtubeId: string;
  /** 1-500 characters. */
  title: string;
  /** When it was (or will be) published, with a time zone; omit while not scheduled. */
  publishedAt?: Date | string | null;
  /** An http(s) URL or a path without a scheme. */
  thumbnailUrl?: string | null;
}

/**
 * Creates the record of a video that exists on YouTube (`register_video`). A `youtubeId` that is
 * already registered fails with a {@link DuplicateError} naming the existing video (`existingId`);
 * an unknown `ideaId` is a {@link NotFoundError}.
 */
export async function registerVideo(tx: ActorTx, input: RegisterVideoInput): Promise<VideoRecord> {
  if (input.ideaId !== undefined && input.ideaId !== null) {
    requireUuid("idea_id", input.ideaId);
  }
  rejectNul("youtube_id", input.youtubeId);
  rejectNul("title", input.title);
  rejectNul("thumbnail_url", input.thumbnailUrl);
  const publishedAt =
    input.publishedAt === undefined || input.publishedAt === null
      ? null
      : instantText("published_at", input.publishedAt);
  const { rows } = await tx.query<VideoRecord>(
    `SELECT ${VIDEO_COLUMNS}
       FROM public.register_video($1::text, $2::text, $3::uuid, $4::uuid, $5::text, $6::text,
                                  $7::timestamptz, $8::text)`,
    [
      tx.actor.name,
      tx.actor.type,
      tx.actor.tokenId,
      input.ideaId ?? null,
      input.youtubeId,
      input.title,
      publishedAt,
      input.thumbnailUrl ?? null,
    ],
  );
  return firstRow(rows, "register_video");
}

/**
 * The editable fields. A field that is present is set; `null` clears `publishedAt`, `thumbnailUrl`
 * and `ideaId`. The YouTube id cannot be changed.
 */
export interface VideoFields {
  title?: string;
  publishedAt?: Date | string | null;
  thumbnailUrl?: string | null;
  /** Links the video to an idea (it must exist) or, with null, unlinks it. */
  ideaId?: string | null;
}

export interface UpdateVideoInput {
  id: string;
  /** The `version` of the video the caller read. */
  expectedVersion: number;
  fields: VideoFields;
}

/** The names the database function knows the fields by. */
const FIELD_NAMES: Readonly<Record<string, string>> = {
  title: "title",
  publishedAt: "published_at",
  thumbnailUrl: "thumbnail_url",
  ideaId: "idea_id",
  youtubeId: "youtube_id",
};

/**
 * Edits title, publication time, thumbnail or idea link of a video (`update_video`). Fails with
 * {@link VersionConflictError} (`latestVersion`) when the video changed since `expectedVersion`, and
 * with {@link InvalidTransitionError} (reason `archived`) for an archived video. Saving the stored
 * values again changes nothing: the same record comes back, with the same version.
 */
export async function updateVideo(tx: ActorTx, input: UpdateVideoInput): Promise<VideoRecord> {
  requireUuid("id", input.id);
  requireInteger("expected_version", input.expectedVersion);
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.fields)) {
    if (value === undefined) {
      continue;
    }
    const name = FIELD_NAMES[key] ?? key;
    if (typeof value === "string" && name !== "published_at") {
      rejectNul(name, value);
    }
    if (name === "idea_id" && typeof value === "string") {
      requireUuid("idea_id", value);
    }
    fields[name] =
      name === "published_at" && value !== null
        ? instantText("published_at", value as Date | string)
        : value;
  }
  const { rows } = await tx.query<VideoRecord>(
    `SELECT ${VIDEO_COLUMNS}
       FROM public.update_video($1::text, $2::text, $3::uuid, $4::uuid, $5::integer, $6::jsonb)`,
    [
      tx.actor.name,
      tx.actor.type,
      tx.actor.tokenId,
      input.id,
      input.expectedVersion,
      JSON.stringify(fields),
    ],
  );
  return firstRow(rows, "update_video");
}

export interface ArchiveVideoInput {
  id: string;
  /** Fail with a version conflict unless the video is still at this version. */
  expectedVersion?: number;
}

/**
 * Archives a video (`archive_video`, soft delete). An archived video is read-only: it takes no
 * edits, new metric snapshots or new experiments. Archiving an archived video changes nothing.
 */
export async function archiveVideo(tx: ActorTx, input: ArchiveVideoInput): Promise<VideoRecord> {
  requireUuid("id", input.id);
  if (input.expectedVersion !== undefined) {
    requireInteger("expected_version", input.expectedVersion);
  }
  const { rows } = await tx.query<VideoRecord>(
    `SELECT ${VIDEO_COLUMNS}
       FROM public.archive_video($1::text, $2::text, $3::uuid, $4::uuid, $5::integer)`,
    [tx.actor.name, tx.actor.type, tx.actor.tokenId, input.id, input.expectedVersion ?? null],
  );
  return firstRow(rows, "archive_video");
}

/** One video by id (archived ones included), or null. Needs only SELECT on `videos`. */
export async function getVideo(db: Queryable, id: string): Promise<VideoRecord | null> {
  requireUuid("id", id);
  const { rows } = await db.query<VideoRecord>(
    `SELECT ${VIDEO_COLUMNS} FROM public.videos WHERE id = $1::uuid`,
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
