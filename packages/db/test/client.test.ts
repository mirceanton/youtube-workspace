import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertPoolRole, createPool, sql, type Queryable } from "../src/client.js";
import { migrationStatus } from "../src/migrate.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { failure } from "./helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

describe("sql", () => {
  it("turns every interpolation into a bind parameter", () => {
    const name = "Robert'); DROP TABLE events; --";
    const query = sql`SELECT * FROM f(${name}, ${42}, ${null}) WHERE x = ${name}`;
    expect(query).toEqual({
      text: "SELECT * FROM f($1, $2, $3) WHERE x = $4",
      values: [name, 42, null, name],
    });
    expect(sql`SELECT 1`).toEqual({ text: "SELECT 1", values: [] });
  });

  it("round-trips hostile values unchanged through Postgres", async () => {
    const hostile = "'; DROP TABLE events; -- $1 \\ \" $$ x";
    const { rows } = await db
      .pool("ytw_web")
      .query<{ v: string }>(sql`SELECT ${hostile}::text AS v`);
    expect(rows[0]?.v).toBe(hostile);
  });
});

describe("createPool and assertPoolRole", () => {
  it("accept a pool that logs in as the expected role and name the connection", async () => {
    const pool = createPool({ role: "ytw_web", connectionString: db.url("ytw_web") });
    try {
      await assertPoolRole(pool, "ytw_web");
      const { rows } = await pool.query<{ name: string }>(
        "SELECT current_setting('application_name') AS name",
      );
      expect(rows[0]?.name).toBe("ytw-web");
    } finally {
      await pool.end();
    }
  });

  it("refuse a pool that logs in as another role or as a superuser", async () => {
    const wrong = createPool({ role: "ytw_web", connectionString: db.url("ytw_mcp") });
    const admin = createPool({ role: "ytw_mcp", connectionString: db.url("admin") });
    try {
      expect((await failure(assertPoolRole(wrong, "ytw_web"))).message).toMatch(
        /must log in as ytw_web, but it logs in as role ytw_mcp/,
      );
      expect((await failure(assertPoolRole(admin, "ytw_mcp"))).message).toMatch(/\(a superuser\)/);
    } finally {
      await Promise.all([wrong.end(), admin.end()]);
    }
  });

  it("give pools and clients the Queryable shape the wrappers take", async () => {
    const pool: Queryable = db.pool("ytw_mcp");
    expect(await migrationStatus(pool)).toMatchObject({ upToDate: true });
    const client = await db.pool("ytw_web").connect();
    try {
      const viaClient: Queryable = client;
      const { rows } = await viaClient.query<{ n: number }>(sql`SELECT ${2}::int + 1 AS n`);
      expect(rows[0]?.n).toBe(3);
    } finally {
      client.release();
    }
  });
});
