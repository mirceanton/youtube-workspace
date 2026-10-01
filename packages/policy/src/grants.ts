import {
  GRANTABLE_LEVELS,
  RESOURCES,
  type Level,
  type Resource,
  type ResourceLevels,
} from "@ytw/shared/constants";
import {
  assertLevelMap,
  isLevel,
  isPlainObject,
  isResource,
  mapResources,
  satisfies,
} from "./levels.js";
import { effectiveLevels, userLevels, type UserLevelsSource } from "./principal.js";

/**
 * The owner whose ceiling a token grant is checked against. **Pass the owner's user record** (a
 * `UserPrincipal`, a `TokenOwner` or `{ isAdmin, levels }` with the *stored* levels): the admin rule
 * is then applied here, so an admin's ceiling is the maximum everywhere.
 *
 * A bare level map is also accepted, and is taken to be the owner's *effective* levels, i.e. the
 * result of `userLevels(owner)`. Never pass an admin's stored `levels` map on its own: the admin
 * rule would be skipped and the ceiling would be whatever rows happen to be stored.
 *
 * A user record is recognised as a plain object with its own `isAdmin` and `levels` properties.
 */
export type GrantOwner = UserLevelsSource | Readonly<ResourceLevels>;

function isUserLevelsSource(owner: GrantOwner): owner is UserLevelsSource {
  return isPlainObject(owner) && Object.hasOwn(owner, "isAdmin") && Object.hasOwn(owner, "levels");
}

/**
 * The highest level a token may be given on each object: the owner's effective level, capped by
 * what the object allows. For an admin that is Write everywhere and Read on the activity log.
 */
export function grantCeiling(owner: GrantOwner): ResourceLevels {
  return isUserLevelsSource(owner) ? userLevels(owner) : effectiveLevels(owner);
}

/**
 * The levels the settings screen offers for a new or edited token, per object, lowest first
 * (PRD 7: "The UI offers only allowed values"). An owner with Write gets None, Read, Write; with
 * Read, None and Read; the activity log never offers Write.
 */
export function grantOptions(owner: GrantOwner): Record<Resource, readonly Level[]> {
  return optionsUpTo(grantCeiling(owner));
}

function optionsUpTo(ceiling: ResourceLevels): Record<Resource, readonly Level[]> {
  return mapResources((resource) =>
    GRANTABLE_LEVELS[resource].filter((level) => satisfies(ceiling[resource], level)),
  );
}

/**
 * - `unknown_resource`: the key is not an object with access levels;
 * - `invalid_level`: the value is not none, read or write;
 * - `not_grantable`: the object never allows that level (write on the activity log);
 * - `exceeds_owner`: the level is above the owner's own level on that object.
 */
export type GrantViolationReason =
  "unknown_resource" | "invalid_level" | "not_grantable" | "exceeds_owner";

export interface GrantViolation {
  /** The key as given; a `Resource` unless `reason` is `unknown_resource`. */
  readonly resource: string;
  /** The value as given. */
  readonly requested: unknown;
  readonly reason: GrantViolationReason;
  /** Levels that would be accepted for this object (empty for an unknown object). */
  readonly allowed: readonly Level[];
  /** Says what is wrong and which values are valid; safe to show to a user or an agent. */
  readonly message: string;
}

/**
 * Every reason the requested token levels cannot be granted by `owner` (see `GrantOwner`: pass the
 * owner's user record); an empty list means they can. `requested` may be partial (objects left out
 * are not checked, so an edit can send only what changed) and may come straight from a parsed JSON
 * body: unknown objects and levels are reported, not thrown. Only its own properties are read, and
 * anything but a plain object (a `Map`, an array, an object inheriting from another) throws a
 * `PolicyError`.
 */
export function grantViolations(
  owner: GrantOwner,
  requested: Readonly<Partial<Record<Resource, Level>>>,
): GrantViolation[] {
  assertLevelMap(requested, "Requested levels");
  const ceiling = grantCeiling(owner);
  const options = optionsUpTo(ceiling);
  const violations: GrantViolation[] = [];
  for (const [resource, level] of Object.entries(requested) as [string, unknown][]) {
    if (level === undefined) continue;
    if (!isResource(resource)) {
      violations.push({
        resource,
        requested: level,
        reason: "unknown_resource",
        allowed: [],
        message: `${JSON.stringify(resource)} is not an object with access levels; valid objects: ${RESOURCES.join(", ")}`,
      });
      continue;
    }
    const allowed = options[resource];
    const choose = `choose one of: ${allowed.join(", ")}`;
    if (!isLevel(level)) {
      violations.push({
        resource,
        requested: level,
        reason: "invalid_level",
        allowed,
        message: `${JSON.stringify(level)} is not an access level for ${resource}; ${choose}`,
      });
    } else if (!GRANTABLE_LEVELS[resource].includes(level)) {
      violations.push({
        resource,
        requested: level,
        reason: "not_grantable",
        allowed,
        message: `${level} is never allowed on ${resource} (it allows ${GRANTABLE_LEVELS[resource].join(", ")}); ${choose}`,
      });
    } else if (!allowed.includes(level)) {
      violations.push({
        resource,
        requested: level,
        reason: "exceeds_owner",
        allowed,
        message: `${level} on ${resource} is above the owner's own level (${ceiling[resource]}); a token never exceeds its owner; ${choose}`,
      });
    }
  }
  return violations;
}

/**
 * Whether `owner` may give a token the `requested` levels: every level is at or below the owner's
 * effective level and within what the object allows (PRD 7). Pass the owner's user record so the
 * admin rule applies (see `GrantOwner`). The server must reject anything else; `grantViolations`
 * explains why.
 */
export function canGrant(
  owner: GrantOwner,
  requested: Readonly<Partial<Record<Resource, Level>>>,
): boolean {
  return grantViolations(owner, requested).length === 0;
}
