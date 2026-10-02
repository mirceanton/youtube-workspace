/**
 * Guards for the numbers and times that the video, metric and experiment wrappers (T13) hand to the
 * database. Like args.ts, used by the typed wrappers only (not exported from the package index): they
 * refuse what could not reach the database intact (NaN and infinity, which `JSON.stringify` would
 * silently turn into null, a Date that is not a time, a time without a time zone) with a
 * {@link ValidationError} that names the argument. The ranges stay the database function's to check.
 */
import { ValidationError } from "./errors.js";

/**
 * A decimal number: a JavaScript number, a string for an exact value beyond what a double holds
 * (`"9007199254740993"`, `"4.52"`; the database returns numerics as strings, so they can be passed
 * back as they are), or a bigint.
 */
export type DecimalInput = number | string | bigint;

/** Shortens and JSON-quotes a caller's value for a message. */
function show(value: string): string {
  return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}...` : value);
}

/**
 * The value as a JSON number or string: finite numbers stay numbers, bigints and strings become
 * strings (the database accepts both forms). Strings are not parsed here; the function judges them.
 */
export function decimalJson(field: string, value: DecimalInput): number | string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`${field} must be a finite number (got ${String(value)})`, {
        field,
      });
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.includes("\u0000")) {
      throw new ValidationError(`${field} contains a NUL character (U+0000): remove it`, { field });
    }
    return value;
  }
  throw new ValidationError(`${field} must be a number or a decimal string`, { field });
}

const DECIMAL = /^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$/;

/**
 * The value as the text of a `numeric` argument (for `$n::numeric`). A string that is not a plain
 * decimal would make the driver fail with a bare "invalid input syntax" error, so it is refused here.
 */
export function decimalText(field: string, value: DecimalInput): string {
  const json = decimalJson(field, value);
  if (typeof json === "string" && (json.length > 64 || !DECIMAL.test(json))) {
    throw new ValidationError(
      `${field} must be a number or a decimal string such as "4.52" (got ${show(json)})`,
      { field },
    );
  }
  return String(json);
}

const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?([Zz]|[+-]\d{2}(:?\d{2})?)$/;

/**
 * A point in time as ISO 8601 text for a `timestamptz` argument. A string must carry its time zone
 * (`2026-10-01T12:00:00Z`, `...+02:00`): without one the server would read it in its own zone, and
 * the same call would mean different instants on different machines.
 */
export function instantText(field: string, value: Date | string): string {
  if (value instanceof Date) {
    const time = value.getTime();
    const year = Number.isNaN(time) ? Number.NaN : value.getUTCFullYear();
    if (!(year >= 0 && year <= 9999)) {
      throw new ValidationError(
        `${field} is not a valid date (a Date between the years 0 and 9999)`,
        {
          field,
        },
      );
    }
    return value.toISOString();
  }
  if (typeof value !== "string" || !ISO_WITH_ZONE.test(value)) {
    throw new ValidationError(
      `${field} must be a date and time with a time zone such as "2026-10-01T12:00:00Z" or a Date (got ${
        typeof value === "string" ? show(value) : typeof value
      })`,
      { field },
    );
  }
  return value;
}
