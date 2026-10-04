import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "../src/env.js";

const required = {
  DATABASE_URL: "postgres://ytw_web:ytw-web-dev-password@localhost:5432/youtube_workspace",
  OIDC_ISSUER_URL: "http://localhost:8080/realms/youtube-workspace",
  OIDC_CLIENT_ID: "youtube-workspace",
  OIDC_CLIENT_SECRET: "dev-only-secret",
  OIDC_REDIRECT_URI: "http://localhost:3000/auth/callback",
  OIDC_GROUPS_CLAIM_PATH: "groups",
  OIDC_REQUIRED_GROUP: "youtube-workspace-users",
  SESSION_SECRET: "a-dev-only-session-secret-with-32-or-more-characters",
};

describe("web-server env", () => {
  it("applies defaults when nothing is set", () => {
    expect(loadEnv(required)).toEqual({
      HOST: "0.0.0.0",
      PORT: 3000,
      LOG_LEVEL: "info",
      APP_VERSION: "0.0.0-dev",
      GIT_SHA: "unknown",
      ...required,
      SESSION_IDLE_TIMEOUT: 28_800,
      SESSION_ABSOLUTE_TIMEOUT: 604_800,
    });
  });

  it("treats empty values as unset", () => {
    expect(loadEnv({ ...required, PORT: "", LOG_LEVEL: "" })).toMatchObject({
      PORT: 3000,
      LOG_LEVEL: "info",
    });
  });

  it("coerces PORT and keeps explicit values", () => {
    expect(loadEnv({ ...required, PORT: "8080", LOG_LEVEL: "debug" })).toMatchObject({
      PORT: 8080,
      LOG_LEVEL: "debug",
    });
  });

  it("fails fast with a message naming every bad variable", () => {
    let error: unknown;
    try {
      loadEnv({ ...required, PORT: "eighty", LOG_LEVEL: "loud" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(EnvError);
    const message = (error as EnvError).message;
    expect(message).toContain("Invalid environment for web-server");
    expect(message).toContain("PORT");
    expect(message).toContain("LOG_LEVEL");
  });

  it("rejects out-of-range ports", () => {
    expect(() => loadEnv({ ...required, PORT: "70000" })).toThrow(EnvError);
  });

  it("rejects weak session secrets and insecure remote OIDC URLs", () => {
    expect(() => loadEnv({ ...required, SESSION_SECRET: "short" })).toThrow(EnvError);
    expect(() =>
      loadEnv({ ...required, OIDC_ISSUER_URL: "http://identity.example.com/realm" }),
    ).toThrow(/OIDC_ISSUER_URL: use HTTPS outside localhost/);
  });
});
