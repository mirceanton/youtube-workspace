// Who may do what (migration 0052, T14): set_user_permission, set_user_admin, the access matrix, and
// the agreement of the SQL level rules with @ytw/shared and @ytw/policy.
//
// PRD 7: admins set other users' levels; the activity log is never write; an admin always holds the
// maximum (so the stored rows must say so too); the last admin cannot be demoted, however many
// demotions race; API tokens never manage access.
import {
  GRANTABLE_LEVELS,
  LEVELS,
  RESOURCES,
  type Level,
  type Resource,
} from "@ytw/shared/constants";
import { capLevel, levelsFromRows, minLevel, userLevels, type UserPrincipal } from "@ytw/policy";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, withActor, type Actor } from "../src/client.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../src/errors.js";
import { getUserAccess, setUserAdmin } from "../src/identity.js";
import { listUserAccess, setUserPermission } from "../src/permissions.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { failure } from "./helpers.js";
import {
  everywhere,
  eventCount,
  eventsFor,
  eventsSince,
  grant,
  login,
  mark,
  person,
  promote,
  unique,
  type TestUser,
} from "./identity-helpers.js";

const MAX_LEVELS = Object.fromEntries(
  RESOURCES.map((resource) => [resource, GRANTABLE_LEVELS[resource].at(-1)]),
) as Record<Resource, Level>;
const NO_ACCESS = everywhere("none");

async function storedRows(db: TestDb, userId: string): Promise<Record<string, string>> {
  const { rows } = await db.admin.query<{ resource: string; level: string }>(
    "SELECT resource, level FROM user_permissions WHERE user_id = $1 ORDER BY resource",
    [userId],
  );
  return Object.fromEntries(rows.map((row) => [row.resource, row.level]));
}

async function adminNames(db: TestDb): Promise<string[]> {
  const { rows } = await db.admin.query<{ username: string }>(
    "SELECT username FROM users WHERE is_admin ORDER BY username",
  );
  return rows.map((row) => row.username);
}

function setPermission(
  db: TestDb,
  acting: TestUser,
  user: TestUser,
  resource: Resource | string,
  level: Level | string,
  actor: Actor = person(acting.username),
) {
  return withActor(db.pool("ytw_web"), actor, (tx) =>
    setUserPermission(tx, {
      actingUserId: acting.id,
      userId: user.id,
      resource: resource as Resource,
      level: level as Level,
    }),
  );
}

function setAdmin(
  db: TestDb,
  acting: TestUser,
  user: TestUser,
  isAdmin: boolean,
  options: { keepLevels?: boolean; actor?: Actor; pool?: Pool } = {},
) {
  return withActor(
    options.pool ?? db.pool("ytw_web"),
    options.actor ?? person(acting.username),
    (tx) =>
      setUserAdmin(tx, {
        actingUserId: acting.id,
        userId: user.id,
        isAdmin,
        ...(options.keepLevels === undefined ? {} : { keepLevels: options.keepLevels }),
      }),
  );
}

describe("set_user_permission", () => {
  let db: TestDb;
  let root: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    db = await createTestDb();
    root = await login(db, "root");
    bob = await login(db, "bob");
  });
  afterAll(async () => {
    await db.drop();
  });

  it("an admin sets a level; the change is visible at once and audited with a readable event", async () => {
    const before = await mark(db);
    const change = await setPermission(db, root, bob, "scripts", "read");
    expect(change).toEqual({
      userId: bob.id,
      resource: "scripts",
      previousLevel: "none",
      level: "read",
      changed: true,
    });
    expect((await getUserAccess(db.pool("ytw_web"), bob.id))?.levels.scripts).toBe("read");
    expect((await storedRows(db, bob.id)).scripts).toBe("read");

    const events = await eventsSince(db, before);
    expect(events.map((event) => `${event.entity_type}:${event.action}`).toSorted()).toEqual([
      "user:user.permission_changed",
      "user_permission:update",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ actor: "root", actor_type: "human", token_id: null });
    }
    expect(events.find((event) => event.action === "user.permission_changed")).toMatchObject({
      entity_id: bob.id,
      payload: { user: "bob", resource: "scripts", from: "none", to: "read" },
    });
    expect(events.find((event) => event.action === "update")?.payload).toMatchObject({
      old: { level: "none" },
      new: { level: "read" },
    });
  });

  it("walks a cell through every level, reporting the previous one", async () => {
    const seen: string[] = [];
    for (const level of ["write", "read", "none", "write"] as const) {
      const change = await setPermission(db, root, bob, "ideas", level);
      seen.push(`${change.previousLevel}>${change.level}:${change.changed}`);
    }
    expect(seen).toEqual([
      "none>write:true",
      "write>read:true",
      "read>none:true",
      "none>write:true",
    ]);
  });

  it("changes nothing and logs nothing when the level already holds", async () => {
    await setPermission(db, root, bob, "videos", "read");
    const events = await eventCount(db);
    const again = await setPermission(db, root, bob, "videos", "read");
    expect(again).toMatchObject({ changed: false, previousLevel: "read", level: "read" });
    expect(await eventCount(db)).toBe(events);
  });

  // Every (object, level) pair: accepted exactly when the object can hold that level.
  const pairs = RESOURCES.flatMap((resource) => LEVELS.map((level) => [resource, level] as const));
  it.each(pairs)("%s %s", async (resource, level) => {
    const user = await login(db, `pair-${resource}-${level}-${unique()}`);
    const allowed = (GRANTABLE_LEVELS[resource] as readonly Level[]).includes(level);
    const attempt = setPermission(db, root, user, resource, level);
    if (allowed) {
      expect(await attempt).toMatchObject({ resource, level, changed: level !== "none" });
      expect((await getUserAccess(db.pool("ytw_web"), user.id))?.levels[resource]).toBe(level);
    } else {
      const err = await failure(attempt);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).allowed).toEqual(["none", "read"]);
      expect(err.message).toBe(
        `write is never allowed on activity (the maximum is read); choose one of: none, read`,
      );
      expect((await getUserAccess(db.pool("ytw_web"), user.id))?.levels[resource]).toBe("none");
    }
  });

  it("names the valid objects and levels when either is unknown", async () => {
    const badResource = await failure(setPermission(db, root, bob, "videoz", "read"));
    expect(badResource).toBeInstanceOf(ValidationError);
    expect((badResource as ValidationError).field).toBe("resource");
    expect((badResource as ValidationError).allowed).toEqual([...RESOURCES]);
    expect(badResource.message).toBe(
      `resource "videoz" is not an object with access levels; valid objects: ${RESOURCES.join(", ")}`,
    );

    const badLevel = await failure(setPermission(db, root, bob, "videos", "admin"));
    expect(badLevel).toBeInstanceOf(ValidationError);
    expect((badLevel as ValidationError).allowed).toEqual([...LEVELS]);
    expect(badLevel.message).toBe(
      'level "admin" is not an access level; valid levels: none, read, write',
    );
  });

  it("refuses a user who does not exist", async () => {
    const ghost = { id: "00000000-0000-4000-8000-000000000001", username: "ghost" };
    const err = await failure(setPermission(db, root, ghost, "ideas", "read"));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toMatch(/does not exist: users appear after their first login/);
  });

  it("only an admin may change levels", async () => {
    const reader = await login(db, `reader-${unique()}`);
    const before = await storedRows(db, bob.id);
    const err = await failure(setPermission(db, reader, bob, "notes", "write"));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe(
      `only an admin can change access levels, and "${reader.username}" is not an admin`,
    );
    expect((err as ForbiddenError).details).toMatchObject({ reason: "not_admin" });
    expect(await storedRows(db, bob.id)).toEqual(before);
  });

  it("an API token never changes levels, even one that names an admin as the acting user", async () => {
    const agent: Actor = { name: "root", type: "agent", tokenId: bob.id };
    const err = await failure(setPermission(db, root, bob, "notes", "write", agent));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toMatch(
      /^only a signed-in person can change access levels: API tokens never manage/,
    );
    expect((err as ForbiddenError).details).toMatchObject({ reason: "not_human" });
  });

  it("the audit actor must be the acting user: no changes under someone else's name", async () => {
    const err = await failure(setPermission(db, root, bob, "notes", "write", person("mallory")));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe(
      'the audit actor "mallory" is not the acting user "root": pass the signed-in user\'s username as the actor',
    );
    expect((await storedRows(db, bob.id)).notes).toBe("none");
  });

  it("refuses an acting user who does not exist", async () => {
    const ghost = { id: "00000000-0000-4000-8000-000000000002", username: "ghost" };
    const err = await failure(setPermission(db, ghost, bob, "ideas", "read"));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toMatch(/^the acting user .* does not exist$/);
  });

  it("never lowers an admin's levels; asking for the maximum they already hold is a no-op", async () => {
    const dora = await login(db, `dora-${unique()}`);
    await promote(db, root, dora);

    const err = await failure(setPermission(db, root, dora, "ideas", "read"));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe(
      `"${dora.username}" is an admin and always holds write on ideas: demote them first (set_user_admin) before lowering their access`,
    );
    expect(await storedRows(db, dora.id)).toEqual(MAX_LEVELS);

    const events = await eventCount(db);
    expect(await setPermission(db, root, dora, "ideas", "write")).toMatchObject({
      changed: false,
      previousLevel: "write",
      level: "write",
    });
    // The activity log's maximum is read.
    expect(await setPermission(db, root, dora, "activity", "read")).toMatchObject({
      changed: false,
    });
    const lowered = await failure(setPermission(db, root, dora, "activity", "none"));
    expect(lowered).toBeInstanceOf(ForbiddenError);
    // An admin cannot lower themselves either.
    const self = await failure(setPermission(db, root, root, "notes", "none"));
    expect(self).toBeInstanceOf(ForbiddenError);
    expect(await eventCount(db)).toBe(events);
  });
});

describe("set_user_admin", () => {
  let db: TestDb;
  let root: TestUser;

  beforeAll(async () => {
    db = await createTestDb();
    root = await login(db, "root");
  });
  afterAll(async () => {
    await db.drop();
  });

  it("promoting raises the stored rows to the maximum in the same transaction", async () => {
    const eve = await login(db, "eve");
    await grant(db, root, eve, { ideas: "read", scripts: "write" });
    const before = await mark(db);

    const change = await setAdmin(db, root, eve, true);
    expect(change).toEqual({
      userId: eve.id,
      username: "eve",
      isAdmin: true,
      previousIsAdmin: false,
      changed: true,
      levels: MAX_LEVELS,
    });
    expect(await storedRows(db, eve.id)).toEqual(MAX_LEVELS);
    expect((await getUserAccess(db.pool("ytw_web"), eve.id))?.isAdmin).toBe(true);

    const events = await eventsSince(db, before);
    const kinds = events.map((event) => `${event.entity_type}:${event.action}`);
    expect(kinds).toContain("user:update");
    expect(kinds).toContain("user:user.admin_granted");
    // Four rows were below the maximum (ideas read, experiments/videos/notes none), scripts and activity
    // were already there... activity was none: so five rows were raised.
    expect(kinds.filter((kind) => kind === "user_permission:update")).toHaveLength(5);
    expect(events.find((event) => event.action === "user.admin_granted")).toMatchObject({
      entity_id: eve.id,
      actor: "root",
      actor_type: "human",
      token_id: null,
      payload: { user: "eve" },
    });
  });

  it("promoting an admin again changes nothing and logs nothing", async () => {
    const eve = await login(db, "eve");
    const events = await eventCount(db);
    expect(await setAdmin(db, root, eve, true)).toMatchObject({ changed: false, isAdmin: true });
    expect(await eventCount(db)).toBe(events);
  });

  it("demoting resets the user to none on every object by default, so their tokens drop too", async () => {
    const fay = await login(db, "fay");
    await promote(db, root, fay);
    const before = await mark(db);

    const change = await setAdmin(db, root, fay, false);
    expect(change).toMatchObject({
      isAdmin: false,
      previousIsAdmin: true,
      changed: true,
      levels: NO_ACCESS,
    });
    expect(await storedRows(db, fay.id)).toEqual(NO_ACCESS);
    const events = await eventsSince(db, before);
    expect(events.find((event) => event.action === "user.admin_revoked")).toMatchObject({
      entity_id: fay.id,
      payload: { user: "fay", levels_reset: true },
    });
  });

  it("demoting with keepLevels keeps the stored rows: the person stays a user with those levels", async () => {
    const gil = await login(db, "gil");
    await promote(db, root, gil);
    const change = await setAdmin(db, root, gil, false, { keepLevels: true });
    expect(change).toMatchObject({ isAdmin: false, changed: true, levels: MAX_LEVELS });
    expect(await storedRows(db, gil.id)).toEqual(MAX_LEVELS);
    const events = await eventsFor(db, gil.id);
    expect(events.find((event) => event.action === "user.admin_revoked")?.payload).toMatchObject({
      levels_reset: false,
    });
  });

  it("demoting a user who is not an admin changes nothing", async () => {
    const hal = await login(db, "hal");
    const events = await eventCount(db);
    expect(await setAdmin(db, root, hal, false)).toMatchObject({
      changed: false,
      isAdmin: false,
      previousIsAdmin: false,
    });
    expect(await eventCount(db)).toBe(events);
  });

  it("only an admin may promote or demote", async () => {
    const ivy = await login(db, "ivy");
    const jon = await login(db, "jon");
    const err = await failure(setAdmin(db, ivy, jon, true));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe('only an admin can change who is an admin, and "ivy" is not an admin');
    expect((await getUserAccess(db.pool("ytw_web"), jon.id))?.isAdmin).toBe(false);
  });

  it("an API token never promotes or demotes, and the actor must be the acting user", async () => {
    const kim = await login(db, "kim");
    const agent: Actor = { name: "root", type: "agent", tokenId: kim.id };
    const asToken = await failure(setAdmin(db, root, kim, true, { actor: agent }));
    expect(asToken).toBeInstanceOf(ForbiddenError);
    expect(asToken.message).toMatch(/^only a signed-in person can change who is an admin/);
    const asOther = await failure(setAdmin(db, root, kim, true, { actor: person("mallory") }));
    expect(asOther).toBeInstanceOf(ForbiddenError);
    expect(asOther.message).toMatch(/audit actor "mallory" is not the acting user "root"/);
    expect((await getUserAccess(db.pool("ytw_web"), kim.id))?.isAdmin).toBe(false);
  });

  it("refuses an unknown user and a missing flag", async () => {
    const ghost = { id: "00000000-0000-4000-8000-000000000003", username: "ghost" };
    expect(await failure(setAdmin(db, root, ghost, true))).toBeInstanceOf(NotFoundError);
    const err = await failure(
      withActor(db.pool("ytw_web"), person("root"), (tx) =>
        tx.query(
          sql`SELECT * FROM set_user_admin(${tx.actor.name}, ${tx.actor.type}, ${tx.actor.tokenId},
                                           ${root.id}, ${root.id}, ${null})`,
        ),
      ),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("is_admin is required: true to promote, false to demote");
  });
});

describe("the last admin", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it("cannot be demoted, not even by themselves; once there is another admin, it can", async () => {
    const root = await login(db, "root");
    const err = await failure(setAdmin(db, root, root, false));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe(
      '"root" is the last admin and cannot be demoted: promote another user to admin first',
    );
    expect((err as ForbiddenError).details).toMatchObject({
      reason: "last_admin",
      user_id: root.id,
    });
    expect(await adminNames(db)).toEqual(["root"]);
    expect(await storedRows(db, root.id)).toEqual(MAX_LEVELS);

    const second = await login(db, "second");
    await promote(db, root, second);
    expect(await setAdmin(db, second, root, false)).toMatchObject({
      changed: true,
      isAdmin: false,
    });
    expect(await adminNames(db)).toEqual(["second"]);
    // ... and now second is the last one.
    const again = await failure(setAdmin(db, second, second, false));
    expect(again).toBeInstanceOf(ForbiddenError);
    expect(again.message).toMatch(/"second" is the last admin/);
  });
});

describe("the last admin under concurrency", () => {
  const ROUNDS = 10;

  it(`${ROUNDS} rounds of two admins demoting each other at the same moment leave exactly one admin`, async () => {
    const db = await createTestDb();
    const pool = new Pool({ connectionString: db.url("ytw_web"), max: 4 });
    try {
      const root = await login(db, "root");
      const other = await login(db, "other");
      for (let round = 0; round < ROUNDS; round += 1) {
        await promote(db, root, other);
        expect(await adminNames(db)).toEqual(["other", "root"]);

        const results = await Promise.allSettled([
          setAdmin(db, root, other, false, { pool }),
          setAdmin(db, other, root, false, { pool }),
        ]);
        const failures = results.filter((result) => result.status === "rejected");
        expect(failures).toHaveLength(1);
        expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(ForbiddenError);
        const survivors = await adminNames(db);
        expect(survivors).toHaveLength(1);

        // Put the loser back (the survivor is the admin) for the next round.
        const loser = survivors[0] === "root" ? other : root;
        const survivor = survivors[0] === "root" ? root : other;
        await promote(db, survivor, loser);
      }
    } finally {
      await pool.end();
      await db.drop();
    }
  });

  it("six admins demoting themselves in parallel: exactly five succeed, the last one is refused", async () => {
    const db = await createTestDb();
    const pool = new Pool({ connectionString: db.url("ytw_web"), max: 8 });
    try {
      const root = await login(db, "root");
      const admins: TestUser[] = [root];
      for (let index = 1; index < 6; index += 1) {
        const user = await login(db, `admin-${index}`);
        await promote(db, root, user);
        admins.push(user);
      }
      expect(await adminNames(db)).toHaveLength(6);

      const results = await Promise.allSettled(
        admins.map((admin) => setAdmin(db, admin, admin, false, { pool })),
      );
      const refused = results.filter((result) => result.status === "rejected");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
      expect(refused).toHaveLength(1);
      const reason = (refused[0] as PromiseRejectedResult).reason as Error;
      expect(reason).toBeInstanceOf(ForbiddenError);
      expect(reason.message).toMatch(/is the last admin and cannot be demoted/);

      const left = await adminNames(db);
      expect(left).toHaveLength(1);
      // The survivor still holds the maximum, in the stored rows too; the five others hold none.
      const { rows } = await db.admin.query<{
        username: string;
        is_admin: boolean;
        levels: string;
      }>(
        `SELECT u.username, u.is_admin,
                (SELECT string_agg(p.level, ',' ORDER BY p.resource)
                   FROM user_permissions p WHERE p.user_id = u.id) AS levels
           FROM users u ORDER BY u.username`,
      );
      for (const row of rows) {
        expect(row.levels).toBe(
          row.is_admin
            ? Object.entries(MAX_LEVELS)
                .toSorted(([a], [b]) => a.localeCompare(b))
                .map(([, level]) => level)
                .join(",")
            : "none,none,none,none,none,none",
        );
      }
    } finally {
      await pool.end();
      await db.drop();
    }
  });

  it("many admins demoting each other in a ring never leave the system without an admin", async () => {
    const db = await createTestDb();
    const pool = new Pool({ connectionString: db.url("ytw_web"), max: 8 });
    try {
      const root = await login(db, "root");
      const admins: TestUser[] = [root];
      for (let index = 1; index < 6; index += 1) {
        const user = await login(db, `admin-${index}`);
        await promote(db, root, user);
        admins.push(user);
      }
      const results = await Promise.allSettled(
        admins.map((admin, index) =>
          setAdmin(db, admin, admins[(index + 1) % admins.length] as TestUser, false, { pool }),
        ),
      );
      const succeeded = results.filter((result) => result.status === "fulfilled").length;
      // Around a ring every demoter is also somebody's victim, so not all six can act in time.
      expect(succeeded).toBeLessThanOrEqual(5);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(ForbiddenError);
        }
      }
      expect((await adminNames(db)).length).toBe(6 - succeeded);
      expect((await adminNames(db)).length).toBeGreaterThanOrEqual(1);
    } finally {
      await pool.end();
      await db.drop();
    }
  });
});

describe("promotion racing with changes to the same user's levels", () => {
  it("never leaves an admin whose stored rows are below the maximum", async () => {
    const db = await createTestDb();
    const pool = new Pool({ connectionString: db.url("ytw_web"), max: 12 });
    try {
      const root = await login(db, "root");
      for (let round = 0; round < 12; round += 1) {
        const target = await login(db, `target-${round}`);
        await grant(db, root, target, { ideas: "write", scripts: "write", notes: "write" });
        const lowerings = RESOURCES.filter((resource) => resource !== "activity").map((resource) =>
          withActor(pool, person("root"), (tx) =>
            setUserPermission(tx, {
              actingUserId: root.id,
              userId: target.id,
              resource,
              level: "none",
            }),
          ),
        );
        const results = await Promise.allSettled([
          setAdmin(db, root, target, true, { pool }),
          ...lowerings,
        ]);
        // The promotion always succeeds; each lowering either ran before it (and was then undone by the
        // promotion) or was refused because the user already was an admin.
        expect(results[0]?.status).toBe("fulfilled");
        for (const result of results.slice(1)) {
          if (result.status === "rejected") {
            expect(result.reason).toBeInstanceOf(ForbiddenError);
            expect((result.reason as Error).message).toMatch(/is an admin and always holds/);
          }
        }
        expect(await storedRows(db, target.id)).toEqual(MAX_LEVELS);
        expect((await getUserAccess(db.pool("ytw_web"), target.id))?.levels).toEqual(MAX_LEVELS);
      }
    } finally {
      await pool.end();
      await db.drop();
    }
  });
});

describe("the access matrix (list_users_with_levels)", () => {
  let db: TestDb;
  let root: TestUser;
  beforeAll(async () => {
    db = await createTestDb();
    root = await login(db, "root");
  });
  afterAll(async () => {
    await db.drop();
  });

  it("lists every user, oldest first, with the levels they hold", async () => {
    const lee = await login(db, "lee");
    const max = await login(db, "max");
    await grant(db, root, lee, { ideas: "write", activity: "read" });
    await grant(db, root, max, { scripts: "read" });

    const matrix = await listUserAccess(db.pool("ytw_web"), root.id);
    expect(matrix.map((user) => user.username)).toEqual(["root", "lee", "max"]);
    expect(matrix.map((user) => user.isAdmin)).toEqual([true, false, false]);
    expect(matrix[0]?.levels).toEqual(MAX_LEVELS);
    expect(matrix[1]?.levels).toEqual({ ...NO_ACCESS, ideas: "write", activity: "read" });
    expect(matrix[2]?.levels).toEqual({ ...NO_ACCESS, scripts: "read" });
    expect(matrix[1]).toMatchObject({
      id: lee.id,
      email: "lee@example.test",
      issuer: expect.any(String),
    });
  });

  it("is for admins only", async () => {
    const nobody = await login(db, "nobody");
    const err = await failure(listUserAccess(db.pool("ytw_web"), nobody.id));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe("only an admin can list the access levels of all users");
    const unknown = await failure(
      listUserAccess(db.pool("ytw_web"), "00000000-0000-4000-8000-000000000004"),
    );
    expect(unknown).toBeInstanceOf(ForbiddenError);
  });
});

describe("agreement with @ytw/shared and @ytw/policy", () => {
  let db: TestDb;
  let root: TestUser;
  beforeAll(async () => {
    db = await createTestDb();
    root = await login(db, "root");
  });
  afterAll(async () => {
    await db.drop();
  });

  it("lists the same objects and maximum levels as @ytw/shared", async () => {
    const { rows } = await db.admin.query<{ resources: string[] }>(
      "SELECT ytw_resources() AS resources",
    );
    expect(rows[0]?.resources).toEqual([...RESOURCES]);
    for (const resource of RESOURCES) {
      const { rows: max } = await db.admin.query<{ max: string }>(
        "SELECT ytw_max_level($1) AS max",
        [resource],
      );
      expect(max[0]?.max).toBe(GRANTABLE_LEVELS[resource].at(-1));
    }
    const unknown = await db.admin.query<{ max: string | null; rank: number | null }>(
      "SELECT ytw_max_level('sponsors') AS max, ytw_level_rank('admin') AS rank",
    );
    expect(unknown.rows[0]).toEqual({ max: null, rank: null });
  });

  it("ranks levels like @ytw/shared LEVELS and caps and compares like @ytw/policy", async () => {
    for (const level of LEVELS) {
      const { rows } = await db.admin.query<{ rank: number }>("SELECT ytw_level_rank($1) AS rank", [
        level,
      ]);
      expect(rows[0]?.rank).toBe(LEVELS.indexOf(level));
    }
    for (const a of LEVELS) {
      for (const b of LEVELS) {
        const { rows } = await db.admin.query<{ least: string }>(
          "SELECT ytw_least_level($1, $2) AS least",
          [a, b],
        );
        expect(rows[0]?.least).toBe(minLevel(a, b));
      }
      for (const resource of RESOURCES) {
        const { rows } = await db.admin.query<{ cap: string }>(
          "SELECT ytw_cap_level($1, $2) AS cap",
          [resource, a],
        );
        expect(rows[0]?.cap).toBe(capLevel(resource, a));
      }
    }
  });

  it("computes a user's effective levels exactly like policy userLevels from the stored rows", async () => {
    const patterns: Partial<Record<Resource, Level>>[] = [
      {},
      { ideas: "read" },
      { scripts: "write", notes: "read", activity: "read" },
      everywhere("read"),
      everywhere("write"),
      { experiments: "write", videos: "read" },
    ];
    for (const [index, pattern] of patterns.entries()) {
      const user = await login(db, `policy-${index}`);
      await grant(db, root, user, pattern);
      for (const admin of [false, true]) {
        if (admin) {
          await promote(db, root, user);
        }
        const { rows } = await db.admin.query<{ resource: string; level: string }>(
          "SELECT resource, level FROM user_permissions WHERE user_id = $1",
          [user.id],
        );
        const principal: UserPrincipal = {
          kind: "user",
          userId: user.id,
          username: user.username,
          isAdmin: admin,
          levels: levelsFromRows(rows),
        };
        expect((await getUserAccess(db.pool("ytw_web"), user.id))?.levels).toEqual(
          userLevels(principal),
        );
      }
    }
  });
});
