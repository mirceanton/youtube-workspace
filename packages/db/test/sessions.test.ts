// Web sessions (migration 0054, T14): idle and absolute expiry, touch, refresh-token storage,
// delete and purge, and the guarantee that sessions never reach the audit log.
//
// Time passing is simulated by moving the stored timestamps back (superuser pool); the functions
// measure expiry against the clock of the call that checks it, so a shifted session behaves exactly
// like an old one.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "../src/errors.js";
import {
  createWebSession,
  deleteWebSession,
  getWebSession,
  purgeExpiredWebSessions,
  touchWebSession,
  updateWebSessionTokens,
} from "../src/sessions.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { failure } from "./helpers.js";
import { eventCount, login, type TestUser } from "./identity-helpers.js";

const IDLE = 8 * 3600; // PRD 7: idle timeout 8 hours
const ABSOLUTE = 7 * 86_400; // PRD 7: absolute timeout 7 days
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let db: TestDb;
let sam: TestUser;
const web = () => db.pool("ytw_web");

beforeAll(async () => {
  db = await createTestDb();
  sam = await login(db, "sam");
});

afterAll(async () => {
  await db.drop();
});

/** Makes a session look `seconds` older: every stored timestamp moves back. */
async function age(sessionId: string, seconds: number): Promise<void> {
  await db.admin.query(
    `UPDATE ytw_private.web_sessions
        SET created_at = created_at - make_interval(secs => $2),
            last_seen_at = last_seen_at - make_interval(secs => $2),
            expires_at = expires_at - make_interval(secs => $2),
            absolute_expires_at = absolute_expires_at - make_interval(secs => $2)
      WHERE id = $1`,
    [sessionId, seconds],
  );
}

interface StoredSession {
  last_seen_at: Date;
  expires_at: Date;
  absolute_expires_at: Date;
}

async function stored(sessionId: string): Promise<StoredSession> {
  const { rows } = await db.admin.query<StoredSession>(
    "SELECT last_seen_at, expires_at, absolute_expires_at FROM ytw_private.web_sessions WHERE id = $1",
    [sessionId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("session not found");
  }
  return row;
}

function start(
  overrides: {
    idle?: number;
    absolute?: number;
    refresh?: Uint8Array | null;
    hint?: string | null;
  } = {},
) {
  return createWebSession(web(), {
    userId: sam.id,
    refreshTokenEncrypted: overrides.refresh === undefined ? randomBytes(64) : overrides.refresh,
    idTokenHint: overrides.hint === undefined ? "header.payload.signature" : overrides.hint,
    idleTimeoutSeconds: overrides.idle ?? IDLE,
    absoluteTimeoutSeconds: overrides.absolute ?? ABSOLUTE,
  });
}

describe("create_web_session", () => {
  it("starts an active session: idle expiry = now + idle timeout, absolute expiry = now + absolute timeout", async () => {
    const session = await start();
    expect(session).toMatchObject({ userId: sam.id, status: "active" });
    expect(session.id).toMatch(UUID_V4);
    expect(session.lastSeenAt).toEqual(session.createdAt);
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(IDLE * 1000);
    expect(session.absoluteExpiresAt.getTime() - session.createdAt.getTime()).toBe(ABSOLUTE * 1000);
    expect(Math.abs(session.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("the session id is a random version 4 UUID: it is a bearer handle, not a time-ordered key", async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, () => start({ refresh: null })));
    expect(new Set(ids.map((session) => session.id)).size).toBe(20);
    for (const session of ids) {
      expect(session.id).toMatch(UUID_V4);
    }
  });

  it("never lets the idle expiry exceed the absolute expiry", async () => {
    const session = await start({ idle: 7200, absolute: 3600 });
    expect(session.expiresAt).toEqual(session.absoluteExpiresAt);
  });

  it("works without a refresh token or ID token hint (the provider issued none)", async () => {
    const session = await start({ refresh: null, hint: null });
    expect(await getWebSession(web(), session.id)).toMatchObject({
      status: "active",
      refreshTokenEncrypted: null,
      idTokenHint: null,
    });
  });

  const invalid: [string, Parameters<typeof createWebSession>[1], RegExp, string][] = [
    [
      "an idle timeout below a minute",
      { userId: "", idleTimeoutSeconds: 59, absoluteTimeoutSeconds: ABSOLUTE },
      /^the idle timeout must be between 60 and 31622400 seconds/,
      "idle_timeout_seconds",
    ],
    [
      "an idle timeout above 366 days",
      { userId: "", idleTimeoutSeconds: 31_622_401, absoluteTimeoutSeconds: ABSOLUTE },
      /^the idle timeout must be between/,
      "idle_timeout_seconds",
    ],
    [
      "a negative idle timeout",
      { userId: "", idleTimeoutSeconds: -5, absoluteTimeoutSeconds: ABSOLUTE },
      /^the idle timeout must be between/,
      "idle_timeout_seconds",
    ],
    [
      "an absolute timeout below a minute",
      { userId: "", idleTimeoutSeconds: IDLE, absoluteTimeoutSeconds: 0 },
      /^the absolute timeout must be between 60 and 31622400 seconds/,
      "absolute_timeout_seconds",
    ],
    [
      "an empty refresh token",
      {
        userId: "",
        refreshTokenEncrypted: new Uint8Array(0),
        idleTimeoutSeconds: IDLE,
        absoluteTimeoutSeconds: ABSOLUTE,
      },
      /^the encrypted refresh token must be 1 to 16384 bytes/,
      "refresh_token_encrypted",
    ],
    [
      "a refresh token over 16384 bytes",
      {
        userId: "",
        refreshTokenEncrypted: new Uint8Array(16_385),
        idleTimeoutSeconds: IDLE,
        absoluteTimeoutSeconds: ABSOLUTE,
      },
      /^the encrypted refresh token must be 1 to 16384 bytes/,
      "refresh_token_encrypted",
    ],
    [
      "an empty ID token hint",
      {
        userId: "",
        idTokenHint: "",
        idleTimeoutSeconds: IDLE,
        absoluteTimeoutSeconds: ABSOLUTE,
      },
      /^the ID token hint must be 1 to 16384 characters/,
      "id_token_hint",
    ],
    [
      "an ID token hint over 16384 characters",
      {
        userId: "",
        idTokenHint: "h".repeat(16_385),
        idleTimeoutSeconds: IDLE,
        absoluteTimeoutSeconds: ABSOLUTE,
      },
      /^the ID token hint must be 1 to 16384 characters/,
      "id_token_hint",
    ],
  ];
  it.each(invalid)("refuses %s", async (_label, input, message, field) => {
    const err = await failure(createWebSession(web(), { ...input, userId: sam.id }));
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).field).toBe(field);
    expect(err.message).toMatch(message);
  });

  it("accepts the limits themselves", async () => {
    expect(
      (await start({ idle: 60, absolute: 60, refresh: new Uint8Array(1), hint: "h" })).status,
    ).toBe("active");
    const long = await start({
      idle: 31_622_400,
      absolute: 31_622_400,
      refresh: new Uint8Array(16_384).fill(7),
      hint: "h".repeat(16_384),
    });
    expect((await getWebSession(web(), long.id))?.refreshTokenEncrypted?.length).toBe(16_384);
  });

  it("refuses a whole-number-of-seconds violation before it reaches the database", async () => {
    const err = await failure(
      createWebSession(web(), {
        userId: sam.id,
        idleTimeoutSeconds: 1.5,
        absoluteTimeoutSeconds: ABSOLUTE,
      }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("idle_timeout_seconds must be a whole number of seconds");
    const notANumber = await failure(
      touchWebSession(web(), "00000000-0000-4000-8000-000000000020", Number.NaN),
    );
    expect(notANumber).toBeInstanceOf(ValidationError);
  });

  it("refuses a user who does not exist", async () => {
    const err = await failure(
      createWebSession(web(), {
        userId: "00000000-0000-4000-8000-000000000021",
        idleTimeoutSeconds: IDLE,
        absoluteTimeoutSeconds: ABSOLUTE,
      }),
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe(
      "user 00000000-0000-4000-8000-000000000021 does not exist: a session belongs to a user who has signed in",
    );
  });
});

describe("get_web_session", () => {
  it("returns the opaque refresh token and the ID token hint of an active session", async () => {
    const refresh = randomBytes(300);
    const session = await start({ refresh, hint: "a.b.c" });
    const details = await getWebSession(web(), session.id);
    expect(details).toMatchObject({
      id: session.id,
      userId: sam.id,
      status: "active",
      idTokenHint: "a.b.c",
    });
    expect(details?.refreshTokenEncrypted?.equals(Buffer.from(refresh))).toBe(true);
    expect(details?.absoluteExpiresAt).toEqual(session.absoluteExpiresAt);
  });

  it("returns null for an unknown id", async () => {
    expect(await getWebSession(web(), "00000000-0000-4000-8000-000000000022")).toBeNull();
  });

  it("reports idle expiry and absolute expiry distinctly, and hands out no refresh token once dead", async () => {
    const idle = await start({ idle: 3600, absolute: ABSOLUTE });
    await age(idle.id, 3601);
    expect(await getWebSession(web(), idle.id)).toMatchObject({
      status: "idle_expired",
      refreshTokenEncrypted: null,
      idTokenHint: "header.payload.signature",
    });

    const old = await start({ idle: 3600, absolute: 7200 });
    await age(old.id, 7201);
    expect((await getWebSession(web(), old.id))?.status).toBe("absolute_expired");
    expect((await getWebSession(web(), old.id))?.refreshTokenEncrypted).toBeNull();

    // Just inside both limits it is still alive.
    const edge = await start({ idle: 3600, absolute: 7200 });
    await age(edge.id, 3590);
    expect(await getWebSession(web(), edge.id)).toMatchObject({ status: "active" });
  });
});

describe("touch_web_session", () => {
  it("moves the idle expiry forward from now, not from the old expiry, and records the activity", async () => {
    const session = await start({ idle: 3600, absolute: ABSOLUTE });
    await age(session.id, 1800); // half the idle time has passed
    const before = await stored(session.id);

    const touched = await touchWebSession(web(), session.id, 3600);
    expect(touched).toMatchObject({ id: session.id, userId: sam.id, status: "active" });
    expect(touched?.expiresAt.getTime() ?? 0).toBeGreaterThan(before.expires_at.getTime());
    expect(touched?.lastSeenAt.getTime() ?? 0).toBeGreaterThan(before.last_seen_at.getTime());
    // now + 3600 s: within a few seconds of the clock.
    expect(Math.abs((touched?.expiresAt.getTime() ?? 0) - (Date.now() + 3_600_000))).toBeLessThan(
      30_000,
    );
    // The absolute expiry is fixed at login.
    expect(touched?.absoluteExpiresAt).toEqual(before.absolute_expires_at);
  });

  it("never moves the idle expiry past the absolute expiry", async () => {
    const session = await start({ idle: 3600, absolute: 4000 });
    await age(session.id, 1000);
    const touched = await touchWebSession(web(), session.id, IDLE);
    expect(touched?.expiresAt).toEqual(touched?.absoluteExpiresAt);
  });

  it("does not revive a session whose idle time ran out", async () => {
    const session = await start({ idle: 3600, absolute: ABSOLUTE });
    await age(session.id, 3601);
    const before = await stored(session.id);
    expect(await touchWebSession(web(), session.id, 3600)).toBeNull();
    expect(await stored(session.id)).toEqual(before);
    expect((await getWebSession(web(), session.id))?.status).toBe("idle_expired");
  });

  it("does not revive a session past its absolute lifetime", async () => {
    const session = await start({ idle: 3600, absolute: 7200 });
    await age(session.id, 7201);
    expect(await touchWebSession(web(), session.id, 3600)).toBeNull();
    expect((await getWebSession(web(), session.id))?.status).toBe("absolute_expired");
  });

  it("returns null for an unknown session", async () => {
    expect(await touchWebSession(web(), "00000000-0000-4000-8000-000000000023", IDLE)).toBeNull();
  });

  it("a session used more often than its idle timeout lives on, until its absolute lifetime ends", async () => {
    // Idle 1 h, absolute 2 h, a request every 30 minutes.
    const session = await start({ idle: 3600, absolute: 7200 });
    const outcomes: string[] = [];
    for (let step = 1; step <= 5; step += 1) {
      await age(session.id, 1800);
      const touched = await touchWebSession(web(), session.id, 3600);
      outcomes.push(touched === null ? "dead" : touched.status);
    }
    // 30 min, 60 min, 90 min: alive although the idle timeout (1 h) is shorter than the session;
    // at 120 min the absolute lifetime ends it; it stays dead.
    expect(outcomes).toEqual(["active", "active", "active", "dead", "dead"]);
    expect((await getWebSession(web(), session.id))?.status).toBe("absolute_expired");
  });

  it("a session left alone dies of idleness although its absolute lifetime has not ended", async () => {
    const session = await start({ idle: 3600, absolute: ABSOLUTE });
    await age(session.id, 3000);
    expect(await touchWebSession(web(), session.id, 3600)).not.toBeNull();
    await age(session.id, 3601); // an hour and a bit with no request
    expect(await touchWebSession(web(), session.id, 3600)).toBeNull();
    expect((await getWebSession(web(), session.id))?.status).toBe("idle_expired");
  });
});

describe("update_web_session_tokens", () => {
  it("stores the tokens of a silent refresh; null keeps the stored value", async () => {
    const session = await start({ refresh: Buffer.from("old-ciphertext"), hint: "old.hint.token" });
    const fresh = randomBytes(80);
    expect(await updateWebSessionTokens(web(), session.id, { refreshTokenEncrypted: fresh })).toBe(
      true,
    );
    let details = await getWebSession(web(), session.id);
    expect(details?.refreshTokenEncrypted?.equals(Buffer.from(fresh))).toBe(true);
    expect(details?.idTokenHint).toBe("old.hint.token");

    expect(await updateWebSessionTokens(web(), session.id, { idTokenHint: "new.hint.token" })).toBe(
      true,
    );
    details = await getWebSession(web(), session.id);
    expect(details?.refreshTokenEncrypted?.equals(Buffer.from(fresh))).toBe(true);
    expect(details?.idTokenHint).toBe("new.hint.token");

    expect(await updateWebSessionTokens(web(), session.id, {})).toBe(true);
    expect((await getWebSession(web(), session.id))?.idTokenHint).toBe("new.hint.token");
  });

  it("does not revive or change a dead or unknown session", async () => {
    const session = await start({ refresh: Buffer.from("ciphertext") });
    await age(session.id, ABSOLUTE + 1);
    expect(
      await updateWebSessionTokens(web(), session.id, { refreshTokenEncrypted: randomBytes(10) }),
    ).toBe(false);
    const { rows } = await db.admin.query<{ refresh_token_encrypted: Buffer }>(
      "SELECT refresh_token_encrypted FROM ytw_private.web_sessions WHERE id = $1",
      [session.id],
    );
    expect(rows[0]?.refresh_token_encrypted.toString()).toBe("ciphertext");
    expect(
      await updateWebSessionTokens(web(), "00000000-0000-4000-8000-000000000024", {
        idTokenHint: "x",
      }),
    ).toBe(false);
  });

  it("refuses blobs and hints the table cannot hold", async () => {
    const session = await start();
    const empty = await failure(
      updateWebSessionTokens(web(), session.id, { refreshTokenEncrypted: new Uint8Array(0) }),
    );
    expect(empty).toBeInstanceOf(ValidationError);
    const big = await failure(
      updateWebSessionTokens(web(), session.id, { idTokenHint: "h".repeat(16_385) }),
    );
    expect(big).toBeInstanceOf(ValidationError);
  });
});

describe("delete_web_session", () => {
  it("ends a session: gone for get and touch, true once and false after", async () => {
    const session = await start();
    expect(await deleteWebSession(web(), session.id)).toBe(true);
    expect(await getWebSession(web(), session.id)).toBeNull();
    expect(await touchWebSession(web(), session.id, IDLE)).toBeNull();
    expect(await deleteWebSession(web(), session.id)).toBe(false);
    expect(await deleteWebSession(web(), "00000000-0000-4000-8000-000000000025")).toBe(false);
  });

  it("only removes the session asked for", async () => {
    const keep = await start();
    const drop = await start();
    await deleteWebSession(web(), drop.id);
    expect((await getWebSession(web(), keep.id))?.status).toBe("active");
  });
});

describe("purge_expired_web_sessions", () => {
  it("deletes sessions past their idle or absolute expiry and keeps live ones", async () => {
    const own = await createTestDb();
    try {
      const user = await login(own, "purger");
      const make = (idle: number, absolute: number) =>
        createWebSession(own.pool("ytw_web"), {
          userId: user.id,
          idleTimeoutSeconds: idle,
          absoluteTimeoutSeconds: absolute,
        });
      const shift = (id: string, seconds: number) =>
        own.admin.query(
          `UPDATE ytw_private.web_sessions
              SET created_at = created_at - make_interval(secs => $2),
                  last_seen_at = last_seen_at - make_interval(secs => $2),
                  expires_at = expires_at - make_interval(secs => $2),
                  absolute_expires_at = absolute_expires_at - make_interval(secs => $2)
            WHERE id = $1`,
          [id, seconds],
        );

      const alive = await make(3600, 7200);
      const stillAlive = await make(3600, 7200);
      await shift(stillAlive.id, 3000);
      const idleDead = await make(3600, 7200);
      await shift(idleDead.id, 3700);
      const absoluteDead = await make(3600, 7200);
      await shift(absoluteDead.id, 7300);
      const bothDead = await make(60, 60);
      await shift(bothDead.id, 120);

      expect(await purgeExpiredWebSessions(own.pool("ytw_web"))).toBe(3);
      const { rows } = await own.admin.query<{ id: string }>(
        "SELECT id FROM ytw_private.web_sessions ORDER BY id",
      );
      expect(rows.map((row) => row.id).toSorted()).toEqual([alive.id, stillAlive.id].toSorted());
      expect(await purgeExpiredWebSessions(own.pool("ytw_web"))).toBe(0);
    } finally {
      await own.drop();
    }
  });
});

describe("audit", () => {
  it("sessions write no events at all and their ids appear in none", async () => {
    const before = await eventCount(db);
    const session = await start();
    await touchWebSession(web(), session.id, IDLE);
    await getWebSession(web(), session.id);
    await updateWebSessionTokens(web(), session.id, { idTokenHint: "x.y.z" });
    const second = await start();
    await deleteWebSession(web(), second.id);
    await purgeExpiredWebSessions(web());
    expect(await eventCount(db)).toBe(before);

    const { rows } = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events
        WHERE entity_id = ANY ($1::uuid[]) OR payload::text LIKE '%' || $2 || '%'`,
      [[session.id, second.id], session.id],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("the table has no audit trigger (a session id must never reach events)", async () => {
    const { rows } = await db.admin.query(
      `SELECT 1 FROM pg_trigger WHERE tgrelid = 'ytw_private.web_sessions'::regclass AND NOT tgisinternal`,
    );
    expect(rows).toHaveLength(0);
  });
});
