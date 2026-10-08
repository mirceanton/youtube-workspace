import {
  getIdeaPipeline,
  getVideo,
  listMetricSnapshots,
  listVideoPerformance,
  registerVideo,
  toClientError,
  updateVideo,
  type MetricSnapshot,
  type VideoPerformanceRecord,
  type VideoRecord,
} from "@ytw/db";
import {
  createVideoRequestSchema,
  listVideosQuerySchema,
  updateVideoRequestSchema,
  VIDEOS_PATH,
} from "@ytw/shared/api/videos";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebAuth } from "../../types.js";

type VideoRequest = FastifyRequest & { auth: WebAuth };
interface VideoParams {
  id: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function serializeVideo(video: VideoRecord) {
  return {
    id: video.id,
    idea_id: video.ideaId,
    youtube_id: video.youtubeId,
    title: video.title,
    published_at: iso(video.publishedAt),
    thumbnail_url: video.thumbnailUrl,
    version: video.version,
    archived_at: iso(video.archivedAt),
    created_at: video.createdAt.toISOString(),
    updated_at: video.updatedAt.toISOString(),
    created_by: video.createdBy,
    updated_by: video.updatedBy,
  };
}

function serializeMetrics(metrics: MetricSnapshot[]) {
  return metrics
    .toSorted((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime())
    .map((metric) => ({
      id: metric.id,
      video_id: metric.videoId,
      captured_at: metric.capturedAt.toISOString(),
      views: metric.views,
      impressions: metric.impressions,
      ctr: metric.ctr,
      avg_view_duration_s: metric.avgViewDurationS,
      avg_view_pct: metric.avgViewPct,
      watch_time_min: metric.watchTimeMin,
      subs_gained: metric.subsGained,
      retention: metric.retention,
      created_at: metric.createdAt.toISOString(),
      created_by: metric.createdBy,
    }));
}

function serializePerformance(record: VideoPerformanceRecord) {
  return {
    id: record.id,
    idea_id: record.ideaId,
    youtube_id: record.youtubeId,
    title: record.title,
    published_at: iso(record.publishedAt),
    thumbnail_url: record.thumbnailUrl,
    latest: record.latest
      ? {
          id: record.latest.id,
          captured_at: record.latest.capturedAt.toISOString(),
          views: record.latest.views,
          impressions: record.latest.impressions,
          ctr: record.latest.ctr,
          avg_view_duration_s: record.latest.avgViewDurationS,
          avg_view_pct: record.latest.avgViewPct,
          watch_time_min: record.latest.watchTimeMin,
          subs_gained: record.latest.subsGained,
        }
      : null,
    median: {
      sample_size: record.median.sampleSize,
      views: record.median.views,
      impressions: record.median.impressions,
      ctr: record.median.ctr,
      avg_view_duration_s: record.median.avgViewDurationS,
      avg_view_pct: record.median.avgViewPct,
      watch_time_min: record.median.watchTimeMin,
      subs_gained: record.median.subsGained,
    },
    vs_median: {
      views: record.vsMedian.views,
      impressions: record.vsMedian.impressions,
      ctr: record.vsMedian.ctr,
      avg_view_duration_s: record.vsMedian.avgViewDurationS,
      avg_view_pct: record.vsMedian.avgViewPct,
      watch_time_min: record.vsMedian.watchTimeMin,
      subs_gained: record.vsMedian.subsGained,
    },
  };
}

function asParams(request: FastifyRequest): VideoParams | null {
  const params = request.params as Partial<VideoParams>;
  return typeof params.id === "string" && UUID_PATTERN.test(params.id) ? { id: params.id } : null;
}

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message });
}

async function sendFailure(app: FastifyInstance, reply: FastifyReply, error: unknown, id?: string) {
  const clientError = toClientError(error);
  let latest: ReturnType<typeof serializeVideo> | null | undefined;
  if (clientError.status === 409 && id) {
    try {
      const current = await getVideo(app.db.pool, id);
      latest = current ? serializeVideo(current) : null;
    } catch {
      latest = null;
    }
  }
  return reply.code(clientError.status).send({
    error: clientError.message,
    ...(clientError.details ? { details: clientError.details } : {}),
    ...(clientError.status === 409 ? { latest: latest ?? null } : {}),
  });
}

/** Videos API. Route guards use current videos permissions; all writes bind the session actor. */
export default async function videosRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance;

  app.get(
    VIDEOS_PATH,
    { preHandler: app.requireLevel("videos", "read") },
    async (request, reply) => {
      const parsed = listVideosQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return invalid(reply, parsed.error.issues[0]?.message ?? "Invalid query");
      try {
        const videos = await listVideoPerformance(app.db.pool, { limit: parsed.data.limit });
        return reply.send({ videos: videos.map(serializePerformance) });
      } catch (error) {
        return sendFailure(app, reply, error);
      }
    },
  );

  app.get<{ Params: VideoParams }>(
    `${VIDEOS_PATH}/:id`,
    { preHandler: app.requireLevel("videos", "read") },
    async (request, reply) => {
      const params = asParams(request);
      if (!params) return invalid(reply, "id must be a valid UUID");
      try {
        const video = await getVideo(app.db.pool, params.id);
        if (!video) return reply.code(404).send({ error: "Video not found" });
        const [metrics, performance] = await Promise.all([
          listMetricSnapshots(app.db.pool, { videoId: params.id, limit: 1000 }),
          listVideoPerformance(app.db.pool, { videoId: params.id, limit: 1 }),
        ]);
        const auth = (request as VideoRequest).auth;
        const idea =
          video.ideaId && auth.levels.ideas !== "none"
            ? await getIdeaPipeline(app.db.pool, video.ideaId, true)
            : null;
        return reply.send({
          video: serializeVideo(video),
          metrics: serializeMetrics(metrics),
          performance: performance[0] ? serializePerformance(performance[0]) : null,
          ...(idea ? { idea: { id: idea.id, title: idea.title } } : {}),
        });
      } catch (error) {
        return sendFailure(app, reply, error, params.id);
      }
    },
  );

  app.post(
    VIDEOS_PATH,
    { preHandler: app.requireLevel("videos", "write") },
    async (request, reply) => {
      const parsed = createVideoRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return invalid(reply, parsed.error.issues[0]?.message ?? "Invalid video");
      const {
        idea_id: ideaId,
        youtube_id: youtubeId,
        title,
        published_at: publishedAt,
        thumbnail_url: thumbnailUrl,
      } = parsed.data;
      try {
        const video = await app.db.withActor(request, (tx) =>
          registerVideo(tx, {
            ...(ideaId !== undefined ? { ideaId } : {}),
            youtubeId,
            title,
            ...(publishedAt !== undefined ? { publishedAt } : {}),
            ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
          }),
        );
        return reply.code(201).send({ video: serializeVideo(video) });
      } catch (error) {
        return sendFailure(app, reply, error);
      }
    },
  );

  app.patch<{ Params: VideoParams }>(
    `${VIDEOS_PATH}/:id`,
    { preHandler: app.requireLevel("videos", "write") },
    async (request, reply) => {
      const params = asParams(request);
      if (!params) return invalid(reply, "id must be a valid UUID");
      const parsed = updateVideoRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return invalid(reply, parsed.error.issues[0]?.message ?? "Invalid video update");
      const { expected_version: expectedVersion, ...fields } = parsed.data;
      try {
        const video = await app.db.withActor(request, (tx) =>
          updateVideo(tx, {
            id: params.id,
            expectedVersion,
            fields: {
              ...(fields.title !== undefined ? { title: fields.title } : {}),
              ...(fields.published_at !== undefined ? { publishedAt: fields.published_at } : {}),
              ...(fields.thumbnail_url !== undefined ? { thumbnailUrl: fields.thumbnail_url } : {}),
              ...(fields.idea_id !== undefined ? { ideaId: fields.idea_id } : {}),
            },
          }),
        );
        return reply.send({ video: serializeVideo(video) });
      } catch (error) {
        return sendFailure(app, reply, error, params.id);
      }
    },
  );
}
