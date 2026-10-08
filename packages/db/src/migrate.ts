/**
 * The migration runner behind `pnpm migrate` and the server's boot.
 *
 * - Files are `migrations/NNNN_name.sql`, applied in order, each in its own transaction together
 *   with its `schema_migrations` row, so a file is either fully applied or not at all. A file may
 *   not contain transaction control (COMMIT, ROLLBACK, ...): such files are rejected before anything
 *   runs, and a file that ends the transaction anyway is detected and fails.
 * - Applied files are immutable: the runner stores a SHA-256 checksum and refuses to run when an
 *   applied file was edited, renamed or deleted, or when a pending file is older than the newest
 *   applied one.
 * - A session-level advisory lock in the target database serialises runs, so replicas booting at
 *   the same moment migrate once.
 * - It runs as the role that owns the database and needs nothing more.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type DatabaseError } from "pg";
import type { Queryable } from "./client.js";
import { isPgError } from "./errors.js";

/** Advisory lock key held for a whole run ("ytw_migr" as eight ASCII bytes). */
export const MIGRATION_LOCK_KEY = "8751751227628939122";

const FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const BYTE_ORDER_MARK = 0xfeff;

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
  /** Connection to the target database (`DATABASE_URL`): the role that owns it. */
  databaseUrl: string;
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

/** A top-level transaction-control statement found in a migration file. */
export interface TransactionControlStatement {
  /** The statement's leading keyword(s), e.g. `COMMIT` or `PREPARE TRANSACTION`. */
  readonly statement: string;
  /** 1-based line where the statement starts. */
  readonly line: number;
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
    const withoutBom = raw.charCodeAt(0) === BYTE_ORDER_MARK ? raw.slice(1) : raw;
    const normalized = withoutBom.replace(/\r\n/g, "\n");
    for (const control of findTransactionControl(normalized)) {
      problems.push(
        `${entry.name}: line ${control.line}: ${control.statement} is not allowed; every file runs ` +
          "in one transaction that the runner commits (SQL-standard BEGIN ATOMIC bodies count too: " +
          "quote function bodies with $$)",
      );
    }
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
 * Applies every pending migration. Safe to run repeatedly and concurrently; a second run with
 * nothing to do applies nothing.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const files = await loadMigrations(options.migrationsDir);
  const lockTimeoutMs = options.lockTimeoutMs ?? 300_000;

  const client = new Client({
    connectionString: options.databaseUrl,
    application_name: "ytw-migrate",
  });
  client.on("notice", (notice) => log(`notice: ${notice.message}`));

  try {
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
    return { applied: appliedNow, alreadyApplied: applied.length };
  } finally {
    // Ending the session releases the advisory lock.
    await client.end().catch(() => undefined);
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

const TRANSACTION_CONTROL = new Set([
  "ABORT",
  "BEGIN",
  "COMMIT",
  "END",
  "RELEASE",
  "ROLLBACK",
  "SAVEPOINT",
  "START",
]);
// Postgres treats every non-ASCII character as an identifier character.
const DOLLAR_TAG = /\$(?:(?:[A-Za-z_]|\P{ASCII})(?:\w|\P{ASCII})*)?\$/uy;
const WORD = /(?:[A-Za-z_]|\P{ASCII})(?:[\w$]|\P{ASCII})*/uy;

/**
 * Finds top-level transaction-control statements (BEGIN, START, COMMIT, END, ROLLBACK, ABORT,
 * SAVEPOINT, RELEASE, PREPARE TRANSACTION) in SQL text. A small lexer that follows Postgres's rules
 * for comments (nested block comments too), string literals (standard and E'' escape strings),
 * quoted identifiers and dollar quoting, so keywords inside function bodies, strings and comments
 * are ignored. SQL-standard function bodies (`BEGIN ATOMIC ... END`) contain unquoted semicolons
 * and are reported as well; quote function bodies with `$$` instead.
 */
export function findTransactionControl(sql: string): TransactionControlStatement[] {
  const found: TransactionControlStatement[] = [];
  // The statement's first two tokens: words upper-cased, "" for anything else.
  let leading: string[] = [];
  let leadingLine = 1;
  let line = 1;
  let i = 0;

  const token = (word: string): void => {
    if (leading.length === 0) {
      leadingLine = line;
    }
    if (leading.length < 2) {
      leading.push(word);
    }
  };
  const endStatement = (): void => {
    const [first = "", second = ""] = leading;
    if (TRANSACTION_CONTROL.has(first)) {
      found.push({ statement: first, line: leadingLine });
    } else if (first === "PREPARE" && second === "TRANSACTION") {
      found.push({ statement: "PREPARE TRANSACTION", line: leadingLine });
    }
    leading = [];
  };
  const advanceTo = (end: number): void => {
    for (let j = i; j < end; j += 1) {
      if (sql.charCodeAt(j) === 10) {
        line += 1;
      }
    }
    i = end;
  };
  const skipQuoted = (quote: string, backslashEscapes: boolean): void => {
    let j = i + 1;
    while (j < sql.length) {
      const ch = sql[j];
      if (backslashEscapes && ch === "\\") {
        j += 2;
      } else if (ch === quote && sql[j + 1] === quote) {
        j += 2;
      } else if (ch === quote) {
        advanceTo(j + 1);
        return;
      } else {
        j += 1;
      }
    }
    advanceTo(sql.length);
  };

  while (i < sql.length) {
    const ch = sql[i] as string;
    if (ch === "\n") {
      line += 1;
      i += 1;
    } else if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      advanceTo(end === -1 ? sql.length : end);
    } else if (ch === "/" && sql[i + 1] === "*") {
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth += 1;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth -= 1;
          j += 2;
          if (depth === 0) {
            break;
          }
        } else {
          j += 1;
        }
      }
      advanceTo(Math.min(j, sql.length));
    } else if (ch === ";") {
      endStatement();
      i += 1;
    } else if (ch === "'" || ch === '"') {
      token("");
      skipQuoted(ch, false);
    } else if (ch === "$") {
      token("");
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(sql)?.[0];
      if (tag === undefined) {
        i += 1;
      } else {
        const close = sql.indexOf(tag, i + tag.length);
        advanceTo(close === -1 ? sql.length : close + tag.length);
      }
    } else {
      WORD.lastIndex = i;
      const word = WORD.exec(sql)?.[0];
      if (word === undefined) {
        token("");
        i += 1;
      } else if ((word === "E" || word === "e") && sql[i + 1] === "'") {
        token("");
        i += 1;
        skipQuoted("'", true);
      } else {
        token(word.toUpperCase());
        i += word.length;
      }
    }
  }
  endStatement();
  return found;
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
    const xidBefore = await currentXid(client, "SELECT pg_current_xact_id()::text AS xid");
    try {
      await client.query(file.sql);
    } catch (err) {
      throw new MigrationError(describeFailure(file, err), { cause: err });
    }
    // Backstop for transaction control the file scan did not catch: the transaction must still
    // be the one opened above.
    const xidAfter = await currentXid(
      client,
      "SELECT pg_current_xact_id_if_assigned()::text AS xid",
    );
    if (xidAfter !== xidBefore) {
      throw new MigrationError(
        `${file.filename} ended the migration's transaction (COMMIT, ROLLBACK or similar); ` +
          "statements before that point may have been committed without a schema_migrations row. " +
          "Inspect the database before running the migrations again.",
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

async function currentXid(client: Client, sql: string): Promise<string | null> {
  const { rows } = await client.query<{ xid: string | null }>(sql);
  return rows[0]?.xid ?? null;
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
