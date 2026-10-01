// Splitting the front matter block off a file and reading it as restricted YAML.
//
// The YAML is parsed with the `failsafe` schema (every scalar is a string, so no number, boolean
// or date coercion), explicit tags, anchors, aliases and merge keys are rejected, duplicate keys
// are errors, nesting is capped and the block is capped in size. Nothing is ever converted to
// native JS objects: the known keys are read straight from the document tree.

import {
  LineCounter,
  isAlias,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  type DocumentOptions,
  type ParseOptions,
  type SchemaOptions,
} from "yaml";
import { FRONT_MATTER_MAX_BYTES, FRONT_MATTER_MAX_DEPTH } from "./constants.js";
import { ScriptMdError, quoteForMessage } from "./errors.js";
import {
  describeIdeaIdProblem,
  describeKindProblem,
  describeStatusProblem,
  describeVersionProblem,
  isScriptKind,
  isScriptStatus,
  normalizeIdeaId,
  parseVersionText,
  type ScriptFrontMatter,
} from "./fields.js";
import { utf8ByteLength } from "./text.js";

const YAML_OPTIONS: ParseOptions & DocumentOptions & SchemaOptions = {
  schema: "failsafe",
  version: "1.2",
  strict: true,
  uniqueKeys: true,
  merge: false,
  prettyErrors: false,
  logLevel: "silent",
};

/** The raw front matter block of a file and where it sits. */
export interface RawFrontMatter {
  /** Text between the fences (LF newlines), including the final newline before the closing fence. */
  yaml: string;
  /** 1-based line number of the opening fence in the file, for error messages. */
  fenceLine: number;
}

export interface SplitFile {
  frontMatter: RawFrontMatter | null;
  /** Everything after the front matter (the whole text when there is none). */
  body: string;
}

function isFenceLine(line: string): boolean {
  if (!line.startsWith("---")) return false;
  for (let i = 3; i < line.length; i++) {
    const char = line[i];
    if (char !== " " && char !== "\t") return false;
  }
  return true;
}

function isBlankLine(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char !== " " && char !== "\t") return false;
  }
  return true;
}

function countNewlines(text: string, end: number): number {
  let count = 0;
  let index = text.indexOf("\n");
  while (index !== -1 && index < end) {
    count += 1;
    index = text.indexOf("\n", index + 1);
  }
  return count;
}

/**
 * Splits a normalized text (no BOM, LF newlines) into front matter and body.
 *
 * Front matter exists when the first non-blank line is exactly `---`. It ends at the next line
 * that is exactly `---`. One blank line directly after the closing fence is the separator and is
 * dropped from the body; the body is otherwise returned byte for byte.
 */
export function splitFrontMatter(text: string): SplitFile {
  // Locate the first non-blank line.
  let lineStart = 0;
  let firstLineEnd = -1;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (!isBlankLine(text.slice(lineStart, lineEnd))) {
      firstLineEnd = lineEnd;
      break;
    }
    if (newline === -1) return { frontMatter: null, body: text };
    lineStart = newline + 1;
  }

  if (!isFenceLine(text.slice(lineStart, firstLineEnd))) {
    return { frontMatter: null, body: text };
  }

  const fenceLine = countNewlines(text, lineStart) + 1;
  const contentStart = firstLineEnd >= text.length ? text.length : firstLineEnd + 1;

  let cursor = contentStart;
  for (;;) {
    const newline = text.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? text.length : newline;
    // Characters never outnumber bytes, so a longer window is certainly over the byte limit.
    if (cursor - contentStart > FRONT_MATTER_MAX_BYTES) {
      throw new ScriptMdError(
        "front_matter_unterminated",
        `The file starts with a "---" line but no closing "---" line was found within the first ${FRONT_MATTER_MAX_BYTES} bytes. Close the front matter with a line containing only "---", or remove the opening "---" line if the file has no front matter (use "***" for a horizontal rule on the first line).`,
        { limit: FRONT_MATTER_MAX_BYTES, line: fenceLine },
      );
    }
    if (isFenceLine(text.slice(cursor, lineEnd))) {
      const yaml = text.slice(contentStart, cursor);
      const bytes = utf8ByteLength(yaml);
      if (bytes > FRONT_MATTER_MAX_BYTES) {
        throw new ScriptMdError(
          "front_matter_too_large",
          `The front matter is ${bytes} bytes; the limit is ${FRONT_MATTER_MAX_BYTES} bytes. Keep only idea_id, kind, version and status between the "---" lines.`,
          { bytes, limit: FRONT_MATTER_MAX_BYTES },
        );
      }
      let bodyStart = newline === -1 ? text.length : newline + 1;
      if (text.charCodeAt(bodyStart) === 0x0a) bodyStart += 1; // the separator blank line
      return { frontMatter: { yaml, fenceLine }, body: text.slice(bodyStart) };
    }
    if (newline === -1) {
      throw new ScriptMdError(
        "front_matter_unterminated",
        'The file starts with a "---" line but the front matter is never closed. Add a line containing only "---" after the front matter, or remove the opening "---" line if the file has no front matter (use "***" for a horizontal rule on the first line).',
        { line: fenceLine },
      );
    }
    cursor = newline + 1;
  }
}

function invalid(message: string, details: Record<string, string | number> = {}): never {
  throw new ScriptMdError("front_matter_invalid", message, details);
}

/** Walks a parsed YAML node, rejecting everything the format does not allow. */
function checkNode(node: unknown, depth: number): void {
  if (node === null || node === undefined) return;
  if (isAlias(node)) {
    invalid(
      "The front matter uses a YAML alias (*name). Aliases are not allowed; write the value out.",
    );
  }
  if (!isNode(node)) return;
  if (node.anchor) {
    invalid(
      "The front matter uses a YAML anchor (&name). Anchors are not allowed; write the value out.",
    );
  }
  if (node.tag) {
    invalid(
      `The front matter uses the YAML tag ${quoteForMessage(node.tag)}. Tags are not allowed; write plain values.`,
    );
  }
  if (isMap(node) || isSeq(node)) {
    if (depth > FRONT_MATTER_MAX_DEPTH) {
      invalid(
        `The front matter nests more than ${FRONT_MATTER_MAX_DEPTH} levels deep. Keep it a flat list of key: value lines.`,
        { limit: FRONT_MATTER_MAX_DEPTH },
      );
    }
    for (const item of node.items) {
      if (isPair(item)) {
        if (!isScalar(item.key) || typeof item.key.value !== "string") {
          invalid("Every front matter key must be plain text such as idea_id.");
        }
        checkNode(item.key, depth + 1);
        checkNode(item.value, depth + 1);
      } else {
        checkNode(item, depth + 1);
      }
    }
  }
}

function fieldProblem(field: string, problem: string, line: number | undefined): never {
  throw new ScriptMdError(
    "front_matter_invalid",
    `Front matter field "${field}" is invalid: ${problem}.`,
    {
      field,
      ...(line === undefined ? {} : { line }),
    },
  );
}

/**
 * Parses the YAML between the fences. Returns the known fields that are present (validated);
 * unknown keys are allowed, ignored and must still be safe YAML. Throws `front_matter_invalid`.
 */
export function parseFrontMatterYaml(raw: RawFrontMatter): Partial<ScriptFrontMatter> {
  // `...` ends a YAML document and the parser silently ignores whatever follows it.
  const endMarker = /^\.\.\.(?:[ \t]|$)/m.exec(raw.yaml);
  if (endMarker) {
    invalid(
      'The front matter contains a YAML document end marker ("..."). Remove that line; only simple "key: value" lines are allowed between the "---" lines.',
    );
  }

  const lineCounter = new LineCounter();
  const lineOf = (offset: number | undefined): number | undefined =>
    offset === undefined ? undefined : raw.fenceLine + lineCounter.linePos(offset).line;

  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(raw.yaml, { ...YAML_OPTIONS, lineCounter });
  } catch {
    // The parser reports problems on the document; this is a last-resort guard (for example a
    // stack overflow in a runtime with a smaller stack), never a way to get partial results.
    return invalid(
      'The front matter could not be read as YAML. Use simple "key: value" lines between the "---" lines.',
    );
  }

  if (doc.errors.some((error) => error.code === "RESOURCE_EXHAUSTION")) {
    invalid(
      `The front matter nests too deeply (more than ${FRONT_MATTER_MAX_DEPTH} levels are not allowed). Keep it a flat list of key: value lines.`,
      { limit: FRONT_MATTER_MAX_DEPTH },
    );
  }
  const firstError = doc.errors[0];
  if (firstError) {
    const line = lineOf(firstError.pos[0]);
    const where = line === undefined ? "" : ` (line ${line} of the file)`;
    invalid(
      `The front matter is not valid YAML${where}: ${(firstError.message.split("\n")[0] ?? "").slice(0, 160)}. Use simple "key: value" lines between the "---" lines.`,
      line === undefined ? { reason: firstError.code } : { reason: firstError.code, line },
    );
  }
  if (doc.warnings.length > 0) {
    // The only warning the failsafe schema produces is an unresolved tag (!!js/function, !name).
    invalid(
      "The front matter uses a YAML tag (such as !!name or !name). Tags are not allowed; write plain values.",
      { reason: doc.warnings[0]?.code ?? "WARNING" },
    );
  }

  const root = doc.contents;
  if (root === null) return {}; // empty block or comments only
  if (!isMap(root)) {
    invalid(
      'The front matter must be a list of "key: value" lines (a YAML mapping), for example "idea_id: ...".',
    );
  }
  checkNode(root, 1);

  const scalars = new Map<string, { value: unknown; line: number | undefined }>();
  for (const pair of root.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue; // checkNode rejected it
    scalars.set(pair.key.value, { value: pair.value, line: lineOf(pair.key.range?.[0]) });
  }

  const result: Partial<ScriptFrontMatter> = {};

  const textOf = (field: string): { text: string; line: number | undefined } | null => {
    const entry = scalars.get(field);
    if (entry === undefined) return null;
    const { value, line } = entry;
    if (!isScalar(value) || typeof value.value !== "string" || value.value === "") {
      fieldProblem(field, "it must be a single non-empty value", line);
    }
    return { text: value.value, line };
  };

  const ideaId = textOf("idea_id");
  if (ideaId) {
    const normalized = normalizeIdeaId(ideaId.text);
    if (normalized === null)
      fieldProblem("idea_id", describeIdeaIdProblem(ideaId.text), ideaId.line);
    result.ideaId = normalized;
  }

  const kind = textOf("kind");
  if (kind) {
    if (!isScriptKind(kind.text)) fieldProblem("kind", describeKindProblem(kind.text), kind.line);
    result.kind = kind.text;
  }

  const version = textOf("version");
  if (version) {
    const parsed = parseVersionText(version.text);
    if (parsed === null)
      fieldProblem("version", describeVersionProblem(version.text), version.line);
    result.version = parsed;
  }

  const status = textOf("status");
  if (status) {
    if (!isScriptStatus(status.text)) {
      fieldProblem("status", describeStatusProblem(status.text), status.line);
    }
    result.status = status.text;
  }

  return result;
}
