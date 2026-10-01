import { SCRIPT_BODY_MAX_BYTES } from "@ytw/shared";
import { SCRIPT_FILE_MAX_INPUT_BYTES } from "./constants.js";
import { ScriptMdError } from "./errors.js";
import type { ScriptFrontMatter } from "./fields.js";
import { parseFrontMatterYaml, splitFrontMatter } from "./front-matter.js";
import {
  assertNoNul,
  decodeUtf8Strict,
  normalizeNewlines,
  stripBom,
  utf8ByteLength,
} from "./text.js";

/** A script file as text or as raw bytes (for example `await file.arrayBuffer()` wrapped in a Uint8Array). */
export type ScriptFileInput = string | Uint8Array;

/** A complete script file: all four front matter fields plus the body. */
export interface ScriptFile extends ScriptFrontMatter {
  body: string;
}

export interface ParsedScriptFile {
  /** True when the file started with a front matter block (even an empty one). */
  hasFrontMatter: boolean;
  /** The known fields the front matter contained, validated. Unknown keys are ignored. */
  frontMatter: Partial<ScriptFrontMatter>;
  /** The body with front matter and its separator blank line removed, LF newlines. */
  body: string;
}

function tooLarge(bytes: number | undefined): ScriptMdError {
  const size = bytes === undefined ? "" : ` (${bytes} bytes)`;
  return new ScriptMdError(
    "file_too_large",
    `The file is too large${size}. A script body may be at most ${SCRIPT_BODY_MAX_BYTES} bytes (1 MiB) of UTF-8 text; split the content or shorten it.`,
    { limit: SCRIPT_BODY_MAX_BYTES, ...(bytes === undefined ? {} : { bytes }) },
  );
}

/**
 * Throws `body_too_large` when the body exceeds SCRIPT_BODY_MAX_BYTES UTF-8 bytes. The limit
 * applies to the body that gets stored (front matter excluded, LF newlines).
 */
export function assertBodyWithinLimit(body: string): void {
  // Cheap exits: a UTF-16 unit takes at least 1 and at most 3 bytes.
  if (body.length * 3 <= SCRIPT_BODY_MAX_BYTES) return;
  const bytes = utf8ByteLength(body);
  if (bytes > SCRIPT_BODY_MAX_BYTES) {
    throw new ScriptMdError(
      "body_too_large",
      `The script body is ${bytes} bytes; the limit is ${SCRIPT_BODY_MAX_BYTES} bytes (1 MiB) of UTF-8 text, counted without the front matter. Shorten the body or split it into separate scripts.`,
      { bytes, limit: SCRIPT_BODY_MAX_BYTES },
    );
  }
}

/**
 * The canonical stored form of a body: LF newlines, no NUL characters, within the byte limit.
 * Everything else, including leading and trailing blank lines, is preserved exactly.
 */
export function normalizeBody(body: string): string {
  assertNoNul(body);
  const normalized = normalizeNewlines(body);
  assertBodyWithinLimit(normalized);
  return normalized;
}

/**
 * Turns raw file content into normalized text: size guard, strict UTF-8 decoding, one leading
 * byte order mark removed, NUL rejected, CRLF and CR converted to LF.
 */
export function readScriptText(input: ScriptFileInput): string {
  let text: string;
  if (typeof input === "string") {
    // A UTF-16 unit is at least one UTF-8 byte, so this never rejects a file that fits.
    if (input.length > SCRIPT_FILE_MAX_INPUT_BYTES) throw tooLarge(undefined);
    text = input;
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > SCRIPT_FILE_MAX_INPUT_BYTES) throw tooLarge(input.byteLength);
    text = decodeUtf8Strict(input);
  } else {
    throw new ScriptMdError(
      "invalid_argument",
      "A script file must be given as a string or as UTF-8 bytes (Uint8Array).",
    );
  }
  text = stripBom(text);
  assertNoNul(text);
  return normalizeNewlines(text);
}

/**
 * Reads a script file leniently: front matter is optional and may hold any subset of the four
 * fields, but whatever is present must be valid. Use {@link parseCompleteScriptFile} for files
 * that must carry all of them.
 *
 * Throws {@link ScriptMdError} for oversize, non-UTF-8, NUL-containing, unterminated or unsafe
 * input.
 */
export function parseScriptFile(input: ScriptFileInput): ParsedScriptFile {
  const text = readScriptText(input);
  const { frontMatter, body } = splitFrontMatter(text);
  const fields = frontMatter === null ? {} : parseFrontMatterYaml(frontMatter);
  assertBodyWithinLimit(body);
  return { hasFrontMatter: frontMatter !== null, frontMatter: fields, body };
}

/** Like {@link parseScriptFile} but requires `idea_id`, `kind`, `version` and `status`. */
export function parseCompleteScriptFile(input: ScriptFileInput): ScriptFile {
  const { hasFrontMatter, frontMatter, body } = parseScriptFile(input);
  if (!hasFrontMatter) {
    throw new ScriptMdError(
      "front_matter_invalid",
      'The file has no front matter. Exported script files start with a "---" block containing idea_id, kind, version and status.',
    );
  }
  const { ideaId, kind, version, status } = frontMatter;
  const missing = [
    ideaId === undefined ? "idea_id" : null,
    kind === undefined ? "kind" : null,
    version === undefined ? "version" : null,
    status === undefined ? "status" : null,
  ].filter((name): name is string => name !== null);
  if (ideaId === undefined || kind === undefined || version === undefined || status === undefined) {
    throw new ScriptMdError(
      "front_matter_invalid",
      `The front matter is missing ${missing.join(", ")}. Exported script files carry idea_id, kind, version and status.`,
      { missing },
    );
  }
  return { ideaId, kind, version, status, body };
}
