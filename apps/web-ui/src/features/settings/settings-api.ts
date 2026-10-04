import {
  listSettingsTokensResponseSchema,
  listSettingsUsersResponseSchema,
  SETTINGS_PROFILE_PATH,
  SETTINGS_TOKENS_PATH,
  SETTINGS_USERS_PATH,
  issuedSettingsTokenResponseSchema,
  settingsProfileSchema,
  settingsTokenMutationResponseSchema,
  type CreateSettingsTokenRequest,
  type IssuedSettingsTokenResponse,
  type ListSettingsTokensResponse,
  type ListSettingsUsersResponse,
  type SettingsProfileResponse,
  type SettingsToken,
  type SettingsUser,
} from "@ytw/shared/api/settings";
import { api } from "@/lib/api.ts";

export const settingsKeys = {
  profile: ["settings", "profile"] as const,
  tokens: ["settings", "tokens"] as const,
  users: ["settings", "users"] as const,
};

export function getSettingsProfile(signal?: AbortSignal): Promise<SettingsProfileResponse> {
  return api.get(SETTINGS_PROFILE_PATH, {
    parse: settingsProfileSchema,
    ...(signal ? { signal } : {}),
  });
}

export function getSettingsTokens(signal?: AbortSignal): Promise<ListSettingsTokensResponse> {
  return api.get(SETTINGS_TOKENS_PATH, {
    parse: listSettingsTokensResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function getSettingsUsers(signal?: AbortSignal): Promise<ListSettingsUsersResponse> {
  return api.get(SETTINGS_USERS_PATH, {
    parse: listSettingsUsersResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export function createSettingsToken(input: CreateSettingsTokenRequest) {
  return api.post<IssuedSettingsTokenResponse>(SETTINGS_TOKENS_PATH, input, {
    parse: issuedSettingsTokenResponseSchema,
  });
}

export function patchSettingsToken(tokenId: string, permissions: Partial<SettingsToken["levels"]>) {
  return api.patch<{ token: SettingsToken }>(
    `${SETTINGS_TOKENS_PATH}/${tokenId}`,
    { permissions },
    { parse: settingsTokenMutationResponseSchema },
  );
}

export function rotateSettingsToken(tokenId: string) {
  return api.post<IssuedSettingsTokenResponse>(
    `${SETTINGS_TOKENS_PATH}/${tokenId}/rotate`,
    {},
    {
      parse: issuedSettingsTokenResponseSchema,
    },
  );
}

export function revokeSettingsToken(tokenId: string) {
  return api.delete<{ token: SettingsToken }>(`${SETTINGS_TOKENS_PATH}/${tokenId}`, {
    parse: settingsTokenMutationResponseSchema,
  });
}

export function setUserPermission(
  userId: string,
  resource: keyof SettingsUser["levels"],
  level: SettingsUser["levels"][keyof SettingsUser["levels"]],
) {
  return api.patch(`${SETTINGS_USERS_PATH}/${userId}/permissions`, { resource, level });
}

export function setUserAdmin(userId: string, isAdmin: boolean, keepLevels = false) {
  return api.patch(`${SETTINGS_USERS_PATH}/${userId}/admin`, {
    is_admin: isAdmin,
    keep_levels: keepLevels,
  });
}
