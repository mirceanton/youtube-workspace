import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../src/testing.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

describe("uuid_generate_v7", () => {
  it("returns version 7, RFC variant ids whose first 48 bits are the current Unix time in ms", async () => {
    const before = Date.now();
    const { rows } = await db.admin.query<{ id: string }>(
      "SELECT uuid_generate_v7()::text AS id FROM generate_series(1, 1000)",
    );
    const after = Date.now();
    for (const { id } of rows) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const ms = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
      expect(ms).toBeGreaterThanOrEqual(before - 1000);
      expect(ms).toBeLessThanOrEqual(after + 1000);
    }
  });

  it("is unique and sorts by creation time across milliseconds", async () => {
    const unique = await db.admin.query<{ n: number }>(
      "SELECT count(DISTINCT uuid_generate_v7())::int AS n FROM generate_series(1, 10000)",
    );
    expect(unique.rows[0]?.n).toBe(10_000);

    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { rows } = await db.admin.query<{ id: string }>(
        "SELECT pg_sleep(0.002), uuid_generate_v7()::text AS id",
      );
      ids.push(rows[0]?.id as string);
    }
    expect(ids.toSorted()).toEqual(ids);
  });
});
