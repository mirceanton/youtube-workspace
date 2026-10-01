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

/**
 * Names that are credentials wherever they are assigned in free text: `password=hunter2` (libpq
 * connection strings, form bodies), `"client_secret": "..."` (JSON dumped into a message).
 * Ambiguous names (`code`, `state`) are left out; they only count inside URLs.
 */
const ASSIGNED_NAMES = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "client_secret",
  "client_assertion",
  "access_token",
  "id_token",
  "refresh_token",
  "code_verifier",
  "api_key",
  "apikey",
  "private_key",
  "csrf_token",
  "session_id",
  "sessionid",
  "token",
  "jwt",
].join("|");
const ASSIGNED_VALUE = `(?:"[^"\\\\]*"|'[^'\\\\]*'|[^\\s,;&}"'\\\\]+)`;
/** `password=value`, `db_password = value`. */
const KEY_VALUE = new RegExp(
  `(?<![A-Za-z0-9])(${ASSIGNED_NAMES})(\\s*=\\s*)${ASSIGNED_VALUE}`,
  "gi",
);
/** `"password": "value"`, as left by JSON.stringify. */
const JSON_PAIR = new RegExp(`(["'])(${ASSIGNED_NAMES})\\1(\\s*:\\s*)${ASSIGNED_VALUE}`, "gi");
/** `scheme://user:password@host`: connection strings and URLs with embedded credentials. */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@"'\\]+):([^\s/?#@"'\\]+)@/gi;
const BEARER = /\b(Bearer)(\s+)([A-Za-z0-9._~+/=-]{6,})/gi;
const AUTHORIZATION_TEXT =
  /\b((?:proxy-)?authorization\s*[:=]\s*)(?:basic|digest|negotiate|token)\s+[^\s"'\\]+/gi;
const COOKIE_TEXT = /\b((?:set-)?cookie\s*[:=]\s*)[^"\\\r\n]+/gi;
const JWT = /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
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

/**
 * `jsonLine` selects the variant for a finished JSON log line, which must stay parseable: it skips
 * {@link JSON_PAIR}, whose replacement would also eat the structure of the line itself. Pairs inside
 * strings are cleaned before the line is built, when the string is still a plain string.
 */
function scrubBuiltIn(input: string, jsonLine: boolean): string {
  let out = input;
  if (out.includes("://")) out = out.replace(URL_USERINFO, `$1:${REDACTED}@`);
  if (/[?&#]/.test(out)) out = out.replace(QUERY_PARAM, `$1$2=${REDACTED}`);
  if (out.includes("=")) out = out.replace(KEY_VALUE, `$1$2${REDACTED}`);
  if (!jsonLine && out.includes(":")) out = out.replace(JSON_PAIR, `$1$2$1$3${REDACTED}`);
  out = out.replace(BEARER, (match: string, scheme: string, space: string, token: string) =>
    BEARER_PROSE.has(token.toLowerCase()) ? match : `${scheme}${space}${REDACTED}`,
  );
  out = out.replace(AUTHORIZATION_TEXT, `$1${REDACTED}`);
  out = out.replace(COOKIE_TEXT, `$1${REDACTED}`);
  out = out.replace(JWT, REDACTED);
  // Database object names also start with `ytw_` (ytw_set_actor, ytw_web). Real tokens are random
  // base64url, so require a digit, an upper-case letter or `-` to leave identifiers alone.
  out = out.replace(API_TOKEN, (match: string) => (/[0-9A-Z-]/.test(match) ? REDACTED : match));
  return out;
}

/** Literal secrets shorter than this are ignored: replacing "abc" everywhere would wreck the logs. */
export const MIN_LITERAL_SECRET_LENGTH = 8;

/**
 * Builds the scrubber for individual strings (field values, messages, error stacks). `secrets` are
 * literal values (for example `SESSION_SECRET`) that are removed wherever they appear, in plain and
 * JSON-escaped form.
 */
export function createStringScrubber(secrets: readonly string[] = []): (input: string) => string {
  return buildScrubber(secrets, false);
}

/**
 * Builds the scrubber for a finished JSON log line. Same rules as {@link createStringScrubber}, but
 * every replacement keeps the line valid JSON.
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
    // Literals first: a pattern could otherwise redact only the part of a secret that happens to
    // match it and leave the rest behind.
    let out = input;
    for (const literal of ordered) {
      if (out.includes(literal)) out = out.split(literal).join(REDACTED);
    }
    return scrubBuiltIn(out, jsonLine);
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
 * Containers whose children are request parameters. Inside them `code`, `state` and friends are
 * credentials (an OIDC callback's query is `{ code, state }`); anywhere else `code` is an error or
 * status code and `state` a business value, so they are only sensitive here.
 */
const PARAMETER_CONTAINERS = new Set([
  "query",
  "querystring",
  "qs",
  "params",
  "searchparams",
  "urlparams",
  "form",
  "formdata",
]);

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
      const childIsParameters = PARAMETER_CONTAINERS.has(normalizeKey(key));
      out.push([key, walk(child, ctx, depth + 1, childIsParameters)]);
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
  // Node's `rawHeaders` is a flat [name, value, name, value, ...] list.
  const pairs = parentKey === "rawHeaders" || parentKey === "rawTrailers";
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
