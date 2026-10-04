import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getUserAccess, setUserPermission, withActor, type UserAccess } from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { OidcClient } from "../src/core/oidc.js";
import {
  decryptSessionData,
  encryptSessionData,
  type SessionSecretData,
} from "../src/core/session-crypto.js";
import type { Env } from "../src/env.js";
import { loadEnv } from "../src/env.js";

const ISSUER = "http://localhost:8080/realms/youtube-workspace";
const CLIENT_ID = "youtube-workspace";
const REQUIRED_GROUP = "youtube-workspace-users";
const HOST = "localhost:5173";
const ORIGIN = "https://workspace.example";
const SESSION_SECRET = "a-dev-only-session-secret-with-32-or-more-characters";
const ROUTES = fileURLToPath(new URL("./fixtures/routes", import.meta.url));

interface IdentityProfile {
  subject: string;
  username: string;
  groups: string[];
  expiresIn: number;
}

interface TokenClaimsOverride {
  issuer?: string;
  audience?: string | string[];
  subject?: string;
  expiresAt?: number;
}

interface IdTokenOverride extends TokenClaimsOverride {
  nonce?: string;
}

interface RefreshIdTokenOverride {
  subject?: string;
  nonce?: string | null;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

class MockOidcProvider {
  readonly #privateKey: KeyObject;
  readonly publicJwk: Record<string, unknown>;
  readonly profiles = new Map<string, IdentityProfile>();
  readonly accessTokenOverrides = new Map<string, string | TokenClaimsOverride>();
  readonly idTokenOverrides = new Map<string, IdTokenOverride>();
  readonly invalidIdTokenSignatures = new Set<string>();
  readonly invalidAccessTokenSignatures = new Set<string>();
  readonly refreshIdTokenOverrides = new Map<string, RefreshIdTokenOverride>();
  userInfoGroups: string[] | undefined;
  omitJwks = false;
  emptyJwks = false;
  refreshDelayMilliseconds = 0;
  refreshCalls = 0;
  #loginTokenSequence = 0;
  readonly #refreshTokenProfiles = new Map<string, IdentityProfile>();
  readonly #consumedRefreshTokens = new Set<string>();
  readonly #accessTokenSubjects = new Map<string, string>();
  readonly fetch: typeof fetch;

  constructor() {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.#privateKey = pair.privateKey;
    const exported = pair.publicKey.export({ format: "jwk" });
    this.publicJwk = { ...exported, kid: "test-key", use: "sig", alg: "RS256" };
    this.fetch = this.#fetch.bind(this);
  }

  signIdToken(profile: IdentityProfile, nonce: string | undefined): string {
    const override = this.idTokenOverrides.get(profile.username);
    const nonceClaim = override?.nonce ?? nonce;
    const token = this.#signJwt({
      iss: override?.issuer ?? ISSUER,
      aud: override?.audience ?? CLIENT_ID,
      sub: override?.subject ?? profile.subject,
      iat: Math.floor(Date.now() / 1000),
      exp: override?.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
      ...(nonceClaim === undefined ? {} : { nonce: nonceClaim }),
      preferred_username: profile.username,
      name: profile.username,
      email: `${profile.username}@example.test`,
      realm: { groups: profile.groups },
    });
    return this.invalidIdTokenSignatures.has(profile.username)
      ? this.#corruptSignature(token)
      : token;
  }

  signAccessToken(profile: IdentityProfile): string {
    const override = this.accessTokenOverrides.get(profile.username);
    if (typeof override === "string") return override;
    const claims = override ?? {};
    const token = this.#signJwt({
      iss: claims.issuer ?? ISSUER,
      aud: claims.audience ?? CLIENT_ID,
      sub: claims.subject ?? profile.subject,
      iat: Math.floor(Date.now() / 1000),
      exp: claims.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
    });
    if (this.invalidAccessTokenSignatures.has(profile.username)) {
      return this.#corruptSignature(token);
    }
    this.#accessTokenSubjects.set(token, profile.subject);
    return token;
  }

  #corruptSignature(token: string): string {
    const [header, payload, signature = ""] = token.split(".");
    const first = signature[0] === "A" ? "B" : "A";
    return `${header}.${payload}.${first}${signature.slice(1)}`;
  }

  #signJwt(payload: Record<string, unknown>): string {
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }));
    const encodedPayload = base64url(JSON.stringify(payload));
    const signed = `${header}.${encodedPayload}`;
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
        ...(this.omitJwks ? {} : { jwks_uri: `${ISSUER}/protocol/openid-connect/certs` }),
        end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname.endsWith("/protocol/openid-connect/certs")) {
      return this.#json({ keys: this.emptyJwks ? [] : [this.publicJwk] });
    }
    if (url.pathname.endsWith("/protocol/openid-connect/token")) {
      const body = init?.body;
      const parameters = new URLSearchParams(
        typeof body === "string" ? body : body instanceof URLSearchParams ? body : "",
      );
      if (parameters.get("grant_type") === "refresh_token") {
        const refreshToken = parameters.get("refresh_token") ?? "";
        const profile = this.#refreshTokenProfiles.get(refreshToken);
        if (profile === undefined || this.#consumedRefreshTokens.has(refreshToken)) {
          return this.#json({ error: "invalid_grant" }, 400);
        }
        this.#consumedRefreshTokens.add(refreshToken);
        this.refreshCalls += 1;
        if (this.refreshDelayMilliseconds > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.refreshDelayMilliseconds));
        }
        const rotatedRefreshToken = `refresh-rotated-${this.refreshCalls}`;
        this.#refreshTokenProfiles.set(rotatedRefreshToken, profile);
        const refreshIdToken = this.refreshIdTokenOverrides.get(profile.username);
        return this.#json({
          access_token: this.signAccessToken(profile),
          refresh_token: rotatedRefreshToken,
          token_type: "Bearer",
          expires_in: 3600,
          ...(refreshIdToken === undefined
            ? {}
            : {
                id_token: this.signIdToken(
                  { ...profile, subject: refreshIdToken.subject ?? profile.subject },
                  refreshIdToken.nonce ?? undefined,
                ),
              }),
        });
      }
      const code = parameters.get("code") ?? "";
      const profile = this.profiles.get(code);
      if (profile === undefined) return this.#json({ error: "invalid_grant" }, 400);
      // openid-client sends nonce in the authorization request; tests use one profile per flow.
      const idToken = this.signIdToken(profile, this.lastNonce ?? "");
      const refreshToken = `refresh-${profile.username}-${++this.#loginTokenSequence}`;
      this.#refreshTokenProfiles.set(refreshToken, profile);
      return this.#json({
        access_token: this.signAccessToken(profile),
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: profile.expiresIn,
        id_token: idToken,
      });
    }
    if (url.pathname.endsWith("/protocol/openid-connect/userinfo")) {
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      const token = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      const subject = token === undefined ? undefined : this.#accessTokenSubjects.get(token);
      const profile = [...this.profiles.values()].find(
        (candidate) => candidate.subject === subject,
      );
      if (profile === undefined) return this.#json({ error: "invalid_token" }, 401);
      return this.#json({
        sub: profile.subject,
        realm: { groups: this.userInfoGroups ?? profile.groups },
      });
    }
    throw new Error(`unexpected OIDC fetch ${url.href}`);
  }

  lastNonce: string | undefined;

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

async function attemptLogin(
  app: FastifyInstance,
  provider: MockOidcProvider,
  code: string,
  options: { tamperState?: boolean } = {},
): Promise<{
  login: Awaited<ReturnType<FastifyInstance["inject"]>>;
  callback: Awaited<ReturnType<FastifyInstance["inject"]>>;
}> {
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
  const transactionCookie = setCookie(login, "ytw_oidc");
  const callback = await app.inject({
    method: "GET",
    url: `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(
      options.tamperState ? `${state}-tampered` : state,
    )}`,
    headers: { host: HOST, cookie: transactionCookie },
  });
  return { login, callback };
}

async function signIn(
  app: FastifyInstance,
  provider: MockOidcProvider,
  code: string,
): Promise<string> {
  const { login, callback } = await attemptLogin(app, provider, code);
  expect(callback.statusCode).toBe(303);
  expect(cookieLine(login, "ytw_oidc")).toContain("Secure");
  const sessionCookie = cookieLine(callback, "ytw_session");
  expect(sessionCookie).toContain("HttpOnly");
  expect(sessionCookie).toContain("SameSite=Lax");
  expect(sessionCookie).toContain("Secure");
  expect(callback.headers.location).toBe("/ideas");
  return setCookie(callback, "ytw_session");
}

async function loginRequest(app: FastifyInstance, sessionCookie: string, url = "/api/me") {
  return app.inject({ method: "GET", url, headers: { host: HOST, cookie: sessionCookie } });
}

async function readSessionSecret(cookie: string): Promise<SessionSecretData> {
  const result = await db.admin.query<{ refresh_token_encrypted: Buffer | null }>(
    "SELECT refresh_token_encrypted FROM ytw_private.web_sessions WHERE id = $1::uuid",
    [cookie.slice("ytw_session=".length)],
  );
  const encrypted = result.rows[0]?.refresh_token_encrypted;
  if (encrypted === undefined || encrypted === null) throw new Error("session ciphertext missing");
  return decryptSessionData(SESSION_SECRET, encrypted);
}

async function writeSessionSecret(cookie: string, data: SessionSecretData): Promise<void> {
  await db.admin.query(
    "UPDATE ytw_private.web_sessions SET refresh_token_encrypted = $2 WHERE id = $1::uuid",
    [cookie.slice("ytw_session=".length), encryptSessionData(SESSION_SECRET, data)],
  );
}

async function countSession(cookie: string): Promise<number> {
  const result = await db.admin.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM ytw_private.web_sessions WHERE id = $1::uuid",
    [cookie.slice("ytw_session=".length)],
  );
  return result.rows[0]?.count ?? 0;
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

  it("rejects hostile callback tokens and state before creating a user or session", async () => {
    const attacks: Array<{
      code: string;
      setup: (username: string) => void;
      tamperState?: boolean;
    }> = [
      { code: "bad-state", setup: () => undefined, tamperState: true },
      {
        code: "bad-id-signature",
        setup: (username) => provider.invalidIdTokenSignatures.add(username),
      },
      {
        code: "bad-id-nonce",
        setup: (username) => provider.idTokenOverrides.set(username, { nonce: "wrong-nonce" }),
      },
      {
        code: "bad-id-issuer",
        setup: (username) => provider.idTokenOverrides.set(username, { issuer: `${ISSUER}/evil` }),
      },
      {
        code: "bad-id-audience",
        setup: (username) =>
          provider.idTokenOverrides.set(username, { audience: "another-client" }),
      },
      {
        code: "expired-id-token",
        setup: (username) =>
          provider.idTokenOverrides.set(username, {
            expiresAt: Math.floor(Date.now() / 1000) - 60,
          }),
      },
      {
        code: "opaque-access-token",
        setup: (username) => provider.accessTokenOverrides.set(username, "not-a-jwt"),
      },
      {
        code: "forged-access-signature",
        setup: (username) => provider.invalidAccessTokenSignatures.add(username),
      },
      {
        code: "bad-access-issuer",
        setup: (username) =>
          provider.accessTokenOverrides.set(username, { issuer: `${ISSUER}/evil` }),
      },
      {
        code: "bad-access-audience",
        setup: (username) =>
          provider.accessTokenOverrides.set(username, { audience: "another-client" }),
      },
      {
        code: "expired-access-token",
        setup: (username) =>
          provider.accessTokenOverrides.set(username, {
            expiresAt: Math.floor(Date.now() / 1000) - 60,
          }),
      },
      {
        code: "wrong-access-subject",
        setup: (username) =>
          provider.accessTokenOverrides.set(username, { subject: "someone-else" }),
      },
    ];

    for (const attack of attacks) {
      const profile: IdentityProfile = {
        subject: `subject-${attack.code}`,
        username: attack.code,
        groups: [REQUIRED_GROUP],
        expiresIn: 3600,
      };
      provider.profiles.set(attack.code, profile);
      attack.setup(profile.username);
      const { callback } = await attemptLogin(app, provider, attack.code, {
        tamperState: attack.tamperState,
      });
      expect(callback.statusCode).toBe(401);
      expect(callback.headers["set-cookie"]?.toString()).not.toContain("ytw_session=");
      await expectNoIdentity(profile.subject);
      provider.idTokenOverrides.delete(profile.username);
      provider.accessTokenOverrides.delete(profile.username);
      provider.invalidIdTokenSignatures.delete(profile.username);
      provider.invalidAccessTokenSignatures.delete(profile.username);
    }
  });

  it("rejects signed login when the discovered issuer has an empty JWKS", async () => {
    const noKeysProvider = new MockOidcProvider();
    noKeysProvider.emptyJwks = true;
    noKeysProvider.profiles.set("no-jwks", {
      subject: "subject-no-jwks",
      username: "no-jwks",
      groups: [REQUIRED_GROUP],
      expiresIn: 3600,
    });
    const noKeysApp = await buildApp(env(db.url("ytw_web")), {
      pool: webPool,
      oidcFetch: noKeysProvider.fetch,
      routeDirectory: ROUTES,
    });
    try {
      const { callback } = await attemptLogin(noKeysApp, noKeysProvider, "no-jwks");
      expect(callback.statusCode).toBe(401);
      await expectNoIdentity("subject-no-jwks");
    } finally {
      await noKeysApp.close();
    }
  });

  it("retries OIDC discovery after an initial transient failure", async () => {
    let discoveryCalls = 0;
    const retryingFetch: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      if (url.pathname.endsWith("/.well-known/openid-configuration")) {
        discoveryCalls += 1;
        if (discoveryCalls === 1) {
          return new Response("temporarily unavailable", { status: 503 });
        }
      }
      return provider.fetch(input, init);
    };
    const client = new OidcClient(env(db.url("ytw_web")), retryingFetch);
    const parameters = {
      client_id: CLIENT_ID,
      redirect_uri: `${ORIGIN}/auth/callback`,
      response_type: "code",
    };
    await expect(client.authorizationUrl(parameters)).rejects.toBeInstanceOf(Error);
    await expect(client.authorizationUrl(parameters)).resolves.toBeInstanceOf(URL);
    expect(discoveryCalls).toBe(2);
  });

  it("serializes simultaneous refreshes and persists the rotated single-use refresh token", async () => {
    provider.profiles.set("refresh-race", {
      subject: "subject-refresh-race",
      username: "refresh-race",
      groups: [REQUIRED_GROUP],
      expiresIn: 0,
    });
    const cookie = await signIn(app, provider, "refresh-race");
    const expectedUser = await userByUsername("refresh-race");
    const initialRefreshCalls = provider.refreshCalls;
    provider.refreshDelayMilliseconds = 40;
    let firstResponses: Awaited<ReturnType<typeof loginRequest>>[];
    try {
      firstResponses = await Promise.all([loginRequest(app, cookie), loginRequest(app, cookie)]);
    } finally {
      provider.refreshDelayMilliseconds = 0;
    }
    expect(provider.refreshCalls - initialRefreshCalls).toBe(1);
    expect(firstResponses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(firstResponses.map((response) => response.json().user.id)).toEqual([
      expectedUser.id,
      expectedUser.id,
    ]);

    const sessionId = cookie.slice("ytw_session=".length);
    const stored = await db.admin.query<{ refresh_token_encrypted: Buffer }>(
      "SELECT refresh_token_encrypted FROM ytw_private.web_sessions WHERE id = $1::uuid",
      [sessionId],
    );
    const encrypted = stored.rows[0]?.refresh_token_encrypted;
    if (encrypted === undefined) throw new Error("rotated session ciphertext missing");
    const secret = decryptSessionData(SESSION_SECRET, encrypted);
    expect(secret.refreshToken).toMatch(/^refresh-rotated-/);

    await db.admin.query(
      "UPDATE ytw_private.web_sessions SET refresh_token_encrypted = $2 WHERE id = $1::uuid",
      [
        sessionId,
        encryptSessionData(SESSION_SECRET, { ...secret, accessTokenExpiresAt: Date.now() - 1000 }),
      ],
    );
    const rotatedRefreshCalls = provider.refreshCalls;
    const again = await loginRequest(app, cookie);
    expect(again.statusCode).toBe(200);
    expect(again.json().user.id).toBe(expectedUser.id);
    expect(provider.refreshCalls - rotatedRefreshCalls).toBe(1);
  });

  it("does not change the session identity when refresh returns another subject", async () => {
    provider.profiles.set("refresh-subject-change", {
      subject: "subject-refresh-subject-change",
      username: "refresh-subject-change",
      groups: [REQUIRED_GROUP],
      expiresIn: 0,
    });
    provider.refreshIdTokenOverrides.set("refresh-subject-change", {
      subject: "subject-attacker",
    });
    const cookie = await signIn(app, provider, "refresh-subject-change");
    const expectedUser = await userByUsername("refresh-subject-change");
    const response = await loginRequest(app, cookie);
    expect(response.statusCode).toBe(401);
    expect((await userByUsername("refresh-subject-change")).id).toBe(expectedUser.id);
    await expectNoIdentity("subject-attacker");
    const session = await db.admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM ytw_private.web_sessions WHERE id = $1::uuid",
      [cookie.slice("ytw_session=".length)],
    );
    expect(session.rows[0]?.count).toBe(0);
    provider.refreshIdTokenOverrides.delete("refresh-subject-change");
  });

  it("accepts an omitted or matching refresh nonce and rejects a mismatched nonce", async () => {
    const cases = [
      { code: "refresh-nonce-omitted", nonce: null, expectedStatus: 200 },
      { code: "refresh-nonce-matching", nonce: "matching", expectedStatus: 200 },
      { code: "refresh-nonce-wrong", nonce: "wrong", expectedStatus: 401 },
    ] as const;

    for (const testCase of cases) {
      const profile: IdentityProfile = {
        subject: `subject-${testCase.code}`,
        username: testCase.code,
        groups: [REQUIRED_GROUP],
        expiresIn: 0,
      };
      provider.profiles.set(testCase.code, profile);
      const cookie = await signIn(app, provider, testCase.code);
      const original = await readSessionSecret(cookie);
      if (typeof original.nonce !== "string") throw new Error("original OIDC nonce was not stored");
      const returnedNonce =
        testCase.nonce === "matching"
          ? original.nonce
          : testCase.nonce === "wrong"
            ? `${original.nonce}-wrong`
            : null;
      provider.refreshIdTokenOverrides.set(profile.username, { nonce: returnedNonce });

      const response = await loginRequest(app, cookie);
      expect(response.statusCode).toBe(testCase.expectedStatus);
      const sessionCount = await countSession(cookie);
      expect(sessionCount).toBe(testCase.expectedStatus === 200 ? 1 : 0);
      const setCookieHeader = response.headers["set-cookie"]?.toString() ?? "";
      const shouldClearSession = testCase.expectedStatus === 401;
      expect(setCookieHeader.includes("ytw_session=; Path=/")).toBe(shouldClearSession);
      expect(setCookieHeader.includes("Max-Age=0")).toBe(shouldClearSession);
      expect(setCookieHeader.includes("Secure")).toBe(shouldClearSession);
      provider.refreshIdTokenOverrides.delete(profile.username);
    }
  });

  it("keeps legacy nonce-less sessions only when a refresh ID token also omits nonce", async () => {
    for (const testCase of [
      { code: "legacy-refresh-no-nonce", returnedNonce: null, expectedStatus: 200 },
      {
        code: "legacy-refresh-unverifiable-nonce",
        returnedNonce: "unverifiable",
        expectedStatus: 401,
      },
    ]) {
      const profile: IdentityProfile = {
        subject: `subject-${testCase.code}`,
        username: testCase.code,
        groups: [REQUIRED_GROUP],
        expiresIn: 0,
      };
      provider.profiles.set(testCase.code, profile);
      const cookie = await signIn(app, provider, testCase.code);
      const legacy = await readSessionSecret(cookie);
      delete legacy.nonce;
      await writeSessionSecret(cookie, legacy);
      provider.refreshIdTokenOverrides.set(profile.username, { nonce: testCase.returnedNonce });

      const response = await loginRequest(app, cookie);
      expect(response.statusCode).toBe(testCase.expectedStatus);
      expect(await countSession(cookie)).toBe(testCase.expectedStatus === 200 ? 1 : 0);
      const setCookieHeader = response.headers["set-cookie"]?.toString() ?? "";
      const shouldClearSession = testCase.expectedStatus === 401;
      expect(setCookieHeader.includes("ytw_session=; Path=/")).toBe(shouldClearSession);
      expect(setCookieHeader.includes("Max-Age=0")).toBe(shouldClearSession);
      provider.refreshIdTokenOverrides.delete(profile.username);
    }
  });

  it("clears a malformed session cookie and still starts login", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/auth/login",
      headers: { host: HOST, cookie: "ytw_session=not-a-uuid" },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers["set-cookie"]?.toString()).toContain("ytw_session=; Path=/");
    expect(response.headers["set-cookie"]?.toString()).toContain("Max-Age=0");
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
    provider.userInfoGroups = undefined;
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

async function expectNoIdentity(subject: string): Promise<void> {
  const result = await db.admin.query<{ users: number; sessions: number }>(
    `SELECT
       (SELECT count(*)::int FROM users WHERE oidc_sub = $1) AS users,
       (SELECT count(*)::int
          FROM ytw_private.web_sessions AS sessions
          JOIN users ON users.id = sessions.user_id
         WHERE users.oidc_sub = $1) AS sessions`,
    [subject],
  );
  expect(result.rows[0]).toEqual({ users: 0, sessions: 0 });
}

async function signInDenied(server: FastifyInstance, oidc: MockOidcProvider, code: string) {
  return (await attemptLogin(server, oidc, code)).callback;
}
