// @vitest-environment node
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build, type InlineConfig } from "vite";
import { describe, expect, it } from "vitest";

// Bundle-size rules (CLAUDE.md "Bundle size", ADR 0001), checked on real production builds:
//  - the initial download (entry chunk plus everything it imports statically) has no zod, no uPlot,
//    no markdown renderer, no dev-only mock layer or kit gallery;
//  - those heavy parts exist as separate lazy chunks once a feature uses them;
//  - the initial JavaScript stays inside a budget.

const appRoot = resolve(import.meta.dirname, "../..");

/** Strings that only the named dependency (or dev-only module) contributes to a bundle. */
const MARKERS = {
  zod: "Invalid input: expected",
  uplot: "u-wrap",
  markdown: "data-footnote-backref",
  mockApi: "The mock API has no",
  gallery: "Every shared component with mock data",
} as const;

/** Initial JavaScript budget, gzipped. The shell is about 118 kB today (React, router, Query, icons). */
const INITIAL_JS_GZIP_BUDGET = 150 * 1024;

interface Chunk {
  type: "chunk";
  fileName: string;
  code: string;
  isEntry: boolean;
  imports: string[];
  dynamicImports: string[];
}

async function bundle(overrides: InlineConfig = {}): Promise<Chunk[]> {
  // Vitest sets NODE_ENV=test, which would make Vite build React in development mode and keep
  // `import.meta.env.DEV` true. A real `vite build` runs with NODE_ENV=production.
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const result = await build({
      root: appRoot,
      configFile: resolve(appRoot, "vite.config.ts"),
      mode: "production",
      logLevel: "silent",
      ...overrides,
      build: { write: false, ...overrides.build },
    });
    const outputs = Array.isArray(result) ? result : [result];
    return outputs.flatMap((output) =>
      "output" in output
        ? (output.output.filter((item) => item.type === "chunk") as unknown as Chunk[])
        : [],
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

/** The entry chunk and every chunk reachable from it through static imports: what the browser must download first. */
function initialChunks(chunks: Chunk[]): Chunk[] {
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const seen = new Set<string>();
  const queue = chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName);
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...(byName.get(name)?.imports ?? []));
  }
  return [...seen].flatMap((name) => byName.get(name) ?? []);
}

function containing(chunks: Chunk[], marker: string): string[] {
  return chunks.filter((chunk) => chunk.code.includes(marker)).map((chunk) => chunk.fileName);
}

describe("production bundle of the app", () => {
  it("ships the shell without zod, uPlot, the markdown renderer or any dev-only module", async () => {
    const chunks = await bundle();
    const initial = initialChunks(chunks);
    expect(initial.length).toBeGreaterThan(0);
    // Features intentionally emit lazy chunks. Check the initial download graph here; the heavy
    // fixture below verifies that its Zod/chart/Markdown dependencies exist only outside that graph.
    for (const [name, marker] of Object.entries(MARKERS)) {
      expect(containing(initial, marker), `${name} must not be in the initial download`).toEqual(
        [],
      );
    }
    for (const name of ["mockApi", "gallery"] as const) {
      expect(
        containing(chunks, MARKERS[name]),
        `${name} must not be emitted in any production chunk`,
      ).toEqual([]);
    }
  });

  it("keeps the initial JavaScript inside the budget", async () => {
    const chunks = await bundle();
    const gzipped = initialChunks(chunks).reduce(
      (total, chunk) => total + gzipSync(chunk.code).length,
      0,
    );
    expect(gzipped, `initial JS is ${(gzipped / 1024).toFixed(1)} kB gzipped`).toBeLessThan(
      INITIAL_JS_GZIP_BUDGET,
    );
  });
});

async function heavyBuild() {
  return bundle({
    build: {
      rolldownOptions: { input: resolve(appRoot, "test/bundle-fixture/entry.tsx") },
    },
  });
}

describe("a feature that uses the heavy kit components", () => {
  it("loads zod, uPlot and the markdown renderer lazily, never with the initial download", async () => {
    const chunks = await heavyBuild();
    const initial = new Set(initialChunks(chunks).map((chunk) => chunk.fileName));
    for (const key of ["zod", "uplot", "markdown"] as const) {
      const holders = containing(chunks, MARKERS[key]);
      expect(
        holders.length,
        `${key} should be bundled somewhere (marker check works)`,
      ).toBeGreaterThan(0);
      for (const holder of holders) {
        expect(
          initial.has(holder),
          `${key} is in ${holder}, which is part of the initial download`,
        ).toBe(false);
      }
    }
  });

  it("splits uPlot and the markdown renderer into their own chunks, away from the feature page", async () => {
    const chunks = await heavyBuild();
    expect(containing(chunks, MARKERS.uplot)).not.toEqual(containing(chunks, MARKERS.markdown));
    expect(chunks.length).toBeGreaterThanOrEqual(4);
  });
});
