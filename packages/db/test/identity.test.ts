// Signing in (migration 0051, T14): upsert_user_on_login and get_user_access.
//
// PRD 7: the very first user becomes admin with the maximum on every object, in one transaction so
// that only one user can claim it; every later user starts with none everywhere. The race tests
// need a database without users, so they (and the first-login tests) get databases of their own.
import { GRANTABLE_LEVELS, RESOURCES, type Level, type Resource } from "@ytw/shared/constants";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor, type Actor } from "../src/client.js";
import { ForbiddenError, ValidationError } from "../src/errors.js";
import { getUserAccess, upsertUserOnLogin } from "../src/identity.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { failure } from "./helpers.js";
import { ISSUER, eventsSince, login, mark, person } from "./identity-helpers.js";

/** The highest level each object can hold: what an admin has everywhere. */
const MAX_LEVELS = Object.fromEntries(
  RESOURCES.map((resource) => [resource, GRANTABLE_LEVELS[resource].at(-1)]),
) as Record<Resource, Level>;
const NO_ACCESS = Object.fromEntries(RESOURCES.map((resource) => [resource, "none"])) as Record<
  Resource,
  Level
>;

async function storedRows(db: TestDb, userId: string): Promise<Record<string, string>> {
  const { rows } = await db.admin.query<{ resource: string; level: string }>(
    "SELECT resource, level FROM user_permissions WHERE user_id = $1 ORDER BY resource",
    [userId],
  );
  return Object.fromEntries(rows.map((row) => [row.resource, row.level]));
}

describe("the first user", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it("becomes admin with the maximum level on every object, the activity log read-only", async () => {
    const before = await mark(db);
    const alice = await login(db, "alice", { displayName: "Alice Liddell" });

    expect(alice).toMatchObject({
      created: true,
      isAdmin: true,
      username: "alice",
      issuer: ISSUER,
      subject: "sub-alice",
      email: "alice@example.test",
      displayName: "Alice Liddell",
    });
    expect(alice.lastLoginAt).toBeInstanceOf(Date);
    expect(alice.levels).toEqual(MAX_LEVELS);
    expect(alice.levels.activity).toBe("read");
    // The stored rows agree with the admin rule: one per object, at the maximum.
    expect(await storedRows(db, alice.id)).toEqual(MAX_LEVELS);

    // Audit: one insert for the user and one per permission row, all attributed to the person.
    const events = await eventsSince(db, before);
    expect(events.map((event) => `${event.entity_type}:${event.action}`).toSorted()).toEqual(
      ["user:insert", ...RESOURCES.map(() => "user_permission:insert")].toSorted(),
    );
    for (const event of events) {
      expect(event).toMatchObject({ actor: "alice", actor_type: "human", token_id: null });
    }
    // Personal identifiers stay out of the log.
    const text = JSON.stringify(events);
    expect(text).not.toContain("alice@example.test");
    expect(text).not.toContain("sub-alice");
  });

  it("is followed by users who start with none on every object", async () => {
    const bob = await login(db, "bob");
    expect(bob).toMatchObject({ created: true, isAdmin: false, username: "bob" });
    expect(bob.levels).toEqual(NO_ACCESS);
    expect(await storedRows(db, bob.id)).toEqual(NO_ACCESS);

    const carol = await login(db, "carol");
    expect(carol.isAdmin).toBe(false);
    const { rows } = await db.admin.query<{ username: string }>(
      "SELECT username FROM users WHERE is_admin ORDER BY username",
    );
    expect(rows).toEqual([{ username: "alice" }]);
  });
});

describe("first logins racing", () => {
  const ROUNDS = 3;
  const RACERS = 20;

  for (let round = 1; round <= ROUNDS; round += 1) {
    it(`round ${round}: ${RACERS} parallel first logins of different people produce exactly one admin`, async () => {
      const db = await createTestDb();
      const pool = new Pool({ connectionString: db.url("ytw_web"), max: RACERS });
      try {
        const results = await Promise.all(
          Array.from({ length: RACERS }, (_, index) =>
            withActor(pool, person(`racer-${index}`), (tx) =>
              upsertUserOnLogin(tx, {
                issuer: ISSUER,
                sub: `racer-sub-${index}`,
                username: `racer-${index}`,
              }),
            ),
          ),
        );
        expect(results.filter((result) => result.isAdmin)).toHaveLength(1);
        expect(results.every((result) => result.created)).toBe(true);

        const { rows } = await db.admin.query<{ username: string; is_admin: boolean }>(
          "SELECT username, is_admin FROM users",
        );
        expect(rows).toHaveLength(RACERS);
        expect(rows.filter((row) => row.is_admin)).toHaveLength(1);

        // The winner has the maximum everywhere, everyone else has none, in the stored rows too.
        const winner = results.find((result) => result.isAdmin);
        expect(winner?.levels).toEqual(MAX_LEVELS);
        for (const result of results) {
          expect(await storedRows(db, result.id)).toEqual(result.isAdmin ? MAX_LEVELS : NO_ACCESS);
        }
      } finally {
        await pool.end();
        await db.drop();
      }
    });
  }

  it("parallel logins of the SAME new identity create one user and one admin", async () => {
    const db = await createTestDb();
    const pool = new Pool({ connectionString: db.url("ytw_web"), max: RACERS });
    try {
      const results = await Promise.all(
        Array.from({ length: RACERS }, () =>
          withActor(pool, person("dana"), (tx) =>
            upsertUserOnLogin(tx, { issuer: ISSUER, sub: "same-sub", username: "dana" }),
          ),
        ),
      );
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(results.every((result) => result.isAdmin)).toBe(true);
      const { rows } = await db.admin.query<{ n: number }>(
        "SELECT (SELECT count(*) FROM users)::int AS n",
      );
      expect(rows[0]?.n).toBe(1);
      expect(await storedRows(db, results[0]?.id ?? "")).toEqual(MAX_LEVELS);
    } finally {
      await pool.end();
      await db.drop();
    }
  });
});

describe("logging in", () => {
  let db: TestDb;
  let admin: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    db = await createTestDb();
    admin = await login(db, "root");
  });
  afterAll(async () => {
    await db.drop();
  });

  it("an existing user is updated, not duplicated: same id, new last login, same levels", async () => {
    const first = await login(db, "erin");
    const before = await mark(db);
    const second = await login(db, "erin");

    expect(second).toMatchObject({ id: first.id, created: false, isAdmin: false });
    expect(second.lastLoginAt?.getTime() ?? 0).toBeGreaterThan(first.lastLoginAt?.getTime() ?? 0);
    expect(second.levels).toEqual(NO_ACCESS);
    expect(Object.keys(await storedRows(db, first.id))).toHaveLength(RESOURCES.length);

    // Only the login time changed: one update event on the user, nothing on the permission rows.
    const events = await eventsSince(db, before);
    expect(events.map((event) => `${event.entity_type}:${event.action}`)).toEqual(["user:update"]);
    expect(events[0]?.payload).toMatchObject({
      old: { last_login_at: expect.any(String) },
      new: { last_login_at: expect.any(String) },
    });
    expect(events[0]).toMatchObject({ actor: "erin", actor_type: "human", token_id: null });
  });

  it("mirrors the profile of the identity provider, including a new username and cleared fields", async () => {
    const first = await login(db, "frank", { sub: "frank-sub", displayName: "Frank Furter" });
    expect(first).toMatchObject({ email: "frank@example.test", displayName: "Frank Furter" });

    const renamed = await login(db, "franklin", {
      sub: "frank-sub",
      email: "franklin@example.test",
      displayName: null,
    });
    expect(renamed).toMatchObject({
      id: first.id,
      created: false,
      username: "franklin",
      email: "franklin@example.test",
      displayName: null,
    });
    // The identity is (issuer, sub): the same sub at another issuer is another person.
    const elsewhere = await login(db, "frank", {
      sub: "frank-sub",
      issuer: "https://other-idp.example.test",
    });
    expect(elsewhere.id).not.toBe(first.id);
    expect(elsewhere.created).toBe(true);
  });

  it("drops optional claims that cannot be stored instead of failing the login", async () => {
    const odd = await login(db, "gina", {
      email: "not an email address",
      displayName: `  Gina\n\tG${"x".repeat(300)}  `,
    });
    expect(odd.email).toBeNull();
    expect(odd.displayName).toHaveLength(200);
    expect(odd.displayName).toMatch(/^Gina G/);
    expect(odd.displayName).not.toMatch(/[\n\t]/);

    expect((await login(db, "hal", { email: "x" })).email).toBeNull();
    expect((await login(db, "ivy", { email: `${"a".repeat(320)}@x.test` })).email).toBeNull();
    expect((await login(db, "jon", { email: "  jon@example.test " })).email).toBe(
      "jon@example.test",
    );
    expect((await login(db, "kim", { displayName: " \n " })).displayName).toBeNull();
  });

  it("trims the username the way the audit actor is trimmed", async () => {
    const user = await withActor(db.pool("ytw_web"), { name: " lena ", type: "human" }, (tx) =>
      upsertUserOnLogin(tx, { issuer: ISSUER, sub: "lena-sub", username: " lena " }),
    );
    expect(user.username).toBe("lena");
  });

  const invalid: [string, Parameters<typeof upsertUserOnLogin>[1], string][] = [
    ["issuer", { issuer: "", sub: "s", username: "x" }, "issuer"],
    ["issuer with whitespace", { issuer: "https://a b", sub: "s", username: "x" }, "issuer"],
    [
      "issuer too long",
      { issuer: `https://${"a".repeat(2050)}`, sub: "s", username: "x" },
      "issuer",
    ],
    ["sub", { issuer: ISSUER, sub: "", username: "x" }, "sub"],
    ["sub with a control character", { issuer: ISSUER, sub: "a\u0007b", username: "x" }, "sub"],
    ["sub too long", { issuer: ISSUER, sub: "s".repeat(256), username: "x" }, "sub"],
    ["blank username", { issuer: ISSUER, sub: "s", username: "   " }, "username"],
    ["username too long", { issuer: ISSUER, sub: "s", username: "u".repeat(201) }, "username"],
    ["username with a newline", { issuer: ISSUER, sub: "s", username: "a\nb" }, "username"],
  ];

  it.each(invalid)("refuses a login without a valid %s", async (_label, input, field) => {
    const actor: Actor = { name: "someone", type: "human" };
    const err = await failure(
      withActor(db.pool("ytw_web"), actor, (tx) => upsertUserOnLogin(tx, input)),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).field).toBe(field);
    expect(err.message).toMatch(new RegExp(`${field} is required`));
  });

  it("only the person signing in can log in as themselves: another actor is refused", async () => {
    const victim = await login(db, "victim");
    const err = await failure(
      withActor(db.pool("ytw_web"), person("mallory"), (tx) =>
        upsertUserOnLogin(tx, { issuer: ISSUER, sub: "sub-victim", username: "victim" }),
      ),
    );
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toMatch(/audit actor "mallory" is not the signing-in user "victim"/);
    const after = await getUserAccess(db.pool("ytw_web"), victim.id);
    expect(after?.lastLoginAt).toEqual(victim.lastLoginAt);
  });

  it("an API token cannot log in", async () => {
    const agent: Actor = { name: "robot", type: "agent", tokenId: admin.id };
    const err = await failure(
      withActor(db.pool("ytw_web"), agent, (tx) =>
        upsertUserOnLogin(tx, { issuer: ISSUER, sub: "robot-sub", username: "robot" }),
      ),
    );
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toMatch(/API tokens cannot log in/);
    const { rows } = await db.admin.query("SELECT 1 FROM users WHERE username = 'robot'");
    expect(rows).toHaveLength(0);
  });

  it("restores the one-row-per-object invariant when rows are missing or too low", async () => {
    const mia = await login(db, "mia");
    // Rows deleted by hand (as after an object type was added without a backfill).
    await withActor(db.admin, person("fixer"), (tx) =>
      tx.query(
        "DELETE FROM user_permissions WHERE user_id = $1 AND resource IN ('ideas', 'notes')",
        [mia.id],
      ),
    );
    expect(Object.keys(await storedRows(db, mia.id))).toHaveLength(RESOURCES.length - 2);
    await login(db, "mia");
    expect(await storedRows(db, mia.id)).toEqual(NO_ACCESS);

    // An admin whose rows were lowered by hand is raised again at the next login.
    await withActor(db.admin, person("fixer"), (tx) =>
      tx.query("UPDATE user_permissions SET level = 'none' WHERE user_id = $1", [admin.id]),
    );
    const again = await login(db, "root");
    expect(again.levels).toEqual(MAX_LEVELS);
    expect(await storedRows(db, admin.id)).toEqual(MAX_LEVELS);
  });
});

describe("get_user_access", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it("returns the user with the levels they hold now, or null for an unknown id", async () => {
    const root = await login(db, "root");
    const nina = await login(db, "nina");
    const web = db.pool("ytw_web");

    expect(await getUserAccess(web, root.id)).toMatchObject({
      id: root.id,
      isAdmin: true,
      levels: MAX_LEVELS,
      username: "root",
    });
    expect(await getUserAccess(web, nina.id)).toMatchObject({ isAdmin: false, levels: NO_ACCESS });
    expect(await getUserAccess(web, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("applies the admin rule even when stored rows are lower (the stricter side is never the looser)", async () => {
    const root = await login(db, "root");
    await withActor(db.admin, person("fixer"), (tx) =>
      tx.query("UPDATE user_permissions SET level = 'none' WHERE user_id = $1", [root.id]),
    );
    expect((await getUserAccess(db.pool("ytw_web"), root.id))?.levels).toEqual(MAX_LEVELS);
  });
});
