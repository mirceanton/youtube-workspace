import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

const issuer = process.env.MOCK_OIDC_ISSUER ?? "http://127.0.0.1:4100/realms/youtube-workspace";
const clientId = process.env.OIDC_CLIENT_ID ?? "youtube-workspace";
const clientSecret = process.env.OIDC_CLIENT_SECRET ?? "dev-only-secret";
const redirectUri = process.env.OIDC_REDIRECT_URI ?? "http://127.0.0.1:5173/auth/callback";
const adminToken = process.env.E2E_MOCK_ADMIN_TOKEN ?? "ytw-e2e-local-mock-admin";
const accessGroup = "youtube-workspace-users";
const accessTokenLifetime = 8;
const sessionCookie = "ytw_mock_idp_session";
const authorizationCodes = new Map<string, AuthorizationCode>();
const pendingAuthorizations = new Map<string, AuthorizationRequest>();
const refreshTokens = new Map<string, string>();
const accessTokens = new Map<string, string>();

interface Identity {
  username: string;
  password: string;
  subject: string;
  email: string;
  displayName: string;
  groups: Set<string>;
}

interface AuthorizationRequest {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

interface AuthorizationCode extends AuthorizationRequest {
  username: string;
}

const identities = new Map<string, Identity>([
  [
    "owner",
    {
      username: "owner",
      password: "owner-dev-pass",
      subject: "e2e-owner-subject",
      email: "owner@youtube-workspace.test",
      displayName: "Dev Owner",
      groups: new Set([accessGroup]),
    },
  ],
  [
    "collaborator",
    {
      username: "collaborator",
      password: "collaborator-dev-pass",
      subject: "e2e-collaborator-subject",
      email: "collaborator@youtube-workspace.test",
      displayName: "Dev Collaborator",
      groups: new Set([accessGroup]),
    },
  ],
  [
    "outsider",
    {
      username: "outsider",
      password: "outsider-dev-pass",
      subject: "e2e-outsider-subject",
      email: "outsider@youtube-workspace.test",
      displayName: "Dev Outsider",
      groups: new Set(),
    },
  ],
]);

const keyPair = await generateKeyPair("RS256", { modulusLength: 2048 });
const keyId = randomBytes(12).toString("base64url");
const publicKey = (await exportJWK(keyPair.publicKey)) as JWK & { kid: string };
publicKey.kid = keyId;
publicKey.use = "sig";
publicKey.alg = "RS256";
publicKey.key_ops = ["verify"];

function json(reply: ServerResponse, status: number, value: unknown): void {
  reply.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  reply.end(JSON.stringify(value));
}

function html(reply: ServerResponse, status: number, content: string): void {
  reply.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  reply.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign in</title>${content}</html>`,
  );
}

function cookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string") return undefined;
  const prefix = `${name}=`;
  return header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

async function rawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.byteLength;
    if (size > 16_384) throw new Error("form too large");
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

async function formBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams((await rawBody(request)).toString("utf8"));
}

function authenticatedClient(request: IncomingMessage, form: URLSearchParams): boolean {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return (
      separator >= 0 &&
      decoded.slice(0, separator) === clientId &&
      decoded.slice(separator + 1) === clientSecret
    );
  }
  return form.get("client_id") === clientId && form.get("client_secret") === clientSecret;
}

function issueCode(reply: ServerResponse, request: AuthorizationRequest, identity: Identity): void {
  const code = randomBytes(24).toString("base64url");
  authorizationCodes.set(code, { ...request, username: identity.username });
  const callback = new URL(request.redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", request.state);
  reply.writeHead(302, { location: callback.href });
  reply.end();
}

async function signedToken(identity: Identity, expiresIn: number, nonce?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    preferred_username: identity.username,
    name: identity.displayName,
    email: identity.email,
    groups: [...identity.groups],
    ...(nonce === undefined ? {} : { nonce }),
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keyId, typ: "JWT" })
    .setIssuer(issuer)
    .setSubject(identity.subject)
    .setAudience(clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .sign(keyPair.privateKey);
}

async function tokenResponse(identity: Identity, nonce?: string): Promise<Record<string, unknown>> {
  const refreshToken = randomBytes(32).toString("base64url");
  refreshTokens.set(refreshToken, identity.username);
  const accessToken = await signedToken(identity, accessTokenLifetime);
  accessTokens.set(accessToken, identity.username);
  return {
    access_token: accessToken,
    id_token: await signedToken(identity, accessTokenLifetime, nonce),
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: accessTokenLifetime,
    scope: "openid profile email",
  };
}

async function handleAuthorization(request: IncomingMessage, reply: ServerResponse, url: URL) {
  const params = url.searchParams;
  const requestedRedirectUri = params.get("redirect_uri");
  const state = params.get("state");
  const nonce = params.get("nonce");
  const codeChallenge = params.get("code_challenge");
  if (
    params.get("client_id") !== clientId ||
    params.get("response_type") !== "code" ||
    requestedRedirectUri !== redirectUri ||
    state === null ||
    nonce === null ||
    codeChallenge === null ||
    params.get("code_challenge_method") !== "S256"
  ) {
    return html(reply, 400, "<h1>Invalid sign-in request</h1>");
  }

  const authorization: AuthorizationRequest = {
    redirectUri: requestedRedirectUri,
    state,
    nonce,
    codeChallenge,
  };
  const userSession = cookie(request, sessionCookie);
  const signedInUser = userSession ? identities.get(userSession) : undefined;
  if (signedInUser !== undefined) {
    issueCode(reply, authorization, signedInUser);
    return;
  }

  const authorizationId = randomBytes(16).toString("base64url");
  pendingAuthorizations.set(authorizationId, authorization);
  return html(
    reply,
    200,
    `<main><h1>Sign in</h1><form method="post" action="/login"><input type="hidden" name="authorization_id" value="${authorizationId}"><label for="username">Username or email</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button></form></main>`,
  );
}

async function handleToken(request: IncomingMessage, reply: ServerResponse) {
  const form = await formBody(request);
  if (!authenticatedClient(request, form)) return json(reply, 401, { error: "invalid_client" });

  if (form.get("grant_type") === "authorization_code") {
    const code = form.get("code");
    const codeVerifier = form.get("code_verifier");
    const grant = code === null ? undefined : authorizationCodes.get(code);
    if (code !== null) authorizationCodes.delete(code);
    const actualChallenge =
      codeVerifier === null ? "" : createHash("sha256").update(codeVerifier).digest("base64url");
    if (
      grant === undefined ||
      grant.redirectUri !== form.get("redirect_uri") ||
      actualChallenge !== grant.codeChallenge
    ) {
      return json(reply, 400, { error: "invalid_grant" });
    }
    const identity = identities.get(grant.username);
    if (identity === undefined) return json(reply, 400, { error: "invalid_grant" });
    return json(reply, 200, await tokenResponse(identity, grant.nonce));
  }

  if (form.get("grant_type") === "refresh_token") {
    const refreshToken = form.get("refresh_token");
    const username = refreshToken === null ? undefined : refreshTokens.get(refreshToken);
    const identity = username === undefined ? undefined : identities.get(username);
    if (identity === undefined) return json(reply, 400, { error: "invalid_grant" });
    return json(reply, 200, await tokenResponse(identity));
  }

  return json(reply, 400, { error: "unsupported_grant_type" });
}

async function handleRequest(request: IncomingMessage, reply: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:4100");
  const realmPath = new URL(issuer).pathname;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/healthz") {
    return json(reply, 200, { ok: true });
  }
  if (method === "GET" && url.pathname === `${realmPath}/.well-known/openid-configuration`) {
    return json(reply, 200, {
      issuer,
      authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
      token_endpoint: `${issuer}/protocol/openid-connect/token`,
      userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
      jwks_uri: `${issuer}/protocol/openid-connect/certs`,
      end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (method === "GET" && url.pathname === `${realmPath}/protocol/openid-connect/certs`) {
    return json(reply, 200, { keys: [publicKey] });
  }
  if (method === "GET" && url.pathname === `${realmPath}/protocol/openid-connect/auth`) {
    return handleAuthorization(request, reply, url);
  }
  if (method === "POST" && url.pathname === "/login") {
    const form = await formBody(request);
    const authorizationId = form.get("authorization_id");
    const authorization =
      authorizationId === null ? undefined : pendingAuthorizations.get(authorizationId);
    const identity = identities.get(form.get("username") ?? "");
    if (authorizationId !== null) pendingAuthorizations.delete(authorizationId);
    if (
      authorization === undefined ||
      identity === undefined ||
      identity.password !== form.get("password")
    ) {
      return html(
        reply,
        401,
        '<main><h1>Sign in</h1><p role="alert">Invalid credentials</p></main>',
      );
    }
    reply.setHeader(
      "set-cookie",
      `${sessionCookie}=${identity.username}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
    );
    return issueCode(reply, authorization, identity);
  }
  if (method === "POST" && url.pathname === `${realmPath}/protocol/openid-connect/token`) {
    return handleToken(request, reply);
  }
  if (method === "GET" && url.pathname === `${realmPath}/protocol/openid-connect/userinfo`) {
    const authorization = request.headers.authorization;
    const token =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : undefined;
    const username = token === undefined ? undefined : accessTokens.get(token);
    const identity = username === undefined ? undefined : identities.get(username);
    if (identity === undefined) return json(reply, 401, { error: "invalid_token" });
    return json(reply, 200, {
      sub: identity.subject,
      preferred_username: identity.username,
      name: identity.displayName,
      email: identity.email,
      groups: [...identity.groups],
    });
  }
  if (method === "GET" && url.pathname === `${realmPath}/protocol/openid-connect/logout`) {
    const redirect = url.searchParams.get("post_logout_redirect_uri");
    if (redirect === null || new URL(redirect).origin !== new URL(redirectUri).origin) {
      return json(reply, 400, { error: "invalid_request" });
    }
    reply.setHeader("set-cookie", `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    reply.writeHead(302, { location: redirect });
    reply.end();
    return;
  }
  if (
    url.pathname.startsWith("/_e2e/") &&
    request.headers.authorization === `Bearer ${adminToken}`
  ) {
    const match = /^\/_e2e\/users\/([^/]+)\/groups(?:\/([^/]+))?$/.exec(url.pathname);
    if (match === null) return json(reply, 404, { error: "not_found" });
    const identity = identities.get(decodeURIComponent(match[1] ?? ""));
    if (identity === undefined) return json(reply, 404, { error: "not_found" });
    if (method === "DELETE" && match[2] !== undefined) {
      identity.groups.delete(decodeURIComponent(match[2]));
      reply.writeHead(204).end();
      return;
    }
    if (method === "PUT" && match[2] === undefined) {
      const parsed: unknown = JSON.parse((await rawBody(request)).toString("utf8"));
      const groups =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { groups?: unknown }).groups
          : undefined;
      if (!Array.isArray(groups) || groups.some((group) => typeof group !== "string")) {
        return json(reply, 400, { error: "invalid_groups" });
      }
      identity.groups = new Set(groups);
      return json(reply, 200, { ok: true });
    }
  }
  if (method === "POST" && url.pathname === `${realmPath}/protocol/openid-connect/token`) {
    return json(reply, 405, { error: "method_not_allowed" });
  }
  return json(reply, 404, { error: "not_found" });
}

const configuredPort = Number(process.env.MOCK_OIDC_PORT ?? 4100);
if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
  throw new Error("MOCK_OIDC_PORT must be a valid port number");
}

const server = createServer((request, reply) => {
  void handleRequest(request, reply).catch(() => {
    if (!reply.headersSent) json(reply, 500, { error: "mock_provider_error" });
    else reply.destroy();
  });
});

server.listen(configuredPort, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
