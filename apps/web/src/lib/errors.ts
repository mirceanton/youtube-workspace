// Errors thrown by the API client (src/lib/api.ts). Everything a page needs to react to is a
// subclass, so callers branch with `instanceof` instead of comparing status codes.

/** A non-2xx response. `message` is the server's `{ error }` text when it sent one. */
export class ApiError extends Error {
  readonly status: number;
  /** The parsed JSON body, when there was one. */
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** 401: not signed in or the session ended. The client has already started the login redirect. */
export class UnauthorizedError extends ApiError {
  constructor(message: string, body?: unknown) {
    super(message, 401, body);
    this.name = "UnauthorizedError";
  }
}

/** 403: signed in but the stored level is too low (or the CSRF check failed). */
export class ForbiddenError extends ApiError {
  constructor(message: string, body?: unknown) {
    super(message, 403, body);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string, body?: unknown) {
    super(message, 404, body);
    this.name = "NotFoundError";
  }
}

/**
 * 409: optimistic-concurrency failure. `latest` is whatever the server sent next to `error`
 * (feature specific: usually the current row or its version). Show a `ConflictDialog`, never
 * overwrite silently.
 */
export class ConflictError extends ApiError {
  readonly latest: unknown;

  constructor(message: string, latest: unknown, body?: unknown) {
    super(message, 409, body);
    this.name = "ConflictError";
    this.latest = latest;
  }
}

/** The request never produced a response: offline, DNS, server down, aborted by the network. */
export class NetworkError extends Error {
  constructor(message = "Can't reach the server. Check your connection and try again.") {
    super(message);
    this.name = "NetworkError";
  }
}

/** A 2xx response whose body did not match the contract, which means a client/server mismatch. */
export class ResponseShapeError extends Error {
  constructor(path: string, cause: unknown) {
    super(`The server's response to ${path} was not in the expected format.`, { cause });
    this.name = "ResponseShapeError";
  }
}

export function isConflictError(error: unknown): error is ConflictError {
  return error instanceof ConflictError;
}

/** True for failures that retrying cannot fix (4xx), so queries should not retry them. */
export function isClientError(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

/** A sentence for a person: what happened and, when known, what to do. */
export function describeError(error: unknown): string {
  if (error instanceof NetworkError) return error.message;
  if (error instanceof ForbiddenError) {
    return error.message || "You do not have access to this.";
  }
  if (error instanceof ApiError) return error.message;
  if (error instanceof ResponseShapeError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}
