import { describe, expect, it } from "vitest";
import {
  NOTE_BODY_MAX_BYTES,
  createNoteRequestSchema,
  createNoteResponseSchema,
  listNotesQuerySchema,
  listNotesResponseSchema,
  noteSchema,
} from "../src/api/notes.js";
import {
  CSRF_HEADER,
  LOGIN_PATH,
  LOGOUT_PATH,
  ME_PATH,
  RETURN_TO_PARAM,
  apiErrorBodySchema,
  conflictBodySchema,
  meResponseSchema,
} from "../src/api/session.js";
import { RESOURCES, type ResourceLevels } from "../src/index.js";

const levels: ResourceLevels = {
  ideas: "write",
  scripts: "write",
  experiments: "read",
  videos: "read",
  notes: "write",
  activity: "none",
};
const user = {
  id: "0199-user",
  username: "owner",
  displayName: "Channel Owner",
  email: "owner@example.test",
  isAdmin: true,
};
const entityId = "0199c2a4-7b1e-7c3a-9d2f-3b8a1c4e5f60";
const note = {
  id: "0199c2a4-7b1e-7c3a-9d2f-3b8a1c4e5f61",
  entity_type: "idea",
  entity_id: entityId,
  author: "claude-agent",
  actor_type: "agent",
  body_md: "Looks **good**",
  created_at: "2026-10-01T10:00:00.000Z",
  updated_at: "2026-10-01T10:00:00.000Z",
};

describe("session contract", () => {
  it("accepts the documented /api/me body", () => {
    expect(meResponseSchema.parse({ user, levels })).toEqual({ user, levels });
  });

  it("requires a level for every resource and refuses write on activity", () => {
    const missing = { ...levels } as Partial<ResourceLevels>;
    delete missing.notes;
    expect(meResponseSchema.safeParse({ user, levels: missing }).success).toBe(false);
    expect(
      meResponseSchema.safeParse({ user, levels: { ...levels, activity: "write" } }).success,
    ).toBe(false);
    expect(RESOURCES.every((resource) => resource in levels)).toBe(true);
  });

  it("names the routes and the CSRF header exactly as the plan does", () => {
    expect([ME_PATH, LOGIN_PATH, LOGOUT_PATH, RETURN_TO_PARAM, CSRF_HEADER]).toEqual([
      "/api/me",
      "/auth/login",
      "/auth/logout",
      "return_to",
      "X-CSRF-Token",
    ]);
  });

  it("describes errors and conflicts", () => {
    expect(apiErrorBodySchema.safeParse({ error: "nope" }).success).toBe(true);
    expect(apiErrorBodySchema.safeParse({ error: "" }).success).toBe(false);
    expect(conflictBodySchema.parse({ error: "stale", latest: { version: 4 } }).latest).toEqual({
      version: 4,
    });
  });
});

describe("notes contract", () => {
  it("accepts a stored note and the list and create responses around it", () => {
    expect(noteSchema.parse(note)).toEqual(note);
    expect(listNotesResponseSchema.parse({ notes: [note] }).notes).toHaveLength(1);
    expect(createNoteResponseSchema.parse({ note }).note.author).toBe("claude-agent");
  });

  it("accepts timestamps with an offset", () => {
    expect(noteSchema.safeParse({ ...note, created_at: "2026-10-01T12:00:00+02:00" }).success).toBe(
      true,
    );
  });

  it("only knows the entity types of the data model and the two actor types", () => {
    expect(noteSchema.safeParse({ ...note, entity_type: "user" }).success).toBe(false);
    expect(noteSchema.safeParse({ ...note, actor_type: "robot" }).success).toBe(false);
    expect(listNotesQuerySchema.safeParse({ entity_type: "video", entity_id: "x" }).success).toBe(
      false,
    );
  });

  it("validates create requests: non-empty, within the byte limit", () => {
    const base = { entity_type: "script", entity_id: entityId };
    expect(createNoteRequestSchema.safeParse({ ...base, body_md: "hello" }).success).toBe(true);
    expect(createNoteRequestSchema.safeParse({ ...base, body_md: "   \n" }).success).toBe(false);
    expect(
      createNoteRequestSchema.safeParse({ ...base, body_md: "a".repeat(NOTE_BODY_MAX_BYTES) })
        .success,
    ).toBe(true);
    // Counted in bytes, not characters: 3 bytes per character.
    expect(
      createNoteRequestSchema.safeParse({
        ...base,
        body_md: "€".repeat(NOTE_BODY_MAX_BYTES / 3 + 1),
      }).success,
    ).toBe(false);
  });
});
