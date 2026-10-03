/**
 * Handler implementations for `token` commands.
 */
import { listApiTokens, ValidationError } from "@ytw/db";
import { createToken, revokeToken, rotateToken, updateToken } from "@ytw/tokens";
import { formatLevels, parseExpiresIn, parseGrant } from "../format.js";
import { requireUser } from "../user-lookup.js";
import type { CommandContext } from "./user.js";

export async function handleTokenCreate(
  args: {
    owner?: string;
    name?: string;
    expiresIn?: string;
    grants: string[];
  },
  ctx: CommandContext,
): Promise<void> {
  if (!args.owner) {
    throw new ValidationError("--owner <user> is required.");
  }
  if (!args.name) {
    throw new ValidationError("--name <token-name> is required.");
  }

  const owner = await requireUser(ctx.pool, args.owner, "Token owner");
  const permissions = parseGrant(args.grants);
  const expiresAt = parseExpiresIn(args.expiresIn);

  const issued = await createToken(
    ctx.pool,
    { id: owner.id, username: owner.username },
    {
      name: args.name.trim(),
      expiresAt,
      permissions,
    },
  );

  if (ctx.json) {
    ctx.print(JSON.stringify(issued, null, 2));
    return;
  }

  ctx.print(`Created API token "${issued.token.name}" (${issued.token.id}):`);
  ctx.print(`  Owner:            ${owner.username}`);
  ctx.print(`  Prefix:           ${issued.token.prefix}`);
  ctx.print(
    `  Expires At:       ${
      issued.token.expiresAt ? issued.token.expiresAt.toISOString() : "never"
    }`,
  );
  ctx.print(`  Effective Levels: ${formatLevels(issued.token.effectiveLevels)}`);
  ctx.print("\nToken Secret (show once):");
  ctx.print(`  ${issued.secret}`);
  ctx.print("\nStore this secret securely now. It will never be displayed again.");
}

export async function handleTokenList(
  args: {
    owner?: string;
  },
  ctx: CommandContext,
): Promise<void> {
  if (!args.owner) {
    throw new ValidationError("--owner <user> is required.");
  }

  const owner = await requireUser(ctx.pool, args.owner, "Token owner");
  const tokens = await listApiTokens(ctx.pool, owner.id);

  if (ctx.json) {
    ctx.print(JSON.stringify(tokens, null, 2));
    return;
  }

  if (tokens.length === 0) {
    ctx.print(`No API tokens found for user "${owner.username}".`);
    return;
  }

  ctx.print(`API tokens for "${owner.username}" (${tokens.length}):\n`);
  for (const token of tokens) {
    ctx.print(`- ${token.name} (${token.id})`);
    ctx.print(`  Prefix:           ${token.prefix}`);
    ctx.print(`  Status:           ${token.status}`);
    ctx.print(`  Expires:          ${token.expiresAt ? token.expiresAt.toISOString() : "never"}`);
    ctx.print(`  Last Used:        ${token.lastUsedAt ? token.lastUsedAt.toISOString() : "never"}`);
    ctx.print(`  Effective Levels: ${formatLevels(token.effectiveLevels)}`);
  }
}

export async function handleTokenUpdate(
  args: {
    owner?: string;
    token?: string;
    grants: string[];
  },
  ctx: CommandContext,
): Promise<void> {
  if (!args.owner) {
    throw new ValidationError("--owner <user> is required.");
  }
  if (!args.token) {
    throw new ValidationError("--token <token-id> is required.");
  }
  if (args.grants.length === 0) {
    throw new ValidationError("At least one <resource>=<level> permission grant is required.");
  }

  const owner = await requireUser(ctx.pool, args.owner, "Token owner");
  const permissions = parseGrant(args.grants);

  const updated = await updateToken(
    ctx.pool,
    { id: owner.id, username: owner.username },
    args.token.trim(),
    permissions,
  );

  if (ctx.json) {
    ctx.print(JSON.stringify(updated, null, 2));
    return;
  }

  ctx.print(`Updated API token "${updated.name}" (${updated.id}):`);
  ctx.print(`  Status:           ${updated.status}`);
  ctx.print(`  Effective Levels: ${formatLevels(updated.effectiveLevels)}`);
}

export async function handleTokenRotate(
  args: {
    owner?: string;
    token?: string;
    expiresIn?: string;
  },
  ctx: CommandContext,
): Promise<void> {
  if (!args.owner) {
    throw new ValidationError("--owner <user> is required.");
  }
  if (!args.token) {
    throw new ValidationError("--token <token-id> is required.");
  }

  const owner = await requireUser(ctx.pool, args.owner, "Token owner");
  const expiresAt = args.expiresIn !== undefined ? parseExpiresIn(args.expiresIn) : undefined;

  const rotated = await rotateToken(
    ctx.pool,
    { id: owner.id, username: owner.username },
    args.token.trim(),
    expiresAt,
  );

  if (ctx.json) {
    ctx.print(JSON.stringify(rotated, null, 2));
    return;
  }

  ctx.print(
    `Rotated API token "${rotated.token.name}" (${rotated.token.id}). Previous secret invalidated.`,
  );
  ctx.print(`  New Prefix:       ${rotated.token.prefix}`);
  ctx.print(
    `  Expires At:       ${
      rotated.token.expiresAt ? rotated.token.expiresAt.toISOString() : "never"
    }`,
  );
  ctx.print("\nNew Token Secret (show once):");
  ctx.print(`  ${rotated.secret}`);
  ctx.print("\nStore this secret securely now. It will never be displayed again.");
}

export async function handleTokenRevoke(
  args: {
    owner?: string;
    token?: string;
  },
  ctx: CommandContext,
): Promise<void> {
  if (!args.owner) {
    throw new ValidationError("--owner <user> is required.");
  }
  if (!args.token) {
    throw new ValidationError("--token <token-id> is required.");
  }

  const owner = await requireUser(ctx.pool, args.owner, "Token owner");

  const revoked = await revokeToken(
    ctx.pool,
    { id: owner.id, username: owner.username },
    args.token.trim(),
  );

  if (ctx.json) {
    ctx.print(JSON.stringify(revoked, null, 2));
    return;
  }

  ctx.print(`Revoked API token "${revoked.name}" (${revoked.id}).`);
}
