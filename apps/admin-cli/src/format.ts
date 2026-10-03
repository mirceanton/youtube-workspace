/**
 * Parsing and formatting helpers for the admin CLI.
 */
import {
  GRANTABLE_LEVELS,
  LEVELS,
  RESOURCES,
  type Level,
  type Resource,
  type ResourceLevels,
} from "@ytw/shared/constants";
import { ValidationError } from "@ytw/db";

/**
 * Parses one or more grant specifications like `ideas=write,scripts=read` or `["ideas=write", "scripts=read"]`.
 */
export function parseGrant(
  grantSpecs: string | readonly string[],
): Partial<Record<Resource, Level>> {
  const specs =
    typeof grantSpecs === "string"
      ? grantSpecs.split(",")
      : grantSpecs.flatMap((s) => s.split(","));

  const permissions: Partial<Record<Resource, Level>> = {};

  for (const raw of specs) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;

    const parts = trimmed.split("=");
    if (parts.length !== 2) {
      throw new ValidationError(
        `Invalid grant specification "${trimmed}". Format must be <resource>=<level> (e.g. ideas=write).`,
      );
    }

    const [resourceStr, levelStr] = [
      parts[0]!.trim().toLowerCase(),
      parts[1]!.trim().toLowerCase(),
    ];

    if (!RESOURCES.includes(resourceStr as Resource)) {
      throw new ValidationError(
        `Unknown resource "${resourceStr}". Valid resources: ${RESOURCES.join(", ")}.`,
      );
    }

    if (!LEVELS.includes(levelStr as Level)) {
      throw new ValidationError(`Unknown level "${levelStr}". Valid levels: ${LEVELS.join(", ")}.`);
    }

    const resource = resourceStr as Resource;
    const level = levelStr as Level;
    const allowedLevels = GRANTABLE_LEVELS[resource];

    if (!allowedLevels.includes(level)) {
      throw new ValidationError(
        `Level "${level}" is not allowed on "${resource}". Allowed levels: ${allowedLevels.join(", ")}.`,
      );
    }

    permissions[resource] = level;
  }

  return permissions;
}

/**
 * Parses duration or expiration strings like "90d", "30d", "24h", "never", or ISO dates.
 */
export function parseExpiresIn(val: string | undefined): Date | null {
  if (val === undefined) {
    // Default expiry: 90 days from now
    return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  }

  const trimmed = val.trim().toLowerCase();
  if (trimmed === "never" || trimmed === "none" || trimmed === "null") {
    return null;
  }

  const durationMatch = /^(\d+)\s*(d|days?|h|hours?|m|mins?|minutes?|w|weeks?|y|years?)$/i.exec(
    trimmed,
  );

  if (durationMatch) {
    const num = parseInt(durationMatch[1]!, 10);
    const unit = durationMatch[2]!.toLowerCase();
    let ms = 0;

    if (unit.startsWith("m") && !unit.startsWith("month")) {
      ms = num * 60 * 1000;
    } else if (unit.startsWith("h")) {
      ms = num * 3600 * 1000;
    } else if (unit.startsWith("d")) {
      ms = num * 24 * 3600 * 1000;
    } else if (unit.startsWith("w")) {
      ms = num * 7 * 24 * 3600 * 1000;
    } else if (unit.startsWith("y")) {
      ms = num * 365 * 24 * 3600 * 1000;
    }

    if (ms > 0) {
      return new Date(Date.now() + ms);
    }
  }

  const parsedDate = new Date(val);
  if (!Number.isNaN(parsedDate.getTime())) {
    return parsedDate;
  }

  throw new ValidationError(
    `Invalid --expires-in value "${val}". Use e.g. "90d", "30d", "24h", "never", or an ISO date.`,
  );
}

/**
 * Formats a resource level record as a compact string, e.g. "ideas:write scripts:read ...".
 */
export function formatLevels(levels: ResourceLevels): string {
  return RESOURCES.map((res) => `${res}=${levels[res]}`).join(" ");
}

/**
 * Formats an error into a human-readable string without stack traces.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
