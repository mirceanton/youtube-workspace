// Fixtures shared by the T14 tests (identity, permissions, tokens, sessions). Not a test file.
// Everything goes through the real wrappers as the real application roles; the superuser pool
// (db.admin) is used only to look at tables and to move stored timestamps (to simulate time passing).
import { createHash, randomBytes } from "node:crypto";
import { LEVELS, RESOURCES, type Level, type Resource } from "@ytw/shared/constants";
import { withActor, type Actor } from "../src/client.js";
import { setUserAdmin, upsertUserOnLogin, type LoginResult } from "../src/identity.js";
import { setUserPermission } from "../src/permissions.js";
import { createApiToken, type ApiTokenInfo } from "../src/tokens.js";
import type { TestDb } from "../src/testing.js";

export const ISSUER = "https://id.example.test/realms/youtube-workspace";

/** A person acting through the web app. */
export const person = (username: string): Actor => ({ name: username, type: "human" });

let counter = 0;
/** A short unique suffix, so fixtures never collide inside one test database. */
export const unique = (): string => `${Date.now().toString(36)}${(counter += 1).toString(36)}`;

export interface TestUser {
  id: string;
  username: string;
}

/** Signs a person in through the web role, exactly as T40 will. */
export async function login(
  db: TestDb,
  username: string,
  extra: { sub?: string; issuer?: string; email?: string | null; displayName?: string | null } = {},
): Promise<LoginResult> {
  return withActor(db.pool("ytw_web"), person(username), (tx) =>
    upsertUserOnLogin(tx, {
      issuer: extra.issuer ?? ISSUER,
      sub: extra.sub ?? `sub-${username}`,
      username,
      email: extra.email === undefined ? `${username}@example.test` : extra.email,
      displayName: extra.displayName === undefined ? username : extra.displayName,
    }),
  );
}

/** Sets the given levels for `user`, as `admin`. */
export async function grant(
  db: TestDb,
  admin: TestUser,
  user: TestUser,
  levels: Partial<Record<Resource, Level>>,
): Promise<void> {
  for (const [resource, level] of Object.entries(levels) as [Resource, Level][]) {
    await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
      setUserPermission(tx, { actingUserId: admin.id, userId: user.id, resource, level }),
    );
  }
}

export async function promote(db: TestDb, admin: TestUser, user: TestUser): Promise<void> {
  await withActor(db.pool("ytw_web"), person(admin.username), (tx) =>
    setUserAdmin(tx, { actingUserId: admin.id, userId: user.id, isAdmin: true }),
  );
}

/** Every object at `level`, capped (the activity log never write). */
export function everywhere(level: Level): Record<Resource, Level> {
  return Object.fromEntries(
    RESOURCES.map((resource) => [
      resource,
      resource === "activity" && level === "write" ? "read" : level,
    ]),
  ) as Record<Resource, Level>;
}

/** A fresh secret as T21 will make it, with the prefix and SHA-256 hash the database stores. */
export function newSecret(): { secret: string; prefix: string; hash: string } {
  const secret = `ytw_${randomBytes(32).toString("base64url")}`;
  return {
    secret,
    prefix: secret.slice(0, 12),
    hash: createHash("sha256").update(secret).digest("hex"),
  };
}

export interface MadeToken {
  token: ApiTokenInfo;
  secret: string;
  prefix: string;
  hash: string;
}

/** Creates a token for `owner` (acting as the owner). */
export async function makeToken(
  db: TestDb,
  owner: TestUser,
  options: {
    name?: string;
    permissions?: Partial<Record<Resource, Level>>;
    expiresAt?: Date | null;
  } = {},
): Promise<MadeToken> {
  const made = newSecret();
  const token = await withActor(db.pool("ytw_web"), person(owner.username), (tx) =>
    createApiToken(tx, {
      ownerUserId: owner.id,
      name: options.name ?? `agent-${unique()}`,
      tokenPrefix: made.prefix,
      tokenHash: made.hash,
      expiresAt: options.expiresAt === undefined ? null : options.expiresAt,
      permissions: options.permissions ?? {},
    }),
  );
  return { token, ...made };
}

export interface EventRow {
  actor: string;
  actor_type: string;
  token_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown>;
}

/** Audit events of one entity, oldest first (ids are time-ordered; ties inside a millisecond are rare). */
export async function eventsFor(db: TestDb, entityId: string): Promise<EventRow[]> {
  const { rows } = await db.admin.query<EventRow>(
    `SELECT actor, actor_type, token_id, action, entity_type, entity_id, payload
       FROM events WHERE entity_id = $1 ORDER BY created_at, id`,
    [entityId],
  );
  return rows;
}

export async function eventCount(db: TestDb): Promise<number> {
  const { rows } = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM events");
  return rows[0]?.n ?? -1;
}

/** The database clock now: take it before an action, then read what the action logged with `eventsSince`. */
export async function mark(db: TestDb): Promise<Date> {
  const { rows } = await db.admin.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  return rows[0]?.now ?? new Date();
}

/** Events logged by transactions that started after `since` (see `mark`), oldest first. */
export async function eventsSince(db: TestDb, since: Date): Promise<EventRow[]> {
  const { rows } = await db.admin.query<EventRow>(
    `SELECT actor, actor_type, token_id, action, entity_type, entity_id, payload
       FROM events WHERE created_at > $1 ORDER BY created_at, id`,
    [since],
  );
  return rows;
}

/** The levels in `LEVELS` up to and including `max`. */
export function levelsUpTo(max: Level): Level[] {
  return LEVELS.slice(0, LEVELS.indexOf(max) + 1);
}
