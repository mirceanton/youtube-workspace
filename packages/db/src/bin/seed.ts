#!/usr/bin/env node
import { createHash } from "node:crypto";
import { Pool } from "pg";

interface SeedUser {
  username: string;
  issuer: string;
  sub: string;
  email?: string;
  displayName?: string;
}

interface SeedToken {
  owner: string;
  name: string;
  secret: string;
  grants: Record<string, string>;
}

function singleMcpToken(): SeedToken[] {
  const owner = process.env.SEED_MCP_TOKEN_OWNER?.trim();
  const name = process.env.SEED_MCP_TOKEN_NAME?.trim();
  const secret = process.env.SEED_MCP_TOKEN_SECRET?.trim();
  const grants = process.env.SEED_MCP_TOKEN_GRANTS?.trim();
  if (!owner && !name && !secret && !grants) return [];
  if (!owner || !name || !secret || !grants) {
    throw new Error(
      "SEED_MCP_TOKEN_OWNER, SEED_MCP_TOKEN_NAME, SEED_MCP_TOKEN_SECRET, and SEED_MCP_TOKEN_GRANTS must be set together",
    );
  }
  try {
    const parsed: unknown = JSON.parse(grants);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    return [{ owner, name, secret, grants: parsed as Record<string, string> }];
  } catch (cause) {
    throw new Error(
      `SEED_MCP_TOKEN_GRANTS must be a JSON object: ${cause instanceof Error ? cause.message : cause}`,
      { cause },
    );
  }
}

function parseJson<T>(name: string): T[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error("must be a JSON array");
    return value as T[];
  } catch (cause) {
    throw new Error(
      `${name} must be a JSON array: ${cause instanceof Error ? cause.message : cause}`,
      { cause },
    );
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function tokenPrefix(secret: string): string {
  return secret.slice(0, 12);
}

function tokenHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const users = parseJson<SeedUser>("SEED_USERS_JSON");
  const tokens = [...parseJson<SeedToken>("SEED_API_TOKENS_JSON"), ...singleMcpToken()];
  const pool = new Pool({ connectionString: databaseUrl, max: 1, application_name: "ytw-seed" });

  try {
    for (const user of users) {
      const username = requiredString(user.username, "SEED_USERS_JSON[].username");
      const issuer = requiredString(user.issuer, "SEED_USERS_JSON[].issuer");
      const sub = requiredString(user.sub, "SEED_USERS_JSON[].sub");
      await pool.query("SELECT * FROM upsert_user_on_login($1, $2, NULL, $3, $4, $5, $6, $7)", [
        username,
        "human",
        issuer,
        sub,
        username,
        user.email ?? null,
        user.displayName ?? null,
      ]);
      console.log(`@ytw/db: ensured user ${username}`);
    }

    for (const token of tokens) {
      const owner = requiredString(token.owner, "SEED_API_TOKENS_JSON[].owner");
      const name = requiredString(token.name, "SEED_API_TOKENS_JSON[].name");
      const secret = requiredString(token.secret, "SEED_API_TOKENS_JSON[].secret");
      if (!/^ytw_[A-Za-z0-9_-]{43}$/.test(secret)) {
        throw new Error(`seed token ${name} has an invalid secret shape`);
      }
      const { rows: ownerRows } = await pool.query<{ id: string }>(
        "SELECT id FROM public.users WHERE username = $1",
        [owner],
      );
      const ownerRow = ownerRows[0];
      if (!ownerRow) throw new Error(`seed token ${name} references missing owner ${owner}`);

      const hash = tokenHash(secret);
      const { rows: existing } = await pool.query<{ token_hash: string }>(
        "SELECT token_hash FROM ytw_private.api_tokens WHERE user_id = $1 AND name = $2",
        [ownerRow.id, name],
      );
      if (existing[0]) {
        if (existing[0].token_hash !== hash) {
          throw new Error(
            `seed token ${name} already exists with a different secret; rotate it explicitly`,
          );
        }
        console.log(`@ytw/db: seed token ${name} already exists`);
        continue;
      }

      await pool.query(
        "SELECT * FROM create_api_token($1, $2, NULL, $3, $4, $5, $6, NULL, $7::jsonb)",
        [
          owner,
          "human",
          ownerRow.id,
          name,
          tokenPrefix(secret),
          hash,
          JSON.stringify(token.grants),
        ],
      );
      console.log(`@ytw/db: created seed token ${name}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(`@ytw/db: seed failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
