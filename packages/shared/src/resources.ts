/**
 * Objects that carry an access level for every user and every API token.
 * `videos` covers videos and their metric snapshots; `activity` is the audit log.
 *
 * Adding an object type starts here: TypeScript then flags every `Record<Resource, ...>` below
 * that needs a new entry; the database CHECK constraints and functions need the same change.
 */
export const RESOURCES = [
  "ideas",
  "scripts",
  "experiments",
  "videos",
  "notes",
  "activity",
] as const;
export type Resource = (typeof RESOURCES)[number];

/** Access levels in ascending order: each level includes everything before it (Write includes Read). */
export const LEVELS = ["none", "read", "write"] as const;
export type Level = (typeof LEVELS)[number];

/**
 * Levels that may ever be stored for a resource. The activity log is None or Read only;
 * the database enforces the same rule with a CHECK constraint.
 */
export const GRANTABLE_LEVELS: Readonly<Record<Resource, readonly Level[]>> = {
  ideas: LEVELS,
  scripts: LEVELS,
  experiments: LEVELS,
  videos: LEVELS,
  notes: LEVELS,
  activity: ["none", "read"],
};

/** Human-readable names, as the settings screen shows them. */
export const RESOURCE_LABELS: Readonly<Record<Resource, string>> = {
  ideas: "Ideas",
  scripts: "Scripts",
  experiments: "Experiments",
  videos: "Videos and metrics",
  notes: "Notes",
  activity: "Activity log",
};

/** One level per resource: a user's levels, a token's levels, or a token's effective levels. */
export type ResourceLevels = Record<Resource, Level>;
