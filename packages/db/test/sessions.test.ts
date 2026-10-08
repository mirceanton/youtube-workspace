import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "../src/errors.js";
import { setUserAccessRevoked } from "../src/permissions.js";
import {
  createWebSession,
  deleteWebSession,
  getWebSession,
  purgeExpiredWebSessions,
  touchWebSession,
  updateWebSessionTokens,
} from "../src/sessions.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { actAs, alice, failure, signIn } from "./helpers.js";

let db: TestDb;
let user: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  db = await createTestDb();
  user = await signIn(db, "alice");
});

afterAll(async () => {
  await db.drop();
});

const create = () =>
  createWebSession(db.pool, {
    userId: user.id,
    refreshTokenEncrypted: Buffer.from("ciphertext"),
    idTokenHint: "id-token",
    idleTimeoutSeconds: 3600,
    absoluteTimeoutSeconds: 86_400,
  });

describe("web sessions", () => {
  it("live from sign-in to logout and die with either expiry", async () => {
    const session = await create();
    expect(session).toMatchObject({ userId: user.id, status: "active" });
    expect((await getWebSession(db.pool, session.id))?.refreshTokenEncrypted?.toString()).toBe(
      "ciphertext",
    );

    const touched = await touchWebSession(db.pool, session.id, 7200);
    expect(touched?.expiresAt.getTime()).toBeGreaterThan(session.expiresAt.getTime());
    expect(await updateWebSessionTokens(db.pool, session.id, { idTokenHint: "newer" })).toBe(true);
    expect((await getWebSession(db.pool, session.id))?.idTokenHint).toBe("newer");

    await db.pool.query(
      `UPDATE ytw_private.web_sessions SET expires_at = now() - interval '1 second'
        WHERE id_hash = sha256(uuid_send($1::uuid))`,
      [session.id],
    );
    expect(await touchWebSession(db.pool, session.id, 3600)).toBeNull();
    expect(await updateWebSessionTokens(db.pool, session.id, { idTokenHint: "x" })).toBe(false);
    expect(await getWebSession(db.pool, session.id)).toMatchObject({
      status: "idle_expired",
      refreshTokenEncrypted: null,
    });
    expect(await purgeExpiredWebSessions(db.pool)).toBe(1);
    expect(await getWebSession(db.pool, session.id)).toBeNull();

    const other = await create();
    expect(await deleteWebSession(db.pool, other.id)).toBe(true);
    expect(await deleteWebSession(db.pool, other.id)).toBe(false);
  });

  it("keep only a hash of the session id, in the table and everywhere else", async () => {
    const session = await create();
    const { rows } = await db.pool.query<{ id_hash: Buffer }>(
      "SELECT id_hash FROM ytw_private.web_sessions",
    );
    const expected = createHash("sha256").update(
      Buffer.from(session.id.replaceAll("-", ""), "hex"),
    );
    expect(rows.map((row) => row.id_hash.toString("hex"))).toContain(expected.digest("hex"));

    const raw = [session.id, session.id.replaceAll("-", "")];
    const dump = await db.pool.query<{ text: string }>(
      `SELECT s::text AS text FROM ytw_private.web_sessions s
       UNION ALL SELECT payload::text FROM events
       UNION ALL SELECT row_to_json(e)::text FROM events e`,
    );
    expect(dump.rows.some((row) => raw.some((id) => row.text.includes(id)))).toBe(false);
  });

  it("are not started for a person whose access is revoked", async () => {
    const bob = await signIn(db, "bob");
    await actAs(db, alice, (tx) =>
      setUserAccessRevoked(tx, { actingUserId: user.id, userId: bob.id, revoked: true }),
    );
    const refused = await failure(
      createWebSession(db.pool, {
        userId: bob.id,
        idleTimeoutSeconds: 60,
        absoluteTimeoutSeconds: 60,
      }),
    );
    expect(refused).toBeInstanceOf(ForbiddenError);
  });
});
