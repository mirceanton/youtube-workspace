// Sign-in, access levels and API tokens: the first user is admin, a token never exceeds its owner.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, type ValidationError } from "../src/errors.js";
import { getUserAccess, setUserAdmin } from "../src/identity.js";
import { listUserAccess, setUserAccessRevoked, setUserPermission } from "../src/permissions.js";
import { createWebSession } from "../src/sessions.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import {
  createApiToken,
  lookupTokenByHash,
  revokeApiToken,
  rotateApiToken,
  touchTokenLastUsed,
  type ApiTokenInfo,
} from "../src/tokens.js";
import { actAs, alice, failure, newSecret, signIn } from "./helpers.js";

let db: TestDb;
let admin: Awaited<ReturnType<typeof signIn>>;
let bob: Awaited<ReturnType<typeof signIn>>;
const bobActor = { name: "bob", type: "human" } as const;

beforeAll(async () => {
  db = await createTestDb();
  admin = await signIn(db, "alice");
  bob = await signIn(db, "bob");
});

afterAll(async () => {
  await db.drop();
});

const setLevel = (
  resource: "ideas" | "activity",
  level: "none" | "read" | "write",
  actor = alice,
) =>
  actAs(db, actor, (tx) =>
    setUserPermission(tx, {
      actingUserId: actor === alice ? admin.id : bob.id,
      userId: bob.id,
      resource,
      level,
    }),
  );
const lock = (revoked: boolean) =>
  actAs(db, alice, (tx) =>
    setUserAccessRevoked(tx, { actingUserId: admin.id, userId: bob.id, revoked }),
  );

const createToken = (permissions: Parameters<typeof createApiToken>[1]["permissions"]) => {
  const secret = newSecret();
  return actAs(db, bobActor, (tx) =>
    createApiToken(tx, {
      ownerUserId: bob.id,
      name: "ci",
      tokenPrefix: secret.prefix,
      tokenHash: secret.hash,
      expiresAt: null,
      permissions,
    }),
  ).then((token) => ({ token, hash: secret.hash }));
};

describe("sign-in and access levels", () => {
  it("makes the first user an admin with every level and later users start with none", async () => {
    expect(admin).toMatchObject({ created: true, isAdmin: true });
    expect(admin.levels).toEqual({
      ideas: "write",
      scripts: "write",
      experiments: "write",
      videos: "write",
      notes: "write",
      activity: "read",
    });
    expect(bob.isAdmin).toBe(false);
    expect(Object.values(bob.levels)).toEqual(Array(6).fill("none"));
  });

  it("lets only an admin change levels, never write on the activity log, never the last admin", async () => {
    expect(await failure(setLevel("ideas", "read", bobActor))).toBeInstanceOf(ForbiddenError);
    const activityWrite = await failure(setLevel("activity", "write"));
    expect((activityWrite as ValidationError).field).toBe("level");
    await setLevel("ideas", "read");
    expect((await getUserAccess(db.pool, bob.id))?.levels.ideas).toBe("read");
    const users = await listUserAccess(db.pool, admin.id);
    expect(users.map((user) => user.username)).toEqual(["alice", "bob"]);

    const demote = await failure(
      actAs(db, alice, (tx) =>
        setUserAdmin(tx, { actingUserId: admin.id, userId: admin.id, isAdmin: false }),
      ),
    );
    expect(demote).toBeInstanceOf(ForbiddenError);
    expect(demote.message).toContain("last admin");
  });
});

describe("API tokens", () => {
  let info: ApiTokenInfo;
  let hash: string;

  it("never exceed their owner and are looked up by the hash of the secret", async () => {
    const tooMuch = await failure(createToken({ ideas: "write" }));
    expect(tooMuch).toBeInstanceOf(ForbiddenError);
    expect(tooMuch.message).toContain("choose one of: none, read");

    ({ token: info, hash } = await createToken({ ideas: "read" }));
    expect(info).toMatchObject({ status: "active", levels: { ideas: "read", scripts: "none" } });
    expect(await lookupTokenByHash(db.pool, hash)).toMatchObject({
      status: "active",
      effectiveLevels: { ideas: "read" },
    });
    expect(await lookupTokenByHash(db.pool, newSecret().hash)).toEqual({ status: "unknown" });
    expect(await touchTokenLastUsed(db.pool, info)).toBe(true);

    const { rows } = await db.pool.query("SELECT row_to_json(e)::text AS text FROM events e");
    expect(rows.some((row) => row.text.includes(hash) || row.text.includes(info.prefix))).toBe(
      false,
    );
  });

  it("follow their owner's level at once, and die with the owner's access", async () => {
    await setLevel("ideas", "none");
    expect(await lookupTokenByHash(db.pool, hash)).toMatchObject({
      status: "active",
      levels: { ideas: "read" },
      effectiveLevels: { ideas: "none" },
    });

    await setLevel("ideas", "read");
    const timeouts = { idleTimeoutSeconds: 3600, absoluteTimeoutSeconds: 7200 };
    await createWebSession(db.pool, { userId: bob.id, ...timeouts });
    expect(await lock(true)).toMatchObject({ changed: true, sessionsEnded: 1 });
    expect(await lookupTokenByHash(db.pool, hash)).toMatchObject({
      status: "owner_revoked",
      effectiveLevels: { ideas: "none" },
    });
    await lock(false);
    expect(await lookupTokenByHash(db.pool, hash)).toMatchObject({ status: "active" });
  });

  it("can be rotated and revoked, and then stop working", async () => {
    const next = newSecret();
    const rotate = { actingUserId: bob.id, apiTokenId: info.id };
    await actAs(db, bobActor, (tx) =>
      rotateApiToken(tx, { ...rotate, newTokenPrefix: next.prefix, newTokenHash: next.hash }),
    );
    expect(await lookupTokenByHash(db.pool, hash)).toEqual({ status: "unknown" });
    await actAs(db, bobActor, (tx) => revokeApiToken(tx, rotate));
    expect(await lookupTokenByHash(db.pool, next.hash)).toMatchObject({
      status: "revoked",
      effectiveLevels: { ideas: "none" },
    });
  });
});
