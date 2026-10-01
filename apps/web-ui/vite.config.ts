import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

// In development the SPA runs on Vite's dev server and proxies API and auth routes to the web
// server (default port 3000), so the browser sees a single origin, as in production where the web
// server serves the built SPA itself.
const webServerUrl = "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // "@ytw/source" resolves workspace packages to their TypeScript sources (see vitest.shared.ts).
    conditions: ["@ytw/source", ...defaultClientConditions],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": webServerUrl,
      "/auth": webServerUrl,
    },
  },
});
