/**
 * MCP read tools.
 *
 * Structured read tools returning only objects the token can Read.
 */
import {
  ForbiddenError,
  getIdea,
  getScriptVersion,
  listExperimentResults,
  listIdeaPipeline,
  listNotes,
  listVideoPerformance,
  NotFoundError,
  searchAll,
  ValidationError,
} from "@ytw/db";
import { can } from "@ytw/policy";
import {
  EXPERIMENT_STATUSES,
  IDEA_STAGES,
  NOTE_ENTITY_TYPES,
  SCRIPT_KINDS,
  type NoteEntityType,
} from "@ytw/shared/constants";
import { z } from "zod";
import { defineTool, type ToolRegistry } from "../registry.js";

export const listIdeasTool = defineTool({
  name: "list_ideas",
  description:
    "Lists ideas in the pipeline with their age in stage and latest script revisions. Filterable by stage. Requires Read permission on ideas.",
  requires: { resource: "ideas", level: "read" },
  input: z.object({
    status: z.enum(IDEA_STAGES).optional().describe("Filter by a single stage"),
    stages: z.array(z.enum(IDEA_STAGES)).optional().describe("Filter by multiple stages"),
    include_archived: z
      .boolean()
      .optional()
      .describe("Include archived ideas (default: false, only active ideas)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Maximum number of ideas to return (default: 500)"),
  }),
  async handler(input, context) {
    const stages = input.status ? [input.status] : input.stages;
    return listIdeaPipeline(context.db, {
      stages,
      includeArchived: input.include_archived,
      limit: input.limit,
    });
  },
});

export const getIdeaTool = defineTool({
  name: "get_idea",
  description: "Gets a single idea by ID. Requires Read permission on ideas.",
  requires: { resource: "ideas", level: "read" },
  input: z.object({
    id: z.string().uuid().describe("Idea UUID"),
  }),
  async handler(input, context) {
    const idea = await getIdea(context.db, input.id);
    if (!idea) {
      throw new NotFoundError(`idea with id "${input.id}" does not exist`, {
        entity: "idea",
        id: input.id,
      });
    }
    return idea;
  },
});

export const getScriptTool = defineTool({
  name: "get_script",
  description:
    "Gets a script or packaging revision by idea ID and kind. Returns the latest version unless a specific version is requested. Requires Read permission on scripts.",
  requires: { resource: "scripts", level: "read" },
  input: z.object({
    idea_id: z.string().uuid().describe("Idea UUID"),
    kind: z.enum(SCRIPT_KINDS).describe("Script kind: script or packaging"),
    version: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Specific revision number to retrieve (omitted means latest revision)"),
  }),
  async handler(input, context) {
    const script = await getScriptVersion(context.db, {
      ideaId: input.idea_id,
      kind: input.kind,
      version: input.version,
    });
    if (!script) {
      throw new NotFoundError(
        `script for idea "${input.idea_id}" and kind "${input.kind}"${input.version !== undefined ? ` version ${input.version}` : ""} does not exist`,
        { entity: "script", ideaId: input.idea_id, kind: input.kind, version: input.version },
      );
    }
    return script;
  },
});

export const listVideosTool = defineTool({
  name: "list_videos",
  description:
    "Lists videos and their headline performance metrics compared against channel medians. Requires Read permission on videos.",
  requires: { resource: "videos", level: "read" },
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Maximum number of videos to return (default: 500)"),
  }),
  async handler(input, context) {
    return listVideoPerformance(context.db, { limit: input.limit });
  },
});

export const getVideoPerformanceTool = defineTool({
  name: "get_video_performance",
  description:
    "Gets detailed performance metrics and channel median comparisons for a specific video. Requires Read permission on videos.",
  requires: { resource: "videos", level: "read" },
  input: z.object({
    video_id: z.string().uuid().describe("Video UUID"),
  }),
  async handler(input, context) {
    const rows = await listVideoPerformance(context.db, {
      videoId: input.video_id,
      limit: 1,
    });
    if (rows.length === 0) {
      throw new NotFoundError(`video with id "${input.video_id}" does not exist`, {
        entity: "video",
        id: input.video_id,
      });
    }
    return rows[0];
  },
});

export const listExperimentsTool = defineTool({
  name: "list_experiments",
  description:
    "Lists packaging experiments and their variant results. Filterable by video or status. Requires Read permission on experiments.",
  requires: { resource: "experiments", level: "read" },
  input: z.object({
    video_id: z.string().uuid().optional().describe("Filter by video UUID"),
    status: z.enum(EXPERIMENT_STATUSES).optional().describe("Filter by experiment status"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Maximum number of experiments to return (default: 500)"),
  }),
  async handler(input, context) {
    return listExperimentResults(context.db, {
      videoId: input.video_id,
      statuses: input.status ? [input.status] : undefined,
      limit: input.limit,
    });
  },
});

export const getExperimentResultsTool = defineTool({
  name: "get_experiment_results",
  description:
    "Gets detailed results of a packaging experiment with variants side by side, CTR differences vs control, and the declared winner. Requires Read permission on experiments.",
  requires: { resource: "experiments", level: "read" },
  input: z.object({
    experiment_id: z.string().uuid().describe("Experiment UUID"),
  }),
  async handler(input, context) {
    const rows = await listExperimentResults(context.db, {
      experimentId: input.experiment_id,
      limit: 1,
    });
    if (rows.length === 0) {
      throw new NotFoundError(`experiment with id "${input.experiment_id}" does not exist`, {
        entity: "experiment",
        id: input.experiment_id,
      });
    }
    return rows[0];
  },
});

export const listNotesTool = defineTool({
  name: "list_notes",
  description:
    "Lists comments and notes attached to an entity (idea, video, experiment, etc.), oldest first. Requires Read permission on notes.",
  requires: { resource: "notes", level: "read" },
  input: z.object({
    entity_type: z
      .enum(NOTE_ENTITY_TYPES)
      .optional()
      .describe("Entity type (idea, script, video, experiment)"),
    entity_id: z.string().uuid().optional().describe("Entity UUID"),
    entity: z
      .object({
        type: z.enum(NOTE_ENTITY_TYPES),
        id: z.string().uuid(),
      })
      .optional()
      .describe("Entity reference object"),
  }),
  async handler(input, context) {
    const entityType = (input.entity_type ?? input.entity?.type) as NoteEntityType | undefined;
    const entityId = input.entity_id ?? input.entity?.id;
    if (!entityType || !entityId) {
      throw new ValidationError("entity_type and entity_id are required", { field: "entity" });
    }
    return listNotes(context.db, { entityType, entityId });
  },
});

export const searchTool = defineTool({
  name: "search",
  description:
    "Performs full-text search across ideas (titles and pitches) and scripts (latest revision bodies). Results are limited to the resources the token has permission to Read.",
  input: z.object({
    query: z
      .string()
      .min(1)
      .max(1000)
      .describe("Search query string with optional phrases or boolean operators"),
    resources: z
      .array(z.enum(["ideas", "scripts"]))
      .optional()
      .describe("Optional subset of resources to search (defaults to all readable resources)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Maximum number of results to return (default: 20, max: 50)"),
  }),
  async handler(input, context) {
    const allowedResources: ("ideas" | "scripts")[] = [];
    if (can(context.principal, "ideas", "read")) {
      allowedResources.push("ideas");
    }
    if (can(context.principal, "scripts", "read")) {
      allowedResources.push("scripts");
    }

    if (allowedResources.length === 0) {
      throw new ForbiddenError(
        "Permission denied: read access on ideas or scripts is required to search",
        { reason: "insufficient_permissions" },
      );
    }

    let resourcesToSearch = allowedResources;
    if (input.resources && input.resources.length > 0) {
      for (const r of input.resources) {
        if (!allowedResources.includes(r)) {
          throw new ForbiddenError(
            `Permission denied: read access on ${r} is required to search ${r}`,
            { resource: r },
          );
        }
      }
      resourcesToSearch = input.resources.filter((r) => allowedResources.includes(r));
    }

    return searchAll(context.db, {
      query: input.query,
      resources: resourcesToSearch,
      limit: input.limit,
    });
  },
});

export function register(registry: ToolRegistry): void {
  registry.register(listIdeasTool);
  registry.register(getIdeaTool);
  registry.register(getScriptTool);
  registry.register(listVideosTool);
  registry.register(getVideoPerformanceTool);
  registry.register(listExperimentsTool);
  registry.register(getExperimentResultsTool);
  registry.register(listNotesTool);
  registry.register(searchTool);
}
