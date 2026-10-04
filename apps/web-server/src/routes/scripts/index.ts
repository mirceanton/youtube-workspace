import {
  saveScriptVersion,
  setScriptStatus,
  toClientError,
  VersionConflictError,
  type ScriptRecord,
  type Queryable,
} from "@ytw/db";
import {
  isScriptMdError,
  normalizeBody,
  prepareUpload,
  scriptFileName,
  serializeScriptFile,
  SCRIPT_FILE_MAX_INPUT_BYTES,
} from "@ytw/script-md";
import { SCRIPT_BODY_MAX_BYTES, type ScriptKind } from "@ytw/shared/constants";
import {
  getScriptResponseSchema,
  listScriptHistoryQuerySchema,
  listScriptsResponseSchema,
  listScriptHistoryResponseSchema,
  saveScriptRequestSchema,
  saveScriptResponseSchema,
  setScriptStatusRequestSchema,
  setScriptStatusResponseSchema,
  SCRIPTS_HISTORY_PATH,
  SCRIPTS_PATH,
  SCRIPTS_UPLOAD_PATH,
  uploadScriptQuerySchema,
} from "@ytw/shared/api/scripts";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { ActorTx } from "@ytw/db";
import { z } from "zod";

type ScriptsCore = FastifyInstance & {
  requireLevel(resource: "scripts", level: "read" | "write"): preHandlerHookHandler;
  db: {
    pool: Queryable;
    withActor<T>(request: FastifyRequest, fn: (client: ActorTx) => Promise<T>): Promise<T>;
  };
};

interface ScriptRow {
  id: string;
  idea_id: string;
  idea_title?: string;
  kind: ScriptKind;
  version: number;
  status: "draft" | "review" | "approved";
  size_bytes: number;
  created_at: Date;
  updated_at: Date;
  created_by: string;
  updated_by: string;
  body_md?: string;
}

function toApiScript(row: ScriptRow) {
  return {
    id: row.id,
    idea_id: row.idea_id,
    ...(row.idea_title === undefined ? {} : { idea_title: row.idea_title }),
    kind: row.kind,
    version: row.version,
    status: row.status,
    size_bytes: row.size_bytes,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

function scriptRecordToApi(row: ScriptRecord) {
  return {
    id: row.id,
    idea_id: row.ideaId,
    kind: row.kind,
    version: row.version,
    status: row.status,
    size_bytes: row.sizeBytes,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    created_by: row.createdBy,
    updated_by: row.updatedBy,
  };
}

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message });
}

function sendScriptError(reply: FastifyReply, error: unknown) {
  if (isScriptMdError(error)) {
    return reply.code(error.httpStatus).send({
      error: error.message,
      code: error.code,
      details: error.details,
    });
  }
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

const SCRIPT_COLUMNS = `s.id, s.idea_id, s.kind, s.version, s.status,
  octet_length(s.body_md) AS size_bytes, s.created_at, s.updated_at, s.created_by, s.updated_by`;

/** Human API for script history, new immutable revisions, status, and shared markdown files. */
export default async function scriptsRoutes(server: FastifyInstance): Promise<void> {
  const app = server as ScriptsCore;

  // Mirrors the MCP file route parser and cap. The front matter is validated by @ytw/script-md.
  app.addContentTypeParser(
    ["text/markdown", "text/plain"],
    { parseAs: "buffer", bodyLimit: SCRIPT_FILE_MAX_INPUT_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.get(
    SCRIPTS_PATH,
    { preHandler: app.requireLevel("scripts", "read") },
    async (_request, reply) => {
      const { rows } = await app.db.pool.query<ScriptRow>(
        `SELECT * FROM (
           SELECT DISTINCT ON (s.idea_id, s.kind) ${SCRIPT_COLUMNS}, i.title AS idea_title
             FROM public.scripts s
             JOIN public.ideas i ON i.id = s.idea_id
            WHERE i.archived_at IS NULL
            ORDER BY s.idea_id, s.kind, s.version DESC
         ) latest
          ORDER BY lower(latest.idea_title), latest.kind`,
      );
      const response = listScriptsResponseSchema.safeParse({
        scripts: rows.map(toApiScript),
      });
      if (!response.success) throw response.error;
      return reply.send(response.data);
    },
  );

  app.get(
    SCRIPTS_HISTORY_PATH,
    { preHandler: app.requireLevel("scripts", "read") },
    async (request, reply) => {
      const parsed = listScriptHistoryQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return invalid(reply, parsed.error.issues[0]?.message ?? "Invalid query");
      const { idea_id: ideaId, kind } = parsed.data;
      const idea = await app.db.pool.query<{ title: string }>(
        "SELECT title FROM public.ideas WHERE id = $1::uuid",
        [ideaId],
      );
      if (idea.rows.length === 0) return reply.code(404).send({ error: "Idea not found" });

      const { rows } = await app.db.pool.query<ScriptRow>(
        `SELECT ${SCRIPT_COLUMNS}
           FROM public.scripts s
          WHERE s.idea_id = $1::uuid AND s.kind = $2::text
          ORDER BY s.version DESC`,
        [ideaId, kind],
      );
      const response = listScriptHistoryResponseSchema.safeParse({
        idea_id: ideaId,
        idea_title: idea.rows[0]?.title ?? "Untitled idea",
        kind,
        versions: rows.map(toApiScript),
      });
      if (!response.success) throw response.error;
      return reply.send(response.data);
    },
  );

  app.get(
    `${SCRIPTS_PATH}/:script_id`,
    { preHandler: app.requireLevel("scripts", "read") },
    async (request, reply) => {
      const params = request.params as { script_id?: unknown };
      const id = typeof params.script_id === "string" ? params.script_id : "";
      const parsedId = z.string().uuid().safeParse(id);
      if (!parsedId.success) return invalid(reply, "script_id must be a UUID");
      const { rows } = await app.db.pool.query<ScriptRow>(
        `SELECT ${SCRIPT_COLUMNS}, s.body_md
           FROM public.scripts s
          WHERE s.id = $1::uuid`,
        [parsedId.data],
      );
      const row = rows[0];
      if (row === undefined) return reply.code(404).send({ error: "Script version not found" });
      const response = getScriptResponseSchema.safeParse({
        script: { ...toApiScript(row), body_md: row.body_md },
      });
      if (!response.success) throw response.error;
      return reply.send(response.data);
    },
  );

  app.get(
    `${SCRIPTS_PATH}/:script_id/file`,
    { preHandler: app.requireLevel("scripts", "read") },
    async (request, reply) => {
      const params = request.params as { script_id?: unknown };
      const id = typeof params.script_id === "string" ? params.script_id : "";
      const parsedId = z.string().uuid().safeParse(id);
      if (!parsedId.success) return invalid(reply, "script_id must be a UUID");
      const { rows } = await app.db.pool.query<ScriptRow>(
        `SELECT ${SCRIPT_COLUMNS}, s.body_md
           FROM public.scripts s
          WHERE s.id = $1::uuid`,
        [parsedId.data],
      );
      const row = rows[0];
      if (row === undefined) return reply.code(404).send({ error: "Script version not found" });
      const content = serializeScriptFile({
        ideaId: row.idea_id,
        kind: row.kind,
        version: row.version,
        status: row.status,
        body: row.body_md ?? "",
      });
      const filename = scriptFileName({
        ideaId: row.idea_id,
        kind: row.kind,
        version: row.version,
      });
      return reply
        .type("text/markdown; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(content);
    },
  );

  app.post(
    SCRIPTS_PATH,
    {
      preHandler: app.requireLevel("scripts", "write"),
      bodyLimit: SCRIPT_BODY_MAX_BYTES + 16_384,
    },
    async (request, reply) => {
      const parsed = saveScriptRequestSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? "Invalid body");
      try {
        const bodyMd = normalizeBody(parsed.data.body_md);
        const script = await app.db.withActor(request, (tx) =>
          saveScriptVersion(tx, {
            ideaId: parsed.data.idea_id,
            kind: parsed.data.kind,
            baseVersion: parsed.data.base_version,
            bodyMd,
          }),
        );
        const response = saveScriptResponseSchema.safeParse({ script: scriptRecordToApi(script) });
        if (!response.success) throw response.error;
        return reply.code(201).send(response.data);
      } catch (error) {
        return sendScriptError(reply, error);
      }
    },
  );

  app.patch(
    `${SCRIPTS_PATH}/:script_id/status`,
    { preHandler: app.requireLevel("scripts", "write") },
    async (request, reply) => {
      const params = request.params as { script_id?: unknown };
      const id = typeof params.script_id === "string" ? params.script_id : "";
      const parsedId = z.string().uuid().safeParse(id);
      if (!parsedId.success) return invalid(reply, "script_id must be a UUID");
      const parsed = setScriptStatusRequestSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? "Invalid body");
      try {
        const script = await app.db.withActor(request, (tx) =>
          setScriptStatus(tx, { scriptId: parsedId.data, status: parsed.data.status }),
        );
        const response = setScriptStatusResponseSchema.safeParse({
          script: scriptRecordToApi(script),
        });
        if (!response.success) throw response.error;
        return reply.send(response.data);
      } catch (error) {
        return sendScriptError(reply, error);
      }
    },
  );

  app.post(
    SCRIPTS_UPLOAD_PATH,
    {
      preHandler: app.requireLevel("scripts", "write"),
      bodyLimit: SCRIPT_FILE_MAX_INPUT_BYTES,
    },
    async (request, reply) => {
      const parsed = uploadScriptQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return invalid(reply, parsed.error.issues[0]?.message ?? "Invalid query");
      const content = request.body;
      if (typeof content !== "string" && !(content instanceof Uint8Array)) {
        return invalid(reply, "Upload a UTF-8 Markdown file as text/markdown");
      }
      try {
        const prepared = prepareUpload(content, {
          ideaId: parsed.data.idea_id,
          kind: parsed.data.kind,
          ...(parsed.data.base_version === undefined
            ? {}
            : { baseVersion: parsed.data.base_version }),
          requireBaseVersion: true,
        });
        const script = await app.db.withActor(request, (tx) =>
          saveScriptVersion(tx, {
            ideaId: parsed.data.idea_id,
            kind: parsed.data.kind,
            baseVersion: prepared.baseVersion ?? 0,
            bodyMd: prepared.body,
          }),
        );
        const response = saveScriptResponseSchema.safeParse({ script: scriptRecordToApi(script) });
        if (!response.success) throw response.error;
        return reply.code(201).send(response.data);
      } catch (error) {
        return sendScriptError(reply, error);
      }
    },
  );
}
