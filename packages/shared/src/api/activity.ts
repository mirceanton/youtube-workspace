import { z } from "zod";
import { ACTOR_TYPES } from "../enums.js";
import { RESOURCES } from "../resources.js";

export const ACTIVITY_PATH = "/api/activity";
export const ACTIVITY_CHANGES_PATH = `${ACTIVITY_PATH}/changes`;
export const ACTIVITY_PAGE_SIZE = 50;

const timestampSchema = z.iso.datetime({ offset: true });
const entityTypeSchema = z.string().trim().min(1).max(64);
// Live-poll cursors carry compressed PostgreSQL snapshots and can grow when many transactions are
// open at once. The route applies the same bound before decoding.
const cursorSchema = z.string().max(8192);

export const activityEventSchema = z.object({
  id: z.uuid(),
  created_at: timestampSchema,
  actor: z.string(),
  actor_type: z.enum(ACTOR_TYPES),
  token_id: z.uuid().nullable(),
  action: z.string(),
  entity_type: z.string().nullable(),
  entity_id: z.uuid().nullable(),
  payload: z.record(z.string(), z.unknown()),
});

export const listActivityQuerySchema = z.object({
  actor: z.string().max(200).optional(),
  actor_type: z.enum(ACTOR_TYPES).optional(),
  entity_type: entityTypeSchema.optional(),
  entity_id: z.uuid().optional(),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(ACTIVITY_PAGE_SIZE),
  cursor: cursorSchema.optional(),
});
export type ListActivityQuery = z.infer<typeof listActivityQuerySchema>;

export const activityResponseSchema = z.object({
  events: z.array(activityEventSchema),
  next_cursor: cursorSchema.nullable(),
});
export type ActivityResponse = z.infer<typeof activityResponseSchema>;

export const activityChangesQuerySchema = z.object({ since: cursorSchema.optional() });
export type ActivityChangesQuery = z.infer<typeof activityChangesQuerySchema>;

export const activityChangesResponseSchema = z.object({
  /** Resource-only hints; actor, action, entity ids and payload are never exposed by this poll. */
  changed_resources: z.array(z.enum(RESOURCES)),
  /** Opaque high-water cursor for the next poll. */
  cursor: cursorSchema.nullable(),
  has_more: z.boolean(),
});
export type ActivityChangesResponse = z.infer<typeof activityChangesResponseSchema>;
