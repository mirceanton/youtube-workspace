import { Lightbulb } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  FeatureDiscoveryError,
  defineFeature,
  discoverFeatures,
  navEntriesFor,
  type FeatureDefinition,
} from "../../src/app/features.ts";
import { sessionWith } from "../helpers/render.tsx";

// The same mechanism the app uses (import.meta.glob + discoverFeatures), pointed at fixtures.
const fixtureModules = import.meta.glob("../fixtures/features/*/routes.tsx", { eager: true });

function mod(feature: unknown): { default: unknown } {
  return { default: feature };
}

function valid(overrides: Partial<FeatureDefinition> = {}): FeatureDefinition {
  return defineFeature({
    id: "ideas",
    requires: { resource: "ideas", level: "read" },
    nav: { label: "Ideas", icon: Lightbulb, order: 20 },
    routes: [{ path: "ideas", element: null }],
    ...overrides,
  });
}

function problemsOf(modules: Record<string, unknown>): string {
  let thrown: unknown;
  try {
    discoverFeatures(modules);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(FeatureDiscoveryError);
  return (thrown as Error).message;
}

describe("feature auto-discovery with import.meta.glob", () => {
  it("finds every routes.tsx below the features folder and orders them by nav order", () => {
    expect(Object.keys(fixtureModules).toSorted()).toEqual([
      "../fixtures/features/alpha/routes.tsx",
      "../fixtures/features/beta/routes.tsx",
      "../fixtures/features/delta/routes.tsx",
      "../fixtures/features/gamma/routes.tsx",
      "../fixtures/features/hidden/routes.tsx",
    ]);
    const features = discoverFeatures(fixtureModules);
    // order: beta 10, alpha 20, gamma 60, delta 90, then features without a nav item.
    expect(features.map((f) => f.id)).toEqual(["beta", "alpha", "gamma", "delta", "hidden"]);
  });

  it("keeps the declaration (requires, routes) exactly as written", () => {
    const alpha = discoverFeatures(fixtureModules).find((f) => f.id === "alpha");
    expect(alpha?.requires).toEqual({ resource: "ideas", level: "read" });
    expect(alpha?.routes.map((r) => r.path)).toEqual(["alpha", "alpha/:itemId"]);
    expect(typeof alpha?.routes[0]?.lazy).toBe("function");
  });

  it("returns an empty list when no feature exists yet", () => {
    expect(discoverFeatures({})).toEqual([]);
  });

  it("is not affected by the order the glob returns the files in", () => {
    const reversed = Object.fromEntries(Object.entries(fixtureModules).toReversed());
    expect(discoverFeatures(reversed).map((f) => f.id)).toEqual(
      discoverFeatures(fixtureModules).map((f) => f.id),
    );
  });
});

describe("feature declaration checks", () => {
  it("accepts a well-formed feature", () => {
    expect(discoverFeatures({ "../features/ideas/routes.tsx": mod(valid()) })).toHaveLength(1);
  });

  it("breaks ties on nav order by id", () => {
    const a = valid({ id: "a", routes: [{ path: "a", element: null }] });
    const b = valid({ id: "b", routes: [{ path: "b", element: null }] });
    const result = discoverFeatures({
      "../features/b/routes.tsx": mod(b),
      "../features/a/routes.tsx": mod(a),
    });
    expect(result.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("rejects a file without a default export", () => {
    expect(problemsOf({ "../features/ideas/routes.tsx": {} })).toContain(
      "must default-export defineFeature",
    );
  });

  it("rejects an id that is not the folder name, or malformed", () => {
    expect(problemsOf({ "../features/other/routes.tsx": mod(valid()) })).toContain(
      'id must equal the folder name "other"',
    );
    expect(problemsOf({ "../features/Ideas/routes.tsx": mod(valid({ id: "Ideas" })) })).toContain(
      "id must be lower-case",
    );
  });

  it("rejects two features with the same id or the same route path", () => {
    const duplicateId = problemsOf({
      "../features/ideas/routes.tsx": mod(valid()),
      "../features/ideas2/ideas/routes.tsx": mod(valid()),
    });
    expect(duplicateId).toContain("is already used by");
  });

  it("makes features stay inside their own path", () => {
    expect(
      problemsOf({
        "../features/ideas/routes.tsx": mod(
          valid({ routes: [{ path: "scripts", element: null }] }),
        ),
      }),
    ).toContain('route path "scripts" must be "ideas" or start with "ideas/"');
    expect(
      problemsOf({
        "../features/ideas/routes.tsx": mod(valid({ routes: [{ path: "ideasx", element: null }] })),
      }),
    ).toContain('must be "ideas" or start with "ideas/"');
    // Sub-paths are fine.
    expect(
      discoverFeatures({
        "../features/ideas/routes.tsx": mod(
          valid({
            routes: [
              { path: "ideas", element: null },
              { path: "ideas/:id/edit", element: null },
            ],
          }),
        ),
      }),
    ).toHaveLength(1);
  });

  it("rejects index routes, missing paths and empty route lists", () => {
    expect(
      problemsOf({
        "../features/ideas/routes.tsx": mod(valid({ routes: [{ index: true, element: null }] })),
      }),
    ).toContain("no index routes");
    expect(problemsOf({ "../features/ideas/routes.tsx": mod(valid({ routes: [] })) })).toContain(
      "routes must be a non-empty array",
    );
  });

  it("rejects a route path declared twice", () => {
    const clash = problemsOf({
      "../features/a/routes.tsx": mod(
        valid({
          id: "a",
          routes: [
            { path: "a", element: null },
            { path: "a", element: null },
          ],
        }),
      ),
    });
    expect(clash).toContain('route path "a" is already used by');
  });

  it.each([
    ["an unknown resource", { resource: "comments", level: "read" }],
    ["level none", { resource: "ideas", level: "none" }],
    ["an empty list", []],
    ["a string other than any", "everyone"],
    ["a missing value", undefined],
  ])("rejects requires with %s", (_name, requires) => {
    expect(
      problemsOf({
        "../features/ideas/routes.tsx": mod({ ...valid(), requires }),
      }),
    ).toContain("requires must be");
  });

  it.each([
    ["label", { label: "", icon: Lightbulb, order: 1 }, "nav.label is required"],
    ["icon", { label: "X", icon: "star", order: 1 }, "nav.icon must be an icon component"],
    ["order", { label: "X", icon: Lightbulb, order: Number.NaN }, "nav.order must be a number"],
    [
      "target",
      { label: "X", icon: Lightbulb, order: 1, to: "/elsewhere" },
      "nav.to must be /ideas or below it",
    ],
  ])("rejects a nav item with a bad %s", (_name, nav, message) => {
    expect(problemsOf({ "../features/ideas/routes.tsx": mod({ ...valid(), nav }) })).toContain(
      message,
    );
  });

  it("reports every problem at once, naming the files", () => {
    const message = problemsOf({
      "../features/ideas/routes.tsx": mod(valid({ routes: [] })),
      "../features/scripts/routes.tsx": {},
    });
    expect(message).toContain("../features/ideas/routes.tsx");
    expect(message).toContain("../features/scripts/routes.tsx");
    expect(message.split("\n- ").length).toBeGreaterThanOrEqual(3);
  });
});

describe("navEntriesFor", () => {
  const features = discoverFeatures(fixtureModules);
  const ids = (levels: Parameters<typeof sessionWith>[0]) =>
    navEntriesFor(features, sessionWith(levels).levels).map((e) => e.id);

  it("shows a feature only when the stored levels satisfy its requirement", () => {
    expect(ids({ ideas: "read" })).toEqual(["alpha", "delta"]);
    expect(ids({ ideas: "read", scripts: "write" })).toEqual(["beta", "alpha", "delta"]);
    expect(ids({ scripts: "read" })).toEqual(["delta"]);
  });

  it("treats a list of requirements as any-of", () => {
    expect(ids({ activity: "read" })).toEqual(["gamma", "delta"]);
    expect(ids({ experiments: "write" })).toEqual(["gamma", "delta"]);
    expect(ids({ experiments: "read" })).toEqual(["delta"]);
  });

  it('"any" needs some access, a feature without nav never appears, and None everywhere shows nothing', () => {
    expect(ids({})).toEqual([]);
    expect(ids({ videos: "read" })).toEqual(["delta"]);
    expect(ids({ ideas: "write" })).not.toContain("hidden");
  });

  it("links to /<id> unless the feature says otherwise", () => {
    const entries = navEntriesFor(
      [valid({ nav: { label: "Ideas", icon: Lightbulb, order: 1, to: "/ideas/board" } })],
      sessionWith({ ideas: "read" }).levels,
    );
    expect(entries[0]?.to).toBe("/ideas/board");
    expect(navEntriesFor(features, sessionWith({ ideas: "read" }).levels)[0]?.to).toBe("/alpha");
  });
});
