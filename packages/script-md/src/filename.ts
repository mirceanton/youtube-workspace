import type { ScriptKind } from "@ytw/shared";
import { SCRIPT_FILE_EXTENSION } from "./constants.js";
import { ScriptMdError } from "./errors.js";
import {
  describeIdeaIdProblem,
  describeKindProblem,
  describeVersionProblem,
  isScriptKind,
  isValidVersion,
  normalizeIdeaId,
} from "./fields.js";

const MAX_SLUG_LENGTH = 48;
const MAX_TITLE_CHARS_CONSIDERED = 256;

export interface ScriptFileNameParts {
  ideaId: string;
  kind: ScriptKind;
  /** Included as `-v<version>` when given. */
  version?: number;
  /** The idea title; turned into a readable prefix. Falls back to the start of the idea id. */
  title?: string;
}

/**
 * Lowercase ASCII slug: accents are folded, everything that is not a letter or digit becomes a
 * single hyphen, at most 48 characters, no leading or trailing hyphen. May return "".
 */
export function slugify(text: string): string {
  const slug = text
    .slice(0, MAX_TITLE_CHARS_CONSIDERED)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug;
}

/**
 * The file name for a downloaded script, for example `why-rust-is-fast-script-v3.md` or
 * `idea-0190f3a2-packaging-v1.md`.
 *
 * The result only contains `a-z 0-9 . -`, starts with a letter or digit and ends in `.md`, so it
 * is safe in a `Content-Disposition` header, on every file system and in a path (it never holds
 * a separator or `..`), whatever the title contains.
 */
export function scriptFileName(parts: ScriptFileNameParts): string {
  const ideaId = normalizeIdeaId(parts.ideaId);
  if (ideaId === null) {
    throw new ScriptMdError(
      "invalid_argument",
      `Cannot build a file name: ${describeIdeaIdProblem(parts.ideaId)}.`,
    );
  }
  if (!isScriptKind(parts.kind)) {
    throw new ScriptMdError(
      "invalid_argument",
      `Cannot build a file name: ${describeKindProblem(parts.kind)}.`,
    );
  }
  if (parts.version !== undefined && !isValidVersion(parts.version)) {
    throw new ScriptMdError(
      "invalid_argument",
      `Cannot build a file name: ${describeVersionProblem(parts.version)}.`,
    );
  }

  const slug = typeof parts.title === "string" ? slugify(parts.title) : "";
  const prefix = slug === "" ? `idea-${ideaId.slice(0, 8)}` : slug;
  const version = parts.version === undefined ? "" : `-v${parts.version}`;
  return `${prefix}-${parts.kind}${version}${SCRIPT_FILE_EXTENSION}`;
}
