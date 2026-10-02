-- 0042_metric_functions: the only write path for video metric snapshots (PRD 4 "video_metrics",
-- "Integrity rules"; PRD 5 log_metrics). Conventions: docs/database.md; helpers: 0030 and 0040.
--
-- video_metrics is append-only with a unique key (video_id, captured_at). log_metrics is idempotent
-- on that key: an agent that repeats a call (a timeout, a retry) gets the stored snapshot back with
-- created = false, and a *different* payload for an existing key is refused with a readable error
-- that shows both sets of numbers, because a snapshot never changes. The limits mirror the CHECK
-- constraints of 0016_videos; a violated CHECK is a bare SQLSTATE 23514, so every limit is
-- validated first.

-- The metrics a snapshot can hold, in display order (the keys of the `metrics` argument).
CREATE FUNCTION public.ytw_metric_keys()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT ARRAY['views', 'impressions', 'ctr', 'avg_view_duration_s', 'avg_view_pct', 'watch_time_min',
               'subs_gained', 'retention']
$$;

REVOKE ALL ON FUNCTION public.ytw_metric_keys() FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_metric_keys() IS
  'Internal: the metric names a snapshot can hold (the keys of log_metrics''s metrics argument).';

-- The numbers of one snapshot as compact JSON for a conflict message and its DETAIL: only the
-- metrics that are set; the retention curve is reduced to its number of points.
CREATE FUNCTION public.ytw_metric_summary(
  p_views numeric, p_impressions numeric, p_ctr numeric, p_avg_view_duration_s numeric,
  p_avg_view_pct numeric, p_watch_time_min numeric, p_subs_gained numeric, p_retention jsonb
)
RETURNS jsonb
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'views', p_views,
    'impressions', p_impressions,
    'ctr', p_ctr,
    'avg_view_duration_s', p_avg_view_duration_s,
    'avg_view_pct', p_avg_view_pct,
    'watch_time_min', p_watch_time_min,
    'subs_gained', p_subs_gained,
    'retention', CASE WHEN p_retention IS NULL THEN NULL
                      ELSE jsonb_build_object('points', jsonb_array_length(p_retention)) END))
$$;

REVOKE ALL ON FUNCTION public.ytw_metric_summary(numeric, numeric, numeric, numeric, numeric, numeric, numeric, jsonb) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_metric_summary(numeric, numeric, numeric, numeric, numeric, numeric, numeric, jsonb) IS
  'Internal: the set metrics of a snapshot as compact JSON (retention as its point count).';

-- That summary as text, in display order: "views=1200, ctr=4.5, retention=100 points".
CREATE FUNCTION public.ytw_metric_summary_text(p_summary jsonb)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT coalesce(string_agg(
           CASE WHEN k.key = 'retention'
                THEN format('retention=%s points', p_summary -> 'retention' ->> 'points')
                ELSE format('%s=%s', k.key, p_summary ->> k.key) END,
           ', ' ORDER BY k.ord), 'nothing')
  FROM unnest(public.ytw_metric_keys()) WITH ORDINALITY AS k (key, ord)
  WHERE p_summary ? k.key
$$;

REVOKE ALL ON FUNCTION public.ytw_metric_summary_text(jsonb) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_metric_summary_text(jsonb) IS
  'Internal: a metric summary as "name=value, ..." text for error messages.';

-- duplicate: the key (video, captured_at) exists with other numbers. Shows both sets and says what
-- to do. DETAIL carries existing_id, both summaries and the names of the metrics that differ.
-- `p_retention_differs` is true when the two retention curves are not equal: the summaries show only
-- their number of points, so two curves of equal length need this flag to be reported as different.
CREATE FUNCTION public.ytw_raise_metric_conflict(
  p_video_id uuid, p_captured_at timestamptz, p_existing_id uuid, p_stored jsonb, p_submitted jsonb,
  p_retention_differs boolean
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_differing text[];
  v_note text := '';
BEGIN
  SELECT coalesce(array_agg(k.key ORDER BY k.ord), '{}'::text[]) INTO v_differing
  FROM unnest(public.ytw_metric_keys()) WITH ORDINALITY AS k (key, ord)
  WHERE (p_stored -> k.key) IS DISTINCT FROM (p_submitted -> k.key)
     OR (k.key = 'retention' AND p_retention_differs);
  IF p_retention_differs AND (p_stored -> 'retention') IS NOT DISTINCT FROM (p_submitted -> 'retention') THEN
    v_note := '; the retention curves have the same number of points but different values';
  END IF;

  PERFORM public.ytw_raise(
    'duplicate',
    format('video %s already has a snapshot captured at %s with different numbers, so nothing was saved (stored: %s; submitted: %s%s): a snapshot never changes; log the new numbers with a later captured_at, or resend exactly the stored numbers to repeat the earlier call',
           p_video_id, public.ytw_metric_fmt_ts(p_captured_at),
           public.ytw_metric_summary_text(p_stored), public.ytw_metric_summary_text(p_submitted), v_note),
    jsonb_build_object('entity', 'video_metric', 'existing_id', p_existing_id, 'video_id', p_video_id,
                       'captured_at', public.ytw_metric_fmt_ts(p_captured_at),
                       'stored', p_stored, 'submitted', p_submitted, 'differing', to_jsonb(v_differing)),
    'To correct numbers, log a snapshot with a different captured_at.');
END
$$;

REVOKE ALL ON FUNCTION public.ytw_raise_metric_conflict(uuid, timestamptz, uuid, jsonb, jsonb, boolean) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_raise_metric_conflict(uuid, timestamptz, uuid, jsonb, jsonb, boolean) IS
  'Internal: raise duplicate for a snapshot key that exists with other numbers.';

-- log_metrics: appends the snapshot (video_id, captured_at) of a video, or recognises a repeat.
--
--   p_captured_at  when the numbers were read: a finite time between 2005 and one day ahead
--   p_metrics      a JSON object with at least one of views, impressions, ctr, avg_view_duration_s,
--                  avg_view_pct, watch_time_min, subs_gained, retention; null values count as absent
--
-- Returns (snapshot, created). created = true: a new row was appended. created = false: the key
-- already held exactly these numbers (numbers compare by value, so 4.5 equals "4.50"; a metric that
-- is absent differs from one that is set) and the stored row is returned unchanged, with no new
-- audit row. Other numbers for an existing key: duplicate, showing both. An archived video accepts
-- no new snapshots, but a repeat of a stored one is still answered with created = false.
--
-- Concurrency: callers for one video queue on its row lock (FOR NO KEY UPDATE, the lock a plain
-- UPDATE takes, so inserts of snapshots and experiments that reference the video are not held up),
-- so of N racing calls for one key exactly one inserts and the others read its row and answer
-- created = false (or duplicate, for other numbers). The same lock keeps a snapshot from slipping in
-- while the video is being archived. Without the lock the insert is still safe: ON CONFLICT DO
-- NOTHING waits for the other transaction and the stored row is compared afterwards.
CREATE FUNCTION public.log_metrics(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_video_id uuid, p_captured_at timestamptz, p_metrics jsonb
)
RETURNS TABLE (snapshot public.video_metrics, created boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_keys CONSTANT text[] := public.ytw_metric_keys();
  c_max_bigint CONSTANT numeric := 9223372036854775807;
  c_max_decimal CONSTANT numeric := 1000000000000000;
  c_max_payload_bytes CONSTANT integer := 100000;
  v_key text;
  v_views numeric;
  v_impressions numeric;
  v_ctr numeric;
  v_duration numeric;
  v_pct numeric;
  v_watch numeric;
  v_subs numeric;
  v_retention jsonb;
  v_video public.videos;
  v_stored public.video_metrics;
  v_row public.video_metrics;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_video_id IS NULL THEN
    PERFORM public.ytw_raise('validation', 'video_id is required: pass the id of the video the numbers belong to',
                             jsonb_build_object('field', 'video_id'));
  END IF;
  PERFORM public.ytw_check_video_time('captured_at', p_captured_at, now() + interval '1 day',
                                      'a snapshot records numbers that were already read');
  IF p_metrics IS NULL OR jsonb_typeof(p_metrics) <> 'object' THEN
    PERFORM public.ytw_raise('validation',
      format('metrics must be an object such as {"views": 1200, "ctr": 4.5}; metrics: %s',
             public.ytw_fmt_list(c_keys)),
      jsonb_build_object('field', 'metrics', 'allowed', to_jsonb(c_keys)));
  END IF;
  IF octet_length(p_metrics::text) > c_max_payload_bytes THEN
    PERFORM public.ytw_raise('validation',
      format('metrics is too large: %s bytes, the limit is %s', octet_length(p_metrics::text), c_max_payload_bytes),
      jsonb_build_object('field', 'metrics', 'bytes', octet_length(p_metrics::text),
                         'max_bytes', c_max_payload_bytes));
  END IF;
  FOR v_key IN SELECT k FROM jsonb_object_keys(p_metrics) AS k ORDER BY k LOOP
    IF NOT v_key = ANY (c_keys) THEN
      PERFORM public.ytw_raise('validation',
        format('metric %s is not known; metrics: %s', public.ytw_fmt_value(v_key), public.ytw_fmt_list(c_keys)),
        jsonb_build_object('field', 'metrics', 'value', left(v_key, 60), 'allowed', to_jsonb(c_keys)));
    END IF;
  END LOOP;

  v_views := public.ytw_metric_number('metrics.views', p_metrics -> 'views', 0, c_max_bigint, true,
                                      'how many times the video was viewed');
  v_impressions := public.ytw_metric_number('metrics.impressions', p_metrics -> 'impressions', 0, c_max_bigint, true,
                                            'how many times thumbnails were shown');
  v_ctr := public.ytw_metric_number('metrics.ctr', p_metrics -> 'ctr', 0, 100, false,
                                    'a percentage: 4.5 means 4.5 %');
  v_duration := public.ytw_metric_number('metrics.avg_view_duration_s', p_metrics -> 'avg_view_duration_s',
                                         0, c_max_decimal, false, 'seconds');
  v_pct := public.ytw_metric_number('metrics.avg_view_pct', p_metrics -> 'avg_view_pct', 0, 10000, false,
                                    'percent of the video watched on average; above 100 happens when viewers rewatch');
  v_watch := public.ytw_metric_number('metrics.watch_time_min', p_metrics -> 'watch_time_min',
                                      0, c_max_decimal, false, 'minutes');
  v_subs := public.ytw_metric_number('metrics.subs_gained', p_metrics -> 'subs_gained',
                                     -2147483648, 2147483647, true,
                                     'net subscribers gained; negative when more were lost');
  v_retention := CASE WHEN jsonb_typeof(p_metrics -> 'retention') = 'null' THEN NULL
                      ELSE p_metrics -> 'retention' END;
  PERFORM public.ytw_check_retention(v_retention);
  IF num_nonnulls(v_views, v_impressions, v_ctr, v_duration, v_pct, v_watch, v_subs, v_retention) = 0 THEN
    PERFORM public.ytw_raise('validation',
      format('metrics holds no values: give at least one of %s', public.ytw_fmt_list(c_keys)),
      jsonb_build_object('field', 'metrics', 'allowed', to_jsonb(c_keys)));
  END IF;

  SELECT * INTO v_video FROM public.videos WHERE id = p_video_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_not_found('video', p_video_id);
  END IF;

  SELECT * INTO v_stored FROM public.video_metrics AS m
   WHERE m.video_id = p_video_id AND m.captured_at = p_captured_at;
  IF NOT FOUND THEN
    IF v_video.archived_at IS NOT NULL THEN
      PERFORM public.ytw_raise_video_archived(p_video_id, 'given new metric snapshots');
    END IF;
    INSERT INTO public.video_metrics (video_id, captured_at, views, impressions, ctr,
                                      avg_view_duration_s, avg_view_pct, watch_time_min, subs_gained, retention)
    VALUES (p_video_id, p_captured_at, v_views::bigint, v_impressions::bigint, v_ctr,
            v_duration, v_pct, v_watch, v_subs::integer, v_retention)
    ON CONFLICT ON CONSTRAINT video_metrics_video_captured_key DO NOTHING
    RETURNING * INTO v_row;
    IF FOUND THEN
      RETURN QUERY SELECT v_row, true;
      RETURN;
    END IF;
    -- A writer that did not take the video lock got there first (the insert waited for it).
    SELECT * INTO v_stored FROM public.video_metrics AS m
     WHERE m.video_id = p_video_id AND m.captured_at = p_captured_at;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'log_metrics: snapshot of video % at % vanished', p_video_id, p_captured_at;
    END IF;
  END IF;

  IF (v_stored.views, v_stored.impressions, v_stored.ctr, v_stored.avg_view_duration_s,
      v_stored.avg_view_pct, v_stored.watch_time_min, v_stored.subs_gained, v_stored.retention)
     IS NOT DISTINCT FROM
     (v_views::bigint, v_impressions::bigint, v_ctr, v_duration, v_pct, v_watch, v_subs::integer, v_retention) THEN
    RETURN QUERY SELECT v_stored, false;
    RETURN;
  END IF;

  PERFORM public.ytw_raise_metric_conflict(
    p_video_id, p_captured_at, v_stored.id,
    public.ytw_metric_summary(v_stored.views, v_stored.impressions, v_stored.ctr, v_stored.avg_view_duration_s,
                              v_stored.avg_view_pct, v_stored.watch_time_min, v_stored.subs_gained, v_stored.retention),
    public.ytw_metric_summary(v_views, v_impressions, v_ctr, v_duration, v_pct, v_watch, v_subs, v_retention),
    v_stored.retention IS DISTINCT FROM v_retention);
END
$$;

REVOKE ALL ON FUNCTION public.log_metrics(text, text, uuid, uuid, timestamptz, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_metrics(text, text, uuid, uuid, timestamptz, jsonb)
  TO ytw_web, ytw_mcp;

COMMENT ON FUNCTION public.log_metrics(text, text, uuid, uuid, timestamptz, jsonb) IS
  'Append a metric snapshot of a video; idempotent on (video_id, captured_at): a repeat returns the stored row with created = false, other numbers for the same key are refused. Errors: validation, not_found, invalid_transition (archived), duplicate.';
