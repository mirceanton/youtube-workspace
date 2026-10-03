/** Reading the `Authorization: Bearer <token>` header. Never echoes the header's content. */
import { isTokenShaped } from "./secret.js";

/** Longer headers are refused unread: no token is anywhere near this long. */
export const MAX_AUTHORIZATION_HEADER_LENGTH = 512;

export type BearerParse =
  | { readonly ok: true; readonly secret: string }
  | { readonly ok: false; readonly reason: "missing" | "malformed" };

/**
 * `missing`: no header (or an empty one). `malformed`: anything that is not exactly
 * `Bearer ytw_<43 characters>` (the scheme is case-insensitive, one space), more than one header
 * value included. A well-formed token that does not exist is the authenticator's business.
 */
export function parseBearer(header: string | readonly string[] | undefined): BearerParse {
  if (header === undefined) {
    return { ok: false, reason: "missing" };
  }
  if (typeof header !== "string") {
    return { ok: false, reason: header.length === 0 ? "missing" : "malformed" };
  }
  if (header.trim() === "") {
    return { ok: false, reason: "missing" };
  }
  if (header.length > MAX_AUTHORIZATION_HEADER_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const space = header.indexOf(" ");
  if (space === -1 || header.slice(0, space).toLowerCase() !== "bearer") {
    return { ok: false, reason: "malformed" };
  }
  const secret = header.slice(space + 1);
  return isTokenShaped(secret) ? { ok: true, secret } : { ok: false, reason: "malformed" };
}
