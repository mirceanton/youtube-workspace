// Status and type enums. The database mirrors each one with a CHECK constraint or enum.
// The matching zod schemas are in schemas.ts.

/** `scripts.kind`: a video script or its packaging doc (title, thumbnail and description ideas). */
export const SCRIPT_KINDS = ["script", "packaging"] as const;
export type ScriptKind = (typeof SCRIPT_KINDS)[number];

/** `scripts.status`. New revisions always start as `draft`. */
export const SCRIPT_STATUSES = ["draft", "review", "approved"] as const;
export type ScriptStatus = (typeof SCRIPT_STATUSES)[number];

/** `experiments.type`: which part of a video's packaging is being tested. */
export const EXPERIMENT_TYPES = ["title", "thumbnail", "description"] as const;
export type ExperimentType = (typeof EXPERIMENT_TYPES)[number];

/** `experiments.status`: planned -> running -> concluded | cancelled. */
export const EXPERIMENT_STATUSES = ["planned", "running", "concluded", "cancelled"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/** `events.actor_type`: who made a change. */
export const ACTOR_TYPES = ["human", "agent"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * `notes.entity_type`: the kinds of record a note can be attached to. These are the objects that
 * exist; extending the list means editing it here and the database CHECK constraint together.
 */
export const NOTE_ENTITY_TYPES = ["idea", "script", "video", "experiment"] as const;
export type NoteEntityType = (typeof NOTE_ENTITY_TYPES)[number];
