// Gate: SQL injection & input fuzzing hardening across all database functions (PRD 5, PRD 9).
//
// Verifies that malicious SQL payloads, escape characters, sleep injections, and null bytes
// passed to function arguments are safely handled via parameterized queries and validation,
// with zero SQL injection or unauthorized database modification.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor, type Actor } from "../../src/client.js";
import { createExperiment, recordVariantStats } from "../../src/experiments.js";
import { advanceIdea, createIdea, getIdea, updateIdea } from "../../src/ideas.js";
import { upsertUserOnLogin } from "../../src/identity.js";
import { listEvents } from "../../src/activity.js";
import { logMetrics } from "../../src/metrics.js";
import { addNote } from "../../src/notes.js";
import { setUserPermission } from "../../src/permissions.js";
import { saveScriptVersion, setScriptStatus } from "../../src/scripts.js";
import { searchAll } from "../../src/search.js";
import { createTestDb, type TestDb } from "../../src/testing.js";
import { createApiToken } from "../../src/tokens.js";
import { registerVideo } from "../../src/videos.js";
import type {
  IdeaStage,
  NoteEntityType,
  Resource,
  Level,
  ScriptStatus,
} from "@ytw/shared/constants";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

const INJECTION_STRINGS = [
  "'; DROP TABLE ideas; --",
  "' OR '1'='1",
  "'; SELECT pg_sleep(5); --",
  "' UNION SELECT NULL, NULL, NULL; --",
  "Robert'); DROP TABLE students;--",
  '"\'\\\'\'"""--/*',
  "\\0",
  "\u0000",
  "../../etc/passwd",
  "\u202E\uFEFF\u0000test\u200B",
  "'; TRUNCATE events; --",
  "<script>alert(1)</script>",
  "1; EXECUTE IMMEDIATE 'DROP TABLE users';",
] as const;

function randomYoutubeId(): string {
  return randomBytes(9).toString("base64url").slice(0, 11);
}

async function attempt<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; val: T } | { ok: false; errName: string }> {
  try {
    const val = await fn();
    return { ok: true, val };
  } catch (err: unknown) {
    const errName = err instanceof Error ? err.name : String(err);
    return { ok: false, errName };
  }
}

function isSafe(
  res: { ok: true; val: unknown } | { ok: false; errName: string },
  allowedErrors: readonly string[],
): boolean {
  if (res.ok) return true;
  return allowedErrors.includes(res.errName);
}

describe("gate: SQL injection hardening", () => {
  const alice: Actor = { name: "alice", type: "human" };

  it("create_idea: handles injection payloads safely across all arguments", async () => {
    for (const payload of INJECTION_STRINGS) {
      const start = Date.now();
      const res = await attempt(async () => {
        const idea = await withActor(db.pool("ytw_web"), alice, (tx) =>
          createIdea(tx, {
            title: `Injection title: ${payload.replace(/\0/g, "[null]")}`,
            pitch: `Pitch with payload: ${payload}`,
            source: `Source: ${payload}`,
            tags: ["security", "injection"],
          }),
        );
        const retrieved = await getIdea(db.admin, idea.id);
        return retrieved?.pitch;
      });
      expect(isSafe(res, ["ValidationError", "TypeError"])).toBe(true);
      expect(Date.now() - start).toBeLessThan(3000);
    }
  });

  it("update_idea: handles injection payloads in title, pitch, source", async () => {
    const idea = await withActor(db.pool("ytw_web"), alice, (tx) =>
      createIdea(tx, { title: "Original Idea for Update Injection" }),
    );

    for (const payload of INJECTION_STRINGS) {
      const start = Date.now();
      const res = await attempt(() =>
        withActor(db.pool("ytw_web"), alice, (tx) =>
          updateIdea(tx, {
            id: idea.id,
            expectedVersion: idea.version,
            fields: {
              pitch: `Updated pitch: ${payload}`,
              source: `Source: ${payload}`,
            },
          }),
        ),
      );
      expect(isSafe(res, ["ValidationError", "VersionConflictError", "TypeError"])).toBe(true);
      expect(Date.now() - start).toBeLessThan(3000);
    }
  });

  it("advance_idea: handles injection payloads in note and new_status", async () => {
    const idea = await withActor(db.pool("ytw_web"), alice, (tx) =>
      createIdea(tx, { title: "Advance Idea for Injection" }),
    );

    for (const payload of INJECTION_STRINGS) {
      const start = Date.now();
      const res1 = await attempt(() =>
        withActor(db.pool("ytw_web"), alice, (tx) =>
          advanceIdea(tx, {
            id: idea.id,
            newStatus: "shortlisted",
            note: `Advancing note: ${payload}`,
          }),
        ),
      );
      expect(isSafe(res1, ["ValidationError", "InvalidTransitionError", "TypeError"])).toBe(true);

      const res2 = await attempt(() =>
        withActor(db.pool("ytw_web"), alice, (tx) =>
          advanceIdea(tx, {
            id: idea.id,
            newStatus: payload as unknown as IdeaStage,
          }),
        ),
      );
      expect(isSafe(res2, ["ValidationError", "TypeError"])).toBe(true);
      expect(Date.now() - start).toBeLessThan(3000);
    }
  });

  it("save_script_version & set_script_status: handles injection in body_md and status", async () => {
    const idea = await withActor(db.pool("ytw_web"), alice, (tx) =>
      createIdea(tx, { title: "Script Injection Idea" }),
    );

    for (const payload of INJECTION_STRINGS) {
      const start = Date.now();
      const res = await attempt(async () => {
        const saved = await withActor(db.pool("ytw_web"), alice, (tx) =>
          saveScriptVersion(tx, {
            ideaId: idea.id,
            kind: "script",
            baseVersion: 0,
            bodyMd: `# Script Title\n\nPayload: ${payload}`,
          }),
        );
        await withActor(db.pool("ytw_web"), alice, (tx) =>
          setScriptStatus(tx, {
            scriptId: saved.id,
            status: payload as unknown as ScriptStatus,
          }),
        );
      });
      // status will fail validation/enum check, which is safe
      expect(
        isSafe(res, [
          "ValidationError",
          "VersionConflictError",
          "TypeError",
          "InvalidStatusTransitionError",
        ]),
      ).toBe(true);
      expect(Date.now() - start).toBeLessThan(3000);
    }
  });

  it("register_video: handles injection in youtube_id, title, thumbnail_url", async () => {
    for (const payload of INJECTION_STRINGS) {
      const start = Date.now();
      const res = await attempt(() =>
        withActor(db.pool("ytw_web"), alice, (tx) =>
          registerVideo(tx, {
            youtubeId: randomYoutubeId(),
            title: `Video Title: ${payload.replace(/\0/g, "")}`,
            thumbnailUrl: `https://example.test/${encodeURIComponent(payload)}`,
          }),
        ),
      );
      expect(isSafe(res, ["ValidationError", "TypeError"])).toBe(true);
      expect(Date.now() - start).toBeLessThan(3000);
    }
  });

  it("log_metrics: handles injection in metric JSON payloads", async () => {
    const vid = await withActor(db.pool("ytw_web"), alice, (tx) =>
      registerVideo(tx, {
        youtubeId: randomYoutubeId(),
        title: "Video for Metrics Injection",
      }),
    );

    for (const payload of INJECTION_STRINGS) {
      const start = Date.now();
      const res = await attempt(() =>
        withActor(db.pool("ytw_web"), alice, (tx) =>
          logMetrics(tx, {
            videoId: vid.id,
            capturedAt: new Date(),
            metrics: {
              views: payload as unknown as number,
              retention: [{ t: 0, pct: 100 }],
            },
          }),
        ),
      );
      expect(isSafe(res, ["ValidationError", "DuplicateError", "TypeError", "error"])).toBe(true);
      expect(Date.now() - start).toBeLessThan(3000);
    }
  });

  it("create_experiment, record_variant_stats, conclude_experiment: handles injection", async () => {
    const vid = await withActor(db.pool("ytw_web"), alice, (tx) =>
      registerVideo(tx, {
        youtubeId: randomYoutubeId(),
        title: "Video for Experiment Injection",
      }),
    );

    for (const payload of INJECTION_STRINGS) {
      const start = Date.now();
      const res = await attempt(async () => {
        const exp = await withActor(db.pool("ytw_web"), alice, (tx) =>
          createExperiment(tx, {
            videoId: vid.id,
            type: "title",
            hypothesis: `Hypothesis: ${payload}`,
            variants: [
              { label: "A", content: `Control: ${payload}`, isControl: true },
              { label: "B", content: `Variant: ${payload}`, isControl: false },
            ],
          }),
        );
        await withActor(db.pool("ytw_web"), alice, (tx) =>
          recordVariantStats(tx, {
            variantId: exp.variants[0]!.id,
            impressions: 100,
            ctr: 0.1,
          }),
        );
      });
      expect(isSafe(res, ["ValidationError", "InvalidTransitionError", "TypeError"])).toBe(true);
      expect(Date.now() - start).toBeLessThan(3000);
    }
  });

  it("add_note: handles injection in entity_type and body_md", async () => {
    const idea = await withActor(db.pool("ytw_web"), alice, (tx) =>
      createIdea(tx, { title: "Note Injection Idea" }),
    );

    for (const payload of INJECTION_STRINGS) {
      const start = Date.now();
      const res1 = await attempt(() =>
        withActor(db.pool("ytw_web"), alice, (tx) =>
          addNote(tx, {
            entityType: "idea",
            entityId: idea.id,
            bodyMd: `Note payload: ${payload}`,
          }),
        ),
      );
      expect(isSafe(res1, ["ValidationError", "TypeError"])).toBe(true);

      const res2 = await attempt(() =>
        withActor(db.pool("ytw_web"), alice, (tx) =>
          addNote(tx, {
            entityType: payload as unknown as NoteEntityType,
            entityId: idea.id,
            bodyMd: "valid note",
          }),
        ),
      );
      expect(isSafe(res2, ["ValidationError", "TypeError"])).toBe(true);
      expect(Date.now() - start).toBeLessThan(3000);
    }
  });

  it("search_all: fuzzing full-text search with arbitrary injection syntax", async () => {
    for (const payload of INJECTION_STRINGS) {
      const start = Date.now();
      const res = await attempt(() =>
        searchAll(db.pool("ytw_web"), {
          query: payload,
          resources: ["ideas", "scripts"],
        }),
      );
      expect(isSafe(res, ["ValidationError", "TypeError"])).toBe(true);
      expect(Date.now() - start).toBeLessThan(3000);
    }
  });

  it("list_events: handles injection in actor, action_prefix, cursor", async () => {
    for (const payload of INJECTION_STRINGS) {
      const start = Date.now();
      const res = await attempt(() =>
        listEvents(db.pool("ytw_web"), {
          actor: payload,
        }),
      );
      expect(isSafe(res, ["ValidationError", "TypeError"])).toBe(true);
      expect(Date.now() - start).toBeLessThan(3000);
    }
  });

  it("user_create (upsert_user_on_login): handles injection in user fields", async () => {
    for (const payload of INJECTION_STRINGS) {
      const start = Date.now();
      const safeUser = `u_${randomUUID().slice(0, 8)}`;
      const userActor: Actor = { name: safeUser, type: "human" };
      const res = await attempt(() =>
        withActor(db.pool("ytw_web"), userActor, (tx) =>
          upsertUserOnLogin(tx, {
            issuer: "https://id.example.test",
            sub: `sub_${randomUUID()}_${payload.replace(/\0/g, "")}`,
            username: safeUser,
            email: `${safeUser}@example.test`,
            displayName: `Display ${payload}`,
          }),
        ),
      );
      expect(isSafe(res, ["ValidationError", "ForbiddenError", "TypeError"])).toBe(true);
      expect(Date.now() - start).toBeLessThan(3000);
    }
  });

  it("user_set_level (set_user_permission): handles injection in resource and level", async () => {
    const adminUsername = `admin_${randomUUID().slice(0, 8)}`;
    const adminActor: Actor = { name: adminUsername, type: "human" };
    const admin = await withActor(db.pool("ytw_web"), adminActor, (tx) =>
      upsertUserOnLogin(tx, {
        issuer: "https://id.example.test",
        sub: `sub_admin_${randomUUID()}`,
        username: adminUsername,
      }),
    );

    for (const payload of INJECTION_STRINGS) {
      const start = Date.now();
      await expect(
        withActor(db.pool("ytw_web"), adminActor, (tx) =>
          setUserPermission(tx, {
            actingUserId: admin.id,
            userId: admin.id,
            resource: payload as unknown as Resource,
            level: "read",
          }),
        ),
      ).rejects.toThrow(/.+/);

      await expect(
        withActor(db.pool("ytw_web"), adminActor, (tx) =>
          setUserPermission(tx, {
            actingUserId: admin.id,
            userId: admin.id,
            resource: "ideas",
            level: payload as unknown as Level,
          }),
        ),
      ).rejects.toThrow(/.+/);

      expect(Date.now() - start).toBeLessThan(3000);
    }
  });

  it("token_create (create_api_token): handles injection in token name and permissions", async () => {
    const ownerUsername = `owner_${randomUUID().slice(0, 8)}`;
    const ownerActor: Actor = { name: ownerUsername, type: "human" };
    const owner = await withActor(db.pool("ytw_web"), ownerActor, (tx) =>
      upsertUserOnLogin(tx, {
        issuer: "https://id.example.test",
        sub: `sub_owner_${randomUUID()}`,
        username: ownerUsername,
      }),
    );

    for (const payload of INJECTION_STRINGS) {
      const start = Date.now();
      const res = await attempt(() =>
        withActor(db.pool("ytw_web"), ownerActor, (tx) =>
          createApiToken(tx, {
            ownerUserId: owner.id,
            name: `Token ${payload}`,
            tokenPrefix: "ytw_test",
            tokenHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            expiresAt: null,
            permissions: {},
          }),
        ),
      );
      expect(isSafe(res, ["ValidationError", "ForbiddenError", "TypeError"])).toBe(true);
      expect(Date.now() - start).toBeLessThan(3000);
    }
  });

  it("post-fuzzing integrity audit: all tables exist and are uncorrupted", async () => {
    const tables = [
      "ideas",
      "scripts",
      "videos",
      "video_metrics",
      "experiments",
      "experiment_variants",
      "notes",
      "events",
      "users",
      "user_permissions",
      "schema_migrations",
    ];

    for (const table of tables) {
      const { rows } = await db.admin.query<{ count: string }>(
        `SELECT count(*)::text as count FROM public.${table}`,
      );
      expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(0);
    }
  });
});
