import {
  concludeExperiment,
  createExperiment,
  getExperiment,
  listExperimentResults,
  listMetricSnapshots,
  recordVariantStats,
  toClientError,
  updateExperimentStatus,
  VersionConflictError,
  type Queryable,
  type VariantRecord,
} from "@ytw/db";
import type { ActorTx } from "@ytw/db";
import {
  concludeExperimentRequestSchema,
  concludeExperimentResponseSchema,
  createExperimentRequestSchema,
  createExperimentResponseSchema,
  EXPERIMENT_CONCLUDE_PATH,
  EXPERIMENT_CTR_HISTORY_PATH,
  EXPERIMENT_STATUS_PATH,
  EXPERIMENT_VARIANT_STATS_PATH,
  EXPERIMENTS_PATH,
  experimentCtrHistoryResponseSchema,
  getExperimentResponseSchema,
  listExperimentVideosResponseSchema,
  listExperimentsQuerySchema,
  listExperimentsResponseSchema,
  EXPERIMENT_VIDEOS_PATH,
  recordVariantStatsRequestSchema,
  recordVariantStatsResponseSchema,
  updateExperimentStatusRequestSchema,
  updateExperimentStatusResponseSchema,
} from "@ytw/shared/api/experiments";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";

type ExperimentsCore = FastifyInstance & {
  requireLevel(resource: "experiments" | "videos", level: "read" | "write"): preHandlerHookHandler;
  db: {
    pool: Queryable;
    withActor<T>(request: FastifyRequest, fn: (client: ActorTx) => Promise<T>): Promise<T>;
  };
};

const uuidSchema = z.uuid();

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message });
}

function sendDbError(reply: FastifyReply, error: unknown) {
  if (error instanceof VersionConflictError) {
    return reply.code(409).send({
      error: error.message,
      latest: { version: error.latestVersion },
    });
  }
  const clientError = toClientError(error);
  return reply.code(clientError.status).send({
    error: clientError.message,
    code: clientError.error,
    ...(clientError.hint === undefined ? {} : { hint: clientError.hint }),
    details: clientError.details,
  });
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function toListItem(result: Awaited<ReturnType<typeof listExperimentResults>>[number]) {
  return {
    id: result.experimentId,
    video_id: result.videoId,
    video_title: result.videoTitle,
    type: result.type,
    status: result.status,
    hypothesis: result.hypothesis,
    starts_at: iso(result.startsAt),
    ends_at: iso(result.endsAt),
    winner_variant_id: result.winnerVariantId,
    conclusion: result.conclusion,
    created_at: result.createdAt.toISOString(),
    variants: result.variants.map((variant) => ({
      id: variant.variantId,
      label: variant.label,
      content: variant.content,
      is_control: variant.isControl,
      impressions: variant.impressions,
      ctr: variant.ctr,
      ctr_vs_control: variant.ctrVsControl,
      ctr_lift_pct: variant.ctrLiftPct,
      is_winner: variant.isWinner,
    })),
  };
}

async function detailFor(db: Queryable, id: string) {
  const base = await getExperiment(db, id);
  if (base === null) return null;
  const result = (await listExperimentResults(db, { experimentId: id, limit: 1 }))[0];
  if (result === undefined) return null;
  const resultById = new Map(result.variants.map((variant) => [variant.variantId, variant]));
  return {
    id: base.id,
    video_id: base.videoId,
    video_title: result.videoTitle,
    type: base.type,
    status: base.status,
    hypothesis: base.hypothesis,
    starts_at: iso(base.startsAt),
    ends_at: iso(base.endsAt),
    winner_variant_id: base.winnerVariantId,
    conclusion: base.conclusion,
    version: base.version,
    created_at: base.createdAt.toISOString(),
    updated_at: base.updatedAt.toISOString(),
    created_by: base.createdBy,
    updated_by: base.updatedBy,
    variants: base.variants.map((variant: VariantRecord) => {
      const comparison = resultById.get(variant.id);
      return {
        id: variant.id,
        label: variant.label,
        content: variant.content,
        is_control: variant.isControl,
        impressions: variant.impressions,
        ctr: variant.ctr,
        ctr_vs_control: comparison?.ctrVsControl ?? null,
        ctr_lift_pct: comparison?.ctrLiftPct ?? null,
        is_winner: comparison?.isWinner ?? false,
        created_by: variant.createdBy,
        updated_by: variant.updatedBy,
      };
    }),
  };
}

function parseExperimentId(value: unknown): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The browser API for experiment planning, comparison, statistics, and conclusions. */
export default async function experimentsRoutes(server: FastifyInstance): Promise<void> {
  const app = server as ExperimentsCore;

  app.get(
    EXPERIMENTS_PATH,
    { preHandler: app.requireLevel("experiments", "read") },
    async (request, reply) => {
      const parsed = listExperimentsQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return invalid(reply, parsed.error.issues[0]?.message ?? "Invalid query");
      const status = parsed.data.status;
      const options =
        status === undefined ? {} : { statuses: Array.isArray(status) ? status : [status] };
      const results = await listExperimentResults(app.db.pool, options);
      const response = listExperimentsResponseSchema.safeParse({
        experiments: results.map(toListItem),
      });
      if (!response.success) throw response.error;
      return reply.send(response.data);
    },
  );

  app.get(
    EXPERIMENT_VIDEOS_PATH,
    {
      preHandler: [app.requireLevel("experiments", "write"), app.requireLevel("videos", "read")],
    },
    async (_request, reply) => {
      const { rows } = await app.db.pool.query<{ id: string; title: string }>(
        `SELECT id, title FROM public.videos WHERE archived_at IS NULL
          ORDER BY published_at DESC NULLS LAST, lower(title), id`,
      );
      const response = listExperimentVideosResponseSchema.safeParse({ videos: rows });
      if (!response.success) throw response.error;
      return reply.send(response.data);
    },
  );

  app.get(
    `${EXPERIMENTS_PATH}/:experiment_id`,
    { preHandler: app.requireLevel("experiments", "read") },
    async (request, reply) => {
      const id = parseExperimentId((request.params as { experiment_id?: unknown }).experiment_id);
      if (id === null) return invalid(reply, "experiment_id must be a UUID");
      const experiment = await detailFor(app.db.pool, id);
      if (experiment === null) return reply.code(404).send({ error: "Experiment not found" });
      const response = getExperimentResponseSchema.safeParse({ experiment });
      if (!response.success) throw response.error;
      return reply.send(response.data);
    },
  );

  // Video metrics belong to the videos resource. The separate endpoint keeps experiment details
  // available to a user who can read experiments but has no access to video metrics.
  app.get(
    EXPERIMENT_CTR_HISTORY_PATH,
    {
      preHandler: [app.requireLevel("experiments", "read"), app.requireLevel("videos", "read")],
    },
    async (request, reply) => {
      const id = parseExperimentId((request.params as { experiment_id?: unknown }).experiment_id);
      if (id === null) return invalid(reply, "experiment_id must be a UUID");
      const experiment = await getExperiment(app.db.pool, id);
      if (experiment === null) return reply.code(404).send({ error: "Experiment not found" });
      const snapshots = await listMetricSnapshots(app.db.pool, {
        videoId: experiment.videoId,
        limit: 1000,
      });
      const response = experimentCtrHistoryResponseSchema.safeParse({
        history: snapshots.toReversed().map((snapshot) => ({
          captured_at: snapshot.capturedAt.toISOString(),
          ctr: snapshot.ctr,
        })),
      });
      if (!response.success) throw response.error;
      return reply.send(response.data);
    },
  );

  app.post(
    EXPERIMENTS_PATH,
    { preHandler: app.requireLevel("experiments", "write") },
    async (request, reply) => {
      const parsed = createExperimentRequestSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? "Invalid body");
      try {
        const created = await app.db.withActor(request, (tx) =>
          createExperiment(tx, {
            videoId: parsed.data.video_id,
            type: parsed.data.type,
            hypothesis: parsed.data.hypothesis,
            variants: parsed.data.variants.map((variant) => ({
              label: variant.label,
              content: variant.content,
              ...(variant.is_control === undefined ? {} : { isControl: variant.is_control }),
            })),
          }),
        );
        const experiment = await detailFor(app.db.pool, created.id);
        if (experiment === null) return reply.code(404).send({ error: "Experiment not found" });
        const response = createExperimentResponseSchema.safeParse({ experiment });
        if (!response.success) throw response.error;
        return reply.code(201).send(response.data);
      } catch (error) {
        return sendDbError(reply, error);
      }
    },
  );

  app.patch(
    EXPERIMENT_STATUS_PATH,
    { preHandler: app.requireLevel("experiments", "write") },
    async (request, reply) => {
      const id = parseExperimentId((request.params as { experiment_id?: unknown }).experiment_id);
      if (id === null) return invalid(reply, "experiment_id must be a UUID");
      const parsed = updateExperimentStatusRequestSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? "Invalid body");
      try {
        const experiment = await app.db.withActor(request, (tx) =>
          updateExperimentStatus(tx, {
            id,
            expectedVersion: parsed.data.expected_version,
            newStatus: parsed.data.status,
          }),
        );
        const response = updateExperimentStatusResponseSchema.safeParse({
          experiment: {
            id: experiment.id,
            status: experiment.status,
            starts_at: iso(experiment.startsAt),
            ends_at: iso(experiment.endsAt),
            version: experiment.version,
            updated_at: experiment.updatedAt.toISOString(),
            updated_by: experiment.updatedBy,
          },
        });
        if (!response.success) throw response.error;
        return reply.send(response.data);
      } catch (error) {
        return sendDbError(reply, error);
      }
    },
  );

  app.patch(
    EXPERIMENT_VARIANT_STATS_PATH,
    { preHandler: app.requireLevel("experiments", "write") },
    async (request, reply) => {
      const params = request.params as { experiment_id?: unknown; variant_id?: unknown };
      const experimentId = parseExperimentId(params.experiment_id);
      const variantId = parseExperimentId(params.variant_id);
      if (experimentId === null) return invalid(reply, "experiment_id must be a UUID");
      if (variantId === null) return invalid(reply, "variant_id must be a UUID");
      const parsed = recordVariantStatsRequestSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? "Invalid body");
      try {
        const experiment = await getExperiment(app.db.pool, experimentId);
        if (experiment === null) return reply.code(404).send({ error: "Experiment not found" });
        if (!experiment.variants.some((variant) => variant.id === variantId)) {
          return reply.code(404).send({ error: "Variant not found" });
        }
        const variant = await app.db.withActor(request, (tx) =>
          recordVariantStats(tx, {
            variantId,
            ...(parsed.data.impressions === undefined
              ? {}
              : { impressions: parsed.data.impressions }),
            ...(parsed.data.ctr === undefined ? {} : { ctr: parsed.data.ctr }),
          }),
        );
        const response = recordVariantStatsResponseSchema.safeParse({
          variant: {
            id: variant.id,
            experiment_id: variant.experimentId,
            label: variant.label,
            content: variant.content,
            is_control: variant.isControl,
            impressions: variant.impressions,
            ctr: variant.ctr,
            created_by: variant.createdBy,
            updated_by: variant.updatedBy,
          },
        });
        if (!response.success) throw response.error;
        return reply.send(response.data);
      } catch (error) {
        return sendDbError(reply, error);
      }
    },
  );

  app.post(
    EXPERIMENT_CONCLUDE_PATH,
    { preHandler: app.requireLevel("experiments", "write") },
    async (request, reply) => {
      const id = parseExperimentId((request.params as { experiment_id?: unknown }).experiment_id);
      if (id === null) return invalid(reply, "experiment_id must be a UUID");
      const parsed = concludeExperimentRequestSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? "Invalid body");
      try {
        const experiment = await app.db.withActor(request, (tx) =>
          concludeExperiment(tx, {
            id,
            expectedVersion: parsed.data.expected_version,
            winnerVariantId: parsed.data.winner_variant_id,
            conclusion: parsed.data.conclusion,
          }),
        );
        const response = concludeExperimentResponseSchema.safeParse({
          experiment: {
            id: experiment.id,
            status: experiment.status,
            starts_at: iso(experiment.startsAt),
            ends_at: iso(experiment.endsAt),
            version: experiment.version,
            updated_at: experiment.updatedAt.toISOString(),
            updated_by: experiment.updatedBy,
            winner_variant_id: experiment.winnerVariantId,
            conclusion: experiment.conclusion,
          },
        });
        if (!response.success) throw response.error;
        return reply.send(response.data);
      } catch (error) {
        return sendDbError(reply, error);
      }
    },
  );
}
