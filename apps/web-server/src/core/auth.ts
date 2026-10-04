import {
  createWebSession,
  deleteWebSession,
  getUserAccess,
  getWebSession,
  markUserOutsideAccessGroup,
  touchWebSession,
  updateWebSessionTokens,
  upsertUserOnLogin,
  withActor,
  type ActorTx,
  type UserAccess,
} from "@ytw/db";
import { authorize, DENIAL_HTTP_STATUS, type AccessRule } from "@ytw/policy";
import type { Resource } from "@ytw/shared/constants";
import * as oidc from "openid-client";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Pool } from "pg";
import type { Env } from "../env.js";
import { OidcClient } from "./oidc.js";
import {
  decryptLoginTransaction,
  decryptSessionData,
  encryptLoginTransaction,
  encryptSessionData,
  type LoginTransaction,
  type SessionSecretData,
} from "./session-crypto.js";
import type { SecurityRouteRecord, WebAuth } from "./types.js";

export const SESSION_COOKIE = "ytw_session";
export const LOGIN_COOKIE = "ytw_oidc";
export const CSRF_HEADER = "x-csrf-token";

const LOGIN_TRANSACTION_TTL_SECONDS = 600;
const REFRESH_EARLY_SECONDS = 30;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUARDED = Symbol("ytw.route-guard");
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const sessionRefreshQueues = new Map<string, Promise<void>>();
const PUBLIC_ROUTES = new Set([
  "GET /healthz",
  "HEAD /healthz",
  "GET /readyz",
  "HEAD /readyz",
  "GET /metrics",
  "HEAD /metrics",
  "GET /auth/login",
  "HEAD /auth/login",
  "GET /auth/callback",
  "HEAD /auth/callback",
  "GET /auth/access-denied",
  "HEAD /auth/access-denied",
]);

interface Dependencies {
  env: Env;
  oidc: OidcClient;
}

type CookieOptions = {
  maxAge?: number;
  secure: boolean;
};

function addCookie(reply: FastifyReply, name: string, value: string, options: CookieOptions): void {
  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.secure) attributes.push("Secure");
  if (options.maxAge !== undefined) attributes.push(`Max-Age=${options.maxAge}`);
  const existing = reply.getHeader("set-cookie");
  const cookies = Array.isArray(existing)
    ? existing.map(String)
    : typeof existing === "string"
      ? [existing]
      : [];
  cookies.push(`${name}=${value}; ${attributes.join("; ")}`);
  reply.header("Set-Cookie", cookies);
}

function clearCookie(reply: FastifyReply, name: string, secure: boolean): void {
  const attributes = [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (secure) attributes.push("Secure");
  addRawCookie(reply, `${name}=; ${attributes.join("; ")}`);
}

function addRawCookie(reply: FastifyReply, cookie: string): void {
  const existing = reply.getHeader("set-cookie");
  const cookies = Array.isArray(existing)
    ? existing.map(String)
    : typeof existing === "string"
      ? [existing]
      : [];
  cookies.push(cookie);
  reply.header("Set-Cookie", cookies);
}

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function hasCookie(request: FastifyRequest, name: string): boolean {
  return (
    typeof request.headers.cookie === "string" &&
    request.headers.cookie.split(";").some((part) => part.trim().startsWith(`${name}=`))
  );
}

function secureCookie(env: Env): boolean {
  return new URL(env.OIDC_REDIRECT_URI).protocol === "https:";
}

function currentOrigin(env: Env): string {
  return new URL(env.OIDC_REDIRECT_URI).origin;
}

function csrfToken(secret: string, sessionId: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionId}`).digest("base64url");
}

function sameToken(expected: string, supplied: string | undefined): boolean {
  if (supplied === undefined) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function claimsAtPath(value: unknown, path: string): unknown {
  const parts = path.startsWith("/")
    ? path
        .split("/")
        .filter(Boolean)
        .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    : path.split(".").filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function normalizeGroup(value: string): string {
  return value.replace(/^\/+/, "");
}

function hasRequiredGroup(claims: unknown, env: Env): boolean {
  const groups = claimsAtPath(claims, env.OIDC_GROUPS_CLAIM_PATH);
  if (!Array.isArray(groups)) return false;
  const required = normalizeGroup(env.OIDC_REQUIRED_GROUP);
  return groups.some((group) => typeof group === "string" && normalizeGroup(group) === required);
}

function safeReturnTo(value: string | undefined, env: Env): string {
  if (
    value === undefined ||
    value === "" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/";
  }
  try {
    const candidate = new URL(value, currentOrigin(env));
    return candidate.origin === currentOrigin(env)
      ? `${candidate.pathname}${candidate.search}${candidate.hash}`
      : "/";
  } catch {
    return "/";
  }
}

function tokenExpiry(
  response: { expires_in?: unknown },
  claims: { exp?: unknown } | undefined,
): number {
  if (typeof response.expires_in === "number" && Number.isFinite(response.expires_in)) {
    return Date.now() + Math.max(0, response.expires_in) * 1000;
  }
  if (typeof claims?.exp === "number" && Number.isFinite(claims.exp)) return claims.exp * 1000;
  return Date.now();
}

function requiredString(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function includesAudience(value: unknown, clientId: string): boolean {
  return value === clientId || (Array.isArray(value) && value.includes(clientId));
}

function setAuth(request: FastifyRequest, user: UserAccess | null): void {
  if (user === null || user.accessRevokedAt !== null) {
    request.auth = undefined;
    return;
  }
  request.auth = {
    userId: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    levels: user.levels,
    displayName: user.displayName,
    email: user.email,
  };
}

function isGuarded(handler: unknown): boolean {
  return typeof handler === "function" && GUARDED in handler;
}

function hasGuard(preHandler: unknown): boolean {
  const handlers = Array.isArray(preHandler) ? preHandler : [preHandler];
  return handlers.some(isGuarded);
}

async function endSessionForGroupRevocation(
  app: FastifyInstance,
  sessionId: string,
  data: SessionSecretData,
): Promise<void> {
  await withActor(app.db.pool, { name: data.username, type: "human" }, (tx) =>
    markUserOutsideAccessGroup(tx, { issuer: data.issuer, sub: data.subject }).then(
      () => undefined,
    ),
  );
  await deleteWebSession(app.db.pool, sessionId);
}

async function withSessionRefreshLock<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = sessionRefreshQueues.get(sessionId);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionRefreshQueues.set(sessionId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sessionRefreshQueues.get(sessionId) === current) sessionRefreshQueues.delete(sessionId);
  }
}

async function refreshSession(
  app: FastifyInstance,
  dependencies: Dependencies,
  sessionId: string,
): Promise<{ data: SessionSecretData; idTokenHint: string | null } | null> {
  return withSessionRefreshLock(sessionId, async () => {
    // A queued request must use the latest encrypted refresh token. Another request may already
    // have rotated it while this one waited for the per-session lock.
    const session = await getWebSession(app.db.pool, sessionId);
    if (session === null || session.status !== "active") return null;

    let current: SessionSecretData;
    try {
      if (session.refreshTokenEncrypted === null) return null;
      current = decryptSessionData(dependencies.env.SESSION_SECRET, session.refreshTokenEncrypted);
    } catch {
      return null;
    }
    if (current.accessTokenExpiresAt > Date.now() + REFRESH_EARLY_SECONDS * 1000) {
      return { data: current, idTokenHint: session.idTokenHint };
    }
    if (current.refreshToken === null) return null;

    const response = await dependencies.oidc.refreshTokenGrant(current.refreshToken);
    if (typeof response.access_token !== "string" || response.access_token.length === 0)
      return null;
    const accessTokenExpiry = await dependencies.oidc.validateAccessToken(
      response.access_token,
      current.subject,
    );
    const refreshedClaims = response.claims();
    const idToken = typeof response.id_token === "string" ? response.id_token : null;
    if (idToken !== null && refreshedClaims === undefined) {
      throw new Error("OIDC refresh ID token could not be verified");
    }
    if (
      refreshedClaims !== undefined &&
      (requiredString(refreshedClaims, "iss") !== current.issuer ||
        requiredString(refreshedClaims, "sub") !== current.subject ||
        !includesAudience(refreshedClaims.aud, dependencies.env.OIDC_CLIENT_ID) ||
        typeof refreshedClaims.exp !== "number" ||
        refreshedClaims.exp * 1000 <= Date.now())
    ) {
      throw new Error("OIDC refresh changed the authenticated identity");
    }

    const profile = await dependencies.oidc.fetchUserInfo(response.access_token, current.subject);
    if (!hasRequiredGroup(profile, dependencies.env)) {
      await endSessionForGroupRevocation(app, sessionId, current);
      return null;
    }

    const next: SessionSecretData = {
      ...current,
      refreshToken:
        typeof response.refresh_token === "string" ? response.refresh_token : current.refreshToken,
      accessTokenExpiresAt: Math.min(accessTokenExpiry, tokenExpiry(response, refreshedClaims)),
    };
    const updated = await updateWebSessionTokens(app.db.pool, sessionId, {
      refreshTokenEncrypted: encryptSessionData(dependencies.env.SESSION_SECRET, next),
      ...(idToken === null ? {} : { idTokenHint: idToken }),
    });
    if (!updated) return null;
    const latest = await getWebSession(app.db.pool, sessionId);
    if (latest === null || latest.status !== "active" || latest.userId !== session.userId)
      return null;
    return { data: next, idTokenHint: latest.idTokenHint };
  });
}

async function loadSession(
  app: FastifyInstance,
  dependencies: Dependencies,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  request.auth = undefined;
  request.sessionId = undefined;
  const sessionId = cookieValue(request, SESSION_COOKIE);
  const secure = secureCookie(dependencies.env);
  if (sessionId === undefined) {
    if (hasCookie(request, SESSION_COOKIE)) clearCookie(reply, SESSION_COOKIE, secure);
    return;
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    clearCookie(reply, SESSION_COOKIE, secure);
    return;
  }

  const discard = async (): Promise<void> => {
    await deleteWebSession(app.db.pool, sessionId).catch(() => false);
    clearCookie(reply, SESSION_COOKIE, secure);
    request.auth = undefined;
    request.sessionId = undefined;
  };

  let session = await getWebSession(app.db.pool, sessionId);
  if (session === null || session.status !== "active") {
    await discard();
    return;
  }

  let data: SessionSecretData;
  try {
    if (session.refreshTokenEncrypted === null)
      throw new Error("session has no encrypted identity");
    data = decryptSessionData(dependencies.env.SESSION_SECRET, session.refreshTokenEncrypted);
  } catch {
    await discard();
    return;
  }

  if (data.accessTokenExpiresAt <= Date.now() + REFRESH_EARLY_SECONDS * 1000) {
    try {
      const refreshed = await refreshSession(app, dependencies, sessionId);
      if (refreshed === null) {
        await discard();
        return;
      }
      data = refreshed.data;
      session = { ...session, idTokenHint: refreshed.idTokenHint };
    } catch (error) {
      request.log.warn(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "OIDC refresh failed",
      );
      await discard();
      return;
    }
  }

  const access = await getUserAccess(app.db.pool, session.userId);
  if (access === null || access.accessRevokedAt !== null) {
    await discard();
    return;
  }
  setAuth(request, access);
  if (request.auth === undefined) {
    await discard();
    return;
  }
  request.sessionId = sessionId;

  const touched = await touchWebSession(
    app.db.pool,
    sessionId,
    dependencies.env.SESSION_IDLE_TIMEOUT,
  );
  if (touched === null) await discard();
}

function csp(nonce?: string): string {
  return [
    "default-src 'self'",
    `script-src 'self'${nonce === undefined ? "" : ` 'nonce-${nonce}'`}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function addSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (
      path === "/api" ||
      path.startsWith("/api/") ||
      path === "/auth" ||
      path.startsWith("/auth/")
    ) {
      reply.header("Cache-Control", "no-store");
    }
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (reply.getHeader("content-security-policy") === undefined)
      reply.header("Content-Security-Policy", csp());
    const host = request.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host !== "localhost" && host !== "::1" && !/^127(?:\.\d{1,3}){3}$/.test(host)) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });
}

function denied(reply: FastifyReply, rule: AccessRule, principal: WebAuth | undefined): unknown {
  const decision = authorize(
    principal === undefined
      ? undefined
      : {
          kind: "user",
          userId: principal.userId,
          username: principal.username,
          isAdmin: principal.isAdmin,
          levels: principal.levels,
        },
    rule,
  );
  if (decision.allowed) return undefined;
  return reply.code(DENIAL_HTTP_STATUS[decision.reason]).send({ error: decision.message });
}

const requireAuthenticated: preHandlerHookHandler = async (request, reply) => {
  const result = denied(reply, "authenticated", request.auth);
  if (result !== undefined) return result;
};
Object.defineProperty(requireAuthenticated, GUARDED, { value: true });

function validateCsrfAndOrigin(request: FastifyRequest, reply: FastifyReply, env: Env): unknown {
  const path = request.url.split("?", 1)[0] ?? request.url;
  const target =
    path === "/api" || path.startsWith("/api/") || path === "/auth" || path.startsWith("/auth/");
  if (!target) return undefined;

  const origin = request.headers.origin;
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) return undefined;
  if (request.auth === undefined || request.sessionId === undefined) {
    return reply.code(401).send({ error: "Authentication required." });
  }
  const suppliedHeader = request.headers[CSRF_HEADER];
  const supplied = Array.isArray(suppliedHeader) ? undefined : suppliedHeader;
  if (
    origin !== currentOrigin(env) ||
    !sameToken(csrfToken(env.SESSION_SECRET, request.sessionId), supplied)
  ) {
    return reply.code(403).send({ error: "CSRF validation failed." });
  }
  return undefined;
}

/** Reject hostile origins before session loading can refresh tokens or extend idle expiry. */
function validateOrigin(request: FastifyRequest, reply: FastifyReply, env: Env): unknown {
  const path = request.url.split("?", 1)[0] ?? request.url;
  const target =
    path === "/api" || path.startsWith("/api/") || path === "/auth" || path.startsWith("/auth/");
  if (!target) return undefined;
  const origin = request.headers.origin;
  if (
    (origin !== undefined && origin !== currentOrigin(env)) ||
    request.method.toUpperCase() === "OPTIONS"
  ) {
    return reply.code(403).send({ error: "Cross-origin request denied." });
  }
  return undefined;
}

function routeMethods(method: string | readonly string[]): string[] {
  return (Array.isArray(method) ? method : [method]).map((item) => item.toUpperCase());
}

export function registerAuthCore(
  app: FastifyInstance,
  env: Env,
  oidcClient: OidcClient,
  pool: Pool,
): void {
  const dependencies = { env, oidc: oidcClient };
  const routeRecords: SecurityRouteRecord[] = [];
  app.decorate("securityRoutes", () => routeRecords.map((route) => ({ ...route })));
  app.decorateRequest("auth", null as unknown as WebAuth | undefined);
  app.decorateRequest("sessionId", null as unknown as string | undefined);

  app.addHook("onRoute", (route) => {
    const methods = routeMethods(route.method);
    for (const method of methods) {
      routeRecords.push({
        method,
        url: route.url,
        guarded: hasGuard(route.preHandler) || PUBLIC_ROUTES.has(`${method} ${route.url}`),
      });
    }
  });

  app.decorate("requireLevel", (resource: Resource, level: "read" | "write") => {
    const rule: AccessRule = { resource, level };
    const guard: preHandlerHookHandler = async (request, reply) => {
      const result = denied(reply, rule, request.auth);
      if (result !== undefined) return result;
    };
    Object.defineProperty(guard, GUARDED, { value: true });
    return guard;
  });

  app.decorate("db", {
    pool,
    withActor<T>(request: FastifyRequest, fn: (client: ActorTx) => Promise<T>) {
      if (request.auth === undefined) throw new Error("withActor requires an authenticated user");
      return withActor(pool, { name: request.auth.username, type: "human" }, fn);
    },
  });

  addSecurityHeaders(app);
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (path === "/healthz" || path === "/readyz" || path === "/metrics") {
      request.auth = undefined;
      request.sessionId = undefined;
      return;
    }
    const originValidation = validateOrigin(request, reply, env);
    if (originValidation !== undefined) return originValidation;
    await loadSession(app, dependencies, request, reply);
    const validation = validateCsrfAndOrigin(request, reply, env);
    if (validation !== undefined) return validation;
  });

  app.get("/api/me", { preHandler: requireAuthenticated }, async (request, reply) => {
    if (request.auth === undefined || request.sessionId === undefined) {
      return reply.code(401).send({ error: "Authentication required." });
    }
    reply.header("X-CSRF-Token", csrfToken(env.SESSION_SECRET, request.sessionId));
    return {
      user: {
        id: request.auth.userId,
        username: request.auth.username,
        displayName: request.auth.displayName ?? "",
        email: request.auth.email ?? "",
        isAdmin: request.auth.isAdmin,
      },
      levels: request.auth.levels,
    };
  });

  app.get("/auth/login", async (request, reply) => {
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite === "cross-site") return reply.code(403).send("Login request denied.");
    try {
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const returnTo = safeReturnTo(
        typeof request.query === "object" && request.query !== null
          ? String((request.query as Record<string, unknown>).return_to ?? "")
          : undefined,
        env,
      );
      const transaction: LoginTransaction = {
        version: 1,
        state,
        nonce,
        codeVerifier,
        expiresAt: Date.now() + LOGIN_TRANSACTION_TTL_SECONDS * 1000,
        returnTo,
      };
      const url = await oidcClient.authorizationUrl({
        client_id: env.OIDC_CLIENT_ID,
        redirect_uri: env.OIDC_REDIRECT_URI,
        response_type: "code",
        scope: "openid profile email",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      addCookie(reply, LOGIN_COOKIE, encryptLoginTransaction(env.SESSION_SECRET, transaction), {
        maxAge: LOGIN_TRANSACTION_TTL_SECONDS,
        secure: secureCookie(env),
      });
      return reply.redirect(url.href, 302);
    } catch (error) {
      request.log.warn(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "OIDC discovery or authorization failed",
      );
      return reply.code(503).send("Sign-in is temporarily unavailable.");
    }
  });

  app.get("/auth/callback", async (request, reply) => {
    const secure = secureCookie(env);
    const loginCookie = cookieValue(request, LOGIN_COOKIE);
    clearCookie(reply, LOGIN_COOKIE, secure);
    if (loginCookie === undefined)
      return reply.code(400).send("The sign-in request expired. Please try again.");

    let transaction: LoginTransaction;
    try {
      transaction = decryptLoginTransaction(env.SESSION_SECRET, loginCookie);
    } catch {
      return reply.code(400).send("The sign-in request expired. Please try again.");
    }

    try {
      const callback = new URL(request.url, env.OIDC_REDIRECT_URI);
      const tokens = await oidcClient.authorizationCodeGrant(callback, {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (claims === undefined) return reply.code(401).send("Sign-in could not be verified.");
      const issuer = requiredString(claims, "iss");
      const subject = requiredString(claims, "sub");
      const username = requiredString(claims, "preferred_username");
      if (
        issuer !== env.OIDC_ISSUER_URL ||
        subject === undefined ||
        username === undefined ||
        !includesAudience(claims.aud, env.OIDC_CLIENT_ID) ||
        typeof claims.exp !== "number" ||
        claims.exp * 1000 <= Date.now()
      ) {
        return reply.code(401).send("Sign-in could not be verified.");
      }
      if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
        return reply.code(401).send("Sign-in could not be verified.");
      }
      const accessTokenExpiry = await oidcClient.validateAccessToken(tokens.access_token, subject);
      if (!hasRequiredGroup(claims, env)) {
        await withActor(app.db.pool, { name: username, type: "human" }, (tx) =>
          markUserOutsideAccessGroup(tx, { issuer, sub: subject }).then(() => undefined),
        );
        return reply.redirect("/auth/access-denied", 303);
      }
      if (typeof tokens.refresh_token !== "string" || tokens.refresh_token.length === 0) {
        return reply.code(503).send("The identity provider did not issue a refresh token.");
      }

      const identity: SessionSecretData = {
        version: 1,
        issuer,
        subject,
        username,
        refreshToken: tokens.refresh_token,
        accessTokenExpiresAt: Math.min(accessTokenExpiry, tokenExpiry(tokens, claims)),
        returnTo: transaction.returnTo,
      };
      const login = await withActor(app.db.pool, { name: username, type: "human" }, (tx) =>
        upsertUserOnLogin(tx, {
          issuer,
          sub: subject,
          username,
          email: requiredString(claims, "email") ?? null,
          displayName: requiredString(claims, "name") ?? null,
        }),
      );
      const session = await createWebSession(app.db.pool, {
        userId: login.id,
        refreshTokenEncrypted: encryptSessionData(env.SESSION_SECRET, identity),
        idTokenHint: tokens.id_token ?? null,
        idleTimeoutSeconds: env.SESSION_IDLE_TIMEOUT,
        absoluteTimeoutSeconds: env.SESSION_ABSOLUTE_TIMEOUT,
      });
      addCookie(reply, SESSION_COOKIE, session.id, {
        maxAge: env.SESSION_ABSOLUTE_TIMEOUT,
        secure,
      });
      return reply.redirect(identity.returnTo, 303);
    } catch (error) {
      request.log.warn(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "OIDC callback failed",
      );
      return reply.code(401).send("Sign-in could not be completed. Please try again.");
    }
  });

  app.get("/auth/access-denied", async (_request, reply) => {
    return reply
      .code(403)
      .type("text/html; charset=utf-8")
      .send(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Access denied</title><h1>Access denied</h1><p>Your identity is not in the required workspace group.</p></html>',
      );
  });

  app.get("/auth/logout", { preHandler: requireAuthenticated }, async (request, reply) => {
    if (request.sessionId === undefined)
      return reply.code(401).send({ error: "Authentication required." });
    const nonce = randomBytes(18).toString("base64url");
    reply.header("Content-Security-Policy", csp(nonce));
    reply.type("text/html; charset=utf-8");
    const token = csrfToken(env.SESSION_SECRET, request.sessionId);
    return reply.send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign out</title><h1>Sign out</h1><button id="sign-out" type="button">Sign out</button><script nonce="${nonce}">document.getElementById("sign-out").addEventListener("click",async()=>{const response=await fetch("/auth/logout",{method:"POST",headers:{"X-CSRF-Token":"${token}",Accept:"application/json"}});if(response.ok){const result=await response.json();location.assign(result.redirectTo)}else{location.reload()}})</script></html>`,
    );
  });

  app.post("/auth/logout", { preHandler: requireAuthenticated }, async (request, reply) => {
    if (request.sessionId === undefined)
      return reply.code(401).send({ error: "Authentication required." });
    const session = await getWebSession(app.db.pool, request.sessionId);
    const redirectUrl = await oidcClient.endSessionUrl(session?.idTokenHint ?? null);
    await deleteWebSession(app.db.pool, request.sessionId);
    clearCookie(reply, SESSION_COOKIE, secureCookie(env));
    clearCookie(reply, LOGIN_COOKIE, secureCookie(env));
    reply.header("Clear-Site-Data", '"cache", "storage"');
    if (request.headers.accept?.includes("application/json")) {
      return reply.send({
        redirectTo: redirectUrl?.href ?? new URL("/", env.OIDC_REDIRECT_URI).href,
      });
    }
    return reply.redirect(redirectUrl?.href ?? new URL("/", env.OIDC_REDIRECT_URI).href, 303);
  });
}

export function checkGuardCoverage(routes: readonly SecurityRouteRecord[]): string[] {
  return routes.filter((route) => !route.guarded).map((route) => `${route.method} ${route.url}`);
}
