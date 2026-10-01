/**
 * The migration runner behind `pnpm migrate` (PRD 9: "one command, safe to run repeatedly").
 *
 * - Files are `migrations/NNNN_name.sql`, applied in order, each in its own transaction together
 *   with its `schema_migrations` row, so a file is either fully applied or not at all.
 * - Applied files are immutable: the runner stores a SHA-256 checksum and refuses to run when an
 *   applied file was edited, renamed or deleted, or when a pending file is older than the newest
 *   applied one.
 * - A session-level advisory lock serialises runs. Roles are cluster-wide, so runners that migrate
 *   different databases of one cluster at the same time (the test harness) also share a lock taken
 *   in one common database (`lockDatabaseUrl`).
 * - After each file the catalog guard `ytw_catalog_violations()` (migration 0002) must return no
 *   rows, otherwise the file is rolled back.
 * - Role passwords come from the caller (the CLI reads them from the environment), are sent as
 *   SCRAM-SHA-256 verifiers and are never logged.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, DatabaseError } from "pg";
import { APP_ROLES, type AppRole, type Queryable } from "./client.js";
import { isPgError } from "./errors.js";

/** Environment variable that carries each role's password for `pnpm migrate`. */
export const ROLE_PASSWORD_ENV: Readonly<Record<AppRole, string>> = {
  ytw_web: "YTW_WEB_PASSWORD",
  ytw_mcp: "YTW_MCP_PASSWORD",
  ytw_readonly: "YTW_READONLY_PASSWORD",
};

/**
 * Advisory lock keys held for a whole run: one in the target database ("ytw_migr" as eight ASCII
 * bytes) and, with `lockDatabaseUrl`, one in the shared lock database ("ytw_clus"). Distinct keys
 * mean a lock database that happens to be the target database cannot deadlock a run with itself.
 */
export const MIGRATION_LOCK_KEY = "8751751227628939122";
export const CLUSTER_LOCK_KEY = "8751751227461367155";

const FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const PASSWORD_PATTERN = /^[\x21-\x7e]{16,256}$/;
const SCRAM_ITERATIONS = 4096;

/** Any problem the runner detects itself (bad files, checksum drift, a failed file, lock timeout). */
export class MigrationError extends Error {
  override name = "MigrationError";
}

export interface MigrationFile {
  /** Four-digit number, e.g. `0004`. */
  readonly version: string;
  /** File name, e.g. `0004_audit.sql`. */
  readonly filename: string;
  readonly path: string;
  readonly sql: string;
  /** SHA-256 (hex) of the file with CRLF line endings normalised to LF and any BOM removed. */
  readonly checksum: string;
}

export interface MigrateOptions {
  /** Privileged connection to the target database (`MIGRATION_DATABASE_URL`). */
  databaseUrl: string;
  /**
   * Database whose advisory lock serialises runs across databases (default: the target only).
   * Give every runner that may run concurrently on one cluster the same value.
   */
  lockDatabaseUrl?: string;
  /** Passwords to set for the application roles after migrating; omitted roles are unchanged. */
  rolePasswords?: Partial<Record<AppRole, string>>;
  /** Directory with the `NNNN_name.sql` files (default: this package's `migrations/`). */
  migrationsDir?: string;
  /** Progress lines (never contains secrets). Default: silent. */
  log?: (line: string) => void;
  /** How long to wait for another run's lock before failing (default 5 minutes). */
  lockTimeoutMs?: number;
}

export interface MigrateResult {
  /** File names applied by this run, in order. */
  readonly applied: string[];
  /** Number of files that were already applied before this run. */
  readonly alreadyApplied: number;
  /** Roles whose password this run set. */
  readonly passwordsSet: AppRole[];
}

export interface MigrationStatus {
  /** True when every file is applied unchanged and the database knows no other file. */
  readonly upToDate: boolean;
  readonly applied: number;
  /** Files not applied yet. */
  readonly pending: string[];
  /** Applied files whose name or checksum differs from the file on disk. */
  readonly changed: string[];
  /** Applied versions with no file on disk (the database is newer than this code). */
  readonly unknown: string[];
}

interface AppliedRow {
  version: string;
  filename: string;
  checksum: string;
}

/** `packages/db/migrations`, found from this module whether it runs from `src/` or `dist/src/`. */
export function defaultMigrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "migrations"))) {
      return join(dir, "migrations");
    }
    dir = dirname(dir);
  }
  throw new MigrationError("cannot find the @ytw/db migrations directory");
}

/** Reads and validates the migration files, sorted by version. */
export async function loadMigrations(
  dir: string = defaultMigrationsDir(),
): Promise<MigrationFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const problems: string[] = [];
  const files: MigrationFile[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) {
      continue;
    }
    const match = FILE_PATTERN.exec(entry.name);
    if (match === null) {
      problems.push(
        `${entry.name}: migration files must be named NNNN_lower_snake_case.sql (four digits)`,
      );
      continue;
    }
    const version = match[1] as string;
    const previous = seen.get(version);
    if (previous !== undefined) {
      problems.push(`${entry.name}: version ${version} is already used by ${previous}`);
      continue;
    }
    seen.set(version, entry.name);
    const path = join(dir, entry.name);
    const raw = await readFile(path, "utf8");
    const normalized = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
    files.push({
      version,
      filename: entry.name,
      path,
      sql: normalized,
      checksum: createHash("sha256").update(normalized, "utf8").digest("hex"),
    });
  }

  if (problems.length > 0) {
    throw new MigrationError(`invalid migration files in ${dir}:\n- ${problems.join("\n- ")}`);
  }
  return files.toSorted((a, b) => a.version.localeCompare(b.version));
}

/**
 * Applies every pending migration, then the role passwords. Safe to run repeatedly and
 * concurrently; a second run with nothing to do applies nothing.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const files = await loadMigrations(options.migrationsDir);
  const passwords = validatePasswords(options.rolePasswords ?? {});
  const lockTimeoutMs = options.lockTimeoutMs ?? 300_000;

  const lockClient =
    options.lockDatabaseUrl === undefined
      ? undefined
      : new Client({
          connectionString: options.lockDatabaseUrl,
          application_name: "ytw-migrate-lock",
        });
  const client = new Client({
    connectionString: options.databaseUrl,
    application_name: "ytw-migrate",
  });
  client.on("notice", (notice) => log(`notice: ${notice.message}`));

  try {
    // Always cluster lock first, then database lock: a holder of the database lock never waits
    // for anything else, so runs cannot deadlock.
    if (lockClient !== undefined) {
      await lockClient.connect();
      await acquireLock(lockClient, CLUSTER_LOCK_KEY, lockTimeoutMs);
    }
    await client.connect();
    await acquireLock(client, MIGRATION_LOCK_KEY, lockTimeoutMs);

    if (!(await hasMigrationsTable(client))) {
      await client.query(`
        CREATE TABLE public.schema_migrations (
          version text PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
          filename text NOT NULL UNIQUE,
          checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
          applied_at timestamptz NOT NULL DEFAULT now(),
          applied_by text NOT NULL DEFAULT current_user,
          duration_ms integer NOT NULL
        )`);
    }
    const applied = await readApplied(client);
    const status = compare(files, applied);
    const problems = [
      ...status.changedDescriptions,
      ...status.unknown.map(
        (filename) =>
          `${filename} is recorded as applied but is missing from the migrations directory; ` +
          "this database is newer than the code being deployed",
      ),
    ];
    const newest = applied.at(-1)?.version;
    const outOfOrder =
      newest === undefined ? [] : status.pendingFiles.filter((file) => file.version < newest);
    for (const file of outOfOrder) {
      problems.push(
        `${file.filename} is pending but older than the newest applied migration (${newest}); ` +
          "number new migrations above every applied one (in development: recreate the database)",
      );
    }
    if (problems.length > 0) {
      throw new MigrationError(
        `refusing to migrate:\n- ${problems.join("\n- ")}\n` +
          "Applied migrations are immutable: revert the change and put it in a new migration.",
      );
    }

    const appliedNow: string[] = [];
    for (const file of status.pendingFiles) {
      const ms = await applyFile(client, file);
      appliedNow.push(file.filename);
      log(`applied ${file.filename} (${ms} ms)`);
    }
    if (appliedNow.length === 0) {
      log(`up to date: ${applied.length} migrations already applied`);
    }

    const passwordsSet: AppRole[] = [];
    for (const role of APP_ROLES) {
      const password = passwords[role];
      if (password === undefined) {
        log(`${role}: no password given, left unchanged`);
        continue;
      }
      await setRolePassword(client, role, password);
      passwordsSet.push(role);
      log(`${role}: password set`);
    }

    return { applied: appliedNow, alreadyApplied: applied.length, passwordsSet };
  } finally {
    // Ending the sessions releases the advisory locks.
    await client.end().catch(() => undefined);
    await lockClient?.end().catch(() => undefined);
  }
}

/** Compares the files on disk with `schema_migrations`, without changing anything. */
export async function migrationStatus(
  db: Queryable,
  migrationsDir?: string,
): Promise<MigrationStatus> {
  const files = await loadMigrations(migrationsDir);
  const applied = (await hasMigrationsTable(db)) ? await readApplied(db) : [];
  const status = compare(files, applied);
  return {
    upToDate:
      status.pendingFiles.length === 0 &&
      status.changed.length === 0 &&
      status.unknown.length === 0,
    applied: applied.length,
    pending: status.pendingFiles.map((file) => file.filename),
    changed: status.changed,
    unknown: status.unknown,
  };
}

/**
 * The SCRAM-SHA-256 verifier Postgres stores for `password` (RFC 5802/7677, the format of
 * `pg_authid.rolpassword`). Sending the verifier instead of the password keeps the plain text out of
 * server logs and statistics. Passwords are printable ASCII, for which SASLprep changes nothing.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

async function acquireLock(client: Client, key: string, timeoutMs: number): Promise<void> {
  await client.query(`SET lock_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`);
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [key]);
  } catch (err) {
    if (isPgError(err) && err.code === "55P03") {
      throw new MigrationError(
        `another migration run held the lock for more than ${Math.round(timeoutMs / 1000)} s; try again`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    await client.query("RESET lock_timeout");
  }
}

async function hasMigrationsTable(db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
  );
  return rows[0]?.present === true;
}

async function readApplied(db: Queryable): Promise<AppliedRow[]> {
  const { rows } = await db.query<AppliedRow>(
    "SELECT version, filename, checksum FROM public.schema_migrations ORDER BY version",
  );
  return rows;
}

function compare(files: MigrationFile[], applied: AppliedRow[]) {
  const byVersion = new Map(files.map((file) => [file.version, file]));
  const appliedVersions = new Set(applied.map((row) => row.version));
  const changed: string[] = [];
  const changedDescriptions: string[] = [];
  const unknown: string[] = [];

  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (file === undefined) {
      unknown.push(row.filename);
    } else if (file.filename !== row.filename) {
      changed.push(row.filename);
      changedDescriptions.push(`${row.filename} was applied but is now named ${file.filename}`);
    } else if (file.checksum !== row.checksum) {
      changed.push(row.filename);
      changedDescriptions.push(
        `${row.filename} was changed after it was applied (checksum ${row.checksum.slice(0, 12)} ` +
          `in the database, ${file.checksum.slice(0, 12)} on disk)`,
      );
    }
  }
  const pendingFiles = files.filter((file) => !appliedVersions.has(file.version));
  return { pendingFiles, changed, changedDescriptions, unknown };
}

async function applyFile(client: Client, file: MigrationFile): Promise<number> {
  const started = performance.now();
  await client.query("BEGIN");
  try {
    try {
      await client.query(file.sql);
    } catch (err) {
      throw new MigrationError(describeFailure(file, err), { cause: err });
    }
    const violations = await catalogViolations(client);
    if (violations.length > 0) {
      throw new MigrationError(
        `${file.filename} breaks the privilege rules (ytw_catalog_violations), rolled back:\n- ` +
          violations.map((v) => `${v.rule}: ${v.object} ${v.detail}`).join("\n- "),
      );
    }
    const ms = Math.round(performance.now() - started);
    await client.query(
      "INSERT INTO public.schema_migrations (version, filename, checksum, duration_ms) VALUES ($1, $2, $3, $4)",
      [file.version, file.filename, file.checksum, ms],
    );
    await client.query("COMMIT");
    return ms;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

async function catalogViolations(
  client: Client,
): Promise<{ rule: string; object: string; detail: string }[]> {
  const guard = await client.query<{ present: boolean }>(
    "SELECT to_regprocedure('public.ytw_catalog_violations()') IS NOT NULL AS present",
  );
  if (guard.rows[0]?.present !== true) {
    return [];
  }
  const { rows } = await client.query<{ rule: string; object: string; detail: string }>(
    "SELECT rule, object, detail FROM public.ytw_catalog_violations() ORDER BY 1, 2, 3",
  );
  return rows;
}

function describeFailure(file: MigrationFile, err: unknown): string {
  if (!isPgError(err)) {
    return `${file.filename} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  const pgErr = err as DatabaseError;
  const position = Number(pgErr.position);
  const where =
    Number.isInteger(position) && position > 0
      ? ` at line ${file.sql.slice(0, position - 1).split("\n").length}`
      : "";
  const lines = [`${file.filename} failed${where}: ${pgErr.message} (SQLSTATE ${pgErr.code})`];
  if (pgErr.detail) lines.push(`detail: ${pgErr.detail}`);
  if (pgErr.hint) lines.push(`hint: ${pgErr.hint}`);
  if (pgErr.where) lines.push(`context: ${pgErr.where}`);
  return lines.join("\n");
}

function validatePasswords(
  passwords: Partial<Record<AppRole, string>>,
): Partial<Record<AppRole, string>> {
  const result: Partial<Record<AppRole, string>> = {};
  for (const role of APP_ROLES) {
    const password = passwords[role];
    if (password === undefined || password === "") {
      continue;
    }
    if (!PASSWORD_PATTERN.test(password)) {
      throw new MigrationError(
        `the password for ${role} (${ROLE_PASSWORD_ENV[role]}) must be 16 to 256 printable ASCII ` +
          "characters without spaces, e.g. the output of `openssl rand -hex 24`",
      );
    }
    result[role] = password;
  }
  return result;
}

async function setRolePassword(client: Client, role: AppRole, password: string): Promise<void> {
  const exists = await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1", [role]);
  if (exists.rowCount === 0) {
    throw new MigrationError(`cannot set the password for ${role}: the role does not exist`);
  }
  // ALTER ROLE takes no bind parameters. The role name is one of the fixed APP_ROLES and the
  // verifier is base64 text; both are still escaped.
  const statement =
    `ALTER ROLE ${client.escapeIdentifier(role)} PASSWORD ` +
    client.escapeLiteral(scramSha256Verifier(password));
  try {
    await client.query(statement);
  } catch (err) {
    // Never echo the statement: it carries the verifier.
    const reason = isPgError(err) ? err.message : "unknown error";
    throw new MigrationError(`cannot set the password for ${role}: ${reason}`);
  }
}
