import * as oidc from "openid-client";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import type { OidcConfig } from "../env.js";

const ACCESS_TOKEN_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;

/** openid-client adapter; the optional Fetch implementation keeps provider tests in-process. */
export class OidcClient {
  private configuration: Promise<oidc.Configuration> | undefined;

  constructor(
    private readonly config: OidcConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private getConfiguration(): Promise<oidc.Configuration> {
    if (this.configuration === undefined) {
      const pending = this.discover().catch((error: unknown) => {
        if (this.configuration === pending) this.configuration = undefined;
        throw error;
      });
      this.configuration = pending;
    }
    return this.configuration;
  }

  private async discover(): Promise<oidc.Configuration> {
    const issuer = new URL(this.config.issuerUrl);
    const execute = [oidc.enableNonRepudiationChecks];
    if (issuer.protocol === "http:") execute.unshift(oidc.allowInsecureRequests);
    const options: oidc.DiscoveryRequestOptions = {
      [oidc.customFetch]: this.fetcher,
      execute,
    };
    return oidc.discovery(
      issuer,
      this.config.clientId,
      this.config.clientSecret,
      undefined,
      options,
    );
  }

  async authorizationUrl(parameters: Record<string, string>): Promise<URL> {
    return oidc.buildAuthorizationUrl(await this.getConfiguration(), parameters);
  }

  async authorizationCodeGrant(
    callbackUrl: URL,
    checks: oidc.AuthorizationCodeGrantChecks,
  ): Promise<oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers> {
    return oidc.authorizationCodeGrant(await this.getConfiguration(), callbackUrl, checks);
  }

  async refreshTokenGrant(
    refreshToken: string,
  ): Promise<oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers> {
    return oidc.refreshTokenGrant(await this.getConfiguration(), refreshToken);
  }

  async fetchUserInfo(accessToken: string, subject: string): Promise<oidc.UserInfoResponse> {
    return oidc.fetchUserInfo(await this.getConfiguration(), accessToken, subject);
  }

  /** Validate the signed JWT access token before sending it to the UserInfo endpoint. */
  async validateAccessToken(accessToken: string, expectedSubject: string): Promise<number> {
    const configuration = await this.getConfiguration();
    const metadata = configuration.serverMetadata();
    if (typeof metadata.jwks_uri !== "string" || metadata.jwks_uri.length === 0) {
      throw new Error("OIDC issuer metadata has no JWKS endpoint");
    }

    const response = await this.fetcher(metadata.jwks_uri, {
      headers: { accept: "application/jwk-set+json, application/json" },
    });
    if (!response.ok) throw new Error("OIDC JWKS request failed");
    const document: unknown = await response.json();
    if (
      typeof document !== "object" ||
      document === null ||
      !Array.isArray((document as { keys?: unknown }).keys) ||
      (document as { keys: unknown[] }).keys.length === 0
    ) {
      throw new Error("OIDC JWKS response is invalid");
    }

    // No `audience` option: the audience of an access token is the resource it is for, which the
    // provider picks (Keycloak says `account`), not necessarily this client.
    const { payload } = await jwtVerify(accessToken, createLocalJWKSet(document as JSONWebKeySet), {
      issuer: metadata.issuer,
      algorithms: [...ACCESS_TOKEN_ALGORITHMS],
    });
    if (!this.issuedToClient(payload)) {
      throw new Error("OIDC access token was not issued to this client");
    }
    if (payload.sub !== expectedSubject) throw new Error("OIDC access token subject mismatch");
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      throw new Error("OIDC access token has no valid expiry");
    }
    return payload.exp * 1000;
  }

  /** The client a token was issued to: `azp` (Keycloak), `client_id` (RFC 9068) or the audience. */
  private issuedToClient(payload: JWTPayload): boolean {
    const clientId = this.config.clientId;
    const audience = payload.aud;
    return (
      payload.azp === clientId ||
      payload.client_id === clientId ||
      audience === clientId ||
      (Array.isArray(audience) && audience.includes(clientId))
    );
  }

  async endSessionUrl(idTokenHint: string | null): Promise<URL | undefined> {
    const configuration = await this.getConfiguration();
    const endSessionEndpoint = configuration.serverMetadata().end_session_endpoint;
    if (!endSessionEndpoint) return undefined;
    return oidc.buildEndSessionUrl(configuration, {
      post_logout_redirect_uri: new URL("/", this.config.redirectUri).href,
      ...(idTokenHint === null ? {} : { id_token_hint: idTokenHint }),
    });
  }
}

export type OidcFetch = typeof fetch;
