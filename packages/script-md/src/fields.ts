import {
  SCRIPT_KINDS,
  SCRIPT_STATUSES,
  type ScriptKind,
  type ScriptStatus,
} from "@ytw/shared/constants";
import { MAX_SCRIPT_VERSION } from "./constants.js";
import { quoteForMessage } from "./errors.js";

/** The four fields the front matter of an exported script file carries. */
export interface ScriptFrontMatter {
  /** UUID of the idea the script belongs to (lowercase). */
  ideaId: string;
  kind: ScriptKind;
  /** Script version the file was exported from; the base version when uploading edits. */
  version: number;
  status: ScriptStatus;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Canonical decimal digits: no sign, spaces, exponent or hex, and no leading zeros ("03" is out).
const VERSION_PATTERN = /^(?:0|[1-9]\d{0,9})$/;

/** A field problem as a message fragment (no sentence end), or null when the value is valid. */
export type FieldProblem = string;

/** Returns the canonical lowercase UUID, or null when `value` is not a UUID. */
export function normalizeIdeaId(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

export function describeIdeaIdProblem(value: unknown): FieldProblem {
  return `idea_id must be a UUID such as 0190f3a2-7c1e-7b52-9d0e-3f4a5b6c7d8e, got ${quoteForMessage(value)}`;
}

export function isScriptKind(value: unknown): value is ScriptKind {
  return typeof value === "string" && (SCRIPT_KINDS as readonly string[]).includes(value);
}

export function describeKindProblem(value: unknown): FieldProblem {
  return `kind must be one of ${SCRIPT_KINDS.join(", ")}, got ${quoteForMessage(value)}`;
}

export function isScriptStatus(value: unknown): value is ScriptStatus {
  return typeof value === "string" && (SCRIPT_STATUSES as readonly string[]).includes(value);
}

export function describeStatusProblem(value: unknown): FieldProblem {
  return `status must be one of ${SCRIPT_STATUSES.join(", ")}, got ${quoteForMessage(value)}`;
}

/** True for an integer in 0..MAX_SCRIPT_VERSION (0 is the base version of a script's first revision). */
export function isValidVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SCRIPT_VERSION
  );
}

/**
 * Parses a version written as text, such as the `?base_version=` query parameter or a front
 * matter `version` value. Only canonical decimal digits from `0` to 2147483647 are accepted:
 * `03`, `+3`, `-1`, `1e3`, `0x3`, `3.0`, `" 3"`, `""` and anything that is not a string give
 * null. `0` is valid (the base version of a script's first revision).
 */
export function parseVersionText(value: unknown): number | null {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return isValidVersion(parsed) ? parsed : null;
}

export function describeVersionProblem(value: unknown): FieldProblem {
  return `version must be a whole number from 0 to ${MAX_SCRIPT_VERSION}, written in digits only (no sign, spaces or leading zeros), got ${quoteForMessage(value)}`;
}
