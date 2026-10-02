-- 0032_script_functions: the only write paths for scripts (PRD 4 "Integrity rules"; PRD 5
-- save_script_version, set_script_status). Conventions: docs/database.md.
--
--   save_script_version  appends the next revision of an idea's script or packaging doc, if the
--                        caller edited the latest one (optimistic concurrency without a version
--                        column: scripts are append-only)
--   set_script_status    the one thing about a saved revision that may change: draft, review, approved
--
-- kind and status mirror SCRIPT_KINDS and SCRIPT_STATUSES, and the body limit SCRIPT_BODY_MAX_BYTES,
-- of @ytw/shared (packages/db/test/scripts.test.ts checks all three). A violated CHECK is a bare
-- SQLSTATE 23514, so the limits are validated here first with readable errors.

-- version_conflict for scripts: the caller's base_version is not the latest. The message tells an
-- agent exactly what to do next; DETAIL carries latest_version (0 = nothing saved yet).
CREATE FUNCTION public.ytw_raise_script_conflict(
  p_idea_id uuid, p_kind text, p_base_version integer, p_latest integer
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.ytw_raise(
    'version_conflict',
    CASE
      WHEN p_latest = 0 THEN
        format('idea %s has no saved %s yet, so base_version must be 0 (you sent %s): save the first version with base_version 0',
               p_idea_id, p_kind, p_base_version)
      ELSE
        format('base_version %s is not the latest %s version of idea %s: the latest is version %s; fetch version %s, merge your changes into it and save again with base_version %s',
               p_base_version, p_kind, p_idea_id, p_latest, p_latest, p_latest)
    END,
    jsonb_build_object('entity', 'script', 'idea_id', p_idea_id, 'kind', p_kind,
                       'expected_version', p_base_version, 'latest_version', p_latest));
END
$$;

REVOKE ALL ON FUNCTION public.ytw_raise_script_conflict(uuid, text, integer, integer) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_raise_script_conflict(uuid, text, integer, integer) IS
  'Internal: raise version_conflict for save_script_version (idea, kind, base, latest).';

-- save_script_version: inserts version latest + 1 as a draft, provided p_base_version equals the
-- latest version of (idea, kind); the first version has base 0. Otherwise it raises version_conflict
-- carrying the latest version number, so the caller can fetch it, merge and retry.
--
-- Concurrency: writers of one idea queue on the idea's row lock (FOR NO KEY UPDATE, the lock a plain
-- UPDATE takes, so inserts of videos that reference the idea are not held up). The second of two
-- racing saves with the same base therefore reads the winner's version after the lock is released
-- and fails the base check; the unique key (idea_id, kind, version) is the last line of defence and
-- is turned into the same error. The same lock stops a save from slipping in while the idea is
-- being archived. The body is stored exactly as given: @ytw/script-md has already normalised it.
-- The result is the saved row (it includes body_md: wrappers select the columns they need).
CREATE FUNCTION public.save_script_version(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_idea_id uuid, p_kind text, p_base_version integer, p_body_md text
)
RETURNS public.scripts
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_kinds CONSTANT text[] := ARRAY['script', 'packaging'];
  c_max_bytes CONSTANT integer := 1048576;
  v_archived_at timestamptz;
  v_latest integer;
  v_row public.scripts;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_idea_id IS NULL THEN
    PERFORM public.ytw_raise('validation', 'idea_id is required: pass the id of the idea the script belongs to',
                             jsonb_build_object('field', 'idea_id'));
  END IF;
  IF p_kind IS NULL OR NOT p_kind = ANY (c_kinds) THEN
    PERFORM public.ytw_raise('validation',
      format('kind %s is not valid; valid kinds: %s', public.ytw_fmt_value(p_kind), public.ytw_fmt_list(c_kinds)),
      jsonb_build_object('field', 'kind', 'value', left(p_kind, 60), 'allowed', to_jsonb(c_kinds)));
  END IF;
  IF p_base_version IS NULL OR p_base_version < 0 THEN
    PERFORM public.ytw_raise('validation',
      'base_version is required: pass the version you edited (the latest version number), or 0 when no version exists yet',
      jsonb_build_object('field', 'base_version'));
  END IF;
  IF p_body_md IS NULL THEN
    PERFORM public.ytw_raise('validation',
      'body_md is required (an empty string is allowed): pass the markdown without front matter',
      jsonb_build_object('field', 'body_md'));
  END IF;
  IF octet_length(p_body_md) > c_max_bytes THEN
    PERFORM public.ytw_raise('validation',
      format('body_md is too large: %s bytes, the limit is %s (1 MiB of UTF-8)', octet_length(p_body_md), c_max_bytes),
      jsonb_build_object('field', 'body_md', 'bytes', octet_length(p_body_md), 'max_bytes', c_max_bytes));
  END IF;

  SELECT i.archived_at INTO v_archived_at FROM public.ideas AS i WHERE i.id = p_idea_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_not_found('idea', p_idea_id);
  END IF;
  IF v_archived_at IS NOT NULL THEN
    PERFORM public.ytw_raise_idea_archived(p_idea_id, 'given new script versions');
  END IF;

  SELECT coalesce(max(s.version), 0) INTO v_latest
  FROM public.scripts AS s WHERE s.idea_id = p_idea_id AND s.kind = p_kind;
  IF p_base_version <> v_latest THEN
    PERFORM public.ytw_raise_script_conflict(p_idea_id, p_kind, p_base_version, v_latest);
  END IF;

  BEGIN
    INSERT INTO public.scripts (idea_id, kind, version, body_md)
    VALUES (p_idea_id, p_kind, v_latest + 1, p_body_md)
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    -- Someone inserted this version without taking the idea lock (a repeatable-read caller, or a
    -- tool that bypasses this function): report it as the conflict it is.
    SELECT coalesce(max(s.version), 0) INTO v_latest
    FROM public.scripts AS s WHERE s.idea_id = p_idea_id AND s.kind = p_kind;
    PERFORM public.ytw_raise_script_conflict(p_idea_id, p_kind, p_base_version, v_latest);
  END;
  RETURN v_row;
END
$$;

REVOKE ALL ON FUNCTION public.save_script_version(text, text, uuid, uuid, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_script_version(text, text, uuid, uuid, text, integer, text)
  TO ytw_web, ytw_mcp;

COMMENT ON FUNCTION public.save_script_version(text, text, uuid, uuid, text, integer, text) IS
  'Append the next draft revision of an idea''s script or packaging doc if base_version is the latest (0 for the first). Errors: validation, not_found, invalid_transition (archived idea), version_conflict (latest_version).';

-- set_script_status: draft, review or approved, for one saved revision, in any order. The only
-- column of a saved revision that may change (the append-only guard of 0015 allows exactly this).
-- Setting the status a revision already has changes nothing and writes no audit row.
CREATE FUNCTION public.set_script_status(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_script_id uuid, p_status text
)
RETURNS public.scripts
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_statuses CONSTANT text[] := ARRAY['draft', 'review', 'approved'];
  v_row public.scripts;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_script_id IS NULL THEN
    PERFORM public.ytw_raise('validation',
      'script_id is required: pass the id of the saved script revision (not the idea id)',
      jsonb_build_object('field', 'script_id'));
  END IF;
  IF p_status IS NULL OR NOT p_status = ANY (c_statuses) THEN
    PERFORM public.ytw_raise('validation',
      format('status %s is not valid; valid statuses: %s', public.ytw_fmt_value(p_status), public.ytw_fmt_list(c_statuses)),
      jsonb_build_object('field', 'status', 'value', left(p_status, 60), 'allowed', to_jsonb(c_statuses)));
  END IF;

  SELECT * INTO v_row FROM public.scripts WHERE id = p_script_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_not_found('script', p_script_id);
  END IF;
  IF v_row.status = p_status THEN
    RETURN v_row;
  END IF;

  UPDATE public.scripts SET status = p_status WHERE id = p_script_id RETURNING * INTO v_row;
  RETURN v_row;
END
$$;

REVOKE ALL ON FUNCTION public.set_script_status(text, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_script_status(text, text, uuid, uuid, text) TO ytw_web, ytw_mcp;

COMMENT ON FUNCTION public.set_script_status(text, text, uuid, uuid, text) IS
  'Set the review status (draft, review, approved) of one saved script revision. Errors: validation, not_found.';
