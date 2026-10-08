import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from("youtube-workspace/session/v1", "utf8");

/** Server-side data encrypted inside the opaque refresh-token ciphertext field of a session. */
export interface SessionSecretData {
  version: 1;
  issuer: string;
  subject: string;
  username: string;
  /** Absent only for sessions encrypted before nonce retention was added. */
  nonce?: string;
  refreshToken: string | null;
  accessTokenExpiresAt: number;
  returnTo: string;
}

/** One-time Authorization Code transaction; never trusted until AES-GCM authentication succeeds. */
export interface LoginTransaction {
  version: 1;
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
  returnTo: string;
}

function keyFromSecret(secret: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), AAD, Buffer.from("aes-256-gcm"), 32),
  );
}

function seal<T>(secret: string, value: T): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function open<T>(secret: string, ciphertext: Uint8Array): T {
  const input = Buffer.from(ciphertext);
  if (input.length <= IV_BYTES + TAG_BYTES) throw new Error("invalid encrypted session data");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFromSecret(secret),
    input.subarray(0, IV_BYTES),
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(input.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  const plaintext = Buffer.concat([
    decipher.update(input.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/**
 * Longest text the database accepts for `id_token_hint` (a column of 16384 characters). A sealed
 * ID token that does not fit is dropped: sign-out then simply goes without the hint.
 */
const ID_TOKEN_HINT_MAX_CHARS = 16_384;

/**
 * The ID token is kept to hint the identity provider at sign-out. It is a credential for that
 * provider, and the database is readable by `query_sql`, so it is stored sealed with the same key
 * as the refresh token (as base64 text in the existing column).
 */
export function encryptIdTokenHint(secret: string, idToken: string): string | null {
  const sealed = seal(secret, idToken).toString("base64");
  return sealed.length <= ID_TOKEN_HINT_MAX_CHARS ? sealed : null;
}

/** The ID token behind a stored hint, or null when it cannot be opened (wrong key, damaged). */
export function decryptIdTokenHint(secret: string, stored: string): string | null {
  try {
    const idToken = open<unknown>(secret, Buffer.from(stored, "base64"));
    return typeof idToken === "string" ? idToken : null;
  } catch {
    return null;
  }
}

export function encryptSessionData(secret: string, value: SessionSecretData): Buffer {
  return seal(secret, value);
}

export function decryptSessionData(secret: string, value: Uint8Array): SessionSecretData {
  const data = open<SessionSecretData>(secret, value);
  if (
    data.version !== 1 ||
    typeof data.issuer !== "string" ||
    typeof data.subject !== "string" ||
    typeof data.username !== "string" ||
    (data.nonce !== undefined && typeof data.nonce !== "string") ||
    (data.refreshToken !== null && typeof data.refreshToken !== "string") ||
    !Number.isSafeInteger(data.accessTokenExpiresAt) ||
    typeof data.returnTo !== "string"
  ) {
    throw new Error("invalid encrypted session data");
  }
  return data;
}

export function encryptLoginTransaction(secret: string, value: LoginTransaction): string {
  return seal(secret, value).toString("base64url");
}

export function decryptLoginTransaction(secret: string, value: string): LoginTransaction {
  const data = open<LoginTransaction>(secret, Buffer.from(value, "base64url"));
  if (
    data.version !== 1 ||
    typeof data.state !== "string" ||
    typeof data.nonce !== "string" ||
    typeof data.codeVerifier !== "string" ||
    !Number.isSafeInteger(data.expiresAt) ||
    typeof data.returnTo !== "string" ||
    data.expiresAt < Date.now()
  ) {
    throw new Error("invalid OIDC login transaction");
  }
  return data;
}
