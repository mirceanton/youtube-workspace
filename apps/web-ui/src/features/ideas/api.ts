import { IDEA_STAGES } from "@ytw/shared/constants";
import type {
  Idea,
  IdeaDetailResponse,
  ListIdeasQuery,
  ListIdeasResponse,
} from "@ytw/shared/api/ideas";
import { api } from "@/lib/api.ts";

// Keep this feature bundle independent of the server-side Zod schemas in @ytw/shared/api/ideas.
export const IDEAS_PATH = "/api/ideas";

export const ideasQueryKey = {
  all: ["ideas"] as const,
  list: (filters: Partial<ListIdeasQuery>) => ["ideas", "list", filters] as const,
  detail: (ideaId: string) => ["ideas", ideaId] as const,
};

export function fetchIdeas(
  filters: Partial<ListIdeasQuery>,
  signal?: AbortSignal,
): Promise<ListIdeasResponse> {
  return api.get<ListIdeasResponse>(IDEAS_PATH, {
    query: filters,
    signal,
  });
}

export function fetchIdea(ideaId: string, signal?: AbortSignal): Promise<IdeaDetailResponse> {
  return api.get<IdeaDetailResponse>(`${IDEAS_PATH}/${ideaId}`, {
    signal,
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCRIPT_STATUSES = ["draft", "review", "approved"] as const;

function isDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isScriptSummary(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value === null;
  const summary = value as Record<string, unknown>;
  return (
    typeof summary.id === "string" &&
    UUID_PATTERN.test(summary.id) &&
    Number.isInteger(summary.version) &&
    (SCRIPT_STATUSES as readonly unknown[]).includes(summary.status) &&
    isDate(summary.saved_at)
  );
}

/** Validates a conflict payload before it replaces detail/query state; keeps Zod out of this chunk. */
export function parseIdea(value: unknown): Idea | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const idea = value as Record<string, unknown>;
  if (
    typeof idea.id !== "string" ||
    !UUID_PATTERN.test(idea.id) ||
    typeof idea.title !== "string" ||
    !(idea.pitch === null || typeof idea.pitch === "string") ||
    !IDEA_STAGES.includes(idea.status as (typeof IDEA_STAGES)[number]) ||
    !isDate(idea.status_changed_at) ||
    typeof idea.age_in_stage_seconds !== "number" ||
    !Number.isFinite(idea.age_in_stage_seconds) ||
    idea.age_in_stage_seconds < 0 ||
    !Number.isInteger(idea.days_in_stage) ||
    (idea.days_in_stage as number) < 0 ||
    !(
      idea.score === null ||
      (Number.isInteger(idea.score) && (idea.score as number) >= 0 && (idea.score as number) <= 100)
    ) ||
    !isNullableString(idea.source) ||
    !Number.isInteger(idea.version) ||
    (idea.version as number) < 1 ||
    !(idea.archived_at === null || isDate(idea.archived_at)) ||
    !isDate(idea.created_at) ||
    !isDate(idea.updated_at) ||
    typeof idea.created_by !== "string" ||
    typeof idea.updated_by !== "string" ||
    !Array.isArray(idea.tags) ||
    !idea.tags.every((tag) => typeof tag === "string") ||
    ("latest_script" in idea &&
      idea.latest_script !== undefined &&
      !isScriptSummary(idea.latest_script)) ||
    ("latest_packaging" in idea &&
      idea.latest_packaging !== undefined &&
      !isScriptSummary(idea.latest_packaging))
  ) {
    return null;
  }
  return idea as unknown as Idea;
}
