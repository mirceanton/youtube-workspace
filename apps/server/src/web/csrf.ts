import { createHmac, timingSafeEqual } from "node:crypto";

/** Request header that carries the CSRF token (Node lower-cases header names). */
export const CSRF_HEADER = "x-csrf-token";

/** The token for a session: a keyed hash of its id, so it needs no storage of its own. */
export function csrfToken(secret: string, sessionId: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionId}`).digest("base64url");
}

export function sameToken(expected: string, supplied: string | undefined): boolean {
  if (supplied === undefined) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}
