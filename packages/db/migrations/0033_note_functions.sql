-- 0033_note_functions: the only write path for notes (PRD 4 "notes"; PRD 5 add_note). Conventions:
-- docs/database.md.
--
-- Notes are append-only comments on an idea, script revision, video or experiment. Whether the
-- target exists is decided by the trigger of 0018 (a missing record is not_found), which also
-- rejects an unknown entity_type; add_note relies on it for both. What the trigger cannot do is
-- explain a violated CHECK or bound what it echoes: the entity_type is pre-checked here only so
-- that a hostile 1 MB value is not repeated in the error, and the body rules (not blank, at most
-- NOTE_BODY_MAX_BYTES of UTF-8) are validated here first.

-- The one place a note is written, shared by add_note and advance_idea (a note that explains a move
-- back). `p_field` names the argument in error messages ("note" for advance_idea).
CREATE FUNCTION public.ytw_insert_note(
  p_entity_type text, p_entity_id uuid, p_body_md text, p_field text DEFAULT 'body_md'
)
RETURNS public.notes
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_max_bytes CONSTANT integer := 65536;
  c_types CONSTANT text[] := ARRAY['idea', 'script', 'video', 'experiment'];
  v_note public.notes;
BEGIN
  IF p_entity_type IS NULL OR NOT p_entity_type = ANY (c_types) THEN
    PERFORM public.ytw_raise('validation',
      format('entity_type %s is not valid; valid values: %s',
             public.ytw_fmt_value(p_entity_type), public.ytw_fmt_list(c_types)),
      jsonb_build_object('field', 'entity_type', 'value', left(p_entity_type, 60),
                         'allowed', to_jsonb(c_types)));
  END IF;
  IF p_entity_id IS NULL THEN
    PERFORM public.ytw_raise('validation',
      'entity_id is required: pass the id of the idea, script revision, video or experiment to comment on',
      jsonb_build_object('field', 'entity_id'));
  END IF;
  IF p_body_md IS NULL OR p_body_md ~ '^[[:space:]]*$' THEN
    PERFORM public.ytw_raise('validation',
      format('%s is required: a note cannot be empty or only whitespace', p_field),
      jsonb_build_object('field', p_field));
  END IF;
  IF octet_length(p_body_md) > c_max_bytes THEN
    PERFORM public.ytw_raise('validation',
      format('%s is too large: %s bytes, the limit is %s (UTF-8)', p_field, octet_length(p_body_md), c_max_bytes),
      jsonb_build_object('field', p_field, 'bytes', octet_length(p_body_md), 'max_bytes', c_max_bytes));
  END IF;

  INSERT INTO public.notes (entity_type, entity_id, body_md)
  VALUES (p_entity_type, p_entity_id, p_body_md)
  RETURNING * INTO v_note;
  RETURN v_note;
END
$$;

REVOKE ALL ON FUNCTION public.ytw_insert_note(text, uuid, text, text) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_insert_note(text, uuid, text, text) IS
  'Internal: validate the body and insert a note; the notes trigger validates the target.';

-- add_note: comment on an idea, a script revision (its id, not the idea's), a video or an
-- experiment. Returns the note, with its author (the actor), actor type and timestamps.
CREATE FUNCTION public.add_note(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_entity_type text, p_entity_id uuid, p_body_md text
)
RETURNS public.notes
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  RETURN public.ytw_insert_note(p_entity_type, p_entity_id, p_body_md, 'body_md');
END
$$;

REVOKE ALL ON FUNCTION public.add_note(text, text, uuid, text, uuid, text) FROM PUBLIC;


COMMENT ON FUNCTION public.add_note(text, text, uuid, text, uuid, text) IS
  'Add a comment to an idea, script revision, video or experiment. Errors: validation, not_found.';
