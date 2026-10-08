// The read side: pipeline and result views, search and the activity feed over the audit log.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listEvents } from "../src/activity.js";
import type { ActorTx } from "../src/client.js";
import { createExperiment, recordVariantStats } from "../src/experiments.js";
import { archiveIdea, createIdea } from "../src/ideas.js";
import { logMetrics } from "../src/metrics.js";
import { saveScriptVersion } from "../src/scripts.js";
import { SEARCH_HIGHLIGHT_START, searchAll } from "../src/search.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import {
  countIdeasByStage,
  listExperimentResults,
  listIdeaPipeline,
  listVideoPerformance,
} from "../src/views.js";
import { registerVideo } from "../src/videos.js";
import { actAs, alice, failure } from "./helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

const act = <T>(fn: (tx: ActorTx) => Promise<T>) => actAs(db, alice, fn);
const newVideo = (title: string) =>
  act((tx) => registerVideo(tx, { youtubeId: randomBytes(8).toString("base64url"), title }));
const script = (ideaId: string, bodyMd: string) =>
  act((tx) => saveScriptVersion(tx, { ideaId, kind: "script", baseVersion: 0, bodyMd }));

describe("views", () => {
  it("show an idea with its latest script and hide it once archived", async () => {
    const idea = await act((tx) => createIdea(tx, { title: "Pipeline idea" }));
    await script(idea.id, "v1");
    const [row] = await listIdeaPipeline(db.pool);
    expect(row).toMatchObject({ id: idea.id, latestScript: { version: 1, status: "draft" } });
    expect(row?.latestPackaging).toBeNull();
    expect((await countIdeasByStage(db.pool)).inbox).toBe(1);

    await act((tx) => archiveIdea(tx, { id: idea.id }));
    expect(await listIdeaPipeline(db.pool)).toEqual([]);
    expect(await listIdeaPipeline(db.pool, { includeArchived: true })).toHaveLength(1);
  });

  it("compare each video with the channel median", async () => {
    for (const views of [100, 300]) {
      const video = await newVideo(`${views} views`);
      const metrics = { views };
      await act((tx) =>
        logMetrics(tx, { videoId: video.id, capturedAt: "2026-10-01T12:00:00Z", metrics }),
      );
    }
    const rows = await listVideoPerformance(db.pool);
    const vs = rows.map((row) => [row.latest?.views, row.median.views, row.vsMedian.views]);
    expect(vs.toSorted()).toEqual([
      ["100", "200", "-100"],
      ["300", "200", "100"],
    ]);
  });

  it("put the variants of an experiment side by side", async () => {
    const video = await newVideo("Tested");
    const variants = [
      { label: "A", content: "a.png", isControl: true },
      { label: "B", content: "b.png" },
    ];
    const experiment = await act((tx) =>
      createExperiment(tx, { videoId: video.id, type: "thumbnail", variants }),
    );
    for (const [variant, ctr] of [4, 5].entries()) {
      const variantId = experiment.variants[variant]?.id ?? "";
      await act((tx) => recordVariantStats(tx, { variantId, ctr }));
    }
    const [result] = await listExperimentResults(db.pool, { experimentId: experiment.id });
    const rows = result?.variants.map((v) => [v.label, v.ctrVsControl, v.isWinner]);
    expect(rows).toEqual([
      ["A", "0", false],
      ["B", "1", false],
    ]);
  });
});

describe("search", () => {
  it("finds ideas and the latest script revision, within the resources it may read", async () => {
    const idea = await act((tx) => createIdea(tx, { title: "Quantum computing explained" }));
    await script(idea.id, "Entanglement links two particles.");
    const query = "quantum or entanglement";
    const both = await searchAll(db.pool, { query, resources: ["ideas", "scripts"] });
    expect(both.map((hit) => hit.entityType).toSorted()).toEqual(["idea", "script"]);
    expect(both[0]?.snippet).toContain(SEARCH_HIGHLIGHT_START);

    const scriptsOnly = await searchAll(db.pool, { query, resources: ["scripts"] });
    expect(scriptsOnly).toMatchObject([{ entityType: "script", ideaId: idea.id, title: null }]);
    expect(await searchAll(db.pool, { query, resources: [] })).toEqual([]);
  });
});

describe("activity", () => {
  it("lists the audit log newest first, filtered and paged", async () => {
    const filter = { actor: "alice", entityType: "idea", limit: 2 };
    const page = await listEvents(db.pool, filter);
    expect(page.events).toHaveLength(2);
    expect(page.events.every((e) => e.actor === "alice" && e.actorType === "human")).toBe(true);
    const next = await listEvents(db.pool, { ...filter, cursor: page.nextCursor ?? "" });
    expect(next.events.map((e) => e.id)).not.toContain(page.events[0]?.id);
  });

  it("is append-only", async () => {
    expect((await failure(db.pool.query("UPDATE events SET actor = 'x'"))).code).toBe("YT007");
    expect((await failure(db.pool.query("DELETE FROM events"))).code).toBe("YT007");
  });
});
