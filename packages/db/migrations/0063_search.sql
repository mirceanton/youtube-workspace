-- 0063_search: global full-text search over idea titles, idea pitches and script bodies (PRD 6
-- "Search", T15). One function, search_all(query, limit, resources), for the web UI and the MCP
-- tools. Details and the marker format: docs/database.md, "Views, search and activity (T15)".
--
-- What it searches. Ideas that are not archived (title weight A, pitch weight B: the stored
-- search_vector of T11) and the LATEST revision of each (idea, kind) of those ideas' scripts (the
-- body, weight D). Older revisions are never searched, so a document is one hit however often it was
-- saved, and what was removed from the latest text cannot be found any more. The query goes through
-- websearch_to_tsquery('english', ...), the configuration the vectors were built with.
--
-- Rank. ts_rank scaled into [0, 1) (flag 32: rank / (rank + 1)), without length normalisation, so
-- that the field weights decide: a match in a title (weight A) outranks one in a pitch (B), which
-- outranks any number of matches in a script body (D); within one field more occurrences rank
-- higher. Ties are ordered by entity type, then id, so the order is the same every time. Ranks are
-- only comparable within one result.
--
-- Permissions. The function cannot know what the caller's token may read, so the SERVICE passes the
-- resources it may read ('ideas', 'scripts'; PRD 7) and the function searches exactly those: no
-- default, NULL or an unknown name is a validation error, an empty list finds nothing. A script hit
-- carries its idea's title only when 'ideas' is listed too (a title is idea data).
--
-- Robustness. Whatever the query text is (empty, NULL, only stop words, operator soup, unbalanced
-- quotes, 10 MB of noise) the function answers with rows or with none, never with an error:
-- websearch_to_tsquery accepts any text, and only the first 1000 characters are used. The limit is
-- 1 to 50 (NULL means 20), anything else is a validation error that names the range.
--
-- SECURITY INVOKER: it reads ideas and scripts with the caller's own privileges, so it cannot show
-- more than the caller could select. Executable by ytw_web and ytw_mcp only (ytw_readonly never
-- runs application functions). Because it must not call helpers that application roles cannot
-- execute, errors are raised with the catalogue SQLSTATE directly (YT001 = validation, the code
-- ytw_raise uses) instead of through ytw_raise.
--
-- Snippet. Plain text of at most 400 characters; the matched words are wrapped in U+27E6 (start) and
-- U+27E7 (stop). Those two characters are removed from the source text first, so a marker is always
-- one this function put there. Everything else in the snippet is the author's text and must be
-- escaped before it is shown as HTML. Whitespace and control characters are collapsed to single
-- spaces. A script body is highlighted only up to its first 100 000 characters (ts_headline costs
-- time in proportion to the text it parses): a match further in is still found and ranked, but its
-- snippet is the start of the body without markers.

CREATE FUNCTION public.search_all(p_query text, p_limit integer, p_resources text[])
RETURNS TABLE (
  entity_type text,
  id uuid,
  idea_id uuid,
  kind text,
  version integer,
  title text,
  rank real,
  snippet text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  c_mark_start constant text := U&'\27E6';
  c_mark_stop constant text := U&'\27E7';
  c_default_limit constant integer := 20;
  c_max_limit constant integer := 50;
  c_max_query_chars constant integer := 1000;
  c_snippet_chars constant integer := 400;
  c_source_chars constant integer := 100000;
  c_headline_options constant text :=
    'StartSel=' || U&'\27E6' || ', StopSel=' || U&'\27E7' || ', MaxWords=35, MinWords=15, MaxFragments=0';
  v_limit integer := coalesce(p_limit, c_default_limit);
  v_ideas boolean;
  v_scripts boolean;
  v_query tsquery;
  v_hit record;
  v_snippet text;
BEGIN
  IF p_resources IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'YT001',
      MESSAGE = 'resources is required: list the resources the caller may read, from "ideas" and "scripts" (an empty list searches nothing)',
      DETAIL = '{"field": "resources", "allowed": ["ideas", "scripts"]}';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_resources) AS r (name) WHERE r.name IS NULL OR r.name NOT IN ('ideas', 'scripts')) THEN
    RAISE EXCEPTION USING ERRCODE = 'YT001',
      MESSAGE = format('resources may only list "ideas" and "scripts" (got %s)',
                       to_json(left(array_to_string(p_resources, ','), 60))::text),
      DETAIL = '{"field": "resources", "allowed": ["ideas", "scripts"]}';
  END IF;
  IF v_limit < 1 OR v_limit > c_max_limit THEN
    RAISE EXCEPTION USING ERRCODE = 'YT001',
      MESSAGE = format('limit must be a whole number from 1 to %s (got %s)', c_max_limit, v_limit),
      DETAIL = jsonb_build_object('field', 'limit', 'value', v_limit, 'min', 1, 'max', c_max_limit)::text;
  END IF;

  v_ideas := 'ideas' = ANY (p_resources);
  v_scripts := 'scripts' = ANY (p_resources);
  IF NOT (v_ideas OR v_scripts) THEN
    RETURN;
  END IF;

  -- Any text is a query; one without a searchable word (empty, stop words, punctuation) finds nothing.
  v_query := websearch_to_tsquery('english', btrim(left(coalesce(p_query, ''), c_max_query_chars)));
  IF numnode(v_query) = 0 THEN
    RETURN;
  END IF;

  FOR v_hit IN
    WITH hits AS (
      SELECT 'idea'::text AS entity_type, i.id, i.id AS idea_id, NULL::text AS kind,
             NULL::integer AS version, i.title, ts_rank(i.search_vector, v_query, 32) AS rank
      FROM public.ideas i
      WHERE v_ideas AND i.archived_at IS NULL AND i.search_vector @@ v_query
      UNION ALL
      SELECT 'script'::text, s.id, s.idea_id, s.kind, s.version,
             CASE WHEN v_ideas THEN i.title END, ts_rank(s.search_vector, v_query, 32)
      FROM public.scripts s
      JOIN public.ideas i ON i.id = s.idea_id
      WHERE v_scripts AND i.archived_at IS NULL AND s.search_vector @@ v_query
        AND NOT EXISTS (
          SELECT 1 FROM public.scripts newer
          WHERE newer.idea_id = s.idea_id AND newer.kind = s.kind AND newer.version > s.version)
    ),
    top AS (
      SELECT h.* FROM hits h ORDER BY h.rank DESC, h.entity_type, h.id LIMIT v_limit
    )
    SELECT t.entity_type, t.id, t.idea_id, t.kind, t.version, t.title, t.rank,
           CASE WHEN t.entity_type = 'idea' THEN concat_ws(E'\n', i.title, i.pitch)
                ELSE substr(s.body_md, 1, c_source_chars) END AS source
    FROM top t
    LEFT JOIN public.ideas i ON t.entity_type = 'idea' AND i.id = t.id
    LEFT JOIN public.scripts s ON t.entity_type = 'script' AND s.id = t.id
    ORDER BY t.rank DESC, t.entity_type, t.id
  LOOP
    v_snippet := ts_headline('english', translate(v_hit.source, c_mark_start || c_mark_stop, ''),
                             v_query, c_headline_options);
    v_snippet := btrim(regexp_replace(v_snippet, '[[:space:][:cntrl:]]+', ' ', 'g'));
    IF char_length(v_snippet) > c_snippet_chars THEN
      -- One character short of the cap, so that closing an unfinished highlight still fits.
      v_snippet := left(v_snippet, c_snippet_chars - 1);
      IF char_length(v_snippet) - char_length(replace(v_snippet, c_mark_start, ''))
         > char_length(v_snippet) - char_length(replace(v_snippet, c_mark_stop, '')) THEN
        v_snippet := v_snippet || c_mark_stop;
      END IF;
    END IF;

    entity_type := v_hit.entity_type;
    id := v_hit.id;
    idea_id := v_hit.idea_id;
    kind := v_hit.kind;
    version := v_hit.version;
    title := v_hit.title;
    rank := v_hit.rank;
    snippet := v_snippet;
    RETURN NEXT;
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION public.search_all(text, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_all(text, integer, text[]) TO ytw_web, ytw_mcp;

COMMENT ON FUNCTION public.search_all(text, integer, text[]) IS
  'Full-text search (websearch syntax, english) over idea titles/pitches and the latest script revisions: search_all(query, limit 1-50, resources subset of {ideas, scripts}). Returns entity_type, id, idea_id, kind, version, title, rank and a plain-text snippet with U+27E6/U+27E7 around the matches.';
