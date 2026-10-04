import { EXPERIMENT_STATUSES, EXPERIMENT_TYPES } from "../constants.js";
import { z } from "zod";

export const EXPERIMENTS_PATH = "/api/experiments";
export const EXPERIMENTS_LIST_LIMIT = 500;
export const EXPERIMENT_VIDEOS_PATH = `${EXPERIMENTS_PATH}/videos`;
export const EXPERIMENT_CTR_HISTORY_PATH = `${EXPERIMENTS_PATH}/:experiment_id/ctr-history`;
export const EXPERIMENT_VARIANT_STATS_PATH = `${EXPERIMENTS_PATH}/:experiment_id/variants/:variant_id/stats`;
export const EXPERIMENT_CONCLUDE_PATH = `${EXPERIMENTS_PATH}/:experiment_id/conclude`;
export const EXPERIMENT_STATUS_PATH = `${EXPERIMENTS_PATH}/:experiment_id/status`;

const uuidSchema = z.uuid();
const statusSchema = z.enum(EXPERIMENT_STATUSES);
const typeSchema = z.enum(EXPERIMENT_TYPES);
const timestampSchema = z.iso.datetime({ offset: true });
const decimalSchema = z.union([z.number().finite(), z.string().min(1)]);

export const experimentVariantSchema = z.object({
  id: uuidSchema,
  label: z.string(),
  content: z.string(),
  is_control: z.boolean(),
  impressions: z.string().nullable(),
  ctr: z.string().nullable(),
  ctr_vs_control: z.string().nullable(),
  ctr_lift_pct: z.string().nullable(),
  is_winner: z.boolean(),
  created_by: z.string(),
  updated_by: z.string(),
});
const experimentListVariantSchema = experimentVariantSchema.omit({
  created_by: true,
  updated_by: true,
});

export const experimentSchema = z.object({
  id: uuidSchema,
  video_id: uuidSchema,
  video_title: z.string(),
  type: typeSchema,
  status: statusSchema,
  hypothesis: z.string().nullable(),
  starts_at: timestampSchema.nullable(),
  ends_at: timestampSchema.nullable(),
  winner_variant_id: uuidSchema.nullable(),
  conclusion: z.string().nullable(),
  version: z.number().int().positive(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  created_by: z.string(),
  updated_by: z.string(),
  variants: z.array(experimentVariantSchema),
});

export const experimentListItemSchema = z.object({
  id: uuidSchema,
  video_id: uuidSchema,
  video_title: z.string(),
  type: typeSchema,
  status: statusSchema,
  hypothesis: z.string().nullable(),
  starts_at: timestampSchema.nullable(),
  ends_at: timestampSchema.nullable(),
  winner_variant_id: uuidSchema.nullable(),
  conclusion: z.string().nullable(),
  created_at: timestampSchema,
  variants: z.array(experimentListVariantSchema),
});

export const listExperimentsQuerySchema = z.object({
  status: z.union([statusSchema, z.array(statusSchema)]).optional(),
});

export const listExperimentsResponseSchema = z.object({
  experiments: z.array(experimentListItemSchema),
});

export const listExperimentVideosResponseSchema = z.object({
  videos: z.array(z.object({ id: uuidSchema, title: z.string() })),
});

export const getExperimentResponseSchema = z.object({
  experiment: experimentSchema,
});

export const experimentCtrHistorySchema = z.object({
  captured_at: timestampSchema,
  ctr: z.string().nullable(),
});

export const experimentCtrHistoryResponseSchema = z.object({
  history: z.array(experimentCtrHistorySchema),
});

export const createExperimentRequestSchema = z.object({
  video_id: uuidSchema,
  type: typeSchema,
  hypothesis: z.string().nullable().optional(),
  variants: z.array(
    z.object({
      label: z.string(),
      content: z.string(),
      is_control: z.boolean().optional(),
    }),
  ),
});

export const createExperimentResponseSchema = getExperimentResponseSchema;

export const updateExperimentStatusRequestSchema = z.object({
  expected_version: z.number().int().min(1),
  status: z.enum(["running", "cancelled"]),
});

export const updateExperimentStatusResponseSchema = z.object({
  experiment: z.object({
    id: uuidSchema,
    status: statusSchema,
    starts_at: timestampSchema.nullable(),
    ends_at: timestampSchema.nullable(),
    version: z.number().int().positive(),
    updated_at: timestampSchema,
    updated_by: z.string(),
  }),
});

export const recordVariantStatsRequestSchema = z
  .object({
    impressions: decimalSchema.optional(),
    ctr: decimalSchema.optional(),
  })
  .refine((input) => input.impressions !== undefined || input.ctr !== undefined, {
    message: "Provide impressions, CTR, or both",
  });

export const recordVariantStatsResponseSchema = z.object({
  variant: z.object({
    id: uuidSchema,
    experiment_id: uuidSchema,
    label: z.string(),
    content: z.string(),
    is_control: z.boolean(),
    impressions: z.string().nullable(),
    ctr: z.string().nullable(),
    created_by: z.string(),
    updated_by: z.string(),
  }),
});

export const concludeExperimentRequestSchema = z.object({
  expected_version: z.number().int().min(1),
  winner_variant_id: uuidSchema.nullable(),
  conclusion: z.string().trim().min(1).max(20_000),
});

export const concludeExperimentResponseSchema = updateExperimentStatusResponseSchema.extend({
  experiment: updateExperimentStatusResponseSchema.shape.experiment.extend({
    winner_variant_id: uuidSchema.nullable(),
    conclusion: z.string().nullable(),
  }),
});

export type Experiment = z.infer<typeof experimentSchema>;
export type ExperimentVariant = z.infer<typeof experimentVariantSchema>;
export type ExperimentCtrHistory = z.infer<typeof experimentCtrHistorySchema>;
