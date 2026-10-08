import { describe, expect, it } from "vitest";
import { NOTE_BODY_MAX_BYTES, createNoteRequestSchema, noteSchema } from "../src/api/notes.js";
import { meResponseSchema } from "../src/api/session.js";
import { GRANTABLE_LEVELS, RESOURCES, resourceLevelsSchema } from "../src/index.js";

const allRead = Object.fromEntries(RESOURCES.map((resource) => [resource, "read"]));
const entityId = "0199c2a4-7b1e-7c3a-9d2f-3b8a1c4e5f60";

describe("resource levels", () => {
  it("caps the activity log at read and allows every level elsewhere", () => {
    for (const resource of RESOURCES) {
      const expected = resource === "activity" ? ["none", "read"] : ["none", "read", "write"];
      expect(GRANTABLE_LEVELS[resource]).toEqual(expected);
    }
  });

  it("accepts a complete map and rejects write on the activity log with a readable message", () => {
    expect(resourceLevelsSchema.parse(allRead)).toEqual(allRead);
    const result = resourceLevelsSchema.safeParse({ ...allRead, activity: "write" });
    expect(result.error?.issues[0]?.message).toBe(
      '"write" is not allowed for activity; valid levels: none, read',
    );
  });
});

describe("api contracts", () => {
  it("validates the /api/me body", () => {
    const user = {
      id: "u1",
      username: "owner",
      displayName: "Owner",
      email: "owner@example.test",
      isAdmin: true,
    };
    expect(meResponseSchema.safeParse({ user, levels: allRead }).success).toBe(true);
    const write = { ...allRead, activity: "write" };
    expect(meResponseSchema.safeParse({ user, levels: write }).success).toBe(false);
  });

  it("validates notes: known entity types, non-empty body within the byte limit", () => {
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
    expect(noteSchema.parse(note)).toEqual(note);
    expect(noteSchema.safeParse({ ...note, entity_type: "user" }).success).toBe(false);

    const base = { entity_type: "script", entity_id: entityId };
    expect(createNoteRequestSchema.safeParse({ ...base, body_md: "hello" }).success).toBe(true);
    expect(createNoteRequestSchema.safeParse({ ...base, body_md: "   \n" }).success).toBe(false);
    // Counted in bytes, not characters: 3 bytes per character.
    const tooLong = "€".repeat(NOTE_BODY_MAX_BYTES / 3 + 1);
    expect(createNoteRequestSchema.safeParse({ ...base, body_md: tooLong }).success).toBe(false);
  });
});
