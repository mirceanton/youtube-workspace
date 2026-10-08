// The contract between the server and the SPA, as plain constants.
// packages/shared/src/api/session.ts exports the same values next to the zod schemas the server
// validates with; importing that module here would pull zod into the initial bundle, so the shell
// keeps its own copy and test/lib/contract.test.ts asserts that the two never drift apart.

export const ME_PATH = "/api/me";
export const NOTES_PATH = "/api/notes";
export const NOTE_BODY_MAX_BYTES = 65_536;
export const LOGIN_PATH = "/auth/login";
export const LOGOUT_PATH = "/auth/logout";
export const RETURN_TO_PARAM = "return_to";
export const CSRF_HEADER = "X-CSRF-Token";

/** SPA route the server may redirect to when the OIDC group gate refuses a login. */
export const ACCESS_DENIED_PATH = "/access-denied";

/** Methods that never change data and therefore need no CSRF token. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
