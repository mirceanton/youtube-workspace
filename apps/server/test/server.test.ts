import { createPool, lookupTokenByHash, migrationStatus } from "@ytw/db";
import { createTestDb, DEFAULT_TEST_DATABASE_URL, type TestDb } from "@ytw/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FailureLimiter, generateToken } from "../src/tokens/index.js";
import { callTool, envFor, rpc, toolNames } from "./helpers.js";

const READ_ALL = "ideas=read,scripts=read,experiments=read,videos=read,notes=read,activity=read";
const UNAUTHORIZED = { error: "unauthorized", message: "Unauthorized" };

let db: TestDb;
let app: FastifyInstance;
const gateway = generateToken();
// Every boot reconciles the seeded token with its environment, so a boot that must leave the
// gateway alone has to carry the same settings.
const gatewayEnv = {
  MCP_BOOTSTRAP_TOKEN: gateway.secret,
  MCP_BOOTSTRAP_TOKEN_NAME: "gateway",
  MCP_BOOTSTRAP_TOKEN_PERMISSIONS: "ideas=write,scripts=write,activity=read",
};

beforeAll(async () => {
  db = await createTestDb({ migrate: false });
  app = await buildApp(envFor(db, gatewayEnv), {
    pool: db.pool,
    limiter: new FailureLimiter({ maxFailures: 100 }),
  });
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

/** Another boot of the server on the same database, closed by the caller. */
function boot(extra: Record<string, string>, options: Parameters<typeof buildApp>[1] = {}) {
  return buildApp(envFor(db, extra), { pool: db.pool, ...options });
}

describe("boot", () => {
  it("migrates an empty database and seeds the configured token", async () => {
    expect((await migrationStatus(db.pool)).upToDate).toBe(true);
    expect(await lookupTokenByHash(db.pool, gateway.hash)).toMatchObject({
      status: "active",
      name: "gateway",
      effectiveLevels: { ideas: "write", scripts: "write", videos: "none", activity: "read" },
    });
  });

  it("answers health and readiness probes, and metrics", async () => {
    const health = await app.inject({ url: "/healthz" });
    expect(health.json()).toEqual({ status: "ok", version: "0.0.0-dev", commit: "unknown" });
    const ready = await app.inject({ url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready", checks: { database: "ok", schema: "ok" } });
    expect((await app.inject({ url: "/metrics" })).payload).toContain("ytw_build_info");
  });

  it("protects /metrics when METRICS_TOKEN is set", async () => {
    const metricsToken = "metrics-token-long-enough";
    const protectedApp = await boot({ ...gatewayEnv, METRICS_TOKEN: metricsToken });
    expect((await protectedApp.inject({ url: "/metrics" })).statusCode).toBe(401);
    const headers = { authorization: `Bearer ${metricsToken}` };
    expect((await protectedApp.inject({ url: "/metrics", headers })).statusCode).toBe(200);
    await protectedApp.close();
  });

  it("refuses to start on a database that is newer than the code", async () => {
    await db.pool.query(
      "INSERT INTO schema_migrations (version, filename, checksum, duration_ms) VALUES ('9999', '9999_future.sql', repeat('0', 64), 0)",
    );
    await expect(boot(gatewayEnv)).rejects.toThrow(/database migration failed/);
    await db.pool.query("DELETE FROM schema_migrations WHERE version = '9999'");
  });
});

describe("/mcp", () => {
  it("needs the bearer token of an active API token, and says nothing more than 401", async () => {
    const wrong = generateToken().secret;
    for (const secret of [undefined, "not-a-token", wrong]) {
      const response = await rpc(app, secret, "tools/list");
      expect([response.status, response.body]).toEqual([401, UNAUTHORIZED]);
    }
    const initialized = await rpc(app, gateway.secret, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(initialized.status).toBe(200);
    expect(initialized.body.result?.serverInfo?.name).toBe("youtube-workspace-mcp");
    expect((await app.inject({ method: "GET", url: "/mcp" })).statusCode).toBe(401);
  });

  it("offers the tools the token may use and audits a call under the token's name", async () => {
    const names = await toolNames(app, gateway.secret);
    expect(names).toContain("create_idea");
    expect(names).not.toContain("query_sql");

    const created = await callTool(app, gateway.secret, "create_idea", { title: "Why tests?" });
    expect(created.isError).toBe(false);
    const listed = await callTool(app, gateway.secret, "list_ideas");
    expect(JSON.stringify(listed.json)).toContain("Why tests?");

    const { rows } = await db.pool.query(
      `SELECT actor, actor_type, action, payload->>'tool' AS tool FROM events
        WHERE actor = 'gateway' AND (entity_id = $1 OR action = 'tool.call') ORDER BY created_at`,
      [created.json["id"]],
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ actor_type: "agent", action: "insert", tool: null }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ action: "tool.call", tool: "create_idea" }),
    );
  });

  it("refuses a tool the token has no level for, and audits the refusal", async () => {
    const denied = await callTool(app, gateway.secret, "list_videos");
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/videos/);
    const { rows } = await db.pool.query(
      "SELECT payload FROM events WHERE action = 'tool.call' AND payload->>'tool' = 'list_videos'",
    );
    expect(rows[0]?.payload).toMatchObject({ outcome: "denied" });
  });

  it("limits clients that keep sending bad tokens", async () => {
    const limited = await boot(gatewayEnv, { limiter: new FailureLimiter({ maxFailures: 2 }) });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await rpc(limited, undefined, "tools/list")).status);
    }
    expect(statuses).toEqual([401, 401, 429]);
    await limited.close();
  });
});

describe("script files", () => {
  it("round-trips a script through /files and rejects a stale upload", async () => {
    const idea = await callTool(app, gateway.secret, "create_idea", { title: "Files" });
    const url = `/files/scripts/${idea.json["id"]}/script`;
    const auth = { authorization: `Bearer ${gateway.secret}` };
    const put = (base: number, body: string) =>
      app.inject({
        method: "PUT",
        url: `${url}?base_version=${base}`,
        headers: { ...auth, "content-type": "text/markdown" },
        payload: body,
      });

    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: auth })).statusCode).toBe(404);
    expect((await put(0, "# Hello\n\nFirst draft.\n")).statusCode).toBe(201);

    const file = await app.inject({ url, headers: auth });
    expect(file.headers["content-type"]).toContain("text/markdown");
    expect(file.payload).toMatch(/^---\n[\s\S]*version: 1[\s\S]*---\n/);
    expect(file.payload).toContain("First draft.");

    const stale = await put(0, "# Hello again\n");
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "version_conflict", latest_version: 1 });
  });
});

describe("the seeded token follows the environment", () => {
  it("serves query_sql to a token that reads everything, unless the role is a superuser", async () => {
    const reader = generateToken();
    const plain = await boot({
      MCP_BOOTSTRAP_TOKEN: reader.secret,
      MCP_BOOTSTRAP_TOKEN_PERMISSIONS: READ_ALL,
    });
    expect(await toolNames(plain, reader.secret)).toContain("query_sql");
    const count = await callTool(plain, reader.secret, "query_sql", {
      sql: "SELECT count(*)::int AS n FROM ideas",
    });
    expect(count.json).toMatchObject({ rowCount: 1, rows: [{ n: expect.any(Number) }] });
    const write = await callTool(plain, reader.secret, "query_sql", { sql: "DELETE FROM ideas" });
    expect(write.isError).toBe(true);
    await plain.close();

    const url = new URL(process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
    url.pathname = `/${db.name}`;
    const lines: string[] = [];
    const superPool = createPool({ connectionString: url.toString() });
    const superuser = await buildApp(
      envFor(
        { url: url.toString() },
        {
          MCP_BOOTSTRAP_TOKEN: reader.secret,
          MCP_BOOTSTRAP_TOKEN_PERMISSIONS: READ_ALL,
          LOG_LEVEL: "warn",
        },
      ),
      { pool: superPool, logDestination: { write: (line) => lines.push(line) } },
    );
    expect(await toolNames(superuser, reader.secret)).not.toContain("query_sql");
    expect(lines.join("")).toContain("query_sql MCP tool is disabled");
    expect(lines.join("")).not.toContain(reader.secret);
    await superuser.close();
    await superPool.end();
  });

  it("revokes the token when the variable is unset and replaces it when it changes", async () => {
    const first = generateToken();
    const second = generateToken();

    const withFirst = await boot({ MCP_BOOTSTRAP_TOKEN: first.secret });
    expect((await rpc(withFirst, first.secret, "tools/list")).status).toBe(200);
    await withFirst.close();

    const without = await boot({});
    expect((await rpc(without, first.secret, "tools/list")).status).toBe(401);
    expect(await lookupTokenByHash(db.pool, first.hash)).toMatchObject({ status: "revoked" });
    await without.close();

    const withSecond = await boot({ MCP_BOOTSTRAP_TOKEN: second.secret });
    expect((await rpc(withSecond, second.secret, "tools/list")).status).toBe(200);
    expect((await rpc(withSecond, first.secret, "tools/list")).status).toBe(401);
    await withSecond.close();
  });
});
