import { z } from "zod";
import { resourceLevelsSchema } from "../schemas.js";

// The "web contract" between the server's web routes and the SPA. The server validates what it
// sends against these schemas; the SPA shell keeps a zod-free copy of the checks.

/** `GET` returns the signed-in user and their stored access levels. */
export const ME_PATH = "/api/me";

/** Browser navigation (not fetch) that starts the OIDC login; `return_to` is a same-origin path. */
export const LOGIN_PATH = "/auth/login";

/** Browser navigation that ends the session, including the identity provider's. */
export const LOGOUT_PATH = "/auth/logout";

/** Query parameter of `LOGIN_PATH` that carries the same-origin path to return to after login. */
export const RETURN_TO_PARAM = "return_to";

/**
 * Response header of `GET /api/me` carrying the CSRF token. Every mutating request (anything but
 * GET/HEAD/OPTIONS) must send the latest value back in a request header of the same name.
 */
export const CSRF_HEADER = "X-CSRF-Token";

export const sessionUserSchema = z.object({
  id: z.string().min(1),
  /** The OIDC `preferred_username`; also the actor name in the audit log. */
  username: z.string().min(1),
  displayName: z.string(),
  email: z.string(),
  isAdmin: z.boolean(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

/**
 * Body of `GET /api/me`. `levels` holds the user's CURRENT stored level for every resource (never
 * cached by the server); `activity` is `none` or `read`. The SPA uses it to show or hide things,
 * which is cosmetic: the server checks every route and mutation itself.
 */
export const meResponseSchema = z.object({
  user: sessionUserSchema,
  levels: resourceLevelsSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Body of every non-2xx JSON response: a message a person (or an LLM) can act on. */
export const apiErrorBodySchema = z.object({
  error: z.string().min(1),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/**
 * Body of a `409` caused by an optimistic-concurrency failure (stale `expected_version` or
 * `base_version`). `latest` is feature-specific: the current row, or at least its version, so the
 * client can offer "reload" or "merge" instead of overwriting.
 */
export const conflictBodySchema = apiErrorBodySchema.extend({
  latest: z.unknown(),
});
export type ConflictBody = z.infer<typeof conflictBodySchema>;
