import { createIdea, saveScriptVersion, withActor, type Actor } from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dbBackedFeatureCore,
  type FeatureTestCore,
  type FeatureTestUser,
} from "../../../test/helpers/db-backed-feature-core.js";
import { grantFeatureLevels, signInFeatureUser } from "../../../test/helpers/feature-users.js";
import searchRoutes from "./index.js";

const acting = (username: string): Actor => ({ name: username, type: "human" });

describe("/api/search (PostgreSQL integration)", () => {
  let db: TestDb;
  let app: FeatureTestCore;
  let owner: FeatureTestUser;
  let ideasOnly: FeatureTestUser;
  let scriptsOnly: FeatureTestUser;
  let activityOnly: FeatureTestUser;
  let none: FeatureTestUser;
  let ideaId: string;

  beforeAll(async () => {
    db = await createTestDb();
    owner = await signInFeatureUser(db, "t47-search-owner");
    ideasOnly = await signInFeatureUser(db, "t47-search-ideas");
    scriptsOnly = await signInFeatureUser(db, "t47-search-scripts");
    activityOnly = await signInFeatureUser(db, "t47-search-activity");
    none = await signInFeatureUser(db, "t47-search-none");
    await grantFeatureLevels(db, owner, ideasOnly, { ideas: "read" });
    await grantFeatureLevels(db, owner, scriptsOnly, { scripts: "read" });
    await grantFeatureLevels(db, owner, activityOnly, { activity: "read" });

    const idea = await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
      createIdea(tx, {
        title: "Nebula pane optimization",
        pitch: "A documentary about making the night sky clearer.",
      }),
    );
    ideaId = idea.id;
    await withActor(db.pool("ytw_web"), acting(owner.username), (tx) =>
      saveScriptVersion(tx, {
        ideaId,
        kind: "script",
        baseVersion: 0,
        bodyMd: "A story about the aurora over a quiet mountain.",
      }),
    );

    app = dbBackedFeatureCore(db, [owner, ideasOnly, scriptsOnly, activityOnly, none]);
    await app.register(searchRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("filters search results by each user's current readable resources", async () => {
    const ideaResults = await app.inject({
      method: "GET",
      url: "/api/search?q=Nebula",
      headers: { "x-test-user": ideasOnly.username },
    });
    expect(ideaResults.statusCode).toBe(200);
    expect(
      ideaResults.json().results.map((result: { entity_type: string }) => result.entity_type),
    ).toEqual(["idea"]);
    expect(ideaResults.json().results[0].title).toBe("Nebula pane optimization");

    const scriptResults = await app.inject({
      method: "GET",
      url: "/api/search?q=aurora",
      headers: { "x-test-user": scriptsOnly.username },
    });
    expect(scriptResults.statusCode).toBe(200);
    expect(scriptResults.json().results).toHaveLength(1);
    expect(scriptResults.json().results[0]).toMatchObject({
      entity_type: "script",
      idea_id: ideaId,
      title: null,
    });
  });

  it("requires a readable workspace resource and validates limits", async () => {
    expect((await app.inject({ method: "GET", url: "/api/search?q=nebula" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/search?q=nebula",
          headers: { "x-test-user": none.username },
        })
      ).statusCode,
    ).toBe(403);
    const unrelatedRead = await app.inject({
      method: "GET",
      url: "/api/search?q=nebula",
      headers: { "x-test-user": activityOnly.username },
    });
    expect(unrelatedRead.statusCode).toBe(403);
    const invalid = await app.inject({
      method: "GET",
      url: "/api/search?q=nebula&limit=999",
      headers: { "x-test-user": ideasOnly.username },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
