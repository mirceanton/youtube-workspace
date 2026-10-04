import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "@ytw/db/testing";

const e2eDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(e2eDirectory, "..");
const mode = process.env.E2E_IDP ?? "mock";

if (mode !== "mock" && mode !== "keycloak") {
  throw new Error("E2E_IDP must be either mock or keycloak");
}

function startPlaywright(environment: NodeJS.ProcessEnv): Promise<number> {
  const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  const child = spawn(
    process.execPath,
    [cli, "test", "--config", resolve(e2eDirectory, "playwright.config.ts")],
    { cwd: repositoryRoot, env: environment, stdio: "inherit" },
  );
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal === "SIGINT" ? 130 : 1)));
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => child.kill(signal));
    }
  });
}

async function main(): Promise<void> {
  let testDb: Awaited<ReturnType<typeof createTestDb>> | undefined;
  try {
    testDb = await createTestDb();
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      E2E_IDP: mode,
      E2E_DATABASE_URL: testDb.url("admin"),
      E2E_WEB_DATABASE_URL: testDb.url("ytw_web"),
      E2E_MCP_DATABASE_URL: testDb.url("ytw_mcp"),
      E2E_READONLY_DATABASE_URL: testDb.url("ytw_readonly"),
      OIDC_ISSUER_URL:
        mode === "mock"
          ? "http://127.0.0.1:4100/realms/youtube-workspace"
          : `${(process.env.KEYCLOAK_URL ?? "http://localhost:8080").replace(/\/$/, "")}/realms/youtube-workspace`,
      E2E_MOCK_ADMIN_TOKEN: process.env.E2E_MOCK_ADMIN_TOKEN ?? "ytw-e2e-local-mock-admin",
    };
    process.stdout.write(`[e2e] Running ${mode} identity-provider scenario.\n`);
    process.exitCode = await startPlaywright(environment);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown setup error";
    process.stderr.write(`[e2e] Setup failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    if (testDb !== undefined) {
      try {
        await testDb.drop();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown cleanup error";
        process.stderr.write(`[e2e] Could not drop its disposable database: ${message}\n`);
        process.exitCode = 1;
      }
    }
  }
}

await main();
