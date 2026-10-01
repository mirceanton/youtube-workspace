// Helpers shared by the @ytw/db tests (not a test file itself).
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultMigrationsDir } from "../src/migrate.js";

/** Runs `promise`, expects it to fail, and returns the error. */
export async function failure(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) {
      return err as Error & Record<string, unknown>;
    }
    throw new Error(`rejected with a non-Error: ${String(err)}`);
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** The SQLSTATE of the error `promise` fails with. */
export async function sqlstate(promise: Promise<unknown>): Promise<string> {
  const err = await failure(promise);
  const code = err.code ?? (err.cause as Record<string, unknown> | undefined)?.code;
  return typeof code === "string" ? code : `no SQLSTATE: ${err.message}`;
}

/** A temporary copy of the real migrations directory, for tests that add or edit files. */
export async function copyMigrations(): Promise<{ dir: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ytw-db-migrations-"));
  await cp(defaultMigrationsDir(), dir, { recursive: true });
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}
