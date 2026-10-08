import type { RouteObject } from "react-router";
import type { IconComponent } from "@/kit/types.ts";
import { validateRequirement } from "@ytw/policy";
import { meetsRequirement, type FeatureAccess, type MeResponse } from "@/lib/session.ts";

// Feature auto-discovery. A feature is a folder `src/features/<id>/` with a `routes.tsx` that
// default-exports `defineFeature({...})`. The shell finds every such file with `import.meta.glob`
// (src/app/registry.ts), builds the router and the navigation from them, and wraps each feature's
// routes in an access check. Adding a feature therefore never edits a shared file.

export interface FeatureNav {
  /** Text of the navigation item. */
  label: string;
  /** A lucide-react icon (or any component taking `className`). */
  icon: IconComponent;
  /**
   * Position in the navigation, lowest first. Convention: dashboard 10, ideas 20, scripts 30,
   * experiments 40, videos 50, activity 60, search 70, settings 90. On phones the first four items
   * are in the bottom bar and the rest under "More".
   */
  order: number;
  /** Where the item links to. Default `/<id>`; must stay inside `/<id>`. */
  to?: string;
}

export interface FeatureDefinition {
  /** Unique, lower-case, equal to the folder name: `ideas`, `activity`. */
  id: string;
  /**
   * Access needed to see the feature (nav item and routes), in the policy layer's vocabulary:
   * `{ resource: "ideas", level: "read" }`, `"authenticated"` for screens every signed-in user may
   * open, `"admin"` for admin-only screens, or an array of these (any one suffices). Cosmetic: the
   * server enforces the real rule on every request.
   */
  requires: FeatureAccess;
  /** Omit for a feature that is reachable only by links (no nav item). */
  nav?: FeatureNav;
  /**
   * React Router routes. Every top-level `path` must be the feature id or start with `<id>/`, so
   * features cannot collide. Load pages lazily: `{ path: "ideas", lazy: () => import("./IdeasPage.tsx") }`
   * where the module exports `Component` (and optionally `ErrorBoundary`).
   */
  routes: RouteObject[];
}

/** Identity function that type-checks a feature declaration. */
export function defineFeature(feature: FeatureDefinition): FeatureDefinition {
  return feature;
}

export class FeatureDiscoveryError extends Error {
  constructor(problems: readonly string[]) {
    super(`Invalid feature declarations:\n- ${problems.join("\n- ")}`);
    this.name = "FeatureDiscoveryError";
  }
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function isComponent(value: unknown): boolean {
  // Function components and forwardRef/memo wrappers (objects with $$typeof).
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

/** Why a declared rule is unusable, or null. Uses the policy layer's own check for level rules. */
function ruleProblem(rule: unknown): string | null {
  if (rule === "authenticated" || rule === "admin") return null;
  try {
    validateRequirement(rule as Parameters<typeof validateRequirement>[0]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Why `requires` is unusable (empty string when it is fine). */
function requiresProblem(requires: unknown): string {
  const rules = Array.isArray(requires) ? requires : [requires];
  if (rules.length === 0) return "the list is empty";
  for (const rule of rules) {
    const problem = ruleProblem(rule);
    if (problem) return problem;
  }
  return "";
}

function folderOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 2] ?? path;
}

// Turns the result of `import.meta.glob("../features/*/routes.tsx", { eager: true })` into a
// validated, ordered feature list. All problems are reported at once, with the offending file, so a
// mistake in one feature is obvious at startup instead of showing up as a missing menu item.
export function discoverFeatures(modules: Record<string, unknown>): FeatureDefinition[] {
  const problems: string[] = [];
  const features: FeatureDefinition[] = [];
  const seenIds = new Map<string, string>();
  const seenPaths = new Map<string, string>();

  for (const [file, mod] of Object.entries(modules).toSorted(([a], [b]) => a.localeCompare(b))) {
    const feature = (mod as { default?: unknown } | null)?.default as FeatureDefinition | undefined;
    if (!feature || typeof feature !== "object") {
      problems.push(`${file}: must default-export defineFeature({ ... })`);
      continue;
    }
    const before = problems.length;
    const where = `${file} (${String(feature.id)})`;
    const { id } = feature;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      problems.push(`${where}: id must be lower-case letters, digits and dashes`);
    } else {
      if (id !== folderOf(file))
        problems.push(`${where}: id must equal the folder name "${folderOf(file)}"`);
      const other = seenIds.get(id);
      if (other) problems.push(`${where}: id is already used by ${other}`);
      else seenIds.set(id, file);
    }
    const requiresIssue = requiresProblem(feature.requires);
    if (requiresIssue) {
      problems.push(
        `${where}: requires is invalid (${requiresIssue}); use { resource, level: "read" | "write" }, ` +
          '"authenticated", "admin", or a list of these where any one suffices',
      );
    }
    if (feature.nav !== undefined) {
      const { nav } = feature;
      if (typeof nav.label !== "string" || nav.label.trim() === "")
        problems.push(`${where}: nav.label is required`);
      if (!isComponent(nav.icon)) problems.push(`${where}: nav.icon must be an icon component`);
      if (typeof nav.order !== "number" || !Number.isFinite(nav.order))
        problems.push(`${where}: nav.order must be a number`);
      if (nav.to !== undefined && !(nav.to === `/${id}` || nav.to.startsWith(`/${id}/`))) {
        problems.push(`${where}: nav.to must be /${id} or below it`);
      }
    }
    if (!Array.isArray(feature.routes) || feature.routes.length === 0) {
      problems.push(`${where}: routes must be a non-empty array`);
    } else {
      for (const route of feature.routes) {
        const path = route.path;
        if (route.index || typeof path !== "string") {
          problems.push(`${where}: top-level routes need a string path (no index routes)`);
          continue;
        }
        if (!(path === id || path.startsWith(`${id}/`))) {
          problems.push(`${where}: route path "${path}" must be "${id}" or start with "${id}/"`);
        }
        const clash = seenPaths.get(path);
        if (clash) problems.push(`${where}: route path "${path}" is already used by ${clash}`);
        else seenPaths.set(path, file);
      }
    }
    if (problems.length === before) features.push(feature);
  }

  if (problems.length > 0) throw new FeatureDiscoveryError(problems);

  return features.toSorted((a, b) => {
    const orderA = a.nav?.order ?? Number.POSITIVE_INFINITY;
    const orderB = b.nav?.order ?? Number.POSITIVE_INFINITY;
    return orderA === orderB ? a.id.localeCompare(b.id) : orderA - orderB;
  });
}

export interface NavEntry {
  id: string;
  label: string;
  icon: IconComponent;
  to: string;
}

/**
 * The navigation for a user: features with a nav item whose requirement the user satisfies, by
 * `nav.order` (ties by id), whatever order the features arrive in.
 */
export function navEntriesFor(features: readonly FeatureDefinition[], me: MeResponse): NavEntry[] {
  return features
    .filter(
      (feature): feature is FeatureDefinition & { nav: FeatureNav } =>
        feature.nav !== undefined && meetsRequirement(me, feature.requires),
    )
    .toSorted((a, b) => a.nav.order - b.nav.order || a.id.localeCompare(b.id))
    .map((feature) => ({
      id: feature.id,
      label: feature.nav.label,
      icon: feature.nav.icon,
      to: feature.nav.to ?? `/${feature.id}`,
    }));
}
