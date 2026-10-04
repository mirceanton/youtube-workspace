import { z } from "zod";
import { GRANTABLE_LEVELS, LEVELS, RESOURCES } from "../resources.js";

export const SETTINGS_PROFILE_PATH = "/api/settings/profile";
export const SETTINGS_TOKENS_PATH = "/api/settings/tokens";
export const SETTINGS_USERS_PATH = "/api/settings/users";

const levelSchema = z.enum(LEVELS);
const resourceSchema = z.enum(RESOURCES);
const permissionsSchema = z.record(resourceSchema, levelSchema).superRefine((permissions, ctx) => {
  for (const resource of RESOURCES) {
    if (!GRANTABLE_LEVELS[resource].includes(permissions[resource])) {
      ctx.addIssue({
        code: "custom",
        path: [resource],
        message: `A permission level is not allowed for ${resource}`,
      });
    }
  }
});
const partialPermissionsSchema = z
  .partialRecord(resourceSchema, levelSchema)
  .superRefine((permissions, ctx) => {
    for (const resource of RESOURCES) {
      const level = permissions[resource];
      if (level !== undefined && !GRANTABLE_LEVELS[resource].includes(level)) {
        ctx.addIssue({
          code: "custom",
          path: [resource],
          message: `A permission level is not allowed for ${resource}`,
        });
      }
    }
  });
const timestampSchema = z.iso.datetime({ offset: true });

export const settingsProfileSchema = z.object({
  profile: z.object({
    id: z.uuid(),
    username: z.string().min(1),
    display_name: z.string().nullable(),
    email: z.string().nullable(),
    issuer: z.string().min(1),
    subject: z.string().min(1),
    is_admin: z.boolean(),
    access_revoked_at: timestampSchema.nullable(),
  }),
  levels: permissionsSchema,
});
export type SettingsProfileResponse = z.infer<typeof settingsProfileSchema>;

export const settingsTokenSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  prefix: z.string().min(1),
  status: z.enum(["active", "revoked", "expired", "owner_revoked"]),
  created_at: timestampSchema,
  expires_at: timestampSchema.nullable(),
  last_used_at: timestampSchema.nullable(),
  revoked_at: timestampSchema.nullable(),
  levels: permissionsSchema,
  effective_levels: permissionsSchema,
});
export type SettingsToken = z.infer<typeof settingsTokenSchema>;

export const settingsTokenMutationResponseSchema = z.object({
  token: settingsTokenSchema,
});

export const listSettingsTokensResponseSchema = z.object({
  tokens: z.array(settingsTokenSchema),
});
export type ListSettingsTokensResponse = z.infer<typeof listSettingsTokensResponseSchema>;

export const createSettingsTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Omitted means 90 days from now; null means never expires. */
  expires_at: timestampSchema.nullable().optional(),
  permissions: partialPermissionsSchema,
});
export type CreateSettingsTokenRequest = z.infer<typeof createSettingsTokenRequestSchema>;

export const updateSettingsTokenRequestSchema = z.object({
  permissions: partialPermissionsSchema,
});
export type UpdateSettingsTokenRequest = z.infer<typeof updateSettingsTokenRequestSchema>;

export const rotateSettingsTokenRequestSchema = z.object({
  /** Omitted keeps its current expiry; null means never expires. */
  expires_at: timestampSchema.nullable().optional(),
});
export type RotateSettingsTokenRequest = z.infer<typeof rotateSettingsTokenRequestSchema>;

export const issuedSettingsTokenResponseSchema = z.object({
  token: settingsTokenSchema,
  /** The only response that contains the secret. It must be displayed once and then discarded. */
  secret: z.string().min(1),
});
export type IssuedSettingsTokenResponse = z.infer<typeof issuedSettingsTokenResponseSchema>;

export const settingsUserSchema = z.object({
  id: z.uuid(),
  username: z.string().min(1),
  display_name: z.string().nullable(),
  email: z.string().nullable(),
  is_admin: z.boolean(),
  created_at: timestampSchema,
  last_login_at: timestampSchema.nullable(),
  access_revoked_at: timestampSchema.nullable(),
  levels: permissionsSchema,
});
export type SettingsUser = z.infer<typeof settingsUserSchema>;

export const listSettingsUsersResponseSchema = z.object({
  users: z.array(settingsUserSchema),
});
export type ListSettingsUsersResponse = z.infer<typeof listSettingsUsersResponseSchema>;

export const setSettingsUserPermissionRequestSchema = z.object({
  resource: resourceSchema,
  level: levelSchema,
});
export type SetSettingsUserPermissionRequest = z.infer<
  typeof setSettingsUserPermissionRequestSchema
>;

export const setSettingsUserAdminRequestSchema = z.object({
  is_admin: z.boolean(),
  /** Demotion keeps existing levels only when explicitly requested. */
  keep_levels: z.boolean().optional(),
});
export type SetSettingsUserAdminRequest = z.infer<typeof setSettingsUserAdminRequestSchema>;
