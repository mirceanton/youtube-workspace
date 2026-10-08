// Numeric limits used by more than one part of the system. Keep the database, the server and the
// web app in agreement by importing these instead of repeating the numbers.

/** Maximum size of a script or packaging body, in UTF-8 bytes (1 MiB). */
export const SCRIPT_BODY_MAX_BYTES = 1_048_576;

/** Row cap for the MCP `query_sql` tool. */
export const QUERY_SQL_MAX_ROWS = 500;

/** Statement timeout for the MCP `query_sql` tool, in milliseconds. */
export const QUERY_SQL_TIMEOUT_MS = 10_000;

/** Default lifetime of a new API token, in days. */
export const API_TOKEN_DEFAULT_EXPIRY_DAYS = 90;

/** Polling cadence of the web app's live views; leaves margin inside a fifteen-second freshness target. */
export const LIVE_UPDATE_INTERVAL_MS = 12_000;
