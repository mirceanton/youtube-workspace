import { defineProject } from "vitest/config";

/**
 * Export condition that maps every `@ytw/*` workspace import to its TypeScript source
 * (see the `exports` map in each package.json). Vitest, tsx and Vite use it so that tests and
 * dev servers never depend on a prior build; `node dist/...` in production ignores it.
 */
export const SOURCE_CONDITION = "@ytw/source";

/**
 * Base for every package's vitest.config.ts. Merge it with `mergeConfig` and add the project name
 * plus anything package-specific (environment, setup files, timeouts).
 */
export const baseProjectConfig = defineProject({
  resolve: {
    conditions: [SOURCE_CONDITION],
  },
  ssr: {
    resolve: {
      conditions: [SOURCE_CONDITION],
    },
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    // Same cap as the root config, so package-scoped runs (`pnpm --filter <pkg> test`) stay modest.
    maxWorkers: 2,
  },
});
