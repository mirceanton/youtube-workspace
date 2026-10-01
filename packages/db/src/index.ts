/**
 * @ytw/db: Postgres access for both services: the migration runner, connection pools and the
 * audit-actor transaction, the typed error catalogue, and typed wrappers around the
 * SECURITY DEFINER database functions (PRD 4, 5). Conventions: docs/database.md.
 *
 * The test harness is a separate entry point, `@ytw/db/testing`.
 */
export * from "./client.js";
export * from "./errors.js";
export * from "./migrate.js";

// Typed wrappers, one module per area; each is owned by the task named at its top (PLAN.md
// section 3). Exported names must be unique across these modules.
export * from "./ideas.js";
export * from "./scripts.js";
export * from "./notes.js";
export * from "./videos.js";
export * from "./metrics.js";
export * from "./experiments.js";
export * from "./identity.js";
export * from "./permissions.js";
export * from "./tokens.js";
export * from "./sessions.js";
export * from "./views.js";
export * from "./search.js";
export * from "./activity.js";
