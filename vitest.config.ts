import { defineConfig } from "vitest/config";

// `pnpm test` runs every package's tests in one vitest process. Each package keeps its own
// vitest.config.ts (built on vitest.shared.ts) so package-scoped runs behave the same way.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
    maxWorkers: 2,
  },
});
