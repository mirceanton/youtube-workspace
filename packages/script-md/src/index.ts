/**
 * @ytw/script-md: the script markdown file format.
 *
 * A script file is a YAML front matter block (`idea_id`, `kind`, `version`, `status`) followed by
 * the markdown body. The server (export and upload endpoints) and the web UI (download and
 * upload buttons) both use this package, so the rules are identical everywhere. Everything here
 * is plain JavaScript with no Node-only APIs.
 */
export {
  FRONT_MATTER_MAX_BYTES,
  FRONT_MATTER_MAX_DEPTH,
  MAX_SCRIPT_VERSION,
  SCRIPT_FILE_EXTENSION,
  SCRIPT_FILE_MAX_INPUT_BYTES,
  SCRIPT_FILE_MIME_TYPE,
} from "./constants.js";
export {
  SCRIPT_MD_ERROR_CODES,
  SCRIPT_MD_ERROR_STATUS,
  ScriptMdError,
  isScriptMdError,
  type ScriptMdErrorCode,
  type ScriptMdErrorDetails,
  type ScriptMdHttpStatus,
} from "./errors.js";
export { scriptFileName, slugify, type ScriptFileNameParts } from "./filename.js";
export { normalizeIdeaId, parseVersionText, type ScriptFrontMatter } from "./fields.js";
export {
  assertBodyWithinLimit,
  normalizeBody,
  parseCompleteScriptFile,
  parseScriptFile,
  readScriptText,
  type ParsedScriptFile,
  type ScriptFile,
  type ScriptFileInput,
} from "./parse.js";
export { serializeScriptFile } from "./serialize.js";
export { normalizeNewlines, utf8ByteLength } from "./text.js";
export {
  parseBaseVersion,
  prepareUpload,
  type PreparedUpload,
  type UploadTarget,
} from "./upload.js";
