/**
 * @ytw/policy: pure permission logic shared by the web server and the MCP server (PRD 7). No I/O:
 * callers load users, tokens and levels from the database and pass them in on every request.
 *
 * The objects and levels come from `@ytw/shared` (`RESOURCES`, `LEVELS`, `GRANTABLE_LEVELS`); this
 * package never lists them itself. See docs/policy.md for the API and for adding an object type.
 */
export type { Level, Resource, ResourceLevels } from "@ytw/shared";
export * from "./access.js";
export * from "./grants.js";
export * from "./levels.js";
export * from "./principal.js";
export * from "./summary.js";
