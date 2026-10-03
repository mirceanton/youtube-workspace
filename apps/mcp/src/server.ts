import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { toClientError, withActor, type Actor, type ActorTx } from "@ytw/db";
import type { ToolCallMetrics } from "@ytw/observability";
import { authorize, type TokenPrincipal } from "@ytw/policy";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import { logToolCallEvent } from "./audit.js";
import type { ToolContext, ToolDefinition } from "./tools.js";

export interface CreateServerOptions {
  principal: TokenPrincipal;
  pool: Pool;
  readonlyPool?: Pool | undefined;
  tools: readonly ToolDefinition[];
  log: FastifyBaseLogger;
  toolCallMetrics?: ToolCallMetrics | undefined;
  appVersion?: string | undefined;
}

/**
 * Creates an McpServer instance bound to the authenticated principal for one stateless request.
 */
export function createMcpServer(options: CreateServerOptions): McpServer {
  const { principal, pool, readonlyPool, tools, log, toolCallMetrics, appVersion } = options;

  const server = new McpServer(
    {
      name: "youtube-workspace-mcp",
      version: appVersion ?? "0.0.0-dev",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const actor: Actor = {
    name: principal.tokenName,
    type: "agent",
    tokenId: principal.tokenId,
  };

  const context: ToolContext = {
    principal,
    pool,
    db: pool,
    readonlyPool,
    actor,
    withTx: <T>(fn: (tx: ActorTx) => Promise<T>) => withActor(pool, actor, fn),
    log,
  };

  for (const tool of tools) {
    if (tool.filter && !tool.filter(principal)) {
      continue;
    }

    const inputSchema = tool.input ?? {};

    // Register tool with McpServer
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: inputSchema as Record<string, z.ZodTypeAny>,
      },
      async (args: Record<string, unknown>) => {
        const start = process.hrtime.bigint();

        // 1. Permission check via @ytw/policy
        if (tool.requires) {
          const decision = authorize(principal, tool.requires);
          if (!decision.allowed) {
            const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
            toolCallMetrics?.record({
              tool: tool.name,
              token: principal.tokenName,
              outcome: "denied",
              durationSeconds,
            });

            await logToolCallEvent(pool, {
              actor: principal.tokenName,
              tokenId: principal.tokenId,
              tool: tool.name,
              outcome: "denied",
              tokenOwner: principal.owner.username,
            }).catch((err) => {
              log.error({ err, tool: tool.name }, "failed to log denied tool call event");
            });

            return {
              content: [{ type: "text", text: decision.message }],
              isError: true,
            };
          }
        }

        // 2. Execute handler
        try {
          const result = await tool.handler(args, context);
          const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;

          if (
            typeof result === "object" &&
            result !== null &&
            "isError" in result &&
            (result as { isError?: boolean }).isError === true
          ) {
            toolCallMetrics?.record({
              tool: tool.name,
              token: principal.tokenName,
              outcome: "error",
              durationSeconds,
            });
            await logToolCallEvent(pool, {
              actor: principal.tokenName,
              tokenId: principal.tokenId,
              tool: tool.name,
              outcome: "error",
              tokenOwner: principal.owner.username,
            }).catch((err) => {
              log.error({ err, tool: tool.name }, "failed to log error tool call event");
            });
            return result as CallToolResult;
          }

          toolCallMetrics?.record({
            tool: tool.name,
            token: principal.tokenName,
            outcome: "ok",
            durationSeconds,
          });

          await logToolCallEvent(pool, {
            actor: principal.tokenName,
            tokenId: principal.tokenId,
            tool: tool.name,
            outcome: "ok",
            tokenOwner: principal.owner.username,
          }).catch((err) => {
            log.error({ err, tool: tool.name }, "failed to log ok tool call event");
          });

          if (
            typeof result === "object" &&
            result !== null &&
            "content" in result &&
            Array.isArray((result as { content?: unknown }).content)
          ) {
            return result as CallToolResult;
          }

          return {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
          const clientError = toClientError(error);

          toolCallMetrics?.record({
            tool: tool.name,
            token: principal.tokenName,
            outcome: "error",
            durationSeconds,
          });

          await logToolCallEvent(pool, {
            actor: principal.tokenName,
            tokenId: principal.tokenId,
            tool: tool.name,
            outcome: "error",
            error: clientError.error,
            tokenOwner: principal.owner.username,
          }).catch((err) => {
            log.error({ err, tool: tool.name }, "failed to log error tool call event");
          });

          let text = clientError.message;
          if (clientError.hint) {
            text += `\nHint: ${clientError.hint}`;
          }
          if (clientError.details && Object.keys(clientError.details).length > 0) {
            text += `\nDetails: ${JSON.stringify(clientError.details)}`;
          }

          return {
            content: [{ type: "text", text }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}
