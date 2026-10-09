/**
 * Sign-in with an OpenID Connect provider. The browser holds a cookie with a random session id; the
 * database keeps only its hash and, sealed with `SESSION_SECRET`, what is needed to renew the
 * session (refresh token, identity). Every request re-reads the user's current levels, so a change
 * made in Settings applies at once, and a session whose provider session is gone (the refresh
 * fails, or the user left the access group) ends.
 */
import { randomBytes } from "node:crypto";
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
} from "@ytw/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as oidc from "openid-client";
import type { Pool } from "pg";
import type { OidcConfig } from "../env.js";
import { csrfToken } from "./csrf.js";
import { OidcClient, type OidcFetch } from "./oidc.js";
import {
  decryptIdTokenHint,
  decryptLoginTransaction,
  decryptSessionData,
  encryptIdTokenHint,
  encryptLoginTransaction,
  encryptSessionData,
  type LoginTransaction,
  type SessionSecretData,
} from "./session-crypto.js";
import { toWebAuth, type AuthMode } from "./types.js";

export const SESSION_COOKIE = "ytw_session";
export const LOGIN_COOKIE = "ytw_oidc";

const LOGIN_TRANSACTION_TTL_SECONDS = 600;
const REFRESH_EARLY_SECONDS = 30;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function addCookie(
  reply: FastifyReply,
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean },
): void {
  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${options.maxAge}`];
  if (options.secure) attributes.push("Secure");
  appendCookie(reply, `${name}=${value}; ${attributes.join("; ")}`);
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
  appendCookie(reply, `${name}=; ${attributes.join("; ")}`);
}

function appendCookie(reply: FastifyReply, cookie: string): void {
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

/**
 * What to log about a failed sign-in step. The class name alone is not enough (openid-client throws
 * `ClientError` for most failures), so the library's error code goes with it. Never the message:
 * some quote what the provider sent.
 */
function errorFields(error: unknown): { errorName: string; errorCode?: string } {
  if (!(error instanceof Error)) return { errorName: "unknown" };
  const code = (error as { code?: unknown }).code;
  return typeof code === "string"
    ? { errorName: error.name, errorCode: code }
    : { errorName: error.name };
}

function includesAudience(value: unknown, clientId: string): boolean {
  return value === clientId || (Array.isArray(value) && value.includes(clientId));
}

/** The content security policy; the sign-out page adds a nonce for its one inline script. */
export function contentSecurityPolicy(nonce?: string): string {
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

export function createOidcAuth(config: OidcConfig, pool: Pool, fetcher?: OidcFetch): AuthMode {
  const client = new OidcClient(config, fetcher);
  const origin = new URL(config.redirectUri).origin;
  const secure = new URL(config.redirectUri).protocol === "https:";
  const secret = config.sessionSecret;
  // Requests of one session wait for each other while the refresh token is renewed.
  const refreshQueues = new Map<string, Promise<void>>();

  function hasRequiredGroup(claims: unknown): boolean {
    if (config.requiredGroup === undefined) return true;
    const groups = claimsAtPath(claims, config.groupsClaimPath);
    if (!Array.isArray(groups)) return false;
    const required = normalizeGroup(config.requiredGroup);
    return groups.some((group) => typeof group === "string" && normalizeGroup(group) === required);
  }

  function safeReturnTo(value: string | undefined): string {
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
      const candidate = new URL(value, origin);
      return candidate.origin === origin
        ? `${candidate.pathname}${candidate.search}${candidate.hash}`
        : "/";
    } catch {
      return "/";
    }
  }

  async function withRefreshLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = refreshQueues.get(sessionId);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    refreshQueues.set(sessionId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (refreshQueues.get(sessionId) === current) refreshQueues.delete(sessionId);
    }
  }

  async function endSessionForGroupRevocation(
    sessionId: string,
    data: SessionSecretData,
  ): Promise<void> {
    await withActor(pool, { name: data.username, type: "human" }, (tx) =>
      markUserOutsideAccessGroup(tx, { issuer: data.issuer, sub: data.subject }).then(
        () => undefined,
      ),
    );
    await deleteWebSession(pool, sessionId);
  }

  /** Renews the access token with the stored refresh token; null when the session cannot go on. */
  async function refreshSession(sessionId: string): Promise<SessionSecretData | null> {
    return withRefreshLock(sessionId, async () => {
      // A queued request must use the latest encrypted refresh token. Another request may already
      // have rotated it while this one waited for the per-session lock.
      const session = await getWebSession(pool, sessionId);
      if (session === null || session.status !== "active") return null;

      let current: SessionSecretData;
      try {
        if (session.refreshTokenEncrypted === null) return null;
        current = decryptSessionData(secret, session.refreshTokenEncrypted);
      } catch {
        return null;
      }
      if (current.accessTokenExpiresAt > Date.now() + REFRESH_EARLY_SECONDS * 1000) {
        return current;
      }
      if (current.refreshToken === null) return null;

      const response = await client.refreshTokenGrant(current.refreshToken);
      if (typeof response.access_token !== "string" || response.access_token.length === 0) {
        return null;
      }
      const accessTokenExpiry = await client.validateAccessToken(
        response.access_token,
        current.subject,
      );
      const refreshedClaims = response.claims();
      const idToken = typeof response.id_token === "string" ? response.id_token : null;
      if (idToken !== null && refreshedClaims === undefined) {
        throw new Error("OIDC refresh ID token could not be verified");
      }
      // A provider that sends a nonce on refresh must send the one of the original login.
      if (
        refreshedClaims !== undefined &&
        (requiredString(refreshedClaims, "iss") !== current.issuer ||
          requiredString(refreshedClaims, "sub") !== current.subject ||
          !includesAudience(refreshedClaims.aud, config.clientId) ||
          typeof refreshedClaims.exp !== "number" ||
          refreshedClaims.exp * 1000 <= Date.now() ||
          (Object.hasOwn(refreshedClaims, "nonce") && refreshedClaims.nonce !== current.nonce))
      ) {
        throw new Error("OIDC refresh changed the authenticated identity or nonce");
      }

      const profile = await client.fetchUserInfo(response.access_token, current.subject);
      if (!hasRequiredGroup(profile)) {
        await endSessionForGroupRevocation(sessionId, current);
        return null;
      }

      const next: SessionSecretData = {
        ...current,
        refreshToken:
          typeof response.refresh_token === "string"
            ? response.refresh_token
            : current.refreshToken,
        accessTokenExpiresAt: Math.min(accessTokenExpiry, tokenExpiry(response, refreshedClaims)),
      };
      const hint = idToken === null ? null : encryptIdTokenHint(secret, idToken);
      const updated = await updateWebSessionTokens(pool, sessionId, {
        refreshTokenEncrypted: encryptSessionData(secret, next),
        ...(hint === null ? {} : { idTokenHint: hint }),
      });
      return updated ? next : null;
    });
  }

  async function loadSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    request.auth = undefined;
    request.sessionId = undefined;
    const sessionId = cookieValue(request, SESSION_COOKIE);
    if (sessionId === undefined) {
      // A cookie that cannot even be decoded is cleared rather than sent again and again.
      if (
        request.headers.cookie
          ?.split(";")
          .some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`))
      ) {
        clearCookie(reply, SESSION_COOKIE, secure);
      }
      return;
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      clearCookie(reply, SESSION_COOKIE, secure);
      return;
    }

    const discard = async (): Promise<void> => {
      await deleteWebSession(pool, sessionId).catch(() => false);
      clearCookie(reply, SESSION_COOKIE, secure);
      request.auth = undefined;
      request.sessionId = undefined;
    };

    const session = await getWebSession(pool, sessionId);
    if (session === null || session.status !== "active") {
      await discard();
      return;
    }

    let data: SessionSecretData;
    try {
      if (session.refreshTokenEncrypted === null) {
        throw new Error("session has no encrypted identity");
      }
      data = decryptSessionData(secret, session.refreshTokenEncrypted);
    } catch {
      await discard();
      return;
    }

    if (data.accessTokenExpiresAt <= Date.now() + REFRESH_EARLY_SECONDS * 1000) {
      try {
        if ((await refreshSession(sessionId)) === null) {
          await discard();
          return;
        }
      } catch (error) {
        request.log.warn(errorFields(error), "OIDC refresh failed");
        await discard();
        return;
      }
    }

    const auth = toWebAuth(await getUserAccess(pool, session.userId));
    if (auth === undefined) {
      await discard();
      return;
    }
    request.auth = auth;
    request.sessionId = sessionId;

    if ((await touchWebSession(pool, sessionId, config.idleTimeoutSeconds)) === null) {
      await discard();
    }
  }

  function registerRoutes(app: FastifyInstance): void {
    app.get("/auth/login", async (request, reply) => {
      if (request.headers["sec-fetch-site"] === "cross-site") {
        return reply.code(403).send("Login request denied.");
      }
      try {
        const state = oidc.randomState();
        const nonce = oidc.randomNonce();
        const codeVerifier = oidc.randomPKCECodeVerifier();
        const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
        const returnTo = safeReturnTo(
          typeof request.query === "object" && request.query !== null
            ? String((request.query as Record<string, unknown>).return_to ?? "")
            : undefined,
        );
        const transaction: LoginTransaction = {
          version: 1,
          state,
          nonce,
          codeVerifier,
          expiresAt: Date.now() + LOGIN_TRANSACTION_TTL_SECONDS * 1000,
          returnTo,
        };
        const url = await client.authorizationUrl({
          client_id: config.clientId,
          redirect_uri: config.redirectUri,
          response_type: "code",
          scope: "openid profile email",
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });
        addCookie(reply, LOGIN_COOKIE, encryptLoginTransaction(secret, transaction), {
          maxAge: LOGIN_TRANSACTION_TTL_SECONDS,
          secure,
        });
        return reply.redirect(url.href, 302);
      } catch (error) {
        request.log.warn(errorFields(error), "OIDC discovery or authorization failed");
        return reply.code(503).send("Sign-in is temporarily unavailable.");
      }
    });

    app.get("/auth/callback", async (request, reply) => {
      const loginCookie = cookieValue(request, LOGIN_COOKIE);
      clearCookie(reply, LOGIN_COOKIE, secure);
      if (loginCookie === undefined) {
        return reply.code(400).send("The sign-in request expired. Please try again.");
      }

      let transaction: LoginTransaction;
      try {
        transaction = decryptLoginTransaction(secret, loginCookie);
      } catch {
        return reply.code(400).send("The sign-in request expired. Please try again.");
      }

      try {
        const callback = new URL(request.url, config.redirectUri);
        const tokens = await client.authorizationCodeGrant(callback, {
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
          issuer !== config.issuerUrl ||
          subject === undefined ||
          username === undefined ||
          !includesAudience(claims.aud, config.clientId) ||
          typeof claims.exp !== "number" ||
          claims.exp * 1000 <= Date.now()
        ) {
          return reply.code(401).send("Sign-in could not be verified.");
        }
        if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
          return reply.code(401).send("Sign-in could not be verified.");
        }
        const accessTokenExpiry = await client.validateAccessToken(tokens.access_token, subject);
        if (!hasRequiredGroup(claims)) {
          await withActor(pool, { name: username, type: "human" }, (tx) =>
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
          nonce: transaction.nonce,
          refreshToken: tokens.refresh_token,
          accessTokenExpiresAt: Math.min(accessTokenExpiry, tokenExpiry(tokens, claims)),
          returnTo: transaction.returnTo,
        };
        const login = await withActor(pool, { name: username, type: "human" }, (tx) =>
          upsertUserOnLogin(tx, {
            issuer,
            sub: subject,
            username,
            email: requiredString(claims, "email") ?? null,
            displayName: requiredString(claims, "name") ?? null,
          }),
        );
        const session = await createWebSession(pool, {
          userId: login.id,
          refreshTokenEncrypted: encryptSessionData(secret, identity),
          idTokenHint:
            typeof tokens.id_token === "string"
              ? encryptIdTokenHint(secret, tokens.id_token)
              : null,
          idleTimeoutSeconds: config.idleTimeoutSeconds,
          absoluteTimeoutSeconds: config.absoluteTimeoutSeconds,
        });
        addCookie(reply, SESSION_COOKIE, session.id, {
          maxAge: config.absoluteTimeoutSeconds,
          secure,
        });
        return reply.redirect(identity.returnTo, 303);
      } catch (error) {
        request.log.warn(errorFields(error), "OIDC callback failed");
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

    // A page with a button instead of a state-changing GET: signing out needs the CSRF token.
    app.get("/auth/logout", { preHandler: app.requireAuthenticated }, async (request, reply) => {
      if (request.sessionId === undefined) {
        return reply.code(401).send({ error: "Authentication required." });
      }
      const nonce = randomBytes(18).toString("base64url");
      reply.header("Content-Security-Policy", contentSecurityPolicy(nonce));
      reply.type("text/html; charset=utf-8");
      const token = csrfToken(secret, request.sessionId);
      return reply.send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign out</title><h1>Sign out</h1><button id="sign-out" type="button">Sign out</button><script nonce="${nonce}">document.getElementById("sign-out").addEventListener("click",async()=>{const response=await fetch("/auth/logout",{method:"POST",headers:{"X-CSRF-Token":"${token}",Accept:"application/json"}});if(response.ok){const result=await response.json();location.assign(result.redirectTo)}else{location.reload()}})</script></html>`,
      );
    });

    app.post("/auth/logout", { preHandler: app.requireAuthenticated }, async (request, reply) => {
      if (request.sessionId === undefined) {
        return reply.code(401).send({ error: "Authentication required." });
      }
      const session = await getWebSession(pool, request.sessionId);
      const idTokenHint =
        session === null || session.idTokenHint === null
          ? null
          : decryptIdTokenHint(secret, session.idTokenHint);
      const redirectUrl = await client.endSessionUrl(idTokenHint);
      await deleteWebSession(pool, request.sessionId);
      clearCookie(reply, SESSION_COOKIE, secure);
      clearCookie(reply, LOGIN_COOKIE, secure);
      reply.header("Clear-Site-Data", '"cache", "storage"');
      const target = redirectUrl?.href ?? new URL("/", config.redirectUri).href;
      if (request.headers.accept?.includes("application/json")) {
        return reply.send({ redirectTo: target });
      }
      return reply.redirect(target, 303);
    });
  }

  return { csrfSecret: secret, origin, loadSession, registerRoutes };
}
