// Text primitives with no Node-only APIs, so the parser runs unchanged in Node and the browser.

import { ScriptMdError } from "./errors.js";

/** Length of `text` in UTF-8 bytes, without allocating. Lone surrogates count as U+FFFD (3 bytes), like TextEncoder. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Converts CRLF and lone CR line endings to LF. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Removes one leading byte order mark (U+FEFF), if present. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Throws `invalid_characters` when the text contains a NUL character. */
export function assertNoNul(text: string): void {
  const index = text.indexOf("\u0000");
  if (index !== -1) {
    throw new ScriptMdError(
      "invalid_characters",
      `The file contains a NUL character (U+0000) at position ${index}. Script files must be UTF-8 text; binary content and UTF-16 files are not accepted. Re-save the file as plain UTF-8 markdown.`,
      { position: index },
    );
  }
}

/**
 * Throws `invalid_encoding` when a string holds a lone (unpaired) surrogate. Such a string cannot
 * be written as UTF-8, so the string path rejects it exactly like the byte path rejects invalid
 * UTF-8, and both paths accept the same set of texts.
 */
export function assertWellFormed(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1); // NaN past the end, which fails the range test
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
    } else if (unit < 0xdc00 || unit > 0xdfff) {
      continue;
    }
    throw new ScriptMdError(
      "invalid_encoding",
      `The text is not valid Unicode: it contains an unpaired surrogate character at position ${i}. Script files must be UTF-8 text; remove or replace the broken character and try again.`,
      { position: i },
    );
  }
}

/**
 * Decodes UTF-8 bytes strictly (invalid sequences throw instead of becoming U+FFFD). The byte
 * order mark is kept so the caller strips it in one place.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ScriptMdError(
      "invalid_encoding",
      "The file is not valid UTF-8 text. Script files must be UTF-8 encoded (UTF-16 and binary files are not accepted). Re-save the file as UTF-8 and try again.",
    );
  }
}
