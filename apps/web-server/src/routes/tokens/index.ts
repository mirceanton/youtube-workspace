import { getUserAccess, listApiTokens, type ApiTokenInfo } from "@ytw/db";
import {
  createSettingsTokenRequestSchema,
  issuedSettingsTokenResponseSchema,
  listSettingsTokensResponseSchema,
  rotateSettingsTokenRequestSchema,
  SETTINGS_TOKENS_PATH,
  settingsTokenSchema,
  updateSettingsTokenRequestSchema,
} from "@ytw/shared/api/settings";
import { createToken, revokeToken, rotateToken, TokenGrantError, updateToken } from "@ytw/tokens";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  invalidSettingsRequest,
  sendSettingsError,
  settingsAuthOf,
  type SettingsCore,
} from "../settings/index.js";

const DEFAULT_EXPIRY_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function tokenForApi(token: ApiTokenInfo) {
  return settingsTokenSchema.parse({
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    status: token.status,
    created_at: token.createdAt.toISOString(),
    expires_at: token.expiresAt?.toISOString() ?? null,
    last_used_at: token.lastUsedAt?.toISOString() ?? null,
    revoked_at: token.revokedAt?.toISOString() ?? null,
    levels: token.levels,
    effective_levels: token.effectiveLevels,
  });
}

function tokenParams(request: FastifyRequest): { tokenId: string } | null {
  const params = request.params as { tokenId?: unknown };
  return typeof params.tokenId === "string" ? { tokenId: params.tokenId } : null;
}

function tokenIdSchema(request: FastifyRequest): string | null {
  const params = tokenParams(request);
  if (params === null) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    params.tokenId,
  )
    ? params.tokenId
    : null;
}

/** Own-token management API. The secret is returned only from create and rotate. */
export default async function tokenRoutes(server: FastifyInstance): Promise<void> {
  const app = server as SettingsCore;
  const requireAccess = app.requireAnyLevel("read");

  app.get(SETTINGS_TOKENS_PATH, { preHandler: requireAccess }, async (request, reply) => {
    try {
      const auth = settingsAuthOf(request);
      if (!auth) return reply.code(401).send({ error: "Authentication required" });
      const tokens = await listApiTokens(app.db.pool, auth.userId);
      return reply.send(
        listSettingsTokensResponseSchema.parse({
          tokens: tokens.map(tokenForApi),
        }),
      );
    } catch (error) {
      return sendSettingsError(reply, error);
    }
  });

  app.post(SETTINGS_TOKENS_PATH, { preHandler: requireAccess }, async (request, reply) => {
    const parsed = createSettingsTokenRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return invalidSettingsRequest(reply, parsed.error.issues[0]?.message ?? "Invalid token");
    }
    try {
      const auth = settingsAuthOf(request);
      if (!auth) return reply.code(401).send({ error: "Authentication required" });
      const owner = await getUserAccess(app.db.pool, auth.userId);
      if (!owner) return reply.code(401).send({ error: "Authentication required" });
      const expiresAt =
        parsed.data.expires_at === undefined
          ? new Date(Date.now() + DEFAULT_EXPIRY_DAYS * DAY_MS)
          : parsed.data.expires_at === null
            ? null
            : new Date(parsed.data.expires_at);
      const issued = await createToken(
        app.db.pool,
        { id: owner.id, username: owner.username },
        {
          name: parsed.data.name,
          expiresAt,
          permissions: parsed.data.permissions,
        },
      );
      const response = issuedSettingsTokenResponseSchema.parse({
        token: tokenForApi(issued.token),
        secret: issued.secret,
      });
      return reply.code(201).send(response);
    } catch (error) {
      if (error instanceof TokenGrantError) {
        return reply.code(403).send({ error: error.message });
      }
      return sendSettingsError(reply, error);
    }
  });

  app.patch(
    `${SETTINGS_TOKENS_PATH}/:tokenId`,
    { preHandler: requireAccess },
    async (request, reply) => {
      const tokenId = tokenIdSchema(request);
      if (!tokenId) return invalidSettingsRequest(reply, "tokenId must be a UUID");
      const parsed = updateSettingsTokenRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidSettingsRequest(reply, parsed.error.issues[0]?.message ?? "Invalid token");
      }
      try {
        const auth = settingsAuthOf(request);
        if (!auth) return reply.code(401).send({ error: "Authentication required" });
        const token = await updateToken(
          app.db.pool,
          { id: auth.userId, username: auth.username },
          tokenId,
          parsed.data.permissions,
        );
        return reply.send({ token: tokenForApi(token) });
      } catch (error) {
        if (error instanceof TokenGrantError) {
          return reply.code(403).send({ error: error.message });
        }
        return sendSettingsError(reply, error);
      }
    },
  );

  app.post(
    `${SETTINGS_TOKENS_PATH}/:tokenId/rotate`,
    { preHandler: requireAccess },
    async (request, reply) => {
      const tokenId = tokenIdSchema(request);
      if (!tokenId) return invalidSettingsRequest(reply, "tokenId must be a UUID");
      const parsed = rotateSettingsTokenRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return invalidSettingsRequest(reply, parsed.error.issues[0]?.message ?? "Invalid expiry");
      }
      try {
        const auth = settingsAuthOf(request);
        if (!auth) return reply.code(401).send({ error: "Authentication required" });
        const issued = await rotateToken(
          app.db.pool,
          { id: auth.userId, username: auth.username },
          tokenId,
          parsed.data.expires_at === undefined
            ? undefined
            : parsed.data.expires_at === null
              ? null
              : new Date(parsed.data.expires_at),
        );
        return reply.send(
          issuedSettingsTokenResponseSchema.parse({
            token: tokenForApi(issued.token),
            secret: issued.secret,
          }),
        );
      } catch (error) {
        return sendSettingsError(reply, error);
      }
    },
  );

  app.delete(
    `${SETTINGS_TOKENS_PATH}/:tokenId`,
    { preHandler: requireAccess },
    async (request, reply) => {
      const tokenId = tokenIdSchema(request);
      if (!tokenId) return invalidSettingsRequest(reply, "tokenId must be a UUID");
      try {
        const auth = settingsAuthOf(request);
        if (!auth) return reply.code(401).send({ error: "Authentication required" });
        const token = await revokeToken(
          app.db.pool,
          { id: auth.userId, username: auth.username },
          tokenId,
        );
        return reply.send({ token: tokenForApi(token) });
      } catch (error) {
        return sendSettingsError(reply, error);
      }
    },
  );
}
