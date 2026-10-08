/**
 * Generating and hashing API token secrets. A secret is `ytw_` plus 32 random bytes as
 * base64url; the database stores only its SHA-256 (64 lower-case hex digits) and a short prefix that
 * lets people tell tokens apart. The secret itself is shown once, at creation or rotation.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_PREFIX_LITERAL = "ytw_";
/** Characters of the secret kept as the display prefix (`ytw_` and 8 more; the database allows 16). */
export const TOKEN_DISPLAY_PREFIX_LENGTH = 12;
const SECRET_BYTES = 32;
/** `ytw_` + base64url of 32 bytes (43 characters, no padding). */
export const TOKEN_LENGTH = TOKEN_PREFIX_LITERAL.length + 43;
const TOKEN_SHAPE = /^ytw_[A-Za-z0-9_-]{43}$/;

/** A freshly generated token: show `secret` once, store `prefix` and `hash`. */
export interface GeneratedToken {
  readonly secret: string;
  readonly prefix: string;
  readonly hash: string;
}

/** Whether `value` has the shape of a token this package generates (says nothing about validity). */
export function isTokenShaped(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

/** SHA-256 of a secret as 64 lower-case hex digits: what `api_tokens.token_hash` holds. */
export function hashToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** The display prefix of a secret. */
export function tokenPrefix(secret: string): string {
  return secret.slice(0, TOKEN_DISPLAY_PREFIX_LENGTH);
}

/** Makes a new secret from 32 bytes of the system's CSPRNG. */
export function generateToken(): GeneratedToken {
  const secret = `${TOKEN_PREFIX_LITERAL}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return { secret, prefix: tokenPrefix(secret), hash: hashToken(secret) };
}

/** Constant-time check that `secret` hashes to `expectedHash` (hex). False for any malformed hash. */
export function secretMatchesHash(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(secret), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
