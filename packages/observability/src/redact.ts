/**
 * Secret redaction for log output (PRD 5 and 9: tokens, cookies and secrets never reach a log line).
 *
 * Two independent mechanisms, because a secret can reach a log in two different shapes:
 *
 * 1. {@link redact} walks a value of any depth and replaces the value of every sensitive KEY
 *    (`authorization`, `cookie`, `password`, `access_token`, ...) while copying the rest. The logger
 *    applies it to the merge object, to child bindings and to format arguments.
 * 2. {@link createStringScrubber} rewrites sensitive-looking VALUES inside any string (bearer
 *    credentials, `ytw_` API tokens, JWTs, passwords in connection strings, secrets in query strings,
 *    and literal secrets registered at startup). The logger applies it to every serialized line as
 *    the last step, so a secret interpolated into a message or an error stack is caught as well.
 *
 * Both are fail-closed: when in doubt the value is replaced. Redaction keeps the log line valid JSON
 * and never throws.
 */

export const REDACTED = "[REDACTED]";

/** Nesting deeper than this is replaced, never emitted unscanned. */
export const MAX_REDACT_DEPTH = 12;

// ---------------------------------------------------------------------------------------------
// Key-based redaction
// ---------------------------------------------------------------------------------------------

/** Lowercases and drops everything but letters and digits: `Set-Cookie`, `set_cookie` -> `setcookie`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A normalized key containing any of these fragments is sensitive. */
const SENSITIVE_FRAGMENTS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "authorization",
  "cookie",
  "apikey",
  "privatekey",
  "credential",
  "csrf",
  "xsrf",
  "jwt",
  "bearer",
  "clientassertion",
  "codeverifier",
  "sessionid",
  "encryptionkey",
  "signingkey",
  "hmackey",
  "masterkey",
] as const;

/** Whole normalized keys that are sensitive without containing a fragment above. */
const SENSITIVE_EXACT = new Set(["pwd", "pass", "sid", "auth", "authentication"]);

/**
 * Keys that mention "token" but only describe a token (PRD 7 audit entries record the token's name
 * and id; the prefix is stored for identification). Everything else containing "token" is a secret.
 */
const DESCRIPTIVE_TOKEN_KEY =
  /^tokens?(id|ids|name|names|prefix|type|count|owner|ownerid|ownername|ownerusername|status|levels|expiresat|createdat|lastusedat)$/;

/** True when a field with this name must never be logged. Case, `-` and `_` are ignored. */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized.length === 0) return false;
  if (SENSITIVE_EXACT.has(normalized)) return true;
  for (const fragment of SENSITIVE_FRAGMENTS) {
    if (normalized.includes(fragment)) return true;
  }
  return normalized.includes("token") && !DESCRIPTIVE_TOKEN_KEY.test(normalized);
}

// ---------------------------------------------------------------------------------------------
// Value-based scrubbing
// ---------------------------------------------------------------------------------------------
//
// Everything below runs on attacker-controlled text (request URLs, header values, bodies), so
// three rules apply to every pattern:
//
// - Linear time. No nested or overlapping quantifiers, and any pattern that starts on a run of
//   characters excludes that run's own characters in a lookbehind (`(?<![a-z0-9+.-])`), so only the
//   first position of a run can start a match. A 16 KB URL built to make a naive regex backtrack
//   quadratically cost hundreds of milliseconds of event loop; test/scrub-performance.test.ts keeps
//   a hostile input per pattern.
// - Bounded input. A string longer than MAX_SCRUB_LENGTH is cut (see `bound`) before any pattern
//   sees it, so the work per string has a ceiling whatever the patterns do.
// - Fail closed. Cutting removes text, and the cut never leaves half of a token behind.

/** Query-string / fragment parameters whose value is a credential or a one-time code. */
const SENSITIVE_QUERY_PARAMS = [
  "code",
  "state",
  "session_state",
  "access_token",
  "id_token",
  "refresh_token",
  "id_token_hint",
  "token",
  "client_secret",
  "client_assertion",
  "code_verifier",
  "password",
  "passwd",
  "secret",
  "api_key",
  "apikey",
  "key",
  "auth",
  "authorization",
  "sig",
  "signature",
  "sid",
  "session",
  "session_id",
  "sessionid",
  "csrf",
  "csrf_token",
  "_csrf",
  "xsrf",
  "jwt",
  "bearer",
].join("|");

const QUERY_PARAM = new RegExp(`([?&#])(${SENSITIVE_QUERY_PARAMS})=([^&#\\s"'\\\\]*)`, "gi");
/** `scheme://user:password@host`: connection strings and URLs with embedded credentials. */
const URL_USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@"'\\]+):([^\s/?#@"'\\]+)@/gi;
const BEARER = /\b(Bearer)(\s+)([A-Za-z0-9._~+/=-]{6,})/gi;
const AUTHORIZATION_TEXT =
  /\b((?:proxy-)?authorization\s*[:=]\s*)(?:basic|digest|negotiate|token)\s+[^\s"'\\]+/gi;
const COOKIE_TEXT = /\b((?:set-)?cookie\s*[:=]\s*)[^"\\\r\n]+/gi;
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
/** API tokens are `ytw_` + 32 random bytes in base64url. */
const API_TOKEN = /(?<![A-Za-z0-9])ytw_[A-Za-z0-9_-]{12,}/g;

/** Words that follow "Bearer" in ordinary prose ("missing Bearer authorization header"). */
const BEARER_PROSE = new Set([
  "auth",
  "authentication",
  "authorization",
  "scheme",
  "header",
  "headers",
  "realm",
  "prefix",
  "required",
  "missing",
  "invalid",
  "expired",
  "revoked",
  "format",
  "value",
]);

// Credentials assigned in free text: `password=hunter2` (libpq connection strings, form bodies) and
// `{"clientSecret": "..."}` (JSON dumped into a message). JSON that is itself inside a JSON string
// has its quotes escaped, once per nesting level (`\"clientSecret\"`, then `\\\"clientSecret\\\"`),
// which is how it looks in a finished log line. A regex finds the "name =" part, the name is judged
// by the same rule as object keys, and the value is read by hand. That keeps the work linear and
// lets the scan continue inside the values of harmless names.
const ASSIGNMENT = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(\s*=\s*)/g;
/** `"name":` with any number of backslashes in front of each quote (group 1). */
const JSON_ASSIGNMENT = /(?<!\\)(\\*)(["'])([A-Za-z0-9_.-]+)\1\2(\s*:\s*)/g;

/**
 * Like {@link isSensitiveKey}, for names found in free text. `max_tokens=100` and `tokenizer=bpe`
 * are not credentials, so "token" only counts at the end of the name; the short names `pass`, `sid`
 * and `auth` are too common in prose to count here.
 */
function isSensitiveAssignedName(name: string): boolean {
  const normalized = normalizeKey(name);
  if (normalized === "pwd") return true;
  for (const fragment of SENSITIVE_FRAGMENTS) {
    if (normalized.includes(fragment)) return true;
  }
  return normalized.endsWith("token");
}

const BACKSLASH = 0x5c;

function isBareValueStop(code: number): boolean {
  // whitespace , ; & } " ' \
  return (
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    code === 0x2c ||
    code === 0x3b ||
    code === 0x26 ||
    code === 0x7d ||
    code === 0x22 ||
    code === 0x27 ||
    code === BACKSLASH
  );
}

/** What replaces a value, and where the value ends. `end === start` means there is no value. */
interface ValueSpan {
  end: number;
  replacement: string;
}

/**
 * Reads the value that starts at `start`: a bare word, or a quoted string whose quotes may be
 * escaped (`\"..\"`) because the text is JSON inside a JSON string. In a finished JSON line
 * (`jsonLine`) a quote preceded by an even number of backslashes is the line's own structure and
 * never the start of a value, so those are left alone.
 */
function readValue(text: string, start: number, jsonLine: boolean): ValueSpan {
  const none: ValueSpan = { end: start, replacement: "" };
  let quoteAt = start;
  while (text.charCodeAt(quoteAt) === BACKSLASH) quoteAt += 1;
  const escapes = quoteAt - start;
  const quote = text[quoteAt];

  if (quote === '"' || (quote === "'" && escapes === 0 && !jsonLine)) {
    if (jsonLine && escapes % 2 === 0) return none;
    return readQuoted(text, quoteAt, escapes, jsonLine);
  }
  if (escapes > 0) return none;

  let index = start;
  while (index < text.length && !isBareValueStop(text.charCodeAt(index))) index += 1;
  return { end: index, replacement: REDACTED };
}

function readQuoted(text: string, quoteAt: number, escapes: number, jsonLine: boolean): ValueSpan {
  const quote = text[quoteAt] ?? '"';
  const slashes = "\\".repeat(escapes);
  let from = quoteAt + 1;
  for (;;) {
    const found = text.indexOf(quote, from);
    if (found === -1) break;
    let run = 0;
    while (found - 1 - run > quoteAt && text.charCodeAt(found - 1 - run) === BACKSLASH) run += 1;
    // The closing quote has the same escaping as the opening one. In plain text, a quote after an
    // even number of backslashes also closes a string that is not escaped at all.
    const closes = escapes === 0 ? run % 2 === 0 : run === escapes;
    if (closes) {
      return { end: found + 1, replacement: `${slashes}${quote}${REDACTED}${slashes}${quote}` };
    }
    // In a JSON line an unescaped quote ends the string we are in: the quoted value was never
    // closed inside it, so everything up to here is the value.
    if (jsonLine && run % 2 === 0) {
      return { end: found, replacement: `${slashes}${quote}${REDACTED}` };
    }
    from = found + 1;
  }
  // Unterminated: swallow the rest, to fail closed.
  return { end: text.length, replacement: `${slashes}${quote}${REDACTED}` };
}

function scanAssignments(
  text: string,
  pattern: RegExp,
  /** The name of the assignment, or undefined to skip this match. */
  nameOf: (match: RegExpExecArray) => string | undefined,
  jsonLine: boolean,
): string {
  const parts: string[] = [];
  let copied = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const name = nameOf(match);
    if (name === undefined || !isSensitiveAssignedName(name)) continue;
    const valueStart = match.index + match[0].length;
    const value = readValue(text, valueStart, jsonLine);
    if (value.end === valueStart) continue;
    parts.push(text.slice(copied, valueStart), value.replacement);
    copied = value.end;
    pattern.lastIndex = value.end;
  }
  if (copied === 0) return text;
  parts.push(text.slice(copied));
  return parts.join("");
}

function redactAssignments(text: string, jsonLine: boolean): string {
  const afterEquals = scanAssignments(text, ASSIGNMENT, (match) => match[1], jsonLine);
  return scanAssignments(
    afterEquals,
    JSON_ASSIGNMENT,
    // In a JSON line a key whose quotes are not escaped is the line's own structure.
    (match) => (jsonLine && (match[1]?.length ?? 0) % 2 === 0 ? undefined : match[3]),
    jsonLine,
  );
}

/**
 * `jsonLine` selects the variant for a finished JSON log line, which must stay parseable: it never
 * touches a plain `"key": value` pair, because that is the structure of the line itself. Pairs
 * inside strings are cleaned before the line is built, when the string is still a plain string, and
 * again here in their escaped form.
 */
function scrubBuiltIn(input: string, jsonLine: boolean): string {
  let out = input;
  if (out.includes("://")) out = out.replace(URL_USERINFO, `$1:${REDACTED}@`);
  if (/[?&#]/.test(out)) out = out.replace(QUERY_PARAM, `$1$2=${REDACTED}`);
  out = out.replace(BEARER, (match: string, scheme: string, space: string, token: string) =>
    BEARER_PROSE.has(token.toLowerCase()) ? match : `${scheme}${space}${REDACTED}`,
  );
  out = out.replace(AUTHORIZATION_TEXT, `$1${REDACTED}`);
  out = out.replace(COOKIE_TEXT, `$1${REDACTED}`);
  out = out.replace(JWT, REDACTED);
  // Database object names also start with `ytw_` (ytw_set_actor, ytw_web). Real tokens are random
  // base64url, so require a digit, an upper-case letter or `-` to leave identifiers alone.
  out = out.replace(API_TOKEN, (match: string) => (/[0-9A-Z-]/.test(match) ? REDACTED : match));
  // Last: the header patterns above must see "authorization=Bearer x" before its value is cut at
  // the space.
  if (out.includes("=") || out.includes(":")) {
    out = redactAssignments(out, jsonLine);
  }
  return out;
}

/** A single string longer than this is cut before it is scrubbed. */
export const MAX_SCRUB_LENGTH = 16 * 1024;
/** How much of a cut string is kept: the start, which says what it was, and the end. */
export const SCRUB_HEAD_LENGTH = 12 * 1024;
export const SCRUB_TAIL_LENGTH = MAX_SCRUB_LENGTH - SCRUB_HEAD_LENGTH;
/** The cut moves at most this far to avoid leaving part of a token behind. */
const MAX_PARTIAL_TOKEN = 2048;

function isTokenCharacter(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x2e || // .
    code === 0x5f || // _
    code === 0x7e || // ~
    code === 0x2b || // +
    code === 0x2f || // /
    code === 0x3d || // =
    code === 0x2d || // -
    code === 0x25 // %
  );
}

/**
 * Cuts the middle out of an over-long string. The kept head and tail stop before any run of token
 * characters that the cut would have split, so a secret straddling the cut is removed whole instead
 * of half of it staying in the log.
 */
function bound(input: string): string {
  if (input.length <= MAX_SCRUB_LENGTH) return input;
  let headEnd = SCRUB_HEAD_LENGTH;
  const headFloor = Math.max(0, headEnd - MAX_PARTIAL_TOKEN);
  while (headEnd > headFloor && isTokenCharacter(input.charCodeAt(headEnd - 1))) headEnd -= 1;
  let tailStart = input.length - SCRUB_TAIL_LENGTH;
  const tailCeiling = Math.min(input.length, tailStart + MAX_PARTIAL_TOKEN);
  while (tailStart < tailCeiling && isTokenCharacter(input.charCodeAt(tailStart))) tailStart += 1;
  return `${input.slice(0, headEnd)}[truncated ${tailStart - headEnd} characters]${input.slice(tailStart)}`;
}

/** Literal secrets shorter than this are ignored: replacing "abc" everywhere would wreck the logs. */
export const MIN_LITERAL_SECRET_LENGTH = 8;

/**
 * Builds the scrubber for individual strings (field values, messages, error stacks). `secrets` are
 * literal values (for example `SESSION_SECRET`) that are removed wherever they appear, in plain and
 * JSON-escaped form. Strings longer than {@link MAX_SCRUB_LENGTH} are cut.
 */
export function createStringScrubber(secrets: readonly string[] = []): (input: string) => string {
  return buildScrubber(secrets, false);
}

/**
 * Builds the scrubber for a finished JSON log line. Same rules as {@link createStringScrubber}, but
 * every replacement keeps the line valid JSON, and the line is never cut (its strings were cut when
 * they were scrubbed individually).
 */
export function createLineScrubber(secrets: readonly string[] = []): (line: string) => string {
  return buildScrubber(secrets, true);
}

function buildScrubber(secrets: readonly string[], jsonLine: boolean): (input: string) => string {
  const literals = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < MIN_LITERAL_SECRET_LENGTH) continue;
    literals.add(secret);
    // The same value as it appears inside a JSON string (quotes, backslashes, control characters).
    literals.add(JSON.stringify(secret).slice(1, -1));
  }
  // Longest first, so a secret that contains another secret is removed whole.
  const ordered = [...literals].toSorted((a, b) => b.length - a.length);
  return (input: string): string => {
    // Literals first, on the whole string: a pattern could otherwise redact only the part of a
    // secret that happens to match it, and a cut could split a secret in two.
    let out = input;
    for (const literal of ordered) {
      if (out.includes(literal)) out = out.split(literal).join(REDACTED);
    }
    return scrubBuiltIn(jsonLine ? out : bound(out), jsonLine);
  };
}

const defaultScrubber = createStringScrubber();

/** Scrubs one string with the built-in patterns (no literal secrets). */
export function scrubString(input: string): string {
  return defaultScrubber(input);
}

// ---------------------------------------------------------------------------------------------
// Deep redaction
// ---------------------------------------------------------------------------------------------

type Scrub = (input: string) => string;

interface Context {
  scrub: Scrub;
  /** Objects currently being walked, to cut cycles without flagging shared references. */
  ancestors: Set<object>;
}

/**
 * Containers whose children are request or authentication-flow parameters: a key that is `query`,
 * `form`, `qs`, or contains `query`, `params`, `parameters`, `callback`, `oauth`, `oidc` or
 * `redirect` (`queryString`, `searchParams`, `callback`, `oidcResponse`, ...). Inside them `code`,
 * `state` and friends are credentials (an OIDC callback's query is `{ code, state }`); anywhere else
 * `code` is an error or status code and `state` a business value, so they are only sensitive here.
 */
function isParameterContainer(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized === "form" || normalized === "formdata" || normalized === "qs") return true;
  return PARAMETER_CONTAINER_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

const PARAMETER_CONTAINER_FRAGMENTS = [
  "query",
  "param",
  "callback",
  "oauth",
  "oidc",
  "redirect",
] as const;

const PARAMETER_ONLY_KEYS = new Set([
  "code",
  "state",
  "sessionstate",
  "nonce",
  "key",
  "sig",
  "signature",
  "session",
]);

/**
 * Returns a copy of `value` that is safe to log: sensitive keys are replaced, strings are scrubbed,
 * errors become plain objects, binary data becomes a size marker, cycles and excessive depth are cut.
 * The input is never mutated.
 */
export function redact(value: unknown, scrub: Scrub = scrubString): unknown {
  return walk(value, { scrub, ancestors: new Set<object>() }, 0, false);
}

function walk(value: unknown, ctx: Context, depth: number, parameters: boolean): unknown {
  switch (typeof value) {
    case "string":
      return ctx.scrub(value);
    case "number":
    case "boolean":
    case "bigint":
    case "undefined":
      return value;
    case "symbol":
      return ctx.scrub(value.toString());
    case "function":
      return undefined;
    default:
      break;
  }
  if (value === null) return null;
  const obj = value as object;

  if (depth >= MAX_REDACT_DEPTH) return "[Truncated]";
  if (ctx.ancestors.has(obj)) return "[Circular]";
  ctx.ancestors.add(obj);
  try {
    return walkObject(obj, ctx, depth, parameters);
  } catch {
    return "[Unserializable]";
  } finally {
    ctx.ancestors.delete(obj);
  }
}

function walkObject(obj: object, ctx: Context, depth: number, parameters: boolean): unknown {
  if (obj instanceof Date) return obj;
  if (obj instanceof Error) return walkError(obj, ctx, depth);
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
    return `[Binary ${obj.byteLength} bytes]`;
  }
  if (obj instanceof URLSearchParams) return walkEntries([...obj.entries()], ctx, depth, true);
  if (typeof Headers !== "undefined" && obj instanceof Headers) {
    return walkEntries([...obj.entries()], ctx, depth, false);
  }
  if (obj instanceof Map) {
    const entries = [...obj.entries()].map(([k, v]): [string, unknown] => [String(k), v]);
    return walkEntries(entries, ctx, depth, parameters);
  }
  if (obj instanceof Set) return walkArray([...obj], ctx, depth, parameters, "");
  if (Array.isArray(obj)) return walkArray(obj, ctx, depth, parameters, "");

  const toJSON = (obj as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    const json: unknown = toJSON.call(obj);
    // A toJSON that returns itself (or another object graph) is walked like any other value.
    return json === obj
      ? walkRecord(obj, ctx, depth, parameters)
      : walk(json, ctx, depth + 1, parameters);
  }
  return walkRecord(obj, ctx, depth, parameters);
}

function readProperty(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return "[Unserializable]";
  }
}

function walkRecord(obj: object, ctx: Context, depth: number, parameters: boolean): unknown {
  const entries = Object.keys(obj).map((key): [string, unknown] => [key, readProperty(obj, key)]);
  return walkEntries(entries, ctx, depth, parameters);
}

function isSensitiveField(key: string, parameters: boolean): boolean {
  return isSensitiveKey(key) || (parameters && PARAMETER_ONLY_KEYS.has(normalizeKey(key)));
}

function walkEntries(
  entries: ReadonlyArray<readonly [string, unknown]>,
  ctx: Context,
  depth: number,
  parameters: boolean,
): Record<string, unknown> {
  const out: Array<[string, unknown]> = [];
  for (const [key, child] of entries) {
    if (child === undefined) continue;
    if (isSensitiveField(key, parameters)) {
      out.push([key, child === null ? null : REDACTED]);
    } else if ((key === "rawHeaders" || key === "rawTrailers") && Array.isArray(child)) {
      out.push([key, walkArray(child, ctx, depth, false, key)]);
    } else {
      // Once inside a parameter container, everything below it is parameters too.
      out.push([key, walk(child, ctx, depth + 1, parameters || isParameterContainer(key))]);
    }
  }
  // fromEntries defines own properties, so a key named "__proto__" cannot change the prototype.
  return Object.fromEntries(out);
}

function walkArray(
  items: readonly unknown[],
  ctx: Context,
  depth: number,
  parameters: boolean,
  parentKey: string,
): unknown[] {
  // Node's `rawHeaders` is a flat [name, value, name, value, ...] list, and it reaches the logger
  // under any key (or none, as a format argument), so any all-string list of even length is read
  // as name/value pairs. A value after a sensitive name is redacted; other lists are unchanged.
  const pairs =
    parentKey === "rawHeaders" ||
    parentKey === "rawTrailers" ||
    (items.length >= 2 &&
      items.length % 2 === 0 &&
      items.every((item) => typeof item === "string"));
  return items.map((item, index) => {
    const previous = items[index - 1];
    if (pairs && index % 2 === 1 && typeof previous === "string" && isSensitiveKey(previous)) {
      return REDACTED;
    }
    return walk(item, ctx, depth + 1, parameters);
  });
}

function walkError(err: Error, ctx: Context, depth: number): unknown {
  const entries: Array<[string, unknown]> = [
    ["type", err.constructor.name || err.name],
    ["message", err.message],
    ["stack", err.stack],
  ];
  for (const key of Object.keys(err)) {
    if (key === "message" || key === "stack" || key === "type") continue;
    entries.push([key, readProperty(err, key)]);
  }
  if (err.cause !== undefined) entries.push(["cause", err.cause]);
  if (err instanceof AggregateError) entries.push(["errors", err.errors]);
  return walkEntries(entries, ctx, depth, false);
}
