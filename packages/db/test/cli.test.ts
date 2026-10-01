// The `pnpm migrate` entry point, run as a real child process.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations } from "../src/migrate.js";
import { createTestDb, testRolePasswords, testServerUrl, type TestDb } from "../src/testing.js";

const CLI = fileURLToPath(new URL("../src/bin/migrate.ts", import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb({ migrate: false });
});

afterAll(async () => {
  await db.drop();
});

function cli(env: Record<string, string | undefined>): Promise<{ code: number; out: string }> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined && !key.startsWith("YTW_") && !key.startsWith("MIGRATION_")) {
      childEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "--conditions=@ytw/source", CLI],
      { cwd: PACKAGE_DIR, env: childEnv, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

function passwordEnv(): Record<string, string> {
  const passwords = testRolePasswords();
  return {
    YTW_WEB_PASSWORD: passwords.ytw_web,
    YTW_MCP_PASSWORD: passwords.ytw_mcp,
    YTW_READONLY_PASSWORD: passwords.ytw_readonly,
  };
}

describe("migrate CLI", () => {
  it("applies everything, then nothing on the second run, without printing secrets", async () => {
    const files = await loadMigrations();
    const env = {
      MIGRATION_DATABASE_URL: db.url("admin"),
      MIGRATION_LOCK_DATABASE_URL: testServerUrl(),
      ...passwordEnv(),
    };

    const first = await cli(env);
    expect(first).toMatchObject({ code: 0 });
    expect(first.out).toContain(`migrating database ${db.name} on`);
    expect(first.out).toContain("applied 0001_roles.sql");
    expect(first.out).toContain("ytw_readonly: password set");
    expect(first.out).toContain(`done, ${files.length} applied, 0 already applied`);

    const second = await cli(env);
    expect(second).toMatchObject({ code: 0 });
    expect(second.out).toContain(`done, 0 applied, ${files.length} already applied`);

    // The dev superuser's password equals its name, so check for the URL instead; the failure
    // test below uses a distinctive password.
    for (const secret of [...Object.values(passwordEnv()), db.url("admin"), ":postgres@"]) {
      expect(first.out + second.out).not.toContain(secret);
    }
  });

  it("leaves role passwords alone when none are configured", async () => {
    const run = await cli({
      MIGRATION_DATABASE_URL: db.url("admin"),
      MIGRATION_LOCK_DATABASE_URL: testServerUrl(),
    });
    expect(run).toMatchObject({ code: 0 });
    expect(run.out).toContain("ytw_web: no password given, left unchanged");
  });

  it("exits 2 when MIGRATION_DATABASE_URL is missing", async () => {
    const run = await cli({ MIGRATION_DATABASE_URL: "" });
    expect(run.code).toBe(2);
    expect(run.out).toMatch(/MIGRATION_DATABASE_URL is not set/);
  });

  it("exits 1 on failure without echoing the connection string's password", async () => {
    const run = await cli({
      MIGRATION_DATABASE_URL: "postgres://someone:hunter2-secret@127.0.0.1:1/nowhere",
    });
    expect(run.code).toBe(1);
    expect(run.out).toMatch(/migration failed/);
    expect(run.out).not.toContain("hunter2-secret");
  });
});
