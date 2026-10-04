import {
  advanceIdea,
  archiveIdea,
  createIdea,
  getIdeaPipeline,
  listIdeas,
  listVideoPerformance,
  toClientError,
  updateIdea,
  type ActorTx,
  type IdeaPipelineRecord,
  type Queryable,
} from "@ytw/db";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Idea, IdeaScriptSummary, IdeaVideoLink } from "@ytw/shared/api/ideas";
import {
  advanceIdeaRequestSchema,
  archiveIdeaRequestSchema,
  createIdeaRequestSchema,
  listIdeasQuerySchema,
  updateIdeaRequestSchema,
} from "@ytw/shared/api/ideas";
import type { IdeaStage } from "@ytw/shared/constants";
import type { WebAuth } from "../../core/types.js";

type IdeaRequest = FastifyRequest & { auth: WebAuth };

/** The subset of T40's documented core contract this plugin uses. */
type IdeasCore = FastifyInstance & {
  requireLevel(resource: "ideas", level: "read" | "write"): preHandlerHookHandler;
  db: {
    pool: Queryable;
    withActor<T>(request: FastifyRequest, fn: (tx: ActorTx) => Promise<T>): Promise<T>;
  };
};

interface IdeaParams {
  id: string;
}

function iso(value: Date): string {
  return value.toISOString();
}

function scriptSummary(value: IdeaPipelineRecord["latestScript"]): IdeaScriptSummary | null {
  return value
    ? { id: value.id, version: value.version, status: value.status, saved_at: iso(value.savedAt) }
    : null;
}

function serializeIdea(value: IdeaPipelineRecord, includeScriptLinks: boolean): Idea {
  return {
    id: value.id,
    title: value.title,
    pitch: value.pitch,
    status: value.status,
    status_changed_at: iso(value.statusChangedAt),
    age_in_stage_seconds: Math.max(0, value.ageInStageSeconds),
    days_in_stage: Math.max(0, value.daysInStage),
    score: value.score,
    source: value.source,
    tags: value.tags,
    version: value.version,
    archived_at: value.archivedAt ? iso(value.archivedAt) : null,
    created_at: iso(value.createdAt),
    updated_at: iso(value.updatedAt),
    created_by: value.createdBy,
    updated_by: value.updatedBy,
    ...(includeScriptLinks
      ? {
          latest_script: scriptSummary(value.latestScript),
          latest_packaging: value.latestPackaging
            ? {
                id: value.latestPackaging.id,
                version: value.latestPackaging.version,
                status: value.latestPackaging.status,
                saved_at: iso(value.latestPackaging.savedAt),
              }
            : null,
        }
      : {}),
  };
}

function canReadScripts(request: IdeaRequest): boolean {
  return request.auth.levels.scripts !== "none";
}

function canReadVideos(request: IdeaRequest): boolean {
  return request.auth.levels.videos !== "none";
}

function asParams(request: FastifyRequest): IdeaParams | null {
  const params = request.params as Partial<IdeaParams>;
  return typeof params.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.id)
    ? { id: params.id }
    : null;
}

function videoLink(
  record: Awaited<ReturnType<typeof listVideoPerformance>>[number],
): IdeaVideoLink {
  return {
    id: record.id,
    title: record.title,
    youtube_id: record.youtubeId,
    published_at: record.publishedAt ? iso(record.publishedAt) : null,
    thumbnail_url: record.thumbnailUrl,
    views: record.latest?.views ?? null,
    impressions: record.latest?.impressions ?? null,
    ctr: record.latest?.ctr ?? null,
    avg_view_duration_s: record.latest?.avgViewDurationS ?? null,
  };
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message });
}

async function sendFailure(
  app: IdeasCore,
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  id?: string,
) {
  const clientError = toClientError(error);
  let latest: Idea | null | undefined;
  if (clientError.status === 409 && id) {
    try {
      const current = await getIdeaPipeline(app.db.pool, id, true);
      latest = current ? serializeIdea(current, canReadScripts(request as IdeaRequest)) : null;
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

/** Ideas API. Every route guards current-level access and delegates mutations to the shared DB wrappers. */
export default async function ideasRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance as IdeasCore;

  app.get(
    "/api/ideas",
    { preHandler: app.requireLevel("ideas", "read") },
    async (request, reply) => {
      const parsed = listIdeasQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid idea filters");
      const authRequest = request as IdeaRequest;
      try {
        const result = await listIdeas(app.db.pool, {
          ...(parsed.data.stage ? { stage: parsed.data.stage } : {}),
          ...(parsed.data.tag ? { tag: parsed.data.tag } : {}),
          ...(parsed.data.score_min !== undefined ? { scoreMin: parsed.data.score_min } : {}),
          ...(parsed.data.score_max !== undefined ? { scoreMax: parsed.data.score_max } : {}),
          ...(parsed.data.source ? { source: parsed.data.source } : {}),
          includeArchived: parsed.data.include_archived,
          sortBy: parsed.data.sort_by,
          sortOrder: parsed.data.sort_order,
          limit: parsed.data.limit,
          offset: parsed.data.offset,
        });
        return reply.send({
          ideas: result.ideas.map((idea) => serializeIdea(idea, canReadScripts(authRequest))),
          page: { limit: parsed.data.limit, offset: parsed.data.offset, total: result.total },
        });
      } catch (error) {
        return sendFailure(app, request, reply, error);
      }
    },
  );

  app.post(
    "/api/ideas",
    { preHandler: app.requireLevel("ideas", "write") },
    async (request, reply) => {
      const parsed = createIdeaRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid idea");
      try {
        const created = await app.db.withActor(request, (tx) => createIdea(tx, parsed.data));
        const pipeline = await getIdeaPipeline(app.db.pool, created.id, true);
        if (!pipeline) return reply.code(500).send({ error: "The new idea could not be loaded" });
        return reply
          .code(201)
          .send({ idea: serializeIdea(pipeline, canReadScripts(request as IdeaRequest)) });
      } catch (error) {
        return sendFailure(app, request, reply, error);
      }
    },
  );

  app.get<{ Params: IdeaParams }>(
    "/api/ideas/:id",
    { preHandler: app.requireLevel("ideas", "read") },
    async (request, reply) => {
      const params = asParams(request);
      if (!params) return badRequest(reply, "id must be a valid UUID");
      try {
        const idea = await getIdeaPipeline(app.db.pool, params.id, true);
        if (!idea) return reply.code(404).send({ error: "Idea not found" });
        const authRequest = request as IdeaRequest;
        const relatedVideos = canReadVideos(authRequest)
          ? await listVideoPerformance(app.db.pool, { ideaId: params.id, limit: 100 })
          : undefined;
        return reply.send({
          idea: serializeIdea(idea, canReadScripts(authRequest)),
          ...(relatedVideos === undefined ? {} : { videos: relatedVideos.map(videoLink) }),
        });
      } catch (error) {
        return sendFailure(app, request, reply, error, params.id);
      }
    },
  );

  app.patch<{ Params: IdeaParams }>(
    "/api/ideas/:id",
    { preHandler: app.requireLevel("ideas", "write") },
    async (request, reply) => {
      const params = asParams(request);
      if (!params) return badRequest(reply, "id must be a valid UUID");
      const parsed = updateIdeaRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid idea update");
      const { expected_version: expectedVersion, ...fields } = parsed.data;
      try {
        const updated = await app.db.withActor(request, (tx) =>
          updateIdea(tx, { id: params.id, expectedVersion, fields }),
        );
        const pipeline = await getIdeaPipeline(app.db.pool, updated.id, true);
        if (!pipeline) return reply.code(404).send({ error: "Idea not found" });
        return reply.send({
          idea: serializeIdea(pipeline, canReadScripts(request as IdeaRequest)),
        });
      } catch (error) {
        return sendFailure(app, request, reply, error, params.id);
      }
    },
  );

  app.post<{ Params: IdeaParams }>(
    "/api/ideas/:id/stage",
    { preHandler: app.requireLevel("ideas", "write") },
    async (request, reply) => {
      const params = asParams(request);
      if (!params) return badRequest(reply, "id must be a valid UUID");
      const parsed = advanceIdeaRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid stage move");
      try {
        const moved = await app.db.withActor(request, (tx) =>
          advanceIdea(tx, {
            id: params.id,
            newStatus: parsed.data.new_status as IdeaStage,
            note: parsed.data.note,
            expectedVersion: parsed.data.expected_version,
          }),
        );
        const pipeline = await getIdeaPipeline(app.db.pool, moved.idea.id, true);
        if (!pipeline) return reply.code(404).send({ error: "Idea not found" });
        return reply.send({
          idea: serializeIdea(pipeline, canReadScripts(request as IdeaRequest)),
        });
      } catch (error) {
        return sendFailure(app, request, reply, error, params.id);
      }
    },
  );

  app.post<{ Params: IdeaParams }>(
    "/api/ideas/:id/archive",
    { preHandler: app.requireLevel("ideas", "write") },
    async (request, reply) => {
      const params = asParams(request);
      if (!params) return badRequest(reply, "id must be a valid UUID");
      const parsed = archiveIdeaRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid archive request");
      try {
        const archived = await app.db.withActor(request, (tx) =>
          archiveIdea(tx, { id: params.id, expectedVersion: parsed.data.expected_version }),
        );
        const pipeline = await getIdeaPipeline(app.db.pool, archived.id, true);
        if (!pipeline) return reply.code(404).send({ error: "Idea not found" });
        return reply.send({
          idea: serializeIdea(pipeline, canReadScripts(request as IdeaRequest)),
        });
      } catch (error) {
        return sendFailure(app, request, reply, error, params.id);
      }
    },
  );
}
