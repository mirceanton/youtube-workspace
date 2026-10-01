-- 0018_notes: human and agent comments on ideas, scripts, videos and experiments (PRD 4 "notes";
-- PRD 5 "add_note"). The target is polymorphic (entity_type + entity_id), so a trigger stands in for
-- the foreign key: the entity must exist when the note is written, and a note never moves to
-- another entity.
--
-- entity_type mirrors NOTE_ENTITY_TYPES of @ytw/shared and author_type ACTOR_TYPES; the body limit
-- is SCRIPT_BODY_MAX_BYTES (packages/db/test/schema.test.ts checks all three).

CREATE TABLE public.notes (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  entity_type text NOT NULL
    CONSTRAINT notes_entity_type_check
    CHECK (entity_type IN ('idea', 'script', 'video', 'experiment')),
  -- The id of the idea, script revision, video or experiment.
  entity_id uuid NOT NULL,
  -- The actor who wrote the note: a username or an API token name (always equals created_by).
  author text GENERATED ALWAYS AS (created_by) STORED,
  author_type text NOT NULL DEFAULT public.ytw_current_actor_type()
    CONSTRAINT notes_author_type_check CHECK (author_type IN ('human', 'agent')),
  body_md text NOT NULL
    CONSTRAINT notes_body_md_size_check CHECK (btrim(body_md) <> '' AND octet_length(body_md) <= 1048576),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor()
);

COMMENT ON TABLE public.notes IS
  'Comments by people and agents on an idea, script revision, video or experiment (PRD 4).';
COMMENT ON COLUMN public.notes.author IS 'Username or API token name of the writer (equals created_by).';
COMMENT ON COLUMN public.notes.author_type IS 'human or agent.';

CREATE INDEX notes_entity_idx ON public.notes (entity_type, entity_id, created_at);

CREATE FUNCTION public.ytw_notes_entity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_exists boolean;
BEGIN
  IF TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION 'ytw_notes_entity_guard() must be attached BEFORE INSERT OR UPDATE ... FOR EACH ROW (table %)',
      TG_TABLE_NAME;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.entity_type IS DISTINCT FROM OLD.entity_type OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
       OR NEW.author_type IS DISTINCT FROM OLD.author_type THEN
      PERFORM public.ytw_raise(
        'immutable',
        'a note cannot be moved to another entity or change its author; add a new note instead',
        jsonb_build_object('table', 'notes', 'operation', 'update', 'id', NEW.id));
    END IF;
    RETURN NEW;
  END IF;

  v_exists := CASE NEW.entity_type
    WHEN 'idea' THEN EXISTS (SELECT 1 FROM public.ideas WHERE id = NEW.entity_id)
    WHEN 'script' THEN EXISTS (SELECT 1 FROM public.scripts WHERE id = NEW.entity_id)
    WHEN 'video' THEN EXISTS (SELECT 1 FROM public.videos WHERE id = NEW.entity_id)
    WHEN 'experiment' THEN EXISTS (SELECT 1 FROM public.experiments WHERE id = NEW.entity_id)
  END;

  IF v_exists IS NULL THEN
    PERFORM public.ytw_raise(
      'validation',
      format('entity_type %s is not valid; valid values: "idea", "script", "video", "experiment"',
             coalesce(quote_literal(NEW.entity_type), 'NULL')),
      jsonb_build_object('field', 'entity_type', 'value', NEW.entity_type,
                         'allowed', jsonb_build_array('idea', 'script', 'video', 'experiment')));
  ELSIF NOT v_exists THEN
    PERFORM public.ytw_raise(
      'not_found',
      format('%s %s does not exist: a note must be attached to an existing %s',
             NEW.entity_type, coalesce(NEW.entity_id::text, 'NULL'), NEW.entity_type),
      jsonb_build_object('entity', NEW.entity_type, 'id', NEW.entity_id));
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.ytw_notes_entity_guard() FROM PUBLIC;

CREATE TRIGGER notes_entity_guard
  BEFORE INSERT OR UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.ytw_notes_entity_guard();
CREATE TRIGGER notes_touch
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch();
CREATE TRIGGER notes_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('note', '-author', '-updated_by');

GRANT SELECT ON TABLE public.notes TO ytw_web, ytw_mcp, ytw_readonly;
