import { z } from "zod";
import { EXPERIMENT_TYPES } from "../constants.js";

export const DASHBOARD_PATH = "/api/dashboard";

const timestampSchema = z.iso.datetime({ offset: true });
const decimalSchema = z.string().nullable();

export const dashboardIdeaCountsSchema = z.object({
  inbox: z.number().int().nonnegative(),
  shortlisted: z.number().int().nonnegative(),
  scripting: z.number().int().nonnegative(),
  filming: z.number().int().nonnegative(),
  editing: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
});

export const dashboardVideoSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  youtube_id: z.string(),
  published_at: timestampSchema,
  views: decimalSchema,
  impressions: decimalSchema,
  ctr: decimalSchema,
  avg_view_duration_s: decimalSchema,
});

export const dashboardExperimentSchema = z.object({
  id: z.uuid(),
  video_id: z.uuid(),
  video_title: z.string(),
  type: z.enum(EXPERIMENT_TYPES),
  hypothesis: z.string().nullable(),
  starts_at: timestampSchema.nullable(),
  variants: z.array(z.object({ label: z.string(), is_control: z.boolean() })),
});

export const dashboardEventSchema = z.object({
  id: z.uuid(),
  created_at: timestampSchema,
  actor: z.string(),
  actor_type: z.enum(["human", "agent"]),
  action: z.string(),
  entity_type: z.string().nullable(),
  entity_id: z.uuid().nullable(),
  payload: z.record(z.string(), z.unknown()),
});

export const dashboardResponseSchema = z.object({
  ideas: z
    .object({ total: z.number().int().nonnegative(), by_stage: dashboardIdeaCountsSchema })
    .nullable(),
  running_experiments: z.array(dashboardExperimentSchema).nullable(),
  latest_videos: z.array(dashboardVideoSchema).nullable(),
  recent_activity: z.array(dashboardEventSchema).nullable(),
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
