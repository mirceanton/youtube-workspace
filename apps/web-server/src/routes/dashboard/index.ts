import {
  countIdeasByStage,
  listEvents,
  listExperimentResults,
  listVideoPerformance,
  toClientError,
  type Queryable,
} from "@ytw/db";
import { DASHBOARD_PATH, dashboardResponseSchema } from "@ytw/shared/api/dashboard";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { WebAuth } from "../../core/types.js";

type DashboardCore = FastifyInstance & {
  requireAnyLevel(level: "read" | "write"): preHandlerHookHandler;
  db: { pool: Queryable };
};

function timestamp(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function canRead(auth: WebAuth, resource: keyof WebAuth["levels"]): boolean {
  return auth.isAdmin || auth.levels[resource] !== "none";
}

/** Read-only summary; every section is omitted as null when its resource is not readable. */
export default async function dashboardRoutes(server: FastifyInstance): Promise<void> {
  const app = server as DashboardCore;

  app.get(DASHBOARD_PATH, { preHandler: app.requireAnyLevel("read") }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) return reply.code(401).send({ error: "Authentication required." });

    try {
      const [ideas, experiments, videoRecords, activity] = await Promise.all([
        canRead(auth, "ideas") ? countIdeasByStage(app.db.pool) : null,
        canRead(auth, "experiments")
          ? listExperimentResults(app.db.pool, { statuses: ["running"], limit: 20 })
          : null,
        canRead(auth, "videos") ? listVideoPerformance(app.db.pool, { limit: 1000 }) : null,
        canRead(auth, "activity") ? listEvents(app.db.pool, { limit: 20 }) : null,
      ]);

      const response = {
        ideas:
          ideas === null
            ? null
            : {
                total: Object.values(ideas).reduce((sum, count) => sum + count, 0),
                by_stage: ideas,
              },
        running_experiments:
          experiments === null
            ? null
            : experiments.map((experiment) => ({
                id: experiment.experimentId,
                video_id: experiment.videoId,
                // Experiment access does not imply permission to read the linked video's title.
                video_title: canRead(auth, "videos") ? experiment.videoTitle : null,
                type: experiment.type,
                hypothesis: experiment.hypothesis,
                starts_at: timestamp(experiment.startsAt),
                variants: experiment.variants.map((variant) => ({
                  label: variant.label,
                  is_control: variant.isControl,
                })),
              })),
        latest_videos:
          videoRecords === null
            ? null
            : videoRecords
                .filter((video) => video.publishedAt !== null && video.publishedAt <= new Date())
                .slice(0, 10)
                .map((video) => ({
                  id: video.id,
                  title: video.title,
                  youtube_id: video.youtubeId,
                  published_at: video.publishedAt!.toISOString(),
                  views: video.latest?.views ?? null,
                  impressions: video.latest?.impressions ?? null,
                  ctr: video.latest?.ctr ?? null,
                  avg_view_duration_s: video.latest?.avgViewDurationS ?? null,
                })),
        recent_activity:
          activity === null
            ? null
            : activity.events.map((event) => ({
                id: event.id,
                created_at: event.createdAt.toISOString(),
                actor: event.actor,
                actor_type: event.actorType,
                action: event.action,
                entity_type: event.entityType,
                entity_id: event.entityId,
                payload: event.payload,
              })),
      };
      return reply.send(dashboardResponseSchema.parse(response));
    } catch (error) {
      const clientError = toClientError(error);
      return reply.code(clientError.status).send({
        error: clientError.message,
        code: clientError.error,
        ...(clientError.hint === undefined ? {} : { hint: clientError.hint }),
        details: clientError.details,
      });
    }
  });
}
