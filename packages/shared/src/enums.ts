import { z } from "zod";

// Status and type enums from PRD 4. The database mirrors each one with a CHECK constraint or enum.

/** `scripts.kind`: a video script or its packaging doc (title, thumbnail and description ideas). */
export const SCRIPT_KINDS = ["script", "packaging"] as const;
export type ScriptKind = (typeof SCRIPT_KINDS)[number];
export const scriptKindSchema = z.enum(SCRIPT_KINDS);

/** `scripts.status`. New revisions always start as `draft`. */
export const SCRIPT_STATUSES = ["draft", "review", "approved"] as const;
export type ScriptStatus = (typeof SCRIPT_STATUSES)[number];
export const scriptStatusSchema = z.enum(SCRIPT_STATUSES);

/** `experiments.type`: which part of a video's packaging is being tested. */
export const EXPERIMENT_TYPES = ["title", "thumbnail", "description"] as const;
export type ExperimentType = (typeof EXPERIMENT_TYPES)[number];
export const experimentTypeSchema = z.enum(EXPERIMENT_TYPES);

/** `experiments.status`: planned -> running -> concluded | cancelled. */
export const EXPERIMENT_STATUSES = ["planned", "running", "concluded", "cancelled"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export const experimentStatusSchema = z.enum(EXPERIMENT_STATUSES);

/** `events.actor_type`: who made a change. */
export const ACTOR_TYPES = ["human", "agent"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
export const actorTypeSchema = z.enum(ACTOR_TYPES);

/** `notes.entity_type`: the kinds of record a note can be attached to. */
export const NOTE_ENTITY_TYPES = ["idea", "script", "video", "experiment"] as const;
export type NoteEntityType = (typeof NOTE_ENTITY_TYPES)[number];
export const noteEntityTypeSchema = z.enum(NOTE_ENTITY_TYPES);
