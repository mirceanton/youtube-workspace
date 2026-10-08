#!/usr/bin/env node
/**
 * `pnpm migrate` (development; loads apps/server/.env when it exists) and
 * `node packages/db/dist/src/bin/migrate.js` (deployments). Reads DATABASE_URL.
 * Exit codes: 0 done, 1 failed (nothing of a failed file is applied), 2 DATABASE_URL unset.
 */
import { MigrationError, migrate } from "../migrate.js";

/** Names the target without its password. */
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
      "DATABASE_URL is not set. Pass the connection string of the role that owns the database, " +
        "e.g. `DATABASE_URL=postgres://app:secret@localhost:5432/app pnpm migrate`.",
    );
    return 2;
  }

  console.log(`@ytw/db: migrating ${describeTarget(databaseUrl)}`);
  const result = await migrate({
    databaseUrl,
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
