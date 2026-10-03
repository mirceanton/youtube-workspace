// Authentication and the token service against a real database, as the real application roles:
// the web role manages tokens, the MCP role authenticates them. PRD 7: revocation, rotation,
// expiry and a lowered owner apply on the very next call; PRD 9: failed attempts are rate limited.
import {
  setUserAccessRevoked,
  setUserPermission,
  upsertUserOnLogin,
  withActor,
  type Queryable,
} from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FailureLimiter,
  TokenGrantError,
  createAuthenticator,
  createToken,
  generateToken,
  revokeToken,
  rotateToken,
  updateToken,
  type Authenticator,
  type TokenOwnerRef,
} from "../src/index.js";

const ISSUER = "https://id.example.test/realms/ytw";
let db: TestDb;
let admin: TokenOwnerRef;
let counter = 0;

/** Forwards a query to the MCP role's pool (the Queryable overloads need one cast). */
const mcpQuery = ((query: unknown, values?: unknown[]) =>
  db.pool("ytw_mcp").query(query as never, values)) as Queryable["query"];

const person = (username: string) => ({ name: username, type: "human" as const });
const unique = (prefix: string): string => `${prefix}-${Date.now().toString(36)}${(counter += 1)}`;

async function signIn(username: string): Promise<TokenOwnerRef> {
  const result = await withActor(db.pool("ytw_web"), person(username), (tx) =>
    upsertUserOnLogin(tx, { issuer: ISSUER, sub: `sub-${username}`, username }),
  );
  return { id: result.id, username };
}

async function setLevel(
  user: TokenOwnerRef,
  resource: "ideas" | "scripts",
  level: "none" | "read" | "write",
) {
  await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
    setUserPermission(tx, { actingUserId: admin.id, userId: user.id, resource, level }),
  );
}

async function collaborator(): Promise<TokenOwnerRef> {
  const user = await signIn(unique("collab"));
  await setLevel(user, "ideas", "write");
  await setLevel(user, "scripts", "read");
  return user;
}

function authenticator(
  options: {
    limiter?: FailureLimiter;
    now?: () => number;
    touchIntervalMs?: number;
    db?: Queryable;
  } = {},
): Authenticator {
  return createAuthenticator({ db: options.db ?? db.pool("ytw_mcp"), ...options });
}

async function lastUsed(tokenId: string): Promise<Date | null> {
  const { rows } = await db.admin.query<{ last_used_at: Date | null }>(
    "SELECT last_used_at FROM ytw_private.api_tokens WHERE id = $1",
    [tokenId],
  );
  return rows[0]?.last_used_at ?? null;
}

beforeAll(async () => {
  db = await createTestDb();
  admin = await signIn("the-admin"); // the first user ever becomes admin
});
afterAll(async () => {
  await db.drop();
});

describe("a valid token", () => {
  it("authenticates as a principal with the lower of token and owner levels", async () => {
    const owner = await collaborator();
    const name = unique("agent");
    const issued = await createToken(db.pool("ytw_web"), owner, {
      name,
      expiresAt: null,
      permissions: { ideas: "write", scripts: "read" },
    });
    expect(issued.secret).toMatch(/^ytw_/);
    expect(JSON.stringify(issued.token)).not.toContain(issued.secret);

    const result = await authenticator().authenticate(`Bearer ${issued.secret}`, "10.0.0.1");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.principal.kind).toBe("token");
    expect(result.principal.tokenId).toBe(issued.token.id);
    expect(result.principal.tokenName).toBe(name);
    expect(result.ownerUsername).toBe(owner.username);
    expect(result.effectiveLevels.ideas).toBe("write");
    expect(result.effectiveLevels.scripts).toBe("read");
    expect(result.effectiveLevels.videos).toBe("none");
  });

  it("lowering the owner lowers the token on the next call", async () => {
    const owner = await collaborator();
    const issued = await createToken(db.pool("ytw_web"), owner, {
      name: unique("agent"),
      expiresAt: null,
      permissions: { ideas: "write" },
    });
    const auth = authenticator();
    const before = await auth.authenticate(`Bearer ${issued.secret}`, "c");
    expect(before.ok && before.effectiveLevels.ideas).toBe("write");

    await setLevel(owner, "ideas", "read");
    const after = await auth.authenticate(`Bearer ${issued.secret}`, "c");
    expect(after.ok && after.effectiveLevels.ideas).toBe("read");
    expect(after.ok && after.principal.levels.ideas).toBe("write"); // the token's own level is unchanged
  });

  it("updating the token's levels applies on the next call", async () => {
    const owner = await collaborator();
    const issued = await createToken(db.pool("ytw_web"), owner, {
      name: unique("agent"),
      expiresAt: null,
      permissions: { ideas: "write" },
    });
    await updateToken(db.pool("ytw_web"), owner, issued.token.id, { ideas: "none" });
    const result = await authenticator().authenticate(`Bearer ${issued.secret}`, "c");
    expect(result.ok && result.effectiveLevels.ideas).toBe("none");
  });
});

describe("failure modes", () => {
  it("reports a missing header, a malformed one and an unknown token", async () => {
    const auth = authenticator();
    expect(await auth.authenticate(undefined, "m")).toEqual({ ok: false, reason: "missing" });
    expect(await auth.authenticate("Bearer nope", "m")).toEqual({ ok: false, reason: "malformed" });
    expect(await auth.authenticate(`Bearer ${generateToken().secret}`, "m")).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("revocation takes effect on the next call", async () => {
    const owner = await collaborator();
    const issued = await createToken(db.pool("ytw_web"), owner, {
      name: unique("agent"),
      expiresAt: null,
      permissions: { ideas: "read" },
    });
    const auth = authenticator();
    expect((await auth.authenticate(`Bearer ${issued.secret}`, "r")).ok).toBe(true);
    await revokeToken(db.pool("ytw_web"), owner, issued.token.id);
    expect(await auth.authenticate(`Bearer ${issued.secret}`, "r")).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("rotation kills the old secret and the new one works", async () => {
    const owner = await collaborator();
    const issued = await createToken(db.pool("ytw_web"), owner, {
      name: unique("agent"),
      expiresAt: null,
      permissions: { ideas: "read" },
    });
    const rotated = await rotateToken(db.pool("ytw_web"), owner, issued.token.id);
    expect(rotated.secret).not.toBe(issued.secret);
    expect(rotated.token.id).toBe(issued.token.id);
    const auth = authenticator();
    expect(await auth.authenticate(`Bearer ${issued.secret}`, "rot")).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect((await auth.authenticate(`Bearer ${rotated.secret}`, "rot")).ok).toBe(true);
  });

  it("reports an expired token", async () => {
    const owner = await collaborator();
    const issued = await createToken(db.pool("ytw_web"), owner, {
      name: unique("agent"),
      expiresAt: new Date(Date.now() + 3_600_000),
      permissions: { ideas: "read" },
    });
    const client = await db.admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT ytw_set_actor('test', 'human', NULL)");
      await client.query(
        "UPDATE ytw_private.api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1",
        [issued.token.id],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await authenticator().authenticate(`Bearer ${issued.secret}`, "e")).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("reports owner_removed while the owner's access is revoked, and works again after", async () => {
    const owner = await collaborator();
    const issued = await createToken(db.pool("ytw_web"), owner, {
      name: unique("agent"),
      expiresAt: null,
      permissions: { ideas: "read" },
    });
    const auth = authenticator();
    const lock = (revoked: boolean) =>
      withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
        setUserAccessRevoked(tx, { actingUserId: admin.id, userId: owner.id, revoked }),
      );
    await lock(true);
    expect(await auth.authenticate(`Bearer ${issued.secret}`, "o")).toEqual({
      ok: false,
      reason: "owner_removed",
    });
    await lock(false);
    expect((await auth.authenticate(`Bearer ${issued.secret}`, "o")).ok).toBe(true);
  });
});

describe("last_used_at", () => {
  it("is written on first use and then at most once per interval", async () => {
    const owner = await collaborator();
    const issued = await createToken(db.pool("ytw_web"), owner, {
      name: unique("agent"),
      expiresAt: null,
      permissions: { ideas: "read" },
    });
    let now = Date.now();
    const auth = authenticator({ now: () => now, touchIntervalMs: 60_000 });
    expect(await lastUsed(issued.token.id)).toBeNull();

    await auth.authenticate(`Bearer ${issued.secret}`, "t");
    const first = await lastUsed(issued.token.id);
    expect(first).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 20));
    now += 30_000;
    await auth.authenticate(`Bearer ${issued.secret}`, "t");
    expect(await lastUsed(issued.token.id)).toEqual(first);

    now += 31_000;
    await auth.authenticate(`Bearer ${issued.secret}`, "t");
    const later = await lastUsed(issued.token.id);
    expect(later && first && later.getTime() > first.getTime()).toBe(true);
  });

  it("writes once for concurrent first requests", async () => {
    const owner = await collaborator();
    const issued = await createToken(db.pool("ytw_web"), owner, {
      name: unique("agent"),
      expiresAt: null,
      permissions: { ideas: "read" },
    });
    let touches = 0;
    const counting: Queryable = {
      query: (query, values) => {
        const text = typeof query === "string" ? query : query.text;
        if (text.includes("touch_token_last_used")) {
          touches += 1;
        }
        return mcpQuery(query, values);
      },
    };
    const auth = authenticator({ db: counting });
    await Promise.all(
      Array.from({ length: 8 }, () => auth.authenticate(`Bearer ${issued.secret}`, "burst")),
    );
    expect(touches).toBe(1);
  });

  it("does not fail the request when the write fails", async () => {
    const owner = await collaborator();
    const issued = await createToken(db.pool("ytw_web"), owner, {
      name: unique("agent"),
      expiresAt: null,
      permissions: { ideas: "read" },
    });
    const errors: unknown[] = [];
    const flaky: Queryable = {
      query: (query, values) => {
        const text = typeof query === "string" ? query : query.text;
        if (text.includes("touch_token_last_used")) {
          return Promise.reject(new Error("write failed"));
        }
        return mcpQuery(query, values);
      },
    };
    const auth = createAuthenticator({ db: flaky, onTouchError: (error) => errors.push(error) });
    expect((await auth.authenticate(`Bearer ${issued.secret}`, "flaky")).ok).toBe(true);
    expect(errors).toHaveLength(1);
  });
});

describe("rate limiting", () => {
  it("blocks a client after repeated failures, with Retry-After, before touching the database", async () => {
    const owner = await collaborator();
    const issued = await createToken(db.pool("ytw_web"), owner, {
      name: unique("agent"),
      expiresAt: null,
      permissions: { ideas: "read" },
    });
    let lookups = 0;
    const counting: Queryable = {
      query: (query, values) => {
        lookups += 1;
        return mcpQuery(query, values);
      },
    };
    const limiter = new FailureLimiter({ maxFailures: 3, windowMs: 60_000 });
    const auth = authenticator({ limiter, db: counting });
    for (let i = 0; i < 3; i += 1) {
      expect((await auth.authenticate(`Bearer ${generateToken().secret}`, "attacker")).ok).toBe(
        false,
      );
    }
    const lookupsBefore = lookups;
    const blocked = await auth.authenticate(`Bearer ${issued.secret}`, "attacker");
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.reason).toBe("rate_limited");
    expect(!blocked.ok && blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(lookups).toBe(lookupsBefore);
    // another client is unaffected
    expect((await auth.authenticate(`Bearer ${issued.secret}`, "friend")).ok).toBe(true);
  });

  it("counts malformed and missing headers too, and blocks per token prefix", async () => {
    const limiter = new FailureLimiter({ maxFailures: 2 });
    const auth = authenticator({ limiter });
    await auth.authenticate(undefined, "sprayer");
    await auth.authenticate("garbage", "sprayer");
    expect(await auth.authenticate(undefined, "sprayer")).toMatchObject({ reason: "rate_limited" });

    const guess = generateToken().secret;
    await auth.authenticate(`Bearer ${guess}`, "a");
    await auth.authenticate(`Bearer ${guess}`, "b");
    expect(await auth.authenticate(`Bearer ${guess}`, "c")).toMatchObject({
      reason: "rate_limited",
    });
  });
});

describe("the token service", () => {
  it("refuses levels above the owner's with a readable message, before any write", async () => {
    const owner = await collaborator(); // ideas write, scripts read
    const name = unique("greedy");
    const error = await createToken(db.pool("ytw_web"), owner, {
      name,
      expiresAt: null,
      permissions: { scripts: "write", activity: "write" },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenGrantError);
    const violations = (error as TokenGrantError).violations;
    expect(violations.map((v) => v.resource).toSorted()).toEqual(["activity", "scripts"]);
    expect((error as TokenGrantError).message).toMatch(/scripts/);
    const { rows } = await db.admin.query("SELECT 1 FROM ytw_private.api_tokens WHERE name = $1", [
      name,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("refuses an update above the owner's level and keeps the old levels", async () => {
    const owner = await collaborator();
    const issued = await createToken(db.pool("ytw_web"), owner, {
      name: unique("agent"),
      expiresAt: null,
      permissions: { ideas: "read" },
    });
    await expect(
      updateToken(db.pool("ytw_web"), owner, issued.token.id, { scripts: "write" }),
    ).rejects.toBeInstanceOf(TokenGrantError);
    const result = await authenticator().authenticate(`Bearer ${issued.secret}`, "u");
    expect(result.ok && result.principal.levels.scripts).toBe("none");
  });

  it("stores only the hash: the secret appears nowhere in the database", async () => {
    const owner = await collaborator();
    const issued = await createToken(db.pool("ytw_web"), owner, {
      name: unique("agent"),
      expiresAt: null,
      permissions: { ideas: "read" },
    });
    const tables = ["ytw_private.api_tokens", "events"];
    for (const table of tables) {
      const { rows } = await db.admin.query<{ doc: string }>(
        `SELECT t::text AS doc FROM ${table} t`,
      );
      expect(rows.some((row) => row.doc.includes(issued.secret))).toBe(false);
    }
  });
});
