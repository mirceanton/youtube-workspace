import { RESOURCE_LABELS, RESOURCES, type Resource, type ResourceLevels } from "@ytw/shared";
import { maxLevelFor } from "./levels.js";
import { effectiveLevels } from "./principal.js";

/** Objects grouped by level, each group in `RESOURCES` order. Levels are capped per object first. */
export interface LevelSummary {
  readonly write: readonly Resource[];
  readonly read: readonly Resource[];
  readonly none: readonly Resource[];
}

export function summarizeLevels(levels: Readonly<ResourceLevels>): LevelSummary {
  const capped = effectiveLevels(levels);
  return {
    write: RESOURCES.filter((resource) => capped[resource] === "write"),
    read: RESOURCES.filter((resource) => capped[resource] === "read"),
    none: RESOURCES.filter((resource) => capped[resource] === "none"),
  };
}

function labels(resources: readonly Resource[]): string {
  return resources.map((resource) => RESOURCE_LABELS[resource]).join(", ");
}

/**
 * One line for a token list or a profile (PRD 7 "permission summary"): `No access`, `Full access`
 * (the maximum on every object), `Read on everything`, or the groups, e.g.
 * `Write: Ideas, Scripts; Read: Activity log`. Objects at None are left out of the grouped form.
 */
export function describeLevels(levels: Readonly<ResourceLevels>): string {
  const capped = effectiveLevels(levels);
  const summary = summarizeLevels(capped);
  if (summary.none.length === RESOURCES.length) return "No access";
  if (RESOURCES.every((resource) => capped[resource] === maxLevelFor(resource))) {
    return "Full access";
  }
  if (summary.read.length === RESOURCES.length) return "Read on everything";
  const parts: string[] = [];
  if (summary.write.length > 0) parts.push(`Write: ${labels(summary.write)}`);
  if (summary.read.length > 0) parts.push(`Read: ${labels(summary.read)}`);
  return parts.join("; ");
}
