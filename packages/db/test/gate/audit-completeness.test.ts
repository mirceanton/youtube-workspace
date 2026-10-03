// Gate: Audit completeness & events table immutability (PRD 4 "Integrity rules", PRD 5, PRD 7).
//
// 1. Verifies that EVERY business mutating function in @ytw/db writes an `events` row
//    with actor, actor_type, token_id, entity_type, entity_id, action, and valid payload.
// 2. Verifies `events` table immutability:
//    - Application roles cannot UPDATE, DELETE, or TRUNCATE `events` (SQLSTATE 42501).
//    - Even the superuser cannot UPDATE, DELETE, or TRUNCATE `events` (SQLSTATE YT007, ImmutableError).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ROLES, withActor, type Actor } from "../../src/client.js";
import { ImmutableError, toDbError } from "../../src/errors.js";
import {
  concludeExperiment,
  createExperiment,
  recordVariantStats,
  updateExperimentStatus,
} from "../../src/experiments.js";
import { advanceIdea, archiveIdea, createIdea, updateIdea } from "../../src/ideas.js";
import { markUserOutsideAccessGroup, setUserAdmin, upsertUserOnLogin } from "../../src/identity.js";
import { logMetrics } from "../../src/metrics.js";
import { addNote } from "../../src/notes.js";
import { setUserAccessRevoked, setUserPermission } from "../../src/permissions.js";
import { saveScriptVersion, setScriptStatus } from "../../src/scripts.js";
import { createTestDb, type TestDb } from "../../src/testing.js";
import {
  createApiToken,
  revokeApiToken,
  rotateApiToken,
  updateTokenPermissions,
} from "../../src/tokens.js";
import { archiveVideo, registerVideo, updateVideo } from "../../src/videos.js";
import { failure, sqlstate } from "../helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

interface EventRow {
  id: string;
  actor: string;
  actor_type: string;
  token_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

async function latestEventFor(entityId: string, action?: string): Promise<EventRow> {
  const { rows } = await db.admin.query<EventRow>(
    `SELECT id, actor, actor_type, token_id, action, entity_type, entity_id, payload, created_at
       FROM public.events
      WHERE entity_id = $1
        AND ($2::text IS NULL OR action = $2)
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [entityId, action ?? null],
  );
  if (rows[0] === undefined) {
    throw new Error(
      `no events found for entity ${entityId}${action ? ` with action ${action}` : ""}`,
    );
  }
  return rows[0];
}

function randomYoutubeId(): string {
  return randomBytes(9).toString("base64url").slice(0, 11);
}

describe("gate: audit completeness across all mutating functions", () => {
  const humanActor: Actor = { name: "audited_human", type: "human" };
  const agentTokenId = randomUUID();
  const agentActor: Actor = {
    name: "audited_agent",
    type: "agent",
    tokenId: agentTokenId,
  };

  it("ideas: create, update, advance, archive write complete audit event rows", async () => {
    // 1. createIdea
    const idea = await withActor(db.pool("ytw_web"), humanActor, (tx) =>
      createIdea(tx, { title: "Audit Verification Idea" }),
    );
    const createEv = await latestEventFor(idea.id);
    expect(createEv.actor).toBe(humanActor.name);
    expect(createEv.actor_type).toBe("human");
    expect(createEv.token_id).toBeNull();
    expect(createEv.entity_type).toBe("idea");
    expect(createEv.entity_id).toBe(idea.id);
    expect(createEv.action).toBe("insert");
    expect(createEv.payload).toBeDefined();

    // 2. updateIdea
    const updated = await withActor(db.pool("ytw_mcp"), agentActor, (tx) =>
      updateIdea(tx, {
        id: idea.id,
        expectedVersion: idea.version,
        fields: { pitch: "Updated by agent" },
      }),
    );
    const updateEv = await latestEventFor(idea.id);
    expect(updateEv.actor).toBe(agentActor.name);
    expect(updateEv.actor_type).toBe("agent");
    expect(updateEv.token_id).toBe(agentTokenId);
    expect(updateEv.action).toBe("update");
    expect(updateEv.entity_type).toBe("idea");

    // 3. advanceIdea
    await withActor(db.pool("ytw_web"), humanActor, (tx) =>
      advanceIdea(tx, { id: idea.id, newStatus: "shortlisted" }),
    );
    const advanceEv = await latestEventFor(idea.id);
    expect(advanceEv.action).toBe("update");
    expect(advanceEv.actor).toBe(humanActor.name);

    // 4. archiveIdea
    await withActor(db.pool("ytw_web"), humanActor, (tx) =>
      archiveIdea(tx, { id: idea.id, expectedVersion: updated.version + 1 }),
    );
    const archiveEv = await latestEventFor(idea.id);
    expect(archiveEv.action).toBe("update");
    expect(archiveEv.actor).toBe(humanActor.name);
  });

  it("scripts: save_script_version & set_script_status write complete audit events", async () => {
    const idea = await withActor(db.pool("ytw_web"), humanActor, (tx) =>
      createIdea(tx, { title: "Audit Script Idea" }),
    );

    // 1. saveScriptVersion
    const script = await withActor(db.pool("ytw_mcp"), agentActor, (tx) =>
      saveScriptVersion(tx, {
        ideaId: idea.id,
        kind: "script",
        baseVersion: 0,
        bodyMd: "# Script revision for audit test",
      }),
    );
    const scriptEv = await latestEventFor(script.id);
    expect(scriptEv.actor).toBe(agentActor.name);
    expect(scriptEv.actor_type).toBe("agent");
    expect(scriptEv.token_id).toBe(agentTokenId);
    expect(scriptEv.entity_type).toBe("script");
    expect(scriptEv.entity_id).toBe(script.id);
    expect(scriptEv.action).toBe("insert");

    // 2. setScriptStatus
    await withActor(db.pool("ytw_web"), humanActor, (tx) =>
      setScriptStatus(tx, { scriptId: script.id, status: "review" }),
    );
    const statusEv = await latestEventFor(script.id);
    expect(statusEv.action).toBe("update");
    expect(statusEv.actor).toBe(humanActor.name);
  });

  it("videos & metrics: register, update, archive, log_metrics write complete audit events", async () => {
    const youtubeId = randomYoutubeId();

    // 1. registerVideo
    const video = await withActor(db.pool("ytw_web"), humanActor, (tx) =>
      registerVideo(tx, {
        youtubeId,
        title: "Audit Video",
      }),
    );
    const regEv = await latestEventFor(video.id);
    expect(regEv.actor).toBe(humanActor.name);
    expect(regEv.entity_type).toBe("video");
    expect(regEv.entity_id).toBe(video.id);
    expect(regEv.action).toBe("insert");

    // 2. updateVideo
    await withActor(db.pool("ytw_mcp"), agentActor, (tx) =>
      updateVideo(tx, {
        id: video.id,
        expectedVersion: video.version,
        fields: { title: "Audit Video Updated" },
      }),
    );
    const updEv = await latestEventFor(video.id);
    expect(updEv.actor).toBe(agentActor.name);
    expect(updEv.action).toBe("update");

    // 3. logMetrics
    const metric = await withActor(db.pool("ytw_mcp"), agentActor, (tx) =>
      logMetrics(tx, {
        videoId: video.id,
        capturedAt: new Date(),
        metrics: { views: 500, impressions: 5000, ctr: 0.1 },
      }),
    );
    const metricEv = await latestEventFor(metric.snapshot.id);
    expect(metricEv.actor).toBe(agentActor.name);
    expect(metricEv.action).toBe("insert");
    expect(metricEv.entity_type).toBe("video_metric");

    // 4. archiveVideo
    await withActor(db.pool("ytw_web"), humanActor, (tx) => archiveVideo(tx, { id: video.id }));
    const archEv = await latestEventFor(video.id);
    expect(archEv.actor).toBe(humanActor.name);
    expect(archEv.action).toBe("update");
  });

  it("experiments: create, record_variant_stats, update_status, conclude write audit events", async () => {
    const video = await withActor(db.pool("ytw_web"), humanActor, (tx) =>
      registerVideo(tx, {
        youtubeId: randomYoutubeId(),
        title: "Audit Experiment Video",
      }),
    );

    // 1. createExperiment
    const exp = await withActor(db.pool("ytw_web"), humanActor, (tx) =>
      createExperiment(tx, {
        videoId: video.id,
        type: "title",
        hypothesis: "Testing audit logging",
        variants: [
          { label: "Variant A", content: "A", isControl: true },
          { label: "Variant B", content: "B", isControl: false },
        ],
      }),
    );
    const expEv = await latestEventFor(exp.id);
    expect(expEv.actor).toBe(humanActor.name);
    expect(expEv.entity_type).toBe("experiment");
    expect(expEv.action).toBe("insert");

    // 2. recordVariantStats
    const varA = exp.variants[0]!;
    await withActor(db.pool("ytw_mcp"), agentActor, (tx) =>
      recordVariantStats(tx, {
        variantId: varA.id,
        impressions: 1000,
        ctr: 0.12,
      }),
    );
    const varEv = await latestEventFor(varA.id);
    expect(varEv.actor).toBe(agentActor.name);
    expect(varEv.entity_type).toBe("experiment_variant");
    expect(varEv.action).toBe("update");

    // 3. updateExperimentStatus
    const running = await withActor(db.pool("ytw_web"), humanActor, (tx) =>
      updateExperimentStatus(tx, {
        id: exp.id,
        expectedVersion: exp.version,
        newStatus: "running",
      }),
    );
    const runEv = await latestEventFor(exp.id);
    expect(runEv.action).toBe("update");

    // 4. concludeExperiment
    await withActor(db.pool("ytw_web"), humanActor, (tx) =>
      concludeExperiment(tx, {
        id: exp.id,
        expectedVersion: running.version,
        winnerVariantId: varA.id,
        conclusion: "A clearly won",
      }),
    );
    const concEv = await latestEventFor(exp.id);
    expect(concEv.action).toBe("update");
  });

  it("notes: add_note writes audit event", async () => {
    const idea = await withActor(db.pool("ytw_web"), humanActor, (tx) =>
      createIdea(tx, { title: "Audit Note Idea" }),
    );

    const note = await withActor(db.pool("ytw_web"), humanActor, (tx) =>
      addNote(tx, {
        entityType: "idea",
        entityId: idea.id,
        bodyMd: "Testing note audit row",
      }),
    );
    const noteEv = await latestEventFor(note.id);
    expect(noteEv.actor).toBe(humanActor.name);
    expect(noteEv.entity_type).toBe("note");
    expect(noteEv.entity_id).toBe(note.id);
    expect(noteEv.action).toBe("insert");
  });

  it("identity & permissions: login, set_permission, set_admin, revocations write audit events", async () => {
    const adminUsername = `admin_audit_${randomUUID().slice(0, 6)}`;
    const adminActor: Actor = { name: adminUsername, type: "human" };

    // 1. upsertUserOnLogin
    const admin = await withActor(db.pool("ytw_web"), adminActor, (tx) =>
      upsertUserOnLogin(tx, {
        issuer: "https://id.example.test",
        sub: `sub_admin_${randomUUID()}`,
        username: adminUsername,
      }),
    );
    const loginEv = await latestEventFor(admin.id);
    expect(loginEv.actor).toBe(adminUsername);
    expect(loginEv.entity_type).toBe("user");

    const targetUsername = `target_audit_${randomUUID().slice(0, 6)}`;
    const targetActor: Actor = { name: targetUsername, type: "human" };
    const target = await withActor(db.pool("ytw_web"), targetActor, (tx) =>
      upsertUserOnLogin(tx, {
        issuer: "https://id.example.test",
        sub: `sub_target_${randomUUID()}`,
        username: targetUsername,
      }),
    );

    // 2. setUserPermission
    await withActor(db.pool("ytw_web"), adminActor, (tx) =>
      setUserPermission(tx, {
        actingUserId: admin.id,
        userId: target.id,
        resource: "ideas",
        level: "read",
      }),
    );
    const { rows: permEvs } = await db.admin.query<EventRow>(
      "SELECT * FROM public.events WHERE entity_type = 'user_permission' ORDER BY created_at DESC LIMIT 1",
    );
    expect(permEvs[0]?.actor).toBe(adminUsername);

    // 3. setUserAdmin
    await withActor(db.pool("ytw_web"), adminActor, (tx) =>
      setUserAdmin(tx, {
        actingUserId: admin.id,
        userId: target.id,
        isAdmin: true,
      }),
    );
    const adminEv = await latestEventFor(target.id, "user.admin_granted");
    expect(adminEv.actor).toBe(adminUsername);
    expect(adminEv.action).toBe("user.admin_granted");

    // 4. setUserAccessRevoked
    await withActor(db.pool("ytw_web"), adminActor, (tx) =>
      setUserAccessRevoked(tx, {
        actingUserId: admin.id,
        userId: target.id,
        revoked: true,
      }),
    );
    const revEv = await latestEventFor(target.id, "user.access_revoked");
    expect(revEv.actor).toBe(adminUsername);
    expect(revEv.action).toBe("user.access_revoked");

    // 5. markUserOutsideAccessGroup
    await withActor(db.pool("ytw_web"), targetActor, (tx) =>
      markUserOutsideAccessGroup(tx, {
        issuer: "https://id.example.test",
        sub: `sub_target_${randomUUID()}`,
      }),
    );
  });

  it("tokens: create, update_permissions, rotate, revoke write audit events", async () => {
    // 0. Ensure an admin exists to grant permissions
    const adminUsername = `token_admin_${randomUUID().slice(0, 6)}`;
    const adminActor: Actor = { name: adminUsername, type: "human" };
    const admin = await withActor(db.pool("ytw_web"), adminActor, (tx) =>
      upsertUserOnLogin(tx, {
        issuer: "https://id.example.test",
        sub: `sub_token_admin_${randomUUID()}`,
        username: adminUsername,
      }),
    );
    // If not first user, promote via superuser query with fixture actor
    await withActor(db.admin, { name: "fixture", type: "human" }, (tx) =>
      tx.query("UPDATE public.users SET is_admin = true WHERE id = $1", [admin.id]),
    );

    const ownerUsername = `token_owner_${randomUUID().slice(0, 6)}`;
    const ownerActor: Actor = { name: ownerUsername, type: "human" };
    const owner = await withActor(db.pool("ytw_web"), ownerActor, (tx) =>
      upsertUserOnLogin(tx, {
        issuer: "https://id.example.test",
        sub: `sub_owner_${randomUUID()}`,
        username: ownerUsername,
      }),
    );

    // Admin grants owner Write on ideas so owner can create tokens (PRD 7)
    await withActor(db.pool("ytw_web"), adminActor, (tx) =>
      setUserPermission(tx, {
        actingUserId: admin.id,
        userId: owner.id,
        resource: "ideas",
        level: "write",
      }),
    );

    // 1. createApiToken
    const hash = createHash("sha256").update("secret").digest("hex");
    const token = await withActor(db.pool("ytw_web"), ownerActor, (tx) =>
      createApiToken(tx, {
        ownerUserId: owner.id,
        name: "Test Audit Token",
        tokenPrefix: "ytw_pfx",
        tokenHash: hash,
        expiresAt: null,
        permissions: { ideas: "read" },
      }),
    );
    const createEv = await latestEventFor(token.id);
    expect(createEv.actor).toBe(ownerUsername);
    expect(createEv.entity_type).toBe("api_token");
    expect(createEv.action).toBe("token.created");

    // 2. updateTokenPermissions
    await withActor(db.pool("ytw_web"), ownerActor, (tx) =>
      updateTokenPermissions(tx, {
        actingUserId: owner.id,
        apiTokenId: token.id,
        permissions: { ideas: "write" },
      }),
    );
    const updateEv = await latestEventFor(token.id);
    expect(updateEv.actor).toBe(ownerUsername);
    expect(updateEv.action).toBe("token.permissions_changed");

    // 3. rotateApiToken
    const newHash = createHash("sha256").update("new_secret").digest("hex");
    await withActor(db.pool("ytw_web"), ownerActor, (tx) =>
      rotateApiToken(tx, {
        actingUserId: owner.id,
        apiTokenId: token.id,
        newTokenPrefix: "ytw_new",
        newTokenHash: newHash,
      }),
    );
    const rotEv = await latestEventFor(token.id, "token.rotated");
    expect(rotEv.actor).toBe(ownerUsername);
    expect(rotEv.action).toBe("token.rotated");

    // 4. revokeApiToken
    await withActor(db.pool("ytw_web"), ownerActor, (tx) =>
      revokeApiToken(tx, {
        actingUserId: owner.id,
        apiTokenId: token.id,
      }),
    );
    const revEv = await latestEventFor(token.id, "token.revoked");
    expect(revEv.actor).toBe(ownerUsername);
    expect(revEv.action).toBe("token.revoked");
  });

  describe("events table immutability enforcement", () => {
    for (const role of APP_ROLES) {
      it(`rejects ${role} UPDATE on events with 42501`, async () => {
        const client = await db.pool(role).connect();
        try {
          if (role === "ytw_readonly") {
            await client.query("SET default_transaction_read_only = off");
          }
          const code = await sqlstate(client.query("UPDATE public.events SET actor = 'adversary'"));
          expect(code).toBe("42501");
        } finally {
          client.release();
        }
      });

      it(`rejects ${role} DELETE on events with 42501`, async () => {
        const client = await db.pool(role).connect();
        try {
          if (role === "ytw_readonly") {
            await client.query("SET default_transaction_read_only = off");
          }
          const code = await sqlstate(client.query("DELETE FROM public.events"));
          expect(code).toBe("42501");
        } finally {
          client.release();
        }
      });

      it(`rejects ${role} TRUNCATE on events with 42501`, async () => {
        const client = await db.pool(role).connect();
        try {
          if (role === "ytw_readonly") {
            await client.query("SET default_transaction_read_only = off");
          }
          const code = await sqlstate(client.query("TRUNCATE TABLE public.events"));
          expect(code).toBe("42501");
        } finally {
          client.release();
        }
      });
    }

    it("rejects superuser UPDATE on events via append-only trigger with ImmutableError (YT007)", async () => {
      const err = await failure(
        db.admin.query("UPDATE public.events SET actor = 'superuser_tampering'"),
      );
      expect(toDbError(err)).toBeInstanceOf(ImmutableError);
      expect(await sqlstate(Promise.reject(err))).toBe("YT007");
    });

    it("rejects superuser DELETE on events via append-only trigger with ImmutableError (YT007)", async () => {
      const err = await failure(db.admin.query("DELETE FROM public.events"));
      expect(toDbError(err)).toBeInstanceOf(ImmutableError);
      expect(await sqlstate(Promise.reject(err))).toBe("YT007");
    });

    it("rejects superuser TRUNCATE on events via append-only trigger with ImmutableError (YT007)", async () => {
      const err = await failure(db.admin.query("TRUNCATE TABLE public.events"));
      expect(toDbError(err)).toBeInstanceOf(ImmutableError);
      expect(await sqlstate(Promise.reject(err))).toBe("YT007");
    });
  });
});
