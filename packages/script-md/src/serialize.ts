import { ScriptMdError } from "./errors.js";
import {
  describeIdeaIdProblem,
  describeKindProblem,
  describeStatusProblem,
  describeVersionProblem,
  isScriptKind,
  isScriptStatus,
  isValidVersion,
  normalizeIdeaId,
} from "./fields.js";
import { normalizeBody, type ScriptFile } from "./parse.js";

function invalidArgument(problem: string): never {
  throw new ScriptMdError("invalid_argument", `Cannot write the script file: ${problem}.`);
}

/**
 * Writes the canonical script file: a YAML front matter block with `idea_id`, `kind`, `version`
 * and `status` (in that order), a blank line, then the body.
 *
 * ```text
 * ---
 * idea_id: 0190f3a2-7c1e-7b52-9d0e-3f4a5b6c7d8e
 * kind: script
 * version: 3
 * status: draft
 * ---
 *
 * # Body starts here
 * ```
 *
 * The output always uses LF newlines and never starts with a byte order mark. The body is
 * written exactly as given (after CRLF/CR to LF conversion); an empty body produces a file that
 * ends right after the closing fence. Every value is validated before it is written, so the
 * front matter can never be broken or injected into by a field value.
 */
export function serializeScriptFile(file: ScriptFile): string {
  const ideaId = normalizeIdeaId(file.ideaId);
  if (ideaId === null) invalidArgument(describeIdeaIdProblem(file.ideaId));
  if (!isScriptKind(file.kind)) invalidArgument(describeKindProblem(file.kind));
  if (!isValidVersion(file.version)) invalidArgument(describeVersionProblem(file.version));
  if (!isScriptStatus(file.status)) invalidArgument(describeStatusProblem(file.status));
  if (typeof file.body !== "string") invalidArgument("the body must be a string");

  const body = normalizeBody(file.body);
  const head = `---\nidea_id: ${ideaId}\nkind: ${file.kind}\nversion: ${file.version}\nstatus: ${file.status}\n---\n`;
  return body === "" ? head : `${head}\n${body}`;
}
