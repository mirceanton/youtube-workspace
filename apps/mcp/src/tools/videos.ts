/**
 * MCP write tools for videos and metrics (PRD 5, T32).
 */
import { logMetrics, registerVideo, type MetricValues, type RetentionPoint } from "@ytw/db";
import { z } from "zod";
import { defineTool, type ToolRegistry } from "../tools.js";

export const registerVideoTool = defineTool({
  name: "register_video",
  description: "Registers a video that exists on YouTube. Requires Write permission on videos.",
  requires: { resource: "videos", level: "write" },
  input: z.object({
    idea_id: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe("Optional idea UUID the video was created from"),
    youtube_id: z
      .string()
      .min(1)
      .max(32)
      .describe("YouTube video id (11 characters, not a full URL)"),
    title: z.string().min(1).max(500).describe("Video title (1-500 characters)"),
    published_at: z
      .string()
      .nullable()
      .optional()
      .describe("Publication timestamp (ISO 8601 with timezone)"),
    thumbnail_url: z.string().max(2000).nullable().optional().describe("Thumbnail URL or path"),
  }),
  async handler(input, context) {
    return context.withTx((tx) =>
      registerVideo(tx, {
        ideaId: input.idea_id,
        youtubeId: input.youtube_id,
        title: input.title,
        publishedAt: input.published_at,
        thumbnailUrl: input.thumbnail_url,
      }),
    );
  },
});

export const logMetricsTool = defineTool({
  name: "log_metrics",
  description:
    "Appends a snapshot of performance metrics for a video. Idempotent on (video_id, captured_at). Requires Write permission on videos.",
  requires: { resource: "videos", level: "write" },
  input: z.object({
    video_id: z.string().uuid().describe("Video UUID"),
    captured_at: z
      .string()
      .describe("Timestamp when metrics were captured (ISO 8601 with timezone)"),
    metrics: z
      .object({
        views: z.union([z.number(), z.string()]).nullable().optional().describe("Total view count"),
        impressions: z
          .union([z.number(), z.string()])
          .nullable()
          .optional()
          .describe("Total impressions"),
        ctr: z
          .union([z.number(), z.string()])
          .nullable()
          .optional()
          .describe("Click-through rate in percent (0 to 100)"),
        avg_view_duration_s: z
          .union([z.number(), z.string()])
          .nullable()
          .optional()
          .describe("Average view duration in seconds"),
        avg_view_pct: z
          .union([z.number(), z.string()])
          .nullable()
          .optional()
          .describe("Average percentage viewed"),
        watch_time_min: z
          .union([z.number(), z.string()])
          .nullable()
          .optional()
          .describe("Estimated watch time in minutes"),
        subs_gained: z
          .union([z.number(), z.string()])
          .nullable()
          .optional()
          .describe("Net subscribers gained"),
        retention: z
          .array(
            z.object({
              t: z.number().describe("Time in seconds from video start"),
              pct: z.number().describe("Percentage of viewers still watching"),
            }),
          )
          .max(1000)
          .nullable()
          .optional()
          .describe("Audience retention curve points"),
      })
      .describe("Snapshot metric values"),
  }),
  async handler(input, context) {
    const m = input.metrics as Record<string, unknown>;
    const metrics: MetricValues = {
      views: m.views as number | string | null | undefined,
      impressions: m.impressions as number | string | null | undefined,
      ctr: m.ctr as number | string | null | undefined,
      avgViewDurationS: (m.avg_view_duration_s ?? m.avgViewDurationS) as
        number | string | null | undefined,
      avgViewPct: (m.avg_view_pct ?? m.avgViewPct) as number | string | null | undefined,
      watchTimeMin: (m.watch_time_min ?? m.watchTimeMin) as number | string | null | undefined,
      subsGained: (m.subs_gained ?? m.subsGained) as number | string | null | undefined,
      retention: m.retention as RetentionPoint[] | null | undefined,
    };

    return context.withTx((tx) =>
      logMetrics(tx, {
        videoId: input.video_id,
        capturedAt: input.captured_at,
        metrics,
      }),
    );
  },
});

export function register(registry: ToolRegistry): void {
  registry.register(registerVideoTool);
  registry.register(logMetricsTool);
}
