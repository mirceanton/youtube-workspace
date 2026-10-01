import { defineProject, mergeConfig } from "vitest/config";
import { baseProjectConfig } from "../vitest.shared.ts";

// Cross-cutting suites live in subdirectories (security/, perf/, workspace/) rather than src/ or
// test/, so this project also picks up any *.test.ts below it.
export default mergeConfig(
  baseProjectConfig,
  defineProject({
    test: {
      name: "@ytw/tests",
      include: ["**/*.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
    },
  }),
);
