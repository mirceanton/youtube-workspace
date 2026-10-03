/**
 * MCP write tools for ideas (PRD 5, T31).
 */
import { advanceIdea, createIdea, updateIdea } from "@ytw/db";
import { IDEA_STAGES } from "@ytw/shared/constants";
import { z } from "zod";
import { defineTool, type ToolRegistry } from "../tools.js";

export const createIdeaTool = defineTool({
  name: "create_idea",
  description: "Creates a new video idea in the 'inbox' stage. Requires Write permission on ideas.",
  requires: { resource: "ideas", level: "write" },
  input: z.object({
    title: z.string().min(1).max(500).describe("Idea title (1-500 characters)"),
    pitch: z.string().max(20000).optional().describe("Summary or pitch (up to 20,000 characters)"),
    source: z
      .string()
      .max(200)
      .optional()
      .describe("Origin or inspiration for the idea (up to 200 characters)"),
    tags: z
      .array(z.string().min(1).max(64))
      .max(50)
      .optional()
      .describe("Tags for categorization (up to 50 tags)"),
    score: z.number().int().min(0).max(100).optional().describe("Priority score from 0 to 100"),
  }),
  async handler(input, context) {
    return context.withTx((tx) =>
      createIdea(tx, {
        title: input.title,
        pitch: input.pitch,
        source: input.source,
        tags: input.tags,
        score: input.score,
      }),
    );
  },
});

export const updateIdeaTool = defineTool({
  name: "update_idea",
  description:
    "Edits non-status fields of an existing idea. Fails with version conflict if the idea was modified concurrently. Requires Write permission on ideas.",
  requires: { resource: "ideas", level: "write" },
  input: z.object({
    id: z.string().uuid().describe("Idea UUID"),
    expected_version: z
      .number()
      .int()
      .min(1)
      .describe("The version of the idea before this update (optimistic concurrency)"),
    fields: z
      .object({
        title: z.string().min(1).max(500).optional().describe("New title"),
        pitch: z.string().max(20000).nullable().optional().describe("New pitch (null to clear)"),
        source: z.string().max(200).nullable().optional().describe("New source (null to clear)"),
        tags: z
          .array(z.string().min(1).max(64))
          .max(50)
          .optional()
          .describe("New tags list (replaces existing tags)"),
        score: z
          .number()
          .int()
          .min(0)
          .max(100)
          .nullable()
          .optional()
          .describe("New priority score from 0 to 100 (null to clear)"),
      })
      .describe("Editable non-status fields"),
  }),
  async handler(input, context) {
    return context.withTx((tx) =>
      updateIdea(tx, {
        id: input.id,
        expectedVersion: input.expected_version,
        fields: input.fields,
      }),
    );
  },
});

export const advanceIdeaTool = defineTool({
  name: "advance_idea",
  description:
    "Moves an idea to a different stage adhering to transition rules: forward one stage, backward one stage (requires note), any to dropped, dropped to inbox. Requires Write permission on ideas.",
  requires: { resource: "ideas", level: "write" },
  input: z.object({
    id: z.string().uuid().describe("Idea UUID"),
    new_status: z.enum(IDEA_STAGES).describe(`Target idea stage: ${IDEA_STAGES.join(", ")}`),
    note: z
      .string()
      .optional()
      .describe("Reason for stage transition (required when moving backward)"),
    expected_version: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Expected version for optimistic concurrency check"),
  }),
  async handler(input, context) {
    return context.withTx((tx) =>
      advanceIdea(tx, {
        id: input.id,
        newStatus: input.new_status,
        note: input.note,
        expectedVersion: input.expected_version,
      }),
    );
  },
});

export function register(registry: ToolRegistry): void {
  registry.register(createIdeaTool);
  registry.register(updateIdeaTool);
  registry.register(advanceIdeaTool);
}
