import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebSession, setUserAdmin, upsertUserOnLogin, withActor } from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { CSRF_HEADER, meResponseSchema } from "@ytw/shared/api/session";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { encryptSessionData } from "../src/web/session-crypto.js";
import { envFor } from "./helpers.js";

const SESSION_SECRET = "s".repeat(40);
const ORIGIN = "https://workspace.example.com";
const OIDC = {
  OIDC_ISSUER_URL: "https://auth.example.com",
  OIDC_CLIENT_ID: "workspace",
  OIDC_CLIENT_SECRET: "client-secret-value",
  OIDC_REDIRECT_URI: `${ORIGIN}/auth/callback`,
  SESSION_SECRET,
};

let db: TestDb;
let staticDir: string;

beforeAll(async () => {
  db = await createTestDb();
  staticDir = await mkdtemp(join(tmpdir(), "ytw-web-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>app</title>");
});

afterAll(async () => {
  await rm(staticDir, { recursive: true, force: true });
  await db.drop();
});

const logLines: string[] = [];

async function boot(extra: Record<string, string>): Promise<FastifyInstance> {
  return buildApp(envFor(db, { STATIC_WEB_DIR: staticDir, LOG_LEVEL: "info", ...extra }), {
    pool: db.pool,
    logDestination: { write: (line) => logLines.push(line) },
  });
}

describe("single-user mode (no OIDC_*)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await boot({});
  });
  afterAll(async () => {
    await app.close();
  });

  it("treats every request as the local owner, an admin with a CSRF token", async () => {
    const me = await app.inject({ url: "/api/me" });
    expect(me.statusCode).toBe(200);
    const body = meResponseSchema.parse(me.json());
    expect(body.user).toMatchObject({ username: "owner", email: "owner@localhost", isAdmin: true });
    expect(me.headers[CSRF_HEADER.toLowerCase()]).toBeTruthy();
    expect((await app.inject({ url: "/auth/login" })).headers.location).toBe("/");
    expect((await app.inject({ url: "/auth/logout" })).headers.location).toBe("/");
  });

  it("creates an idea through /api with the CSRF header and audits it as the owner", async () => {
    const token = (await app.inject({ url: "/api/me" })).headers[CSRF_HEADER.toLowerCase()];
    const create = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: "/api/ideas", headers, payload: { title: "From the UI" } });

    expect((await create({})).statusCode).toBe(403);
    const created = await create({ [CSRF_HEADER]: String(token) });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ url: "/api/ideas" })).json()).toMatchObject({
      ideas: [{ title: "From the UI" }],
    });
    const { rows } = await db.pool.query(
      "SELECT actor, actor_type FROM events WHERE action = 'insert' AND entity_type = 'idea'",
    );
    expect(rows).toEqual([{ actor: "owner", actor_type: "human" }]);
  });

  it("serves the app and falls back to it for client routes, but never opens /mcp", async () => {
    expect((await app.inject({ url: "/ideas/123" })).payload).toContain("<title>app</title>");
    expect((await app.inject({ url: "/api/unknown" })).statusCode).toBe(404);
    const mcp = await app.inject({ method: "POST", url: "/mcp", payload: {} });
    expect(mcp.statusCode).toBe(401);
  });
});

describe("with OIDC", () => {
  let app: FastifyInstance;
  let cookie: string;
  beforeAll(async () => {
    app = await boot(OIDC);
    const person = { name: "alice", type: "human" } as const;
    const alice = await withActor(db.pool, person, (tx) =>
      upsertUserOnLogin(tx, { issuer: OIDC.OIDC_ISSUER_URL, sub: "alice", username: "alice" }),
    );
    // The owner of the single-user tests came first and is the admin; Alice needs the levels.
    const owner = await db.pool.query<{ id: string }>("SELECT id FROM users WHERE is_admin");
    await withActor(db.pool, { name: "owner", type: "human" }, (tx) =>
      setUserAdmin(tx, { actingUserId: owner.rows[0]?.id ?? "", userId: alice.id, isAdmin: true }),
    );
    const session = await createWebSession(db.pool, {
      userId: alice.id,
      refreshTokenEncrypted: encryptSessionData(SESSION_SECRET, {
        version: 1,
        issuer: OIDC.OIDC_ISSUER_URL,
        subject: "alice",
        username: "alice",
        refreshToken: null,
        accessTokenExpiresAt: Date.now() + 3_600_000,
        returnTo: "/",
      }),
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 7200,
    });
    cookie = `ytw_session=${session.id}`;
  });
  afterAll(async () => {
    await app.close();
  });

  it("answers 401 without a session and sends page requests to the login", async () => {
    expect((await app.inject({ url: "/api/me" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/ideas" })).statusCode).toBe(401);
    const page = await app.inject({
      url: "/ideas?stage=inbox",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe("/auth/login?return_to=%2Fideas%3Fstage%3Dinbox");
    const forged = await app.inject({ url: "/api/me", headers: { cookie: "ytw_session=nope" } });
    expect(forged.statusCode).toBe(401);
  });

  it("accepts a session cookie, and mutations need the CSRF token and the same origin", async () => {
    const me = await app.inject({ url: "/api/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { username: "alice", isAdmin: true } });
    const token = String(me.headers[CSRF_HEADER.toLowerCase()]);

    const create = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/api/ideas",
        headers: { cookie, ...headers },
        payload: { title: "Signed in" },
      });
    expect((await create({ origin: ORIGIN })).statusCode).toBe(403);
    expect((await create({ [CSRF_HEADER]: token })).statusCode).toBe(403);
    expect(
      (await create({ [CSRF_HEADER]: token, origin: "https://evil.example" })).statusCode,
    ).toBe(403);
    expect((await create({ [CSRF_HEADER]: token, origin: ORIGIN })).statusCode).toBe(201);

    const app$ = await app.inject({ url: "/", headers: { cookie } });
    expect(app$.payload).toContain("<title>app</title>");
  });

  it("keeps the session id out of the database and the logs", async () => {
    const id = cookie.slice("ytw_session=".length);
    const stored = await db.pool.query(
      "SELECT count(*)::int AS n, count(*) FILTER (WHERE id_hash = decode(replace($1, '-', ''), 'hex'))::int AS raw FROM ytw_private.web_sessions",
      [id],
    );
    expect(stored.rows[0]).toMatchObject({ raw: 0 });
    expect(stored.rows[0]?.n).toBeGreaterThan(0);
    await app.inject({ url: "/api/me", headers: { cookie } });
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("")).not.toContain(id);
  });
});
