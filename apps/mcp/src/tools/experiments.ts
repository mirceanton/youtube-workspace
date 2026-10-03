/**
 * MCP write tools for experiments (PRD 5, T32).
 */
import { concludeExperiment, createExperiment, getExperiment, recordVariantStats } from "@ytw/db";
import { EXPERIMENT_TYPES } from "@ytw/shared/constants";
import { z } from "zod";
import { defineTool, type ToolRegistry } from "../tools.js";

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
    return context.withTx(async (tx) => {
      let expectedVersion = input.expected_version;
      if (expectedVersion === undefined) {
        const exp = await getExperiment(tx, input.id);
        if (exp) {
          expectedVersion = exp.version;
        } else {
          expectedVersion = 1;
        }
      }
      return concludeExperiment(tx, {
        id: input.id,
        expectedVersion,
        winnerVariantId: input.winner_variant_id ?? null,
        conclusion: input.conclusion,
      });
    });
  },
});

export function register(registry: ToolRegistry): void {
  registry.register(createExperimentTool);
  registry.register(recordVariantStatsTool);
  registry.register(concludeExperimentTool);
}
