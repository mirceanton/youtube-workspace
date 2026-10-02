// The video functions (migration 0041, T13): register_video, update_video and archive_video, with
// the helpers of 0040. Real database, typed wrappers, application roles. The races are real too:
// concurrent transactions on separate connections.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, withActor } from "../src/client.js";
import {
  DuplicateError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from "../src/errors.js";
import { archiveIdea, getIdea } from "../src/ideas.js";
import { addNote, listNotes } from "../src/notes.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import { archiveVideo, getVideo, updateVideo } from "../src/videos.js";
import {
  act,
  alice,
  eventCount,
  eventsFor,
  expectedNullOutcomes,
  functionPrivileges,
  newAgent,
  newIdea,
  nullArgumentOutcomes,
  partition,
  setStageDirectly,
  tick,
  waitForLockWait,
  withoutRowLock,
  type FunctionSpec,
} from "./content-helpers.js";
import { sqlstate } from "./helpers.js";
import { newVideo, rejectedWith, youtubeId } from "./video-helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Calls update_video with a raw JSON `fields` (what an MCP tool sends), bypassing the wrapper. */
function rawUpdate(id: string, version: number, fields: unknown) {
  return db
    .pool("ytw_mcp")
    .query(
      sql`SELECT * FROM update_video('bot', 'agent', NULL, ${id}::uuid, ${version}::integer, ${JSON.stringify(fields)}::jsonb)`,
    );
}

async function videoRows() {
  const { rows } = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM videos");
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------

describe("register_video", () => {
  it("creates a video with every field, at version 1, for the actor", async () => {
    const idea = await newIdea(db);
    const id = youtubeId();
    const video = await newVideo(db, {
      ideaId: idea.id,
      youtubeId: id,
      title: "How I tripled my CTR",
      publishedAt: "2026-09-01T10:00:00Z",
      thumbnailUrl: "https://i.ytimg.com/vi/abc/maxresdefault.jpg",
    });
    expect(video).toMatchObject({
      ideaId: idea.id,
      youtubeId: id,
      title: "How I tripled my CTR",
      publishedAt: new Date("2026-09-01T10:00:00Z"),
      thumbnailUrl: "https://i.ytimg.com/vi/abc/maxresdefault.jpg",
      version: 1,
      archivedAt: null,
      createdBy: "alice",
      updatedBy: "alice",
    });
    expect(video.id).toMatch(UUID_V7);
    expect(await getVideo(db.admin, video.id)).toEqual(video);
  });

  it("needs only a YouTube id and a title", async () => {
    const video = await newVideo(db, { title: "Bare minimum" });
    expect(video).toMatchObject({
      ideaId: null,
      publishedAt: null,
      thumbnailUrl: null,
      version: 1,
    });
  });

  it("accepts an instant in any time zone and keeps the instant", async () => {
    const video = await newVideo(db, { publishedAt: "2026-09-01T12:00:00+02:00" });
    expect(video.publishedAt).toEqual(new Date("2026-09-01T10:00:00Z"));
    const fromDate = await newVideo(db, { publishedAt: new Date("2026-09-01T10:00:00Z") });
    expect(fromDate.publishedAt).toEqual(video.publishedAt);
  });

  it("links the idea and does not move it: no stage change, no new version, no event on the idea", async () => {
    const idea = await setStageDirectly(db, (await newIdea(db)).id, "editing");
    const events = await eventCount(db, idea.id);
    await tick();
    await newVideo(db, { ideaId: idea.id });
    const after = await getIdea(db.admin, idea.id);
    expect(after).toEqual(idea);
    expect(await eventCount(db, idea.id)).toBe(events);
  });

  it("links an archived idea (only the idea itself is frozen)", async () => {
    const idea = await newIdea(db);
    await act(db, alice, (tx) => archiveIdea(tx, { id: idea.id }));
    expect((await newVideo(db, { ideaId: idea.id })).ideaId).toBe(idea.id);
  });

  it("fails for an idea that does not exist and writes nothing", async () => {
    const ideaId = randomUUID();
    const before = await videoRows();
    const err = await rejectedWith(newVideo(db, { ideaId }), NotFoundError);
    expect(err).toMatchObject({ entity: "idea", id: ideaId });
    expect(await videoRows()).toBe(before);
  });

  it("writes one audit row with the actor, and the token of an agent", async () => {
    const agent = newAgent("publisher");
    const video = await newVideo(db, { title: "By an agent" }, agent);
    expect(await eventsFor(db, video.id)).toEqual([
      {
        actor: "publisher",
        actor_type: "agent",
        token_id: agent.tokenId,
        action: "insert",
        entity_type: "video",
        entity_id: video.id,
        payload: {
          new: expect.objectContaining({
            youtube_id: video.youtubeId,
            title: "By an agent",
            version: 1,
            created_by: "publisher",
          }),
        },
      },
    ]);
  });

  describe("youtube_id", () => {
    it.each([
      ["a watch URL", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "not a URL"],
      ["a short URL", "youtu.be/dQw4w9WgXcQ", "not a URL"],
      ["a query string", "v=dQw4w9WgXcQ", "not a URL"],
      ["too short", "dQw4w9WgXc", "exactly 11 characters"],
      ["too long", "dQw4w9WgXcQQ", "exactly 11 characters"],
      ["empty", "", "exactly 11 characters"],
      ["spaces", "dQw4w9 gXcQ", "exactly 11 characters"],
      ["surrounding spaces", " dQw4w9WgXcQ", "exactly 11 characters"],
      ["a newline", "dQw4w9WgXc\n", "exactly 11 characters"],
      ["non-ASCII letters", "dQw4w9WgXcé", "exactly 11 characters"],
      ["SQL injection", "'; DROP TABLE v", "exactly 11 characters"],
      ["5000 characters", "x".repeat(5000), "exactly 11 characters"],
    ])("refuses an id that is %s", async (_label, value, words) => {
      const before = await videoRows();
      const err = await rejectedWith(newVideo(db, { youtubeId: value }), ValidationError);
      expect(err.field).toBe("youtube_id");
      expect(err.message).toContain(words);
      expect(err.message.length).toBeLessThan(400);
      expect(await videoRows()).toBe(before);
    });

    it.each(["dQw4w9WgXcQ", "-_-_-_-_-_-", "___________", "AAAAAAAAAAA", "0123456789a"])(
      "accepts %s",
      async (value) => {
        expect((await newVideo(db, { youtubeId: value })).youtubeId).toBe(value);
      },
    );

    it("treats ids that differ only in case as different videos (YouTube ids are case-sensitive)", async () => {
      const lower = await newVideo(db, { youtubeId: "caseSensiti" });
      const upper = await newVideo(db, { youtubeId: "CASESENSITI" });
      expect(lower.id).not.toBe(upper.id);
    });
  });

  describe("title, publication time and thumbnail", () => {
    it.each([
      ["empty", ""],
      ["spaces", "   "],
      ["a tab and a newline", "\t\n"],
    ])("refuses a title that is %s", async (_label, title) => {
      const err = await rejectedWith(newVideo(db, { title }), ValidationError);
      expect(err.field).toBe("title");
      expect(err.message).toContain("cannot be empty");
    });

    it("limits the title to 500 characters", async () => {
      expect((await newVideo(db, { title: "t".repeat(500) })).title).toHaveLength(500);
      const err = await rejectedWith(newVideo(db, { title: "t".repeat(501) }), ValidationError);
      expect(err.message).toBe("title is too long: 501 characters, the limit is 500");
      expect(err.details).toMatchObject({ field: "title", length: 501, max_length: 500 });
    });

    it("keeps the publication time between 2005 and two years ahead", async () => {
      const soon = new Date(Date.now() + 700 * 86_400_000);
      expect((await newVideo(db, { publishedAt: soon })).publishedAt).toEqual(soon);
      const far = await rejectedWith(
        newVideo(db, { publishedAt: "2062-10-01T00:00:00Z" }),
        ValidationError,
      );
      expect(far.field).toBe("published_at");
      expect(far.message).toContain("too far ahead: scheduled videos can be at most 2 years ahead");
      const old = await rejectedWith(
        newVideo(db, { publishedAt: "1999-12-31T23:59:59Z" }),
        ValidationError,
      );
      expect(old.message).toContain("when YouTube did not exist yet");
    });

    it("refuses infinite times, which no wrapper can send but a raw call can", async () => {
      for (const value of ["infinity", "-infinity"]) {
        const err = await rejectedWith(
          db
            .pool("ytw_mcp")
            .query(
              sql`SELECT * FROM register_video('bot', 'agent', NULL, NULL, ${youtubeId()}, 'x', ${value}::timestamptz)`,
            ),
          ValidationError,
        );
        expect(err.field).toBe("published_at");
        expect(err.message).toContain("must be a real date and time");
      }
    });

    it.each([
      ["no time zone", "2026-09-01T10:00:00"],
      ["a date only", "2026-09-01"],
      ["words", "last Tuesday"],
      ["an empty string", ""],
      ["a number", "1790000000"],
    ])("refuses a publication time with %s before it reaches the database", async (_l, value) => {
      const err = await rejectedWith(newVideo(db, { publishedAt: value }), ValidationError);
      expect(err.field).toBe("published_at");
      expect(err.message).toContain("time zone");
    });

    it("refuses a Date that is not a time", async () => {
      const err = await rejectedWith(
        newVideo(db, { publishedAt: new Date(Number.NaN) }),
        ValidationError,
      );
      expect(err.field).toBe("published_at");
    });

    it.each([
      "https://i.ytimg.com/vi/x/hq.jpg",
      "http://example.com/t.png",
      "HTTPS://EXAMPLE.COM/T.PNG",
      "thumbnails/video-1.png",
      "/thumbnails/video-1.png",
      "//cdn.example.com/t.png",
    ])("accepts the thumbnail %s", async (thumbnailUrl) => {
      expect((await newVideo(db, { thumbnailUrl })).thumbnailUrl).toBe(thumbnailUrl);
    });

    it.each([
      ["a javascript URL", "javascript:alert(1)", "scheme"],
      ["a data URL", "data:image/png;base64,AAAA", "scheme"],
      ["an ftp URL", "ftp://example.com/t.png", "scheme"],
      ["a file URL", "file:///etc/passwd", "scheme"],
      ["a scheme without slashes", "http:evil.example", "scheme"],
      ["empty", "", "cannot be empty"],
      ["a space", "https://example.com/a b.png", "spaces or control"],
      ["a newline", "thumbs/a\nb.png", "spaces or control"],
      ["2049 characters", `https://example.com/${"a".repeat(2029)}`, "too long"],
    ])("refuses a thumbnail that is %s", async (_label, thumbnailUrl, words) => {
      const err = await rejectedWith(newVideo(db, { thumbnailUrl }), ValidationError);
      expect(err.field).toBe("thumbnail_url");
      expect(err.message).toContain(words);
      expect(err.message.length).toBeLessThan(400);
    });
  });

  describe("a YouTube id that is already registered", () => {
    it("fails with a duplicate error that names the existing video and writes nothing", async () => {
      const first = await newVideo(db, { title: "The original" });
      const before = await videoRows();
      const err = await rejectedWith(
        newVideo(db, { youtubeId: first.youtubeId, title: "A second try" }, newAgent()),
        DuplicateError,
      );
      expect(err.existingId).toBe(first.id);
      expect(err.status).toBe(422);
      expect(err.message).toBe(
        `youtube_id "${first.youtubeId}" is already registered as video ${first.id} ("The original"): work with that video instead of registering it again`,
      );
      expect(err.details).toMatchObject({
        entity: "video",
        field: "youtube_id",
        existing_id: first.id,
        existing_archived: false,
      });
      expect(await videoRows()).toBe(before);
      expect(await eventCount(db, first.id)).toBe(1);
    });

    it("says so when the existing video is archived", async () => {
      const first = await newVideo(db);
      await act(db, alice, (tx) => archiveVideo(tx, { id: first.id }));
      const err = await rejectedWith(newVideo(db, { youtubeId: first.youtubeId }), DuplicateError);
      expect(err.message).toContain("which is archived and read-only");
      expect(err.details).toMatchObject({ existing_archived: true });
    });

    it("lets exactly one of many racing registrations win; the others learn which video won", async () => {
      const racing = youtubeId();
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          newVideo(
            db,
            { youtubeId: racing, title: `attempt ${i}` },
            i % 2 === 0 ? alice : newAgent(),
          ),
        ),
      );
      const { ok, failed } = partition(results);
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(7);
      for (const reason of failed) {
        expect(reason).toBeInstanceOf(DuplicateError);
        expect((reason as DuplicateError).existingId).toBe(ok[0]?.id);
      }
      const { rows } = await db.admin.query("SELECT 1 FROM videos WHERE youtube_id = $1", [racing]);
      expect(rows).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("update_video", () => {
  it("sets the given fields, keeps the others and raises the version", async () => {
    const idea = await newIdea(db);
    const video = await newVideo(db, {
      title: "Before",
      publishedAt: "2026-09-01T10:00:00Z",
      thumbnailUrl: "thumbs/a.png",
    });
    await tick();
    const agent = newAgent("editor");
    const updated = await act(db, agent, (tx) =>
      updateVideo(tx, {
        id: video.id,
        expectedVersion: 1,
        fields: { title: "After", ideaId: idea.id },
      }),
    );
    expect(updated).toMatchObject({
      id: video.id,
      title: "After",
      ideaId: idea.id,
      publishedAt: video.publishedAt,
      thumbnailUrl: "thumbs/a.png",
      youtubeId: video.youtubeId,
      version: 2,
      createdBy: "alice",
      updatedBy: "editor",
    });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(video.updatedAt.getTime());
    const trail = await eventsFor(db, video.id);
    expect(trail.at(-1)).toMatchObject({
      actor: "editor",
      token_id: agent.tokenId,
      action: "update",
      payload: {
        old: { title: "Before", version: 1, idea_id: null },
        new: { title: "After", version: 2, idea_id: idea.id },
      },
    });
  });

  it("clears published_at, thumbnail_url and idea_id with null", async () => {
    const idea = await newIdea(db);
    const video = await newVideo(db, {
      ideaId: idea.id,
      publishedAt: "2026-09-01T10:00:00Z",
      thumbnailUrl: "thumbs/a.png",
    });
    const cleared = await act(db, alice, (tx) =>
      updateVideo(tx, {
        id: video.id,
        expectedVersion: 1,
        fields: { publishedAt: null, thumbnailUrl: null, ideaId: null },
      }),
    );
    expect(cleared).toMatchObject({
      publishedAt: null,
      thumbnailUrl: null,
      ideaId: null,
      title: video.title,
      version: 2,
    });
  });

  it("changes the publication time to another zone's spelling of the same instant as no change", async () => {
    const video = await newVideo(db, { publishedAt: "2026-09-01T10:00:00Z" });
    const same = await act(db, alice, (tx) =>
      updateVideo(tx, {
        id: video.id,
        expectedVersion: 1,
        fields: { publishedAt: "2026-09-01T12:00:00+02:00" },
      }),
    );
    expect(same).toEqual(video);
  });

  it("changes nothing when the values are the stored ones: same version, same row, no audit row", async () => {
    const video = await newVideo(db, { thumbnailUrl: "thumbs/a.png" });
    const events = await eventCount(db, video.id);
    await tick();
    const same = await act(db, newAgent(), (tx) =>
      updateVideo(tx, {
        id: video.id,
        expectedVersion: 1,
        fields: { title: video.title, thumbnailUrl: "thumbs/a.png", ideaId: null },
      }),
    );
    expect(same).toEqual(video);
    expect(await eventCount(db, video.id)).toBe(events);
  });

  describe("optimistic concurrency", () => {
    it("fails with the latest version when expected_version is stale, and changes nothing", async () => {
      const video = await newVideo(db, { title: "v1" });
      await act(db, alice, (tx) =>
        updateVideo(tx, { id: video.id, expectedVersion: 1, fields: { title: "v2" } }),
      );
      await act(db, alice, (tx) =>
        updateVideo(tx, { id: video.id, expectedVersion: 2, fields: { title: "v3" } }),
      );
      const events = await eventCount(db, video.id);
      for (const expectedVersion of [1, 2, 4]) {
        const err = await rejectedWith(
          act(db, alice, (tx) =>
            updateVideo(tx, { id: video.id, expectedVersion, fields: { title: "stale" } }),
          ),
          VersionConflictError,
        );
        expect(err.latestVersion).toBe(3);
        expect(err.status).toBe(409);
        expect(err.message).toBe(
          `video ${video.id} has changed since you read it: you sent expected_version ${expectedVersion} but the latest version is 3; reload it, apply your change again and retry with expected_version 3`,
        );
      }
      expect((await getVideo(db.admin, video.id))?.title).toBe("v3");
      expect(await eventCount(db, video.id)).toBe(events);
    });

    it("lets exactly one of racing editors win, and the others learn the new version", async () => {
      const video = await newVideo(db);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          act(db, i % 2 === 0 ? alice : newAgent(), (tx) =>
            updateVideo(tx, { id: video.id, expectedVersion: 1, fields: { title: `edit ${i}` } }),
          ),
        ),
      );
      const { ok, failed } = partition(results);
      expect(ok).toHaveLength(1);
      expect(ok[0]?.version).toBe(2);
      for (const reason of failed) {
        expect(reason).toBeInstanceOf(VersionConflictError);
        expect((reason as VersionConflictError).latestVersion).toBe(2);
      }
      expect(failed).toHaveLength(7);
    });

    it("still lets exactly one win if the row lock is taken away: the version predicate decides", async () => {
      const video = await newVideo(db);
      const results = await withoutRowLock(db, ["update_video"], () =>
        Promise.allSettled(
          Array.from({ length: 8 }, (_, i) =>
            act(db, i % 2 === 0 ? alice : newAgent(), (tx) =>
              updateVideo(tx, { id: video.id, expectedVersion: 1, fields: { title: `edit ${i}` } }),
            ),
          ),
        ),
      );
      const { ok, failed } = partition(results);
      expect(ok).toHaveLength(1);
      for (const reason of failed) {
        expect(reason).toBeInstanceOf(VersionConflictError);
      }
      expect((await getVideo(db.admin, video.id))?.version).toBe(2);
    });
  });

  describe("arguments", () => {
    it("refuses an empty field set, a field that cannot be edited, and the YouTube id", async () => {
      const video = await newVideo(db);
      const empty = await rejectedWith(rawUpdate(video.id, 1, {}), ValidationError);
      expect(empty.message).toBe(
        'fields is empty: give at least one of "title", "published_at", "thumbnail_url", "idea_id"',
      );
      expect(empty.allowed).toEqual(["title", "published_at", "thumbnail_url", "idea_id"]);
      const unknown = await rejectedWith(rawUpdate(video.id, 1, { views: 5 }), ValidationError);
      expect(unknown.message).toContain('field "views" cannot be edited; editable fields:');
      const notObject = await rejectedWith(rawUpdate(video.id, 1, ["title"]), ValidationError);
      expect(notObject.field).toBe("fields");
      const identity = await rejectedWith(
        act(db, alice, (tx) =>
          updateVideo(tx, {
            id: video.id,
            expectedVersion: 1,
            fields: { youtubeId: youtubeId() } as never,
          }),
        ),
        ValidationError,
      );
      expect(identity.field).toBe("youtube_id");
      expect(identity.message).toContain("cannot be changed");
      expect(identity.message).toContain("archive this video and register the right one");
      expect((await getVideo(db.admin, video.id))?.version).toBe(1);
    });

    it("applies the same limits as register_video", async () => {
      const video = await newVideo(db);
      const cases: [string, unknown, string, string][] = [
        ["title", "", "title", "cannot be empty"],
        ["title", null, "title", "title is required"],
        ["title", 5, "title", "got a number"],
        ["title", "t".repeat(501), "title", "too long"],
        ["thumbnail_url", "javascript:alert(1)", "thumbnail_url", "scheme"],
        ["thumbnail_url", "", "thumbnail_url", "cannot be empty"],
        ["published_at", "2026-09-01T10:00:00", "published_at", "time zone"],
        ["published_at", "2026-13-45T10:00:00Z", "published_at", "not a real date"],
        ["published_at", "2062-01-01T00:00:00Z", "published_at", "too far ahead"],
        ["published_at", 12, "published_at", "got a number"],
        ["idea_id", "not-a-uuid", "idea_id", "UUID of an idea"],
        ["idea_id", 7, "idea_id", "UUID of an idea"],
      ];
      for (const [key, value, field, words] of cases) {
        const err = await rejectedWith(rawUpdate(video.id, 1, { [key]: value }), ValidationError);
        expect(err.field, `${key}=${String(value)}`).toBe(field);
        expect(err.message).toContain(words);
      }
      expect((await getVideo(db.admin, video.id))?.version).toBe(1);
    });

    it("refuses a missing id or version, and unknown or malformed ids", async () => {
      const video = await newVideo(db);
      const call = (id: string | null, version: number | null) =>
        db
          .pool("ytw_mcp")
          .query(
            sql`SELECT * FROM update_video('bot', 'agent', NULL, ${id}::uuid, ${version}::integer, '{"title": "x"}'::jsonb)`,
          );
      expect((await rejectedWith(call(null, 1), ValidationError)).field).toBe("id");
      expect((await rejectedWith(call(video.id, null), ValidationError)).field).toBe(
        "expected_version",
      );
      expect((await rejectedWith(call(video.id, 0), ValidationError)).field).toBe(
        "expected_version",
      );
      const missing = randomUUID();
      expect(await rejectedWith(call(missing, 1), NotFoundError)).toMatchObject({
        entity: "video",
        id: missing,
      });
      const bad = await rejectedWith(
        act(db, alice, (tx) => updateVideo(tx, { id: "nope", expectedVersion: 1, fields: {} })),
        ValidationError,
      );
      expect(bad.field).toBe("id");
    });

    it("links an existing idea, and refuses one that does not exist", async () => {
      const video = await newVideo(db);
      const ideaId = randomUUID();
      const err = await rejectedWith(
        act(db, alice, (tx) =>
          updateVideo(tx, { id: video.id, expectedVersion: 1, fields: { ideaId } }),
        ),
        NotFoundError,
      );
      expect(err).toMatchObject({ entity: "idea", id: ideaId });
      const idea = await newIdea(db);
      const linked = await act(db, alice, (tx) =>
        updateVideo(tx, { id: video.id, expectedVersion: 1, fields: { ideaId: idea.id } }),
      );
      expect(linked.ideaId).toBe(idea.id);
    });
  });

  it("refuses an archived video", async () => {
    const video = await newVideo(db);
    await act(db, alice, (tx) => archiveVideo(tx, { id: video.id }));
    const err = await rejectedWith(
      act(db, alice, (tx) =>
        updateVideo(tx, { id: video.id, expectedVersion: 2, fields: { title: "late" } }),
      ),
      InvalidTransitionError,
    );
    expect(err.details).toMatchObject({ entity: "video", id: video.id, reason: "archived" });
    expect(err.message).toBe(`video ${video.id} is archived and cannot be edited`);
    expect((await getVideo(db.admin, video.id))?.title).toBe(video.title);
  });
});

// ---------------------------------------------------------------------------------------------

describe("archive_video", () => {
  it("sets archived_at, raises the version and writes one audit row", async () => {
    const video = await newVideo(db);
    await tick();
    const agent = newAgent("janitor");
    const archived = await act(db, agent, (tx) => archiveVideo(tx, { id: video.id }));
    expect(archived).toMatchObject({
      id: video.id,
      version: 2,
      archivedAt: expect.any(Date),
      updatedBy: "janitor",
    });
    const trail = await eventsFor(db, video.id);
    expect(trail).toHaveLength(2);
    expect(trail[1]).toMatchObject({
      actor: "janitor",
      token_id: agent.tokenId,
      action: "update",
      payload: { old: { archived_at: null, version: 1 }, new: { version: 2 } },
    });
    expect(trail[1]?.payload.new).toHaveProperty("archived_at");
  });

  it("archives twice as a no-op: same row, no new version, no audit row", async () => {
    const video = await newVideo(db);
    const first = await act(db, alice, (tx) => archiveVideo(tx, { id: video.id }));
    const events = await eventCount(db, video.id);
    await tick();
    const second = await act(db, newAgent(), (tx) => archiveVideo(tx, { id: video.id }));
    expect(second).toEqual(first);
    expect(await eventCount(db, video.id)).toBe(events);
  });

  it("checks expected_version when given, and does not need it", async () => {
    const video = await newVideo(db);
    const err = await rejectedWith(
      act(db, alice, (tx) => archiveVideo(tx, { id: video.id, expectedVersion: 3 })),
      VersionConflictError,
    );
    expect(err.latestVersion).toBe(1);
    expect((await getVideo(db.admin, video.id))?.archivedAt).toBeNull();
    const ok = await act(db, alice, (tx) => archiveVideo(tx, { id: video.id, expectedVersion: 1 }));
    expect(ok.archivedAt).not.toBeNull();
  });

  it("fails for a video that does not exist", async () => {
    const id = randomUUID();
    expect(
      await rejectedWith(
        act(db, alice, (tx) => archiveVideo(tx, { id })),
        NotFoundError,
      ),
    ).toMatchObject({ entity: "video", id });
  });

  it("freezes the video but keeps its notes writable and readable", async () => {
    const video = await newVideo(db);
    await act(db, alice, (tx) => archiveVideo(tx, { id: video.id }));
    await act(db, newAgent(), (tx) =>
      addNote(tx, { entityType: "video", entityId: video.id, bodyMd: "still commentable" }),
    );
    expect(await listNotes(db.admin, { entityType: "video", entityId: video.id })).toHaveLength(1);
  });

  it("makes a racing edit wait for the archiving that started first, then refuse it", async () => {
    const video = await newVideo(db);
    const archiver = await db.pool("ytw_web").connect();
    try {
      await archiver.query("BEGIN");
      await archiver.query(sql`SELECT archive_video('alice', 'human', NULL, ${video.id}::uuid)`);
      const racing = withActor(db.pool("ytw_mcp"), newAgent(), (tx) =>
        updateVideo(tx, { id: video.id, expectedVersion: 1, fields: { title: "late" } }),
      );
      const outcome = racing.then(
        () => undefined,
        (err: unknown) => err,
      );
      await waitForLockWait(db, "update_video");
      await archiver.query("COMMIT");
      // Version 1 is stale by now, and the video is archived: the archived video is reported.
      expect(await outcome).toBeInstanceOf(InvalidTransitionError);
    } finally {
      await archiver.query("ROLLBACK").catch(() => undefined);
      archiver.release();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("arguments that are NULL", () => {
  // Generated at run time: a literal id next to a "token" key reads as a credential to the secret scan.
  const agentToken = randomUUID();
  const specs: FunctionSpec[] = [
    {
      name: "register_video",
      types: ["text", "text", "uuid", "uuid", "text", "text", "timestamptz", "text"],
      valid: async () => ["bot", "agent", agentToken, null, youtubeId(), "A title", null, null],
      optional: [2, 3, 6, 7],
    },
    {
      name: "update_video",
      types: ["text", "text", "uuid", "uuid", "integer", "jsonb"],
      valid: async () => [
        "bot",
        "agent",
        agentToken,
        (await newVideo(db)).id,
        1,
        JSON.stringify({ title: "Edited" }),
      ],
      optional: [2],
    },
    {
      name: "archive_video",
      types: ["text", "text", "uuid", "uuid", "integer"],
      valid: async () => ["bot", "agent", agentToken, (await newVideo(db)).id, null],
      optional: [2, 4],
    },
  ];

  it.each(specs)(
    "$name answers a NULL with a validation error wherever a value is required",
    async (spec) => {
      expect(await nullArgumentOutcomes(db, spec)).toEqual(expectedNullOutcomes(spec));
    },
  );
});

// ---------------------------------------------------------------------------------------------

describe("privileges and isolation", () => {
  const WRITERS = ["register_video", "update_video", "archive_video"];
  const HELPERS = [
    "ytw_metric_fmt_ts",
    "ytw_raise_video_archived",
    "ytw_check_video_time",
    "ytw_check_video_field",
    "ytw_metric_number",
    "ytw_check_retention",
  ];

  it.each(WRITERS)(
    "%s is SECURITY DEFINER, pins its search path and is executable by exactly ytw_web and ytw_mcp",
    async (name) => {
      const found = Object.values(await functionPrivileges(db, name));
      expect(found).toHaveLength(1);
      expect(found[0]).toEqual({
        roles: ["ytw_mcp", "ytw_web"],
        publicExecute: false,
        definer: true,
        searchPath: "search_path=pg_catalog, public, pg_temp",
      });
    },
  );

  it.each(HELPERS)("keeps the helper %s out of reach of every application role", async (name) => {
    for (const privileges of Object.values(await functionPrivileges(db, name))) {
      expect(privileges).toMatchObject({ roles: [], publicExecute: false });
    }
  });

  it("keeps the catalog guard clean", async () => {
    const { rows } = await db.admin.query("SELECT * FROM ytw_catalog_violations()");
    expect(rows).toEqual([]);
  });

  it("denies direct writes to videos to every application role, and the functions to ytw_readonly", async () => {
    const video = await newVideo(db);
    for (const role of ["ytw_web", "ytw_mcp", "ytw_readonly"] as const) {
      const pool = db.pool(role);
      const denied = /^(42501|25006)$/;
      expect(
        await sqlstate(
          pool.query("INSERT INTO videos (youtube_id, title) VALUES ($1, 'x')", [youtubeId()]),
        ),
      ).toMatch(denied);
      expect(await sqlstate(pool.query("UPDATE videos SET title = 'tampered'"))).toMatch(denied);
      expect(await sqlstate(pool.query("UPDATE videos SET archived_at = now()"))).toMatch(denied);
      expect(await sqlstate(pool.query("DELETE FROM videos"))).toMatch(denied);
      expect(await sqlstate(pool.query("TRUNCATE videos"))).toMatch(denied);
    }
    const readonly = db.pool("ytw_readonly");
    expect(
      await sqlstate(
        readonly.query(
          `SELECT * FROM register_video('x', 'human', NULL, NULL, '${youtubeId()}', 'x')`,
        ),
      ),
    ).toBe("42501");
    expect(
      await sqlstate(
        readonly.query(`SELECT * FROM archive_video('x', 'human', NULL, '${video.id}')`),
      ),
    ).toBe("42501");
    expect((await getVideo(db.admin, video.id))?.archivedAt).toBeNull();
  });

  it("is not fooled by temporary tables that shadow the real ones", async () => {
    const id = youtubeId();
    const client = await db.admin.connect();
    try {
      await client.query("CREATE TEMP TABLE videos (id uuid, youtube_id text)");
      await client.query("CREATE TEMP TABLE ideas (id uuid)");
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM register_video('mallory', 'human', NULL, NULL, $1, 'real')",
        [id],
      );
      expect(rows).toHaveLength(1);
      const temp = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_temp.videos",
      );
      expect(temp.rows[0]?.n).toBe(0);
    } finally {
      client.release(true);
    }
    const stored = await db.admin.query(
      "SELECT created_by FROM public.videos WHERE youtube_id = $1",
      [id],
    );
    expect(stored.rows).toEqual([{ created_by: "mallory" }]);
  });
});
