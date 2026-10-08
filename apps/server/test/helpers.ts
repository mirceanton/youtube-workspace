import type { TestDb } from "@ytw/db/testing";
import type { FastifyInstance } from "fastify";
import { loadEnv, type Env } from "../src/env.js";

/** A valid environment for the throwaway database; `extra` adds or overrides variables. */
export function envFor(db: Pick<TestDb, "url">, extra: Record<string, string> = {}): Env {
  return loadEnv({ DATABASE_URL: db.url, PORT: "0", LOG_LEVEL: "silent", ...extra });
}

/** The parts of a JSON-RPC answer (or of a JSON error body) that the tests look at. */
export interface RpcBody {
  error?: unknown;
  result?: {
    serverInfo?: { name: string };
    tools?: { name: string }[];
    content?: { text: string }[];
    isError?: boolean;
  };
}

/** One call to the stateless MCP endpoint; the reply is a server-sent event or plain JSON. */
export async function rpc(
  app: FastifyInstance,
  secret: string | undefined,
  method: string,
  params?: unknown,
): Promise<{ status: number; body: RpcBody }> {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(secret === undefined ? {} : { authorization: `Bearer ${secret}` }),
    },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
  const data = response.payload.split("\n").find((line) => line.startsWith("data: "));
  const text = data === undefined ? response.payload : data.slice("data: ".length);
  return { status: response.statusCode, body: JSON.parse(text) as RpcBody };
}

export async function toolNames(app: FastifyInstance, secret: string): Promise<string[]> {
  const { body } = await rpc(app, secret, "tools/list");
  return (body.result?.tools ?? []).map((tool) => tool.name);
}

/** Calls a tool and returns its text, also parsed when it is JSON. */
export async function callTool(
  app: FastifyInstance,
  secret: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string; json: Record<string, unknown> }> {
  const { body } = await rpc(app, secret, "tools/call", { name, arguments: args });
  const text = body.result?.content?.[0]?.text ?? "";
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // An error message, not JSON.
  }
  return { isError: body.result?.isError === true, text, json };
}
