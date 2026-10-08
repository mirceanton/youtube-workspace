import { LOGIN_PATH, RETURN_TO_PARAM } from "./contract.ts";

/**
 * Full-page navigations (leaving the SPA for the server's `/auth/*` routes). Kept behind an
 * object so tests can replace `assign`: jsdom cannot navigate.
 */
export const browser = {
  assign(url: string): void {
    window.location.assign(url);
  },
  reload(): void {
    window.location.reload();
  },
};

/** The current location as a same-origin path, the only kind `return_to` may carry. */
export function currentReturnTo(location: Pick<Location, "pathname" | "search" | "hash">): string {
  const path = `${location.pathname}${location.search}${location.hash}`;
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

export function loginUrl(returnTo: string): string {
  return `${LOGIN_PATH}?${RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`;
}

let redirecting = false;

/**
 * Starts the OIDC login and brings the user back to the page they were on. Idempotent: several
 * requests failing with 401 at once cause one navigation.
 */
export function redirectToLogin(): void {
  if (redirecting) return;
  redirecting = true;
  browser.assign(loginUrl(currentReturnTo(window.location)));
}

/** Test hook: allow `redirectToLogin` to navigate again. */
export function resetLoginRedirect(): void {
  redirecting = false;
}
