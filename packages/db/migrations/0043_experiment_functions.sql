-- 0043_experiment_functions: the only write paths for experiments and their variants (PRD 4
-- "experiments", "experiment_variants"; PRD 5 create_experiment, record_variant_stats,
-- conclude_experiment). Conventions: docs/database.md; helpers: 0030 and 0040.
--
--   create_experiment        an experiment (status planned) with its variants, in one call
--   update_experiment_status the status machine: planned -> running -> concluded | cancelled
--   record_variant_stats     impressions and CTR of one variant, while the experiment is planned or running
--   conclude_experiment      running -> concluded, with the winner (optional) and the conclusion
--
-- type and status mirror EXPERIMENT_TYPES and EXPERIMENT_STATUSES of @ytw/shared, and the status
-- machine below is repeated row by row in packages/db/test/experiments.test.ts, which drives
-- update_experiment_status through every (from, to) pair. The limits mirror the CHECK constraints of
-- 0017_experiments; a violated CHECK is a bare SQLSTATE 23514, so every limit is validated first.
--
-- Why a winner is checked here: experiments_winner_variant_fkey is DEFERRABLE INITIALLY DEFERRED, so
-- a variant of another experiment would only fail at COMMIT (23503), after the call returned.
-- conclude_experiment checks ownership before it writes anything.

CREATE FUNCTION public.ytw_experiment_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT ARRAY['title', 'thumbnail', 'description']
$$;

REVOKE ALL ON FUNCTION public.ytw_experiment_types() FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_experiment_types() IS
  'Internal: every experiment type (EXPERIMENT_TYPES).';

CREATE FUNCTION public.ytw_experiment_statuses()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT ARRAY['planned', 'running', 'concluded', 'cancelled']
$$;

REVOKE ALL ON FUNCTION public.ytw_experiment_statuses() FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_experiment_statuses() IS
  'Internal: every experiment status in lifecycle order (EXPERIMENT_STATUSES).';

-- Every allowed status change, in menu order. `via` names the function that makes it: concluding
-- needs a winner (or none) and a conclusion, so it is conclude_experiment's. Anything not listed is
-- rejected; concluded and cancelled have no rows: they are final.
CREATE FUNCTION public.ytw_experiment_status_transitions()
RETURNS TABLE (from_status text, to_status text, via text)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  VALUES
    ('planned', 'running', 'update_experiment_status'),
    ('planned', 'cancelled', 'update_experiment_status'),
    ('running', 'concluded', 'conclude_experiment'),
    ('running', 'cancelled', 'update_experiment_status')
$$;

REVOKE ALL ON FUNCTION public.ytw_experiment_status_transitions() FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_experiment_status_transitions() IS
  'Internal: allowed experiment status changes; update_experiment_status and conclude_experiment are the only callers.';

-- The valid next statuses of `p_from` as text for a message ("running", "cancelled"), NULL when
-- there are none.
CREATE FUNCTION public.ytw_experiment_next_text(p_from text)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT string_agg(
           CASE WHEN r.via = 'conclude_experiment'
                THEN format('%s (with conclude_experiment)', to_json(r.to_status)::text)
                ELSE to_json(r.to_status)::text END,
           ', ' ORDER BY r.ord)
  FROM public.ytw_experiment_status_transitions() WITH ORDINALITY AS r (from_status, to_status, via, ord)
  WHERE r.from_status = p_from
$$;

REVOKE ALL ON FUNCTION public.ytw_experiment_next_text(text) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_experiment_next_text(text) IS
  'Internal: the valid next statuses of an experiment status, for messages.';

-- invalid_transition: the status machine does not allow the move. Lists the valid next statuses
-- (in the message and in DETAIL `allowed`); a final status says so.
CREATE FUNCTION public.ytw_raise_experiment_move(p_id uuid, p_from text, p_to text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_allowed text[];
  v_text text := public.ytw_experiment_next_text(p_from);
BEGIN
  SELECT coalesce(array_agg(r.to_status ORDER BY r.ord), '{}'::text[]) INTO v_allowed
  FROM public.ytw_experiment_status_transitions() WITH ORDINALITY AS r (from_status, to_status, via, ord)
  WHERE r.from_status = p_from;

  IF v_text IS NULL THEN
    PERFORM public.ytw_raise('invalid_transition',
      CASE WHEN p_from = p_to
           THEN format('experiment %s is already %s, which is final: its status cannot change again', p_id, p_from)
           ELSE format('experiment %s is %s, which is final: it cannot move to "%s"', p_id, p_from, p_to)
      END,
      jsonb_build_object('entity', 'experiment', 'id', p_id, 'from', p_from, 'to', p_to,
                         'allowed', to_jsonb(v_allowed), 'reason', 'terminal'),
      'concluded and cancelled are final. Create a new experiment to test again.');
  END IF;
  PERFORM public.ytw_raise('invalid_transition',
    CASE WHEN p_from = p_to
         THEN format('experiment %s is already %s; valid next statuses: %s', p_id, p_from, v_text)
         ELSE format('an experiment in status "%s" cannot move to "%s"; valid next statuses: %s', p_from, p_to, v_text)
    END,
    jsonb_build_object('entity', 'experiment', 'id', p_id, 'from', p_from, 'to', p_to,
                       'allowed', to_jsonb(v_allowed)),
    'Experiments move planned -> running -> concluded, or to cancelled from planned or running. Conclude with conclude_experiment, which records the winner and the conclusion.');
END
$$;

REVOKE ALL ON FUNCTION public.ytw_raise_experiment_move(uuid, text, text) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_raise_experiment_move(uuid, text, text) IS
  'Internal: raise invalid_transition for a status change the experiment machine forbids.';

-- invalid_transition: a concluded or cancelled experiment is frozen; `p_what` completes the
-- sentence "experiment <id> is <status>, so <p_what>".
CREATE FUNCTION public.ytw_raise_experiment_final(p_id uuid, p_status text, p_what text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.ytw_raise('invalid_transition',
    format('experiment %s is %s, so %s', p_id, p_status, p_what),
    jsonb_build_object('entity', 'experiment', 'id', p_id, 'from', p_status,
                       'allowed', '[]'::jsonb, 'reason', 'terminal'),
    'concluded and cancelled are final. Create a new experiment to test again.');
END
$$;

REVOKE ALL ON FUNCTION public.ytw_raise_experiment_final(uuid, text, text) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_raise_experiment_final(uuid, text, text) IS
  'Internal: raise invalid_transition (reason terminal) for a concluded or cancelled experiment.';

-- The variants argument of create_experiment: a list of 2 to 10 objects {label, content, is_control},
-- exactly one of them the control, labels unique (compared ignoring case and surrounding spaces).
CREATE FUNCTION public.ytw_check_variants(p_variants jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_example CONSTANT text := '[{"label": "A", "content": "Current title", "is_control": true}, {"label": "B", "content": "New title"}]';
  c_fields CONSTANT text[] := ARRAY['label', 'content', 'is_control'];
  c_min CONSTANT integer := 2;
  c_max CONSTANT integer := 10;
  v_type text := coalesce(jsonb_typeof(p_variants), 'null');
  v_variant record;
  v_key text;
  v_text text;
  v_controls integer := 0;
  v_label text;
BEGIN
  IF v_type <> 'array' THEN
    PERFORM public.ytw_raise('validation',
      format('variants must be a list of 2 to 10 objects such as %s', c_example),
      jsonb_build_object('field', 'variants'));
  END IF;
  IF jsonb_array_length(p_variants) < c_min THEN
    PERFORM public.ytw_raise('validation',
      format('an experiment needs at least 2 variants (got %s): one control and one or more alternatives, such as %s',
             jsonb_array_length(p_variants), c_example),
      jsonb_build_object('field', 'variants', 'count', jsonb_array_length(p_variants), 'min_count', c_min));
  END IF;
  IF jsonb_array_length(p_variants) > c_max THEN
    PERFORM public.ytw_raise('validation',
      format('too many variants: %s, the limit is %s', jsonb_array_length(p_variants), c_max),
      jsonb_build_object('field', 'variants', 'count', jsonb_array_length(p_variants), 'max_count', c_max));
  END IF;

  FOR v_variant IN
    SELECT e.item, e.ord FROM jsonb_array_elements(p_variants) WITH ORDINALITY AS e (item, ord) ORDER BY e.ord
  LOOP
    IF jsonb_typeof(v_variant.item) <> 'object' THEN
      PERFORM public.ytw_raise('validation',
        format('variant %s must be an object like {"label": "B", "content": "New title"}', v_variant.ord),
        jsonb_build_object('field', 'variants', 'position', v_variant.ord));
    END IF;
    SELECT k INTO v_key FROM jsonb_object_keys(v_variant.item) AS k WHERE NOT k = ANY (c_fields) ORDER BY k LIMIT 1;
    IF FOUND THEN
      PERFORM public.ytw_raise('validation',
        format('variant %s has an unknown field %s; fields: %s',
               v_variant.ord, public.ytw_fmt_value(v_key), public.ytw_fmt_list(c_fields)),
        jsonb_build_object('field', 'variants', 'position', v_variant.ord, 'allowed', to_jsonb(c_fields)));
    END IF;

    IF jsonb_typeof(v_variant.item -> 'label') IS DISTINCT FROM 'string'
       OR (v_variant.item ->> 'label') ~ '^[[:space:]]*$' THEN
      PERFORM public.ytw_raise('validation',
        format('variant %s needs a label of 1-200 characters, such as "A" or "Control"', v_variant.ord),
        jsonb_build_object('field', 'variants', 'position', v_variant.ord));
    END IF;
    v_text := v_variant.item ->> 'label';
    IF char_length(v_text) > 200 THEN
      PERFORM public.ytw_raise('validation',
        format('variant %s: the label is too long: %s characters, the limit is 200', v_variant.ord, char_length(v_text)),
        jsonb_build_object('field', 'variants', 'position', v_variant.ord));
    END IF;

    IF jsonb_typeof(v_variant.item -> 'content') IS DISTINCT FROM 'string'
       OR (v_variant.item ->> 'content') ~ '^[[:space:]]*$' THEN
      PERFORM public.ytw_raise('validation',
        format('variant %s (%s) needs content: the title or description text, or the thumbnail''s URL or path',
               v_variant.ord, public.ytw_fmt_value(v_text)),
        jsonb_build_object('field', 'variants', 'position', v_variant.ord));
    END IF;
    IF char_length(v_variant.item ->> 'content') > 20000 THEN
      PERFORM public.ytw_raise('validation',
        format('variant %s (%s): the content is too long: %s characters, the limit is 20000',
               v_variant.ord, public.ytw_fmt_value(v_text), char_length(v_variant.item ->> 'content')),
        jsonb_build_object('field', 'variants', 'position', v_variant.ord));
    END IF;

    IF v_variant.item ? 'is_control' THEN
      IF jsonb_typeof(v_variant.item -> 'is_control') <> 'boolean' THEN
        PERFORM public.ytw_raise('validation',
          format('variant %s (%s): is_control must be true or false', v_variant.ord, public.ytw_fmt_value(v_text)),
          jsonb_build_object('field', 'variants', 'position', v_variant.ord));
      END IF;
      IF (v_variant.item ->> 'is_control')::boolean THEN
        v_controls := v_controls + 1;
      END IF;
    END IF;
  END LOOP;

  IF v_controls <> 1 THEN
    PERFORM public.ytw_raise('validation',
      format('exactly one variant must be the control ("is_control": true), the current version to compare against; found %s',
             v_controls),
      jsonb_build_object('field', 'variants', 'controls', v_controls));
  END IF;

  SELECT (array_agg(e.item ->> 'label' ORDER BY e.ord))[1] INTO v_label
  FROM jsonb_array_elements(p_variants) WITH ORDINALITY AS e (item, ord)
  GROUP BY lower(btrim(e.item ->> 'label'))
  HAVING count(*) > 1
  ORDER BY min(e.ord)
  LIMIT 1;
  IF FOUND THEN
    PERFORM public.ytw_raise('validation',
      format('variant labels must be unique: %s is used more than once (labels are compared ignoring case and surrounding spaces)',
             public.ytw_fmt_value(v_label)),
      jsonb_build_object('field', 'variants', 'value', left(v_label, 60)));
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.ytw_check_variants(jsonb) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_check_variants(jsonb) IS
  'Internal: validate the variants argument of create_experiment.';

-- create_experiment: PRD 5 `create_experiment(video_id, type, hypothesis, variants)`. The experiment
-- starts as planned; its variants are written in the same call, so an experiment never exists
-- without them (and a failing variant leaves nothing behind). Variants cannot be added or removed
-- later. The video must exist and not be archived. p_hypothesis is optional (NULL), at most 20000
-- characters and not blank when given.
CREATE FUNCTION public.create_experiment(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_video_id uuid, p_type text, p_hypothesis text, p_variants jsonb
)
RETURNS public.experiments
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_video public.videos;
  v_experiment public.experiments;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_video_id IS NULL THEN
    PERFORM public.ytw_raise('validation',
      'video_id is required: pass the id of the video whose packaging is tested',
      jsonb_build_object('field', 'video_id'));
  END IF;
  IF p_type IS NULL OR NOT p_type = ANY (public.ytw_experiment_types()) THEN
    PERFORM public.ytw_raise('validation',
      format('type %s is not valid; valid types: %s',
             public.ytw_fmt_value(p_type), public.ytw_fmt_list(public.ytw_experiment_types())),
      jsonb_build_object('field', 'type', 'value', left(p_type, 60),
                         'allowed', to_jsonb(public.ytw_experiment_types())));
  END IF;
  IF p_hypothesis IS NOT NULL AND p_hypothesis ~ '^[[:space:]]*$' THEN
    PERFORM public.ytw_raise('validation',
      'hypothesis cannot be empty or only whitespace: say what you expect to happen, or pass null',
      jsonb_build_object('field', 'hypothesis'));
  END IF;
  IF char_length(p_hypothesis) > 20000 THEN
    PERFORM public.ytw_raise('validation',
      format('hypothesis is too long: %s characters, the limit is 20000', char_length(p_hypothesis)),
      jsonb_build_object('field', 'hypothesis', 'length', char_length(p_hypothesis), 'max_length', 20000));
  END IF;
  PERFORM public.ytw_check_variants(p_variants);

  SELECT * INTO v_video FROM public.videos WHERE id = p_video_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_not_found('video', p_video_id);
  END IF;
  IF v_video.archived_at IS NOT NULL THEN
    PERFORM public.ytw_raise_video_archived(p_video_id, 'given new experiments');
  END IF;

  INSERT INTO public.experiments (video_id, type, hypothesis)
  VALUES (p_video_id, p_type, p_hypothesis)
  RETURNING * INTO v_experiment;

  INSERT INTO public.experiment_variants (experiment_id, label, content, is_control)
  SELECT v_experiment.id, e.item ->> 'label', e.item ->> 'content',
         coalesce((e.item ->> 'is_control')::boolean, false)
  FROM jsonb_array_elements(p_variants) WITH ORDINALITY AS e (item, ord)
  ORDER BY e.ord;

  RETURN v_experiment;
END
$$;

REVOKE ALL ON FUNCTION public.create_experiment(text, text, uuid, uuid, text, text, jsonb) FROM PUBLIC;


COMMENT ON FUNCTION public.create_experiment(text, text, uuid, uuid, text, text, jsonb) IS
  'Create a planned experiment with its 2-10 variants (exactly one control) on a video. Errors: validation, not_found (video), invalid_transition (archived video).';

-- update_experiment_status: planned -> running (starts_at := now()), planned or running ->
-- cancelled (ends_at := now() when it had been running). concluded and cancelled are final. The
-- move to concluded belongs to conclude_experiment and is refused here with a pointer to it. A
-- stale p_expected_version is reported before an invalid move.
CREATE FUNCTION public.update_experiment_status(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_id uuid, p_expected_version integer, p_new_status text
)
RETURNS public.experiments
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_experiment public.experiments;
  v_via text;
  v_latest integer;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_id IS NULL THEN
    PERFORM public.ytw_raise('validation', 'id is required: pass the id of the experiment',
                             jsonb_build_object('field', 'id'));
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    PERFORM public.ytw_raise('validation',
      'expected_version is required: pass the version of the experiment you read (a whole number, at least 1)',
      jsonb_build_object('field', 'expected_version'));
  END IF;
  IF p_new_status IS NULL OR NOT p_new_status = ANY (public.ytw_experiment_statuses()) THEN
    PERFORM public.ytw_raise('validation',
      format('new_status %s is not a valid status; valid statuses: %s',
             public.ytw_fmt_value(p_new_status), public.ytw_fmt_list(public.ytw_experiment_statuses())),
      jsonb_build_object('field', 'new_status', 'value', left(p_new_status, 60),
                         'allowed', to_jsonb(public.ytw_experiment_statuses())));
  END IF;

  SELECT * INTO v_experiment FROM public.experiments WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_not_found('experiment', p_id);
  END IF;
  IF v_experiment.version <> p_expected_version THEN
    PERFORM public.ytw_raise_version_conflict('experiment', p_id, p_expected_version, v_experiment.version);
  END IF;

  SELECT r.via INTO v_via
  FROM public.ytw_experiment_status_transitions() AS r
  WHERE r.from_status = v_experiment.status AND r.to_status = p_new_status;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_experiment_move(p_id, v_experiment.status, p_new_status);
  END IF;
  IF v_via = 'conclude_experiment' THEN
    PERFORM public.ytw_raise('validation',
      'the status "concluded" is set with conclude_experiment, which also records the winner and the conclusion: use it to finish this experiment',
      jsonb_build_object('field', 'new_status', 'value', p_new_status, 'allowed', jsonb_build_array('cancelled')));
  END IF;

  UPDATE public.experiments
     SET status = p_new_status,
         starts_at = CASE WHEN p_new_status = 'running' THEN now() ELSE starts_at END,
         -- greatest(): a transaction opened before the experiment started has an earlier now()
         ends_at = CASE WHEN v_experiment.status = 'running' THEN greatest(now(), starts_at) ELSE ends_at END
   WHERE id = p_id AND version = v_experiment.version
  RETURNING * INTO v_experiment;
  IF NOT FOUND THEN
    SELECT x.version INTO v_latest FROM public.experiments AS x WHERE x.id = p_id;
    PERFORM public.ytw_raise_version_conflict('experiment', p_id, p_expected_version, v_latest);
  END IF;
  RETURN v_experiment;
END
$$;

REVOKE ALL ON FUNCTION public.update_experiment_status(text, text, uuid, uuid, integer, text) FROM PUBLIC;


COMMENT ON FUNCTION public.update_experiment_status(text, text, uuid, uuid, integer, text) IS
  'Move an experiment planned -> running or planned/running -> cancelled; p_expected_version must be the version read. Errors: validation, not_found, version_conflict, invalid_transition (allowed lists the valid next statuses).';

-- record_variant_stats: sets the impressions and/or the CTR (percent) of one variant. A value that is
-- NULL is left as it is; at least one must be given. Allowed while the experiment is planned or
-- running; a concluded or cancelled experiment keeps the numbers its conclusion was based on. The
-- last writer wins (variants carry no version): stats are numbers read from YouTube, not edits.
-- Setting the stored values again changes nothing: no audit row. The experiment row is locked first,
-- so a stats call cannot slip in between the status check and a concurrent conclusion.
CREATE FUNCTION public.record_variant_stats(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_variant_id uuid, p_impressions numeric DEFAULT NULL, p_ctr numeric DEFAULT NULL
)
RETURNS public.experiment_variants
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_impressions numeric;
  v_ctr numeric;
  v_experiment_id uuid;
  v_experiment public.experiments;
  v_variant public.experiment_variants;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_variant_id IS NULL THEN
    PERFORM public.ytw_raise('validation',
      'variant_id is required: pass the id of the variant (not of the experiment)',
      jsonb_build_object('field', 'variant_id'));
  END IF;
  v_impressions := public.ytw_metric_number('impressions', to_jsonb(p_impressions), 0, 9223372036854775807, true,
                                            'how many times this variant was shown');
  v_ctr := public.ytw_metric_number('ctr', to_jsonb(p_ctr), 0, 100, false, 'a percentage: 4.5 means 4.5 %');
  IF v_impressions IS NULL AND v_ctr IS NULL THEN
    PERFORM public.ytw_raise('validation',
      'give impressions, ctr or both: there is nothing to record',
      jsonb_build_object('field', 'impressions'));
  END IF;

  SELECT v.experiment_id INTO v_experiment_id FROM public.experiment_variants AS v WHERE v.id = p_variant_id;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_not_found('variant', p_variant_id);
  END IF;
  SELECT * INTO v_experiment FROM public.experiments WHERE id = v_experiment_id FOR NO KEY UPDATE;
  IF v_experiment.status NOT IN ('planned', 'running') THEN
    PERFORM public.ytw_raise_experiment_final(v_experiment.id, v_experiment.status,
      'variant stats can no longer be recorded: they can be recorded while an experiment is "planned" or "running"');
  END IF;

  SELECT * INTO v_variant FROM public.experiment_variants WHERE id = p_variant_id FOR NO KEY UPDATE;
  IF (coalesce(v_impressions, v_variant.impressions), coalesce(v_ctr, v_variant.ctr))
     IS NOT DISTINCT FROM (v_variant.impressions, v_variant.ctr) THEN
    RETURN v_variant;
  END IF;

  UPDATE public.experiment_variants
     SET impressions = coalesce(v_impressions::bigint, impressions), ctr = coalesce(v_ctr, ctr)
   WHERE id = p_variant_id
  RETURNING * INTO v_variant;
  RETURN v_variant;
END
$$;

REVOKE ALL ON FUNCTION public.record_variant_stats(text, text, uuid, uuid, numeric, numeric) FROM PUBLIC;


COMMENT ON FUNCTION public.record_variant_stats(text, text, uuid, uuid, numeric, numeric) IS
  'Record impressions and/or CTR (percent) of a variant while its experiment is planned or running. Errors: validation, not_found (variant), invalid_transition (concluded or cancelled).';

-- conclude_experiment: running -> concluded. p_winner_variant_id must be one of this experiment's
-- variants (checked before anything is written) or NULL when no variant won; p_conclusion says why
-- and is required. The conclusion is final: concluding twice is refused, and so is concluding an
-- experiment that is still planned (start it first) or cancelled. A stale p_expected_version is
-- reported before an invalid move.
CREATE FUNCTION public.conclude_experiment(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_id uuid, p_expected_version integer, p_winner_variant_id uuid, p_conclusion text
)
RETURNS public.experiments
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_experiment public.experiments;
  v_choices text;
  v_ids text[];
  v_latest integer;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_id IS NULL THEN
    PERFORM public.ytw_raise('validation', 'id is required: pass the id of the experiment to conclude',
                             jsonb_build_object('field', 'id'));
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    PERFORM public.ytw_raise('validation',
      'expected_version is required: pass the version of the experiment you read (a whole number, at least 1)',
      jsonb_build_object('field', 'expected_version'));
  END IF;
  IF p_conclusion IS NULL OR p_conclusion ~ '^[[:space:]]*$' THEN
    PERFORM public.ytw_raise('validation',
      'conclusion is required: say what the experiment showed and why the winner won (or why there is none)',
      jsonb_build_object('field', 'conclusion'));
  END IF;
  IF char_length(p_conclusion) > 20000 THEN
    PERFORM public.ytw_raise('validation',
      format('conclusion is too long: %s characters, the limit is 20000', char_length(p_conclusion)),
      jsonb_build_object('field', 'conclusion', 'length', char_length(p_conclusion), 'max_length', 20000));
  END IF;

  SELECT * INTO v_experiment FROM public.experiments WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_not_found('experiment', p_id);
  END IF;
  IF v_experiment.version <> p_expected_version THEN
    PERFORM public.ytw_raise_version_conflict('experiment', p_id, p_expected_version, v_experiment.version);
  END IF;
  IF v_experiment.status = 'concluded' THEN
    PERFORM public.ytw_raise_experiment_final(p_id, 'concluded',
      'it cannot be concluded again: a conclusion is final and cannot be repeated or changed');
  ELSIF v_experiment.status = 'cancelled' THEN
    PERFORM public.ytw_raise_experiment_final(p_id, 'cancelled', 'it cannot be concluded');
  ELSIF v_experiment.status <> 'running' THEN
    PERFORM public.ytw_raise_experiment_move(p_id, v_experiment.status, 'concluded');
  END IF;

  -- The winner must be a variant of this experiment. The foreign key that also guarantees it is
  -- deferred to COMMIT, where a failure could no longer be explained to the caller.
  IF p_winner_variant_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.experiment_variants AS v
       WHERE v.id = p_winner_variant_id AND v.experiment_id = p_id) THEN
    SELECT string_agg(format('%s (%s%s)', v.id, public.ytw_fmt_value(v.label),
                             CASE WHEN v.is_control THEN ', control' ELSE '' END),
                      ', ' ORDER BY v.is_control DESC, v.label, v.id),
           array_agg(v.id::text ORDER BY v.is_control DESC, v.label, v.id)
      INTO v_choices, v_ids
    FROM public.experiment_variants AS v WHERE v.experiment_id = p_id;
    PERFORM public.ytw_raise('validation',
      format('winner_variant_id %s is not a variant of experiment %s: choose one of its variants, or pass null when no variant won: %s',
             p_winner_variant_id, p_id, v_choices),
      jsonb_build_object('field', 'winner_variant_id', 'value', p_winner_variant_id,
                         'allowed', to_jsonb(v_ids)));
  END IF;

  UPDATE public.experiments
     SET status = 'concluded', winner_variant_id = p_winner_variant_id, conclusion = p_conclusion,
         ends_at = greatest(now(), starts_at)
   WHERE id = p_id AND version = v_experiment.version
  RETURNING * INTO v_experiment;
  IF NOT FOUND THEN
    SELECT x.version INTO v_latest FROM public.experiments AS x WHERE x.id = p_id;
    PERFORM public.ytw_raise_version_conflict('experiment', p_id, p_expected_version, v_latest);
  END IF;
  RETURN v_experiment;
END
$$;

REVOKE ALL ON FUNCTION public.conclude_experiment(text, text, uuid, uuid, integer, uuid, text) FROM PUBLIC;


COMMENT ON FUNCTION public.conclude_experiment(text, text, uuid, uuid, integer, uuid, text) IS
  'Conclude a running experiment with a winner (one of its variants, or NULL) and a conclusion; final. Errors: validation (winner_variant_id lists the valid ids), not_found, version_conflict, invalid_transition.';
