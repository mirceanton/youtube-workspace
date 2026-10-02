// API tokens (migration 0053, T14): create with the owner ceiling enforced in the database, look up
// by hash with revoked/expired/unknown told apart, update, rotate, revoke, touch and the settings
// lists. PRD 7: a token never exceeds its owner, lowering the owner lowers the token at once,
// revocation and rotation take effect immediately, the secret is never stored or logged.
import {
  GRANTABLE_LEVELS,
  LEVELS,
  RESOURCES,
  type Level,
  type Resource,
} from "@ytw/shared/constants";
import {
  grantViolations,
  principalLevels,
  type GrantOwner,
  type TokenPrincipal,
} from "@ytw/policy";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, withActor, type Actor } from "../src/client.js";
import {
  DuplicateError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
} from "../src/errors.js";
import { getUserAccess, setUserAdmin } from "../src/identity.js";
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
const NO_ACCESS = everywhere("none");

/** The PRD 7 example users. */
const COLLABORATOR: Record<Resource, Level> = {
  ideas: "write",
  scripts: "write",
  experiments: "write",
  videos: "read",
  notes: "write",
  activity: "read",
};
const READER: Record<Resource, Level> = { ...everywhere("read"), activity: "none" };

let db: TestDb;
let root: TestUser;
let collaborator: TestUser;
let reader: TestUser;
let minimal: TestUser;
let nobody: TestUser;

const web = () => db.pool("ytw_web");

beforeAll(async () => {
  db = await createTestDb();
  root = await login(db, "root");
  collaborator = await login(db, "collaborator");
  reader = await login(db, "reader");
  minimal = await login(db, "minimal");
  nobody = await login(db, "nobody");
  await grant(db, root, collaborator, COLLABORATOR);
  await grant(db, root, reader, READER);
  await grant(db, root, minimal, { ideas: "read" });
});

afterAll(async () => {
  await db.drop();
});

async function owner(user: TestUser): Promise<GrantOwner> {
  const access = await getUserAccess(web(), user.id);
  if (access === null) {
    throw new Error(`user ${user.username} not found`);
  }
  return { isAdmin: access.isAdmin, levels: access.levels };
}

async function tokenCount(userId: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM ytw_private.api_tokens WHERE user_id = $1",
    [userId],
  );
  return rows[0]?.n ?? -1;
}

/** Runs `fn` as `user` in a transaction on the web role. */
function asUser<T>(user: TestUser, fn: Parameters<typeof withActor<T>>[2]): Promise<T> {
  return withActor(web(), person(user.username), fn);
}

function create(
  user: TestUser,
  permissions: Partial<Record<Resource, Level>>,
  overrides: { name?: string; prefix?: string; hash?: string; expiresAt?: Date | null } = {},
  actor: Actor = person(user.username),
) {
  const made = newSecret();
  return withActor(web(), actor, (tx) =>
    createApiToken(tx, {
      ownerUserId: user.id,
      name: overrides.name ?? `tok-${unique()}`,
      tokenPrefix: overrides.prefix ?? made.prefix,
      tokenHash: overrides.hash ?? made.hash,
      expiresAt: overrides.expiresAt === undefined ? null : overrides.expiresAt,
      permissions,
    }),
  );
}

async function lookup(hash: string): Promise<FoundToken> {
  const found = await lookupTokenByHash(db.pool("ytw_mcp"), hash);
  if (found.status === "unknown") {
    throw new Error("token unexpectedly unknown");
  }
  return found;
}

async function expireToken(tokenId: string, when = "now() - interval '1 minute'"): Promise<void> {
  await withActor(db.admin, person("fixer"), (tx) =>
    tx.query(`UPDATE ytw_private.api_tokens SET expires_at = ${when} WHERE id = $1`, [tokenId]),
  );
}

describe("create_api_token", () => {
  it("stores only the hash and the prefix, returns the token without its hash, and audits the creation", async () => {
    const before = await mark(db);
    const expiresAt = new Date(Date.now() + 90 * 86_400_000);
    const made = await makeToken(db, collaborator, {
      name: "editor bot",
      permissions: { scripts: "write", ideas: "read" },
      expiresAt,
    });

    expect(made.token).toMatchObject({
      ownerId: collaborator.id,
      name: "editor bot",
      prefix: made.prefix,
      status: "active",
      revokedAt: null,
      lastUsedAt: null,
      levels: { ...NO_ACCESS, scripts: "write", ideas: "read" },
      effectiveLevels: { ...NO_ACCESS, scripts: "write", ideas: "read" },
    });
    expect(made.token.expiresAt?.getTime()).toBe(expiresAt.getTime());
    expect(JSON.stringify(made.token)).not.toContain(made.hash);

    const { rows } = await db.admin.query<{ token_hash: string; token_prefix: string }>(
      "SELECT token_hash, token_prefix FROM ytw_private.api_tokens WHERE id = $1",
      [made.token.id],
    );
    expect(rows).toEqual([{ token_hash: made.hash, token_prefix: made.prefix }]);
    const permissionRows = await db.admin.query(
      "SELECT resource, level FROM ytw_private.api_token_permissions WHERE token_id = $1",
      [made.token.id],
    );
    expect(permissionRows.rowCount).toBe(RESOURCES.length);

    // Audit: the token insert, one insert per permission row, and the readable token.created event.
    const events = await eventsSince(db, before);
    expect(events.map((event) => `${event.entity_type}:${event.action}`).toSorted()).toEqual(
      [
        "api_token:insert",
        "api_token:token.created",
        ...RESOURCES.map(() => "api_token_permission:insert"),
      ].toSorted(),
    );
    for (const event of events) {
      expect(event).toMatchObject({
        actor: "collaborator",
        actor_type: "human",
        token_id: null,
      });
    }
    const created = events.find((event) => event.action === "token.created");
    expect(created).toMatchObject({
      entity_id: made.token.id,
      payload: {
        token_name: "editor bot",
        owner: "collaborator",
        levels: { ...NO_ACCESS, scripts: "write", ideas: "read" },
      },
    });
    expect(
      events.find((event) => event.entity_type === "api_token" && event.action === "insert"),
    ).toMatchObject({ entity_id: made.token.id });
    // Neither the secret, its hash nor its prefix ever reaches the log.
    const log = JSON.stringify(events);
    for (const secret of [made.secret, made.hash, made.prefix]) {
      expect(log).not.toContain(secret);
    }
  });

  it("gives objects left out the level none, also for an empty permission map", async () => {
    const made = await makeToken(db, collaborator, { permissions: {} });
    expect(made.token.levels).toEqual(NO_ACCESS);
    expect(made.token.effectiveLevels).toEqual(NO_ACCESS);
  });

  it("accepts a token that never expires and one that expires in the future", async () => {
    expect((await makeToken(db, reader, { expiresAt: null })).token.expiresAt).toBeNull();
    const soon = new Date(Date.now() + 60_000);
    expect((await makeToken(db, reader, { expiresAt: soon })).token.status).toBe("active");
  });

  describe("validation", () => {
    const names: [string, string][] = [
      ["an empty name", ""],
      ["a blank name", "   "],
      ["a name over 100 characters", "n".repeat(101)],
      ["a name with a newline", "bad\nname"],
    ];
    it.each(names)("refuses %s", async (_label, name) => {
      const err = await failure(create(collaborator, {}, { name }));
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe("name");
      expect(err.message).toMatch(/^name is required: 1-100 characters/);
    });

    it("accepts a name of exactly 100 characters, trimmed", async () => {
      const made = await create(collaborator, {}, { name: `  ${"n".repeat(100)}  ` });
      expect(made.name).toBe("n".repeat(100));
    });

    const badPrefixes: [string, string][] = [
      ["no ytw_ start", "abcdefgh"],
      ["upper-case YTW_", "YTW_abcd"],
      ["too long (12 characters after ytw_)", "ytw_abcdefghijkl"],
      ["a space", "ytw_ab cd"],
      ["a symbol", "ytw_ab!cd"],
      ["empty", ""],
    ];
    it.each(badPrefixes)("refuses a prefix with %s", async (_label, prefix) => {
      const err = await failure(create(collaborator, {}, { prefix }));
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe("token_prefix");
      expect(err.message).toMatch(/^token_prefix must be "ytw_" followed by at most 11 letters/);
    });

    it("accepts the shortest and the longest prefix", async () => {
      expect((await create(collaborator, {}, { prefix: "ytw_" })).prefix).toBe("ytw_");
      expect((await create(collaborator, {}, { prefix: "ytw_abcdefghijk" })).prefix).toBe(
        "ytw_abcdefghijk",
      );
      expect((await create(collaborator, {}, { prefix: "ytw_A-b_9Zz0-_a" })).prefix).toBe(
        "ytw_A-b_9Zz0-_a",
      );
    });

    it("refuses a hash that is not 64 lower-case hex digits, without echoing it", async () => {
      const secret = newSecret();
      const candidates = [
        secret.secret, // the secret itself passed by mistake
        secret.hash.toUpperCase(),
        secret.hash.slice(1),
        `${secret.hash}0`,
        "",
        `${secret.hash.slice(0, 63)}g`,
      ];
      for (const hash of candidates) {
        const err = await failure(create(collaborator, {}, { hash }));
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).field).toBe("token_hash");
        expect(err.message).toMatch(
          /^token_hash must be the SHA-256 of the token as 64 lower-case/,
        );
        expect(JSON.stringify((err as ValidationError).details)).not.toContain(secret.secret);
        if (hash !== "") {
          expect(err.message).not.toContain(hash);
        }
      }
    });

    it("refuses a hash that already belongs to a token, without echoing it", async () => {
      const first = newSecret();
      await create(collaborator, {}, { hash: first.hash });
      const err = await failure(create(collaborator, {}, { hash: first.hash }));
      expect(err).toBeInstanceOf(DuplicateError);
      expect(err.message).toBe("a token with this hash already exists: generate a new secret");
      expect(err.message).not.toContain(first.hash);
    });

    it("refuses an expiry that is not in the future", async () => {
      for (const expiresAt of [new Date(Date.now() - 1000), new Date(0)]) {
        const err = await failure(create(collaborator, {}, { expiresAt }));
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).field).toBe("expires_at");
      }
    });

    it("refuses a permission map that is not a JSON object", async () => {
      for (const value of ["[]", '"ideas"', "null", "5"]) {
        const made = newSecret();
        const err = await failure(
          asUser(collaborator, (tx) =>
            tx.query(
              sql`SELECT * FROM create_api_token(${tx.actor.name}, ${tx.actor.type}, ${tx.actor.tokenId},
                                                 ${collaborator.id}, 'bad map', ${made.prefix},
                                                 ${made.hash}, NULL, ${value}::jsonb)`,
            ),
          ),
        );
        expect(err).toBeInstanceOf(ValidationError);
        expect(err.message).toMatch(/^permissions must be a JSON object such as/);
      }
      // A missing map (SQL NULL) is refused the same way.
      const made = newSecret();
      const err = await failure(
        asUser(collaborator, (tx) =>
          tx.query(
            sql`SELECT * FROM create_api_token(${tx.actor.name}, ${tx.actor.type}, ${tx.actor.tokenId},
                                               ${collaborator.id}, 'no map', ${made.prefix},
                                               ${made.hash}, NULL, NULL)`,
          ),
        ),
      );
      expect(err).toBeInstanceOf(ValidationError);
    });

    it("reports an unknown object and an unknown level with the valid values", async () => {
      const err = await failure(
        create(collaborator, { sponsors: "read", ideas: "admin" } as unknown as Record<
          Resource,
          Level
        >),
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toBe(
        `token permissions rejected: "admin" is not an access level for ideas; choose one of: none, read, write; "sponsors" is not an object with access levels; valid objects: ${RESOURCES.join(", ")}`,
      );
    });
  });

  describe("the ceiling: a token never exceeds its owner (checked in the database)", () => {
    const owners: [string, () => TestUser][] = [
      ["an admin", () => root],
      ["the PRD collaborator", () => collaborator],
      ["the PRD reader", () => reader],
      ["a user with Read on ideas only", () => minimal],
    ];
    const requests: unknown[] = [...LEVELS, "admin", 5];

    for (const [label, who] of owners) {
      it(`${label}: every (object, level) request is accepted exactly when @ytw/policy accepts it`, async () => {
        const user = who();
        const ceilingOwner = await owner(user);
        for (const resource of RESOURCES) {
          for (const requested of requests) {
            const violations = grantViolations(ceilingOwner, {
              [resource]: requested,
            } as Partial<Record<Resource, Level>>);
            const before = await tokenCount(user.id);
            const attempt = create(user, { [resource]: requested } as Partial<
              Record<Resource, Level>
            >);
            if (violations.length === 0) {
              const made = await attempt;
              expect(made.levels[resource]).toBe(requested);
              expect(await tokenCount(user.id)).toBe(before + 1);
              continue;
            }
            const err = await failure(attempt);
            const reasons = new Set(violations.map((violation) => violation.reason));
            expect(err).toBeInstanceOf(
              reasons.has("exceeds_owner") && reasons.size === 1 ? ForbiddenError : ValidationError,
            );
            // The database words every problem exactly like the policy layer.
            for (const violation of violations) {
              expect(err.message).toContain(violation.message);
            }
            expect(await tokenCount(user.id)).toBe(before);
          }
        }
      });
    }

    it("lists every problem at once and the values that would have been accepted", async () => {
      const err = await failure(
        create(reader, { ideas: "write", scripts: "write", notes: "write", videos: "read" }),
      );
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(err.message).toBe(
        `token permissions rejected for "reader": ` +
          `write on ideas is above the owner's own level (read); a token never exceeds its owner; choose one of: none, read; ` +
          `write on notes is above the owner's own level (read); a token never exceeds its owner; choose one of: none, read; ` +
          `write on scripts is above the owner's own level (read); a token never exceeds its owner; choose one of: none, read`,
      );
      expect((err as ForbiddenError).details).toMatchObject({ reason: "exceeds_owner" });
      const violations = (err as ForbiddenError).details.violations as {
        resource: string;
        requested: string;
        owner_level: string;
        allowed: string[];
      }[];
      expect(violations.map((violation) => violation.resource)).toEqual([
        "ideas",
        "notes",
        "scripts",
      ]);
      expect(violations[0]).toMatchObject({
        requested: "write",
        owner_level: "read",
        allowed: ["none", "read"],
      });
    });

    it("an owner with Write may grant Write, Read or None; an admin owner has the maximum", async () => {
      const full = await create(root, MAX_LEVELS);
      expect(full.levels).toEqual(MAX_LEVELS);
      const mixed = await create(collaborator, {
        ideas: "write",
        videos: "read",
        activity: "read",
      });
      expect(mixed.levels).toEqual({
        ...NO_ACCESS,
        ideas: "write",
        videos: "read",
        activity: "read",
      });
      // Collaborator holds Read on videos: Write on videos is above the ceiling.
      const err = await failure(create(collaborator, { videos: "write" }));
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(err.message).toContain("choose one of: none, read");
    });

    it("an owner with no access to any object cannot create tokens, with an empty map either", async () => {
      for (const permissions of [{}, { ideas: "none" as const }]) {
        const err = await failure(create(nobody, permissions));
        expect(err).toBeInstanceOf(ForbiddenError);
        expect(err.message).toBe(
          '"nobody" has no access to any object, so cannot create API tokens: an admin must grant Read or Write on at least one object first',
        );
      }
      // One Read level is enough.
      await grant(db, root, nobody, { notes: "read" });
      const made = await create(nobody, { notes: "read" });
      expect(made.levels.notes).toBe("read");
      await grant(db, root, nobody, { notes: "none" });
    });
  });

  describe("who may create", () => {
    it("an API token never creates tokens, not even with its owner's id and name", async () => {
      const bot = await makeToken(db, collaborator, { permissions: { ideas: "read" } });
      const agent: Actor = { name: bot.token.name, type: "agent", tokenId: bot.token.id };
      const err = await failure(create(collaborator, { ideas: "read" }, {}, agent));
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(err.message).toMatch(
        /^only a signed-in person can create API tokens: API tokens never manage/,
      );
      const named: Actor = { name: "collaborator", type: "agent", tokenId: bot.token.id };
      expect(await failure(create(collaborator, { ideas: "read" }, {}, named))).toBeInstanceOf(
        ForbiddenError,
      );
    });

    it("tokens are created for one's own account only: not by another user, not even an admin", async () => {
      const before = await tokenCount(reader.id);
      const err = await failure(create(reader, { ideas: "read" }, {}, person("root")));
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(err.message).toBe(
        'the audit actor "root" is not the acting user "reader": pass the signed-in user\'s username as the actor',
      );
      expect(await tokenCount(reader.id)).toBe(before);
    });

    it("refuses an owner who does not exist", async () => {
      const ghost = { id: "00000000-0000-4000-8000-000000000010", username: "ghost" };
      const err = await failure(create(ghost, {}));
      expect(err).toBeInstanceOf(NotFoundError);
    });
  });
});

describe("lookup_token_by_hash", () => {
  it("reports an unknown token as unknown", async () => {
    expect(await lookupTokenByHash(db.pool("ytw_mcp"), newSecret().hash)).toEqual({
      status: "unknown",
    });
  });

  it("refuses anything that is not a SHA-256 hex digest, without echoing it", async () => {
    const secret = newSecret();
    for (const value of [secret.secret, secret.hash.toUpperCase(), "", "abc"]) {
      const err = await failure(lookupTokenByHash(db.pool("ytw_mcp"), value));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toMatch(/^token_hash must be the SHA-256 of the token as 64 lower-case/);
      expect(err.message).not.toContain(secret.secret);
    }
  });

  it("returns the token, its own levels, the owner's levels, the admin flag and the effective minimum", async () => {
    const made = await makeToken(db, collaborator, {
      name: "lookup bot",
      permissions: { ideas: "write", scripts: "read", videos: "read" },
    });
    const found = await lookup(made.hash);
    expect(found).toMatchObject({
      status: "active",
      id: made.token.id,
      name: "lookup bot",
      prefix: made.prefix,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      owner: {
        id: collaborator.id,
        username: "collaborator",
        isAdmin: false,
        levels: COLLABORATOR,
      },
      levels: { ...NO_ACCESS, ideas: "write", scripts: "read", videos: "read" },
      effectiveLevels: { ...NO_ACCESS, ideas: "write", scripts: "read", videos: "read" },
    });
    expect(found.createdAt).toBeInstanceOf(Date);
    expect(JSON.stringify(found)).not.toContain(made.hash);

    const admin = await makeToken(db, root, { permissions: { ideas: "write", activity: "read" } });
    const adminFound = await lookup(admin.hash);
    expect(adminFound.owner).toMatchObject({ username: "root", isAdmin: true, levels: MAX_LEVELS });
    expect(adminFound.effectiveLevels).toEqual({ ...NO_ACCESS, ideas: "write", activity: "read" });
  });

  it("an owner with fewer levels than the token holds limits it: the effective level is the minimum", async () => {
    const lena = await login(db, `lena-${unique()}`);
    await grant(db, root, lena, { ideas: "write", scripts: "write" });
    const made = await makeToken(db, lena, { permissions: { ideas: "write", scripts: "write" } });
    await grant(db, root, lena, { ideas: "read", scripts: "none" });
    const found = await lookup(made.hash);
    expect(found.levels).toMatchObject({ ideas: "write", scripts: "write" });
    expect(found.effectiveLevels).toMatchObject({ ideas: "read", scripts: "none" });
  });

  it("lowering the owner's levels lowers the lookup at once; raising them again restores the token", async () => {
    const mo = await login(db, `mo-${unique()}`);
    await grant(db, root, mo, { scripts: "write", notes: "write" });
    const made = await makeToken(db, mo, { permissions: { scripts: "write", notes: "read" } });
    expect((await lookup(made.hash)).effectiveLevels).toMatchObject({
      scripts: "write",
      notes: "read",
    });

    await grant(db, root, mo, { scripts: "read" });
    expect((await lookup(made.hash)).effectiveLevels.scripts).toBe("read");
    await grant(db, root, mo, { scripts: "none", notes: "none" });
    const lowered = await lookup(made.hash);
    expect(lowered.effectiveLevels).toEqual(NO_ACCESS);
    expect(lowered.owner.levels).toEqual({ ...NO_ACCESS });
    // The token's own levels were never touched.
    expect(lowered.levels).toMatchObject({ scripts: "write", notes: "read" });

    await grant(db, root, mo, { scripts: "write", notes: "write" });
    expect((await lookup(made.hash)).effectiveLevels).toMatchObject({
      scripts: "write",
      notes: "read",
    });
  });

  it("demoting an admin owner lowers the tokens too (levels reset), or not with keepLevels", async () => {
    const nia = await login(db, `nia-${unique()}`);
    await promote(db, root, nia);
    const made = await makeToken(db, nia, { permissions: MAX_LEVELS });
    expect((await lookup(made.hash)).effectiveLevels).toEqual(MAX_LEVELS);
    expect((await lookup(made.hash)).owner.isAdmin).toBe(true);

    await withActor(web(), person("root"), (tx) =>
      setUserAdmin(tx, { actingUserId: root.id, userId: nia.id, isAdmin: false }),
    );
    const demoted = await lookup(made.hash);
    expect(demoted.owner).toMatchObject({ isAdmin: false, levels: NO_ACCESS });
    expect(demoted.effectiveLevels).toEqual(NO_ACCESS);
    expect(demoted.levels).toEqual(MAX_LEVELS);

    await promote(db, root, nia);
    expect((await lookup(made.hash)).effectiveLevels).toEqual(MAX_LEVELS);
    await withActor(web(), person("root"), (tx) =>
      setUserAdmin(tx, { actingUserId: root.id, userId: nia.id, isAdmin: false, keepLevels: true }),
    );
    const kept = await lookup(made.hash);
    expect(kept.owner).toMatchObject({ isAdmin: false, levels: MAX_LEVELS });
    expect(kept.effectiveLevels).toEqual(MAX_LEVELS);
  });

  it("tells active, revoked, expired and unknown apart, and a dead token has no effective access", async () => {
    const active = await makeToken(db, collaborator, {
      permissions: { ideas: "write" },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const revoked = await makeToken(db, collaborator, { permissions: { ideas: "write" } });
    const expired = await makeToken(db, collaborator, { permissions: { ideas: "write" } });
    const both = await makeToken(db, collaborator, { permissions: { ideas: "write" } });

    await asUser(collaborator, (tx) =>
      revokeApiToken(tx, { actingUserId: collaborator.id, apiTokenId: revoked.token.id }),
    );
    await expireToken(expired.token.id);
    await asUser(collaborator, (tx) =>
      revokeApiToken(tx, { actingUserId: collaborator.id, apiTokenId: both.token.id }),
    );
    await expireToken(both.token.id);

    const statuses = await Promise.all(
      [active, revoked, expired, both].map(async (made) => (await lookup(made.hash)).status),
    );
    expect(statuses).toEqual(["active", "revoked", "expired", "revoked"]);
    expect((await lookupTokenByHash(web(), newSecret().hash)).status).toBe("unknown");

    const revokedFound = await lookup(revoked.hash);
    expect(revokedFound.revokedAt).toBeInstanceOf(Date);
    // Everything about the dead tokens is still reported, but they can do nothing.
    for (const made of [revoked, expired, both]) {
      const found = await lookup(made.hash);
      expect(found.id).toBe(made.token.id);
      expect(found.owner.username).toBe("collaborator");
      expect(found.levels.ideas).toBe("write");
      expect(found.effectiveLevels).toEqual(NO_ACCESS);
    }
    expect((await lookup(expired.hash)).expiresAt).toBeInstanceOf(Date);
    expect((await lookup(active.hash)).effectiveLevels.ideas).toBe("write");
  });

  it("builds the @ytw/policy TokenPrincipal: its levels equal the effective minimum computed in SQL", async () => {
    const holders: [string, TestUser][] = [
      ["admin", root],
      ["collaborator", collaborator],
      ["reader", reader],
      ["minimal", minimal],
    ];
    const patterns: Partial<Record<Resource, Level>>[] = [
      {},
      { ideas: "read" },
      { ideas: "write", scripts: "read", activity: "read" },
      { ...everywhere("read") },
      { ...MAX_LEVELS },
    ];
    for (const [, holder] of holders) {
      const ceiling = await owner(holder);
      for (const pattern of patterns) {
        // Only what the owner may grant: clamp the pattern to the owner's levels.
        const grantable = Object.fromEntries(
          Object.entries(pattern).filter(
            ([resource]) =>
              grantViolations(ceiling, { [resource]: pattern[resource as Resource] } as never)
                .length === 0,
          ),
        ) as Partial<Record<Resource, Level>>;
        const made = await makeToken(db, holder, { permissions: grantable });
        const found = await lookup(made.hash);
        const principal: TokenPrincipal = toTokenPrincipal(found);
        expect(principalLevels(principal)).toEqual(found.effectiveLevels);
      }
    }
  });
});

describe("update_token_permissions", () => {
  const update = (
    user: TestUser,
    apiTokenId: string,
    permissions: Partial<Record<Resource, Level>>,
    actor: Actor = person(user.username),
  ) =>
    withActor(web(), actor, (tx) =>
      updateTokenPermissions(tx, { actingUserId: user.id, apiTokenId, permissions }),
    );

  it("lowers and raises levels within the ceiling and leaves the objects not named alone", async () => {
    const made = await makeToken(db, collaborator, {
      permissions: { ideas: "write", notes: "read" },
    });
    const before = await mark(db);
    const updated = await update(collaborator, made.token.id, { ideas: "read", scripts: "write" });
    expect(updated.levels).toEqual({
      ...NO_ACCESS,
      ideas: "read",
      notes: "read",
      scripts: "write",
    });
    expect(updated.effectiveLevels).toEqual(updated.levels);
    expect((await lookup(made.hash)).levels).toEqual(updated.levels);

    const events = await eventsSince(db, before);
    expect(events.map((event) => `${event.entity_type}:${event.action}`).toSorted()).toEqual([
      "api_token:token.permissions_changed",
      "api_token_permission:update",
      "api_token_permission:update",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ actor: "collaborator", actor_type: "human", token_id: null });
    }
    expect(events.find((event) => event.action === "token.permissions_changed")).toMatchObject({
      entity_id: made.token.id,
      payload: {
        token_name: made.token.name,
        owner: "collaborator",
        changes: [
          { resource: "ideas", from: "write", to: "read" },
          { resource: "scripts", from: "none", to: "write" },
        ],
      },
    });
  });

  it("writes nothing when nothing changes", async () => {
    const made = await makeToken(db, collaborator, { permissions: { ideas: "read" } });
    const events = await eventCount(db);
    const same = await update(collaborator, made.token.id, { ideas: "read", notes: "none" });
    expect(same.levels).toEqual(made.token.levels);
    expect(await update(collaborator, made.token.id, {})).toMatchObject({ id: made.token.id });
    expect(await eventCount(db)).toBe(events);
  });

  it("checks the ceiling again: no level above the owner's current level, and the message lists what is allowed", async () => {
    const made = await makeToken(db, reader, { permissions: { ideas: "read" } });
    const err = await failure(update(reader, made.token.id, { ideas: "write", scripts: "read" }));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe(
      `token permissions rejected for "reader": write on ideas is above the owner's own level (read); a token never exceeds its owner; choose one of: none, read`,
    );
    // Nothing was applied, not even the valid half of the request.
    expect((await lookup(made.hash)).levels).toEqual({ ...NO_ACCESS, ideas: "read" });

    const activity = await failure(update(collaborator, made.token.id, { activity: "write" }));
    expect(activity).toBeInstanceOf(NotFoundError); // not their token
    const own = await makeToken(db, collaborator, {});
    const never = await failure(update(collaborator, own.token.id, { activity: "write" }));
    expect(never).toBeInstanceOf(ValidationError);
    expect(never.message).toBe(
      "token permissions rejected: write is never allowed on activity (it allows none, read); choose one of: none, read",
    );
  });

  it("cannot raise a token above an owner who was lowered since, but can still lower it", async () => {
    const pat = await login(db, `pat-${unique()}`);
    await grant(db, root, pat, { ideas: "write", scripts: "write" });
    const made = await makeToken(db, pat, { permissions: { ideas: "write", scripts: "write" } });
    await grant(db, root, pat, { ideas: "read" });
    const err = await failure(update(pat, made.token.id, { ideas: "write" }));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toContain("write on ideas is above the owner's own level (read)");
    const lowered = await update(pat, made.token.id, { ideas: "none", scripts: "read" });
    expect(lowered.levels).toMatchObject({ ideas: "none", scripts: "read" });
  });

  it("only the owner can change a token; a revoked token cannot be changed", async () => {
    const made = await makeToken(db, collaborator, { permissions: { ideas: "read" } });
    const other = await failure(update(reader, made.token.id, { ideas: "none" }));
    expect(other).toBeInstanceOf(NotFoundError);
    expect(other.message).toBe(`you have no API token with id ${made.token.id}`);
    const admin = await failure(update(root, made.token.id, { ideas: "none" }));
    expect(admin).toBeInstanceOf(NotFoundError);
    expect((await lookup(made.hash)).levels.ideas).toBe("read");

    await asUser(collaborator, (tx) =>
      revokeApiToken(tx, { actingUserId: collaborator.id, apiTokenId: made.token.id }),
    );
    const revoked = await failure(update(collaborator, made.token.id, { ideas: "none" }));
    expect(revoked).toBeInstanceOf(InvalidTransitionError);
    expect(revoked.message).toBe(
      `token ${JSON.stringify(made.token.name)} was revoked and cannot be changed: create a new token`,
    );
    expect(
      await failure(update(collaborator, "00000000-0000-4000-8000-000000000011", {})),
    ).toBeInstanceOf(NotFoundError);
  });

  it("an API token cannot change tokens, including its own", async () => {
    const made = await makeToken(db, collaborator, { permissions: { ideas: "read" } });
    const agent: Actor = { name: made.token.name, type: "agent", tokenId: made.token.id };
    const err = await failure(update(collaborator, made.token.id, { ideas: "write" }, agent));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toMatch(/^only a signed-in person can change API tokens/);
    expect((await lookup(made.hash)).levels.ideas).toBe("read");
  });
});

describe("rotate_api_token", () => {
  const rotate = (
    user: TestUser,
    apiTokenId: string,
    input: Partial<{ prefix: string; hash: string; expiresAt: Date | null }> = {},
    actor: Actor = person(user.username),
  ) => {
    const made = newSecret();
    return withActor(web(), actor, (tx) =>
      rotateApiToken(tx, {
        actingUserId: user.id,
        apiTokenId,
        newTokenPrefix: input.prefix ?? made.prefix,
        newTokenHash: input.hash ?? made.hash,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      }),
    ).then((token) => ({ token, ...made, hash: input.hash ?? made.hash }));
  };

  it("kills the old secret at once and activates the new one; id, name, owner and levels stay", async () => {
    const made = await makeToken(db, collaborator, {
      name: "rotating bot",
      permissions: { ideas: "write", notes: "read" },
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await touchTokenLastUsed(db.pool("ytw_mcp"), { id: made.token.id, name: made.token.name });
    expect((await lookup(made.hash)).lastUsedAt).toBeInstanceOf(Date);

    const before = await mark(db);
    const rotated = await rotate(collaborator, made.token.id);
    expect(await lookupTokenByHash(db.pool("ytw_mcp"), made.hash)).toEqual({ status: "unknown" });
    const found = await lookup(rotated.hash);
    expect(found).toMatchObject({
      status: "active",
      id: made.token.id,
      name: "rotating bot",
      prefix: rotated.prefix,
      lastUsedAt: null,
      owner: { id: collaborator.id },
      levels: made.token.levels,
    });
    expect(rotated.token.prefix).toBe(rotated.prefix);
    expect(rotated.token.createdAt).toEqual(made.token.createdAt);
    expect(rotated.token.expiresAt).toEqual(made.token.expiresAt);

    const events = await eventsSince(db, before);
    expect(events.map((event) => `${event.entity_type}:${event.action}`).toSorted()).toEqual([
      "api_token:token.rotated",
      "api_token:update",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ actor: "collaborator", actor_type: "human", token_id: null });
    }
    const log = JSON.stringify(events);
    for (const secret of [
      made.hash,
      made.prefix,
      rotated.hash,
      rotated.prefix,
      made.secret,
      rotated.secret,
    ]) {
      expect(log).not.toContain(secret);
    }
  });

  it("keeps the expiry unless told otherwise; an expired token needs a new expiry", async () => {
    const soon = new Date(Date.now() + 3_600_000);
    const made = await makeToken(db, collaborator, { expiresAt: soon });
    expect((await rotate(collaborator, made.token.id)).token.expiresAt).toEqual(
      made.token.expiresAt,
    );

    const later = new Date(Date.now() + 7 * 86_400_000);
    expect(
      (await rotate(collaborator, made.token.id, { expiresAt: later })).token.expiresAt?.getTime(),
    ).toBe(later.getTime());
    expect(
      (await rotate(collaborator, made.token.id, { expiresAt: null })).token.expiresAt,
    ).toBeNull();

    await expireToken(made.token.id);
    const stale = await failure(rotate(collaborator, made.token.id));
    expect(stale).toBeInstanceOf(ValidationError);
    expect(stale.message).toMatch(
      new RegExp(
        `^token ${JSON.stringify(made.token.name)} expired on \\d{4}-\\d\\d-\\d\\dT[\\d:]+Z: rotate it with a new expiry`,
      ),
    );
    const past = await failure(
      rotate(collaborator, made.token.id, { expiresAt: new Date(Date.now() - 1000) }),
    );
    expect(past).toBeInstanceOf(ValidationError);
    expect((past as ValidationError).field).toBe("expires_at");

    const renewed = await rotate(collaborator, made.token.id, { expiresAt: later });
    expect((await lookup(renewed.hash)).status).toBe("active");
  });

  it("refuses a malformed or duplicate hash (the old secret keeps working when a rotation fails)", async () => {
    const a = await makeToken(db, collaborator, {});
    const b = await makeToken(db, collaborator, {});
    for (const hash of [a.secret, "xyz", a.hash.toUpperCase()]) {
      const err = await failure(rotate(collaborator, a.token.id, { hash }));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).not.toContain(hash);
    }
    expect(await failure(rotate(collaborator, a.token.id, { hash: b.hash }))).toBeInstanceOf(
      DuplicateError,
    );
    expect(await failure(rotate(collaborator, a.token.id, { hash: a.hash }))).toBeInstanceOf(
      DuplicateError,
    );
    expect(await failure(rotate(collaborator, a.token.id, { prefix: "nope" }))).toBeInstanceOf(
      ValidationError,
    );
    expect((await lookup(a.hash)).status).toBe("active");
  });

  it("only the owner rotates, never a revoked token, never an API token", async () => {
    const made = await makeToken(db, collaborator, {});
    expect(await failure(rotate(reader, made.token.id))).toBeInstanceOf(NotFoundError);
    expect(await failure(rotate(root, made.token.id))).toBeInstanceOf(NotFoundError);
    const agent: Actor = { name: made.token.name, type: "agent", tokenId: made.token.id };
    expect(await failure(rotate(collaborator, made.token.id, {}, agent))).toBeInstanceOf(
      ForbiddenError,
    );
    expect((await lookup(made.hash)).status).toBe("active");

    await asUser(collaborator, (tx) =>
      revokeApiToken(tx, { actingUserId: collaborator.id, apiTokenId: made.token.id }),
    );
    const err = await failure(rotate(collaborator, made.token.id));
    expect(err).toBeInstanceOf(InvalidTransitionError);
    expect(err.message).toMatch(/was revoked and cannot be rotated: create a new token$/);
  });

  it("rotating and revoking at the same moment never leaves a usable token", async () => {
    const pool = new Pool({ connectionString: db.url("ytw_web"), max: 4 });
    try {
      for (let round = 0; round < 8; round += 1) {
        const made = await makeToken(db, collaborator, { permissions: { ideas: "read" } });
        const fresh = newSecret();
        const results = await Promise.allSettled([
          withActor(pool, person("collaborator"), (tx) =>
            rotateApiToken(tx, {
              actingUserId: collaborator.id,
              apiTokenId: made.token.id,
              newTokenPrefix: fresh.prefix,
              newTokenHash: fresh.hash,
            }),
          ),
          withActor(pool, person("collaborator"), (tx) =>
            revokeApiToken(tx, { actingUserId: collaborator.id, apiTokenId: made.token.id }),
          ),
        ]);
        expect(results[1]?.status).toBe("fulfilled");
        if (results[0]?.status === "rejected") {
          expect(results[0].reason).toBeInstanceOf(InvalidTransitionError);
        }
        for (const hash of [made.hash, fresh.hash]) {
          expect((await lookupTokenByHash(web(), hash)).status).not.toBe("active");
        }
      }
    } finally {
      await pool.end();
    }
  });
});

describe("revoke_api_token", () => {
  const revoke = (user: TestUser, apiTokenId: string, actor: Actor = person(user.username)) =>
    withActor(web(), actor, (tx) => revokeApiToken(tx, { actingUserId: user.id, apiTokenId }));

  it("takes effect at once, keeps the token listed, and is audited once", async () => {
    const made = await makeToken(db, collaborator, { permissions: { ideas: "write" } });
    expect((await lookup(made.hash)).status).toBe("active");

    const before = await mark(db);
    const revoked = await revoke(collaborator, made.token.id);
    expect(revoked).toMatchObject({
      id: made.token.id,
      status: "revoked",
      effectiveLevels: NO_ACCESS,
    });
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect((await lookup(made.hash)).status).toBe("revoked");
    expect(
      (await listApiTokens(web(), collaborator.id)).find((token) => token.id === made.token.id),
    ).toMatchObject({
      status: "revoked",
    });

    const events = await eventsSince(db, before);
    expect(events.map((event) => `${event.entity_type}:${event.action}`).toSorted()).toEqual([
      "api_token:token.revoked",
      "api_token:update",
    ]);
    expect(events.find((event) => event.action === "token.revoked")).toMatchObject({
      entity_id: made.token.id,
      actor: "collaborator",
      actor_type: "human",
      token_id: null,
      payload: { token_name: made.token.name, owner: "collaborator" },
    });
  });

  it("revoking again changes nothing: the first revocation time stays and nothing more is logged", async () => {
    const made = await makeToken(db, collaborator, {});
    const first = await revoke(collaborator, made.token.id);
    const events = await eventCount(db);
    const second = await revoke(collaborator, made.token.id);
    expect(second.revokedAt).toEqual(first.revokedAt);
    expect(await eventCount(db)).toBe(events);
  });

  it("only the owner revokes; an admin lowers a user's levels instead; an API token never revokes", async () => {
    const made = await makeToken(db, collaborator, { permissions: { ideas: "write" } });
    expect(await failure(revoke(reader, made.token.id))).toBeInstanceOf(NotFoundError);
    expect(await failure(revoke(root, made.token.id))).toBeInstanceOf(NotFoundError);
    const agent: Actor = { name: made.token.name, type: "agent", tokenId: made.token.id };
    const err = await failure(revoke(collaborator, made.token.id, agent));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toMatch(/^only a signed-in person can revoke API tokens/);
    expect((await lookup(made.hash)).status).toBe("active");
    expect(
      await failure(revoke(collaborator, "00000000-0000-4000-8000-000000000012")),
    ).toBeInstanceOf(NotFoundError);
  });
});

describe("touch_token_last_used", () => {
  it("records the use on the token without an audit event and without touching updated_at", async () => {
    const made = await makeToken(db, collaborator, { permissions: { ideas: "read" } });
    const row = async () =>
      (
        await db.admin.query<{ last_used_at: Date | null; updated_at: Date; updated_by: string }>(
          "SELECT last_used_at, updated_at, updated_by FROM ytw_private.api_tokens WHERE id = $1",
          [made.token.id],
        )
      ).rows[0];
    const initial = await row();
    expect(initial?.last_used_at).toBeNull();

    const events = await eventCount(db);
    const token = { id: made.token.id, name: made.token.name };
    expect(await touchTokenLastUsed(db.pool("ytw_mcp"), token)).toBe(true);
    const first = await row();
    expect(first?.last_used_at).toBeInstanceOf(Date);
    expect(first?.updated_at).toEqual(initial?.updated_at);
    expect(first?.updated_by).toBe(initial?.updated_by);

    expect(await touchTokenLastUsed(db.pool("ytw_mcp"), token)).toBe(true);
    expect(await touchTokenLastUsed(web(), token)).toBe(true);
    const later = await row();
    expect((later?.last_used_at?.getTime() ?? 0) >= (first?.last_used_at?.getTime() ?? 1)).toBe(
      true,
    );
    // No audit spam: 3 touches, 0 events.
    expect(await eventCount(db)).toBe(events);
    expect((await lookup(made.hash)).lastUsedAt).toEqual(later?.last_used_at);
  });

  it("leaves revoked, expired and unknown tokens alone", async () => {
    const revoked = await makeToken(db, collaborator, {});
    await asUser(collaborator, (tx) =>
      revokeApiToken(tx, { actingUserId: collaborator.id, apiTokenId: revoked.token.id }),
    );
    const expired = await makeToken(db, collaborator, {});
    await expireToken(expired.token.id);
    for (const made of [revoked, expired]) {
      expect(
        await touchTokenLastUsed(db.pool("ytw_mcp"), { id: made.token.id, name: made.token.name }),
      ).toBe(false);
      expect((await lookup(made.hash)).lastUsedAt).toBeNull();
    }
    expect(
      await touchTokenLastUsed(db.pool("ytw_mcp"), {
        id: "00000000-0000-4000-8000-000000000013",
        name: "ghost",
      }),
    ).toBe(false);
  });

  it("is called as the token itself: a person or a missing token id is refused", async () => {
    const made = await makeToken(db, collaborator, {});
    const asHuman = await failure(
      db.pool("ytw_mcp").query(sql`SELECT touch_token_last_used('collaborator', 'human', NULL)`),
    );
    expect(asHuman).toMatchObject({ code: "YT001" });
    expect(asHuman.message).toMatch(/is called as the token itself/);
    const missing = await failure(
      db
        .pool("ytw_mcp")
        .query(sql`SELECT touch_token_last_used(${made.token.name}, 'agent', NULL)`),
    );
    expect(missing).toMatchObject({ code: "YT001" });
  });
});

describe("the settings lists", () => {
  it("list the owner's own tokens only, newest first, revoked ones included, with own and effective levels", async () => {
    const quinn = await login(db, `quinn-${unique()}`);
    await grant(db, root, quinn, { ideas: "write", scripts: "write", activity: "read" });
    const first = await makeToken(db, quinn, { name: "first", permissions: { ideas: "write" } });
    const second = await makeToken(db, quinn, {
      name: "second",
      permissions: { scripts: "write", activity: "read" },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const third = await makeToken(db, quinn, { name: "third", permissions: { ideas: "read" } });
    await makeToken(db, collaborator, { name: "somebody else's" });
    await asUser(quinn, (tx) =>
      revokeApiToken(tx, { actingUserId: quinn.id, apiTokenId: second.token.id }),
    );
    await touchTokenLastUsed(db.pool("ytw_mcp"), { id: first.token.id, name: "first" });
    await grant(db, root, quinn, { ideas: "read" });

    const tokens = await listApiTokens(web(), quinn.id);
    expect(tokens.map((token) => token.name)).toEqual(["third", "second", "first"]);
    expect(tokens.map((token) => token.status)).toEqual(["active", "revoked", "active"]);
    const byName = Object.fromEntries(tokens.map((token) => [token.name, token]));
    expect(byName.first?.lastUsedAt).toBeInstanceOf(Date);
    expect(byName.third?.lastUsedAt).toBeNull();
    expect(byName.second?.expiresAt).toBeInstanceOf(Date);
    expect(byName.second?.revokedAt).toBeInstanceOf(Date);
    // Own levels stay, effective levels follow the owner: ideas was lowered to read, revoked is none.
    expect(byName.first?.levels).toMatchObject({ ideas: "write" });
    expect(byName.first?.effectiveLevels).toMatchObject({ ideas: "read" });
    expect(byName.second?.levels).toMatchObject({ scripts: "write", activity: "read" });
    expect(byName.second?.effectiveLevels).toEqual(NO_ACCESS);
    expect(byName.third?.prefix).toBe(third.prefix);
    expect(JSON.stringify(tokens)).not.toMatch(/[0-9a-f]{64}/);
    expect(tokens.every((token) => token.ownerId === quinn.id)).toBe(true);
  });

  it("show an expired token as expired with no effective access", async () => {
    const made = await makeToken(db, collaborator, { permissions: { ideas: "write" } });
    await expireToken(made.token.id);
    const listed = (await listApiTokens(web(), collaborator.id)).find(
      (token) => token.id === made.token.id,
    );
    expect(listed).toMatchObject({ status: "expired", effectiveLevels: NO_ACCESS });
  });

  it("return one token for its owner and nothing for anyone else", async () => {
    const made = await makeToken(db, collaborator, { name: "single" });
    expect(await getApiToken(web(), collaborator.id, made.token.id)).toMatchObject({
      id: made.token.id,
      name: "single",
    });
    expect(await getApiToken(web(), reader.id, made.token.id)).toBeNull();
    expect(
      await getApiToken(web(), collaborator.id, "00000000-0000-4000-8000-000000000014"),
    ).toBeNull();
    expect(await listApiTokens(web(), "00000000-0000-4000-8000-000000000015")).toEqual([]);
  });
});

describe("secrets", () => {
  it("never appear in an event, a message or a list across a token's whole life", async () => {
    const before = await mark(db);
    const made = await makeToken(db, collaborator, {
      name: "lifecycle",
      permissions: { ideas: "read" },
    });
    const secrets = [made.secret, made.hash, made.prefix];
    await asUser(collaborator, (tx) =>
      updateTokenPermissions(tx, {
        actingUserId: collaborator.id,
        apiTokenId: made.token.id,
        permissions: { ideas: "write" },
      }),
    );
    const rotated = newSecret();
    await asUser(collaborator, (tx) =>
      rotateApiToken(tx, {
        actingUserId: collaborator.id,
        apiTokenId: made.token.id,
        newTokenPrefix: rotated.prefix,
        newTokenHash: rotated.hash,
      }),
    );
    secrets.push(rotated.secret, rotated.hash, rotated.prefix);
    await touchTokenLastUsed(db.pool("ytw_mcp"), { id: made.token.id, name: "lifecycle" });
    await asUser(collaborator, (tx) =>
      revokeApiToken(tx, { actingUserId: collaborator.id, apiTokenId: made.token.id }),
    );
    // A failed attempt with the secret in the hash position.
    const err = await failure(create(collaborator, {}, { hash: made.secret }));

    const events = JSON.stringify(await eventsSince(db, before));
    const listing = JSON.stringify(await listApiTokens(web(), collaborator.id));
    // The log hides the secret, its hash and even its prefix.
    for (const secret of secrets) {
      expect(events).not.toContain(secret);
    }
    // The settings list shows the prefix (that is its job) but never the secret or the hash.
    for (const secret of [made.secret, made.hash, rotated.secret, rotated.hash]) {
      expect(listing).not.toContain(secret);
    }
    expect(listing).toContain(rotated.prefix);
    expect(err.message).not.toContain(made.secret);
    expect(JSON.stringify(err)).not.toContain(made.secret);
  });
});
