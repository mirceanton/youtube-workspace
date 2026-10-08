import { z } from "zod";
import { actorTypeSchema, noteEntityTypeSchema } from "../schemas.js";

// `/api/notes` contract (the server implements it, the SPA's NotesPanel consumes it). Notes are
// append-only comments on an idea, script, video or experiment.
//
//   GET  /api/notes?entity_type=<type>&entity_id=<uuid>   needs Read on notes   -> 200 listNotesResponse
//   POST /api/notes  { entity_type, entity_id, body_md }  needs Write on notes  -> 201 createNoteResponse
//
// Errors use the shared `{ error }` body: 400 invalid input, 401 not signed in, 403 missing level,
// 404 the entity does not exist. The author of a new note is always the session's actor
// (`preferred_username`, actor type `human`); the client cannot choose it.

/** Largest note body, in UTF-8 bytes. Notes are comments, so far below the 1 MiB script limit. */
export const NOTE_BODY_MAX_BYTES = 65_536;

export const NOTES_PATH = "/api/notes";

const timestampSchema = z.iso.datetime({ offset: true });

export const noteSchema = z.object({
  id: z.string().min(1),
  entity_type: noteEntityTypeSchema,
  entity_id: z.uuid(),
  /** Actor name: a username for people, the API token's name for agents. */
  author: z.string().min(1),
  actor_type: actorTypeSchema,
  /** Raw markdown. Clients must render it sanitised, never as HTML. */
  body_md: z.string(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Note = z.infer<typeof noteSchema>;

export const listNotesQuerySchema = z.object({
  entity_type: noteEntityTypeSchema,
  entity_id: z.uuid(),
});
export type ListNotesQuery = z.infer<typeof listNotesQuerySchema>;

/** Every note of the entity, oldest first. */
export const listNotesResponseSchema = z.object({
  notes: z.array(noteSchema),
});
export type ListNotesResponse = z.infer<typeof listNotesResponseSchema>;

export const createNoteRequestSchema = z.object({
  entity_type: noteEntityTypeSchema,
  entity_id: z.uuid(),
  body_md: z
    .string()
    .refine((body) => body.trim().length > 0, { message: "A note cannot be empty" })
    .refine((body) => new TextEncoder().encode(body).length <= NOTE_BODY_MAX_BYTES, {
      message: `A note can be at most ${NOTE_BODY_MAX_BYTES} bytes`,
    }),
});
export type CreateNoteRequest = z.infer<typeof createNoteRequestSchema>;

export const createNoteResponseSchema = z.object({
  note: noteSchema,
});
export type CreateNoteResponse = z.infer<typeof createNoteResponseSchema>;
