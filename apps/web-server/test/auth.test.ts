import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getUserAccess, setUserPermission, withActor, type UserAccess } from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { loadEnv } from "../src/env.js";

const ISSUER = "http://localhost:8080/realms/youtube-workspace";
const CLIENT_ID = "youtube-workspace";
const REQUIRED_GROUP = "youtube-workspace-users";
const HOST = "localhost:5173";
const ORIGIN = `http://${HOST}`;
const SESSION_SECRET = "a-dev-only-session-secret-with-32-or-more-characters";
const ROUTES = fileURLToPath(new URL("./fixtures/routes", import.meta.url));

interface IdentityProfile {
  subject: string;
  username: string;
  groups: string[];
  expiresIn: number;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

class MockOidcProvider {
  readonly #privateKey: KeyObject;
  readonly publicJwk: Record<string, unknown>;
  readonly profiles = new Map<string, IdentityProfile>();
  userInfoGroups = [REQUIRED_GROUP];
  refreshCalls = 0;
  readonly fetch: typeof fetch;

  constructor() {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.#privateKey = pair.privateKey;
    const exported = pair.publicKey.export({ format: "jwk" });
    this.publicJwk = { ...exported, kid: "test-key", use: "sig", alg: "RS256" };
    this.fetch = this.#fetch.bind(this);
  }

  signIdToken(profile: IdentityProfile, nonce: string): string {
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }));
    const payload = base64url(
      JSON.stringify({
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: profile.subject,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce,
        preferred_username: profile.username,
        name: profile.username,
        email: `${profile.username}@example.test`,
        realm: { groups: profile.groups },
      }),
    );
    const signed = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256")
      .update(signed)
      .sign(this.#privateKey)
      .toString("base64url");
    return `${signed}.${signature}`;
  }

  async #fetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return this.#json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        userinfo_endpoint: `${ISSUER}/protocol/openid-connect/userinfo`,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
        end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname.endsWith("/protocol/openid-connect/certs")) {
      return this.#json({ keys: [this.publicJwk] });
    }
    if (url.pathname.endsWith("/protocol/openid-connect/token")) {
      const body = init?.body;
      const parameters = new URLSearchParams(
        typeof body === "string" ? body : body instanceof URLSearchParams ? body : "",
      );
      if (parameters.get("grant_type") === "refresh_token") {
        this.refreshCalls += 1;
        return this.#json({
          access_token: `access-refreshed-${this.refreshCalls}`,
          refresh_token: `refresh-rotated-${this.refreshCalls}`,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      const code = parameters.get("code") ?? "";
      const profile = this.profiles.get(code);
      if (profile === undefined) return this.#json({ error: "invalid_grant" }, 400);
      // openid-client sends nonce in the authorization request; tests use one profile per flow.
      const idToken = this.signIdToken(profile, this.lastNonce ?? "");
      return this.#json({
        access_token: `access-${profile.username}`,
        refresh_token: `refresh-${profile.username}`,
        token_type: "Bearer",
        expires_in: profile.expiresIn,
        id_token: idToken,
      });
    }
    if (url.pathname.endsWith("/protocol/openid-connect/userinfo")) {
      return this.#json({
        sub: this.lastSubject ?? "subject-owner",
        realm: { groups: this.userInfoGroups },
      });
    }
    throw new Error(`unexpected OIDC fetch ${url.href}`);
  }

  lastNonce: string | undefined;
  lastSubject: string | undefined;

  #json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}

function env(databaseUrl: string): Env {
  return loadEnv({
    LOG_LEVEL: "silent",
    DATABASE_URL: databaseUrl,
    OIDC_ISSUER_URL: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: "dev-only-secret",
    OIDC_REDIRECT_URI: `${ORIGIN}/auth/callback`,
    OIDC_GROUPS_CLAIM_PATH: "realm.groups",
    OIDC_REQUIRED_GROUP: REQUIRED_GROUP,
    SESSION_SECRET,
  });
}

function cookieLine(response: { headers: Record<string, unknown> }, name: string): string {
  const values = response.headers["set-cookie"];
  const cookies = Array.isArray(values)
    ? values.map(String)
    : typeof values === "string"
      ? [values]
      : [];
  const match = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (match === undefined) throw new Error(`response did not set ${name}`);
  return match;
}

function setCookie(response: { headers: Record<string, unknown> }, name: string): string {
  const match = cookieLine(response, name);
  return match.split(";", 1)[0] ?? match;
}

async function signIn(
  app: FastifyInstance,
  provider: MockOidcProvider,
  code: string,
): Promise<string> {
  const profile = provider.profiles.get(code);
  if (profile === undefined) throw new Error(`missing profile ${code}`);
  const login = await app.inject({
    method: "GET",
    url: "/auth/login?return_to=%2Fideas",
    headers: { host: HOST },
  });
  expect(login.statusCode).toBe(302);
  const authorizationUrl = new URL(login.headers.location as string);
  expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const state = authorizationUrl.searchParams.get("state");
  const nonce = authorizationUrl.searchParams.get("nonce");
  if (state === null || nonce === null)
    throw new Error("authorization request omitted state or nonce");
  provider.lastNonce = nonce;
  provider.lastSubject = profile.subject;
  const transactionCookie = setCookie(login, "ytw_oidc");
  const callback = await app.inject({
    method: "GET",
    url: `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    headers: { host: HOST, cookie: transactionCookie },
  });
  expect(callback.statusCode).toBe(303);
  const sessionCookie = cookieLine(callback, "ytw_session");
  expect(sessionCookie).toContain("HttpOnly");
  expect(sessionCookie).toContain("SameSite=Lax");
  expect(sessionCookie).not.toContain("Secure");
  expect(callback.headers.location).toBe("/ideas");
  return setCookie(callback, "ytw_session");
}

async function loginRequest(app: FastifyInstance, sessionCookie: string, url = "/api/me") {
  return app.inject({ method: "GET", url, headers: { host: HOST, cookie: sessionCookie } });
}

let db: TestDb;
let app: FastifyInstance;
let provider: MockOidcProvider;
let webPool: ReturnType<TestDb["pool"]>;

beforeAll(async () => {
  db = await createTestDb();
  webPool = db.pool("ytw_web");
  provider = new MockOidcProvider();
  provider.profiles.set("owner", {
    subject: "subject-owner",
    username: "owner",
    groups: [`/${REQUIRED_GROUP}`],
    expiresIn: 3600,
  });
  provider.profiles.set("outsider", {
    subject: "subject-outsider",
    username: "outsider",
    groups: ["other-group"],
    expiresIn: 3600,
  });
  provider.profiles.set("reader", {
    subject: "subject-reader",
    username: "reader",
    groups: [REQUIRED_GROUP],
    expiresIn: 3600,
  });
  app = await buildApp(env(db.url("ytw_web")), {
    pool: webPool,
    oidcFetch: provider.fetch,
    routeDirectory: ROUTES,
  });
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe("web BFF OIDC and sessions", () => {
  it("allows a grouped user, creates the first admin, and does not create a user for an outsider", async () => {
    expect(app.securityRoutes().filter((route) => !route.guarded)).toEqual([]);
    const ownerCookie = await signIn(app, provider, "owner");
    const me = await loginRequest(app, ownerCookie);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: { username: "owner", displayName: "owner", email: "owner@example.test", isAdmin: true },
    });
    expect(me.headers["x-csrf-token"]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(me.headers["cache-control"]).toBe("no-store");
    expect(me.headers["set-cookie"]).toBeUndefined();
    const sessionId = ownerCookie.slice("ytw_session=".length);
    const stored = await db.admin.query<{ refresh_token_encrypted: Buffer }>(
      "SELECT refresh_token_encrypted FROM ytw_private.web_sessions WHERE id = $1::uuid",
      [sessionId],
    );
    expect(stored.rows[0]?.refresh_token_encrypted).toBeInstanceOf(Buffer);
    expect(stored.rows[0]?.refresh_token_encrypted.toString("utf8")).not.toContain("refresh-owner");
    const actor = await app.inject({
      method: "POST",
      url: "/api/actor",
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: ownerCookie,
        "x-csrf-token": String(me.headers["x-csrf-token"]),
      },
    });
    expect(actor.statusCode).toBe(200);
    expect(actor.json()).toEqual({ name: "owner", type: "human", tokenId: null });

    const denied = await signInDenied(app, provider, "outsider");
    expect(denied.statusCode).toBe(303);
    expect(denied.headers.location).toBe("/auth/access-denied");
    expect(denied.headers["set-cookie"]).not.toContain("ytw_session=");
    const deniedPage = await app.inject({
      method: "GET",
      url: "/auth/access-denied",
      headers: { host: HOST },
    });
    expect(deniedPage.statusCode).toBe(403);
    expect(deniedPage.body).toContain("Access denied");
    const rows = await db.admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM users WHERE oidc_sub = $1",
      ["subject-outsider"],
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("rejects CSRF, requires same-origin POSTs, and performs RP logout", async () => {
    const cookie = await signIn(app, provider, "owner");
    const me = await loginRequest(app, cookie);
    const csrf = String(me.headers["x-csrf-token"]);
    const missing = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { host: HOST, origin: ORIGIN, cookie },
    });
    expect(missing.statusCode).toBe(403);
    const crossOrigin = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { host: HOST, origin: "https://attacker.example", cookie, "x-csrf-token": csrf },
    });
    expect(crossOrigin.statusCode).toBe(403);

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie,
        "x-csrf-token": csrf,
        accept: "application/json",
      },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["clear-site-data"]).toBe('"cache", "storage"');
    expect(logout.json().redirectTo).toContain("/protocol/openid-connect/logout");
    expect(logout.json().redirectTo).toContain("id_token_hint=");
    const logoutCookies = logout.headers["set-cookie"];
    expect(
      (Array.isArray(logoutCookies) ? logoutCookies : [logoutCookies]).some((value) =>
        value?.includes("Max-Age=0"),
      ),
    ).toBe(true);
    expect((await loginRequest(app, cookie)).statusCode).toBe(401);
  });

  it("ends and revokes a session when refresh finds the user outside the access group", async () => {
    const profile = provider.profiles.get("owner");
    if (profile === undefined) throw new Error("owner profile missing");
    provider.profiles.set("expiring", { ...profile, expiresIn: 0 });
    const cookie = await signIn(app, provider, "expiring");
    provider.userInfoGroups = [];
    const me = await loginRequest(app, cookie);
    expect(provider.refreshCalls).toBeGreaterThan(0);
    expect(me.statusCode).toBe(401);
    const access = await db.admin.query<{ access_revoked_at: Date | null }>(
      "SELECT access_revoked_at FROM users WHERE oidc_sub = $1",
      ["subject-owner"],
    );
    expect(access.rows[0]?.access_revoked_at).toBeInstanceOf(Date);
    const session = await db.admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM ytw_private.web_sessions WHERE id = $1::uuid",
      [cookie.slice("ytw_session=".length)],
    );
    expect(session.rows[0]?.count).toBe(0);
    provider.userInfoGroups = [REQUIRED_GROUP];
  });

  it("expires idle and absolute sessions and checks permissions against current DB levels", async () => {
    const ownerCookie = await signIn(app, provider, "owner");
    const readerCookie = await signIn(app, provider, "reader");
    const owner = await userByUsername("owner");
    const reader = await userByUsername("reader");

    await withActor(webPool, { name: "owner", type: "human" }, (tx) =>
      setUserPermission(tx, {
        actingUserId: owner.id,
        userId: reader.id,
        resource: "ideas",
        level: "read",
      }),
    );
    const allowed = await loginRequest(app, readerCookie, "/api/protected");
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ username: "reader" });
    const readerMe = await loginRequest(app, readerCookie);
    const writeDenied = await app.inject({
      method: "POST",
      url: "/api/protected",
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: readerCookie,
        "x-csrf-token": String(readerMe.headers["x-csrf-token"]),
      },
    });
    expect(writeDenied.statusCode).toBe(403);

    await withActor(webPool, { name: "owner", type: "human" }, (tx) =>
      setUserPermission(tx, {
        actingUserId: owner.id,
        userId: reader.id,
        resource: "ideas",
        level: "none",
      }),
    );
    const denied = await loginRequest(app, readerCookie, "/api/protected");
    expect(denied.statusCode).toBe(403);

    const idleCookie = await signIn(app, provider, "reader");
    const idleSessionId = idleCookie.slice("ytw_session=".length);
    await db.admin.query(
      `UPDATE ytw_private.web_sessions
          SET last_seen_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute',
              absolute_expires_at = now() + interval '1 hour'
        WHERE id = $1::uuid`,
      [idleSessionId],
    );
    expect((await loginRequest(app, idleCookie)).statusCode).toBe(401);

    const absoluteCookie = await signIn(app, provider, "reader");
    const absoluteSessionId = absoluteCookie.slice("ytw_session=".length);
    await db.admin.query(
      `UPDATE ytw_private.web_sessions
          SET created_at = now() - interval '8 days', last_seen_at = now() - interval '8 days',
              expires_at = now() - interval '1 minute', absolute_expires_at = now() - interval '30 seconds'
        WHERE id = $1::uuid`,
      [absoluteSessionId],
    );
    expect((await loginRequest(app, absoluteCookie)).statusCode).toBe(401);

    // Keep this import exercised as a contract check: the handler reads the committed DB row.
    expect((await getUserAccess(webPool, reader.id))?.levels.ideas).toBe("none");
    expect((await loginRequest(app, ownerCookie)).statusCode).toBe(200);
  });
});

async function userByUsername(username: string): Promise<UserAccess> {
  const result = await db.admin.query<{ user_id: string }>(
    "SELECT id AS user_id FROM users WHERE username = $1",
    [username],
  );
  const id = result.rows[0]?.user_id;
  if (id === undefined) throw new Error(`user ${username} not found`);
  const access = await getUserAccess(webPool, id);
  if (access === null) throw new Error(`access for ${username} not found`);
  return access;
}

async function signInDenied(server: FastifyInstance, oidc: MockOidcProvider, code: string) {
  const profile = oidc.profiles.get(code);
  if (profile === undefined) throw new Error(`missing profile ${code}`);
  const login = await server.inject({ method: "GET", url: "/auth/login", headers: { host: HOST } });
  const authorizationUrl = new URL(login.headers.location as string);
  const state = authorizationUrl.searchParams.get("state");
  const nonce = authorizationUrl.searchParams.get("nonce");
  if (state === null || nonce === null)
    throw new Error("authorization request omitted state or nonce");
  oidc.lastNonce = nonce;
  oidc.lastSubject = profile.subject;
  return server.inject({
    method: "GET",
    url: `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    headers: { host: HOST, cookie: setCookie(login, "ytw_oidc") },
  });
}
