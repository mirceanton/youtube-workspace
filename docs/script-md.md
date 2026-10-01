# Script markdown file format (`@ytw/script-md`)

The file format agents and humans use to take a script or packaging doc out of the workspace, edit
it locally and upload a new revision (PRD 5 "File export and import", PRD 6 "Scripts"). One
package serves every consumer, so the rules cannot drift:

| Consumer | Uses |
| --- | --- |
| MCP service (T34): `export_script`, `GET /files/scripts/{idea_id}/{kind}`, `PUT ...?base_version=N` | `serializeScriptFile`, `scriptFileName`, `prepareUpload`, `SCRIPT_FILE_MAX_INPUT_BYTES`, `ScriptMdError.httpStatus` |
| Web server and UI (T44): download as `.md`, upload a new revision | the same functions |

The package contains no Node-only APIs (no `Buffer`, `process`, `node:*` imports; a test enforces
this), so the same code runs on the server and in the browser. Its runtime dependencies are
`@ytw/shared` (limits and the script kind/status lists) and `yaml` (about 35 KB gzipped, so load
the module with the Scripts route rather than in the app shell).

## The file

```text
---
idea_id: 0190f3a2-7c1e-7b52-9d0e-3f4a5b6c7d8e
kind: script
version: 3
status: draft
---

# Cold open

The body is plain markdown, stored exactly as written.
```

| Field | Value | Meaning |
| --- | --- | --- |
| `idea_id` | UUID | The idea the script belongs to |
| `kind` | `script` or `packaging` | `SCRIPT_KINDS` from `@ytw/shared` |
| `version` | whole number, 0 to 2147483647 | The version the file was exported from. When uploading, it is the base version of the edit (0 means "no version exists yet") |
| `status` | `draft`, `review` or `approved` | `SCRIPT_STATUSES` from `@ytw/shared`. Informational on upload: a new revision is always saved as `draft` |

Layout rules:

- The block starts on the first non-blank line with a line that is exactly `---` (trailing spaces
  allowed) and ends at the next line that is exactly `---`.
- Exactly one blank line separates the closing fence from the body. When reading, one blank line
  directly after the closing fence is dropped and everything else is the body, byte for byte.
  An empty body produces a file that ends right after the closing fence.
- Export writes the four keys in the order above, with unquoted values. Reading accepts any key
  order, quoted values, comments and extra keys (ignored). Extra keys must still be safe YAML.
- A file without front matter is valid input for an upload: the whole text is the body. A body
  whose very first line is `---` is ambiguous with front matter; start it with `***` (or any other
  thematic break) instead. An unclosed `---` block is rejected, never stored as body text.

### Encoding, newlines, BOM

- UTF-8 only. Bytes are decoded strictly: invalid sequences, UTF-16 files and NUL (U+0000) are
  rejected (`invalid_encoding`, `invalid_characters`).
- One leading byte order mark (U+FEFF) is removed on read. Export never writes one. A U+FEFF
  anywhere else is content and is kept.
- CRLF and lone CR are converted to LF everywhere (front matter and body) on read and when
  serializing. Stored bodies and exported files therefore always use LF. All other whitespace,
  including leading and trailing blank lines and a missing final newline, is preserved, so
  downloading and uploading an unchanged file gives back the identical body.

### Limits (bytes, not characters)

| Limit | Value | Error |
| --- | --- | --- |
| Body, after stripping front matter and converting to LF | `SCRIPT_BODY_MAX_BYTES` (1 MiB of UTF-8, from `@ytw/shared`; same number as the database CHECK) | `body_too_large` (413) |
| Front matter block | `FRONT_MATTER_MAX_BYTES` (8 KiB) | `front_matter_too_large` or `front_matter_unterminated` (the closing fence must appear within the first 8 KiB) |
| Raw input handed to the parser | `SCRIPT_FILE_MAX_INPUT_BYTES` (2,113,667 bytes: a CRLF file can be twice its normalized size) | `file_too_large` (413) |
| YAML nesting | `FRONT_MATTER_MAX_DEPTH` (4) | `front_matter_invalid` |

Use `SCRIPT_FILE_MAX_INPUT_BYTES` as the transport body limit (for example Fastify `bodyLimit`) so
oversize uploads are refused before they are buffered; the exact 1 MiB rule is applied by the
parser. A multi-byte character counts as its UTF-8 size: 600,000 two-byte characters are over the
limit although they are fewer than 1,048,576 characters.

## API

```ts
import {
  prepareUpload, serializeScriptFile, scriptFileName,
  isScriptMdError, SCRIPT_FILE_MIME_TYPE, SCRIPT_FILE_MAX_INPUT_BYTES,
} from "@ytw/script-md";

// Download / export_script
const text = serializeScriptFile({ ideaId, kind, version, status, body: row.body_md });
const filename = scriptFileName({ ideaId, kind, version, title: idea.title });
// -> "why-rust-is-fast-script-v3.md"; reply with Content-Type SCRIPT_FILE_MIME_TYPE

// Upload: PUT /files/scripts/{idea_id}/{kind}?base_version=N, or the web upload button
try {
  const { body, baseVersion } = prepareUpload(requestBodyTextOrBytes, {
    ideaId, // from the URL / selected idea
    kind, // from the URL / selected script
    baseVersion: queryBaseVersion, // optional; undefined when the caller gave none
    requireBaseVersion: true, // fail with base_version_missing when neither source has one
  });
  // call the same save-script-version service function as the MCP tool, with baseVersion and body
} catch (error) {
  if (isScriptMdError(error)) {
    // error.httpStatus (400 or 413), error.code, error.message (LLM-readable), error.details
  }
  throw error;
}
```

| Function | Purpose |
| --- | --- |
| `serializeScriptFile({ ideaId, kind, version, status, body })` | Canonical file text. Validates every field, so front matter cannot be injected into; throws `invalid_argument`, `body_too_large` or `invalid_characters` |
| `prepareUpload(input, { ideaId, kind, baseVersion?, requireBaseVersion? })` | Returns `{ body, baseVersion?, hadFrontMatter, frontMatter }`. `input` is a string or `Uint8Array` (UTF-8). See rules below |
| `parseScriptFile(input)` | Lenient reader: `{ hasFrontMatter, frontMatter (known fields present), body }` |
| `parseCompleteScriptFile(input)` | Strict reader that requires all four fields; used by tests and tooling |
| `scriptFileName({ ideaId, kind, version?, title? })` | Download file name; only `a-z 0-9 . -`, always ends in `.md`, never contains a path separator, `..`, quotes or control characters, whatever the title holds |
| `normalizeBody`, `assertBodyWithinLimit`, `utf8ByteLength`, `normalizeNewlines` | Building blocks, for example to check a body typed into the web editor with the same rule |
| `SCRIPT_MD_ERROR_STATUS`, `SCRIPT_MD_ERROR_CODES` | Code to HTTP status table, for exhaustive mapping |

`prepareUpload` rules:

1. The front matter `idea_id` and `kind`, when present, must equal the target (`idea_id_mismatch`,
   `kind_mismatch`, both 400). Missing fields are fine. Idea ids compare case-insensitively.
2. The base version is the front matter `version`, the `baseVersion` option, or both. If both are
   given and differ the call fails with `base_version_mismatch`: the file was edited from a
   different version than the caller believes, which is exactly the stale-edit case, so it is
   surfaced instead of one value silently winning. With neither, `baseVersion` is absent (or
   `base_version_missing` when `requireBaseVersion` is set).
3. `status` and `version` in the file never change what is saved: the revision is a `draft` and
   `baseVersion` decides the conflict check. Stale base versions are detected by the database
   function (`409` with the latest version), not by this package.
4. Everything is validated before anything is returned; there are no partial results.

### Errors

Every failure is a `ScriptMdError` with `code`, `httpStatus`, an LLM-readable `message` that says
what failed and what is valid, and `details` (limits, expected and actual values, the offending
field and file line). Messages echo untrusted values JSON-quoted and truncated.

| Code | HTTP | When |
| --- | --- | --- |
| `file_too_large`, `body_too_large`, `front_matter_too_large` | 413 | A size limit above |
| `invalid_encoding`, `invalid_characters` | 400 | Not UTF-8, or contains NUL |
| `front_matter_unterminated`, `front_matter_invalid` | 400 | Unclosed block; bad YAML, unsafe YAML, wrong shape, or a bad field value (`details.field`, `details.line`) |
| `idea_id_mismatch`, `kind_mismatch`, `base_version_mismatch`, `base_version_missing` | 400 | Upload rules 1 and 2 |
| `invalid_argument` | 400 | The caller passed a malformed idea id, kind or version, or input that is neither string nor bytes |

## YAML safety

The front matter is untrusted input. It is parsed with the `yaml` library in `failsafe` mode and
then checked before any value is read:

- every scalar is a string (no number, boolean, date or `1e3` coercion); the known fields are
  validated by exact patterns afterwards;
- explicit tags (`!!js/function`, `!!python/object`, `!custom`, even `!!str`), anchors, aliases,
  merge keys, directives, document end markers (`...`), duplicate keys and non-text keys are
  rejected, so there are no alias bombs and nothing is ever instantiated or evaluated;
- the document is never converted to JS objects: known keys are read straight from the parse
  tree, so `__proto__` and similar keys cannot pollute anything;
- the block is capped at 8 KiB, nesting at 4 levels, and the parser's own recursion guard
  turns pathological nesting into a normal `front_matter_invalid` error (a last-resort `catch`
  covers a parser that throws, for example on a small stack).

Markdown in the body is never interpreted here. Sanitizing it for display is the job of the web
UI renderer (see "Security rules" in `CLAUDE.md`).

## Tests and extending

```bash
pnpm --filter @ytw/script-md test    # round trip, newline/BOM, limits, hostile YAML, binary, uploads
pnpm --filter @ytw/script-md lint
pnpm --filter @ytw/script-md build
```

Test files: `format` (layout, round trips including a seeded random fuzz of fence-like bodies),
`safety` (huge, deeply nested, binary, NUL, unsafe YAML, byte-exact limits), `upload` (target
checks and the edit loop), `filename`, `portability` (no Node-only imports or globals; error
table) and `yaml-failure` (parser throws).

To add a front matter field, add it to `ScriptFrontMatter` (`fields.ts`), to the validation in
`front-matter.ts` and to `serializeScriptFile`, then extend `format.test.ts`. Keep
the exported field order stable, because agents diff exports.

## Decisions worth knowing

- **Strict base version agreement** (rule 2) is stricter than the PRD, which does not say what to do
  when the front matter and `?base_version=` disagree. The alternative, letting the explicit value
  win, would let an agent that re-fetched the latest version number overwrite changes it never
  merged. Callers who want the lenient behavior can omit `baseVersion` and use the file's value.
- **Front matter is optional on upload** (agents often send a bare body); it is required only by
  `parseCompleteScriptFile`.
- **Bodies are normalized to LF on every path** so the same text produces the same stored bytes
  whether it arrived through the file endpoint, the web upload or an export round trip.
