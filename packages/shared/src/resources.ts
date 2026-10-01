import { z } from "zod";

/**
 * Objects that carry an access level for every user and every API token (PRD 7, "Access model").
 * `videos` covers videos and their metric snapshots; `activity` is the audit log.
 *
 * Adding an object type starts here: TypeScript then flags every `Record<Resource, ...>` below
 * that needs a new entry. The full checklist lives in docs/policy.md.
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
export const resourceSchema = z.enum(RESOURCES);

/** Access levels in ascending order: each level includes everything before it (Write includes Read). */
export const LEVELS = ["none", "read", "write"] as const;
export type Level = (typeof LEVELS)[number];
export const levelSchema = z.enum(LEVELS);

/**
 * Levels that may ever be stored for a resource. The activity log is None or Read only (PRD 7);
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

/** Human-readable names, as the settings screen shows them (PRD 7 example table). */
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

/** Every resource must be present, and each level must be grantable for its resource. */
export const resourceLevelsSchema = z
  .record(resourceSchema, levelSchema)
  .superRefine((levels, ctx) => {
    for (const resource of RESOURCES) {
      const allowed = GRANTABLE_LEVELS[resource];
      if (!allowed.includes(levels[resource])) {
        ctx.addIssue({
          code: "custom",
          path: [resource],
          message: `"${levels[resource]}" is not allowed for ${resource}; valid levels: ${allowed.join(", ")}`,
        });
      }
    }
  });
