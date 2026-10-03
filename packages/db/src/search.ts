/**
 * Typed wrapper for global full-text search (migration 0063): `search_all`. Owned by task T15
 * (docs/orchestration/PLAN.md section 3); behaviour: docs/database.md, "Views, search and activity
 * (T15)".
 *
 * It searches the titles and pitches of ideas that are not archived and the latest revision of each
 * (idea, kind) of their scripts, with the `english` configuration and web-search syntax (quoted
 * phrases, `or`, `-exclusion`). The CALLER decides what the token may read and passes exactly those
 * resources: a service passes the ones its token can Read and never a default. Any query text is
 * accepted (a query without a searchable word finds nothing); only its first
 * {@link SEARCH_QUERY_MAX_CHARS} characters count.
 *
 * Snippets are plain text with {@link SEARCH_HIGHLIGHT_START} and {@link SEARCH_HIGHLIGHT_STOP}
 * around the matches; everything else in them is the author's text (it can contain `<`, `&` or
 * markdown) and must be escaped before it is shown as HTML. {@link snippetSegments} splits one into
 * safe pieces.
 */
import type { ScriptKind } from "@ytw/shared/constants";
import { rejectNul } from "./args.js";
import type { Queryable } from "./client.js";
import { formatAllowed, toDbError, ValidationError } from "./errors.js";

/** The resources `search_all` can search, named as in `RESOURCES` of `@ytw/shared`. */
export const SEARCH_RESOURCES = ["ideas", "scripts"] as const;
export type SearchResource = (typeof SEARCH_RESOURCES)[number];

/** Results returned when no limit is given. */
export const SEARCH_LIMIT_DEFAULT = 20;
/** The largest limit; a bigger one is a validation error. */
export const SEARCH_LIMIT_MAX = 50;
/** Only this many leading characters of a query are used. */
export const SEARCH_QUERY_MAX_CHARS = 1000;
/** The longest snippet, in characters, markers included. */
export const SEARCH_SNIPPET_MAX_CHARS = 400;
/** Opens a highlighted match in a snippet (U+27E6). Never occurs in a snippet otherwise. */
export const SEARCH_HIGHLIGHT_START = String.fromCodePoint(0x27e6);
/** Closes a highlighted match in a snippet (U+27E7). */
export const SEARCH_HIGHLIGHT_STOP = String.fromCodePoint(0x27e7);

/** What kind of record a hit is, as `events.entity_type` names it. */
export type SearchEntityType = "idea" | "script";

export interface SearchHit {
  entityType: SearchEntityType;
  /** The idea's id, or the script revision's id (the revision that matched, always the latest). */
  id: string;
  /** The idea: its own id for an idea hit, the owner of the revision for a script hit. */
  ideaId: string;
  /** The script kind of a script hit; null for an idea. */
  kind: ScriptKind | null;
  /** The revision number of a script hit; null for an idea. */
  version: number | null;
  /**
   * The idea's title. Null for a script hit when `ideas` was not among the searched resources: the
   * title is idea data and the caller may not read it.
   */
  title: string | null;
  /**
   * `ts_rank` scaled into [0, 1): higher is better and only comparable within one result. A match
   * in an idea's title outranks one in its pitch, which outranks any number of matches in a script
   * body; within one field more occurrences rank higher.
   */
  rank: number;
  /** Plain text of at most {@link SEARCH_SNIPPET_MAX_CHARS} characters with the match markers. */
  snippet: string;
}

export interface SearchAllInput {
  /** What to look for; any text. */
  query: string;
  /** The resources to search: the subset of `ideas` and `scripts` the caller may read. */
  resources: readonly SearchResource[];
  /** 1 to {@link SEARCH_LIMIT_MAX} (default {@link SEARCH_LIMIT_DEFAULT}). */
  limit?: number;
}

interface SearchRow {
  entityType: SearchEntityType;
  id: string;
  ideaId: string;
  kind: ScriptKind | null;
  version: number | null;
  title: string | null;
  rank: number;
  snippet: string;
}

/**
 * Runs the search. Best matches first (ties in a fixed order); an empty array when nothing
 * matches, the query has no searchable word, or `resources` is empty.
 */
export async function searchAll(db: Queryable, input: SearchAllInput): Promise<SearchHit[]> {
  if (typeof input.query !== "string") {
    throw new ValidationError("query must be a string", { field: "query" });
  }
  rejectNul("query", input.query);
  const resources: readonly string[] = input.resources;
  if (!Array.isArray(resources)) {
    throw new ValidationError(
      `resources is required: list the resources the caller may read, from ${formatAllowed(SEARCH_RESOURCES)}`,
      { field: "resources", allowed: [...SEARCH_RESOURCES] },
    );
  }
  for (const resource of resources) {
    if (!(SEARCH_RESOURCES as readonly string[]).includes(resource)) {
      throw new ValidationError(
        `resources may only list ${formatAllowed(SEARCH_RESOURCES)} (got ${JSON.stringify(String(resource).slice(0, 60))})`,
        { field: "resources", allowed: [...SEARCH_RESOURCES] },
      );
    }
  }
  const limit = input.limit ?? SEARCH_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) {
    throw new ValidationError(
      `limit must be a whole number from 1 to ${String(SEARCH_LIMIT_MAX)} (got ${String(limit)})`,
      { field: "limit", value: String(limit), min: 1, max: SEARCH_LIMIT_MAX },
    );
  }
  try {
    const { rows } = await db.query<SearchRow>(
      `SELECT entity_type AS "entityType", id, idea_id AS "ideaId", kind, version, title, rank,
              snippet
         FROM public.search_all($1::text, $2::integer, $3::text[])`,
      [input.query, limit, [...resources]],
    );
    return rows;
  } catch (err) {
    throw toDbError(err);
  }
}

/** A piece of a snippet: the text and whether the search matched it. */
export interface SnippetSegment {
  text: string;
  highlight: boolean;
}

/**
 * Splits a snippet at its match markers into pieces a UI can render safely: put `text` in a text
 * node (or escape it) and wrap the pieces with `highlight` in `<mark>`. An unbalanced marker (which
 * the database never produces) is ignored. Empty pieces are left out.
 */
export function snippetSegments(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let highlight = false;
  let text = "";
  const flush = (): void => {
    if (text !== "") {
      segments.push({ text, highlight });
      text = "";
    }
  };
  for (const char of snippet) {
    if (char === SEARCH_HIGHLIGHT_START) {
      flush();
      highlight = true;
    } else if (char === SEARCH_HIGHLIGHT_STOP) {
      flush();
      highlight = false;
    } else {
      text += char;
    }
  }
  flush();
  return segments;
}
