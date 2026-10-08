import { createContext, useContext, useMemo } from "react";
import {
  authorize,
  can,
  hasAnyAccess as principalHasAnyAccess,
  userLevels,
  type AccessRule,
  type RequiredLevel,
  type UserPrincipal,
} from "@ytw/policy";
import { GRANTABLE_LEVELS, RESOURCES, type Level, type Resource } from "@ytw/shared/constants";
// Types only: importing values from "@ytw/shared/api/session" would pull zod into the shell.
import type { MeResponse, SessionUser } from "@ytw/shared/api/session";
import { api } from "./api.ts";
import { CSRF_HEADER, ME_PATH } from "./contract.ts";
import { setCsrfToken } from "./csrf.ts";

export type { MeResponse, SessionUser };

/** Query key of the signed-in user. Invalidate it after changing a user's levels. */
export const ME_QUERY_KEY = ["session"] as const;

export type { RequiredLevel };

/**
 * One rule a feature or a part of a screen can declare, in the policy layer's vocabulary
 * (`@ytw/policy`, docs/policy.md): a level on one object, `{ resource: "ideas", level: "read" }`;
 * `"authenticated"` for screens every signed-in user may open (the settings page); `"admin"` for
 * admin-only parts (the access matrix).
 */
export type FeatureRule = Exclude<AccessRule, "public">;

/** A rule, or a list of rules of which any one is enough. */
export type FeatureAccess = FeatureRule | readonly FeatureRule[];

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

/**
 * The signed-in user as the policy layer's principal, so the SPA decides what to show with the same
 * code the servers use to decide what to allow (admins have Write on everything, Write includes
 * Read, nothing can require Write on the activity log). The decision is still cosmetic: the server
 * checks every request against the levels it loads itself.
 */
export function principalOf(me: MeResponse): UserPrincipal {
  return {
    kind: "user",
    userId: me.user.id,
    username: me.user.username,
    isAdmin: me.user.isAdmin,
    levels: me.levels,
  };
}

/** True when the user has some access to at least one object; otherwise the app shows "access not granted". */
export function hasAnyAccess(me: MeResponse): boolean {
  return principalHasAnyAccess(principalOf(me));
}

/** Cosmetic check (the server decides): does this user satisfy a rule, or any rule of a list? */
export function meetsRequirement(me: MeResponse, requires: FeatureAccess): boolean {
  const principal = principalOf(me);
  const rules: readonly FeatureRule[] = Array.isArray(requires)
    ? requires
    : [requires as FeatureRule];
  return rules.some((rule) => authorize(principal, rule).allowed);
}

export const SessionContext = createContext<MeResponse | null>(null);

/** The signed-in user and their levels. Only available below `SessionGate`, which is every page. */
export function useSession(): MeResponse {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <SessionGate>");
  return session;
}

/** The signed-in user as a policy principal (`can`, `authorize`, `grantOptions`, `describeLevels` take it). */
export function usePrincipal(): UserPrincipal {
  const me = useSession();
  return useMemo(() => principalOf(me), [me]);
}

/** The user's effective level for one object (an admin has Write everywhere; Activity is Read at most). */
export function useLevel(resource: Resource): Level {
  return userLevels(usePrincipal())[resource];
}

/** Whether the user has at least `level` on `resource`. Hiding UI with this is cosmetic. */
export function useCan(resource: Resource, level: RequiredLevel): boolean {
  return can(usePrincipal(), resource, level);
}
