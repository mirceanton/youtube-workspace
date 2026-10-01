import { SCRIPT_BODY_MAX_BYTES } from "@ytw/shared/constants";

/** Maximum size of the front matter block (between the fences), in UTF-8 bytes. */
export const FRONT_MATTER_MAX_BYTES = 8192;

/** Deepest nesting of YAML collections accepted in front matter (the top-level mapping is 1). */
export const FRONT_MATTER_MAX_DEPTH = 4;

/** Largest base version / script version: Postgres `integer`. */
export const MAX_SCRIPT_VERSION = 2_147_483_647;

/**
 * Hard cap on the raw size of a file handed to the parser, in bytes. The real limits are applied
 * after newline normalization (body <= SCRIPT_BODY_MAX_BYTES, front matter <= FRONT_MATTER_MAX_BYTES);
 * a CRLF file can be up to twice as large as its normalized form, so this is twice the sum plus
 * slack for the fences and a BOM. Use it as the transport-level body limit (for example Fastify's
 * `bodyLimit`) so the parser never sees an unbounded input.
 */
export const SCRIPT_FILE_MAX_INPUT_BYTES =
  2 * (SCRIPT_BODY_MAX_BYTES + FRONT_MATTER_MAX_BYTES + 64) + 3;

/** File extension of exported script files. */
export const SCRIPT_FILE_EXTENSION = ".md";

/** Content type for serving and uploading script files. */
export const SCRIPT_FILE_MIME_TYPE = "text/markdown; charset=utf-8";
