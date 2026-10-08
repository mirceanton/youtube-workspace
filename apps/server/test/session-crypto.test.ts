import { describe, expect, it } from "vitest";
import {
  decryptIdTokenHint,
  decryptLoginTransaction,
  decryptSessionData,
  encryptIdTokenHint,
  encryptLoginTransaction,
  encryptSessionData,
} from "../src/web/session-crypto.js";

const SECRET = "a-session-secret-of-at-least-32-characters";
const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.signature";

describe("the ID token hint", () => {
  it("is stored sealed and opened again with the same secret", () => {
    const stored = encryptIdTokenHint(SECRET, ID_TOKEN);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain("eyJ");
    expect(Buffer.from(stored ?? "", "base64").includes(ID_TOKEN)).toBe(false);
    expect(decryptIdTokenHint(SECRET, stored ?? "")).toBe(ID_TOKEN);
    // Sealed afresh every time.
    expect(encryptIdTokenHint(SECRET, ID_TOKEN)).not.toBe(stored);
  });

  it("cannot be opened with another secret or after damage", () => {
    const stored = encryptIdTokenHint(SECRET, ID_TOKEN) ?? "";
    expect(decryptIdTokenHint("another-session-secret-32-characters!", stored)).toBeNull();
    const damaged = Buffer.from(stored, "base64");
    damaged[damaged.length - 1] = (damaged.at(-1) ?? 0) ^ 1;
    expect(decryptIdTokenHint(SECRET, damaged.toString("base64"))).toBeNull();
    expect(decryptIdTokenHint(SECRET, ID_TOKEN)).toBeNull();
  });

  it("is dropped when it would not fit the database column", () => {
    expect(encryptIdTokenHint(SECRET, "x".repeat(20_000))).toBeNull();
  });
});

describe("session data and the login transaction", () => {
  it("round-trip with the secret and are refused with another", () => {
    const data = {
      version: 1,
      issuer: "https://auth.example.com",
      subject: "alice",
      username: "alice",
      refreshToken: "refresh-token-value",
      accessTokenExpiresAt: 1_900_000_000_000,
      returnTo: "/ideas",
    } as const;
    const sealed = encryptSessionData(SECRET, data);
    expect(decryptSessionData(SECRET, sealed)).toEqual(data);
    expect(sealed.includes("refresh-token-value")).toBe(false);
    expect(() => decryptSessionData("another-session-secret-32-characters!", sealed)).toThrow(
      /authenticate data/,
    );

    const login = {
      version: 1,
      state: "state",
      nonce: "nonce",
      codeVerifier: "verifier",
      expiresAt: Date.now() + 60_000,
      returnTo: "/",
    } as const;
    expect(decryptLoginTransaction(SECRET, encryptLoginTransaction(SECRET, login))).toEqual(login);
    const expired = encryptLoginTransaction(SECRET, { ...login, expiresAt: Date.now() - 1 });
    expect(() => decryptLoginTransaction(SECRET, expired)).toThrow(/invalid OIDC login/);
  });
});
