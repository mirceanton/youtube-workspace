import { SCRIPT_KINDS, SCRIPT_STATUSES } from "../constants.js";
import { z } from "zod";

export const SCRIPTS_PATH = "/api/scripts";
export const SCRIPTS_HISTORY_PATH = `${SCRIPTS_PATH}/history`;
export const SCRIPTS_UPLOAD_PATH = `${SCRIPTS_PATH}/upload`;

const uuidSchema = z.string().uuid();
const scriptKindSchema = z.enum(SCRIPT_KINDS);
const scriptStatusSchema = z.enum(SCRIPT_STATUSES);

/** Metadata common to a script revision in a history list or detail response. */
export const scriptVersionSchema = z.object({
  id: uuidSchema,
  idea_id: uuidSchema,
  kind: scriptKindSchema,
  version: z.number().int().positive(),
  status: scriptStatusSchema,
  size_bytes: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  created_by: z.string(),
  updated_by: z.string(),
});

export const scriptListItemSchema = scriptVersionSchema.extend({
  idea_title: z.string(),
});

export const listScriptsResponseSchema = z.object({
  scripts: z.array(scriptListItemSchema),
});

export const listScriptHistoryQuerySchema = z.object({
  idea_id: uuidSchema,
  kind: scriptKindSchema,
});

export const listScriptHistoryResponseSchema = z.object({
  idea_id: uuidSchema,
  idea_title: z.string(),
  kind: scriptKindSchema,
  versions: z.array(scriptVersionSchema),
});

export const getScriptResponseSchema = z.object({
  script: scriptVersionSchema.extend({ body_md: z.string() }),
});

export const saveScriptRequestSchema = z.object({
  idea_id: uuidSchema,
  kind: scriptKindSchema,
  base_version: z.number().int().min(0),
  body_md: z.string(),
});

export const saveScriptResponseSchema = z.object({
  script: scriptVersionSchema,
});

export const setScriptStatusRequestSchema = z.object({
  status: scriptStatusSchema,
});

export const setScriptStatusResponseSchema = z.object({
  script: scriptVersionSchema,
});

export const uploadScriptQuerySchema = z.object({
  idea_id: uuidSchema,
  kind: scriptKindSchema,
  base_version: z.coerce.number().int().min(0).optional(),
});

export type ScriptVersion = z.infer<typeof scriptVersionSchema>;
export type ScriptListItem = z.infer<typeof scriptListItemSchema>;
export type ScriptWithBody = z.infer<typeof getScriptResponseSchema>["script"];
