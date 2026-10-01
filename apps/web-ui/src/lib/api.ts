import { CSRF_HEADER, ME_PATH, SAFE_METHODS } from "./contract.ts";
import { getCsrfToken, setCsrfToken } from "./csrf.ts";
import {
  ApiError,
  ConflictError,
  ForbiddenError,
  NetworkError,
  NotFoundError,
  ResponseShapeError,
  UnauthorizedError,
} from "./errors.ts";
import { redirectToLogin } from "./navigation.ts";

// The one place the SPA talks to the web server. It
//  - sends the CSRF token (from `GET /api/me`) with every mutation,
//  - turns a 401 into a redirect to the OIDC login and a 409 into `ConflictError`,
//  - normalises every failure into a typed error (src/lib/errors.ts),
//  - optionally validates the response (`parse: someZodSchema` works, so does any `{ parse }`).
// Code outside this file never calls `fetch` for /api routes.

export interface Parser<T> {
  parse(data: unknown): T;
}

type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue | readonly (string | number)[]>;

export interface RequestOptions<T = unknown> {
  /** Defaults to GET. */
  method?: string;
  query?: Query;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as is (FormData, Blob, text); wins over `body`. Set `Content-Type` in `headers` if needed. */
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Validates the 2xx JSON body; a failure becomes `ResponseShapeError`. */
  parse?: Parser<T>;
  /** Called with every response before it is interpreted (to read headers, for example). */
  onResponse?: (response: Response) => void;
}

/** Appends `query` to `path`, skipping null/undefined values and repeating array parameters. */
export function withQuery(path: string, query: Query | undefined): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const search = params.toString();
  if (!search) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${search}`;
}

let onUnauthorized: () => void = redirectToLogin;

/** Replaces the 401 reaction (default: redirect to the OIDC login). Pass null to restore it. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler ?? redirectToLogin;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function send(url: string, init: RequestInit, csrf: string | undefined): Promise<Response> {
  const headers = new Headers(init.headers);
  if (csrf) headers.set(CSRF_HEADER, csrf);
  try {
    return await fetch(url, { ...init, headers, credentials: "same-origin" });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new NetworkError();
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorMessage(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const { error } = body as { error: unknown };
    if (typeof error === "string" && error) return error;
  }
  return `The request failed with status ${status}.`;
}

async function toError(response: Response): Promise<ApiError> {
  const body = await readJson(response);
  const message = errorMessage(body, response.status);
  switch (response.status) {
    case 401:
      onUnauthorized();
      return new UnauthorizedError(message, body);
    case 403:
      return new ForbiddenError(message, body);
    case 404:
      return new NotFoundError(message, body);
    case 409: {
      const latest =
        typeof body === "object" && body !== null && "latest" in body
          ? (body as { latest: unknown }).latest
          : undefined;
      return new ConflictError(message, latest, body);
    }
    default:
      return new ApiError(message, response.status, body);
  }
}

/**
 * Re-reads the CSRF token from `GET /api/me`. Used before the first mutation (the token normally
 * arrives with the session query) and after a 403, in case the server rotated it.
 */
export async function refreshCsrfToken(): Promise<string | undefined> {
  try {
    const response = await fetch(ME_PATH, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (response.status === 401) onUnauthorized();
    if (!response.ok) return getCsrfToken();
    setCsrfToken(response.headers.get(CSRF_HEADER));
    await response.body?.cancel();
  } catch {
    // The mutation itself reports the network failure.
  }
  return getCsrfToken();
}

export async function apiRequest<T = unknown>(
  path: string,
  options: RequestOptions<T> = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const url = withQuery(path, options.query);
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  let body: BodyInit | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] ??= "application/json";
  }
  const init: RequestInit = { method, headers, signal: options.signal ?? null };
  if (body !== undefined) init.body = body;

  const mutation = !SAFE_METHODS.has(method);
  let csrf = mutation ? (getCsrfToken() ?? (await refreshCsrfToken())) : undefined;

  let response = await send(url, init, csrf);
  if (mutation && response.status === 403) {
    // Either a real permission error or a rotated CSRF token. Retry once only if the token moved.
    const fresh = await refreshCsrfToken();
    if (fresh && fresh !== csrf) {
      csrf = fresh;
      response = await send(url, init, csrf);
    }
  }

  options.onResponse?.(response);
  if (!response.ok) throw await toError(response);

  if (response.status === 204 || response.status === 205) return undefined as T;
  const json = await readJson(response);
  if (!options.parse) return json as T;
  try {
    return options.parse.parse(json);
  } catch (error) {
    throw new ResponseShapeError(path, error);
  }
}

type BodylessOptions<T> = Omit<RequestOptions<T>, "method" | "body" | "rawBody">;
type BodyOptions<T> = Omit<RequestOptions<T>, "method" | "body">;

export const api = {
  get: <T = unknown>(path: string, options?: BodylessOptions<T>) =>
    apiRequest<T>(path, { ...options, method: "GET" }),
  post: <T = unknown>(path: string, body?: unknown, options?: BodyOptions<T>) =>
    apiRequest<T>(path, { ...options, method: "POST", body }),
  put: <T = unknown>(path: string, body?: unknown, options?: BodyOptions<T>) =>
    apiRequest<T>(path, { ...options, method: "PUT", body }),
  patch: <T = unknown>(path: string, body?: unknown, options?: BodyOptions<T>) =>
    apiRequest<T>(path, { ...options, method: "PATCH", body }),
  delete: <T = unknown>(path: string, options?: BodylessOptions<T>) =>
    apiRequest<T>(path, { ...options, method: "DELETE" }),
};
