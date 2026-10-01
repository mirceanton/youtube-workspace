import { z } from "zod";
import {
  ACTOR_TYPES,
  EXPERIMENT_STATUSES,
  EXPERIMENT_TYPES,
  NOTE_ENTITY_TYPES,
  SCRIPT_KINDS,
  SCRIPT_STATUSES,
} from "./enums.js";
import { IDEA_STAGES } from "./idea-stages.js";
import { GRANTABLE_LEVELS, LEVELS, RESOURCES } from "./resources.js";

// zod schemas for the domain constants. Kept apart from the constants so that code which only needs
// the values (the web UI shell) can import "@ytw/shared/constants" without pulling in zod.

export const resourceSchema = z.enum(RESOURCES);
export const levelSchema = z.enum(LEVELS);

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

export const ideaStageSchema = z.enum(IDEA_STAGES);
export const scriptKindSchema = z.enum(SCRIPT_KINDS);
export const scriptStatusSchema = z.enum(SCRIPT_STATUSES);
export const experimentTypeSchema = z.enum(EXPERIMENT_TYPES);
export const experimentStatusSchema = z.enum(EXPERIMENT_STATUSES);
export const actorTypeSchema = z.enum(ACTOR_TYPES);
export const noteEntityTypeSchema = z.enum(NOTE_ENTITY_TYPES);
