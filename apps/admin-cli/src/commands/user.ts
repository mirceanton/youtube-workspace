/**
 * Handler implementations for `user` commands.
 */
import {
  getUserAccess,
  listUserAccess,
  setUserAccessRevoked,
  setUserAdmin,
  setUserPermission,
  upsertUserOnLogin,
  withActor,
  ForbiddenError,
  ValidationError,
} from "@ytw/db";
import type { Pool } from "pg";
import type { Resource, ResourceLevels } from "@ytw/shared/constants";
import { formatLevels, parseGrant } from "../format.js";
import { findDefaultAdmin, requireUser } from "../user-lookup.js";

export interface CommandContext {
  readonly pool: Pool;
  readonly json: boolean;
  readonly print: (text: string) => void;
}

export async function handleUserCreate(
  args: {
    username?: string;
    issuer?: string;
    sub?: string;
    email?: string;
    displayName?: string;
  },
  ctx: CommandContext,
): Promise<void> {
  const username = args.username?.trim();
  if (!username) {
    throw new ValidationError("--username is required.");
  }

  const issuer = args.issuer?.trim() || "local";
  const sub = args.sub?.trim() || username;
  const email = args.email?.trim() || null;
  const displayName = args.displayName?.trim() || null;

  const result = await withActor(ctx.pool, { name: username, type: "human" }, async (tx) => {
    return upsertUserOnLogin(tx, {
      issuer,
      sub,
      username,
      email,
      displayName,
    });
  });

  if (ctx.json) {
    ctx.print(JSON.stringify(result, null, 2));
    return;
  }

  ctx.print(`User "${result.username}" (${result.id}):`);
  ctx.print(`  Issuer:       ${result.issuer}`);
  ctx.print(`  Subject:      ${result.subject}`);
  if (result.email) ctx.print(`  Email:        ${result.email}`);
  if (result.displayName) ctx.print(`  Display Name: ${result.displayName}`);
  ctx.print(
    `  Admin:        ${result.isAdmin ? "true" : "false"}${
      result.created && result.isAdmin
        ? " (first user in database: granted full admin write access)"
        : ""
    }`,
  );
  ctx.print(`  Levels:       ${formatLevels(result.levels)}`);
}

export async function handleUserList(args: { as?: string }, ctx: CommandContext): Promise<void> {
  let adminId: string;
  let adminUsername: string;

  if (args.as) {
    const admin = await requireUser(ctx.pool, args.as, "Acting admin");
    if (!admin.isAdmin || admin.accessRevokedAt !== null) {
      throw new ForbiddenError(`Acting user "${admin.username}" is not an active admin.`);
    }
    adminId = admin.id;
    adminUsername = admin.username;
  } else {
    const defaultAdmin = await findDefaultAdmin(ctx.pool);
    if (!defaultAdmin) {
      throw new ForbiddenError("No active admin found. Please specify --as <admin-username>.");
    }
    adminId = defaultAdmin.id;
    adminUsername = defaultAdmin.username;
  }

  const users = await listUserAccess(ctx.pool, adminId);

  if (ctx.json) {
    ctx.print(JSON.stringify(users, null, 2));
    return;
  }

  if (users.length === 0) {
    ctx.print("No users found.");
    return;
  }

  ctx.print(`Users (${users.length}) [listed as ${adminUsername}]:\n`);
  for (const user of users) {
    const status = user.accessRevokedAt ? " [ACCESS REVOKED]" : user.isAdmin ? " [ADMIN]" : "";
    ctx.print(`- ${user.username} (${user.id})${status}`);
    ctx.print(`  Issuer/Sub: ${user.issuer} / ${user.subject}`);
    if (user.email) ctx.print(`  Email:      ${user.email}`);
    ctx.print(`  Levels:     ${formatLevels(user.levels)}`);
  }
}

export async function handleUserSetLevel(
  args: {
    as?: string;
    user?: string;
    grants: string[];
  },
  ctx: CommandContext,
): Promise<void> {
  if (!args.as) {
    throw new ValidationError(
      "--as <admin-username> is required: only an admin can set access levels.",
    );
  }
  if (!args.user) {
    throw new ValidationError("Target user is required.");
  }
  if (args.grants.length === 0) {
    throw new ValidationError("At least one <resource>=<level> permission grant is required.");
  }

  const admin = await requireUser(ctx.pool, args.as, "Acting admin");
  const target = await requireUser(ctx.pool, args.user, "Target user");
  const permissions = parseGrant(args.grants);

  const changes = await withActor(ctx.pool, { name: admin.username, type: "human" }, async (tx) => {
    const results = [];
    for (const [res, lvl] of Object.entries(permissions) as [
      Resource,
      ResourceLevels[Resource],
    ][]) {
      const change = await setUserPermission(tx, {
        actingUserId: admin.id,
        userId: target.id,
        resource: res,
        level: lvl,
      });
      results.push(change);
    }
    return results;
  });

  const updatedAccess = await getUserAccess(ctx.pool, target.id);

  if (ctx.json) {
    ctx.print(
      JSON.stringify(
        {
          target: target.username,
          changes,
          user: updatedAccess,
        },
        null,
        2,
      ),
    );
    return;
  }

  ctx.print(`Updated access levels for user "${target.username}":`);
  for (const c of changes) {
    ctx.print(
      `  ${c.resource}: ${c.previousLevel} -> ${c.level}${c.changed ? "" : " (unchanged)"}`,
    );
  }
  if (updatedAccess) {
    ctx.print(`Current effective levels: ${formatLevels(updatedAccess.levels)}`);
  }
}

export async function handleUserSetAdmin(
  args: {
    as?: string;
    user?: string;
    admin?: boolean;
    keepLevels?: boolean;
  },
  ctx: CommandContext,
): Promise<void> {
  if (!args.as) {
    throw new ValidationError(
      "--as <admin-username> is required: only an admin can change admin status.",
    );
  }
  if (!args.user) {
    throw new ValidationError("Target user is required.");
  }

  const admin = await requireUser(ctx.pool, args.as, "Acting admin");
  const target = await requireUser(ctx.pool, args.user, "Target user");
  const isAdmin = args.admin ?? true;
  const keepLevels = args.keepLevels ?? false;

  const result = await withActor(ctx.pool, { name: admin.username, type: "human" }, async (tx) => {
    return setUserAdmin(tx, {
      actingUserId: admin.id,
      userId: target.id,
      isAdmin,
      keepLevels,
    });
  });

  if (ctx.json) {
    ctx.print(JSON.stringify(result, null, 2));
    return;
  }

  if (result.isAdmin) {
    ctx.print(`Promoted "${target.username}" to admin.${result.changed ? "" : " (already admin)"}`);
  } else {
    ctx.print(
      `Demoted "${target.username}" from admin.${
        keepLevels ? " Existing permission levels retained." : " Permission levels reset to none."
      }${result.changed ? "" : " (already non-admin)"}`,
    );
  }
  ctx.print(`Effective levels: ${formatLevels(result.levels)}`);
}

export async function handleUserRevokeAccess(
  args: {
    as?: string;
    user?: string;
  },
  ctx: CommandContext,
): Promise<void> {
  if (!args.as) {
    throw new ValidationError(
      "--as <admin-username> is required: only an admin can revoke user access.",
    );
  }
  if (!args.user) {
    throw new ValidationError("Target user is required.");
  }

  const admin = await requireUser(ctx.pool, args.as, "Acting admin");
  const target = await requireUser(ctx.pool, args.user, "Target user");

  const result = await withActor(ctx.pool, { name: admin.username, type: "human" }, async (tx) => {
    return setUserAccessRevoked(tx, {
      actingUserId: admin.id,
      userId: target.id,
      revoked: true,
    });
  });

  if (ctx.json) {
    ctx.print(JSON.stringify(result, null, 2));
    return;
  }

  ctx.print(
    `Revoked access for user "${target.username}". Ended ${result.sessionsEnded} active session(s).`,
  );
}

export async function handleUserRestoreAccess(
  args: {
    as?: string;
    user?: string;
  },
  ctx: CommandContext,
): Promise<void> {
  if (!args.as) {
    throw new ValidationError(
      "--as <admin-username> is required: only an admin can restore user access.",
    );
  }
  if (!args.user) {
    throw new ValidationError("Target user is required.");
  }

  const admin = await requireUser(ctx.pool, args.as, "Acting admin");
  const target = await requireUser(ctx.pool, args.user, "Target user");

  const result = await withActor(ctx.pool, { name: admin.username, type: "human" }, async (tx) => {
    return setUserAccessRevoked(tx, {
      actingUserId: admin.id,
      userId: target.id,
      revoked: false,
    });
  });

  if (ctx.json) {
    ctx.print(JSON.stringify(result, null, 2));
    return;
  }

  ctx.print(`Restored access for user "${target.username}".`);
}
