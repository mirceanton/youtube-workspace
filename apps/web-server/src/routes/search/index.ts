import { searchAll, toClientError, type Queryable } from "@ytw/db";
import { SEARCH_PATH, searchQuerySchema, searchResponseSchema } from "@ytw/shared/api/search";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { WebAuth } from "../../core/types.js";

type SearchCore = FastifyInstance & {
  requireAnyLevel(level: "read" | "write"): preHandlerHookHandler;
  db: { pool: Queryable };
};

/** Global search passes only the resource levels this request currently holds to the DB reader. */
export default async function searchRoutes(server: FastifyInstance): Promise<void> {
  const app = server as SearchCore;

  app.get(SEARCH_PATH, { preHandler: app.requireAnyLevel("read") }, async (request, reply) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid search" });
    }
    const auth = request.auth as WebAuth | undefined;
    if (!auth) return reply.code(401).send({ error: "Authentication required." });

    const resources = (["ideas", "scripts"] as const).filter(
      (resource) => auth.isAdmin || auth.levels[resource] !== "none",
    );
    if (resources.length === 0) {
      return reply.code(403).send({ error: "Read access to ideas or scripts is required." });
    }
    try {
      const results = await searchAll(app.db.pool, {
        query: parsed.data.q,
        limit: parsed.data.limit,
        resources,
      });
      return reply.send(
        searchResponseSchema.parse({
          results: results.map((result) => ({
            entity_type: result.entityType,
            id: result.id,
            idea_id: result.ideaId,
            kind: result.kind,
            version: result.version,
            title: result.title,
            rank: result.rank,
            snippet: result.snippet,
          })),
        }),
      );
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
