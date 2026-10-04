import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from("youtube-workspace/session/v1", "utf8");

/** Server-side data encrypted inside the opaque T14 refresh-token ciphertext field. */
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
