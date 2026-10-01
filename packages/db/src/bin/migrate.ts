#!/usr/bin/env node
/**
 * `pnpm migrate` (development, loads the root .env) and `node packages/db/dist/src/bin/migrate.js`
 * (deployments). Reads MIGRATION_DATABASE_URL, the optional YTW_*_PASSWORD variables and the
 * optional MIGRATION_LOCK_DATABASE_URL (see .env.example).
 * Exit codes: 0 done, 1 failed (nothing of a failed file is applied), 2 MIGRATION_DATABASE_URL unset.
 */
import { APP_ROLES, type AppRole } from "../client.js";
import { MigrationError, ROLE_PASSWORD_ENV, migrate } from "../migrate.js";

function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "(default)";
    const user = decodeURIComponent(parsed.username) || "(default user)";
    return `database ${database} on ${parsed.host || "(local socket)"} as ${user}`;
  } catch {
    return "the configured database";
  }
}

async function main(): Promise<number> {
  const databaseUrl = process.env.MIGRATION_DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error(
      "MIGRATION_DATABASE_URL is not set. Pass the privileged connection string to this command " +
        "only, e.g. `MIGRATION_DATABASE_URL=postgres://... pnpm migrate` (see .env.example).",
    );
    return 2;
  }

  const rolePasswords: Partial<Record<AppRole, string>> = {};
  for (const role of APP_ROLES) {
    const value = process.env[ROLE_PASSWORD_ENV[role]];
    if (value !== undefined && value !== "") {
      rolePasswords[role] = value;
    }
  }

  const lockDatabaseUrl = process.env.MIGRATION_LOCK_DATABASE_URL?.trim();

  // Never print the URL itself: it carries the password.
  console.log(`@ytw/db: migrating ${describeTarget(databaseUrl)}`);
  const result = await migrate({
    databaseUrl,
    ...(lockDatabaseUrl === undefined || lockDatabaseUrl === "" ? {} : { lockDatabaseUrl }),
    rolePasswords,
    log: (line) => {
      console.log(`  ${line}`);
    },
  });
  console.log(
    `@ytw/db: done, ${result.applied.length} applied, ${result.alreadyApplied} already applied`,
  );
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    err instanceof MigrationError ? `@ytw/db: ${message}` : `@ytw/db: migration failed: ${message}`,
  );
  process.exitCode = 1;
}
