/**
 * MCP write tools for experiments.
 */
import {
  concludeExperiment,
  createExperiment,
  getExperiment,
  recordVariantStats,
  updateExperimentStatus,
  type Queryable,
} from "@ytw/db";
import { EXPERIMENT_TYPES } from "@ytw/shared/constants";
import { z } from "zod";
import { defineTool, type ToolRegistry } from "../registry.js";

/**
 * The version the caller passed, or the stored one. A missing experiment falls through as version 1
 * so the database function raises the not_found error.
 */
async function resolveVersion(db: Queryable, id: string, given: number | undefined) {
  if (given !== undefined) {
    return given;
  }
  return (await getExperiment(db, id))?.version ?? 1;
}

export const createExperimentTool = defineTool({
  name: "create_experiment",
  description:
    "Creates a new packaging experiment with its variants. Exactly one variant must be designated as the control. Requires Write permission on experiments.",
  requires: { resource: "experiments", level: "write" },
  input: z.object({
    video_id: z.string().uuid().describe("Video UUID"),
    type: z.enum(EXPERIMENT_TYPES).describe(`Experiment type: ${EXPERIMENT_TYPES.join(", ")}`),
    hypothesis: z
      .string()
      .max(20000)
      .nullable()
      .optional()
      .describe("Hypothesis text (up to 20,000 characters)"),
    variants: z
      .array(
        z.object({
          label: z.string().min(1).max(200).describe("Variant label (1-200 characters)"),
          content: z
            .string()
            .min(1)
            .max(20000)
            .describe("Variant content (e.g. title text or thumbnail URL/path)"),
          is_control: z
            .boolean()
            .optional()
            .describe("True if this variant is the control (exactly one variant must be control)"),
        }),
      )
      .min(2)
      .max(10)
      .describe("2 to 10 variants, exactly one of which must be control"),
  }),
  async handler(input, context) {
    return context.withTx((tx) =>
      createExperiment(tx, {
        videoId: input.video_id,
        type: input.type,
        hypothesis: input.hypothesis,
        variants: input.variants.map((v) => ({
          label: v.label,
          content: v.content,
          isControl: v.is_control ?? false,
        })),
      }),
    );
  },
});

export const updateExperimentStatusTool = defineTool({
  name: "update_experiment_status",
  description:
    "Starts a planned experiment (status running, which sets its start time) or cancels a planned or running one (status cancelled, final). Use conclude_experiment to finish a running experiment with a winner. Requires Write permission on experiments.",
  requires: { resource: "experiments", level: "write" },
  input: z.object({
    id: z.string().uuid().describe("Experiment UUID"),
    new_status: z
      .enum(["running", "cancelled"])
      .describe("running (from planned) or cancelled (from planned or running)"),
    expected_version: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Expected experiment version for optimistic concurrency check"),
  }),
  async handler(input, context) {
    return context.withTx(async (tx) =>
      updateExperimentStatus(tx, {
        id: input.id,
        expectedVersion: await resolveVersion(tx, input.id, input.expected_version),
        newStatus: input.new_status,
      }),
    );
  },
});

export const recordVariantStatsTool = defineTool({
  name: "record_variant_stats",
  description:
    "Records impressions and/or CTR for an experiment variant while the experiment is planned or running. Requires Write permission on experiments.",
  requires: { resource: "experiments", level: "write" },
  input: z.object({
    variant_id: z.string().uuid().describe("Variant UUID"),
    impressions: z
      .union([z.number(), z.string()])
      .nullable()
      .optional()
      .describe("Impression count (whole number >= 0)"),
    ctr: z
      .union([z.number(), z.string()])
      .nullable()
      .optional()
      .describe("Click-through rate in percent (0 to 100)"),
  }),
  async handler(input, context) {
    return context.withTx((tx) =>
      recordVariantStats(tx, {
        variantId: input.variant_id,
        impressions: input.impressions,
        ctr: input.ctr,
      }),
    );
  },
});

export const concludeExperimentTool = defineTool({
  name: "conclude_experiment",
  description:
    "Concludes a running experiment, designating a winning variant and recording conclusions. Requires Write permission on experiments.",
  requires: { resource: "experiments", level: "write" },
  input: z.object({
    id: z.string().uuid().describe("Experiment UUID"),
    winner_variant_id: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe("Winning variant UUID, or null when no variant won"),
    conclusion: z.string().min(1).max(20000).describe("Conclusion notes explaining the learnings"),
    expected_version: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Expected experiment version for optimistic concurrency check"),
  }),
  async handler(input, context) {
    return context.withTx(async (tx) =>
      concludeExperiment(tx, {
        id: input.id,
        expectedVersion: await resolveVersion(tx, input.id, input.expected_version),
        winnerVariantId: input.winner_variant_id ?? null,
        conclusion: input.conclusion,
      }),
    );
  },
});

export function register(registry: ToolRegistry): void {
  registry.register(createExperimentTool);
  registry.register(updateExperimentStatusTool);
  registry.register(recordVariantStatsTool);
  registry.register(concludeExperimentTool);
}
