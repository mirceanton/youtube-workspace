-- 0030_function_helpers: internal helpers for the write functions of 0031-0039 (T12): how to print a
-- caller's value inside an error message, and the three errors every idea or script function raises
-- the same way. Conventions: docs/database.md ("Database function convention", "Errors").
--
-- None of these is executable by an application role (REVOKE ALL ... FROM PUBLIC and no grant). They
-- run inside the SECURITY DEFINER functions, i.e. as the function owner, so an application role can
-- reach them only through a public function that has validated its arguments first.

-- Prints a caller-supplied value for an error message: JSON-quoted, so quotes, newlines and control
-- characters cannot break the sentence or forge a second one, and cut after 60 characters, so a
-- 1 MiB argument is never echoed back.
CREATE FUNCTION public.ytw_fmt_value(p_value text)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_value IS NULL THEN 'NULL'
    WHEN char_length(p_value) > 60 THEN to_json(left(p_value, 60))::text || '...'
    ELSE to_json(p_value)::text
  END
$$;

REVOKE ALL ON FUNCTION public.ytw_fmt_value(text) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_fmt_value(text) IS
  'Internal: a caller value as a JSON-quoted, truncated string for error messages.';

-- Lists allowed values the way formatAllowed() of @ytw/db does: "a", "b", "c".
CREATE FUNCTION public.ytw_fmt_list(p_values text[])
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT coalesce(string_agg(to_json(v.item)::text, ', ' ORDER BY v.ord), '')
  FROM unnest(p_values) WITH ORDINALITY AS v (item, ord)
$$;

REVOKE ALL ON FUNCTION public.ytw_fmt_list(text[]) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_fmt_list(text[]) IS
  'Internal: allowed values as "a", "b", "c" for error messages.';

-- not_found: the record a caller named does not exist.
CREATE FUNCTION public.ytw_raise_not_found(p_entity text, p_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.ytw_raise(
    'not_found',
    format('%s %s does not exist: check the id', p_entity, p_id),
    jsonb_build_object('entity', p_entity, 'id', p_id));
END
$$;

REVOKE ALL ON FUNCTION public.ytw_raise_not_found(text, uuid) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_raise_not_found(text, uuid) IS
  'Internal: raise not_found for an entity id.';

-- version_conflict on a row that carries a version column (ideas): says what the caller sent, what
-- is current, and what to do. The latest version is also in DETAIL for programs.
CREATE FUNCTION public.ytw_raise_version_conflict(
  p_entity text, p_id uuid, p_expected integer, p_latest integer
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.ytw_raise(
    'version_conflict',
    format('%s %s has changed since you read it: you sent expected_version %s but the latest version is %s; reload it, apply your change again and retry with expected_version %s',
           p_entity, p_id, p_expected, p_latest, p_latest),
    jsonb_build_object('entity', p_entity, 'id', p_id,
                       'expected_version', p_expected, 'latest_version', p_latest));
END
$$;

REVOKE ALL ON FUNCTION public.ytw_raise_version_conflict(text, uuid, integer, integer) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_raise_version_conflict(text, uuid, integer, integer) IS
  'Internal: raise version_conflict (entity, id, expected, latest).';

-- invalid_transition: an archived idea (soft-deleted, PRD 4) is frozen. `p_what` completes the
-- sentence "... and cannot be <p_what>".
CREATE FUNCTION public.ytw_raise_idea_archived(p_id uuid, p_what text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.ytw_raise(
    'invalid_transition',
    format('idea %s is archived and cannot be %s', p_id, p_what),
    jsonb_build_object('entity', 'idea', 'id', p_id, 'reason', 'archived'),
    'Archived ideas are read-only. Create a new idea instead.');
END
$$;

REVOKE ALL ON FUNCTION public.ytw_raise_idea_archived(uuid, text) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_raise_idea_archived(uuid, text) IS
  'Internal: raise invalid_transition (reason archived) for an archived idea.';
