import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FailureLimiter,
  generateToken,
  hashToken,
  isTokenShaped,
  parseBearer,
  secretMatchesHash,
} from "../src/tokens/index.js";

describe("token secrets", () => {
  it("are ytw_ plus 43 base64url characters, stored as a SHA-256 and a short prefix", () => {
    const token = generateToken();
    expect(token.secret).toMatch(/^ytw_[A-Za-z0-9_-]{43}$/);
    expect(isTokenShaped(token.secret)).toBe(true);
    expect(token.prefix).toBe(token.secret.slice(0, 12));
    expect(token.hash).toBe(createHash("sha256").update(token.secret).digest("hex"));
    expect(hashToken(token.secret)).toBe(token.hash);
    expect(generateToken().secret).not.toBe(token.secret);
  });

  it("match their own hash only", () => {
    const token = generateToken();
    expect(secretMatchesHash(token.secret, token.hash)).toBe(true);
    expect(secretMatchesHash(generateToken().secret, token.hash)).toBe(false);
    expect(secretMatchesHash(token.secret, "short")).toBe(false);
  });
});

describe("parseBearer", () => {
  const { secret } = generateToken();

  it("reads one well-formed bearer token, whatever the case of the scheme", () => {
    expect(parseBearer(`Bearer ${secret}`)).toEqual({ ok: true, secret });
    expect(parseBearer(`bEaReR ${secret}`)).toEqual({ ok: true, secret });
  });

  it("tells a missing header from a malformed one", () => {
    for (const header of [undefined, "", "  ", []]) {
      expect(parseBearer(header)).toEqual({ ok: false, reason: "missing" });
    }
    for (const header of [
      secret,
      `Basic ${secret}`,
      `Bearer  ${secret}`,
      `Bearer ${secret}x`,
      "Bearer ytw_short",
      [`Bearer ${secret}`, `Bearer ${secret}`],
      `Bearer ${secret}${"a".repeat(600)}`,
    ]) {
      expect(parseBearer(header)).toEqual({ ok: false, reason: "malformed" });
    }
  });
});

describe("FailureLimiter", () => {
  it("blocks a key after its failures, says how long to wait, and forgives after the window", () => {
    let now = 0;
    const limiter = new FailureLimiter({ maxFailures: 2, windowMs: 60_000, now: () => now });
    limiter.recordFailure(["client:a"]);
    expect(limiter.check(["client:a"])).toEqual({ allowed: true });
    limiter.recordFailure(["client:a"]);
    expect(limiter.check(["client:a"])).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.check(["client:b"])).toEqual({ allowed: true });

    now = 45_500;
    expect(limiter.check(["client:a", "client:b"])).toEqual({
      allowed: false,
      retryAfterSeconds: 15,
    });
    now = 60_000;
    expect(limiter.check(["client:a"])).toEqual({ allowed: true });
  });

  it("tracks a bounded number of keys", () => {
    const limiter = new FailureLimiter({ maxKeys: 3 });
    for (let index = 0; index < 10; index += 1) limiter.recordFailure([`prefix:${index}`]);
    expect(limiter.size).toBe(3);
  });
});
