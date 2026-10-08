import { listUserAccess, setUserAdmin, setUserPermission, type UserAccess } from "@ytw/db";
import {
  listSettingsUsersResponseSchema,
  SETTINGS_USERS_PATH,
  setSettingsUserAdminRequestSchema,
  setSettingsUserPermissionRequestSchema,
  settingsUserSchema,
} from "@ytw/shared/api/settings";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  invalidSettingsRequest,
  requireCurrentAdmin,
  sendSettingsError,
  settingsAuthOf,
} from "../settings/index.js";

function userParams(request: FastifyRequest): string | null {
  const params = request.params as { userId?: unknown };
  if (typeof params.userId !== "string") return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    params.userId,
  )
    ? params.userId
    : null;
}

function userForApi(user: UserAccess) {
  return settingsUserSchema.parse({
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    email: user.email,
    is_admin: user.isAdmin,
    created_at: user.createdAt.toISOString(),
    last_login_at: user.lastLoginAt?.toISOString() ?? null,
    access_revoked_at: user.accessRevokedAt?.toISOString() ?? null,
    levels: user.levels,
  });
}

/** Admin user matrix API; database functions enforce admin and last-admin rules as a second gate. */
export default async function adminRoutes(server: FastifyInstance): Promise<void> {
  const app = server;
  const requireAdmin = [app.requireLevel("activity", "read"), requireCurrentAdmin(app)];

  app.get(SETTINGS_USERS_PATH, { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const auth = settingsAuthOf(request);
      if (!auth) return reply.code(401).send({ error: "Authentication required" });
      const users = await listUserAccess(app.db.pool, auth.userId);
      return reply.send(
        listSettingsUsersResponseSchema.parse({
          users: users.map(userForApi),
        }),
      );
    } catch (error) {
      return sendSettingsError(reply, error);
    }
  });

  app.patch(
    `${SETTINGS_USERS_PATH}/:userId/permissions`,
    { preHandler: requireAdmin },
    async (request, reply) => {
      const userId = userParams(request);
      if (!userId) return invalidSettingsRequest(reply, "userId must be a UUID");
      const parsed = setSettingsUserPermissionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidSettingsRequest(
          reply,
          parsed.error.issues[0]?.message ?? "Invalid access level",
        );
      }
      try {
        const auth = settingsAuthOf(request);
        if (!auth) return reply.code(401).send({ error: "Authentication required" });
        const change = await app.db.withActor(request, (tx) =>
          setUserPermission(tx, {
            actingUserId: auth.userId,
            userId,
            resource: parsed.data.resource,
            level: parsed.data.level,
          }),
        );
        return reply.send({
          user_id: change.userId,
          resource: change.resource,
          previous_level: change.previousLevel,
          level: change.level,
          changed: change.changed,
        });
      } catch (error) {
        return sendSettingsError(reply, error);
      }
    },
  );

  app.patch(
    `${SETTINGS_USERS_PATH}/:userId/admin`,
    { preHandler: requireAdmin },
    async (request, reply) => {
      const userId = userParams(request);
      if (!userId) return invalidSettingsRequest(reply, "userId must be a UUID");
      const parsed = setSettingsUserAdminRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return invalidSettingsRequest(
          reply,
          parsed.error.issues[0]?.message ?? "Invalid admin state",
        );
      }
      try {
        const auth = settingsAuthOf(request);
        if (!auth) return reply.code(401).send({ error: "Authentication required" });
        const change = await app.db.withActor(request, (tx) =>
          setUserAdmin(tx, {
            actingUserId: auth.userId,
            userId,
            isAdmin: parsed.data.is_admin,
            keepLevels: parsed.data.keep_levels,
          }),
        );
        return reply.send({
          user: {
            id: change.userId,
            username: change.username,
            is_admin: change.isAdmin,
            levels: change.levels,
          },
          previous_is_admin: change.previousIsAdmin,
          changed: change.changed,
        });
      } catch (error) {
        return sendSettingsError(reply, error);
      }
    },
  );
}
