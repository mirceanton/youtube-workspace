import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  setUserAdmin,
  setUserPermission,
  upsertUserOnLogin,
  withActor,
  type ApiTokenInfo,
} from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import type { Level, Resource } from "@ytw/shared/constants";
import { createToken, FailureLimiter, type TokenOwnerRef } from "@ytw/tokens";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadEnv, type Env } from "./env.js";
import { loadTools, type ToolDefinition } from "./tools.js";

let testCounter = 0;
const unique = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(testCounter += 1).toString(36)}`;
const person = (username: string) => ({ name: username, type: "human" as const });

export interface CreatedTestToken {
  token: ApiTokenInfo;
  secret: string;
  owner: TokenOwnerRef;
}

/**
 * Creates a test user and an API token with the requested permission levels.
 * Safe for use in integration tests (T30-T35).
 */
export async function createTestToken(
  db: TestDb,
  levels: Partial<Record<Resource, Level>> = {},
  options: {
    name?: string;
    ownerUsername?: string;
    isAdmin?: boolean;
  } = {},
): Promise<CreatedTestToken> {
  // Find or create the primary admin on this database
  let admin: TokenOwnerRef;
  const { rows: adminRows } = await db.admin.query<{ id: string; username: string }>(
    "SELECT id, username FROM users WHERE is_admin = true AND access_revoked_at IS NULL ORDER BY created_at ASC LIMIT 1",
  );

  if (adminRows.length > 0 && adminRows[0]) {
    admin = adminRows[0];
  } else {
    const adminUsername = unique("admin");
    const adminResult = await withActor(db.pool("ytw_web"), person(adminUsername), (tx) =>
      upsertUserOnLogin(tx, {
        issuer: "https://id.example.test/realms/ytw",
        sub: `sub-${adminUsername}`,
        username: adminUsername,
      }),
    );
    admin = { id: adminResult.id, username: adminUsername };
  }

  let owner: TokenOwnerRef;
  if (options.isAdmin && !options.ownerUsername) {
    owner = admin;
  } else if (options.ownerUsername) {
    const ownerResult = await withActor(db.pool("ytw_web"), person(options.ownerUsername), (tx) =>
      upsertUserOnLogin(tx, {
        issuer: "https://id.example.test/realms/ytw",
        sub: `sub-${options.ownerUsername}`,
        username: options.ownerUsername!,
      }),
    );
    owner = { id: ownerResult.id, username: options.ownerUsername };
    if (options.isAdmin) {
      await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
        setUserAdmin(tx, {
          actingUserId: admin.id,
          userId: owner.id,
          isAdmin: true,
        }),
      );
    }
  } else {
    const username = unique("user");
    const userResult = await withActor(db.pool("ytw_web"), person(username), (tx) =>
      upsertUserOnLogin(tx, {
        issuer: "https://id.example.test/realms/ytw",
        sub: `sub-${username}`,
        username,
      }),
    );
    owner = { id: userResult.id, username };
  }

  // If the owner is not an admin, grant them the levels needed so the token ceiling is satisfied
  if (!options.isAdmin && owner.id !== admin.id) {
    for (const [resource, level] of Object.entries(levels) as [Resource, Level][]) {
      if (level !== "none") {
        await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
          setUserPermission(tx, {
            actingUserId: admin.id,
            userId: owner.id,
            resource,
            level,
          }),
        );
      }
    }
  }

  const tokenName = options.name ?? unique("agent");
  const issued = await createToken(db.pool("ytw_web"), owner, {
    name: tokenName,
    expiresAt: null,
    permissions: levels,
  });

  return {
    token: issued.token,
    secret: issued.secret,
    owner,
  };
}

export interface StartTestServerOptions {
  db?: TestDb | undefined;
  env?: Partial<Record<keyof Env, string | undefined>> | undefined;
  tools?: readonly ToolDefinition[] | undefined;
  limiter?: FailureLimiter | undefined;
}

export interface TestServer {
  app: FastifyInstance;
  url: string;
  mcpUrl: string;
  db: TestDb;
  close(): Promise<void>;
}

/**
 * Starts a live MCP Fastify server on an ephemeral localhost port.
 */
export async function startTestServer(options: StartTestServerOptions = {}): Promise<TestServer> {
  const db = options.db ?? (await createTestDb());
  const env = loadEnv({
    HOST: "127.0.0.1",
    PORT: "0",
    LOG_LEVEL: "silent",
    DATABASE_URL: db.url("ytw_mcp"),
    READONLY_DATABASE_URL: db.url("ytw_readonly"),
    ...options.env,
  });

  const defaultTools = await loadTools();
  const tools = options.tools ? [...defaultTools, ...options.tools] : defaultTools;

  const app = await buildApp(env, {
    pool: db.pool("ytw_mcp"),
    readonlyPool: db.pool("ytw_readonly"),
    tools,
    limiter: options.limiter,
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const mcpUrl = `${url}/mcp`;

  return {
    app,
    url,
    mcpUrl,
    db,
    close: async () => {
      await app.close();
      if (!options.db) {
        await db.drop();
      }
    },
  };
}

export interface TestClientResult {
  client: Client;
  transport: StreamableHTTPClientTransport;
  close(): Promise<void>;
}

/**
 * Connects an MCP SDK client to the test server with an optional bearer token.
 */
export async function createTestClient(
  mcpUrl: string,
  tokenSecret?: string,
): Promise<TestClientResult> {
  const url = mcpUrl.endsWith("/mcp") ? mcpUrl : `${mcpUrl}/mcp`;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: tokenSecret
      ? {
          headers: {
            Authorization: `Bearer ${tokenSecret}`,
          },
        }
      : undefined,
  });

  const client = new Client(
    {
      name: "test-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await client.connect(transport);

  return {
    client,
    transport,
    close: async () => {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    },
  };
}
