/**
 * HTTP file export and import routes for scripts (PRD 5, T34).
 *
 * GET /files/scripts/:idea_id/:kind
 * PUT /files/scripts/:idea_id/:kind
 */
import {
  getScriptVersion,
  saveScriptVersion,
  toClientError,
  VersionConflictError,
  withActor,
  type Actor,
} from "@ytw/db";
import { authorize } from "@ytw/policy";
import {
  isScriptMdError,
  parseBaseVersion,
  prepareUpload,
  serializeScriptFile,
} from "@ytw/script-md";
import { SCRIPT_KINDS, type ScriptKind } from "@ytw/shared/constants";
import type { Authenticator } from "@ytw/tokens";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { logToolCallEvent } from "../audit.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface FilesPluginOptions {
  pool: Pool;
  authenticator: Authenticator;
}

export async function filesPlugin(
  app: FastifyInstance,
  options: FilesPluginOptions,
): Promise<void> {
  const { pool, authenticator } = options;

  // Add content type parser for text/markdown and text/plain
  app.addContentTypeParser(
    ["text/markdown", "text/plain"],
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // GET /files/scripts/:idea_id/:kind
  app.get(
    "/files/scripts/:idea_id/:kind",
    async (
      request: FastifyRequest<{
        Params: { idea_id: string; kind: string };
        Querystring: { version?: string };
      }>,
      reply: FastifyReply,
    ) => {
      // 1. Authenticate bearer token
      const auth = await authenticator.authenticate(request.headers.authorization, request.ip);
      if (!auth.ok) {
        if (auth.reason === "rate_limited") {
          reply.header("Retry-After", auth.retryAfterSeconds ?? 60);
          return reply
            .status(429)
            .send({ error: "rate_limited", message: "Too many authentication failures" });
        }
        return reply.status(401).send({ error: "unauthorized", message: "Unauthorized" });
      }

      const { principal } = auth;
      const { idea_id: ideaId, kind } = request.params;

      // 2. Validate route parameters (guard against path traversal and malformed inputs)
      if (!UUID_REGEX.test(ideaId)) {
        return reply.status(400).send({
          error: "validation",
          message: `Invalid idea_id: "${ideaId}" is not a valid UUID.`,
        });
      }

      if (!SCRIPT_KINDS.includes(kind as ScriptKind)) {
        return reply.status(400).send({
          error: "validation",
          message: `Invalid kind: "${kind}". Must be one of: ${SCRIPT_KINDS.join(", ")}.`,
        });
      }

      let requestedVersion: number | undefined;
      if (request.query.version !== undefined) {
        const v = Number(request.query.version);
        if (!Number.isInteger(v) || v < 1) {
          return reply.status(400).send({
            error: "validation",
            message: `Invalid version parameter: "${request.query.version}". Must be a positive integer.`,
          });
        }
        requestedVersion = v;
      }

      // 3. Permission check: requires Read on scripts
      const decision = authorize(principal, { resource: "scripts", level: "read" });
      if (!decision.allowed) {
        await logToolCallEvent(pool, {
          actor: principal.tokenName,
          tokenId: principal.tokenId,
          tool: "export_script",
          outcome: "denied",
          tokenOwner: principal.owner.username,
        }).catch((err) => {
          request.log.error(err, "failed to log audit event");
        });

        return reply.status(403).send({ error: "forbidden", message: decision.message });
      }

      // 4. Fetch script revision
      try {
        const script = await getScriptVersion(pool, {
          ideaId,
          kind: kind as ScriptKind,
          version: requestedVersion,
        });

        if (!script) {
          return reply.status(404).send({
            error: "not_found",
            message: `Script for idea "${ideaId}" and kind "${kind}"${requestedVersion !== undefined ? ` version ${requestedVersion}` : ""} was not found.`,
          });
        }

        const serialized = serializeScriptFile({
          ideaId: script.ideaId,
          kind: script.kind,
          version: script.version,
          status: script.status,
          body: script.bodyMd,
        });

        await logToolCallEvent(pool, {
          actor: principal.tokenName,
          tokenId: principal.tokenId,
          tool: "export_script",
          outcome: "ok",
          tokenOwner: principal.owner.username,
          entityType: "script",
          entityId: script.id,
        }).catch((err) => {
          request.log.error(err, "failed to log audit event");
        });

        return reply.type("text/markdown; charset=utf-8").send(serialized);
      } catch (error) {
        const clientError = toClientError(error);
        return reply.status(clientError.status).send(clientError);
      }
    },
  );

  // PUT /files/scripts/:idea_id/:kind
  app.put(
    "/files/scripts/:idea_id/:kind",
    async (
      request: FastifyRequest<{
        Params: { idea_id: string; kind: string };
        Querystring: { base_version?: string };
        Body: string;
      }>,
      reply: FastifyReply,
    ) => {
      // 1. Authenticate bearer token
      const auth = await authenticator.authenticate(request.headers.authorization, request.ip);
      if (!auth.ok) {
        if (auth.reason === "rate_limited") {
          reply.header("Retry-After", auth.retryAfterSeconds ?? 60);
          return reply
            .status(429)
            .send({ error: "rate_limited", message: "Too many authentication failures" });
        }
        return reply.status(401).send({ error: "unauthorized", message: "Unauthorized" });
      }

      const { principal } = auth;
      const { idea_id: ideaId, kind } = request.params;

      // 2. Validate route parameters
      if (!UUID_REGEX.test(ideaId)) {
        return reply.status(400).send({
          error: "validation",
          message: `Invalid idea_id: "${ideaId}" is not a valid UUID.`,
        });
      }

      if (!SCRIPT_KINDS.includes(kind as ScriptKind)) {
        return reply.status(400).send({
          error: "validation",
          message: `Invalid kind: "${kind}". Must be one of: ${SCRIPT_KINDS.join(", ")}.`,
        });
      }

      // 3. Permission check: requires Write on scripts
      const decision = authorize(principal, { resource: "scripts", level: "write" });
      if (!decision.allowed) {
        await logToolCallEvent(pool, {
          actor: principal.tokenName,
          tokenId: principal.tokenId,
          tool: "save_script_version",
          outcome: "denied",
          tokenOwner: principal.owner.username,
        }).catch((err) => {
          request.log.error(err, "failed to log audit event");
        });

        return reply.status(403).send({ error: "forbidden", message: decision.message });
      }

      // 4. Parse query base_version if present
      let explicitBaseVersion: number | undefined;
      if (request.query.base_version !== undefined) {
        try {
          explicitBaseVersion = parseBaseVersion(request.query.base_version);
        } catch (err) {
          if (isScriptMdError(err)) {
            return reply.status(err.httpStatus).send({ error: err.code, message: err.message });
          }
          return reply.status(400).send({
            error: "validation",
            message: `Invalid base_version: ${String(request.query.base_version)}`,
          });
        }
      }

      // 5. Prepare upload (strips front matter, checks idea_id/kind matches, verifies base_version)
      const rawBody = typeof request.body === "string" ? request.body : "";
      let prepared;
      try {
        prepared = prepareUpload(rawBody, {
          ideaId,
          kind: kind as ScriptKind,
          baseVersion: explicitBaseVersion,
          requireBaseVersion: true,
        });
      } catch (err) {
        if (isScriptMdError(err)) {
          return reply.status(err.httpStatus).send({
            error: err.code,
            message: err.message,
            ...err.details,
          });
        }
        return reply.status(400).send({ error: "validation", message: (err as Error).message });
      }

      // 6. Save script revision using saveScriptVersion inside withActor
      const actor: Actor = {
        name: principal.tokenName,
        type: "agent",
        tokenId: principal.tokenId,
      };

      try {
        const saved = await withActor(pool, actor, async (tx) => {
          return saveScriptVersion(tx, {
            ideaId,
            kind: kind as ScriptKind,
            baseVersion: prepared.baseVersion ?? 0,
            bodyMd: prepared.body,
          });
        });

        await logToolCallEvent(pool, {
          actor: principal.tokenName,
          tokenId: principal.tokenId,
          tool: "save_script_version",
          outcome: "ok",
          tokenOwner: principal.owner.username,
          entityType: "script",
          entityId: saved.id,
        }).catch((err) => {
          request.log.error(err, "failed to log audit event");
        });

        return reply.status(201).send({
          ...saved,
          latest_version: saved.version,
        });
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
