// Isolation levels and lock order of the functions that write users, levels and revocations
// (migration 0055, T14 review).
//
// The first-login rule and the last-admin guard read "is there an admin?" AFTER the advisory lock
// (ytw_lock_users) was granted. That only works when each statement reads fresh data: under
// REPEATABLE READ the snapshot is taken by the first statement of the transaction (withActor's
// ytw_set_actor), before the lock, so two requests could both pass the check. The functions refuse
// that isolation level; READ COMMITTED (the default) is what they are built for and SERIALIZABLE is
// safe because Postgres aborts one of two conflicting transactions (40001, "retry").
//
// The same advisory lock comes first in EVERY function that writes users, permission rows or
// revocations, so they all lock in one order (advisory lock, then rows) and cannot deadlock (40P01).
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor, type ActorTx } from "../src/client.js";
import { ValidationError } from "../src/errors.js";
import { markUserOutsideAccessGroup, setUserAdmin, upsertUserOnLogin } from "../src/identity.js";
import { setUserAccessRevoked, setUserPermission } from "../src/permissions.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { failure } from "./helpers.js";
import { ISSUER, eventCount, login, person, promote, type TestUser } from "./identity-helpers.js";

type Isolation = "repeatable read" | "serializable";

/** A pool whose transactions start at `isolation`: what a misconfigured service would have. */
function isolatedPool(db: TestDb, isolation: Isolation, applicationName = "ytw-isolated"): Pool {
  return new Pool({
    connectionString: db.url("ytw_web"),
    max: 4,
    application_name: applicationName,
    options: `-c default_transaction_isolation=${isolation.replace(" ", "\\ ")}`,
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until some backend of `applicationName` is blocked on a lock. */
async function waitUntilBlocked(db: TestDb, applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { rowCount } = await db.admin.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock'`,
      [applicationName],
    );
    if ((rowCount ?? 0) > 0) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`no backend of ${applicationName} ever blocked on a lock`);
}

async function adminNames(db: TestDb): Promise<string[]> {
  const { rows } = await db.admin.query<{ username: string }>(
    "SELECT username FROM users WHERE is_admin ORDER BY username",
  );
  return rows.map((row) => row.username);
}

async function userCount(db: TestDb): Promise<number> {
  const { rows } = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
  return rows[0]?.n ?? -1;
}

/** The refusal every lock-taking function gives a REPEATABLE READ transaction. */
async function expectIsolationRefusal(attempt: Promise<unknown>): Promise<void> {
  const err = await failure(attempt);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).details).toMatchObject({
    reason: "isolation_level",
    isolation: "repeatable read",
  });
  expect(err.message).toMatch(/REPEATABLE READ/);
}

describe("REPEATABLE READ is refused by every function that takes the users lock", () => {
  let db: TestDb;
  let rr: Pool;
  let root: TestUser;
  let dana: TestUser;
  let erin: TestUser;

  beforeAll(async () => {
    db = await createTestDb();
    root = await login(db, "root");
    dana = await login(db, "dana");
    erin = await login(db, "erin");
    await promote(db, root, dana);
    rr = isolatedPool(db, "repeatable read");
  });
  afterAll(async () => {
    await rr.end();
    await db.drop();
  });

  it("refuses a sign-in, a promotion, a level change and both revocations, and writes nothing", async () => {
    const events = await eventCount(db);
    const attempts: [string, () => Promise<unknown>][] = [
      [
        "upsertUserOnLogin",
        () =>
          withActor(rr, person("erin"), (tx) =>
            upsertUserOnLogin(tx, { issuer: ISSUER, sub: "sub-erin", username: "erin" }),
          ),
      ],
      [
        "setUserAdmin",
        () =>
          withActor(rr, person("root"), (tx) =>
            setUserAdmin(tx, { actingUserId: root.id, userId: erin.id, isAdmin: true }),
          ),
      ],
      [
        "setUserPermission",
        () =>
          withActor(rr, person("root"), (tx) =>
            setUserPermission(tx, {
              actingUserId: root.id,
              userId: erin.id,
              resource: "ideas",
              level: "read",
            }),
          ),
      ],
      [
        "setUserAccessRevoked",
        () =>
          withActor(rr, person("root"), (tx) =>
            setUserAccessRevoked(tx, { actingUserId: root.id, userId: erin.id, revoked: true }),
          ),
      ],
      [
        "markUserOutsideAccessGroup",
        () =>
          withActor(rr, person("erin"), (tx) =>
            markUserOutsideAccessGroup(tx, { issuer: ISSUER, sub: "sub-erin" }),
          ),
      ],
    ];
    for (const [, attempt] of attempts) {
      await expectIsolationRefusal(attempt());
    }
    expect(await eventCount(db)).toBe(events);
    expect(await adminNames(db)).toEqual(["dana", "root"]);
  });

  it("says what to do about it", async () => {
    const err = await failure(
      withActor(rr, person("erin"), (tx) =>
        upsertUserOnLogin(tx, { issuer: ISSUER, sub: "sub-erin", username: "erin" }),
      ),
    );
    expect((err as ValidationError).hint).toMatch(/READ COMMITTED/);
    expect(err.message).toMatch(/READ COMMITTED/);
    expect(err.message).toMatch(/SERIALIZABLE/);
  });

  it("does not stop the functions from working in the default isolation level, or from a transaction that sets READ COMMITTED itself", async () => {
    expect(
      await withActor(db.pool("ytw_web"), person("erin"), (tx) =>
        upsertUserOnLogin(tx, { issuer: ISSUER, sub: "sub-erin", username: "erin" }),
      ),
    ).toMatchObject({ created: false, username: "erin" });
    // A service whose connections default to REPEATABLE READ can still ask for READ COMMITTED.
    const client = await rr.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const { rows } = await client.query<{ isolation: string }>(
        "SELECT current_setting('transaction_isolation') AS isolation",
      );
      expect(rows[0]?.isolation).toBe("read committed");
      await client.query(
        "SELECT * FROM set_user_permission('root', 'human', NULL, $1, $2, 'notes', 'read')",
        [root.id, erin.id],
      );
      await client.query("COMMIT");
    } finally {
      client.release(true);
    }
  });
});

describe("two first logins in REPEATABLE READ transactions", () => {
  it("make no admin at all instead of two", async () => {
    const db = await createTestDb();
    const rr = isolatedPool(db, "repeatable read");
    try {
      const outcomes = await Promise.allSettled(
        ["first", "second"].map((name) =>
          withActor(rr, person(name), (tx) =>
            upsertUserOnLogin(tx, { issuer: ISSUER, sub: `sub-${name}`, username: name }),
          ),
        ),
      );
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
      for (const outcome of outcomes) {
        await expectIsolationRefusal(Promise.reject((outcome as PromiseRejectedResult).reason));
      }
      expect(await userCount(db)).toBe(0);
    } finally {
      await rr.end();
      await db.drop();
    }
  });
});

describe("the last admin and a snapshot that is older than the lock", () => {
  it("cannot demote themselves from a REPEATABLE READ snapshot that still shows another admin", async () => {
    const db = await createTestDb();
    const rr = isolatedPool(db, "repeatable read");
    try {
      const u1 = await login(db, "u1");
      const u2 = await login(db, "u2");
      await promote(db, u1, u2);

      const attempt = withActor(rr, person("u1"), async (tx) => {
        // This transaction's snapshot exists now (ytw_set_actor), while u2 is still an admin ...
        await withActor(db.pool("ytw_web"), person("u1"), (other) =>
          setUserAdmin(other, { actingUserId: u1.id, userId: u2.id, isAdmin: false }),
        );
        // ... and u2 is demoted and committed before u1 looks: a stale snapshot would say "u2 is
        // still an admin, so u1 may leave" and the system would be left without one.
        return setUserAdmin(tx, { actingUserId: u1.id, userId: u1.id, isAdmin: false });
      });
      await expectIsolationRefusal(attempt);
      expect(await adminNames(db)).toEqual(["u1"]);
    } finally {
      await rr.end();
      await db.drop();
    }
  });
});

describe("SERIALIZABLE keeps the guarantees: one of two conflicting transactions is aborted", () => {
  it("a lone sign-in works, and the first user is the admin", async () => {
    const db = await createTestDb();
    const serializable = isolatedPool(db, "serializable");
    try {
      const first = await withActor(serializable, person("first"), (tx) =>
        upsertUserOnLogin(tx, { issuer: ISSUER, sub: "sub-first", username: "first" }),
      );
      expect(first).toMatchObject({ created: true, isAdmin: true });
    } finally {
      await serializable.end();
      await db.drop();
    }
  });

  it("a first login that waited for another one with an older snapshot fails with a serialization failure (retry) instead of becoming a second admin", async () => {
    const db = await createTestDb();
    const serializable = isolatedPool(db, "serializable", "ytw-serializable");
    try {
      let firstHoldsTheLock!: () => void;
      const lockHeld = new Promise<void>((resolve) => {
        firstHoldsTheLock = resolve;
      });
      const login1 = withActor(serializable, person("first"), async (tx) => {
        const result = await upsertUserOnLogin(tx, {
          issuer: ISSUER,
          sub: "sub-first",
          username: "first",
        });
        firstHoldsTheLock();
        // Commit only when the second login is queued behind our lock, snapshot already taken.
        await waitUntilBlocked(db, "ytw-serializable");
        return result;
      });
      const login2 = withActor(serializable, person("second"), async (tx) => {
        await lockHeld;
        return upsertUserOnLogin(tx, { issuer: ISSUER, sub: "sub-second", username: "second" });
      });

      const [one, two] = await Promise.allSettled([login1, login2]);
      expect(one.status).toBe("fulfilled");
      expect(two.status).toBe("rejected");
      expect(Reflect.get((two as PromiseRejectedResult).reason as object, "code")).toBe("40001");
      expect(await adminNames(db)).toEqual(["first"]);
      expect(await userCount(db)).toBe(1);

      // The retry the error asks for finds the first admin and becomes an ordinary user.
      const retried = await withActor(serializable, person("second"), (tx) =>
        upsertUserOnLogin(tx, { issuer: ISSUER, sub: "sub-second", username: "second" }),
      );
      expect(retried).toMatchObject({ created: true, isAdmin: false });
      expect(await adminNames(db)).toEqual(["first"]);
    } finally {
      await serializable.end();
      await db.drop();
    }
  });
});

describe("one lock order: the advisory lock first, then rows", () => {
  let db: TestDb;
  let root: TestUser;

  beforeAll(async () => {
    db = await createTestDb();
    root = await login(db, "root");
  });
  afterAll(async () => {
    await db.drop();
  });

  it("an access change followed by a promotion in one transaction does not deadlock with the target's sign-in", async () => {
    const u0 = await login(db, "u0");
    const u1 = await login(db, "u1");
    const poolA = new Pool({ connectionString: db.url("ytw_web"), max: 2 });
    const poolB = new Pool({
      connectionString: db.url("ytw_web"),
      max: 2,
      application_name: "ytw-late-login",
    });
    try {
      let levelChanged!: () => void;
      const changed = new Promise<void>((resolve) => {
        levelChanged = resolve;
      });
      const admin = withActor(poolA, person("root"), async (tx: ActorTx) => {
        // Share-locks root and u0 (before the fix, without the advisory lock) ...
        await setUserPermission(tx, {
          actingUserId: root.id,
          userId: u0.id,
          resource: "ideas",
          level: "read",
        });
        levelChanged();
        // ... while u0 signs in. Once that sign-in is waiting for us ...
        await waitUntilBlocked(db, "ytw-late-login");
        // ... the same transaction promotes somebody: it needs the advisory lock the sign-in
        // already holds (before the fix) while the sign-in waits for u0's row: a deadlock.
        return setUserAdmin(tx, { actingUserId: root.id, userId: u1.id, isAdmin: true });
      });
      const signIn = withActor(poolB, person("u0"), async (tx) => {
        await changed;
        return upsertUserOnLogin(tx, { issuer: ISSUER, sub: "sub-u0", username: "u0" });
      });

      const [promotion, signedIn] = await Promise.allSettled([admin, signIn]);
      expect(promotion).toMatchObject({ status: "fulfilled" });
      expect(signedIn).toMatchObject({ status: "fulfilled" });
      expect(await adminNames(db)).toEqual(["root", "u1"]);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  });

  it("sign-ins, level changes, promotions and revocations racing never deadlock: whatever is refused is refused for a business reason", async () => {
    const people: TestUser[] = [];
    for (const name of ["m0", "m1", "m2", "m3", "m4", "m5"]) {
      people.push(await login(db, name));
    }
    await promote(db, root, people[0] as TestUser);
    const pool = new Pool({ connectionString: db.url("ytw_web"), max: 12 });
    try {
      const operations: Promise<unknown>[] = [];
      for (let round = 0; round < 6; round += 1) {
        for (const [index, user] of people.entries()) {
          const other = people[(index + 1) % people.length] as TestUser;
          operations.push(
            withActor(pool, person(user.username), (tx) =>
              upsertUserOnLogin(tx, {
                issuer: ISSUER,
                sub: `sub-${user.username}`,
                username: user.username,
              }),
            ),
            withActor(pool, person("root"), (tx) =>
              setUserPermission(tx, {
                actingUserId: root.id,
                userId: other.id,
                resource: round % 2 === 0 ? "ideas" : "scripts",
                level: round % 3 === 0 ? "read" : "write",
              }),
            ),
            withActor(pool, person("root"), (tx) =>
              setUserAccessRevoked(tx, {
                actingUserId: root.id,
                userId: other.id,
                revoked: (round + index) % 2 === 0,
              }),
            ),
            withActor(pool, person("root"), (tx) =>
              setUserAdmin(tx, {
                actingUserId: root.id,
                userId: other.id,
                isAdmin: (round + index) % 3 === 0,
              }),
            ),
            withActor(pool, person(user.username), (tx) =>
              markUserOutsideAccessGroup(tx, { issuer: ISSUER, sub: `sub-${user.username}` }),
            ),
          );
        }
      }
      const outcomes = await Promise.allSettled(operations);
      const codes = outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
        .map((outcome) => String(Reflect.get(outcome.reason as object, "code") ?? "typed"));
      // 40P01 = deadlock detected, 40001 = serialization failure: neither may happen.
      expect(codes.filter((code) => code === "40P01" || code === "40001")).toEqual([]);
      expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
    } finally {
      await pool.end();
    }
  });
});
