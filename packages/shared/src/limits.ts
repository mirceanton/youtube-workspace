// Numeric limits fixed by the PRD and used by more than one service. Keep the database, the MCP
// server and the web app in agreement by importing these instead of repeating the numbers.

/** Maximum size of a script or packaging body, in UTF-8 bytes (1 MiB; PRD 9 "Input size limits"). */
export const SCRIPT_BODY_MAX_BYTES = 1_048_576;

/** Row cap for the MCP `query_sql` tool (PRD 5). */
export const QUERY_SQL_MAX_ROWS = 500;

/** Statement timeout for the MCP `query_sql` tool, in milliseconds (PRD 5). */
export const QUERY_SQL_TIMEOUT_MS = 10_000;

/** Default lifetime of a new API token, in days (PRD 7). */
export const API_TOKEN_DEFAULT_EXPIRY_DAYS = 90;

/** Polling cadence that leaves request and browser scheduling margin in the PRD 6 fifteen-second SLA. */
export const LIVE_UPDATE_INTERVAL_MS = 12_000;
