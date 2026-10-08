import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuplicateError, ForbiddenError, NotFoundError, ValidationError } from "../src/errors.js";
import { getUserAccess, setUserAdmin, upsertUserOnLogin } from "../src/identity.js";
import { createIdea } from "../src/ideas.js";
import { listUserAccess } from "../src/permissions.js";
import { seedApiToken, type SeedApiTokenInput } from "../src/seed.js";
import { createWebSession } from "../src/sessions.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { createApiToken, lookupTokenByHash } from "../src/tokens.js";
import { actAs, alice, failure, newSecret, signIn } from "./helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

const first = newSecret();
const second = newSecret();
const input = (secret: typeof first, rest: Partial<SeedApiTokenInput> = {}): SeedApiTokenInput => ({
  name: "bootstrap",
  tokenPrefix: secret.prefix,
  tokenHash: secret.hash,
  permissions: { ideas: "write", activity: "read" },
  ...rest,
});
const seed = (secret: typeof first, rest?: Partial<SeedApiTokenInput>, pool = db.pool) =>
  seedApiToken(pool, input(secret, rest));
const lookup = (hash: string) => lookupTokenByHash(db.pool, hash);

describe("the seeded token", () => {
  it("is created, left alone, updated, replaced and revoked as the configuration changes", async () => {
    expect(await seedApiToken(db.pool, null)).toEqual({ action: "none", tokenId: null });

    const created = await seed(first);
    expect(created.action).toBe("created");
    expect(await lookup(first.hash)).toMatchObject({
      status: "active",
      id: created.tokenId,
      name: "bootstrap",
      expiresAt: null,
      owner: { username: "system", isAdmin: false },
      effectiveLevels: { ideas: "write", scripts: "none", activity: "read" },
    });

    const events = () => db.pool.query("SELECT count(*)::int AS n FROM events");
    const before = await events();
    expect(await seed(first)).toEqual({ action: "unchanged", tokenId: created.tokenId });
    expect(await events()).toEqual(before);

    const renamed = { name: "gateway", permissions: { ideas: "read" } } as const;
    expect(await seed(first, renamed)).toEqual({ action: "updated", tokenId: created.tokenId });
    expect(await lookup(first.hash)).toMatchObject({
      name: "gateway",
      effectiveLevels: { ideas: "read", activity: "none" },
    });

    const replaced = await seed(second);
    expect(replaced.action).toBe("created");
    expect(replaced.tokenId).not.toBe(created.tokenId);
    expect(await lookup(first.hash)).toMatchObject({ status: "revoked" });
    expect(await lookup(second.hash)).toMatchObject({ status: "active" });

    const revoked = { action: "revoked", tokenId: replaced.tokenId };
    expect(await seedApiToken(db.pool, null)).toEqual(revoked);
    expect(await seedApiToken(db.pool, null)).toEqual({ action: "none", tokenId: null });
    expect(await lookup(second.hash)).toMatchObject({ status: "revoked" });

    expect(await seed(second)).toEqual({ action: "created", tokenId: replaced.tokenId });
    expect(await lookup(second.hash)).toMatchObject({ status: "active" });
  });

  it("acts under its own name in the audit log and never leaks its secret", async () => {
    const { rows } = await db.pool.query(
      `SELECT actor, actor_type FROM events
        WHERE action = 'token.created' AND payload ->> 'seeded' = 'true'`,
    );
    expect(rows[0]).toEqual({ actor: "bootstrap", actor_type: "agent" });
    const all = await db.pool.query("SELECT row_to_json(e)::text AS text FROM events e");
    expect(all.rows.some((r) => [first, second].some((s) => r.text.includes(s.hash)))).toBe(false);
  });

  it("acts like any other token: its calls are attributed to it", async () => {
    const token = await lookup(second.hash);
    if (token.status !== "active") {
      throw new Error("expected the seeded token to be active");
    }
    const agent = { name: token.name, type: "agent", tokenId: token.id } as const;
    const idea = await actAs(db, agent, (tx) => createIdea(tx, { title: "From the gateway" }));
    expect(idea.createdBy).toBe("bootstrap");
    const { rows } = await db.pool.query("SELECT token_id FROM events WHERE entity_id = $1", [
      idea.id,
    ]);
    expect(rows).toEqual([{ token_id: token.id }]);
  });

  it("rejects what the token functions reject", async () => {
    const activityWrite = await failure(seed(first, { permissions: { activity: "write" } }));
    expect(activityWrite).toBeInstanceOf(ValidationError);
    expect(await failure(seed(first, { tokenHash: "nope" }))).toBeInstanceOf(ValidationError);
  });
});

describe("the system user", () => {
  it("does not count as the first user, so the first real person is still admin", async () => {
    expect(await signIn(db, "alice")).toMatchObject({ created: true, isAdmin: true });
  });

  it("is hidden, cannot sign in, has no session and cannot be managed", async () => {
    const owner = await signIn(db, "alice");
    const { rows } = await db.pool.query("SELECT id, is_admin FROM users WHERE is_system");
    expect(rows).toHaveLength(1);
    expect(rows[0].is_admin).toBe(false);
    const systemId: string = rows[0].id;

    const users = await listUserAccess(db.pool, owner.id);
    expect(users.map((user) => user.username)).toEqual(["alice"]);
    expect(await getUserAccess(db.pool, systemId)).toBeNull();

    const system = { name: "system", type: "human" } as const;
    const login = { issuer: "urn:ytw:system", sub: "system", username: "system" };
    expect(await failure(actAs(db, system, (tx) => upsertUserOnLogin(tx, login)))).toBeInstanceOf(
      ForbiddenError,
    );
    const timeouts = { idleTimeoutSeconds: 60, absoluteTimeoutSeconds: 60 };
    const session = createWebSession(db.pool, { userId: systemId, ...timeouts });
    expect(await failure(session)).toBeInstanceOf(ForbiddenError);
    const promote = actAs(db, alice, (tx) =>
      setUserAdmin(tx, { actingUserId: owner.id, userId: systemId, isAdmin: true }),
    );
    expect(await failure(promote)).toBeInstanceOf(NotFoundError);
  });
});

describe("tokens made in the web app", () => {
  it("are never touched by the seeding", async () => {
    const owner = await signIn(db, "alice");
    const own = newSecret();
    const ui = await actAs(db, alice, (tx) =>
      createApiToken(tx, {
        ownerUserId: owner.id,
        name: "mine",
        tokenPrefix: own.prefix,
        tokenHash: own.hash,
        expiresAt: null,
        permissions: { ideas: "read" },
      }),
    );
    await seedApiToken(db.pool, null);
    await seed(first);
    expect(await lookup(own.hash)).toMatchObject({ status: "active", id: ui.id });
    expect(await failure(seed(own))).toBeInstanceOf(DuplicateError);
    expect(await lookup(first.hash)).toMatchObject({ status: "active" });
  });
});

describe("replicas booting together", () => {
  it("end up with one active seeded token", async () => {
    const fresh = await createTestDb();
    try {
      const secrets = [first, first, first, second, first];
      const results = await Promise.all(secrets.map((secret) => seed(secret, {}, fresh.pool)));
      expect(results.some((result) => result.action === "created")).toBe(true);
      const { rows } = await fresh.pool.query(
        "SELECT count(*)::int AS n FROM ytw_private.api_tokens WHERE seeded AND revoked_at IS NULL",
      );
      expect(rows[0]).toEqual({ n: 1 });
    } finally {
      await fresh.drop();
    }
  });
});
