import { describe, expect, it } from "vitest";
import {
  FailureLimiter,
  MAX_AUTHORIZATION_HEADER_LENGTH,
  REDACTED_TOKEN,
  TOKEN_LENGTH,
  generateToken,
  hashToken,
  isTokenShaped,
  parseBearer,
  redactTokens,
  secretMatchesHash,
  tokenPrefix,
} from "../src/index.js";

describe("secrets", () => {
  it("generates ytw_ tokens of fixed shape with a matching prefix and SHA-256 hash", () => {
    const token = generateToken();
    expect(token.secret).toHaveLength(TOKEN_LENGTH);
    expect(isTokenShaped(token.secret)).toBe(true);
    expect(token.prefix).toBe(tokenPrefix(token.secret));
    expect(token.prefix).toMatch(/^ytw_[A-Za-z0-9_-]{8}$/);
    expect(token.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(token.hash).toBe(hashToken(token.secret));
    expect(token.hash).not.toContain(token.secret);
  });

  it("never repeats", () => {
    const secrets = new Set(Array.from({ length: 500 }, () => generateToken().secret));
    expect(secrets.size).toBe(500);
  });

  it("hashes a known value (SHA-256 of 'abc')", () => {
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("compares in constant time and refuses malformed hashes", () => {
    const token = generateToken();
    expect(secretMatchesHash(token.secret, token.hash)).toBe(true);
    expect(secretMatchesHash(`${token.secret}x`, token.hash)).toBe(false);
    expect(secretMatchesHash(token.secret, token.hash.slice(1))).toBe(false);
    expect(secretMatchesHash(token.secret, "")).toBe(false);
  });

  it("recognises only the exact shape", () => {
    const { secret } = generateToken();
    expect(isTokenShaped(secret.slice(1))).toBe(false);
    expect(isTokenShaped(`${secret}A`)).toBe(false);
    expect(isTokenShaped(`xyz_${secret.slice(4)}`)).toBe(false);
    expect(isTokenShaped(`${secret.slice(0, -1)}!`)).toBe(false);
    expect(isTokenShaped(`${secret}\n`)).toBe(false);
  });
});

describe("parseBearer", () => {
  const { secret } = generateToken();

  it("accepts the scheme in any case with one space", () => {
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      expect(parseBearer(`${scheme} ${secret}`)).toEqual({ ok: true, secret });
    }
  });

  it("reports an absent or blank header as missing", () => {
    expect(parseBearer(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(parseBearer("")).toEqual({ ok: false, reason: "missing" });
    expect(parseBearer("   ")).toEqual({ ok: false, reason: "missing" });
    expect(parseBearer([])).toEqual({ ok: false, reason: "missing" });
  });

  it.each([
    ["wrong scheme", `Basic ${secret}`],
    ["no scheme", secret],
    ["two spaces", `Bearer  ${secret}`],
    ["trailing space", `Bearer ${secret} `],
    ["token of the wrong shape", "Bearer ytw_short"],
    ["a non-token credential", "Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc"],
    ["scheme only", "Bearer"],
    ["oversized header", `Bearer ${"a".repeat(MAX_AUTHORIZATION_HEADER_LENGTH)}`],
  ])("reports %s as malformed", (_label, header) => {
    expect(parseBearer(header)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses several header values", () => {
    expect(parseBearer([`Bearer ${secret}`, `Bearer ${secret}`])).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("redactTokens", () => {
  it("removes secrets wherever they appear and leaves other text alone", () => {
    const { secret } = generateToken();
    const text = `header Bearer ${secret} and again ${secret}, but ytw_ alone and ytw_abc stay`;
    const out = redactTokens(text);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(secret.slice(4, 20));
    expect(out).toContain(REDACTED_TOKEN);
    expect(out).toContain("ytw_ alone and ytw_abc stay");
  });
});

function clocked(options: ConstructorParameters<typeof FailureLimiter>[0] = {}) {
  let now = 1_000_000;
  const limiter = new FailureLimiter({ ...options, now: () => now });
  return { limiter, advance: (ms: number) => (now += ms) };
}

describe("FailureLimiter", () => {
  it("allows up to maxFailures, then refuses with the seconds left", () => {
    const { limiter, advance } = clocked({ maxFailures: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check(["a"])).toEqual({ allowed: true });
      limiter.recordFailure(["a"]);
    }
    expect(limiter.check(["a"])).toEqual({ allowed: false, retryAfterSeconds: 60 });
    advance(30_500);
    expect(limiter.check(["a"])).toEqual({ allowed: false, retryAfterSeconds: 30 });
    advance(29_500);
    expect(limiter.check(["a"])).toEqual({ allowed: true });
  });

  it("starts a new window after the old one ended", () => {
    const { limiter, advance } = clocked({ maxFailures: 1, windowMs: 1000 });
    limiter.recordFailure(["a"]);
    expect(limiter.check(["a"]).allowed).toBe(false);
    advance(1000);
    expect(limiter.check(["a"]).allowed).toBe(true);
    limiter.recordFailure(["a"]);
    expect(limiter.check(["a"]).allowed).toBe(false);
  });

  it("keeps keys apart and reports the longest wait of several blocked keys", () => {
    const { limiter, advance } = clocked({ maxFailures: 1, windowMs: 10_000 });
    limiter.recordFailure(["a"]);
    advance(4000);
    limiter.recordFailure(["b"]);
    expect(limiter.check(["c"])).toEqual({ allowed: true });
    expect(limiter.check(["a", "b"])).toEqual({ allowed: false, retryAfterSeconds: 10 });
    expect(limiter.check(["a"])).toEqual({ allowed: false, retryAfterSeconds: 6 });
  });

  it("bounds memory by dropping the oldest keys", () => {
    const { limiter } = clocked({ maxKeys: 3, maxFailures: 1 });
    for (const key of ["a", "b", "c", "d"]) {
      limiter.recordFailure([key]);
    }
    expect(limiter.size).toBe(3);
    expect(limiter.check(["a"]).allowed).toBe(true);
    expect(limiter.check(["d"]).allowed).toBe(false);
  });

  it("uses sane defaults and rejects nonsense options", () => {
    const limiter = new FailureLimiter();
    for (let i = 0; i < 10; i += 1) {
      limiter.recordFailure(["x"]);
    }
    expect(limiter.check(["x"]).allowed).toBe(false);
    expect(() => new FailureLimiter({ maxFailures: 0 })).toThrow(RangeError);
    expect(() => new FailureLimiter({ windowMs: 0 })).toThrow(RangeError);
    expect(() => new FailureLimiter({ maxKeys: 0 })).toThrow(RangeError);
  });
});
