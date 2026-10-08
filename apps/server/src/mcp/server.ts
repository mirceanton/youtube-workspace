import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toClientError, withActor, type Actor, type ActorTx } from "@ytw/db";
import { authorize, type TokenPrincipal } from "@ytw/policy";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import type { z } from "zod";
import type { Metrics, ToolCall } from "../observability/index.js";
import { logToolCallEvent } from "./audit.js";
import type { ToolContext, ToolDefinition } from "./registry.js";

export interface CreateServerOptions {
  principal: TokenPrincipal;
  pool: Pool;
  tools: readonly ToolDefinition[];
  log: FastifyBaseLogger;
  metrics: Metrics;
  appVersion: string;
}

function isToolResult(result: unknown): result is CallToolResult {
  return (
    typeof result === "object" && result !== null && Array.isArray(Reflect.get(result, "content"))
  );
}

/** Creates an McpServer bound to the authenticated principal for one stateless request. */
export function createMcpServer(options: CreateServerOptions): McpServer {
  const { principal, pool, tools, log, metrics } = options;

  const server = new McpServer(
    { name: "youtube-workspace-mcp", version: options.appVersion },
    { capabilities: { tools: {} } },
  );

  const actor: Actor = { name: principal.tokenName, type: "agent", tokenId: principal.tokenId };
  const context: ToolContext = {
    principal,
    pool,
    db: pool,
    actor,
    withTx: <T>(fn: (tx: ActorTx) => Promise<T>) => withActor(pool, actor, fn),
    log,
  };

  for (const tool of tools) {
    if (tool.filter && !tool.filter(principal)) {
      continue;
    }

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: (tool.input ?? {}) as Record<string, z.ZodTypeAny>,
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const start = process.hrtime.bigint();

        // Metrics and the audit row are written the same way for every outcome.
        const finish = async (outcome: ToolCall["outcome"], error?: string): Promise<void> => {
          metrics.recordToolCall({
            tool: tool.name,
            token: principal.tokenName,
            outcome,
            durationSeconds: Number(process.hrtime.bigint() - start) / 1e9,
          });
          await logToolCallEvent(pool, {
            actor: principal.tokenName,
            tokenId: principal.tokenId,
            tool: tool.name,
            outcome,
            tokenOwner: principal.owner.username,
            ...(error === undefined ? {} : { error }),
          }).catch((err: unknown) => {
            log.error({ err, tool: tool.name }, "failed to log tool call event");
          });
        };

        if (tool.requires) {
          const decision = authorize(principal, tool.requires);
          if (!decision.allowed) {
            await finish("denied");
            return { content: [{ type: "text", text: decision.message }], isError: true };
          }
        }

        try {
          const result = await tool.handler(args, context);
          if (isToolResult(result)) {
            await finish(result.isError === true ? "error" : "ok");
            return result;
          }
          await finish("ok");
          return {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          const clientError = toClientError(error);
          await finish("error", clientError.error);

          let text = clientError.message;
          if (clientError.hint) {
            text += `\nHint: ${clientError.hint}`;
          }
          if (clientError.details && Object.keys(clientError.details).length > 0) {
            text += `\nDetails: ${JSON.stringify(clientError.details)}`;
          }
          return { content: [{ type: "text", text }], isError: true };
        }
      },
    );
  }

  return server;
}
