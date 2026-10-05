-- 0031_idea_functions: the only write paths for ideas (PRD 4 "Idea stages", "Integrity rules";
-- PRD 5 create_idea, update_idea, advance_idea). Conventions: docs/database.md.
--
--   create_idea    inserts an idea in the inbox
--   update_idea    edits title, pitch, source, tags and score; needs the version the caller read
--   advance_idea   the stage machine; a move back needs a note, which is written in the same call
--   archive_idea   soft delete (archived_at); an archived idea is frozen
--
-- The stage rules below mirror IDEA_STAGES and IDEA_STAGE_TRANSITIONS of @ytw/shared;
-- packages/db/test/ideas.test.ts compares them row by row and drives advance_idea through every
-- (from, to) pair. The field limits mirror the CHECK constraints of 0014_ideas: a violated CHECK
-- is a bare SQLSTATE 23514, so every limit is validated here first with a readable error.

-- 1. The stage machine as data.
CREATE FUNCTION public.ytw_idea_stages()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT ARRAY['inbox', 'shortlisted', 'scripting', 'filming', 'editing', 'published', 'dropped']
$$;

REVOKE ALL ON FUNCTION public.ytw_idea_stages() FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_idea_stages() IS
  'Internal: every idea stage in pipeline order, dropped last (IDEA_STAGES).';

-- Every allowed move, in the order of IDEA_STAGE_TRANSITIONS. Anything not listed is rejected.
--   forward: one stage ahead;  backward: one stage back, note required;
--   drop: any pipeline stage to dropped;  restore: dropped back to the inbox.
CREATE FUNCTION public.ytw_idea_stage_transitions()
RETURNS TABLE (from_stage text, to_stage text, kind text, requires_note boolean)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  VALUES
    ('inbox', 'shortlisted', 'forward', false),
    ('shortlisted', 'scripting', 'forward', false),
    ('scripting', 'filming', 'forward', false),
    ('filming', 'editing', 'forward', false),
    ('editing', 'published', 'forward', false),

    ('shortlisted', 'inbox', 'backward', true),
    ('scripting', 'shortlisted', 'backward', true),
    ('filming', 'scripting', 'backward', true),
    ('editing', 'filming', 'backward', true),
    ('published', 'editing', 'backward', true),

    ('inbox', 'dropped', 'drop', false),
    ('shortlisted', 'dropped', 'drop', false),
    ('scripting', 'dropped', 'drop', false),
    ('filming', 'dropped', 'drop', false),
    ('editing', 'dropped', 'drop', false),
    ('published', 'dropped', 'drop', false),

    ('dropped', 'inbox', 'restore', false)
$$;

REVOKE ALL ON FUNCTION public.ytw_idea_stage_transitions() FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_idea_stage_transitions() IS
  'Internal: allowed idea stage moves (IDEA_STAGE_TRANSITIONS); advance_idea is the only caller.';

-- 2. Field validation shared by create_idea and update_idea. `p_value` is the field as JSON, so a
--    wrongly typed value ("score": "high") is reported instead of being cast. SQL NULL counts as
--    JSON null. Raises validation (field, plus the limits) with a message that says what to send.
CREATE FUNCTION public.ytw_check_idea_field(p_field text, p_value jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_type text := coalesce(jsonb_typeof(p_value), 'null');
  v_got text := CASE v_type
    WHEN 'string' THEN 'text'
    WHEN 'number' THEN 'a number'
    WHEN 'boolean' THEN 'true or false'
    WHEN 'array' THEN 'a list'
    WHEN 'object' THEN 'an object'
    ELSE 'null'
  END;
  v_text text;
  v_number numeric;
  v_tag record;
BEGIN
  IF p_field = 'title' THEN
    IF v_type <> 'string' THEN
      PERFORM public.ytw_raise('validation',
        format('title is required: give the idea a title of 1-500 characters (got %s)', v_got),
        jsonb_build_object('field', 'title'));
    END IF;
    v_text := p_value #>> '{}';
    IF v_text ~ '^[[:space:]]*$' THEN
      PERFORM public.ytw_raise('validation',
        'title is required: it cannot be empty or only whitespace',
        jsonb_build_object('field', 'title'));
    END IF;
    IF char_length(v_text) > 500 THEN
      PERFORM public.ytw_raise('validation',
        format('title is too long: %s characters, the limit is 500', char_length(v_text)),
        jsonb_build_object('field', 'title', 'length', char_length(v_text), 'max_length', 500));
    END IF;

  ELSIF p_field = 'pitch' THEN
    IF v_type = 'null' THEN
      RETURN;
    END IF;
    IF v_type <> 'string' THEN
      PERFORM public.ytw_raise('validation',
        format('pitch must be text of at most 20000 characters, or null (got %s)', v_got),
        jsonb_build_object('field', 'pitch'));
    END IF;
    v_text := p_value #>> '{}';
    IF char_length(v_text) > 20000 THEN
      PERFORM public.ytw_raise('validation',
        format('pitch is too long: %s characters, the limit is 20000', char_length(v_text)),
        jsonb_build_object('field', 'pitch', 'length', char_length(v_text), 'max_length', 20000));
    END IF;

  ELSIF p_field = 'source' THEN
    IF v_type = 'null' THEN
      RETURN;
    END IF;
    IF v_type <> 'string' THEN
      PERFORM public.ytw_raise('validation',
        format('source must be text of 1-200 characters, or null when unknown (got %s)', v_got),
        jsonb_build_object('field', 'source'));
    END IF;
    v_text := p_value #>> '{}';
    IF v_text ~ '^[[:space:]]*$' THEN
      PERFORM public.ytw_raise('validation',
        'source cannot be empty or only whitespace: name where the idea came from, or pass null when unknown',
        jsonb_build_object('field', 'source'));
    END IF;
    IF char_length(v_text) > 200 THEN
      PERFORM public.ytw_raise('validation',
        format('source is too long: %s characters, the limit is 200', char_length(v_text)),
        jsonb_build_object('field', 'source', 'length', char_length(v_text), 'max_length', 200));
    END IF;

  ELSIF p_field = 'tags' THEN
    IF v_type <> 'array' THEN
      PERFORM public.ytw_raise('validation',
        format('tags must be a list of text values such as ["rust", "performance"]; pass [] for no tags (got %s)', v_got),
        jsonb_build_object('field', 'tags'));
    END IF;
    IF jsonb_array_length(p_value) > 50 THEN
      PERFORM public.ytw_raise('validation',
        format('too many tags: %s, the limit is 50', jsonb_array_length(p_value)),
        jsonb_build_object('field', 'tags', 'count', jsonb_array_length(p_value), 'max_count', 50));
    END IF;
    FOR v_tag IN
      SELECT e.item, e.ord FROM jsonb_array_elements(p_value) WITH ORDINALITY AS e (item, ord)
      ORDER BY e.ord
    LOOP
      IF jsonb_typeof(v_tag.item) <> 'string' THEN
        PERFORM public.ytw_raise('validation',
          format('tag number %s must be text, not %s', v_tag.ord,
                 CASE jsonb_typeof(v_tag.item) WHEN 'number' THEN 'a number' WHEN 'boolean' THEN 'true or false'
                      WHEN 'array' THEN 'a list' WHEN 'object' THEN 'an object' ELSE 'null' END),
          jsonb_build_object('field', 'tags', 'position', v_tag.ord));
      END IF;
      v_text := v_tag.item #>> '{}';
      IF v_text = '' THEN
        PERFORM public.ytw_raise('validation',
          format('tag number %s is empty: tags need 1-64 characters', v_tag.ord),
          jsonb_build_object('field', 'tags', 'position', v_tag.ord));
      END IF;
      IF v_text <> btrim(v_text) THEN
        PERFORM public.ytw_raise('validation',
          format('tag %s starts or ends with spaces: remove them', public.ytw_fmt_value(v_text)),
          jsonb_build_object('field', 'tags', 'value', left(v_text, 60)));
      END IF;
      IF char_length(v_text) > 64 THEN
        PERFORM public.ytw_raise('validation',
          format('tag %s is too long: %s characters, the limit is 64', public.ytw_fmt_value(v_text), char_length(v_text)),
          jsonb_build_object('field', 'tags', 'value', left(v_text, 60), 'max_length', 64));
      END IF;
      IF v_text ~ '[[:cntrl:]]' THEN
        PERFORM public.ytw_raise('validation',
          format('tag %s contains control characters (newlines, tabs, ...): use plain text', public.ytw_fmt_value(v_text)),
          jsonb_build_object('field', 'tags', 'value', left(v_text, 60)));
      END IF;
    END LOOP;
    SELECT t.item INTO v_text
    FROM jsonb_array_elements_text(p_value) AS t (item)
    GROUP BY t.item HAVING count(*) > 1
    ORDER BY t.item LIMIT 1;
    IF FOUND THEN
      PERFORM public.ytw_raise('validation',
        format('tags must be distinct: %s appears more than once', public.ytw_fmt_value(v_text)),
        jsonb_build_object('field', 'tags', 'value', left(v_text, 60)));
    END IF;
    -- The CHECK constraint's own predicate, so nothing it rejects can get past the messages above.
    IF NOT public.ytw_valid_tags(ARRAY(SELECT jsonb_array_elements_text(p_value))) THEN
      PERFORM public.ytw_raise('validation',
        'tags are not valid: use at most 50 distinct tags of 1-64 characters, without surrounding spaces or control characters',
        jsonb_build_object('field', 'tags'));
    END IF;

  ELSIF p_field = 'score' THEN
    IF v_type = 'null' THEN
      RETURN;
    END IF;
    IF v_type <> 'number' THEN
      PERFORM public.ytw_raise('validation',
        format('score must be a whole number from 0 to 100, or null to clear it (got %s)', v_got),
        jsonb_build_object('field', 'score'));
    END IF;
    v_number := (p_value #>> '{}')::numeric;
    IF v_number <> trunc(v_number) OR v_number < 0 OR v_number > 100 THEN
      PERFORM public.ytw_raise('validation',
        format('score must be a whole number from 0 to 100 (got %s)', left(p_value #>> '{}', 40)),
        jsonb_build_object('field', 'score', 'value', left(p_value #>> '{}', 40)));
    END IF;

  ELSE
    RAISE EXCEPTION 'ytw_check_idea_field: unknown field %', p_field;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.ytw_check_idea_field(text, jsonb) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_check_idea_field(text, jsonb) IS
  'Internal: validate one editable idea field (title, pitch, source, tags, score) given as JSON.';

-- 3. create_idea: a new idea always starts in the inbox (PRD 5). Only title is required.
CREATE FUNCTION public.create_idea(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_title text,
  p_pitch text DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_tags text[] DEFAULT '{}',
  p_score integer DEFAULT NULL
)
RETURNS public.ideas
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tags text[] := coalesce(p_tags, '{}'::text[]);
  v_idea public.ideas;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  PERFORM public.ytw_check_idea_field('title', to_jsonb(p_title));
  PERFORM public.ytw_check_idea_field('pitch', to_jsonb(p_pitch));
  PERFORM public.ytw_check_idea_field('source', to_jsonb(p_source));
  PERFORM public.ytw_check_idea_field('tags', to_jsonb(v_tags));
  PERFORM public.ytw_check_idea_field('score', to_jsonb(p_score));

  INSERT INTO public.ideas (title, pitch, source, tags, score)
  VALUES (p_title, p_pitch, p_source, v_tags, p_score)
  RETURNING * INTO v_idea;
  RETURN v_idea;
END
$$;

REVOKE ALL ON FUNCTION public.create_idea(text, text, uuid, text, text, text, text[], integer) FROM PUBLIC;


COMMENT ON FUNCTION public.create_idea(text, text, uuid, text, text, text, text[], integer) IS
  'Insert an idea in the inbox. Returns the row. Errors: validation.';

-- 4. update_idea: edits the non-status fields named in p_fields (a JSON object; a key that is
--    present is set, "pitch": null clears it, an absent key is left alone). The caller passes the
--    version it read; if the idea changed since, version_conflict carries latest_version. Saving
--    values equal to the stored ones changes nothing: no new version, no audit row.
CREATE FUNCTION public.update_idea(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_id uuid, p_expected_version integer, p_fields jsonb
)
RETURNS public.ideas
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_editable CONSTANT text[] := ARRAY['title', 'pitch', 'source', 'tags', 'score'];
  v_key text;
  v_idea public.ideas;
  v_title text;
  v_pitch text;
  v_source text;
  v_tags text[];
  v_score integer;
  v_latest integer;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_id IS NULL THEN
    PERFORM public.ytw_raise('validation', 'id is required: pass the id of the idea to update',
                             jsonb_build_object('field', 'id'));
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    PERFORM public.ytw_raise('validation',
      'expected_version is required: pass the version of the idea you read (a whole number, at least 1)',
      jsonb_build_object('field', 'expected_version'));
  END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    PERFORM public.ytw_raise('validation',
      format('fields must be an object such as {"title": "New title"}; editable fields: %s',
             public.ytw_fmt_list(c_editable)),
      jsonb_build_object('field', 'fields', 'allowed', to_jsonb(c_editable)));
  END IF;
  IF p_fields = '{}'::jsonb THEN
    PERFORM public.ytw_raise('validation',
      format('fields is empty: give at least one of %s', public.ytw_fmt_list(c_editable)),
      jsonb_build_object('field', 'fields', 'allowed', to_jsonb(c_editable)));
  END IF;
  FOR v_key IN SELECT k FROM jsonb_object_keys(p_fields) AS k ORDER BY k LOOP
    IF v_key = 'status' THEN
      PERFORM public.ytw_raise('validation',
        format('status cannot be changed with update_idea: use advance_idea to move an idea between stages (stages: %s)',
               public.ytw_fmt_list(public.ytw_idea_stages())),
        jsonb_build_object('field', 'status', 'allowed', to_jsonb(c_editable)));
    END IF;
    IF NOT v_key = ANY (c_editable) THEN
      PERFORM public.ytw_raise('validation',
        format('field %s cannot be edited; editable fields: %s',
               public.ytw_fmt_value(v_key), public.ytw_fmt_list(c_editable)),
        jsonb_build_object('field', left(v_key, 60), 'allowed', to_jsonb(c_editable)));
    END IF;
    PERFORM public.ytw_check_idea_field(v_key, p_fields -> v_key);
  END LOOP;

  -- The row lock serialises writers of this idea; the version check below then sees the winner.
  SELECT * INTO v_idea FROM public.ideas WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_not_found('idea', p_id);
  END IF;
  IF v_idea.archived_at IS NOT NULL THEN
    PERFORM public.ytw_raise_idea_archived(p_id, 'edited');
  END IF;
  IF v_idea.version <> p_expected_version THEN
    PERFORM public.ytw_raise_version_conflict('idea', p_id, p_expected_version, v_idea.version);
  END IF;

  v_title := CASE WHEN p_fields ? 'title' THEN p_fields ->> 'title' ELSE v_idea.title END;
  v_pitch := CASE WHEN p_fields ? 'pitch' THEN p_fields ->> 'pitch' ELSE v_idea.pitch END;
  v_source := CASE WHEN p_fields ? 'source' THEN p_fields ->> 'source' ELSE v_idea.source END;
  v_score := CASE WHEN p_fields ? 'score' THEN (p_fields ->> 'score')::numeric::integer ELSE v_idea.score END;
  IF p_fields ? 'tags' THEN
    SELECT coalesce(array_agg(t.item ORDER BY t.ord), '{}'::text[]) INTO v_tags
    FROM jsonb_array_elements_text(p_fields -> 'tags') WITH ORDINALITY AS t (item, ord);
  ELSE
    v_tags := v_idea.tags;
  END IF;

  IF (v_title, v_pitch, v_source, v_tags, v_score)
     IS NOT DISTINCT FROM (v_idea.title, v_idea.pitch, v_idea.source, v_idea.tags, v_idea.score) THEN
    RETURN v_idea;
  END IF;

  -- The update names the version that was read: if the row lock were ever bypassed, a concurrent
  -- change finds no row here and is reported as the conflict it is, never overwritten.
  UPDATE public.ideas
     SET title = v_title, pitch = v_pitch, source = v_source, tags = v_tags, score = v_score
   WHERE id = p_id AND version = v_idea.version
  RETURNING * INTO v_idea;
  IF NOT FOUND THEN
    SELECT i.version INTO v_latest FROM public.ideas AS i WHERE i.id = p_id;
    PERFORM public.ytw_raise_version_conflict('idea', p_id, p_expected_version, v_latest);
  END IF;
  RETURN v_idea;
END
$$;

REVOKE ALL ON FUNCTION public.update_idea(text, text, uuid, uuid, integer, jsonb) FROM PUBLIC;


COMMENT ON FUNCTION public.update_idea(text, text, uuid, uuid, integer, jsonb) IS
  'Edit title, pitch, source, tags or score of an idea; p_expected_version must be the version read. Errors: validation, not_found, invalid_transition (archived), version_conflict.';

-- 5. archive_idea: soft delete (PRD 4). The idea keeps its row, scripts and notes but can no longer
--    be edited, moved or given scripts. Archiving twice is a no-op. p_expected_version is optional:
--    pass it when the caller acts on a version it read.
CREATE FUNCTION public.archive_idea(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_id uuid, p_expected_version integer DEFAULT NULL
)
RETURNS public.ideas
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_idea public.ideas;
  v_latest integer;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_id IS NULL THEN
    PERFORM public.ytw_raise('validation', 'id is required: pass the id of the idea to archive',
                             jsonb_build_object('field', 'id'));
  END IF;
  IF p_expected_version IS NOT NULL AND p_expected_version < 1 THEN
    PERFORM public.ytw_raise('validation',
      'expected_version must be a whole number of at least 1, or omitted to archive whatever the latest version is',
      jsonb_build_object('field', 'expected_version'));
  END IF;

  SELECT * INTO v_idea FROM public.ideas WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_not_found('idea', p_id);
  END IF;
  IF p_expected_version IS NOT NULL AND v_idea.version <> p_expected_version THEN
    PERFORM public.ytw_raise_version_conflict('idea', p_id, p_expected_version, v_idea.version);
  END IF;
  IF v_idea.archived_at IS NOT NULL THEN
    RETURN v_idea;
  END IF;

  UPDATE public.ideas SET archived_at = now()
   WHERE id = p_id AND version = v_idea.version
  RETURNING * INTO v_idea;
  IF NOT FOUND THEN
    SELECT i.version INTO v_latest FROM public.ideas AS i WHERE i.id = p_id;
    PERFORM public.ytw_raise_version_conflict('idea', p_id, p_expected_version, v_latest);
  END IF;
  RETURN v_idea;
END
$$;

REVOKE ALL ON FUNCTION public.archive_idea(text, text, uuid, uuid, integer) FROM PUBLIC;


COMMENT ON FUNCTION public.archive_idea(text, text, uuid, uuid, integer) IS
  'Soft-delete an idea (archived_at). Errors: validation, not_found, version_conflict.';

-- 6. advance_idea: the stage machine (PRD 4 "Idea stages"), the only way to change ideas.status.
--      forward one stage            inbox -> shortlisted -> scripting -> filming -> editing -> published
--      back one stage               needs a note, written here as a note on the idea
--      any stage -> dropped         dropped -> inbox
--    Everything else is rejected with the valid next stages in the message. p_note is stored as a
--    note on the idea whenever it is given (a reason for a drop is welcome); it is required for a
--    move back. p_expected_version is optional.
--    Returns the idea after the move and the id of the note written (NULL when there was none).
CREATE FUNCTION public.advance_idea(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_id uuid, p_new_status text, p_note text DEFAULT NULL, p_expected_version integer DEFAULT NULL
)
RETURNS TABLE (idea public.ideas, note_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_idea public.ideas;
  v_rule record;
  v_allowed text[];
  v_allowed_text text;
  v_has_note boolean := p_note IS NOT NULL AND p_note !~ '^[[:space:]]*$';
  v_note public.notes;
  v_latest integer;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_id IS NULL THEN
    PERFORM public.ytw_raise('validation', 'id is required: pass the id of the idea to move',
                             jsonb_build_object('field', 'id'));
  END IF;
  IF p_new_status IS NULL OR NOT p_new_status = ANY (public.ytw_idea_stages()) THEN
    PERFORM public.ytw_raise('validation',
      format('new_status %s is not a valid stage; valid stages: %s',
             public.ytw_fmt_value(p_new_status), public.ytw_fmt_list(public.ytw_idea_stages())),
      jsonb_build_object('field', 'new_status', 'value', left(p_new_status, 60),
                         'allowed', to_jsonb(public.ytw_idea_stages())));
  END IF;
  IF p_expected_version IS NOT NULL AND p_expected_version < 1 THEN
    PERFORM public.ytw_raise('validation',
      'expected_version must be a whole number of at least 1, or omitted to move whatever the latest version is',
      jsonb_build_object('field', 'expected_version'));
  END IF;
  IF p_note IS NOT NULL AND octet_length(p_note) > 65536 THEN
    PERFORM public.ytw_raise('validation',
      format('note is too large: %s bytes, the limit is 65536 (UTF-8)', octet_length(p_note)),
      jsonb_build_object('field', 'note', 'bytes', octet_length(p_note), 'max_bytes', 65536));
  END IF;

  SELECT * INTO v_idea FROM public.ideas WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_not_found('idea', p_id);
  END IF;
  IF v_idea.archived_at IS NOT NULL THEN
    PERFORM public.ytw_raise_idea_archived(p_id, 'moved to another stage');
  END IF;
  IF p_expected_version IS NOT NULL AND v_idea.version <> p_expected_version THEN
    PERFORM public.ytw_raise_version_conflict('idea', p_id, p_expected_version, v_idea.version);
  END IF;

  SELECT r.kind, r.requires_note INTO v_rule
  FROM public.ytw_idea_stage_transitions() AS r
  WHERE r.from_stage = v_idea.status AND r.to_stage = p_new_status;
  IF NOT FOUND THEN
    SELECT array_agg(r.to_stage ORDER BY r.ord),
           string_agg(format('%s (%s)', to_json(r.to_stage)::text,
                             CASE r.kind WHEN 'backward' THEN 'backward, note required'
                                         WHEN 'restore' THEN 'restore'
                                         ELSE r.kind END),
                      ', ' ORDER BY r.ord)
      INTO v_allowed, v_allowed_text
    FROM public.ytw_idea_stage_transitions() WITH ORDINALITY AS r (from_stage, to_stage, kind, requires_note, ord)
    WHERE r.from_stage = v_idea.status;
    PERFORM public.ytw_raise('invalid_transition',
      CASE WHEN v_idea.status = p_new_status
           THEN format('idea %s is already in stage "%s"; valid next stages: %s',
                       p_id, v_idea.status, v_allowed_text)
           ELSE format('an idea in stage "%s" cannot move to "%s"; valid next stages: %s',
                       v_idea.status, p_new_status, v_allowed_text)
      END,
      jsonb_build_object('entity', 'idea', 'id', p_id, 'from', v_idea.status, 'to', p_new_status,
                         'allowed', to_jsonb(v_allowed)),
      'Ideas move forward one stage at a time, back one stage with a note, to "dropped" from any stage, and from "dropped" back to "inbox".');
  END IF;
  IF v_rule.requires_note AND NOT v_has_note THEN
    PERFORM public.ytw_raise('validation',
      format('moving an idea back from "%s" to "%s" requires a note explaining why: pass note',
             v_idea.status, p_new_status),
      jsonb_build_object('field', 'note', 'from', v_idea.status, 'to', p_new_status,
                         'kind', v_rule.kind, 'requires_note', true));
  END IF;

  UPDATE public.ideas SET status = p_new_status
   WHERE id = p_id AND version = v_idea.version
  RETURNING * INTO v_idea;
  IF NOT FOUND THEN
    SELECT i.version INTO v_latest FROM public.ideas AS i WHERE i.id = p_id;
    PERFORM public.ytw_raise_version_conflict('idea', p_id, p_expected_version, v_latest);
  END IF;
  IF v_has_note THEN
    v_note := public.ytw_insert_note('idea', p_id, p_note, 'note');
  END IF;

  RETURN QUERY SELECT v_idea, v_note.id;
END
$$;

REVOKE ALL ON FUNCTION public.advance_idea(text, text, uuid, uuid, text, text, integer) FROM PUBLIC;


COMMENT ON FUNCTION public.advance_idea(text, text, uuid, uuid, text, text, integer) IS
  'Move an idea to another stage under the stage rules; a note is required for a move back and is written as a note on the idea. Errors: validation, not_found, invalid_transition, version_conflict.';
