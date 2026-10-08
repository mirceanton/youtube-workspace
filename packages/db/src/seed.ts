/**
 * The seeded API token: lets an operator hand the system one MCP token through configuration, so
 * agents can connect before anyone has opened the web app. The server calls {@link seedApiToken} on
 * every boot and the configuration wins. The rules are in the database function `seed_api_token`.
 */
import type { Level, Resource } from "@ytw/shared/constants";
import { rejectNul } from "./args.js";
import { sql, type Queryable } from "./client.js";
import { onlyRow, queryRows, rejectNulInJson } from "./internal/identity-rows.js";

export interface SeedApiTokenInput {
  /** The audit actor name of every call made with the token (1-100 characters). */
  name: string;
  /** As for `createApiToken`: `ytw_` plus at most 11 characters of the secret. */
  tokenPrefix: string;
  /** SHA-256 of the secret as 64 lower-case hex digits. The secret itself never reaches the database. */
  tokenHash: string;
  /** The token's own levels; objects left out get none. No write on the activity log. */
  permissions: Partial<Record<Resource, Level>>;
}

export type SeedApiTokenAction = "created" | "updated" | "unchanged" | "revoked" | "none";

export interface SeedApiTokenResult {
  action: SeedApiTokenAction;
  /** The seeded token concerned; null for `none`. */
  tokenId: string | null;
}

/**
 * Makes the token described by `input` the seeded token. "The configuration wins", on every call:
 *
 * - no seeded token is active: it is created (`created`);
 * - the same secret with the same name and levels: nothing changes (`unchanged`);
 * - the same secret with another name or levels: they are updated (`updated`);
 * - another secret: the active seeded token is revoked and the new one created (`created`);
 * - `input` is null: an active seeded token is revoked (`revoked`), otherwise nothing happens
 *   (`none`).
 *
 * Only the one token marked as seeded is ever touched; tokens created in the web app are not. The
 * seeded token never expires and belongs to the built-in system user, which is not a person: it
 * cannot sign in, is not "the first user", and is left out of the user lists. The call is one
 * statement and serialised by the database, so replicas that boot together create one token.
 * `ValidationError` for a malformed name, prefix, hash or permission map, `DuplicateError` when a
 * token created in the web app already has this hash.
 */
export async function seedApiToken(
  db: Queryable,
  input: SeedApiTokenInput | null,
): Promise<SeedApiTokenResult> {
  if (input !== null) {
    rejectNul("name", input.name);
    rejectNul("token_prefix", input.tokenPrefix);
    rejectNul("token_hash", input.tokenHash);
    rejectNulInJson("permissions", input.permissions);
  }
  const rows = await queryRows<{ action: SeedApiTokenAction; token_id: string | null }>(
    db,
    sql`SELECT * FROM seed_api_token(
          ${input?.name ?? null}, ${input?.tokenPrefix ?? null}, ${input?.tokenHash ?? null},
          ${input === null ? null : JSON.stringify(input.permissions)}::jsonb)`,
  );
  const row = onlyRow(rows, "seed_api_token");
  return { action: row.action, tokenId: row.token_id };
}
