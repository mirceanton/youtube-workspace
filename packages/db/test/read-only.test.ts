// queryReadOnly runs the SQL of `query_sql` on the normal pool: it must never be able to write.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryReadOnly } from "../src/client.js";
import { ValidationError } from "../src/errors.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { actAs, alice, failure } from "./helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await actAs(db, alice, (tx) => tx.query("INSERT INTO ideas (title) VALUES ('Existing')"));
  await db.pool.query("CREATE SEQUENCE public.counter");
});

afterAll(async () => {
  await db.drop();
});

const run = (text: string, timeoutMs?: number) =>
  queryReadOnly(db.pool, text, timeoutMs === undefined ? {} : { timeoutMs });
const ideaCount = async () =>
  Number((await db.pool.query("SELECT count(*) AS n FROM ideas")).rows[0]?.n);

describe("queryReadOnly", () => {
  it("returns the rows of one statement", async () => {
    const result = await run("SELECT title FROM ideas");
    expect(result.rows).toEqual([{ title: "Existing" }]);
    expect(result.fields.map((field) => field.name)).toEqual(["title"]);
  });

  it.each([
    "INSERT INTO ideas (title) VALUES ('Sneaky')",
    "UPDATE ideas SET title = 'Changed'",
    "DELETE FROM ideas",
    "TRUNCATE ideas",
    "CREATE TABLE sneaky (id integer)",
    "SELECT nextval('public.counter')",
  ])("refuses the write %s", async (statement) => {
    expect((await failure(run(statement))).code).toBe("25006");
  });

  it.each([
    "SET TRANSACTION READ WRITE",
    "SELECT set_config('transaction_read_only', 'off', true)",
    "DO $$ BEGIN SET LOCAL transaction_read_only = off; INSERT INTO ideas (title) VALUES ('x'); END $$",
  ])("cannot make its own transaction writable: %s", async (statement) => {
    expect((await failure(run(statement))).code).toBe("25001");
  });

  it.each([
    "SELECT 1; SELECT 2",
    "SELECT 1; INSERT INTO ideas (title) VALUES ('x')",
    "COMMIT; INSERT INTO ideas (title) VALUES ('x')",
  ])("refuses several statements: %s", async (statement) => {
    expect((await failure(run(statement))).code).toBe("42601");
  });

  it("stops at the timeout, even when the statement tries to lift it", async () => {
    expect((await failure(run("SELECT pg_sleep(5)", 100))).code).toBe("57014");
    const lifted =
      "DO $$ BEGIN PERFORM set_config('statement_timeout', '0', true); PERFORM pg_sleep(5); END $$";
    expect((await failure(run(lifted, 100))).code).toBe("57014");
  });

  it("leaves nothing of the session behind and validates its arguments", async () => {
    await run("SELECT set_config('ytw.leak', 'yes', false)");
    for (let i = 0; i < 6; i += 1) {
      const { rows } = await db.pool.query("SELECT current_setting('ytw.leak', true) AS leak");
      expect(rows[0]).toEqual({ leak: null });
    }
    expect(await failure(run("   "))).toBeInstanceOf(ValidationError);
    expect(await failure(run("SELECT 1", 60_000))).toBeInstanceOf(RangeError);
    expect(await ideaCount()).toBe(1);
  });
});
