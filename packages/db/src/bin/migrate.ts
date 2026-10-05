#!/usr/bin/env node
/**
 * `pnpm migrate` (development, loads the root .env) and `node packages/db/dist/src/bin/migrate.js`
 * (deployments). Reads DATABASE_URL and the optional MIGRATION_LOCK_DATABASE_URL (see .env.example).
 * Exit codes: 0 done, 1 failed (nothing of a failed file is applied), 2 DATABASE_URL unset.
 */
import { MigrationError, migrate } from "../migrate.js";

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
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error(
      "DATABASE_URL is not set. Pass the connection string to this command, " +
        "e.g. `DATABASE_URL=postgres://... ytw-migrate` (see .env.example).",
    );
    return 2;
  }

  const lockDatabaseUrl = process.env.MIGRATION_LOCK_DATABASE_URL?.trim();

  // Never print the URL itself: it carries the password.
  console.log(`@ytw/db: migrating ${describeTarget(databaseUrl)}`);
  const result = await migrate({
    databaseUrl,
    ...(lockDatabaseUrl === undefined || lockDatabaseUrl === "" ? {} : { lockDatabaseUrl }),
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
