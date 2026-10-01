/**
 * Connections: one pool per process for its own role, the `sql` template for parameterized
 * queries, and {@link withActor}, the transaction every mutation runs in. Conventions:
 * docs/database.md.
 */
import { ACTOR_TYPES, type ActorType } from "@ytw/shared/constants";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { ValidationError, formatAllowed, toDbError } from "./errors.js";

/** The fixed database roles created by migration 0001 (PRD 5, "Database roles"). */
export const APP_ROLES = ["ytw_web", "ytw_mcp", "ytw_readonly"] as const;
export type AppRole = (typeof APP_ROLES)[number];

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
  /** The role this process connects as; it names the connection (`application_name`). */
  role: AppRole;
  /** `DATABASE_URL` (or `READONLY_DATABASE_URL` for ytw_readonly). */
  connectionString: string;
  /** Maximum connections (default 10; PRD 9 sizes the system for 10 concurrent users). */
  max?: number;
  /** Overrides the default `application_name` (`ytw-web`, `ytw-mcp`, `ytw-readonly`). */
  applicationName?: string;
  /**
   * Called when an idle pooled connection fails (for example the server restarted). Without a
   * handler such an error would crash the process; the default writes one line to stderr.
   */
  onError?: (err: Error) => void;
}

/**
 * Creates the process's pool for its own role. Call {@link assertPoolRole} once at startup so a
 * `DATABASE_URL` that points at the wrong role (or a superuser) stops the process.
 */
export function createPool(options: CreatePoolOptions): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? options.role.replace("_", "-"),
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on(
    "error",
    options.onError ??
      ((err: Error) => {
        console.error(`@ytw/db: idle ${options.role} connection failed: ${err.message}`);
      }),
  );
  return pool;
}

/**
 * Verifies that the pool logs in as `role` itself (not a superuser, not another role). Throws an
 * Error naming the role it actually got.
 */
export async function assertPoolRole(pool: Queryable, role: AppRole): Promise<void> {
  const { rows } = await pool.query<{ current: string; session: string; superuser: boolean }>(
    `SELECT current_user AS current, session_user AS session, r.rolsuper AS superuser
       FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
  );
  const row = rows[0];
  if (row === undefined || row.current !== role || row.session !== role || row.superuser) {
    const actual = row === undefined ? "an unknown role" : `role ${row.session}`;
    throw new Error(
      `the database connection must log in as ${role}, but it logs in as ${actual}` +
        (row?.superuser === true ? " (a superuser)" : "") +
        "; fix the connection string",
    );
  }
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
