// Gate: Concurrency races & optimistic locking hardening (PRD 4 "Integrity rules", PRD 5, PRD 7).
//
// 1. Double-submit races / concurrent optimistic locking on update_idea (1 succeeds, others fail with 409 conflict).
// 2. Concurrent save_script_version with same base_version (1 succeeds, others fail with conflict returning latest_version).
// 3. Concurrent log_metrics idempotency and conflict detection on (video_id, captured_at).
// 4. Concurrent register_video double-submit with same youtube_id (1 succeeds, others fail with duplicate).
// 5. First-user creation race (race to claim first admin: exactly 1 becomes admin with Write on all, remaining get None on all).
// 6. Concurrent experiment conclusion race.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor, type Actor } from "../../src/client.js";
import { DuplicateError, VersionConflictError } from "../../src/errors.js";
import {
  concludeExperiment,
  createExperiment,
  recordVariantStats,
  updateExperimentStatus,
  type ExperimentRecord,
} from "../../src/experiments.js";
import { createIdea, getIdea, updateIdea, type IdeaRecord } from "../../src/ideas.js";
import { upsertUserOnLogin } from "../../src/identity.js";
import { logMetrics } from "../../src/metrics.js";
import { saveScriptVersion, type ScriptRecord } from "../../src/scripts.js";
import { createTestDb, type TestDb } from "../../src/testing.js";
import { registerVideo, type VideoRecord } from "../../src/videos.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

function randomYoutubeId(): string {
  return randomBytes(9).toString("base64url").slice(0, 11);
}

const alice: Actor = { name: "alice", type: "human" };

describe("gate: concurrency races & optimistic locking hardening", () => {
  it("concurrent update_idea double-submit: exactly 1 succeeds, others fail with VersionConflictError (409)", async () => {
    const idea = await withActor(db.pool("ytw_web"), alice, (tx) =>
      createIdea(tx, { title: "Idea for Concurrent Update" }),
    );

    const concurrentCount = 8;
    const promises = Array.from({ length: concurrentCount }, (_, i) =>
      withActor(db.pool("ytw_web"), alice, (tx) =>
        updateIdea(tx, {
          id: idea.id,
          expectedVersion: idea.version,
          fields: { title: `Concurrent Update Title ${i}` },
        }),
      ),
    );

    const results = await Promise.allSettled(promises);
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<IdeaRecord> => r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(concurrentCount - 1);

    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(VersionConflictError);
      expect(r.reason.sqlstate).toBe("YT004");
      expect(r.reason.status).toBe(409);
      expect(r.reason.latestVersion).toBe(idea.version + 1);
    }

    const finalIdea = await getIdea(db.admin, idea.id);
    expect(finalIdea?.version).toBe(idea.version + 1);
  });

  it("concurrent save_script_version double-submit: exactly 1 succeeds, others fail with VersionConflictError returning latestVersion", async () => {
    const idea = await withActor(db.pool("ytw_web"), alice, (tx) =>
      createIdea(tx, { title: "Idea for Concurrent Script Save" }),
    );

    const first = await withActor(db.pool("ytw_web"), alice, (tx) =>
      saveScriptVersion(tx, {
        ideaId: idea.id,
        kind: "script",
        baseVersion: 0,
        bodyMd: "# Initial Script Revision",
      }),
    );
    expect(first.version).toBe(1);

    const concurrentCount = 8;
    const promises = Array.from({ length: concurrentCount }, (_, i) =>
      withActor(db.pool("ytw_web"), alice, (tx) =>
        saveScriptVersion(tx, {
          ideaId: idea.id,
          kind: "script",
          baseVersion: 1, // All attempt to build on version 1 concurrently
          bodyMd: `# Concurrent Revision ${i}`,
        }),
      ),
    );

    const results = await Promise.allSettled(promises);
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<ScriptRecord> => r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(concurrentCount - 1);

    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(VersionConflictError);
      expect(r.reason.sqlstate).toBe("YT004");
      expect(r.reason.status).toBe(409);
      expect(r.reason.latestVersion).toBe(2);
    }

    const { rows } = await db.admin.query<{ count: string }>(
      "SELECT count(*)::text as count FROM public.scripts WHERE idea_id = $1 AND kind = 'script'",
      [idea.id],
    );
    expect(rows[0]?.count).toBe("2"); // Version 1 and Version 2
  });

  it("concurrent register_video double-submit with same youtube_id: exactly 1 succeeds, others fail with DuplicateError", async () => {
    const youtubeId = randomYoutubeId();
    const concurrentCount = 6;

    const promises = Array.from({ length: concurrentCount }, (_, i) =>
      withActor(db.pool("ytw_web"), alice, (tx) =>
        registerVideo(tx, {
          youtubeId,
          title: `Concurrent Video ${i}`,
        }),
      ),
    );

    const results = await Promise.allSettled(promises);
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<VideoRecord> => r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(concurrentCount - 1);

    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(DuplicateError);
      expect(r.reason.sqlstate).toBe("YT006");
    }

    const { rows } = await db.admin.query<{ count: string }>(
      "SELECT count(*)::text as count FROM public.videos WHERE youtube_id = $1",
      [youtubeId],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("concurrent log_metrics idempotency on identical (video_id, captured_at)", async () => {
    const video = await withActor(db.pool("ytw_web"), alice, (tx) =>
      registerVideo(tx, {
        youtubeId: randomYoutubeId(),
        title: "Video for Concurrent Metrics",
      }),
    );

    const capturedAt = new Date("2026-03-01T10:00:00Z");
    const concurrentCount = 6;

    // Concurrent submissions of identical metrics for the same timestamp
    const promises = Array.from({ length: concurrentCount }, () =>
      withActor(db.pool("ytw_web"), alice, (tx) =>
        logMetrics(tx, {
          videoId: video.id,
          capturedAt,
          metrics: {
            views: 1250,
            impressions: 15000,
            ctr: 0.083,
          },
        }),
      ),
    );

    const results = await Promise.allSettled(promises);
    // All should fulfill due to idempotency
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }

    const { rows } = await db.admin.query<{ count: string }>(
      "SELECT count(*)::text as count FROM public.video_metrics WHERE video_id = $1",
      [video.id],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("concurrent first-user creation race: exactly 1 becomes admin, others get None", async () => {
    // Dedicated clean database to test first-user race from zero users
    const freshDb = await createTestDb();
    try {
      const racerCount = 8;
      const racers = Array.from({ length: racerCount }, (_, i) => ({
        username: `racer_${Date.now().toString(36)}_${i}`,
        sub: `sub_racer_${randomUUID()}`,
      }));

      const promises = racers.map((racer) => {
        const actor: Actor = { name: racer.username, type: "human" };
        return withActor(freshDb.pool("ytw_web"), actor, (tx) =>
          upsertUserOnLogin(tx, {
            issuer: "https://id.example.test",
            sub: racer.sub,
            username: racer.username,
          }),
        );
      });

      const results = await Promise.allSettled(promises);
      for (const r of results) {
        expect(r.status).toBe("fulfilled");
      }

      // Check users table in freshDb
      const { rows: adminRows } = await freshDb.admin.query<{ id: string; username: string }>(
        "SELECT id, username FROM public.users WHERE is_admin = true",
      );
      expect(adminRows.length).toBe(1);

      const winningAdminId = adminRows[0]!.id;

      // Verify the winning admin has Write on all resources (except activity which is read)
      const { rows: adminPerms } = await freshDb.admin.query<{ resource: string; level: string }>(
        "SELECT resource, level FROM public.user_permissions WHERE user_id = $1",
        [winningAdminId],
      );
      expect(adminPerms.length).toBeGreaterThan(0);
      for (const row of adminPerms) {
        const expectedLevel = row.resource === "activity" ? "read" : "write";
        expect(row.level).toBe(expectedLevel);
      }

      // Verify all other users have None on all resources
      const { rows: nonAdminRows } = await freshDb.admin.query<{ id: string }>(
        "SELECT id FROM public.users WHERE is_admin = false",
      );
      expect(nonAdminRows.length).toBe(racerCount - 1);

      for (const nonAdmin of nonAdminRows) {
        const { rows: perms } = await freshDb.admin.query<{ resource: string; level: string }>(
          "SELECT resource, level FROM public.user_permissions WHERE user_id = $1",
          [nonAdmin.id],
        );
        expect(perms.length).toBeGreaterThan(0);
        for (const row of perms) {
          expect(row.level).toBe("none");
        }
      }
    } finally {
      await freshDb.drop();
    }
  });

  it("concurrent experiment conclusion: exactly 1 succeeds, others fail with conflict", async () => {
    const video = await withActor(db.pool("ytw_web"), alice, (tx) =>
      registerVideo(tx, {
        youtubeId: randomYoutubeId(),
        title: "Video for Concurrent Experiment",
      }),
    );

    const exp = await withActor(db.pool("ytw_web"), alice, (tx) =>
      createExperiment(tx, {
        videoId: video.id,
        type: "title",
        hypothesis: "Hypothesis test",
        variants: [
          { label: "Variant A", content: "Title A", isControl: true },
          { label: "Variant B", content: "Title B", isControl: false },
        ],
      }),
    );

    // Transition planned -> running
    const running = await withActor(db.pool("ytw_web"), alice, (tx) =>
      updateExperimentStatus(tx, {
        id: exp.id,
        expectedVersion: exp.version,
        newStatus: "running",
      }),
    );

    const concurrentCount = 6;
    const promises = Array.from({ length: concurrentCount }, (_, i) =>
      withActor(db.pool("ytw_web"), alice, (tx) =>
        concludeExperiment(tx, {
          id: exp.id,
          expectedVersion: running.version,
          winnerVariantId: exp.variants[i % 2]!.id,
          conclusion: `Winner variant concluded by racer ${i}`,
        }),
      ),
    );

    const results = await Promise.allSettled(promises);
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<ExperimentRecord> => r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(concurrentCount - 1);

    for (const r of rejected) {
      expect(["VersionConflictError", "InvalidTransitionError"]).toContain(r.reason.name);
    }
  });

  it("concurrent variant stats updates: multiple threads updating stats without deadlocks", async () => {
    const video = await withActor(db.pool("ytw_web"), alice, (tx) =>
      registerVideo(tx, {
        youtubeId: randomYoutubeId(),
        title: "Video for Concurrent Variant Stats",
      }),
    );

    const exp = await withActor(db.pool("ytw_web"), alice, (tx) =>
      createExperiment(tx, {
        videoId: video.id,
        type: "title",
        hypothesis: "Stats test",
        variants: [
          { label: "Variant A", content: "Title A", isControl: true },
          { label: "Variant B", content: "Title B", isControl: false },
        ],
      }),
    );

    const promises = [
      withActor(db.pool("ytw_web"), alice, (tx) =>
        recordVariantStats(tx, { variantId: exp.variants[0]!.id, impressions: 100, ctr: 0.05 }),
      ),
      withActor(db.pool("ytw_web"), alice, (tx) =>
        recordVariantStats(tx, { variantId: exp.variants[1]!.id, impressions: 200, ctr: 0.1 }),
      ),
      withActor(db.pool("ytw_web"), alice, (tx) =>
        recordVariantStats(tx, { variantId: exp.variants[0]!.id, impressions: 150, ctr: 0.06 }),
      ),
      withActor(db.pool("ytw_web"), alice, (tx) =>
        recordVariantStats(tx, { variantId: exp.variants[1]!.id, impressions: 250, ctr: 0.12 }),
      ),
    ];

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }
  });
});
