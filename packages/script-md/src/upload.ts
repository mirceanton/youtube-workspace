import type { ScriptKind } from "@ytw/shared/constants";
import { ScriptMdError, quoteForMessage } from "./errors.js";
import {
  describeIdeaIdProblem,
  describeKindProblem,
  describeVersionProblem,
  isScriptKind,
  isValidVersion,
  normalizeIdeaId,
  parseVersionText,
  type ScriptFrontMatter,
} from "./fields.js";
import { parseScriptFile, type ScriptFileInput } from "./parse.js";

/**
 * Parses the `base_version` value that arrives outside the file (query parameter, form field,
 * tool argument given as text) with the same rules as the front matter `version`: canonical
 * decimal digits from 0 to 2147483647, so `03`, `+3`, `-1`, `1e3`, `" 3"` and `""` are rejected.
 * Throws `invalid_argument` (400); use {@link parseVersionText} to get null instead.
 */
export function parseBaseVersion(value: unknown): number {
  const parsed = parseVersionText(value);
  if (parsed === null) {
    throw new ScriptMdError(
      "invalid_argument",
      `Invalid base_version: ${describeVersionProblem(value)}. Pass the version number from the exported file's front matter, or 0 when the script has no version yet.`,
    );
  }
  return parsed;
}

/** What an uploaded file is being saved as. */
export interface UploadTarget {
  /** The idea the upload is for (UUID, any case). */
  ideaId: string;
  /** The script kind the upload is for. */
  kind: ScriptKind;
  /**
   * Base version supplied outside the file (the `base_version` query parameter or form field).
   * When the front matter also carries a `version`, the two must agree.
   */
  baseVersion?: number;
  /** Fail with `base_version_missing` when neither the file nor `baseVersion` provides one. */
  requireBaseVersion?: boolean;
}

export interface PreparedUpload {
  /** The body to save as the next version: front matter stripped, LF newlines, within the byte limit. */
  body: string;
  /**
   * The version the edit is based on: the explicit `baseVersion` option or the front matter
   * `version`. Absent when neither was provided.
   */
  baseVersion?: number;
  /** True when the file carried a front matter block that was stripped. */
  hadFrontMatter: boolean;
  /**
   * The validated known fields of the stripped front matter. `status` and `version` are
   * informational: the new revision is always a draft and `baseVersion` is what counts.
   */
  frontMatter: Partial<ScriptFrontMatter>;
}

/**
 * Turns an uploaded markdown file into the body and base version to hand to the "save script
 * version" service function. This is the one place both the MCP file endpoint and the web UI
 * interpret uploads.
 *
 * - UTF-8 only, one BOM tolerated, CRLF/CR converted to LF, NUL rejected.
 * - Front matter is optional; when present it is stripped. Its `idea_id` and `kind`, if given,
 *   must equal the target (`idea_id_mismatch` / `kind_mismatch`).
 * - The body must be at most SCRIPT_BODY_MAX_BYTES UTF-8 bytes (`body_too_large`).
 * - The base version comes from the front matter `version`, from `target.baseVersion`, or both
 *   (they must agree, otherwise `base_version_mismatch`: the file was edited from a different
 *   version than the caller believes, which is exactly the stale-edit situation to surface).
 *
 * @throws {ScriptMdError}
 */
export function prepareUpload(input: ScriptFileInput, target: UploadTarget): PreparedUpload {
  const targetIdeaId = normalizeIdeaId(target.ideaId);
  if (targetIdeaId === null) {
    throw new ScriptMdError(
      "invalid_argument",
      `Invalid upload target: ${describeIdeaIdProblem(target.ideaId)}.`,
    );
  }
  if (!isScriptKind(target.kind)) {
    throw new ScriptMdError(
      "invalid_argument",
      `Invalid upload target: ${describeKindProblem(target.kind)}.`,
    );
  }
  if (target.baseVersion !== undefined && !isValidVersion(target.baseVersion)) {
    throw new ScriptMdError(
      "invalid_argument",
      `Invalid base version: ${describeVersionProblem(target.baseVersion)}.`,
    );
  }

  const { hasFrontMatter, frontMatter, body } = parseScriptFile(input);

  if (frontMatter.ideaId !== undefined && frontMatter.ideaId !== targetIdeaId) {
    throw new ScriptMdError(
      "idea_id_mismatch",
      `The front matter idea_id is ${quoteForMessage(frontMatter.ideaId)} but this upload targets idea ${quoteForMessage(targetIdeaId)}. Upload the file to the idea it was exported from, or fix or remove the idea_id line.`,
      { expected: targetIdeaId, actual: frontMatter.ideaId },
    );
  }
  if (frontMatter.kind !== undefined && frontMatter.kind !== target.kind) {
    throw new ScriptMdError(
      "kind_mismatch",
      `The front matter kind is ${quoteForMessage(frontMatter.kind)} but this upload targets kind ${quoteForMessage(target.kind)}. Upload the file to the kind it was exported from, or fix or remove the kind line.`,
      { expected: target.kind, actual: frontMatter.kind },
    );
  }

  let baseVersion = frontMatter.version;
  if (target.baseVersion !== undefined) {
    if (baseVersion !== undefined && baseVersion !== target.baseVersion) {
      throw new ScriptMdError(
        "base_version_mismatch",
        `The front matter says "version: ${baseVersion}" but the base version given with the upload is ${target.baseVersion}, and they must match: the file was edited on version ${baseVersion}. If your changes are already merged into version ${target.baseVersion}, change the front matter line to "version: ${target.baseVersion}" (or delete that line) and upload again. Otherwise re-download the latest version, merge your changes into it and upload again.`,
        { expected: target.baseVersion, actual: baseVersion },
      );
    }
    baseVersion = target.baseVersion;
  }
  if (baseVersion === undefined && target.requireBaseVersion === true) {
    throw new ScriptMdError(
      "base_version_missing",
      "No base version was given. Keep the version line from the exported front matter, or pass the version the edit is based on (use 0 when no version exists yet).",
    );
  }

  return {
    body,
    ...(baseVersion === undefined ? {} : { baseVersion }),
    hadFrontMatter: hasFrontMatter,
    frontMatter,
  };
}
