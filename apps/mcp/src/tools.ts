import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Actor, ActorTx, Queryable } from "@ytw/db";
import type { Requirement, TokenPrincipal } from "@ytw/policy";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import type { z } from "zod";

/**
 * Context provided to every MCP tool handler.
 */
export interface ToolContext {
  /** The authenticated agent token principal. */
  principal: TokenPrincipal;
  /** Primary pool connected as ytw_mcp. */
  pool: Pool;
  /** Same as pool for convenient query execution. */
  db: Queryable;
  /** Optional read-only pool connected as ytw_readonly (for query_sql). */
  readonlyPool?: Pool | undefined;
  /** The actor object for withActor / database functions. */
  actor: Actor;
  /**
   * Runs `fn` inside a transaction as the token actor (`withActor`).
   * Used by write tools (ideas, scripts, notes, videos, experiments).
   */
  withTx<T>(fn: (tx: ActorTx) => Promise<T>): Promise<T>;
  /** Logger bound to the request. */
  log: FastifyBaseLogger;
}

/**
 * Definition of an MCP tool.
 */
export interface ToolDefinition<TArgs extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  input?: TArgs | z.ZodRawShape;
  /** Level requirement on an object type; when omitted, any authenticated token may call it. */
  requires?: Requirement;
  /** Optional filter function to conditionally register this tool (e.g. query_sql). */
  filter?: (principal: TokenPrincipal) => boolean;
  /** Tool execution handler. */
  handler: (args: z.infer<TArgs>, context: ToolContext) => Promise<unknown>;
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  getTools(): readonly ToolDefinition[];
}

export class InMemoryToolRegistry implements ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.#tools.set(tool.name, tool);
  }

  getTools(): readonly ToolDefinition[] {
    return Array.from(this.#tools.values());
  }
}

/**
 * Helper to define an MCP tool with type inference.
 */
export function defineTool<TArgs extends z.ZodTypeAny = z.ZodTypeAny>(
  definition: ToolDefinition<TArgs>,
): ToolDefinition<TArgs> {
  return definition;
}

/**
 * Discovers and registers all tools from `src/tools/*.ts` (or `dist/src/tools/*.js`).
 */
export async function loadTools(dirUrl?: URL | string): Promise<ToolDefinition[]> {
  const registry = new InMemoryToolRegistry();
  const dir = dirUrl instanceof URL ? dirUrl : new URL(dirUrl ?? "./tools/", import.meta.url);

  let filenames: string[];
  try {
    filenames = await readdir(fileURLToPath(dir));
  } catch {
    // If tools directory doesn't exist, return empty
    return [];
  }

  for (const filename of filenames.toSorted()) {
    // Only import ts and js files, skip test files, declaration files, and maps
    if (
      (!filename.endsWith(".ts") && !filename.endsWith(".js")) ||
      filename.endsWith(".d.ts") ||
      filename.endsWith(".test.ts") ||
      filename.endsWith(".test.js") ||
      filename.endsWith(".spec.ts") ||
      filename.endsWith(".spec.js")
    ) {
      continue;
    }

    const fileUrl = new URL(filename, dir);
    const mod = await import(fileUrl.href);

    if (typeof mod.register === "function") {
      await mod.register(registry);
    } else if (typeof mod.default === "function") {
      await mod.default(registry);
    } else if (mod.tool && typeof mod.tool === "object") {
      registry.register(mod.tool);
    }
  }

  return registry.getTools() as ToolDefinition[];
}
