import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "../src/env.js";
import { generateToken, parseBootstrapPermissions } from "../src/tokens/index.js";

const DATABASE_URL = "postgres://app:s3cret-password@localhost:5432/app";
const OIDC = {
  OIDC_ISSUER_URL: "https://auth.example.com",
  OIDC_CLIENT_ID: "workspace",
  OIDC_CLIENT_SECRET: "client-secret-value",
  OIDC_REDIRECT_URI: "https://workspace.example.com/auth/callback",
  SESSION_SECRET: "x".repeat(32),
};

/** The message of the EnvError that loading `source` throws. */
function failure(source: Record<string, string>): string {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvError) return error.message;
    throw error;
  }
  throw new Error("expected loadEnv to throw");
}

describe("loadEnv", () => {
  it("needs only DATABASE_URL and defaults to single-user mode without a seeded token", () => {
    expect(loadEnv({ DATABASE_URL })).toMatchObject({
      databaseUrl: DATABASE_URL,
      host: "0.0.0.0",
      port: 3000,
      logLevel: "info",
      appVersion: "0.0.0-dev",
      gitSha: "unknown",
      oidc: null,
      bootstrapToken: null,
    });
  });

  it("counts an empty value as unset", () => {
    const env = loadEnv({
      DATABASE_URL,
      PORT: "",
      LOG_LEVEL: "",
      OIDC_ISSUER_URL: "",
      MCP_BOOTSTRAP_TOKEN: "",
      MCP_BOOTSTRAP_TOKEN_PERMISSIONS: "",
    });
    expect(env).toMatchObject({ port: 3000, oidc: null, bootstrapToken: null });
  });

  it("lists every bad variable and never repeats a value", () => {
    const message = failure({
      DATABASE_URL: "not a url",
      PORT: "99999",
      LOG_LEVEL: "loud",
      METRICS_TOKEN: "short",
      MCP_BOOTSTRAP_TOKEN: "ytw_looks-like-a-secret-but-is-too-short",
    });
    for (const name of [
      "DATABASE_URL",
      "PORT",
      "LOG_LEVEL",
      "METRICS_TOKEN",
      "MCP_BOOTSTRAP_TOKEN",
    ]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain("looks-like-a-secret");
    expect(failure({})).toContain("DATABASE_URL");
  });

  it("takes OIDC all or none, with SESSION_SECRET", () => {
    expect(loadEnv({ DATABASE_URL, ...OIDC }).oidc).toMatchObject({
      issuerUrl: OIDC.OIDC_ISSUER_URL,
      groupsClaimPath: "groups",
      requiredGroup: undefined,
      idleTimeoutSeconds: 28_800,
      absoluteTimeoutSeconds: 604_800,
    });

    const { OIDC_CLIENT_SECRET: _secret, SESSION_SECRET: _session, ...partial } = OIDC;
    const message = failure({ DATABASE_URL, ...partial });
    expect(message).toContain("OIDC_CLIENT_SECRET");
    expect(message).toContain("SESSION_SECRET");
    expect(failure({ DATABASE_URL, OIDC_REQUIRED_GROUP: "family" })).toContain("OIDC_ISSUER_URL");
    expect(failure({ DATABASE_URL, ...OIDC, SESSION_SECRET: "too short" })).toContain(
      "SESSION_SECRET",
    );
  });

  it("requires HTTPS for the identity provider except on localhost", () => {
    const local = { OIDC_ISSUER_URL: "http://localhost:8080/realms/x" };
    const redirect = { OIDC_REDIRECT_URI: "http://127.0.0.1:5173/auth/callback" };
    expect(loadEnv({ DATABASE_URL, ...OIDC, ...local, ...redirect }).oidc).not.toBeNull();
    const message = failure({ DATABASE_URL, ...OIDC, OIDC_ISSUER_URL: "http://auth.example.com" });
    expect(message).toContain("OIDC_ISSUER_URL: use HTTPS outside localhost");
  });

  it("reads the seeded token with its name and permissions", () => {
    const { secret } = generateToken();
    expect(loadEnv({ DATABASE_URL, MCP_BOOTSTRAP_TOKEN: secret }).bootstrapToken).toEqual({
      secret,
      name: "bootstrap",
      permissions: {
        ideas: "write",
        scripts: "write",
        experiments: "write",
        videos: "write",
        notes: "write",
        activity: "read",
      },
    });
    const custom = loadEnv({
      DATABASE_URL,
      MCP_BOOTSTRAP_TOKEN: secret,
      MCP_BOOTSTRAP_TOKEN_NAME: "gateway",
      MCP_BOOTSTRAP_TOKEN_PERMISSIONS: " ideas = read , notes=none",
    });
    expect(custom.bootstrapToken).toMatchObject({
      name: "gateway",
      permissions: { ideas: "read", notes: "none" },
    });
    expect(failure({ DATABASE_URL, MCP_BOOTSTRAP_TOKEN: `${secret}x` })).toContain(
      "MCP_BOOTSTRAP_TOKEN",
    );
  });
});

describe("parseBootstrapPermissions", () => {
  it.each([
    ["ideas=admin", "can be"],
    ["widgets=read", "unknown resource"],
    ["ideas=read,ideas=write", "repeats ideas"],
    ["activity=write", "activity can be none, read"],
    ["ideas", "resource=level"],
    ["ideas=read,,notes=read", "entry 2"],
    ["ideas=write=1", "resource=level"],
  ])("refuses %s", (text, reason) => {
    const parsed = parseBootstrapPermissions(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.problems.join("\n")).toContain(reason);
  });

  it("does not repeat what it was given", () => {
    const { secret } = generateToken();
    const parsed = parseBootstrapPermissions(secret);
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });
});
