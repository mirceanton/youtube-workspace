import { randomUUID } from "node:crypto";
import { setUserPermission, upsertUserOnLogin, withActor, type Actor } from "@ytw/db";
import type { Level, Resource } from "@ytw/shared/constants";
import type { TestDb } from "@ytw/db/testing";
import type { FeatureTestUser } from "./db-backed-feature-core.js";

const ISSUER = "https://t47-web.test/issuer";

export async function signInFeatureUser(db: TestDb, username: string): Promise<FeatureTestUser> {
  return withActor(db.pool("ytw_web"), { name: username, type: "human" }, async (tx) => {
    const user = await upsertUserOnLogin(tx, {
      issuer: ISSUER,
      sub: `${username}-${randomUUID()}`,
      username,
    });
    return { id: user.id, username: user.username };
  });
}

export async function grantFeatureLevels(
  db: TestDb,
  admin: FeatureTestUser,
  user: FeatureTestUser,
  grants: Partial<Record<Resource, Level>>,
): Promise<void> {
  const actor: Actor = { name: admin.username, type: "human" };
  await withActor(db.pool("ytw_web"), actor, async (tx) => {
    for (const [resource, level] of Object.entries(grants) as [Resource, Level][]) {
      await setUserPermission(tx, {
        actingUserId: admin.id,
        userId: user.id,
        resource,
        level,
      });
    }
  });
}
