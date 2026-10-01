-- 0010_row_helpers: functions shared by the tables of 0011-0018 (T11). Conventions:
-- docs/database.md ("Schema"). None of these is executable by an application role: they run
-- inside triggers, CHECK constraints and generated columns, i.e. as the role that writes the row
-- (the owner of the SECURITY DEFINER function doing the write).

-- 1. The actor type set by ytw_set_actor(), for column defaults (notes.author_type). Raises
--    missing_actor when nothing was set, like ytw_current_actor().
CREATE FUNCTION public.ytw_current_actor_type()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_type text := nullif(current_setting('app.actor_type', true), '');
BEGIN
  IF v_type IS NULL THEN
    PERFORM public.ytw_raise(
      'missing_actor',
      'no audit actor is set for this transaction: call ytw_set_actor(actor, actor_type, token_id) first',
      '{}'::jsonb);
  END IF;
  RETURN v_type;
END
$$;

REVOKE ALL ON FUNCTION public.ytw_current_actor_type() FROM PUBLIC;

-- 2. Row bookkeeping on UPDATE, so no database function can forget it or get it wrong:
--      * id, created_at and created_by never change (raises immutable);
--      * updated_at := now() and updated_by := the current actor;
--      * argument 'version': version := OLD.version + 1 (optimistic concurrency; whatever the
--        UPDATE wrote is ignored, so `SET version = version + 1` is harmless but unnecessary);
--      * argument 'status_changed_at': set to now() when status changes, otherwise kept (the
--        "age in stage" clock of ideas).
--    An UPDATE that changes nothing else (or only last_used_at, i.e. API token use) is not a
--    modification: the maintained columns keep their old values and the version stays.
--    Generated columns are ignored (they are NULL in NEW inside a BEFORE trigger).
--    Attach as: BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION ytw_touch(['version'][, 'status_changed_at']).
--    INSERTs are left alone: column defaults fill created_*/updated_*, so test fixtures may backdate.
CREATE FUNCTION public.ytw_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_options text[] := coalesce(TG_ARGV::text[], '{}'::text[]);
  v_maintained text[] := ARRAY['updated_at', 'updated_by'];
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
  v_skip text[];
  v_changed text[];
  v_column text;
  v_set jsonb;
  v_actor text;
BEGIN
  IF TG_OP <> 'UPDATE' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'ytw_touch() must be attached BEFORE UPDATE ... FOR EACH ROW (table %)', TG_TABLE_NAME;
  END IF;
  IF NOT v_options <@ ARRAY['version', 'status_changed_at'] THEN
    RAISE EXCEPTION 'ytw_touch(): unknown option in % (table %); valid options: version, status_changed_at',
      v_options, TG_TABLE_NAME;
  END IF;
  v_maintained := v_maintained || v_options;

  FOREACH v_column IN ARRAY ARRAY['id', 'created_at', 'created_by'] LOOP
    IF v_new -> v_column IS DISTINCT FROM v_old -> v_column THEN
      PERFORM public.ytw_raise(
        'immutable',
        format('%s.%s cannot be changed after the row was created', TG_TABLE_NAME, v_column),
        jsonb_build_object('table', TG_TABLE_NAME, 'operation', 'update', 'column', v_column));
    END IF;
  END LOOP;

  SELECT v_maintained || coalesce(array_agg(a.attname::text), '{}'::text[]) INTO v_skip
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated <> '';

  SELECT coalesce(array_agg(n.key), '{}'::text[]) INTO v_changed
  FROM jsonb_each(v_new - v_skip) n
  WHERE (v_old -> n.key) IS DISTINCT FROM n.value;

  IF v_changed <@ ARRAY['last_used_at'] THEN
    -- Nothing but bookkeeping (or token use) changed: restore the maintained columns.
    SELECT coalesce(jsonb_object_agg(o.key, o.value), '{}'::jsonb) INTO v_set
    FROM jsonb_each(v_old) o
    WHERE o.key = ANY (v_maintained);
    RETURN jsonb_populate_record(NEW, v_set);
  END IF;

  v_actor := public.ytw_current_actor();
  v_set := jsonb_build_object('updated_at', now(), 'updated_by', v_actor);
  IF 'version' = ANY (v_options) THEN
    v_set := v_set || jsonb_build_object('version', (v_old ->> 'version')::integer + 1);
  END IF;
  IF 'status_changed_at' = ANY (v_options) THEN
    v_set := v_set || jsonb_build_object(
      'status_changed_at',
      CASE WHEN v_new -> 'status' IS DISTINCT FROM v_old -> 'status'
           THEN to_jsonb(now()) ELSE v_old -> 'status_changed_at' END);
  END IF;
  RETURN jsonb_populate_record(NEW, v_set);
END
$$;

REVOKE ALL ON FUNCTION public.ytw_touch() FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_touch() IS
  'BEFORE UPDATE row trigger: keeps id/created_* immutable, maintains updated_at/updated_by and, by argument, version and status_changed_at.';

-- 3. Tag lists (ideas.tags): at most 50 distinct tags of 1-64 characters each, no surrounding
--    whitespace or control characters, one-dimensional, no NULL elements.
CREATE FUNCTION public.ytw_valid_tags(p_tags text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_tags IS NOT NULL
     AND coalesce(array_ndims(p_tags), 1) = 1
     AND cardinality(p_tags) <= 50
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p_tags) t
       WHERE t IS NULL OR t <> btrim(t) OR char_length(t) NOT BETWEEN 1 AND 64 OR t ~ '[[:cntrl:]]'
     )
     AND cardinality(p_tags) = (SELECT count(DISTINCT t) FROM unnest(p_tags) t)
$$;

REVOKE ALL ON FUNCTION public.ytw_valid_tags(text[]) FROM PUBLIC;

-- 4. Full-text vector of a markdown body (scripts.search_vector). A tsvector is limited to 1 MB,
--    which a 1 MiB body of unrelated words (or pasted base64) can exceed. Real prose never comes
--    close; for such input only the first 100 000 characters are indexed instead of failing the
--    insert (100 000 characters produce well under 1 MB in the worst case).
CREATE FUNCTION public.ytw_body_tsvector(p_body text)
RETURNS tsvector
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RETURN to_tsvector('english'::regconfig, coalesce(p_body, ''));
EXCEPTION WHEN program_limit_exceeded THEN
  RETURN to_tsvector('english'::regconfig, left(p_body, 100000));
END
$$;

REVOKE ALL ON FUNCTION public.ytw_body_tsvector(text) FROM PUBLIC;
