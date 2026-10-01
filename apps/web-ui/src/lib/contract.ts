// The web contract between the web server and the SPA (PLAN.md section 3), as plain constants.
// packages/shared/src/api/session.ts exports the same values next to the zod schemas the server
// validates with; importing that module here would pull zod into the initial bundle, so the shell
// keeps its own copy and test/contract.test.ts asserts that the two never drift apart.

export const ME_PATH = "/api/me";
export const LOGIN_PATH = "/auth/login";
export const LOGOUT_PATH = "/auth/logout";
export const RETURN_TO_PARAM = "return_to";
export const CSRF_HEADER = "X-CSRF-Token";

/** SPA route the web server may redirect to when the OIDC group gate refuses a login. */
export const ACCESS_DENIED_PATH = "/access-denied";

/** Methods that never change data and therefore need no CSRF token. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
