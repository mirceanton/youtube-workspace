import { authorize, DENIAL_HTTP_STATUS, type UserPrincipal } from "@ytw/policy";
import { RESOURCES, type ResourceLevels } from "@ytw/shared/constants";
import type { Idea } from "@ytw/shared/api/ideas";
import type { ActorTx, Queryable } from "@ytw/db";
import type { WebAuth } from "../../core/types.js";
import {
  getIdeaPipeline,
  listNotes,
  registerVideo,
  saveScriptVersion,
  withActor as runWithActor,
} from "@ytw/db";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type preHandlerHookHandler,
} from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import ideasRoutes from "./index.js";

type TestCore = FastifyInstance & {
  requireLevel(resource: "ideas", level: "read" | "write"): preHandlerHookHandler;
  db: {
    pool: Queryable;
    withActor<T>(request: FastifyRequest, fn: (tx: ActorTx) => Promise<T>): Promise<T>;
  };
};

const WRITE = { "x-test-ideas-level": "write" };
const READ = { "x-test-ideas-level": "read" };
const ACTOR = { name: "alice", type: "human" as const };

let db: TestDb;
let app: TestCore;
let sequence = 0;

function nextTag(prefix: string): string {
  sequence += 1;
  return `t43-${prefix}-${sequence}`;
}

async function makeApp(): Promise<TestCore> {
  const instance = Fastify();
  instance.decorateRequest("auth", undefined);
  instance.addHook("onRequest", async (request) => {
    const requested = request.headers["x-test-ideas-level"];
    if (typeof requested !== "string") return;
    const scripts = request.headers["x-test-scripts-level"];
    const videos = request.headers["x-test-videos-level"];
    const levels = Object.fromEntries(
      RESOURCES.map((resource) => [resource, "none"]),
    ) as ResourceLevels;
    levels.ideas = requested === "write" ? "write" : requested === "read" ? "read" : "none";
    if (scripts === "read" || scripts === "write") levels.scripts = scripts;
    if (videos === "read" || videos === "write") levels.videos = videos;
    const auth: WebAuth = {
      userId: "ideas-test-user",
      username: "alice",
      isAdmin: false,
      levels,
      displayName: null,
      email: null,
    };
    Object.assign(request, { auth });
  });

  const core = instance as unknown as TestCore;
  core.requireLevel = (resource, level) => async (request, reply) => {
    const auth = request.auth;
    const principal: UserPrincipal | undefined = auth
      ? {
          kind: "user",
          userId: auth.userId,
          username: auth.username,
          isAdmin: auth.isAdmin,
          levels: auth.levels,
        }
      : undefined;
    const decision = authorize(principal, { resource, level });
    if (!decision.allowed) {
      return reply.code(DENIAL_HTTP_STATUS[decision.reason]).send({ error: decision.message });
    }
  };
  core.db = {
    pool: db.pool("ytw_web"),
    withActor<T>(request: FastifyRequest, fn: (tx: ActorTx) => Promise<T>) {
      const auth = request.auth;
      const principal: UserPrincipal | undefined = auth
        ? {
            kind: "user",
            userId: auth.userId,
            username: auth.username,
            isAdmin: auth.isAdmin,
            levels: auth.levels,
          }
        : undefined;
      if (!principal) throw new Error("Ideas route mutation ran without an authenticated user");
      return runWithActor(db.pool("ytw_web"), { name: principal.username, type: "human" }, fn);
    },
  };

  await ideasRoutes(core);
  await core.ready();
  return core;
}

async function createIdea(input: {
  title: string;
  pitch?: string;
  source?: string;
  tags?: string[];
  score?: number;
}): Promise<Idea> {
  const response = await app.inject({
    method: "POST",
    url: "/api/ideas",
    headers: WRITE,
    payload: input,
  });
  expect(response.statusCode).toBe(201);
  return response.json().idea as Idea;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  app = await makeApp();
});

afterEach(async () => {
  await app.close();
});

describe("Ideas routes", () => {
  it("enforces current None, Read, and Write levels with the shared policy", async () => {
    const createdIdea = await createIdea({ title: `Auth fixture ${nextTag("auth")}` });
    const none = await app.inject({
      method: "GET",
      url: "/api/ideas",
      headers: { "x-test-ideas-level": "none" },
    });
    const anonymous = await app.inject({ method: "GET", url: "/api/ideas" });
    const noneDetail = await app.inject({
      method: "GET",
      url: `/api/ideas/${createdIdea.id}`,
      headers: { "x-test-ideas-level": "none" },
    });
    const readList = await app.inject({ method: "GET", url: "/api/ideas", headers: READ });
    const readWrite = await app.inject({
      method: "POST",
      url: "/api/ideas",
      headers: READ,
      payload: { title: "Read cannot create" },
    });
    const readPatch = await app.inject({
      method: "PATCH",
      url: `/api/ideas/${createdIdea.id}`,
      headers: READ,
      payload: { title: "Read cannot edit", expected_version: createdIdea.version },
    });
    const readStage = await app.inject({
      method: "POST",
      url: `/api/ideas/${createdIdea.id}/stage`,
      headers: READ,
      payload: { new_status: "shortlisted", expected_version: createdIdea.version },
    });
    const readArchive = await app.inject({
      method: "POST",
      url: `/api/ideas/${createdIdea.id}/archive`,
      headers: READ,
      payload: { expected_version: createdIdea.version },
    });
    const writable = await app.inject({
      method: "POST",
      url: "/api/ideas",
      headers: WRITE,
      payload: { title: `Auth fixture ${nextTag("auth")}` },
    });

    expect(none.statusCode).toBe(403);
    expect(anonymous.statusCode).toBe(401);
    expect(noneDetail.statusCode).toBe(403);
    expect(readList.statusCode).toBe(200);
    expect(readWrite.statusCode).toBe(403);
    expect(readPatch.statusCode).toBe(403);
    expect(readStage.statusCode).toBe(403);
    expect(readArchive.statusCode).toBe(403);
    expect(writable.statusCode).toBe(201);
    expect(writable.json().idea.created_by).toBe("alice");
    expect(await getIdeaPipeline(db.pool("ytw_web"), writable.json().idea.id)).toMatchObject({
      title: writable.json().idea.title,
      createdBy: "alice",
    });
  });

  it("filters and paginates through the parameterized database reader", async () => {
    const filterTag = nextTag("filter");
    await createIdea({
      title: `filter match ${filterTag}`,
      score: 75,
      source: "Reddit / r/selfhosted",
      tags: [filterTag, "linux"],
    });
    await createIdea({
      title: `filter low ${filterTag}`,
      score: 20,
      source: "Reddit",
      tags: [filterTag],
    });
    await createIdea({
      title: `filter other-tag ${filterTag}`,
      score: 80,
      source: "Reddit",
      tags: ["other-tag"],
    });

    const filtered = await app.inject({
      method: "GET",
      url: `/api/ideas?stage=inbox&tag=${filterTag}&score_min=70&score_max=90&source=REDDIT&sort_by=title&sort_order=asc`,
      headers: READ,
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().page.total).toBe(1);
    expect(filtered.json().ideas[0].title).toBe(`filter match ${filterTag}`);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/ideas?score_min=90&score_max=10",
      headers: READ,
    });
    expect(invalid.statusCode).toBe(400);

    const pageTag = nextTag("page");
    for (const suffix of ["a", "b", "c"]) {
      await createIdea({ title: `page ${suffix} ${pageTag}`, score: 40, tags: [pageTag] });
    }
    const first = await app.inject({
      method: "GET",
      url: `/api/ideas?tag=${pageTag}&sort_by=title&sort_order=asc&limit=2&offset=0`,
      headers: READ,
    });
    const second = await app.inject({
      method: "GET",
      url: `/api/ideas?tag=${pageTag}&sort_by=title&sort_order=asc&limit=2&offset=2`,
      headers: READ,
    });
    expect(first.json().ideas.map((idea: { title: string }) => idea.title)).toEqual([
      `page a ${pageTag}`,
      `page b ${pageTag}`,
    ]);
    expect(second.json().ideas.map((idea: { title: string }) => idea.title)).toEqual([
      `page c ${pageTag}`,
    ]);
    expect(first.json().page.total).toBe(3);
    expect(second.json().page.total).toBe(3);
  });

  it("persists edits, backward notes, archive, and audit actors; reports DB conflicts and transition rules", async () => {
    const tag = nextTag("mutations");
    const created = await createIdea({ title: `Pipeline ${tag}`, tags: [tag], score: 70 });
    const ideaId = created.id as string;

    const invalidMove = await app.inject({
      method: "POST",
      url: `/api/ideas/${ideaId}/stage`,
      headers: WRITE,
      payload: { new_status: "published", expected_version: created.version },
    });
    expect(invalidMove.statusCode).toBe(422);
    expect(invalidMove.json().error).toContain("valid next stages");

    const forward = await app.inject({
      method: "POST",
      url: `/api/ideas/${ideaId}/stage`,
      headers: WRITE,
      payload: { new_status: "shortlisted", expected_version: created.version },
    });
    expect(forward.statusCode).toBe(200);
    expect(forward.json().idea.status).toBe("shortlisted");

    const missingNote = await app.inject({
      method: "POST",
      url: `/api/ideas/${ideaId}/stage`,
      headers: WRITE,
      payload: { new_status: "inbox", expected_version: forward.json().idea.version },
    });
    expect(missingNote.statusCode).toBe(400);
    expect(missingNote.json().error).toContain("requires a note");

    const backward = await app.inject({
      method: "POST",
      url: `/api/ideas/${ideaId}/stage`,
      headers: WRITE,
      payload: {
        new_status: "inbox",
        note: "Revisit this after checking the audience data.",
        expected_version: forward.json().idea.version,
      },
    });
    expect(backward.statusCode).toBe(200);
    expect(backward.json().idea.status).toBe("inbox");
    const notes = await listNotes(db.pool("ytw_web"), { entityType: "idea", entityId: ideaId });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      author: "alice",
      actorType: "human",
      bodyMd: "Revisit this after checking the audience data.",
    });

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/ideas/${ideaId}`,
      headers: WRITE,
      payload: { title: `Updated ${tag}`, expected_version: backward.json().idea.version },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().idea).toMatchObject({ title: `Updated ${tag}`, updated_by: "alice" });

    const conflict = await app.inject({
      method: "PATCH",
      url: `/api/ideas/${ideaId}`,
      headers: WRITE,
      payload: { title: "Stale edit", expected_version: backward.json().idea.version },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().latest).toMatchObject({
      id: ideaId,
      version: edited.json().idea.version,
    });

    const archive = await app.inject({
      method: "POST",
      url: `/api/ideas/${ideaId}/archive`,
      headers: WRITE,
      payload: { expected_version: edited.json().idea.version },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().idea.archived_at).toBeTruthy();
    const active = await app.inject({ method: "GET", url: `/api/ideas?tag=${tag}`, headers: READ });
    const withArchived = await app.inject({
      method: "GET",
      url: `/api/ideas?tag=${tag}&include_archived=true`,
      headers: READ,
    });
    expect(active.json().page.total).toBe(0);
    expect(withArchived.json().ideas).toHaveLength(1);

    const events = await db.admin.query<{ actor: string; actor_type: string }>(
      `SELECT actor, actor_type FROM public.events WHERE entity_type = 'idea' AND entity_id = $1::uuid`,
      [ideaId],
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(4);
    expect(
      events.rows.every((event) => event.actor === "alice" && event.actor_type === "human"),
    ).toBe(true);
  });

  it("returns linked videos only for a request with current Videos Read", async () => {
    const idea = await createIdea({ title: `Video links ${nextTag("video")}` });
    const ideaId = idea.id as string;
    await runWithActor(db.pool("ytw_web"), ACTOR, (tx) =>
      registerVideo(tx, { ideaId, youtubeId: "T43Ideas001", title: "Linked video" }),
    );
    await runWithActor(db.pool("ytw_web"), ACTOR, (tx) =>
      saveScriptVersion(tx, {
        ideaId,
        kind: "script",
        baseVersion: 0,
        bodyMd: "# Draft script",
      }),
    );
    await runWithActor(db.pool("ytw_web"), ACTOR, (tx) =>
      saveScriptVersion(tx, {
        ideaId,
        kind: "packaging",
        baseVersion: 0,
        bodyMd: "# Packaging draft",
      }),
    );

    const hidden = await app.inject({
      method: "GET",
      url: `/api/ideas/${ideaId}`,
      headers: { ...READ, "x-test-scripts-level": "none" },
    });
    const visible = await app.inject({
      method: "GET",
      url: `/api/ideas/${ideaId}`,
      headers: {
        ...READ,
        "x-test-scripts-level": "read",
        "x-test-videos-level": "read",
      },
    });

    expect(hidden.statusCode).toBe(200);
    expect(hidden.json()).not.toHaveProperty("videos");
    expect(hidden.json().idea).not.toHaveProperty("latest_script");
    expect(hidden.json().idea).not.toHaveProperty("latest_packaging");
    expect(visible.statusCode).toBe(200);
    expect(visible.json().videos).toHaveLength(1);
    expect(visible.json().videos[0]).toMatchObject({
      title: "Linked video",
      youtube_id: "T43Ideas001",
    });
    expect(visible.json().idea.latest_script).toMatchObject({ version: 1, status: "draft" });
    expect(visible.json().idea.latest_packaging).toMatchObject({ version: 1, status: "draft" });
  });
});
