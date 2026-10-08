/**
 * Connections: one pool per process, the `sql` template for parameterized queries, and
 * {@link withActor}, the transaction every mutation runs in.
 */
import { ACTOR_TYPES, QUERY_SQL_TIMEOUT_MS, type ActorType } from "@ytw/shared/constants";
import { Pool, type QueryConfig, type QueryResult, type QueryResultRow } from "pg";
import { ValidationError, formatAllowed, toDbError } from "./errors.js";

/** Largest `payload` that `ytw_log_event` accepts, in bytes of its JSON text. */
export const EVENT_PAYLOAD_MAX_BYTES = 65_536;

/** A parameterized query: `text` with `$1..$n` placeholders and their `values`. */
export interface SqlQuery {
  text: string;
  values: unknown[];
}

/**
 * Tagged template that turns every interpolation into a bind parameter, so values can never become
 * SQL text:
 *
 * ```ts
 * await tx.query(sql`SELECT * FROM create_idea(${a.name}, ${a.type}, ${a.tokenId}, ${title})`);
 * ```
 *
 * Identifiers and SQL fragments cannot be interpolated; write them literally in the template.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery {
  let text = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    text += `$${index + 1}${strings[index + 1] ?? ""}`;
  }
  return { text, values };
}

/** Anything that runs a query: a pool, a pooled client or a {@link ActorTx}. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    query: string | SqlQuery,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export interface CreatePoolOptions {
  /** `DATABASE_URL`: the one role that owns the database. */
  connectionString: string;
  /** Maximum connections (default 10). */
  max?: number;
  /** Shown in `pg_stat_activity` (default `ytw`). */
  applicationName?: string;
  /**
   * Called when an idle pooled connection fails (for example the server restarted). Without a
   * handler such an error would crash the process; the default writes one line to stderr.
   */
  onError?: (err: Error) => void;
}

/** Creates the process's pool. */
export function createPool(options: CreatePoolOptions): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? "ytw",
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on(
    "error",
    options.onError ??
      ((err: Error) => {
        console.error(`@ytw/db: idle connection failed: ${err.message}`);
      }),
  );
  return pool;
}

/** Who is acting: a person (username, no token) or an agent (API token name and id). */
export interface Actor {
  /** `preferred_username` for people, the token's name for agents. */
  readonly name: string;
  readonly type: ActorType;
  /** API token id for agents; null or omitted for people. */
  readonly tokenId?: string | null;
}

/** The transaction handed to the {@link withActor} callback. Errors are already typed. */
export interface ActorTx extends Queryable {
  readonly actor: {
    readonly name: string;
    readonly type: ActorType;
    readonly tokenId: string | null;
  };
}

/**
 * Runs `fn` in one transaction whose audit actor is `actor`: BEGIN, `ytw_set_actor(...)`, `fn`,
 * COMMIT (ROLLBACK if anything throws). Database errors from the catalogue surface as typed
 * {@link DbError} subclasses (see errors.ts).
 *
 * Wrappers still pass the actor explicitly as the first three arguments of every database function
 * (`tx.actor.name`, `tx.actor.type`, `tx.actor.tokenId`): the functions record their own
 * parameters, the transaction-level setting is a second line of defence.
 */
export async function withActor<T>(
  pool: Pool,
  actor: Actor,
  fn: (tx: ActorTx) => Promise<T>,
): Promise<T> {
  if (!(ACTOR_TYPES as readonly string[]).includes(actor.type)) {
    // ytw_set_actor rejects it too; failing early names the valid values without a round trip.
    throw new ValidationError(
      `actor_type ${JSON.stringify(actor.type)} is not valid; valid values: ${formatAllowed(ACTOR_TYPES)}`,
      { field: "actor_type", value: actor.type, allowed: [...ACTOR_TYPES] },
    );
  }
  const normalized = { name: actor.name, type: actor.type, tokenId: actor.tokenId ?? null };
  const client = await pool.connect();
  let finished = false;
  let broken = false;

  const tx: ActorTx = {
    actor: normalized,
    async query<R extends QueryResultRow = QueryResultRow>(
      query: string | SqlQuery,
      values?: unknown[],
    ): Promise<QueryResult<R>> {
      if (finished) {
        throw new Error("withActor: the transaction has already finished");
      }
      try {
        return typeof query === "string"
          ? await client.query<R>(query, values)
          : await client.query<R>(query.text, query.values);
      } catch (err) {
        throw toDbError(err);
      }
    },
  };

  try {
    await client.query("BEGIN");
    await client.query("SELECT ytw_set_actor($1, $2, $3)", [
      normalized.name,
      normalized.type,
      normalized.tokenId,
    ]);
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    throw toDbError(err);
  } finally {
    finished = true;
    client.release(broken);
  }
}

export interface ReadOnlyQueryOptions {
  /** Statement timeout in milliseconds; at most, and by default, `QUERY_SQL_TIMEOUT_MS` (10 s). */
  timeoutMs?: number;
}

/**
 * Runs ONE untrusted SQL statement, for the MCP `query_sql` tool, on the normal pool. Nothing else
 * may run SQL that a client wrote. In order:
 *
 * 1. `BEGIN READ ONLY` and `SET LOCAL statement_timeout`;
 * 2. a query that takes the transaction's snapshot: from then on `SET TRANSACTION READ WRITE` and
 *    its `set_config('transaction_read_only', ...)` equivalent are rejected, so the statement
 *    cannot make its own transaction writable;
 * 3. the statement alone, through the extended protocol, which refuses a string holding more than
 *    one statement (with no parameters node-postgres would use the simple protocol, which runs
 *    several);
 * 4. ROLLBACK, and the connection is destroyed instead of returned to the pool, so nothing the
 *    statement changed in its session (settings, advisory locks, prepared statements, LISTEN)
 *    outlives the call.
 *
 * Errors are the driver's, with the SQLSTATE in `code`: 25006 for a write, 57014 for the timeout,
 * 42601 for a syntax error or several statements. Capping rows and output size is the caller's job.
 *
 * The statement runs as the database role of the pool and can read every table, `ytw_private`
 * included (that is why credentials are stored hashed). Connect as the role that owns the
 * database, never as a superuser, which can read files and start programs from SQL.
 */
export async function queryReadOnly<R extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  statement: string,
  options: ReadOnlyQueryOptions = {},
): Promise<QueryResult<R>> {
  if (typeof statement !== "string" || statement.trim() === "") {
    throw new ValidationError("the SQL statement is empty", { field: "sql" });
  }
  const timeoutMs = options.timeoutMs ?? QUERY_SQL_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > QUERY_SQL_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be an integer from 1 to ${QUERY_SQL_TIMEOUT_MS}`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    // Takes the snapshot: from here on the transaction can no longer be switched to read write.
    await client.query("SELECT 1");
    // `queryMode` is supported by node-postgres but missing from its type definitions.
    const config: QueryConfig & { queryMode: "extended" } = {
      text: statement,
      queryMode: "extended",
    };
    return await client.query<R>(config);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release(true);
  }
}
