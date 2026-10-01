import { defineProject, mergeConfig } from "vitest/config";
import { baseProjectConfig } from "../../vitest.shared.ts";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  mergeConfig(viteConfig, baseProjectConfig),
  defineProject({ test: { name: "@ytw/web-ui", environment: "jsdom" } }),
);
