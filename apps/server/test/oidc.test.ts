import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { OidcConfig } from "../src/env.js";
import { OidcClient } from "../src/web/oidc.js";

const ISSUER = "https://auth.example.com/realms/ytw";
const CLIENT_ID = "youtube-workspace";

const config: OidcConfig = {
  issuerUrl: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: "client-secret",
  redirectUri: "https://youtube-workspace.example.com/auth/callback",
  groupsClaimPath: "groups",
  requiredGroup: undefined,
  sessionSecret: "a-session-secret-of-at-least-32-characters",
  idleTimeoutSeconds: 28_800,
  absoluteTimeoutSeconds: 604_800,
};

let privateKey: CryptoKey;
let client: OidcClient;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/** An identity provider that lives in the test: discovery and the signing keys, nothing else. */
function providerFetch(jwks: { keys: JWK[] }): typeof fetch {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
      });
    }
    if (url.pathname.endsWith("/certs")) return json(jwks);
    return new Response("not found", { status: 404 });
  };
}

function accessToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT({ typ: "Bearer", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setSubject("alice")
    .setExpirationTime("5m")
    .sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  client = new OidcClient(config, providerFetch({ keys: [jwk] }));
});

describe("validating the access token", () => {
  it("accepts the token Keycloak issues: audience `account`, the client in `azp`", async () => {
    const token = await accessToken({ aud: "account", azp: CLIENT_ID });
    const expiry = await client.validateAccessToken(token, "alice");
    expect(expiry).toBeGreaterThan(Date.now());
  });

  it("accepts a token whose audience is the client", async () => {
    const token = await accessToken({ aud: CLIENT_ID });
    await expect(client.validateAccessToken(token, "alice")).resolves.toBeGreaterThan(Date.now());
  });

  it("accepts an RFC 9068 token that names the client in `client_id`", async () => {
    const token = await accessToken({ aud: "https://api.example.com", client_id: CLIENT_ID });
    await expect(client.validateAccessToken(token, "alice")).resolves.toBeGreaterThan(Date.now());
  });

  it("refuses a token issued to another client", async () => {
    const token = await accessToken({ aud: "account", azp: "another-client" });
    await expect(client.validateAccessToken(token, "alice")).rejects.toThrow(/client/);
  });

  it("refuses a token for another subject", async () => {
    const token = await accessToken({ aud: "account", azp: CLIENT_ID });
    await expect(client.validateAccessToken(token, "mallory")).rejects.toThrow(/subject/);
  });
});
