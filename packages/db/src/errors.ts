/**
 * Typed errors for the SQLSTATE catalogue raised by the database functions (`ytw_raise` in
 * migration 0003, documented in docs/database.md).
 *
 * The database writes the sentence a person or an LLM reads ("what failed, and the valid values or
 * the latest version") into the error MESSAGE and the same facts as a JSON object into DETAIL.
 * {@link toDbError} turns such a driver error into the matching subclass of {@link DbError}, which
 * keeps the message verbatim and exposes the parsed details.
 */

/**
 * Every custom SQLSTATE. Class `YT` is outside the ranges the SQL standard and Postgres use. A test
 * asserts that this list equals `ytw_error_codes()` in the database.
 *
 * `status` is the HTTP status the web server should answer with. 409 is reserved for optimistic
 * concurrency conflicts, because the web UI turns every 409 into its reload-or-merge dialog
 * (PLAN.md section 3, web contract); other state errors are 422.
 */
export const DB_ERROR_CATALOGUE = [
  { kind: "validation", sqlstate: "YT001", status: 400 },
  { kind: "not_found", sqlstate: "YT002", status: 404 },
  { kind: "forbidden", sqlstate: "YT003", status: 403 },
  { kind: "version_conflict", sqlstate: "YT004", status: 409 },
  { kind: "invalid_transition", sqlstate: "YT005", status: 422 },
  { kind: "duplicate", sqlstate: "YT006", status: 422 },
  { kind: "immutable", sqlstate: "YT007", status: 422 },
  { kind: "missing_actor", sqlstate: "YT008", status: 500 },
] as const;

export type DbErrorKind = (typeof DB_ERROR_CATALOGUE)[number]["kind"];

/** Machine-readable facts from the error's DETAIL (conventional keys: docs/database.md). */
export type DbErrorDetails = Readonly<Record<string, unknown>>;

/** Base class: `message` is the database's LLM-readable sentence, unchanged. */
export class DbError extends Error {
  override name = "DbError";
  readonly kind: DbErrorKind;
  readonly sqlstate: string;
  /** HTTP status a route should answer with. */
  readonly status: number;
  readonly details: DbErrorDetails;
  readonly hint: string | undefined;

  constructor(
    kind: DbErrorKind,
    message: string,
    details: DbErrorDetails = {},
    hint?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    const entry = catalogueEntry(kind);
    this.kind = kind;
    this.sqlstate = entry.sqlstate;
    this.status = entry.status;
    this.details = details;
    this.hint = hint;
  }

  /** Response body for APIs and MCP tools: `{ error, message, hint?, details }`. */
  toJSON(): { error: DbErrorKind; message: string; hint?: string; details: DbErrorDetails } {
    return {
      error: this.kind,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      details: this.details,
    };
  }
}

/** An argument is missing, malformed or outside its allowed values (details: field, value, allowed). */
export class ValidationError extends DbError {
  override name = "ValidationError";
  constructor(message: string, details?: DbErrorDetails, hint?: string, options?: ErrorOptions) {
    super("validation", message, details, hint, options);
  }
  get field(): string | undefined {
    return stringDetail(this.details, "field");
  }
  get allowed(): string[] | undefined {
    return stringListDetail(this.details, "allowed");
  }
}

/** A referenced record does not exist (details: entity, id). */
export class NotFoundError extends DbError {
  override name = "NotFoundError";
  constructor(message: string, details?: DbErrorDetails, hint?: string, options?: ErrorOptions) {
    super("not_found", message, details, hint, options);
  }
  get entity(): string | undefined {
    return stringDetail(this.details, "entity");
  }
  get id(): string | undefined {
    return stringDetail(this.details, "id");
  }
}

/** The actor is not allowed to do this (details: reason). */
export class ForbiddenError extends DbError {
  override name = "ForbiddenError";
  constructor(message: string, details?: DbErrorDetails, hint?: string, options?: ErrorOptions) {
    super("forbidden", message, details, hint, options);
  }
}

/** The expected or base version is stale (details: latest_version, expected_version). */
export class VersionConflictError extends DbError {
  override name = "VersionConflictError";
  constructor(message: string, details?: DbErrorDetails, hint?: string, options?: ErrorOptions) {
    super("version_conflict", message, details, hint, options);
  }
  get latestVersion(): number | undefined {
    return numberDetail(this.details, "latest_version");
  }
}

/** The state machine does not allow the change (details: from, to, allowed). */
export class InvalidTransitionError extends DbError {
  override name = "InvalidTransitionError";
  constructor(message: string, details?: DbErrorDetails, hint?: string, options?: ErrorOptions) {
    super("invalid_transition", message, details, hint, options);
  }
  get allowed(): string[] | undefined {
    return stringListDetail(this.details, "allowed");
  }
}

/** A record with the same natural key exists (details: entity, existing_id). */
export class DuplicateError extends DbError {
  override name = "DuplicateError";
  constructor(message: string, details?: DbErrorDetails, hint?: string, options?: ErrorOptions) {
    super("duplicate", message, details, hint, options);
  }
  get existingId(): string | undefined {
    return stringDetail(this.details, "existing_id");
  }
}

/** Append-only data cannot be changed or deleted (details: table, operation). */
export class ImmutableError extends DbError {
  override name = "ImmutableError";
  constructor(message: string, details?: DbErrorDetails, hint?: string, options?: ErrorOptions) {
    super("immutable", message, details, hint, options);
  }
}

/** A write ran without an audit actor: a bug in a database function or its caller. */
export class MissingActorError extends DbError {
  override name = "MissingActorError";
  constructor(message: string, details?: DbErrorDetails, hint?: string, options?: ErrorOptions) {
    super("missing_actor", message, details, hint, options);
  }
}

type DbErrorClass = new (
  message: string,
  details?: DbErrorDetails,
  hint?: string,
  options?: ErrorOptions,
) => DbError;

const ERROR_CLASSES: Readonly<Record<DbErrorKind, DbErrorClass>> = {
  validation: ValidationError,
  not_found: NotFoundError,
  forbidden: ForbiddenError,
  version_conflict: VersionConflictError,
  invalid_transition: InvalidTransitionError,
  duplicate: DuplicateError,
  immutable: ImmutableError,
  missing_actor: MissingActorError,
};

/** The fields of a Postgres error that the mapping reads (node-postgres `DatabaseError`). */
export interface PgErrorLike {
  readonly code: string;
  readonly message: string;
  readonly detail?: string | undefined;
  readonly hint?: string | undefined;
}

/**
 * True for errors reported by the Postgres server: they carry a severity and a five-character
 * SQLSTATE (Node's own errors such as EPIPE have no severity).
 */
export function isPgError(err: unknown): err is PgErrorLike & Error {
  if (!(err instanceof Error)) {
    return false;
  }
  const code: unknown = Reflect.get(err, "code");
  const severity: unknown = Reflect.get(err, "severity");
  return typeof severity === "string" && typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
}

/** The catalogue kind for a SQLSTATE, or undefined for codes outside the catalogue. */
export function dbErrorKind(sqlstate: string): DbErrorKind | undefined {
  return DB_ERROR_CATALOGUE.find((entry) => entry.sqlstate === sqlstate)?.kind;
}

/**
 * Maps a driver error with a catalogue SQLSTATE to its typed {@link DbError}; anything else
 * (including errors that already are a DbError) is returned unchanged so callers can rethrow it.
 */
export function toDbError(err: unknown): unknown {
  if (err instanceof DbError || !isPgError(err)) {
    return err;
  }
  const kind = dbErrorKind(err.code);
  if (kind === undefined) {
    return err;
  }
  const ErrorClass = ERROR_CLASSES[kind];
  const hint = err.hint === undefined || err.hint === "" ? undefined : err.hint;
  return new ErrorClass(err.message, parseDetails(err.detail), hint, { cause: err });
}

/**
 * Plain-text rendering for an LLM (MCP tool errors): the message, then the hint and the details.
 * Example: `Version conflict: ... latest version is 4.\nDetails: {"latest_version":4}`.
 */
export function formatDbError(err: DbError): string {
  const lines = [err.message];
  if (err.hint !== undefined) {
    lines.push(`Hint: ${err.hint}`);
  }
  if (Object.keys(err.details).length > 0) {
    lines.push(`Details: ${JSON.stringify(err.details)}`);
  }
  return lines.join("\n");
}

/**
 * Lists valid values the way database messages do: `"a", "b", "c"`. Use it for messages written in
 * TypeScript so both sides read the same.
 */
export function formatAllowed(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

/**
 * What a route or an MCP tool may tell a client about an error from the database layer: a stable
 * `error` code, a `message` that names no table, column, constraint or value, the HTTP `status`,
 * and whether retrying can help. Log the original error on the server; never send it.
 *
 * Catalogue errors keep their message, hint and details, which database functions write for
 * clients. The web contract (PLAN.md section 3) answers version conflicts with `409 {error, latest}`:
 * the HTTP layers take `latest` from `details.latest_version`.
 */
export interface ClientError {
  readonly error: string;
  readonly message: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly hint?: string;
  readonly details?: DbErrorDetails;
}

const INTERNAL_ERROR: ClientError = {
  error: "internal",
  message: "internal database error",
  status: 500,
  retryable: false,
};

const UNAVAILABLE_ERROR: ClientError = {
  error: "unavailable",
  message: "the database is unavailable; retry later",
  status: 503,
  retryable: true,
};

/** Postgres errors outside the catalogue, by SQLSTATE; the first matching pattern wins. */
const SQLSTATE_CLIENT_ERRORS: readonly (readonly [RegExp, ClientError])[] = [
  [
    /^23505$/,
    {
      error: "duplicate",
      message: "a record with the same unique value already exists",
      status: 422,
      retryable: false,
    },
  ],
  [
    /^(23503|23001)$/,
    {
      error: "invalid_reference",
      message: "the request refers to a record that does not exist, or one that is still in use",
      status: 422,
      retryable: false,
    },
  ],
  [
    /^2[23]/,
    {
      error: "validation",
      message: "a value was rejected by the database (wrong type, out of range or not allowed)",
      status: 400,
      retryable: false,
    },
  ],
  [
    /^(40001|40P01)$/,
    {
      error: "retry",
      message: "the database was busy with a conflicting change; retry the request",
      status: 503,
      retryable: true,
    },
  ],
  [
    /^(57014|55P03)$/,
    {
      error: "timeout",
      message: "the database operation took too long and was cancelled",
      status: 503,
      retryable: true,
    },
  ],
  [
    /^(42501|25006)$/,
    {
      error: "forbidden",
      message: "the database refused this operation",
      status: 403,
      retryable: false,
    },
  ],
  [
    /^42/,
    {
      error: "invalid_query",
      message: "the SQL statement is invalid",
      status: 400,
      retryable: false,
    },
  ],
  [/^(08|53|57P0)/, UNAVAILABLE_ERROR],
];

const NETWORK_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"]);

/** Maps any error thrown by the database layer to what a client may see; see {@link ClientError}. */
export function toClientError(err: unknown): ClientError {
  const typed = toDbError(err);
  if (typed instanceof DbError) {
    if (typed.status >= 500) {
      return INTERNAL_ERROR;
    }
    return {
      error: typed.kind,
      message: typed.message,
      status: typed.status,
      retryable: false,
      ...(typed.hint === undefined ? {} : { hint: typed.hint }),
      details: typed.details,
    };
  }
  if (isPgError(typed)) {
    const match = SQLSTATE_CLIENT_ERRORS.find(([pattern]) => pattern.test(typed.code));
    return match === undefined ? INTERNAL_ERROR : { ...match[1] };
  }
  if (err instanceof Error && NETWORK_ERROR_CODES.has(String(Reflect.get(err, "code")))) {
    return UNAVAILABLE_ERROR;
  }
  return INTERNAL_ERROR;
}

function catalogueEntry(kind: DbErrorKind): (typeof DB_ERROR_CATALOGUE)[number] {
  const entry = DB_ERROR_CATALOGUE.find((candidate) => candidate.kind === kind);
  if (entry === undefined) {
    throw new TypeError(`unknown database error kind: ${String(kind)}`);
  }
  return entry;
}

function parseDetails(detail: string | undefined): DbErrorDetails {
  if (detail === undefined || !detail.startsWith("{")) {
    return detail === undefined || detail === "" ? {} : { detail };
  }
  try {
    const parsed: unknown = JSON.parse(detail);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as DbErrorDetails)
      : { detail };
  } catch {
    return { detail };
  }
}

function stringDetail(details: DbErrorDetails, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" ? value : undefined;
}

function numberDetail(details: DbErrorDetails, key: string): number | undefined {
  const value = details[key];
  return typeof value === "number" ? value : undefined;
}

function stringListDetail(details: DbErrorDetails, key: string): string[] | undefined {
  const value = details[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}
