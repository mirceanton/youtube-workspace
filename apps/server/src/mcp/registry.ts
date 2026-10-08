import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Actor, ActorTx, Queryable } from "@ytw/db";
import type { Requirement, TokenPrincipal } from "@ytw/policy";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import type { z } from "zod";

/** Context provided to every MCP tool handler. */
export interface ToolContext {
  /** The authenticated agent token principal. */
  principal: TokenPrincipal;
  pool: Pool;
  /** Same as `pool`, for convenient query execution. */
  db: Queryable;
  /** The audit actor of everything this call writes. */
  actor: Actor;
  /** Runs `fn` in a transaction whose audit actor is the token (`withActor`); used by write tools. */
  withTx<T>(fn: (tx: ActorTx) => Promise<T>): Promise<T>;
  /** Logger bound to the request. */
  log: FastifyBaseLogger;
}

/** Definition of an MCP tool. */
export interface ToolDefinition<TArgs extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  input?: TArgs | z.ZodRawShape;
  /** Level requirement on an object type; when omitted, any authenticated token may call it. */
  requires?: Requirement;
  /** Offer the tool only to principals for which this returns true (e.g. `query_sql`). */
  filter?: (principal: TokenPrincipal) => boolean;
  /**
   * The tool runs SQL written by the caller with the server's own database role. The server leaves
   * it out when that role is a superuser, which could read files and start programs from SQL.
   */
  runsCallerSql?: boolean;
  handler: (args: z.infer<TArgs>, context: ToolContext) => Promise<unknown>;
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
}

class InMemoryToolRegistry implements ToolRegistry {
  readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool);
  }
}

/** Helper to define an MCP tool with type inference. */
export function defineTool<TArgs extends z.ZodTypeAny = z.ZodTypeAny>(
  definition: ToolDefinition<TArgs>,
): ToolDefinition<TArgs> {
  return definition;
}

/**
 * Discovers the tools of `tools/*.ts` (or `dist/src/mcp/tools/*.js`): every module that exports
 * `register(registry)` contributes its tools, so adding a tool never edits a shared file.
 */
export async function loadTools(
  dir: URL = new URL("./tools/", import.meta.url),
): Promise<ToolDefinition[]> {
  const registry = new InMemoryToolRegistry();
  const filenames = await readdir(fileURLToPath(dir));
  for (const filename of filenames.toSorted()) {
    if (!/\.(ts|js)$/.test(filename) || /\.(d|test|spec)\.(ts|js)$/.test(filename)) continue;
    const module = (await import(new URL(filename, dir).href)) as {
      register?: (registry: ToolRegistry) => void;
    };
    module.register?.(registry);
  }
  return [...registry.tools.values()];
}
