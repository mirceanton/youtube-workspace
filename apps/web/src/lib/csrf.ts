// The CSRF token lives in memory only. The server hands out the current value in the
// `X-CSRF-Token` response header of `GET /api/me`; the API client sends it back on every mutation.

let csrfToken: string | undefined;

export function getCsrfToken(): string | undefined {
  return csrfToken;
}

export function setCsrfToken(token: string | null | undefined): void {
  csrfToken = token || undefined;
}
