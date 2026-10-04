import * as oidc from "openid-client";
import type { Env } from "../env.js";

/** openid-client adapter; the optional Fetch implementation keeps provider tests in-process. */
export class OidcClient {
  private configuration: Promise<oidc.Configuration> | undefined;

  constructor(
    private readonly env: Env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private getConfiguration(): Promise<oidc.Configuration> {
    this.configuration ??= this.discover();
    return this.configuration;
  }

  private async discover(): Promise<oidc.Configuration> {
    const issuer = new URL(this.env.OIDC_ISSUER_URL);
    const options: oidc.DiscoveryRequestOptions = {
      [oidc.customFetch]: this.fetcher,
      ...(issuer.protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : {}),
    };
    return oidc.discovery(
      issuer,
      this.env.OIDC_CLIENT_ID,
      this.env.OIDC_CLIENT_SECRET,
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

  async endSessionUrl(idTokenHint: string | null): Promise<URL | undefined> {
    const configuration = await this.getConfiguration();
    const endSessionEndpoint = configuration.serverMetadata().end_session_endpoint;
    if (!endSessionEndpoint) return undefined;
    return oidc.buildEndSessionUrl(configuration, {
      post_logout_redirect_uri: new URL("/", this.env.OIDC_REDIRECT_URI).href,
      ...(idTokenHint === null ? {} : { id_token_hint: idTokenHint }),
    });
  }
}

export type OidcFetch = typeof fetch;
