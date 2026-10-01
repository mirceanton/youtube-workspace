/**
 * Typed errors for the script markdown file format.
 *
 * Every error carries a stable `code` (for programmatic handling), an LLM-readable `message`
 * (says what failed and what is valid) and the HTTP status the file endpoints and the web server
 * should answer with, so the MCP service and the web UI report failures identically.
 */

/** HTTP statuses a file-format error maps to: 400 for malformed input, 413 for size limits. */
export type ScriptMdHttpStatus = 400 | 413;

/** Every error code this package throws, with the HTTP status that goes with it. */
export const SCRIPT_MD_ERROR_STATUS = {
  /** The raw upload is larger than any valid file can be (checked before any parsing). */
  file_too_large: 413,
  /** The body, after stripping front matter and normalizing newlines, exceeds the byte limit. */
  body_too_large: 413,
  /** The front matter block exceeds its byte limit. */
  front_matter_too_large: 413,
  /** The bytes are not valid UTF-8. */
  invalid_encoding: 400,
  /** The text contains a NUL character, which neither Postgres text nor markdown can hold. */
  invalid_characters: 400,
  /** The file opens a front matter block with `---` but never closes it. */
  front_matter_unterminated: 400,
  /** The front matter is not a valid, safe YAML mapping or one of its fields has a bad value. */
  front_matter_invalid: 400,
  /** The front matter `idea_id` differs from the idea being uploaded to. */
  idea_id_mismatch: 400,
  /** The front matter `kind` differs from the kind being uploaded to. */
  kind_mismatch: 400,
  /** The front matter `version` and the explicit base version disagree. */
  base_version_mismatch: 400,
  /** A base version was required but neither the front matter nor the caller supplied one. */
  base_version_missing: 400,
  /** The caller passed an invalid target or option (for example a malformed idea id). */
  invalid_argument: 400,
} as const satisfies Record<string, ScriptMdHttpStatus>;

export type ScriptMdErrorCode = keyof typeof SCRIPT_MD_ERROR_STATUS;

/** All error codes, for exhaustive mapping in callers. */
export const SCRIPT_MD_ERROR_CODES = Object.keys(SCRIPT_MD_ERROR_STATUS) as ScriptMdErrorCode[];

export type ScriptMdErrorDetails = Readonly<Record<string, string | number | readonly string[]>>;

export class ScriptMdError extends Error {
  readonly code: ScriptMdErrorCode;
  /** HTTP status the file endpoints / web server answer with for this error. */
  readonly httpStatus: ScriptMdHttpStatus;
  /** Machine-readable context (limits, expected and actual values, offending field). */
  readonly details: ScriptMdErrorDetails;

  constructor(code: ScriptMdErrorCode, message: string, details: ScriptMdErrorDetails = {}) {
    super(message);
    this.name = "ScriptMdError";
    this.code = code;
    this.httpStatus = SCRIPT_MD_ERROR_STATUS[code];
    this.details = details;
  }
}

/** True for errors thrown by this package (works across duplicate module instances). */
export function isScriptMdError(error: unknown): error is ScriptMdError {
  if (error instanceof ScriptMdError) return true;
  if (!(error instanceof Error) || error.name !== "ScriptMdError") return false;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && Object.hasOwn(SCRIPT_MD_ERROR_STATUS, code);
}

const MAX_ECHOED_CHARS = 64;

/**
 * Renders untrusted text for an error message: JSON-quoted (so control characters and newlines
 * are escaped, which also keeps log lines intact) and truncated.
 */
export function quoteForMessage(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  const truncated = text.length > MAX_ECHOED_CHARS ? `${text.slice(0, MAX_ECHOED_CHARS)}...` : text;
  return JSON.stringify(truncated);
}
