/**
 * Guards for arguments that could not even reach a database function: a malformed UUID, a number
 * that is not a whole 32-bit integer, text with a NUL character. Postgres answers those with a
 * bare driver error (SQLSTATE 22P02, 22021, ...) that no caller can act on; these throw a
 * {@link ValidationError} that says which argument is wrong and what is valid. Used by the typed
 * wrappers only (not exported from the package index): the domain rules stay in the database
 * functions.
 */
import { ValidationError } from "./errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shortens and JSON-quotes a caller's value for a message. */
function show(value: string): string {
  return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}...` : value);
}

export function requireUuid(field: string, value: string): void {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ValidationError(
      `${field} must be a UUID such as 0190f3a2-7c1e-7b52-9d0e-3f4a5b6c7d8e (got ${
        typeof value === "string" ? show(value) : typeof value
      })`,
      { field },
    );
  }
}

/**
 * A whole number that fits a Postgres `integer`. Ranges such as "0 to 100" are the database
 * function's to check, with its own message.
 */
export function requireInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new ValidationError(
      `${field} must be a whole number between -2147483648 and 2147483647 (got ${String(value)})`,
      { field },
    );
  }
}

/** Text cannot contain U+0000 in Postgres (and JSON text with \u0000 is refused too). */
export function rejectNul(field: string, value: string | null | undefined): void {
  if (typeof value === "string" && value.includes("\u0000")) {
    throw new ValidationError(
      `${field} contains a NUL character (U+0000), which cannot be stored: remove it`,
      { field },
    );
  }
}
