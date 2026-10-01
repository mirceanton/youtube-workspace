import { createContext, useContext } from "react";
import {
  GRANTABLE_LEVELS,
  LEVELS,
  RESOURCES,
  type Level,
  type Resource,
  type ResourceLevels,
} from "@ytw/shared/constants";
// Types only: importing values from "@ytw/shared/api/session" would pull zod into the shell.
import type { MeResponse, SessionUser } from "@ytw/shared/api/session";
import { api } from "./api.ts";
import { CSRF_HEADER, ME_PATH } from "./contract.ts";
import { setCsrfToken } from "./csrf.ts";

export type { MeResponse, SessionUser };

/** Query key of the signed-in user. Invalidate it after changing a user's levels. */
export const ME_QUERY_KEY = ["session"] as const;

/** A level a feature can require: `none` would mean "anyone". */
export type RequiredLevel = Exclude<Level, "none">;

export interface AccessRequirement {
  resource: Resource;
  level: RequiredLevel;
}

/**
 * What a feature needs before it is shown: one requirement, a list (any one of them is enough),
 * or `"any"` for screens every user with some access may open (the settings page, for example).
 */
export type FeatureAccess = AccessRequirement | readonly AccessRequirement[] | "any";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates `GET /api/me` without zod (the shell must stay zod-free). Mirrors `meResponseSchema`
 * in packages/shared/src/api/session.ts; test/contract.test.ts keeps the two in agreement.
 */
export function parseMe(json: unknown): MeResponse {
  if (!isObject(json)) throw new Error("/api/me did not return an object");
  const { user, levels } = json;
  if (!isObject(user)) throw new Error("/api/me is missing `user`");
  if (typeof user.id !== "string" || user.id === "") throw new Error("/api/me user.id is invalid");
  if (typeof user.username !== "string" || user.username === "") {
    throw new Error("/api/me user.username is invalid");
  }
  if (typeof user.displayName !== "string") throw new Error("/api/me user.displayName is invalid");
  if (typeof user.email !== "string") throw new Error("/api/me user.email is invalid");
  if (typeof user.isAdmin !== "boolean") throw new Error("/api/me user.isAdmin is invalid");
  if (!isObject(levels)) throw new Error("/api/me is missing `levels`");

  // A resource this build does not know (the server shipped a new object type) fails closed, exactly
  // like the zod schema, instead of hiding that the SPA is out of date.
  for (const key of Object.keys(levels)) {
    if (!(RESOURCES as readonly string[]).includes(key)) {
      throw new Error(`/api/me levels.${key} is not a resource this version knows`);
    }
  }

  const parsedLevels = {} as Record<Resource, Level>;
  for (const resource of RESOURCES) {
    const level = levels[resource];
    if (typeof level !== "string" || !GRANTABLE_LEVELS[resource].includes(level as Level)) {
      throw new Error(`/api/me levels.${resource} is invalid`);
    }
    parsedLevels[resource] = level as Level;
  }
  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      isAdmin: user.isAdmin,
    },
    levels: parsedLevels,
  };
}

/** `GET /api/me`; also remembers the CSRF token the server sends in the response header. */
export function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  return api.get<MeResponse>(ME_PATH, {
    parse: { parse: parseMe },
    ...(signal ? { signal } : {}),
    onResponse: (response) => {
      if (response.ok) setCsrfToken(response.headers.get(CSRF_HEADER));
    },
  });
}

/** True when `actual` is at least `needed` (Write includes Read, Read includes None). */
export function levelAtLeast(actual: Level, needed: Level): boolean {
  return LEVELS.indexOf(actual) >= LEVELS.indexOf(needed);
}

/** True when the user has some access to at least one object; otherwise the app shows "access not granted". */
export function hasAnyAccess(levels: ResourceLevels): boolean {
  return RESOURCES.some((resource) => levels[resource] !== "none");
}

/** Cosmetic check (the server decides): do `levels` satisfy a feature's requirement? */
export function meetsRequirement(levels: ResourceLevels, requires: FeatureAccess): boolean {
  if (requires === "any") return hasAnyAccess(levels);
  const list: readonly AccessRequirement[] = Array.isArray(requires)
    ? requires
    : [requires as AccessRequirement];
  return list.some(({ resource, level }) => levelAtLeast(levels[resource], level));
}

export const SessionContext = createContext<MeResponse | null>(null);

/** The signed-in user and their levels. Only available below `SessionGate`, which is every page. */
export function useSession(): MeResponse {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <SessionGate>");
  return session;
}

/** The user's stored level for one object. */
export function useLevel(resource: Resource): Level {
  return useSession().levels[resource];
}

/** Whether the user's stored level for `resource` is at least `level`. Hiding UI with this is cosmetic. */
export function useCan(resource: Resource, level: RequiredLevel): boolean {
  return levelAtLeast(useLevel(resource), level);
}
