/**
 * Keeps secrets out of the log. The logger blanks well-known fields by name (see logger.ts); this
 * scrubber is the second layer and runs over every finished JSON line, so a secret that ended up
 * inside a message or an error stack is removed too. It knows
 *
 * - the literal secrets of this process (`SESSION_SECRET`, the database password, ...), in plain
 *   and JSON-escaped form;
 * - API tokens, bearer credentials and JWTs wherever they appear;
 * - passwords inside URLs, OIDC and session values in query strings, and our own cookies.
 *
 * Every replacement keeps the line valid JSON, and every pattern is linear: no nested quantifiers,
 * and patterns that start on a run of characters only start at its first character.
 */
export const REDACTED = "[REDACTED]";

/** Literal secrets shorter than this are ignored: replacing "abc" everywhere would wreck the log. */
const MIN_LITERAL_SECRET_LENGTH = 8;

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
  "code_verifier",
  "password",
  "secret",
  "session_id",
].join("|");

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // scheme://user:password@host
  [
    /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@"'\\]+):([^\s/?#@"'\\]+)@/gi,
    `$1:${REDACTED}@`,
  ],
  [new RegExp(`([?&#](?:${SENSITIVE_QUERY_PARAMS})=)[^&#\\s"'\\\\]*`, "gi"), `$1${REDACTED}`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, `$1${REDACTED}`],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // API token secrets: `ytw_` and 43 base64url characters (database objects like ytw_set_actor are shorter).
  [/(?<![A-Za-z0-9])ytw_[A-Za-z0-9_-]{43}/g, REDACTED],
  [/\b(ytw_session|ytw_oidc)=[^;\s"'\\]+/g, `$1=${REDACTED}`],
];

/** Builds the function that scrubs one log line. */
export function createLineScrubber(secrets: readonly string[] = []): (line: string) => string {
  const literals = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < MIN_LITERAL_SECRET_LENGTH) continue;
    literals.add(secret);
    // The same value as it appears inside a JSON string (quotes, backslashes, control characters).
    literals.add(JSON.stringify(secret).slice(1, -1));
  }
  // Longest first, so a secret that contains another secret is removed whole.
  const ordered = [...literals].toSorted((a, b) => b.length - a.length);
  return (line) => {
    let out = line;
    for (const literal of ordered) {
      if (out.includes(literal)) out = out.split(literal).join(REDACTED);
    }
    for (const [pattern, replacement] of PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    return out;
  };
}
