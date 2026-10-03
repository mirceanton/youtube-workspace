/**
 * Command-line entry point and dispatch for ytw-admin.
 */
import { createPool } from "@ytw/db";
import type { Pool } from "pg";
import {
  handleTokenCreate,
  handleTokenList,
  handleTokenRevoke,
  handleTokenRotate,
  handleTokenUpdate,
} from "./commands/token.js";
import {
  handleUserCreate,
  handleUserList,
  handleUserRestoreAccess,
  handleUserRevokeAccess,
  handleUserSetAdmin,
  handleUserSetLevel,
} from "./commands/user.js";
import { formatError } from "./format.js";

export interface RunCliOptions {
  env?: NodeJS.ProcessEnv;
  pool?: Pool;
  databaseUrl?: string;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

export interface CliResult {
  exitCode: number;
}

interface ParsedArgs {
  subcommand?: string;
  action?: string;
  flags: Record<string, string | boolean | string[]>;
  positionals: string[];
}

function parseCliArgs(rawArgs: string[]): ParsedArgs {
  const flags: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];

  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i]!;

    if (arg === "--") {
      positionals.push(...rawArgs.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const equalsIdx = arg.indexOf("=");
      if (equalsIdx !== -1) {
        const key = arg.slice(2, equalsIdx);
        const val = arg.slice(equalsIdx + 1);
        addFlag(flags, key, val);
      } else {
        const key = arg.slice(2);
        const next = rawArgs[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          addFlag(flags, key, next);
          i += 1;
        } else {
          addFlag(flags, key, true);
        }
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      const key = arg.slice(1);
      const next = rawArgs[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        addFlag(flags, key, next);
        i += 1;
      } else {
        addFlag(flags, key, true);
      }
    } else {
      positionals.push(arg);
    }
    i += 1;
  }

  const subcommand = positionals[0];
  const action = positionals[1];
  const remainingPositionals = positionals.slice(2);

  return {
    subcommand,
    action,
    flags,
    positionals: remainingPositionals,
  };
}

function addFlag(
  flags: Record<string, string | boolean | string[]>,
  key: string,
  val: string | boolean,
): void {
  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = val;
  } else if (Array.isArray(existing)) {
    if (typeof val === "string") existing.push(val);
  } else if (typeof existing === "string" && typeof val === "string") {
    flags[key] = [existing, val];
  } else {
    flags[key] = val;
  }
}

function getFlagString(
  flags: Record<string, string | boolean | string[]>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const val = flags[k];
    if (typeof val === "string") return val;
    if (Array.isArray(val) && val[0]) return val[0];
  }
  return undefined;
}

function getFlagArray(
  flags: Record<string, string | boolean | string[]>,
  ...keys: string[]
): string[] {
  const result: string[] = [];
  for (const k of keys) {
    const val = flags[k];
    if (typeof val === "string") result.push(val);
    else if (Array.isArray(val)) result.push(...val);
  }
  return result;
}

function getFlagBoolean(
  flags: Record<string, string | boolean | string[]>,
  ...keys: string[]
): boolean {
  for (const k of keys) {
    const val = flags[k];
    if (val === true || val === "true") return true;
  }
  return false;
}

function printHelp(print: (msg: string) => void): void {
  print(`ytw-admin - YouTube Workspace Admin CLI

USAGE:
  ytw-admin <subcommand> <action> [options]

SUBCOMMANDS:
  user create          Create or bootstrap an application user
  user list            List users and their access levels
  user set-level       Set resource access level for a user (ideas, scripts, ...)
  user set-admin       Promote or demote an administrator
  user revoke-access   Lock out a user and end all active sessions
  user restore-access  Restore access for a locked-out user

  token create         Create an API token for a user
  token list           List API tokens owned by a user
  token update         Update permissions on an existing API token
  token rotate         Rotate secret of an existing API token
  token revoke         Revoke an API token

OPTIONS:
  --json               Output machine-readable JSON
  --as <admin>         Acting admin username (required for management actions)
  --owner <user>       Token owner username or UUID
  --database-url <url> Connection string for role ytw_web (default: DATABASE_URL)
  --help, -h           Show this help message

EXAMPLES:
  # Bootstrap first admin
  ytw-admin user create --username alice

  # Create a collaborator user (starts with no permissions)
  ytw-admin user create --username bob

  # Grant collaborator write permissions on ideas and read on scripts
  ytw-admin user set-level --as alice bob ideas=write scripts=read

  # Create an API token for bob
  ytw-admin token create --owner bob --name agent-1 --grant ideas=write,scripts=read
`);
}

export async function runCli(rawArgs: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((msg: string) => console.log(msg));
  const stderr = options.stderr ?? ((msg: string) => console.error(msg));

  const parsed = parseCliArgs(rawArgs);
  const isJson = getFlagBoolean(parsed.flags, "json");

  if (
    getFlagBoolean(parsed.flags, "help", "h") ||
    !parsed.subcommand ||
    parsed.subcommand === "help"
  ) {
    printHelp(stdout);
    return { exitCode: 0 };
  }

  const databaseUrl =
    getFlagString(parsed.flags, "database-url", "db") ?? options.databaseUrl ?? env.DATABASE_URL;

  let pool = options.pool;
  let ownsPool = false;

  if (!pool) {
    if (!databaseUrl || databaseUrl.trim() === "") {
      const msg =
        "DATABASE_URL is not set. Pass DATABASE_URL in the environment or via --database-url.";
      if (isJson) {
        stdout(JSON.stringify({ error: msg }));
      } else {
        stderr(`Error: ${msg}`);
      }
      return { exitCode: 2 };
    }

    pool = createPool({
      role: "ytw_web",
      connectionString: databaseUrl,
      max: 2,
    });
    ownsPool = true;
  }

  const ctx = {
    pool,
    json: isJson,
    print: stdout,
  };

  try {
    const { subcommand, action, flags, positionals } = parsed;

    if (subcommand === "user") {
      switch (action) {
        case "create": {
          await handleUserCreate(
            {
              username: getFlagString(flags, "username", "u") ?? positionals[0],
              issuer: getFlagString(flags, "issuer", "i"),
              sub: getFlagString(flags, "sub", "s"),
              email: getFlagString(flags, "email", "e"),
              displayName: getFlagString(flags, "display-name", "d"),
            },
            ctx,
          );
          return { exitCode: 0 };
        }
        case "list": {
          await handleUserList(
            {
              as: getFlagString(flags, "as", "a"),
            },
            ctx,
          );
          return { exitCode: 0 };
        }
        case "set-level": {
          const user = getFlagString(flags, "user") ?? positionals[0];
          const flagGrants = getFlagArray(flags, "grant", "g");
          const posGrants = positionals.slice(1);
          const allGrants = [...flagGrants, ...posGrants];

          await handleUserSetLevel(
            {
              as: getFlagString(flags, "as", "a"),
              user,
              grants: allGrants,
            },
            ctx,
          );
          return { exitCode: 0 };
        }
        case "set-admin": {
          const user = getFlagString(flags, "user") ?? positionals[0];
          const isDemote = getFlagBoolean(flags, "demote", "no-admin");
          const isAdmin = !isDemote;
          const keepLevels = getFlagBoolean(flags, "keep-levels");

          await handleUserSetAdmin(
            {
              as: getFlagString(flags, "as", "a"),
              user,
              admin: isAdmin,
              keepLevels,
            },
            ctx,
          );
          return { exitCode: 0 };
        }
        case "revoke-access": {
          const user = getFlagString(flags, "user") ?? positionals[0];
          await handleUserRevokeAccess(
            {
              as: getFlagString(flags, "as", "a"),
              user,
            },
            ctx,
          );
          return { exitCode: 0 };
        }
        case "restore-access": {
          const user = getFlagString(flags, "user") ?? positionals[0];
          await handleUserRestoreAccess(
            {
              as: getFlagString(flags, "as", "a"),
              user,
            },
            ctx,
          );
          return { exitCode: 0 };
        }
        default:
          throw new Error(
            `Unknown user action "${action ?? ""}". Valid actions: create, list, set-level, set-admin, revoke-access, restore-access.`,
          );
      }
    } else if (subcommand === "token") {
      switch (action) {
        case "create": {
          const flagGrants = getFlagArray(flags, "grant", "g");
          const allGrants = [...flagGrants, ...positionals];
          await handleTokenCreate(
            {
              owner: getFlagString(flags, "owner", "o"),
              name: getFlagString(flags, "name", "n"),
              expiresIn: getFlagString(flags, "expires-in", "expires"),
              grants: allGrants,
            },
            ctx,
          );
          return { exitCode: 0 };
        }
        case "list": {
          await handleTokenList(
            {
              owner: getFlagString(flags, "owner", "o") ?? positionals[0],
            },
            ctx,
          );
          return { exitCode: 0 };
        }
        case "update": {
          const flagGrants = getFlagArray(flags, "grant", "g");
          const allGrants = [...flagGrants, ...positionals.slice(1)];
          await handleTokenUpdate(
            {
              owner: getFlagString(flags, "owner", "o"),
              token: getFlagString(flags, "token", "t") ?? positionals[0],
              grants: allGrants,
            },
            ctx,
          );
          return { exitCode: 0 };
        }
        case "rotate": {
          await handleTokenRotate(
            {
              owner: getFlagString(flags, "owner", "o"),
              token: getFlagString(flags, "token", "t") ?? positionals[0],
              expiresIn: getFlagString(flags, "expires-in", "expires"),
            },
            ctx,
          );
          return { exitCode: 0 };
        }
        case "revoke": {
          await handleTokenRevoke(
            {
              owner: getFlagString(flags, "owner", "o"),
              token: getFlagString(flags, "token", "t") ?? positionals[0],
            },
            ctx,
          );
          return { exitCode: 0 };
        }
        default:
          throw new Error(
            `Unknown token action "${action ?? ""}". Valid actions: create, list, update, rotate, revoke.`,
          );
      }
    } else {
      throw new Error(
        `Unknown command "${subcommand}". Valid commands: user, token. Use --help for usage information.`,
      );
    }
  } catch (err) {
    const errorMsg = formatError(err);
    if (isJson) {
      stdout(JSON.stringify({ error: errorMsg }));
    } else {
      stderr(`Error: ${errorMsg}`);
    }
    return { exitCode: 1 };
  } finally {
    if (ownsPool && pool) {
      await pool.end();
    }
  }
}
