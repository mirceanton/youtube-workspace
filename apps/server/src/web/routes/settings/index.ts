import { ForbiddenError, getUserAccess, toClientError, type UserAccess } from "@ytw/db";
import { SETTINGS_PROFILE_PATH, settingsProfileSchema } from "@ytw/shared/api/settings";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";

export function invalidSettingsRequest(
  reply: Parameters<preHandlerHookHandler>[1],
  message: string,
) {
  return reply.code(400).send({ error: message });
}

export function sendSettingsError(reply: Parameters<preHandlerHookHandler>[1], error: unknown) {
  if (error instanceof ForbiddenError) {
    return reply.code(403).send({ error: error.message });
  }
  const client = toClientError(error);
  return reply.code(client.status).send({ error: client.message });
}

export function settingsAuthOf(request: FastifyRequest): FastifyRequest["auth"] {
  return request.auth;
}

export async function currentSettingsAccess(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<UserAccess | null> {
  const auth = settingsAuthOf(request);
  if (!auth) return null;
  return getUserAccess(app.db.pool, auth.userId);
}

/** The signed-in profile, including the stable identity-provider issuer and subject. */
export default async function settingsRoutes(server: FastifyInstance): Promise<void> {
  const app = server;

  app.get(
    SETTINGS_PROFILE_PATH,
    { preHandler: app.requireAnyLevel("read") },
    async (request, reply) => {
      try {
        const profile = await currentSettingsAccess(app, request);
        if (!profile) return reply.code(401).send({ error: "Authentication required" });
        const payload = {
          profile: {
            id: profile.id,
            username: profile.username,
            display_name: profile.displayName,
            email: profile.email,
            issuer: profile.issuer,
            subject: profile.subject,
            is_admin: profile.isAdmin,
            access_revoked_at: profile.accessRevokedAt?.toISOString() ?? null,
          },
          levels: profile.levels,
        };
        return reply.send(settingsProfileSchema.parse(payload));
      } catch (error) {
        return sendSettingsError(reply, error);
      }
    },
  );
}

/** Admin-only route guard, backed by the current database state on every request. */
export function requireCurrentAdmin(app: FastifyInstance): preHandlerHookHandler {
  return async (request, reply) => {
    const auth = settingsAuthOf(request);
    if (!auth) return reply.code(401).send({ error: "Authentication required" });
    const access = await currentSettingsAccess(app, request);
    if (!access) return reply.code(401).send({ error: "Authentication required" });
    if (!access.isAdmin) return reply.code(403).send({ error: "Admin access required" });
  };
}
