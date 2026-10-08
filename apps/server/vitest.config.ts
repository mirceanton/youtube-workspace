import { defineProject, mergeConfig } from "vitest/config";
import { baseProjectConfig } from "../../vitest.shared.ts";

export default mergeConfig(
  baseProjectConfig,
  defineProject({
    test: {
      name: "@ytw/server",
      hookTimeout: 120_000,
      testTimeout: 60_000,
    },
  }),
);
