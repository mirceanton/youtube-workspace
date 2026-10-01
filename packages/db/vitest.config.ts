import { defineProject, mergeConfig } from "vitest/config";
import { baseProjectConfig } from "../../vitest.shared.ts";

export default mergeConfig(
  baseProjectConfig,
  defineProject({
    test: {
      name: "@ytw/db",
      // Every file creates and migrates its own database; migrations of different databases share
      // one cluster-wide lock, so setup can queue behind other workers' runs.
      hookTimeout: 120_000,
      testTimeout: 60_000,
    },
  }),
);
