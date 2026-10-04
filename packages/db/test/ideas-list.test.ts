import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor } from "../src/client.js";
import { archiveIdea, createIdea } from "../src/ideas.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { listIdeas, listVideoPerformance } from "../src/views.js";
import { registerVideo } from "../src/videos.js";

let db: TestDb;
const actor = { name: "ideas-reader-test", type: "human" as const };

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

async function addIdea(
  title: string,
  options: { score?: number; source?: string; tags?: string[] } = {},
) {
  return withActor(db.pool("ytw_web"), actor, (tx) =>
    createIdea(tx, {
      title,
      score: options.score,
      source: options.source,
      tags: options.tags,
    }),
  );
}

describe("web Ideas reader", () => {
  it("filters by stage, exact tag, score range and case-insensitive source", async () => {
    const match = await addIdea("matching row", {
      score: 75,
      source: "Reddit / r/selfhosted",
      tags: ["homelab", "linux"],
    });
    await addIdea("below score", { score: 20, source: "Reddit", tags: ["homelab"] });
    await addIdea("wrong tag", { score: 80, source: "Reddit", tags: ["linux"] });

    const result = await listIdeas(db.pool("ytw_web"), {
      stage: "inbox",
      tag: "homelab",
      scoreMin: 70,
      scoreMax: 80,
      source: "REDDIT",
      sortBy: "title",
      sortOrder: "asc",
    });

    expect(result.ideas.map(({ id }) => id)).toContain(match.id);
    expect(result.ideas.map(({ title }) => title)).toEqual(["matching row"]);
    expect(result.total).toBe(1);
  });

  it("orders deterministically, pages after filtering, and returns the filtered total", async () => {
    await addIdea("page a", { score: 40, tags: ["paging"] });
    await addIdea("page b", { score: 40, tags: ["paging"] });
    await addIdea("page c", { score: 40, tags: ["paging"] });

    const first = await listIdeas(db.pool("ytw_web"), {
      tag: "paging",
      sortBy: "title",
      sortOrder: "asc",
      limit: 2,
      offset: 0,
    });
    const second = await listIdeas(db.pool("ytw_web"), {
      tag: "paging",
      sortBy: "title",
      sortOrder: "asc",
      limit: 2,
      offset: 2,
    });

    expect(first.ideas.map(({ title }) => title)).toEqual(["page a", "page b"]);
    expect(second.ideas.map(({ title }) => title)).toEqual(["page c"]);
    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
  });

  it("includes archived rows only when requested and looks up an archived idea by id", async () => {
    const idea = await addIdea("archive reader fixture");
    await withActor(db.pool("ytw_web"), actor, (tx) =>
      archiveIdea(tx, { id: idea.id, expectedVersion: idea.version }),
    );

    expect((await listIdeas(db.pool("ytw_web"), { id: idea.id })).total).toBe(0);
    const archived = await listIdeas(db.pool("ytw_web"), {
      id: idea.id,
      includeArchived: true,
      limit: 1,
    });
    expect(archived.total).toBe(1);
    expect(archived.ideas[0]?.archivedAt).toBeInstanceOf(Date);
  });

  it("matches linked videos by idea id without returning other videos", async () => {
    const idea = await addIdea("linked video fixture");
    const otherIdea = await addIdea("other video fixture");
    const video = await withActor(db.pool("ytw_web"), actor, (tx) =>
      registerVideo(tx, { ideaId: idea.id, youtubeId: "ideaslin001", title: "Linked" }),
    );
    await withActor(db.pool("ytw_web"), actor, (tx) =>
      registerVideo(tx, { ideaId: otherIdea.id, youtubeId: "ideasoth001", title: "Other" }),
    );

    const results = await listVideoPerformance(db.pool("ytw_web"), { ideaId: idea.id });
    expect(results.map(({ id }) => id)).toEqual([video.id]);
    expect(results[0]?.ideaId).toBe(idea.id);
  });

  it("does not interpolate a caller-supplied sort string", async () => {
    const query = listIdeas(db.pool("ytw_web"), {
      sortBy: "title; DROP TABLE ideas" as never,
    });
    await expect(query).rejects.toThrow("sort_by is not supported");
  });
});
