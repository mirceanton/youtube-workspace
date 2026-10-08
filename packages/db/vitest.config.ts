import { defineProject, mergeConfig } from "vitest/config";
import { baseProjectConfig } from "../../vitest.shared.ts";

export default mergeConfig(
  baseProjectConfig,
  defineProject({
    test: {
      name: "@ytw/db",
      // Every file creates and migrates its own database.
      hookTimeout: 60_000,
      testTimeout: 30_000,
    },
  }),
);
