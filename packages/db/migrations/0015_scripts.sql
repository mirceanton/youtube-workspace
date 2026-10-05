-- 0015_scripts: append-only revisions of a video's script and packaging doc (PRD 4 "scripts",
-- "Integrity rules"; PRD 5 "save_script_version", "set_script_status"). A revision is never edited:
-- T12's save_script_version inserts the next version, and the only column that may change
-- afterwards is its review status (set_script_status). Deleting or truncating is refused.
--
-- kind and status mirror SCRIPT_KINDS and SCRIPT_STATUSES, and the body limit
-- SCRIPT_BODY_MAX_BYTES, of @ytw/shared (packages/db/test/schema.test.ts checks them).

CREATE TABLE public.scripts (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  idea_id uuid NOT NULL REFERENCES public.ideas (id) ON DELETE RESTRICT,
  kind text NOT NULL
    CONSTRAINT scripts_kind_check CHECK (kind IN ('script', 'packaging')),
  -- Revision number per (idea_id, kind): 1, 2, 3, ...
  version integer NOT NULL
    CONSTRAINT scripts_version_check CHECK (version >= 1),
  -- Markdown, at most 1 MiB of UTF-8 (PRD 9 "Input size limits").
  body_md text NOT NULL
    CONSTRAINT scripts_body_md_size_check CHECK (octet_length(body_md) <= 1048576),
  status text NOT NULL DEFAULT 'draft'
    CONSTRAINT scripts_status_check CHECK (status IN ('draft', 'review', 'approved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  -- Who last changed the status (equals created_by until then).
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  -- Full-text search over the body; query it with the 'english' configuration.
  search_vector tsvector GENERATED ALWAYS AS (public.ytw_body_tsvector(body_md)) STORED,
  CONSTRAINT scripts_idea_kind_version_key UNIQUE (idea_id, kind, version)
);

COMMENT ON TABLE public.scripts IS
  'Append-only script and packaging revisions (PRD 4): unique (idea_id, kind, version); only status may change after insert.';
COMMENT ON COLUMN public.scripts.version IS 'Revision number within (idea_id, kind), starting at 1.';
COMMENT ON COLUMN public.scripts.status IS 'Review status of this revision: draft, review or approved.';

CREATE INDEX scripts_search_idx ON public.scripts USING gin (search_vector);

-- Append-only, except the review status (and the bookkeeping ytw_touch() maintains).
CREATE FUNCTION public.ytw_scripts_revision_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_changed text[];
BEGIN
  IF TG_OP <> 'UPDATE' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'ytw_scripts_revision_guard() must be attached BEFORE UPDATE ... FOR EACH ROW (table %)',
      TG_TABLE_NAME;
  END IF;
  SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
  FROM jsonb_each(to_jsonb(NEW) - ARRAY['status', 'updated_at', 'updated_by', 'search_vector']) n
  WHERE (to_jsonb(OLD) -> n.key) IS DISTINCT FROM n.value;

  IF v_changed IS NOT NULL THEN
    PERFORM public.ytw_raise(
      'immutable',
      format('scripts is append-only: %s of a saved revision cannot be changed (only its status can); save a new version instead',
             array_to_string(v_changed, ', ')),
      jsonb_build_object('table', 'scripts', 'operation', 'update', 'columns', to_jsonb(v_changed)));
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.ytw_scripts_revision_guard() FROM PUBLIC;

CREATE TRIGGER scripts_append_only
  BEFORE UPDATE ON public.scripts
  FOR EACH ROW EXECUTE FUNCTION public.ytw_scripts_revision_guard();
CREATE TRIGGER scripts_no_delete
  BEFORE DELETE ON public.scripts
  FOR EACH ROW EXECUTE FUNCTION public.ytw_append_only();
CREATE TRIGGER scripts_no_truncate
  BEFORE TRUNCATE ON public.scripts
  FOR EACH STATEMENT EXECUTE FUNCTION public.ytw_append_only();
CREATE TRIGGER scripts_touch
  BEFORE UPDATE ON public.scripts
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch();
-- Bodies over 8 KiB appear in the payload as {"omitted": "too_large", "bytes": n} (ytw_audit).
CREATE TRIGGER scripts_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.scripts
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('script', '-search_vector', '-updated_by');
