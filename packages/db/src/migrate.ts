/**
 * The migration runner behind `pnpm migrate` (PRD 9: "one command, safe to run repeatedly").
 *
 * - Files are `migrations/NNNN_name.sql`, applied in order, each in its own transaction together
 *   with its `schema_migrations` row, so a file is either fully applied or not at all. A file may
 *   not contain transaction control (COMMIT, ROLLBACK, ...): such files are rejected before anything
 *   runs, and a file that ends the transaction anyway is detected and fails.
 * - Applied files are immutable: the runner stores a SHA-256 checksum and refuses to run when an
 *   applied file was edited, renamed or deleted, or when a pending file is older than the newest
 *   applied one.
 * - Session-level advisory locks serialise runs: one in the target database and, with
 *   `lockDatabaseUrl`, one in a database shared by every runner of the cluster (roles are
 *   cluster-wide, so runs migrating different databases must not interleave).
 * - Before applying anything, the application roles' settings are restored
 *   (`ytw_enforce_role_settings()`) and the catalog guard `ytw_catalog_violations()` must report
 *   nothing. After each file the guard runs again inside the file's transaction; any finding rolls
 *   the file back. Every guard run is self-tested with canary objects, so a migration cannot
 *   silently drop or weaken the guard.
 * - Role passwords come from the caller (the CLI reads them from the environment), are sent as
 *   SCRAM-SHA-256 verifiers, are left alone when the stored verifier already matches (readable by a
 *   superuser only), and are never logged.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type DatabaseError } from "pg";
import { APP_ROLES, type AppRole, type Queryable } from "./client.js";
import { isPgError } from "./errors.js";

/**
 * Advisory lock keys held for a whole run: one in the target database ("ytw_migr" as eight ASCII
 * bytes) and, with `lockDatabaseUrl`, one in the shared lock database ("ytw_clus"). Distinct keys
 * mean a lock database that happens to be the target database cannot deadlock a run with itself.
 */
export const MIGRATION_LOCK_KEY = "8751751227628939122";
export const CLUSTER_LOCK_KEY = "8751751227461367155";

/** @deprecated Database roles are deployment-owned and passwords are ignored. */
export const ROLE_PASSWORD_ENV: Readonly<Record<AppRole, string>> = {
  ytw_web: "YTW_WEB_PASSWORD",
  ytw_mcp: "YTW_MCP_PASSWORD",
  ytw_readonly: "YTW_READONLY_PASSWORD",
};

const FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const PASSWORD_PATTERN = /^[\x21-\x7e]{16,256}$/;
const SCRAM_ITERATIONS = 4096;
const SCRAM_VERIFIER =
  /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;
const BYTE_ORDER_MARK = 0xfeff;

/** Rules the guard must report for the canary objects; see {@link checkGuard}. */
const CANARY_RULES = [
  "table_write_privilege",
  "private_data_exposure",
  "readonly_function_execute",
] as const;

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
  /** @deprecated Ignored. Database roles and credentials are deployment-owned. */
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
  /** @deprecated Always empty; migrations no longer manage role passwords. */
  readonly passwordsSet: AppRole[];
  /** @deprecated Always empty; migrations no longer manage role settings. */
  readonly roleSettingsRestored: string[];
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

/**
 * How a role's stored password relates to a given one: `unset` (no password), `matches`,
 * `differs`, or `unknown` (the stored verifier is not readable: only superusers may read it).
 */
export type PasswordStatus = "unset" | "matches" | "differs" | "unknown";

interface AppliedRow {
  version: string;
  filename: string;
  checksum: string;
}

interface Violation {
  rule: string;
  object: string;
  detail: string;
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
 * Applies every pending migration, then the role passwords. Safe to run repeatedly and
 * concurrently; a second run with nothing to do applies nothing.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const files = await loadMigrations(options.migrationsDir);
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
      const result = await applyFile(client, file);
      appliedNow.push(file.filename);
      log(`applied ${file.filename} (${result.ms} ms)`);
    }
    if (appliedNow.length === 0) {
      log(`up to date: ${applied.length} migrations already applied`);
    }

    return {
      applied: appliedNow,
      alreadyApplied: applied.length,
      passwordsSet: [],
      roleSettingsRestored: [],
    };
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

/**
 * The SCRAM-SHA-256 verifier Postgres stores for `password` (RFC 5802/7677, the format of
 * `pg_authid.rolpassword`). Sending the verifier instead of the password keeps the plain text out of
 * server logs and statistics. Passwords are printable ASCII, for which SASLprep changes nothing.
 */
export function scramSha256Verifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations: number = SCRAM_ITERATIONS,
): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/**
 * Compares a role's stored password with `password` without changing anything. Reading
 * `pg_authid` needs a superuser; anyone else gets `unknown`, as does a role that does not exist.
 */
export async function rolePasswordStatus(
  db: Queryable,
  role: string,
  password: string,
): Promise<PasswordStatus> {
  let stored: string | null;
  try {
    const { rows } = await db.query<{ rolpassword: string | null }>(
      "SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname = $1",
      [role],
    );
    const row = rows[0];
    if (row === undefined) {
      return "unknown";
    }
    stored = row.rolpassword;
  } catch (err) {
    if (isPgError(err) && err.code === "42501") {
      return "unknown";
    }
    throw err;
  }
  if (stored === null) {
    return "unset";
  }
  const parts = SCRAM_VERIFIER.exec(stored);
  if (parts === null) {
    return "differs";
  }
  const recomputed = scramSha256Verifier(
    password,
    Buffer.from(parts[2] as string, "base64"),
    Number(parts[1]),
  );
  return recomputed === stored ? "matches" : "differs";
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

async function hasFunction(db: Queryable, signature: string): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(
    "SELECT to_regprocedure($1) IS NOT NULL AS present",
    [signature],
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

export async function enforceRoleSettings(client: Client): Promise<string[]> {
  if (!(await hasFunction(client, "public.ytw_enforce_role_settings()"))) {
    return [];
  }
  const { rows } = await client.query<{ line: string }>(
    "SELECT line FROM public.ytw_enforce_role_settings() AS line",
  );
  return rows.map((row) => row.line);
}

export async function withRolledBackTransaction<T>(
  client: Client,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    return await fn();
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}

async function applyFile(
  client: Client,
  file: MigrationFile,
): Promise<{ ms: number; guardPresent: boolean }> {
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
    const guardPresent = false;
    const ms = Math.round(performance.now() - started);
    await client.query(
      "INSERT INTO public.schema_migrations (version, filename, checksum, duration_ms) VALUES ($1, $2, $3, $4)",
      [file.version, file.filename, file.checksum, ms],
    );
    await client.query("COMMIT");
    return { ms, guardPresent };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

async function currentXid(client: Client, sql: string): Promise<string | null> {
  const { rows } = await client.query<{ xid: string | null }>(sql);
  return rows[0]?.xid ?? null;
}

/**
 * Runs the catalog guard inside the current transaction and throws on any finding. Before that,
 * inside a savepoint that is always rolled back, it creates three canary objects that break three
 * different rules and requires the guard to report each of them: a guard that was dropped,
 * replaced by one that returns nothing, or stripped of those rules fails the run. `fileName` is
 * the file just applied (undefined before the first file). Returns whether the guard exists.
 */
export async function checkGuard(
  client: Client,
  fileName: string | undefined,
  required: boolean,
): Promise<boolean> {
  const where = fileName ?? "before applying any file";
  if (!(await hasFunction(client, "public.ytw_catalog_violations()"))) {
    if (required) {
      throw new MigrationError(
        `${where}: ytw_catalog_violations() no longer exists; migrations must not drop the ` +
          "catalog guard (extend it with CREATE OR REPLACE in a new migration instead)",
      );
    }
    return false;
  }

  const suffix = randomBytes(6).toString("hex");
  const table = `ytw_canary_t_${suffix}`;
  const view = `ytw_canary_v_${suffix}`;
  const fn = `ytw_canary_f_${suffix}`;
  let rows: Violation[];
  await client.query("SAVEPOINT ytw_guard_check");
  try {
    await client.query(`
      CREATE TABLE public.${table} (id integer);
      GRANT INSERT ON public.${table} TO ytw_web;
      CREATE TABLE ytw_private.${table} (secret text);
      CREATE VIEW public.${view} AS SELECT secret FROM ytw_private.${table};
      GRANT SELECT ON public.${view} TO ytw_readonly;
      CREATE FUNCTION public.${fn}() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp AS 'SELECT 1';
      GRANT EXECUTE ON FUNCTION public.${fn}() TO ytw_readonly;`);
    rows = (
      await client.query<Violation>(
        "SELECT rule, object, detail FROM public.ytw_catalog_violations() ORDER BY 1, 2, 3",
      )
    ).rows;
  } catch (err) {
    throw new MigrationError(
      `${where}: the catalog guard could not run: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT ytw_guard_check").catch(() => undefined);
    await client.query("RELEASE SAVEPOINT ytw_guard_check").catch(() => undefined);
  }

  const canaryRules = new Set(
    rows.filter((row) => row.object.includes(suffix)).map((row) => row.rule),
  );
  const blind = CANARY_RULES.filter((rule) => !canaryRules.has(rule));
  if (blind.length > 0) {
    throw new MigrationError(
      `${where}: ytw_catalog_violations() no longer reports ${blind.join(", ")}; a migration ` +
        "disabled or weakened the catalog guard",
    );
  }
  const violations = rows.filter((row) => !row.object.includes(suffix));
  if (violations.length > 0) {
    const list = violations.map((v) => `${v.rule}: ${v.object} ${v.detail}`).join("\n- ");
    throw new MigrationError(
      fileName === undefined
        ? `the database already breaks the privilege rules (ytw_catalog_violations); nothing was applied:\n- ${list}`
        : `${fileName} breaks the privilege rules (ytw_catalog_violations), rolled back:\n- ${list}`,
    );
  }
  return true;
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

export function validatePasswords(
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

export async function setRolePassword(
  client: Client,
  role: AppRole,
  password: string,
): Promise<void> {
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
