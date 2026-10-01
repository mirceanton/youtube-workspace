import { defineConfig, mergeConfig } from "vitest/config";
import { baseProjectConfig } from "../../vitest.shared.ts";

// The policy layer decides who may do what, so every branch must be exercised by a test (T20).
// `pnpm --filter @ytw/policy test` runs with `--coverage` and fails below 100 % on any metric.
// The root `pnpm test` loads this file as a project; vitest applies coverage settings only from the
// root config, so there the thresholds are inert and the package-scoped run is the gate.
export default mergeConfig(
  baseProjectConfig,
  defineConfig({
    test: {
      name: "@ytw/policy",
      coverage: {
        provider: "v8",
        include: ["src/**/*.ts"],
        reporter: ["text", "json-summary"],
        thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
      },
    },
  }),
);
