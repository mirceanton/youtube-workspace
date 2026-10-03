// Access revocation (migrations 0056-0058, T14 review). PRD 7: the access group check "is repeated on
// every token refresh, so removing someone from the group in Keycloak ends their access", and a
// token's level is the lower of its own and its owner's CURRENT level. users.access_revoked_at is how
// the database knows a person has no access: their levels are none (admins included), they are not an
// admin for @ytw/policy, they cannot manage anything, their tokens are dead (status owner_revoked),
// their sessions are gone, and signing in again (or an admin) brings back exactly what was stored.
import { GRANTABLE_LEVELS, RESOURCES, type Level, type Resource } from "@ytw/shared/constants";
import { principalLevels, userLevels, type TokenPrincipal, type UserPrincipal } from "@ytw/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor, type Actor, type ActorTx } from "../src/client.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../src/errors.js";
import {
  getUserAccess,
  markUserOutsideAccessGroup,
  setUserAdmin,
  upsertUserOnLogin,
} from "../src/identity.js";
import { listUserAccess, setUserAccessRevoked, setUserPermission } from "../src/permissions.js";
import { createWebSession, getWebSession } from "../src/sessions.js";
import {
  createApiToken,
  getApiToken,
  listApiTokens,
  lookupTokenByHash,
  revokeApiToken,
  rotateApiToken,
  toTokenPrincipal,
  touchTokenLastUsed,
  updateTokenPermissions,
  type FoundToken,
} from "../src/tokens.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { failure } from "./helpers.js";
import {
  ISSUER,
  eventCount,
  eventsSince,
  everywhere,
  grant,
  login,
  makeToken,
  mark,
  newSecret,
  person,
  promote,
  unique,
  type TestUser,
} from "./identity-helpers.js";

const MAX_LEVELS = Object.fromEntries(
  RESOURCES.map((resource) => [resource, GRANTABLE_LEVELS[resource].at(-1)]),
) as Record<Resource, Level>;
const NO_ACCESS = Object.fromEntries(RESOURCES.map((resource) => [resource, "none"])) as Record<
  Resource,
  Level
>;
const WRITER: Partial<Record<Resource, Level>> = { ideas: "write", scripts: "read" };
const WRITER_LEVELS: Record<Resource, Level> = { ...NO_ACCESS, ideas: "write", scripts: "read" };

const web = (db: TestDb) => db.pool("ytw_web");
const mcp = (db: TestDb) => db.pool("ytw_mcp");

/** What the web server does when the identity provider says `user` is outside the access group. */
function markOutside(db: TestDb, user: TestUser) {
  return withActor(web(db), person(user.username), (tx) =>
    markUserOutsideAccessGroup(tx, { issuer: ISSUER, sub: `sub-${user.username}` }),
  );
}

/** An admin locks `user` out (revoked) or restores them. */
function lockOut(db: TestDb, admin: TestUser, user: TestUser, revoked = true) {
  return withActor(web(db), person(admin.username), (tx) =>
    setUserAccessRevoked(tx, { actingUserId: admin.id, userId: user.id, revoked }),
  );
}

/** A new ordinary user with the given levels, set by `root`. */
async function newPerson(
  db: TestDb,
  root: TestUser,
  levels: Partial<Record<Resource, Level>> = {},
): Promise<TestUser> {
  const user = await login(db, `person-${unique()}`);
  await grant(db, root, user, levels);
  return user;
}

async function newAdmin(db: TestDb, root: TestUser): Promise<TestUser> {
  const user = await login(db, `admin-${unique()}`);
  await promote(db, root, user);
  return user;
}

async function openSessions(db: TestDb, user: TestUser, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const session = await createWebSession(web(db), {
      userId: user.id,
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86_400,
    });
    ids.push(session.id);
  }
  return ids;
}

async function sessionCount(db: TestDb, userId: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM ytw_private.web_sessions WHERE user_id = $1",
    [userId],
  );
  return rows[0]?.n ?? -1;
}

async function userCount(db: TestDb): Promise<number> {
  const { rows } = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
  return rows[0]?.n ?? -1;
}

async function activeAdmins(db: TestDb): Promise<string[]> {
  const { rows } = await db.admin.query<{ username: string }>(
    "SELECT username FROM users WHERE is_admin AND access_revoked_at IS NULL ORDER BY username",
  );
  return rows.map((row) => row.username);
}

async function storedRows(db: TestDb, userId: string): Promise<Record<string, string>> {
  const { rows } = await db.admin.query<{ resource: string; level: string }>(
    "SELECT resource, level FROM user_permissions WHERE user_id = $1 ORDER BY resource",
    [userId],
  );
  return Object.fromEntries(rows.map((row) => [row.resource, row.level]));
}

async function foundToken(db: TestDb, hash: string): Promise<FoundToken> {
  const found = await lookupTokenByHash(mcp(db), hash);
  if (found.status === "unknown") {
    throw new Error("token unexpectedly unknown");
  }
  return found;
}

async function lastUsedAt(db: TestDb, tokenId: string): Promise<Date | null> {
  const { rows } = await db.admin.query<{ last_used_at: Date | null }>(
    "SELECT last_used_at FROM ytw_private.api_tokens WHERE id = $1",
    [tokenId],
  );
  return rows[0]?.last_used_at ?? null;
}

async function expireToken(db: TestDb, tokenId: string): Promise<void> {
  await withActor(db.admin, person("fixer"), (tx) =>
    tx.query(
      "UPDATE ytw_private.api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [tokenId],
    ),
  );
}

/** Waits until a statement containing `fragment` is blocked on a lock; false when none ever is. */
async function waitUntilQueued(db: TestDb, fragment: string): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rowCount } = await db.admin.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
      [`%${fragment}%`],
    );
    if ((rowCount ?? 0) > 0) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** Runs `attempt`, expects a refusal of kind forbidden with the given `reason`. */
async function expectRefusal(attempt: Promise<unknown>, reason: string): Promise<ForbiddenError> {
  const err = await failure(attempt);
  expect(err).toBeInstanceOf(ForbiddenError);
  expect((err as ForbiddenError).details).toMatchObject({ reason });
  return err as ForbiddenError;
}

function asPerson<T>(db: TestDb, user: TestUser, fn: (tx: ActorTx) => Promise<T>): Promise<T> {
  return withActor(web(db), person(user.username), fn);
}

describe("a person outside the access group (mark_user_outside_access_group)", () => {
  let db: TestDb;
  let root: TestUser;

  beforeAll(async () => {
    db = await createTestDb();
    root = await login(db, "root");
  });
  afterAll(async () => {
    await db.drop();
  });

  it("ends their access: no levels, not an admin, the stored rows kept, and it says since when", async () => {
    const user = await newPerson(db, root, WRITER);
    expect(await getUserAccess(web(db), user.id)).toMatchObject({
      isAdmin: false,
      accessRevokedAt: null,
      levels: WRITER_LEVELS,
    });
    const stored = await storedRows(db, user.id);

    const result = await markOutside(db, user);
    expect(result).toMatchObject({
      userId: user.id,
      username: user.username,
      changed: true,
      sessionsEnded: 0,
    });
    expect(result?.accessRevokedAt).toBeInstanceOf(Date);

    const after = await getUserAccess(web(db), user.id);
    expect(after).toMatchObject({ isAdmin: false, levels: NO_ACCESS });
    expect(after?.accessRevokedAt).toEqual(result?.accessRevokedAt);
    expect(await storedRows(db, user.id)).toEqual(stored);
  });

  it("ends every browser session of the person, on every device, and only theirs", async () => {
    const user = await newPerson(db, root, WRITER);
    const other = await newPerson(db, root, WRITER);
    const sessions = await openSessions(db, user, 3);
    const [otherSession] = await openSessions(db, other, 1);

    const result = await markOutside(db, user);
    expect(result?.sessionsEnded).toBe(3);
    expect(await sessionCount(db, user.id)).toBe(0);
    for (const id of sessions) {
      expect(await getWebSession(web(db), id)).toBeNull();
    }
    expect(await getWebSession(web(db), otherSession ?? "")).toMatchObject({ status: "active" });
  });

  it("logs one readable event under the person's name and leaves their identifiers out of the log", async () => {
    const user = await newPerson(db, root, WRITER);
    await openSessions(db, user, 2);
    const since = await mark(db);
    await markOutside(db, user);

    const events = await eventsSince(db, since);
    expect(events.map((event) => `${event.entity_type}:${event.action}`).toSorted()).toEqual([
      "user:update",
      "user:user.access_revoked",
    ]);
    expect(events.find((event) => event.action === "user.access_revoked")).toMatchObject({
      actor: user.username,
      actor_type: "human",
      token_id: null,
      entity_id: user.id,
      payload: {
        user: user.username,
        via: "identity_provider",
        sessions_ended: 2,
        no_active_admin: false,
      },
    });
    const text = JSON.stringify(events);
    expect(text).not.toContain(`sub-${user.username}`);
    expect(text).not.toContain(`${user.username}@example.test`);
  });

  it("is idempotent: a second call changes nothing, ends no new access and writes no event", async () => {
    const user = await newPerson(db, root, WRITER);
    const first = await markOutside(db, user);
    const since = await mark(db);
    const again = await markOutside(db, user);
    expect(again).toMatchObject({ changed: false, sessionsEnded: 0 });
    expect(again?.accessRevokedAt).toEqual(first?.accessRevokedAt);
    expect(await eventsSince(db, since)).toEqual([]);
  });

  it("never creates a user: an unknown identity gets no row and nothing is written", async () => {
    const someone = await newPerson(db, root, WRITER);
    const users = await userCount(db);
    const events = await eventCount(db);

    const never = await withActor(web(db), person("stranger"), (tx) =>
      markUserOutsideAccessGroup(tx, { issuer: ISSUER, sub: `sub-never-${unique()}` }),
    );
    expect(never).toBeNull();
    // The identity is (issuer, sub): the same subject under another issuer is another person.
    const elsewhere = await withActor(web(db), person(someone.username), (tx) =>
      markUserOutsideAccessGroup(tx, {
        issuer: "https://other.example.test/realms/elsewhere",
        sub: `sub-${someone.username}`,
      }),
    );
    expect(elsewhere).toBeNull();

    expect(await userCount(db)).toBe(users);
    expect(await eventCount(db)).toBe(events);
    expect(await getUserAccess(web(db), someone.id)).toMatchObject({
      accessRevokedAt: null,
      levels: WRITER_LEVELS,
    });
  });

  it("is for a person acting through the web server: an API token cannot, and a missing issuer or subject is a validation error", async () => {
    const user = await newPerson(db, root, WRITER);
    const bot = await makeToken(db, user, { permissions: { ideas: "read" } });
    const agent: Actor = { name: bot.token.name, type: "agent", tokenId: bot.token.id };
    await expectRefusal(
      withActor(web(db), agent, (tx) =>
        markUserOutsideAccessGroup(tx, { issuer: ISSUER, sub: `sub-${user.username}` }),
      ),
      "not_human",
    );
    expect(await getUserAccess(web(db), user.id)).toMatchObject({ accessRevokedAt: null });

    const noIssuer = await failure(
      asPerson(db, user, (tx) => markUserOutsideAccessGroup(tx, { issuer: "", sub: "s" })),
    );
    expect(noIssuer).toBeInstanceOf(ValidationError);
    expect((noIssuer as ValidationError).field).toBe("issuer");
    const noSub = await failure(
      asPerson(db, user, (tx) => markUserOutsideAccessGroup(tx, { issuer: ISSUER, sub: "" })),
    );
    expect((noSub as ValidationError).field).toBe("sub");
  });
});

describe("the tokens of a person whose access is revoked", () => {
  let db: TestDb;
  let root: TestUser;

  beforeAll(async () => {
    db = await createTestDb();
    root = await login(db, "root");
  });
  afterAll(async () => {
    await db.drop();
  });

  it("are dead at once, report owner_revoked and never active, and keep their own levels", async () => {
    const user = await newPerson(db, root, WRITER);
    const made = await makeToken(db, user, { permissions: WRITER });
    const before = await foundToken(db, made.hash);
    expect(before.status).toBe("active");
    expect(before.effectiveLevels).toEqual(WRITER_LEVELS);

    await markOutside(db, user);

    const found = await foundToken(db, made.hash);
    expect(found.status).toBe("owner_revoked");
    expect(found.effectiveLevels).toEqual(NO_ACCESS);
    expect(found.owner).toMatchObject({ id: user.id, isAdmin: false, levels: NO_ACCESS });
    expect(found.levels).toEqual(WRITER_LEVELS);
    expect(() => toTokenPrincipal(found)).toThrow(/owner_revoked/);
    expect((await lookupTokenByHash(mcp(db), newSecret().hash)).status).toBe("unknown");

    // The settings screens and the admin CLI read the same status.
    expect(await getApiToken(web(db), user.id, made.token.id)).toMatchObject({
      status: "owner_revoked",
      effectiveLevels: NO_ACCESS,
      levels: WRITER_LEVELS,
    });
    expect((await listApiTokens(web(db), user.id)).map((token) => token.status)).toEqual([
      "owner_revoked",
    ]);
    // A use is not recorded for a token that cannot act.
    expect(await touchTokenLastUsed(mcp(db), made.token)).toBe(false);
    expect(await lastUsedAt(db, made.token.id)).toBeNull();
  });

  it("report the facts about the token first: revoked, then expired, then owner_revoked", async () => {
    const user = await newPerson(db, root, WRITER);
    const revoked = await makeToken(db, user, { permissions: WRITER });
    const expired = await makeToken(db, user, {
      permissions: WRITER,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const live = await makeToken(db, user, { permissions: WRITER });
    await asPerson(db, user, (tx) =>
      revokeApiToken(tx, { actingUserId: user.id, apiTokenId: revoked.token.id }),
    );
    await expireToken(db, expired.token.id);

    await markOutside(db, user);

    expect(
      await Promise.all(
        [revoked, expired, live].map(async (made) => (await foundToken(db, made.hash)).status),
      ),
    ).toEqual(["revoked", "expired", "owner_revoked"]);
  });

  it("work again, unchanged, once the person's access is restored by signing in", async () => {
    const user = await newPerson(db, root, WRITER);
    const made = await makeToken(db, user, { permissions: WRITER });
    await markOutside(db, user);
    expect((await foundToken(db, made.hash)).status).toBe("owner_revoked");

    const back = await login(db, user.username);
    expect(back).toMatchObject({ created: false, accessRevokedAt: null, levels: WRITER_LEVELS });
    const found = await foundToken(db, made.hash);
    expect(found.status).toBe("active");
    expect(found.effectiveLevels).toEqual(WRITER_LEVELS);
    expect(await touchTokenLastUsed(mcp(db), made.token)).toBe(true);
  });

  it("cannot be revived by creating new ones: a revoked person cannot create, change, rotate or revoke tokens", async () => {
    const user = await newPerson(db, root, WRITER);
    const made = await makeToken(db, user, { permissions: WRITER });
    await markOutside(db, user);
    const hashes = newSecret();
    const events = await eventCount(db);

    await expectRefusal(
      asPerson(db, user, (tx) =>
        createApiToken(tx, {
          ownerUserId: user.id,
          name: "again",
          tokenPrefix: hashes.prefix,
          tokenHash: hashes.hash,
          expiresAt: null,
          permissions: { ideas: "read" },
        }),
      ),
      "access_revoked",
    );
    await expectRefusal(
      asPerson(db, user, (tx) =>
        updateTokenPermissions(tx, {
          actingUserId: user.id,
          apiTokenId: made.token.id,
          permissions: { ideas: "read" },
        }),
      ),
      "access_revoked",
    );
    await expectRefusal(
      asPerson(db, user, (tx) =>
        rotateApiToken(tx, {
          actingUserId: user.id,
          apiTokenId: made.token.id,
          newTokenPrefix: hashes.prefix,
          newTokenHash: hashes.hash,
        }),
      ),
      "access_revoked",
    );
    await expectRefusal(
      asPerson(db, user, (tx) =>
        revokeApiToken(tx, { actingUserId: user.id, apiTokenId: made.token.id }),
      ),
      "access_revoked",
    );
    expect(await eventCount(db)).toBe(events);
  });
});

describe("a revoked admin looks like nobody", () => {
  let db: TestDb;
  let root: TestUser;

  beforeAll(async () => {
    db = await createTestDb();
    root = await login(db, "root");
  });
  afterAll(async () => {
    await db.drop();
  });

  it("is not an admin for @ytw/policy anywhere the database returns the flag: the user, the matrix and their tokens", async () => {
    const admin = await newAdmin(db, root);
    const made = await makeToken(db, admin, { permissions: everywhere("write") });
    expect((await foundToken(db, made.hash)).effectiveLevels).toEqual(MAX_LEVELS);

    await lockOut(db, root, admin);

    const access = await getUserAccess(web(db), admin.id);
    expect(access).toMatchObject({ isAdmin: false, levels: NO_ACCESS });
    const asUser: UserPrincipal = {
      kind: "user",
      userId: admin.id,
      username: admin.username,
      isAdmin: access?.isAdmin ?? true,
      levels: access?.levels ?? MAX_LEVELS,
    };
    expect(userLevels(asUser)).toEqual(NO_ACCESS);

    const found = await foundToken(db, made.hash);
    expect(found.status).toBe("owner_revoked");
    expect(found.owner.isAdmin).toBe(false);
    expect(found.effectiveLevels).toEqual(NO_ACCESS);
    // A caller that ignored `status` and built the principal by hand would still get nothing.
    const careless: TokenPrincipal = {
      kind: "token",
      tokenId: found.id,
      tokenName: found.name,
      levels: found.levels,
      owner: {
        userId: found.owner.id,
        username: found.owner.username,
        isAdmin: found.owner.isAdmin,
        levels: found.owner.levels,
      },
    };
    expect(principalLevels(careless)).toEqual(NO_ACCESS);

    const row = (await listUserAccess(web(db), root.id)).find((user) => user.id === admin.id);
    expect(row).toMatchObject({ isAdmin: false, levels: NO_ACCESS });
    expect(row?.accessRevokedAt).toBeInstanceOf(Date);

    // Restoring brings the admin back with everything they had.
    await lockOut(db, root, admin, false);
    expect(await getUserAccess(web(db), admin.id)).toMatchObject({
      isAdmin: true,
      levels: MAX_LEVELS,
      accessRevokedAt: null,
    });
    expect((await foundToken(db, made.hash)).effectiveLevels).toEqual(MAX_LEVELS);
  });

  it.each([
    ["an admin", true],
    ["an ordinary user with write access", false],
  ])("%s whose access is revoked cannot manage anything", async (_label, isAdmin) => {
    const subject = isAdmin ? await newAdmin(db, root) : await newPerson(db, root, WRITER);
    const target = await newPerson(db, root, WRITER);
    const made = await makeToken(db, subject, { permissions: { ideas: "read" } });
    await markOutside(db, subject);
    const fresh = newSecret();
    const events = await eventCount(db);

    const attempts: Promise<unknown>[] = [
      asPerson(db, subject, (tx) =>
        setUserPermission(tx, {
          actingUserId: subject.id,
          userId: target.id,
          resource: "ideas",
          level: "read",
        }),
      ),
      asPerson(db, subject, (tx) =>
        setUserAdmin(tx, { actingUserId: subject.id, userId: target.id, isAdmin: true }),
      ),
      asPerson(db, subject, (tx) =>
        setUserAccessRevoked(tx, { actingUserId: subject.id, userId: target.id, revoked: true }),
      ),
      asPerson(db, subject, (tx) =>
        createApiToken(tx, {
          ownerUserId: subject.id,
          name: "nope",
          tokenPrefix: fresh.prefix,
          tokenHash: fresh.hash,
          expiresAt: null,
          permissions: {},
        }),
      ),
      asPerson(db, subject, (tx) =>
        revokeApiToken(tx, { actingUserId: subject.id, apiTokenId: made.token.id }),
      ),
      listUserAccess(web(db), subject.id),
      createWebSession(web(db), {
        userId: subject.id,
        idleTimeoutSeconds: 3600,
        absoluteTimeoutSeconds: 86_400,
      }),
    ];
    const outcomes = await Promise.allSettled(attempts);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      const reason = (outcome as PromiseRejectedResult).reason as ForbiddenError;
      expect(reason).toBeInstanceOf(ForbiddenError);
      expect(reason.details).toMatchObject({ reason: "access_revoked" });
    }
    expect(await eventCount(db)).toBe(events);
    expect(await sessionCount(db, subject.id)).toBe(0);
    expect(await getUserAccess(web(db), target.id)).toMatchObject({
      isAdmin: false,
      levels: WRITER_LEVELS,
    });
  });
});

describe("signing in again after the group check passed", () => {
  let db: TestDb;
  let root: TestUser;

  beforeAll(async () => {
    db = await createTestDb();
    root = await login(db, "root");
  });
  afterAll(async () => {
    await db.drop();
  });

  it("restores exactly what was there (admin flag and levels included), logs it, and lets a session start", async () => {
    const admin = await newAdmin(db, root);
    const [sessionId] = await openSessions(db, admin, 1);
    await markOutside(db, admin);
    expect(await getWebSession(web(db), sessionId ?? "")).toBeNull();

    const since = await mark(db);
    const back = await login(db, admin.username);
    expect(back).toMatchObject({
      id: admin.id,
      created: false,
      isAdmin: true,
      levels: MAX_LEVELS,
      accessRevokedAt: null,
    });
    expect(await getUserAccess(web(db), admin.id)).toMatchObject({
      isAdmin: true,
      accessRevokedAt: null,
    });

    const events = await eventsSince(db, since);
    expect(events.find((event) => event.action === "user.access_restored")).toMatchObject({
      actor: admin.username,
      actor_type: "human",
      entity_id: admin.id,
      payload: { user: admin.username, via: "sign_in" },
    });
    expect(await openSessions(db, admin, 1)).toHaveLength(1);
  });

  it("is the only thing that lifts the revocation besides an admin: a user who never signed in again stays out", async () => {
    const user = await newPerson(db, root, WRITER);
    await markOutside(db, user);
    // Reads, profile changes of other people and permission edits do not lift it.
    await grant(db, root, user, { notes: "read" });
    expect(await getUserAccess(web(db), user.id)).toMatchObject({
      levels: NO_ACCESS,
      accessRevokedAt: expect.any(Date),
    });
    // ... and the edit was kept for when they are back.
    expect((await storedRows(db, user.id)).notes).toBe("read");
    expect(await login(db, user.username)).toMatchObject({
      levels: { ...WRITER_LEVELS, notes: "read" },
    });
  });

  it("a login of a person who is not revoked writes no restoration event", async () => {
    const user = await newPerson(db, root, WRITER);
    const since = await mark(db);
    await login(db, user.username);
    const events = await eventsSince(db, since);
    expect(events.map((event) => event.action)).toEqual(["update"]);
  });

  it("a sign-in cannot be forged for another person: the actor must be the signing-in user", async () => {
    const user = await newPerson(db, root, WRITER);
    await markOutside(db, user);
    const err = await failure(
      withActor(web(db), person("somebody-else"), (tx) =>
        upsertUserOnLogin(tx, {
          issuer: ISSUER,
          sub: `sub-${user.username}`,
          username: user.username,
        }),
      ),
    );
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(await getUserAccess(web(db), user.id)).toMatchObject({ levels: NO_ACCESS });
  });
});

describe("an admin locking a person out (set_user_access_revoked)", () => {
  let db: TestDb;
  let root: TestUser;
  let dana: TestUser;

  beforeAll(async () => {
    db = await createTestDb();
    root = await login(db, "root");
    dana = await login(db, "dana");
    await promote(db, root, dana);
  });
  afterAll(async () => {
    await db.drop();
  });

  it("locks out and restores, ends the sessions, and logs who did it", async () => {
    const user = await newPerson(db, root, WRITER);
    const made = await makeToken(db, user, { permissions: WRITER });
    await openSessions(db, user, 2);
    const since = await mark(db);

    const out = await lockOut(db, root, user);
    expect(out).toMatchObject({
      userId: user.id,
      username: user.username,
      changed: true,
      sessionsEnded: 2,
    });
    expect(out.accessRevokedAt).toBeInstanceOf(Date);
    expect(await sessionCount(db, user.id)).toBe(0);
    expect(await getUserAccess(web(db), user.id)).toMatchObject({
      levels: NO_ACCESS,
      accessRevokedAt: out.accessRevokedAt,
    });
    expect((await foundToken(db, made.hash)).status).toBe("owner_revoked");

    const back = await lockOut(db, root, user, false);
    expect(back).toMatchObject({ changed: true, accessRevokedAt: null, sessionsEnded: 0 });
    expect(await getUserAccess(web(db), user.id)).toMatchObject({
      levels: WRITER_LEVELS,
      accessRevokedAt: null,
    });
    expect((await foundToken(db, made.hash)).status).toBe("active");

    const events = (await eventsSince(db, since)).filter((event) =>
      event.action.startsWith("user."),
    );
    expect(events.map((event) => event.action)).toEqual([
      "user.access_revoked",
      "user.access_restored",
    ]);
    expect(events[0]).toMatchObject({
      actor: "root",
      actor_type: "human",
      token_id: null,
      entity_id: user.id,
      payload: { user: user.username, via: "admin", sessions_ended: 2 },
    });
    expect(events[1]).toMatchObject({
      actor: "root",
      payload: { user: user.username, via: "admin" },
    });
  });

  it("asking for the state the user is already in changes nothing and writes no event", async () => {
    const user = await newPerson(db, root, WRITER);
    expect(await lockOut(db, root, user, false)).toMatchObject({ changed: false });
    await lockOut(db, root, user);
    const since = await mark(db);
    expect(await lockOut(db, root, user)).toMatchObject({ changed: false, sessionsEnded: 0 });
    expect(await eventsSince(db, since)).toEqual([]);
  });

  it("is for admins whose access is active, acting as themselves, on a user that exists", async () => {
    const user = await newPerson(db, root, WRITER);
    const bystander = await newPerson(db, root, { ideas: "write" });
    await expectRefusal(lockOut(db, bystander, user), "not_admin");
    // The actor is the audit name of the acting user, not whatever the caller says.
    await expectRefusal(
      withActor(web(db), person("dana"), (tx) =>
        setUserAccessRevoked(tx, { actingUserId: root.id, userId: user.id, revoked: true }),
      ),
      "actor_mismatch",
    );
    const bot = await makeToken(db, root, { permissions: { ideas: "read" } });
    await expectRefusal(
      withActor(web(db), { name: bot.token.name, type: "agent", tokenId: bot.token.id }, (tx) =>
        setUserAccessRevoked(tx, { actingUserId: root.id, userId: user.id, revoked: true }),
      ),
      "not_human",
    );
    const missing = await failure(
      lockOut(db, root, { id: "00000000-0000-4000-8000-0000000000ee", username: "ghost" }),
    );
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(await getUserAccess(web(db), user.id)).toMatchObject({ accessRevokedAt: null });
  });

  it("locks out the person who is asked, an admin included, and the others are untouched", async () => {
    const user = await newAdmin(db, root);
    await lockOut(db, root, user);
    expect(await activeAdmins(db)).not.toContain(user.username);
    expect(await activeAdmins(db)).toEqual(expect.arrayContaining(["root", "dana"]));
  });
});

describe("the last admin whose access is active", () => {
  let db: TestDb;
  let root: TestUser;
  let dana: TestUser;

  beforeAll(async () => {
    db = await createTestDb();
    root = await login(db, "root");
    dana = await login(db, "dana");
    await promote(db, root, dana);
  });
  afterAll(async () => {
    await db.drop();
  });

  it("cannot be locked out, demoted or counted twice: admins whose access is revoked do not count", async () => {
    await lockOut(db, root, dana);
    expect(await activeAdmins(db)).toEqual(["root"]);

    // root is the last ACTIVE admin although dana is still an admin in the table.
    const locked = await expectRefusal(lockOut(db, root, root), "last_admin");
    expect(locked.message).toContain("last admin");
    const demoted = await expectRefusal(
      asPerson(db, root, (tx) =>
        setUserAdmin(tx, { actingUserId: root.id, userId: root.id, isAdmin: false }),
      ),
      "last_admin",
    );
    expect(demoted.message).toBe(
      '"root" is the last admin and cannot be demoted: promote another user to admin first (admins whose access is revoked do not count)',
    );
    expect(await activeAdmins(db)).toEqual(["root"]);

    // Demoting the revoked admin changes nobody's ability to administer, so it is allowed.
    expect(
      await asPerson(db, root, (tx) =>
        setUserAdmin(tx, { actingUserId: root.id, userId: dana.id, isAdmin: false }),
      ),
    ).toMatchObject({ changed: true, isAdmin: false });
    expect(await activeAdmins(db)).toEqual(["root"]);

    // Once there is a second active admin, root can step down again.
    await promote(db, root, dana);
    await lockOut(db, root, dana, false);
    expect(await activeAdmins(db)).toEqual(["dana", "root"]);
    expect(
      await asPerson(db, dana, (tx) =>
        setUserAdmin(tx, { actingUserId: dana.id, userId: root.id, isAdmin: false }),
      ),
    ).toMatchObject({ changed: true });
    expect(await activeAdmins(db)).toEqual(["dana"]);
  });

  it("is outranked by the identity provider: a person outside the access group loses their access even as the last admin, and signing in again brings them back", async () => {
    const admins = await activeAdmins(db);
    expect(admins).toHaveLength(1);
    const [name] = admins;
    const last: TestUser = { id: (await login(db, name ?? "")).id, username: name ?? "" };

    const since = await mark(db);
    expect(await markOutside(db, last)).toMatchObject({ changed: true });
    expect(await activeAdmins(db)).toEqual([]);
    const event = (await eventsSince(db, since)).find(
      (candidate) => candidate.action === "user.access_revoked",
    );
    expect(event?.payload).toMatchObject({ via: "identity_provider", no_active_admin: true });
    expect(await getUserAccess(web(db), last.id)).toMatchObject({
      isAdmin: false,
      levels: NO_ACCESS,
    });

    const back = await login(db, last.username);
    expect(back).toMatchObject({ isAdmin: true, levels: MAX_LEVELS, accessRevokedAt: null });
    expect(await activeAdmins(db)).toEqual([name]);
  });
});

describe("revocations racing", () => {
  it("two admins locking each other out at the same moment leave one admin whose access is active", async () => {
    const db = await createTestDb();
    try {
      const root = await login(db, "root");
      const dana = await login(db, "dana");
      await promote(db, root, dana);

      const outcomes = await Promise.allSettled([lockOut(db, root, dana), lockOut(db, dana, root)]);
      const refused = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.reason).toBeInstanceOf(ForbiddenError);
      expect(await activeAdmins(db)).toHaveLength(1);
    } finally {
      await db.drop();
    }
  });

  it("a session being created while the person is revoked is ended with the rest: none survives", async () => {
    const db = await createTestDb();
    try {
      const root = await login(db, "root");
      const user = await newPerson(db, root, WRITER);
      // The session insert is open (uncommitted); the revocation must wait for it and then end that
      // session too.
      const client = await web(db).connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT * FROM create_web_session($1, NULL, NULL, 3600, 86400)", [
          user.id,
        ]);
        const revocation = markOutside(db, user);
        expect(await waitUntilQueued(db, "mark_user_outside_access_group")).toBe(true);
        await client.query("COMMIT");
        expect(await revocation).toMatchObject({ changed: true, sessionsEnded: 1 });
      } finally {
        client.release(true);
      }
      expect(await sessionCount(db, user.id)).toBe(0);
    } finally {
      await db.drop();
    }
  });

  it("a session cannot start while a revocation is in flight: it waits for it and is refused, so none survives", async () => {
    const db = await createTestDb();
    try {
      const root = await login(db, "root");
      const user = await newPerson(db, root, WRITER);
      // The revocation is open (uncommitted). A session that checked "not revoked" before it and
      // inserted after it would outlive the deletion of the person's sessions.
      const client = await web(db).connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT * FROM mark_user_outside_access_group($1, 'human', NULL, $2, $3)",
          [user.username, ISSUER, `sub-${user.username}`],
        );
        const creation = openSessions(db, user, 1);
        expect(await waitUntilQueued(db, "create_web_session")).toBe(true);
        await client.query("COMMIT");
        await expectRefusal(creation, "access_revoked");
      } finally {
        client.release(true);
      }
      expect(await sessionCount(db, user.id)).toBe(0);
      // Once revoked, no session can start; once restored, one can.
      await expectRefusal(openSessions(db, user, 1), "access_revoked");
      await login(db, user.username);
      expect(await openSessions(db, user, 1)).toHaveLength(1);
    } finally {
      await db.drop();
    }
  });
});
