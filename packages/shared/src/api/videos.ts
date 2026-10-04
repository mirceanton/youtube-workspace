import { z } from "zod";

export const VIDEOS_PATH = "/api/videos";

const timestampSchema = z.iso.datetime({ offset: true });
const decimalSchema = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/)
  .nullable();
const youtubeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const retentionPointSchema = z.object({ t: z.number().finite(), pct: z.number().finite() });

export const metricSnapshotSchema = z.object({
  id: z.uuid(),
  video_id: z.uuid(),
  captured_at: timestampSchema,
  views: decimalSchema,
  impressions: decimalSchema,
  ctr: decimalSchema,
  avg_view_duration_s: decimalSchema,
  avg_view_pct: decimalSchema,
  watch_time_min: decimalSchema,
  subs_gained: z.number().int().nullable(),
  retention: z.array(retentionPointSchema).nullable(),
  created_at: timestampSchema,
  created_by: z.string(),
});
export type MetricSnapshot = z.infer<typeof metricSnapshotSchema>;

export const videoMetricValuesSchema = z.object({
  views: decimalSchema,
  impressions: decimalSchema,
  ctr: decimalSchema,
  avg_view_duration_s: decimalSchema,
  avg_view_pct: decimalSchema,
  watch_time_min: decimalSchema,
  subs_gained: decimalSchema,
});

export const videoMedianSchema = videoMetricValuesSchema.extend({
  sample_size: z.number().int().nonnegative(),
});

export const videoPerformanceDeltaSchema = videoMetricValuesSchema;

export const videoPerformanceSchema = z.object({
  id: z.uuid(),
  idea_id: z.uuid().nullable(),
  youtube_id: youtubeIdSchema,
  title: z.string(),
  published_at: timestampSchema.nullable(),
  thumbnail_url: z.string().nullable(),
  latest: z
    .object({
      id: z.uuid(),
      captured_at: timestampSchema,
      views: decimalSchema,
      impressions: decimalSchema,
      ctr: decimalSchema,
      avg_view_duration_s: decimalSchema,
      avg_view_pct: decimalSchema,
      watch_time_min: decimalSchema,
      subs_gained: z.number().int().nullable(),
    })
    .nullable(),
  median: videoMedianSchema,
  vs_median: videoPerformanceDeltaSchema,
});
export type VideoPerformance = z.infer<typeof videoPerformanceSchema>;

export const videoSchema = z.object({
  id: z.uuid(),
  idea_id: z.uuid().nullable(),
  youtube_id: youtubeIdSchema,
  title: z.string(),
  published_at: timestampSchema.nullable(),
  thumbnail_url: z.string().nullable(),
  version: z.number().int().positive(),
  archived_at: timestampSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  created_by: z.string(),
  updated_by: z.string(),
});
export type Video = z.infer<typeof videoSchema>;

export const videoIdeaLinkSchema = z.object({ id: z.uuid(), title: z.string() });

export const listVideosQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export type ListVideosQuery = z.infer<typeof listVideosQuerySchema>;

export const listVideosResponseSchema = z.object({ videos: z.array(videoPerformanceSchema) });
export type ListVideosResponse = z.infer<typeof listVideosResponseSchema>;

export const videoDetailResponseSchema = z.object({
  video: videoSchema,
  metrics: z.array(metricSnapshotSchema),
  performance: videoPerformanceSchema.nullable(),
  idea: videoIdeaLinkSchema.optional(),
});
export type VideoDetailResponse = z.infer<typeof videoDetailResponseSchema>;

export const createVideoRequestSchema = z.object({
  idea_id: z.uuid().nullable().optional(),
  youtube_id: youtubeIdSchema,
  title: z.string().trim().min(1).max(500),
  published_at: timestampSchema.nullable().optional(),
  thumbnail_url: z.string().max(2048).nullable().optional(),
});
export type CreateVideoRequest = z.infer<typeof createVideoRequestSchema>;

export const updateVideoRequestSchema = z
  .object({
    expected_version: z.number().int().positive(),
    title: z.string().trim().min(1).max(500).optional(),
    published_at: timestampSchema.nullable().optional(),
    thumbnail_url: z.string().max(2048).nullable().optional(),
    idea_id: z.uuid().nullable().optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== "expected_version"), {
    message: "At least one editable field is required",
  });
export type UpdateVideoRequest = z.infer<typeof updateVideoRequestSchema>;

export const videoMutationResponseSchema = z.object({ video: videoSchema });
export type VideoMutationResponse = z.infer<typeof videoMutationResponseSchema>;
