import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, loadEnv } from "vite";

// In development the SPA runs on Vite's dev server and proxies API and auth routes to the web
// server, so the browser sees a single origin, as in production where the web server serves the
// built SPA itself. Only these two variables are read, from the shell or the repository-root .env.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const env = loadEnv("development", repoRoot, ["WEB_UI_PORT", "WEB_SERVER_URL"]);

const port = Number(env.WEB_UI_PORT || 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`WEB_UI_PORT must be a port number, got "${env.WEB_UI_PORT}"`);
}
const webServerUrl = env.WEB_SERVER_URL || "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // "@ytw/source" resolves workspace packages to their TypeScript sources (see vitest.shared.ts).
    conditions: ["@ytw/source", ...defaultClientConditions],
  },
  server: {
    // If the port is taken Vite moves to the next free one; set WEB_UI_PORT when the OIDC redirect
    // URI must match exactly.
    port,
    proxy: {
      "/api": webServerUrl,
      "/auth": webServerUrl,
    },
  },
});
