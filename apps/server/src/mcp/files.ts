/**
 * Script files over HTTP, for agents that edit outside MCP:
 *
 * - `GET /files/scripts/:idea_id/:kind[?version=N]` returns the markdown with front matter;
 * - `PUT /files/scripts/:idea_id/:kind?base_version=N` saves the body as the next draft revision.
 *
 * Both need the bearer token of the agent group and are audited like the MCP tools they mirror.
 */
import {
  getScriptVersion,
  saveScriptVersion,
  toClientError,
  VersionConflictError,
  withActor,
} from "@ytw/db";
import { authorize } from "@ytw/policy";
import {
  isScriptMdError,
  parseBaseVersion,
  prepareUpload,
  SCRIPT_FILE_MAX_INPUT_BYTES,
  serializeScriptFile,
} from "@ytw/script-md";
import { SCRIPT_KINDS, type ScriptKind } from "@ytw/shared/constants";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { logToolCallEvent } from "./audit.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface FileParams {
  idea_id: string;
  kind: string;
}

/** Checks the route parameters (they are also a guard against path tricks); sends 400 if bad. */
function readTarget(
  params: FileParams,
  reply: FastifyReply,
): { ideaId: string; kind: ScriptKind } | undefined {
  const { idea_id: ideaId, kind } = params;
  if (!UUID_REGEX.test(ideaId)) {
    reply.status(400).send({
      error: "validation",
      message: `Invalid idea_id: "${ideaId}" is not a valid UUID.`,
    });
    return undefined;
  }
  if (!SCRIPT_KINDS.includes(kind as ScriptKind)) {
    reply.status(400).send({
      error: "validation",
      message: `Invalid kind: "${kind}". Must be one of: ${SCRIPT_KINDS.join(", ")}.`,
    });
    return undefined;
  }
  return { ideaId, kind: kind as ScriptKind };
}

export function registerScriptFiles(app: FastifyInstance, pool: Pool): void {
  // Markdown arrives as text; the parsers exist only inside the agent group.
  app.addContentTypeParser(
    ["text/markdown", "text/plain"],
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  const audit = (
    request: FastifyRequest,
    tool: "export_script" | "save_script_version",
    outcome: "ok" | "denied",
    scriptId?: string,
  ): Promise<void> => {
    const principal = request.principal;
    if (principal === undefined) return Promise.resolve();
    return logToolCallEvent(pool, {
      actor: principal.tokenName,
      tokenId: principal.tokenId,
      tool,
      outcome,
      tokenOwner: principal.owner.username,
      ...(scriptId === undefined ? {} : { entityType: "script", entityId: scriptId }),
    }).catch((err: unknown) => {
      request.log.error({ err }, "failed to log audit event");
    });
  };

  app.get<{ Params: FileParams; Querystring: { version?: string } }>(
    "/files/scripts/:idea_id/:kind",
    async (request, reply) => {
      const principal = request.principal;
      const target = readTarget(request.params, reply);
      if (principal === undefined || target === undefined) return reply;

      let requestedVersion: number | undefined;
      if (request.query.version !== undefined) {
        const version = Number(request.query.version);
        if (!Number.isInteger(version) || version < 1) {
          return reply.status(400).send({
            error: "validation",
            message: `Invalid version parameter: "${request.query.version}". Must be a positive integer.`,
          });
        }
        requestedVersion = version;
      }

      const decision = authorize(principal, { resource: "scripts", level: "read" });
      if (!decision.allowed) {
        await audit(request, "export_script", "denied");
        return reply.status(403).send({ error: "forbidden", message: decision.message });
      }

      try {
        const script = await getScriptVersion(pool, { ...target, version: requestedVersion });
        if (!script) {
          return reply.status(404).send({
            error: "not_found",
            message: `Script for idea "${target.ideaId}" and kind "${target.kind}"${requestedVersion !== undefined ? ` version ${requestedVersion}` : ""} was not found.`,
          });
        }
        await audit(request, "export_script", "ok", script.id);
        return reply.type("text/markdown; charset=utf-8").send(
          serializeScriptFile({
            ideaId: script.ideaId,
            kind: script.kind,
            version: script.version,
            status: script.status,
            body: script.bodyMd,
          }),
        );
      } catch (error) {
        const clientError = toClientError(error);
        return reply.status(clientError.status).send(clientError);
      }
    },
  );

  app.put<{ Params: FileParams; Querystring: { base_version?: string }; Body: string }>(
    "/files/scripts/:idea_id/:kind",
    { bodyLimit: SCRIPT_FILE_MAX_INPUT_BYTES },
    async (request, reply) => {
      const principal = request.principal;
      const target = readTarget(request.params, reply);
      if (principal === undefined || target === undefined) return reply;

      const decision = authorize(principal, { resource: "scripts", level: "write" });
      if (!decision.allowed) {
        await audit(request, "save_script_version", "denied");
        return reply.status(403).send({ error: "forbidden", message: decision.message });
      }

      let prepared;
      try {
        const baseVersion =
          request.query.base_version === undefined
            ? undefined
            : parseBaseVersion(request.query.base_version);
        // Strips the front matter, checks that idea_id and kind match the URL and verifies base_version.
        prepared = prepareUpload(typeof request.body === "string" ? request.body : "", {
          ...target,
          baseVersion,
          requireBaseVersion: true,
        });
      } catch (err) {
        if (isScriptMdError(err)) {
          return reply
            .status(err.httpStatus)
            .send({ error: err.code, message: err.message, ...err.details });
        }
        return reply.status(400).send({ error: "validation", message: (err as Error).message });
      }

      try {
        const saved = await withActor(
          pool,
          { name: principal.tokenName, type: "agent", tokenId: principal.tokenId },
          (tx) =>
            saveScriptVersion(tx, {
              ...target,
              baseVersion: prepared.baseVersion ?? 0,
              bodyMd: prepared.body,
            }),
        );
        await audit(request, "save_script_version", "ok", saved.id);
        return reply.status(201).send({ ...saved, latest_version: saved.version });
      } catch (err) {
        if (err instanceof VersionConflictError) {
          return reply.status(409).send({
            error: "version_conflict",
            message: err.message,
            latest_version: err.latestVersion,
            latestVersion: err.latestVersion,
          });
        }
        const clientError = toClientError(err);
        return reply.status(clientError.status).send(clientError);
      }
    },
  );
}
