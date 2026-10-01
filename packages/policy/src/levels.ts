import {
  GRANTABLE_LEVELS,
  LEVELS,
  RESOURCES,
  type Level,
  type Resource,
  type ResourceLevels,
} from "@ytw/shared";

/** A level a route or tool can require. Requiring `none` would allow everyone, so it is not a requirement. */
export type RequiredLevel = Exclude<Level, "none">;

/**
 * Thrown when the policy layer is handed data it cannot interpret: an unknown level, resource or
 * principal kind, or a requirement that can never be met. It always means a bug or corrupt data, so
 * callers let it propagate (the request fails closed) instead of turning it into a denial.
 */
export class PolicyError extends Error {
  override readonly name = "PolicyError";
}

/** `true` for `"none"`, `"read"` and `"write"`. */
export function isLevel(value: unknown): value is Level {
  return (LEVELS as readonly unknown[]).includes(value);
}

/** `true` for every object in `RESOURCES` (from `@ytw/shared`). */
export function isResource(value: unknown): value is Resource {
  return (RESOURCES as readonly unknown[]).includes(value);
}

/** Throws a `PolicyError` naming the valid objects unless `value` is a known resource. */
export function assertResource(value: unknown): asserts value is Resource {
  if (!isResource(value)) {
    throw new PolicyError(
      `Unknown object ${JSON.stringify(value)}; valid objects: ${RESOURCES.join(", ")}`,
    );
  }
}

/**
 * Position of a level in `LEVELS` (none 0, read 1, write 2). Each level includes every lower one.
 * Throws a `PolicyError` for anything that is not a level, so a corrupt value can never compare as
 * "high enough".
 */
export function levelRank(level: Level): number {
  const rank = LEVELS.indexOf(level);
  if (rank < 0) {
    throw new PolicyError(
      `Unknown access level ${JSON.stringify(level)}; valid levels: ${LEVELS.join(", ")}`,
    );
  }
  return rank;
}

/** Negative when `a` is lower than `b`, zero when equal, positive when higher. Usable with `sort`. */
export function compareLevels(a: Level, b: Level): number {
  return levelRank(a) - levelRank(b);
}

/** Whether holding `have` is enough for something that needs `need` (Write includes Read). */
export function satisfies(have: Level, need: Level): boolean {
  return levelRank(have) >= levelRank(need);
}

/** The lower of two levels. */
export function minLevel(a: Level, b: Level): Level {
  return levelRank(a) <= levelRank(b) ? a : b;
}

/** The highest level that may ever be held on `resource`: `read` for the activity log, else `write`. */
export function maxLevelFor(resource: Resource): Level {
  assertResource(resource);
  return GRANTABLE_LEVELS[resource].reduce<Level>(
    (best, level) => (levelRank(level) > levelRank(best) ? level : best),
    "none",
  );
}

/**
 * `level` capped at what `resource` allows. Stored data never exceeds the cap (the database has a
 * CHECK for it); capping again here keeps the rule true even if a caller builds levels by hand.
 */
export function capLevel(resource: Resource, level: Level): Level {
  return minLevel(level, maxLevelFor(resource));
}

/** Builds a `Record<Resource, T>` by calling `fn` for every resource, in `RESOURCES` order. */
export function mapResources<T>(fn: (resource: Resource) => T): Record<Resource, T> {
  return Object.fromEntries(RESOURCES.map((resource) => [resource, fn(resource)])) as Record<
    Resource,
    T
  >;
}

/** Every resource at `level`, capped per resource (so `"write"` gives the activity log `"read"`). */
export function levelsEverywhere(level: Level): ResourceLevels {
  return mapResources((resource) => capLevel(resource, level));
}

/** None on every object: a new user (PRD 7) and the starting point for parsing stored rows. */
export const NO_ACCESS: Readonly<ResourceLevels> = Object.freeze(levelsEverywhere("none"));

/** The maximum on every object: Write everywhere and Read on the activity log. What admins hold. */
export const FULL_ACCESS: Readonly<ResourceLevels> = Object.freeze(levelsEverywhere("write"));

/** One stored permission row (`user_permissions` or `api_token_permissions`). */
export interface LevelRow {
  readonly resource: string;
  readonly level: unknown;
}

/**
 * Turns stored permission rows into a complete level map.
 *
 * - A resource with no row is `none` (fail closed), e.g. an object type added after the row was written.
 * - A row for a resource this code does not know is ignored, so a migration that adds an object type
 *   can run before the code that understands it is deployed.
 * - An unknown level or two rows for the same resource throw a `PolicyError`: the database
 *   constraints rule both out, so either one means corrupt input and the request must fail.
 */
export function levelsFromRows(rows: Iterable<LevelRow>): ResourceLevels {
  const levels: ResourceLevels = { ...NO_ACCESS };
  const seen = new Set<Resource>();
  for (const row of rows) {
    if (!isResource(row.resource)) continue;
    if (!isLevel(row.level)) {
      throw new PolicyError(
        `Unknown access level ${JSON.stringify(row.level)} for ${row.resource}; valid levels: ${LEVELS.join(", ")}`,
      );
    }
    if (seen.has(row.resource)) {
      throw new PolicyError(`More than one level given for ${row.resource}`);
    }
    seen.add(row.resource);
    levels[row.resource] = row.level;
  }
  return levels;
}

/** `levelsFromRows` for an object such as `{ ideas: "write", scripts: "read" }` (e.g. a jsonb column). */
export function levelsFromRecord(record: Readonly<Record<string, unknown>>): ResourceLevels {
  return levelsFromRows(Object.entries(record).map(([resource, level]) => ({ resource, level })));
}
