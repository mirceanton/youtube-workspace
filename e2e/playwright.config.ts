import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const e2eDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(e2eDirectory, "..");
const mode = process.env.E2E_IDP ?? "mock";
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
const issuer =
  process.env.OIDC_ISSUER_URL ??
  (mode === "mock"
    ? "http://127.0.0.1:4100/realms/youtube-workspace"
    : "http://localhost:8080/realms/youtube-workspace");
const redirectUri = `${baseURL}/auth/callback`;
const clientId = "youtube-workspace";
const clientSecret = "dev-only-secret";
const sessionSecret = process.env.E2E_SESSION_SECRET ?? randomBytes(48).toString("base64url");
const mockAdminToken = process.env.E2E_MOCK_ADMIN_TOKEN ?? "ytw-e2e-local-mock-admin";
const node = process.execPath;

const webServerEnvironment = {
  ...process.env,
  HOST: "127.0.0.1",
  DATABASE_URL: process.env.E2E_WEB_DATABASE_URL ?? "",
  OIDC_ISSUER_URL: issuer,
  OIDC_CLIENT_ID: clientId,
  OIDC_CLIENT_SECRET: clientSecret,
  OIDC_REDIRECT_URI: redirectUri,
  OIDC_GROUPS_CLAIM_PATH: "groups",
  OIDC_REQUIRED_GROUP: "youtube-workspace-users",
  SESSION_SECRET: sessionSecret,
  LOG_LEVEL: "warn",
};

const mcpServerEnvironment = {
  ...process.env,
  HOST: "127.0.0.1",
  DATABASE_URL: process.env.E2E_MCP_DATABASE_URL ?? "",
  READONLY_DATABASE_URL: process.env.E2E_READONLY_DATABASE_URL ?? "",
  LOG_LEVEL: "warn",
};

const servers = [
  ...(mode === "mock"
    ? [
        {
          command: `${node} --conditions=@ytw/source --import tsx e2e/src/mock-idp.ts`,
          cwd: repositoryRoot,
          env: {
            ...process.env,
            MOCK_OIDC_PORT: "4100",
            MOCK_OIDC_ISSUER: issuer,
            E2E_MOCK_ADMIN_TOKEN: mockAdminToken,
            OIDC_CLIENT_ID: clientId,
            OIDC_CLIENT_SECRET: clientSecret,
            OIDC_REDIRECT_URI: redirectUri,
          },
          url: "http://127.0.0.1:4100/healthz",
          name: "Mock OIDC provider",
          timeout: 30_000,
          reuseExistingServer: false,
        },
      ]
    : []),
  {
    command: `${node} --conditions=@ytw/source --import tsx apps/web-server/src/index.ts`,
    cwd: repositoryRoot,
    env: { ...webServerEnvironment, PORT: "3000" },
    url: "http://127.0.0.1:3000/readyz",
    name: "Web server",
    timeout: 120_000,
    reuseExistingServer: false,
  },
  {
    command: `${node} --conditions=@ytw/source --import tsx apps/mcp/src/index.ts`,
    cwd: repositoryRoot,
    env: { ...mcpServerEnvironment, PORT: "3001" },
    url: "http://127.0.0.1:3001/readyz",
    name: "MCP server",
    timeout: 120_000,
    reuseExistingServer: false,
  },
  {
    command: "./node_modules/.bin/vite --host 127.0.0.1 --port 5173 --strictPort",
    cwd: resolve(repositoryRoot, "apps/web-ui"),
    env: {
      ...process.env,
      WEB_UI_PORT: "5173",
      WEB_SERVER_URL: "http://127.0.0.1:3000",
    },
    url: baseURL,
    name: "Web UI",
    timeout: 120_000,
    reuseExistingServer: false,
  },
];

export default defineConfig({
  testDir: "./flows",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: "line",
  outputDir: join(tmpdir(), `ytw-e2e-${process.pid}`),
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: servers,
});
