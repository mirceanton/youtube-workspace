// Helpers shared by the @ytw/db tests (not a test file itself).
import { createHash, randomBytes } from "node:crypto";
import { withActor, type Actor, type ActorTx } from "../src/client.js";
import { upsertUserOnLogin, type LoginResult } from "../src/identity.js";
import type { TestDb } from "../src/testing.js";
import { createApiToken } from "../src/tokens.js";

export const alice: Actor = { name: "alice", type: "human" };

/** Runs `promise`, expects it to fail, and returns the error. */
export async function failure(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) {
      return err;
    }
    throw new Error(`rejected with a non-Error: ${String(err)}`, { cause: err });
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** Runs `fn` in a transaction whose audit actor is `actor`. */
export function actAs<T>(db: TestDb, actor: Actor, fn: (tx: ActorTx) => Promise<T>): Promise<T> {
  return withActor(db.pool, actor, fn);
}

/** Signs a person in (the first one ever becomes admin); the same name is the same account. */
export function signIn(db: TestDb, username: string): Promise<LoginResult> {
  return actAs(db, { name: username, type: "human" }, (tx) =>
    upsertUserOnLogin(tx, { issuer: "https://id.example.test", sub: `sub-${username}`, username }),
  );
}

/** A random token secret's SHA-256 and prefix, the way the server derives them. */
export function newSecret(): { hash: string; prefix: string } {
  const secret = `ytw_${randomBytes(32).toString("base64url")}`;
  return { hash: createHash("sha256").update(secret).digest("hex"), prefix: secret.slice(0, 12) };
}

/** An agent acting through a real API token owned by `ownerUserId`. */
export async function newAgent(db: TestDb, ownerUserId: string, owner: Actor): Promise<Actor> {
  const secret = newSecret();
  const token = await actAs(db, owner, (tx) =>
    createApiToken(tx, {
      ownerUserId,
      name: `agent-${randomBytes(3).toString("hex")}`,
      tokenPrefix: secret.prefix,
      tokenHash: secret.hash,
      expiresAt: null,
      permissions: {
        ideas: "write",
        scripts: "write",
        experiments: "write",
        videos: "write",
        notes: "write",
      },
    }),
  );
  return { name: token.name, type: "agent", tokenId: token.id };
}
