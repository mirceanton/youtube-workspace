/**
 * MCP write tools for notes.
 */
import { addNote } from "@ytw/db";
import { NOTE_BODY_MAX_BYTES } from "@ytw/shared/api/notes";
import { NOTE_ENTITY_TYPES } from "@ytw/shared/constants";
import { z } from "zod";
import { defineTool, type ToolRegistry } from "../registry.js";

export const addNoteTool = defineTool({
  name: "add_note",
  description:
    "Adds a markdown comment/note to an entity (idea, script revision, video, or experiment). Requires Write permission on notes.",
  requires: { resource: "notes", level: "write" },
  input: z.object({
    entity_type: z
      .enum(NOTE_ENTITY_TYPES)
      .describe(`Target entity type: ${NOTE_ENTITY_TYPES.join(", ")}`),
    entity_id: z
      .string()
      .uuid()
      .describe("Target entity UUID (for scripts, the script revision ID)"),
    body_md: z
      .string()
      .min(1, "Note body must not be blank")
      .max(
        NOTE_BODY_MAX_BYTES,
        `Note body exceeds maximum allowed size of ${NOTE_BODY_MAX_BYTES} bytes (64 KiB)`,
      )
      .describe("Note content in markdown (up to 64 KiB)"),
  }),
  async handler(input, context) {
    return context.withTx((tx) =>
      addNote(tx, {
        entityType: input.entity_type,
        entityId: input.entity_id,
        bodyMd: input.body_md,
      }),
    );
  },
});

export function register(registry: ToolRegistry): void {
  registry.register(addNoteTool);
}
