import { z } from "zod";
import { ideaStageSchema } from "../schemas.js";

export const IDEAS_PATH = "/api/ideas";

export const IDEA_SORT_FIELDS = [
  "title",
  "status",
  "score",
  "source",
  "created_at",
  "updated_at",
  "status_changed_at",
] as const;
export const ideaSortFieldSchema = z.enum(IDEA_SORT_FIELDS);
export const ideaSortOrderSchema = z.enum(["asc", "desc"]);

const timestampSchema = z.iso.datetime({ offset: true });

export const ideaScriptSummarySchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  status: z.enum(["draft", "review", "approved"]),
  saved_at: timestampSchema,
});
export type IdeaScriptSummary = z.infer<typeof ideaScriptSummarySchema>;

/** Idea fields plus pipeline and audit metadata shared by the list and detail routes. */
export const ideaSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  pitch: z.string().nullable(),
  status: ideaStageSchema,
  status_changed_at: timestampSchema,
  age_in_stage_seconds: z.number().nonnegative(),
  days_in_stage: z.number().int().nonnegative(),
  score: z.number().int().min(0).max(100).nullable(),
  source: z.string().nullable(),
  tags: z.array(z.string()),
  version: z.number().int().positive(),
  archived_at: timestampSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  created_by: z.string(),
  updated_by: z.string(),
  latest_script: ideaScriptSummarySchema.nullable().optional(),
  latest_packaging: ideaScriptSummarySchema.nullable().optional(),
});
export type Idea = z.infer<typeof ideaSchema>;

export const ideaVideoLinkSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  youtube_id: z.string(),
  published_at: timestampSchema.nullable(),
  thumbnail_url: z.string().nullable(),
  views: z.string().nullable(),
  impressions: z.string().nullable(),
  ctr: z.string().nullable(),
  avg_view_duration_s: z.string().nullable(),
});
export type IdeaVideoLink = z.infer<typeof ideaVideoLinkSchema>;

export const listIdeasQuerySchema = z
  .object({
    stage: ideaStageSchema.optional(),
    tag: z.string().trim().min(1).max(64).optional(),
    score_min: z.coerce.number().int().min(0).max(100).optional(),
    score_max: z.coerce.number().int().min(0).max(100).optional(),
    source: z.string().trim().min(1).max(200).optional(),
    sort_by: ideaSortFieldSchema.default("updated_at"),
    sort_order: ideaSortOrderSchema.default("desc"),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    include_archived: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .transform((value) => value === true || value === "true")
      .default(false),
  })
  .superRefine((query, ctx) => {
    if (
      query.score_min !== undefined &&
      query.score_max !== undefined &&
      query.score_min > query.score_max
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["score_min"],
        message: "score_min must be less than or equal to score_max",
      });
    }
  });
export type ListIdeasQuery = z.infer<typeof listIdeasQuerySchema>;

export const listIdeasResponseSchema = z.object({
  ideas: z.array(ideaSchema),
  page: z.object({
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});
export type ListIdeasResponse = z.infer<typeof listIdeasResponseSchema>;

export const createIdeaRequestSchema = z.object({
  title: z.string().trim().min(1).max(500),
  pitch: z.string().max(20_000).nullable().optional(),
  source: z.string().trim().min(1).max(200).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  score: z.number().int().min(0).max(100).nullable().optional(),
});
export type CreateIdeaRequest = z.infer<typeof createIdeaRequestSchema>;

export const updateIdeaRequestSchema = createIdeaRequestSchema
  .partial()
  .extend({
    expected_version: z.number().int().positive(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== "expected_version"), {
    message: "At least one editable field is required",
  });
export type UpdateIdeaRequest = z.infer<typeof updateIdeaRequestSchema>;

export const advanceIdeaRequestSchema = z.object({
  expected_version: z.number().int().positive(),
  new_status: ideaStageSchema,
  note: z.string().max(65_536).nullable().optional(),
});
export type AdvanceIdeaRequest = z.infer<typeof advanceIdeaRequestSchema>;

export const archiveIdeaRequestSchema = z.object({
  expected_version: z.number().int().positive(),
});
export type ArchiveIdeaRequest = z.infer<typeof archiveIdeaRequestSchema>;

export const ideaDetailResponseSchema = z.object({
  idea: ideaSchema,
  videos: z.array(ideaVideoLinkSchema).optional(),
});
export type IdeaDetailResponse = z.infer<typeof ideaDetailResponseSchema>;

export const ideaMutationResponseSchema = z.object({ idea: ideaSchema });
export type IdeaMutationResponse = z.infer<typeof ideaMutationResponseSchema>;
