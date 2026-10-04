import { z } from "zod";
import { SCRIPT_KINDS } from "../enums.js";

export const SEARCH_PATH = "/api/search";
export const SEARCH_QUERY_MAX_CHARS = 1000;
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_HIGHLIGHT_START = "⟦";
export const SEARCH_HIGHLIGHT_STOP = "⟧";

export const searchQuerySchema = z.object({
  q: z.string().max(SEARCH_QUERY_MAX_CHARS),
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).default(SEARCH_LIMIT_DEFAULT),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchResultSchema = z.object({
  entity_type: z.enum(["idea", "script"]),
  id: z.uuid(),
  idea_id: z.uuid(),
  kind: z.enum(SCRIPT_KINDS).nullable(),
  version: z.number().int().positive().nullable(),
  title: z.string().nullable(),
  rank: z.number().finite().min(0).max(1),
  snippet: z.string().max(400),
});

export const searchResponseSchema = z.object({ results: z.array(searchResultSchema) });
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export interface SearchSnippetSegment {
  text: string;
  highlight: boolean;
}

/** Split database match markers into text safe for rendering as React text nodes. */
export function searchSnippetSegments(snippet: string): SearchSnippetSegment[] {
  const segments: SearchSnippetSegment[] = [];
  let highlighted = false;
  let text = "";
  const flush = () => {
    if (text) segments.push({ text, highlight: highlighted });
    text = "";
  };
  for (const character of snippet) {
    if (character === SEARCH_HIGHLIGHT_START) {
      flush();
      highlighted = true;
    } else if (character === SEARCH_HIGHLIGHT_STOP) {
      flush();
      highlighted = false;
    } else {
      text += character;
    }
  }
  flush();
  return segments;
}
