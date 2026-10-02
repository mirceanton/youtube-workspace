-- 0040_video_helpers: internal helpers for the video, metric and experiment functions of 0041-0049
-- (T13). Conventions: docs/database.md ("Database function convention", "Errors"); the helpers of
-- 0030 (ytw_fmt_value, ytw_fmt_list, ytw_raise_not_found, ytw_raise_version_conflict) are reused.
--
-- None of these is executable by an application role (REVOKE ALL ... FROM PUBLIC and no grant). They
-- run inside the SECURITY DEFINER functions, i.e. as the function owner, after those functions have
-- called ytw_set_actor().
--
-- A violated CHECK is a bare SQLSTATE 23514, so every rule of 0016 is validated here first with a
-- message that says what is allowed. The checks accept nothing the constraints refuse; where they
-- are stricter (a time window, whole-number metrics, the retention shape) the limit is documented in
-- docs/database.md ("Videos, metrics and experiments").

-- Prints an instant for a message: ISO 8601 in UTC, fraction only when there is one, e.g.
-- 2026-10-01T12:00:00Z or 2026-10-01T12:00:00.25Z.
CREATE FUNCTION public.ytw_metric_fmt_ts(p_ts timestamptz)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_ts IS NULL THEN 'NULL'
    WHEN NOT isfinite(p_ts) THEN p_ts::text
    ELSE regexp_replace(to_char(p_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), '\.?0+$', '') || 'Z'
  END
$$;

REVOKE ALL ON FUNCTION public.ytw_metric_fmt_ts(timestamptz) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_metric_fmt_ts(timestamptz) IS
  'Internal: an instant as ISO 8601 UTC text for error messages.';

-- invalid_transition: an archived video (soft-deleted, PRD 4) is frozen. `p_what` completes the
-- sentence "... and cannot be <p_what>".
CREATE FUNCTION public.ytw_raise_video_archived(p_id uuid, p_what text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.ytw_raise(
    'invalid_transition',
    format('video %s is archived and cannot be %s', p_id, p_what),
    jsonb_build_object('entity', 'video', 'id', p_id, 'reason', 'archived'),
    'Archived videos are read-only: their metrics, experiments and notes stay readable, but they accept no edits, new metric snapshots or new experiments.');
END
$$;

REVOKE ALL ON FUNCTION public.ytw_raise_video_archived(uuid, text) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_raise_video_archived(uuid, text) IS
  'Internal: raise invalid_transition (reason archived) for an archived video.';

-- A time that is stored in a timestamptz column (published_at, captured_at): finite, not before
-- YouTube existed and not later than `p_latest`. Without a window one mistyped year (2062) would
-- sort a video or a snapshot above every real one in the "latest" views. `p_why` completes the
-- sentence "<field> <time> is too far ahead: <p_why>".
CREATE FUNCTION public.ytw_check_video_time(
  p_field text, p_ts timestamptz, p_latest timestamptz, p_why text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_earliest CONSTANT timestamptz := '2005-01-01 00:00:00+00';
BEGIN
  IF p_ts IS NULL THEN
    PERFORM public.ytw_raise('validation',
      format('%s is required: pass a date and time with a time zone, such as "2026-10-01T12:00:00Z"', p_field),
      jsonb_build_object('field', p_field));
  END IF;
  IF NOT isfinite(p_ts) THEN
    PERFORM public.ytw_raise('validation',
      format('%s must be a real date and time, not %s', p_field, p_ts::text),
      jsonb_build_object('field', p_field));
  END IF;
  IF p_ts < c_earliest THEN
    PERFORM public.ytw_raise('validation',
      format('%s %s is before %s, when YouTube did not exist yet: check the year and the time zone',
             p_field, public.ytw_metric_fmt_ts(p_ts), public.ytw_metric_fmt_ts(c_earliest)),
      jsonb_build_object('field', p_field, 'value', public.ytw_metric_fmt_ts(p_ts),
                         'earliest', public.ytw_metric_fmt_ts(c_earliest)));
  END IF;
  IF p_ts > p_latest THEN
    PERFORM public.ytw_raise('validation',
      format('%s %s is too far ahead: %s (the latest accepted time is %s)',
             p_field, public.ytw_metric_fmt_ts(p_ts), p_why, public.ytw_metric_fmt_ts(p_latest)),
      jsonb_build_object('field', p_field, 'value', public.ytw_metric_fmt_ts(p_ts),
                         'latest', public.ytw_metric_fmt_ts(p_latest)));
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.ytw_check_video_time(text, timestamptz, timestamptz, text) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_check_video_time(text, timestamptz, timestamptz, text) IS
  'Internal: validate a stored time (finite, 2005 or later, not after p_latest).';

-- Field validation shared by register_video and update_video. `p_value` is the field as JSON, so a
-- wrongly typed value ("title": 5) is reported instead of being cast; SQL NULL counts as JSON null.
-- Raises validation (field, plus the limits) with a message that says what to send.
CREATE FUNCTION public.ytw_check_video_field(p_field text, p_value jsonb)
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
  v_ts timestamptz;
  v_scheme text;
BEGIN
  IF p_field = 'youtube_id' THEN
    IF v_type <> 'string' THEN
      PERFORM public.ytw_raise('validation',
        format('youtube_id is required: pass the 11-character YouTube video id (the value after v= in the watch URL), for example "dQw4w9WgXcQ" (got %s)', v_got),
        jsonb_build_object('field', 'youtube_id'));
    END IF;
    v_text := p_value #>> '{}';
    IF v_text ~ '^[A-Za-z0-9_-]{11}$' THEN
      RETURN;
    END IF;
    IF v_text ~* '^[a-z][a-z0-9+.-]*://' OR v_text ~ '[/?=.&]' THEN
      PERFORM public.ytw_raise('validation',
        format('youtube_id must be the 11-character video id, not a URL: use only the part after v= (or after youtu.be/), for example "dQw4w9WgXcQ" (got %s)',
               public.ytw_fmt_value(v_text)),
        jsonb_build_object('field', 'youtube_id', 'value', left(v_text, 60)));
    END IF;
    PERFORM public.ytw_raise('validation',
      format('youtube_id must be exactly 11 characters: letters, digits, "-" and "_" (got %s, which has %s characters)',
             public.ytw_fmt_value(v_text), char_length(v_text)),
      jsonb_build_object('field', 'youtube_id', 'value', left(v_text, 60)));

  ELSIF p_field = 'title' THEN
    IF v_type <> 'string' THEN
      PERFORM public.ytw_raise('validation',
        format('title is required: give the video a title of 1-500 characters (got %s)', v_got),
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

  ELSIF p_field = 'published_at' THEN
    IF v_type = 'null' THEN
      RETURN;
    END IF;
    IF v_type <> 'string' THEN
      PERFORM public.ytw_raise('validation',
        format('published_at must be a date and time with a time zone such as "2026-10-01T12:00:00Z", or null when not scheduled yet (got %s)', v_got),
        jsonb_build_object('field', 'published_at'));
    END IF;
    v_text := p_value #>> '{}';
    -- An explicit offset: a time without one would be read in the server's time zone.
    IF char_length(v_text) > 40
       OR v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
      PERFORM public.ytw_raise('validation',
        format('published_at must be a date and time with a time zone such as "2026-10-01T12:00:00Z" or "2026-10-01T14:00:00+02:00" (got %s)',
               public.ytw_fmt_value(v_text)),
        jsonb_build_object('field', 'published_at', 'value', left(v_text, 60)));
    END IF;
    BEGIN
      v_ts := v_text::timestamptz;
    EXCEPTION WHEN data_exception THEN
      PERFORM public.ytw_raise('validation',
        format('published_at %s is not a real date and time', public.ytw_fmt_value(v_text)),
        jsonb_build_object('field', 'published_at', 'value', left(v_text, 60)));
    END;
    PERFORM public.ytw_check_video_time('published_at', v_ts, now() + interval '2 years',
                                        'scheduled videos can be at most 2 years ahead');

  ELSIF p_field = 'thumbnail_url' THEN
    IF v_type = 'null' THEN
      RETURN;
    END IF;
    IF v_type <> 'string' THEN
      PERFORM public.ytw_raise('validation',
        format('thumbnail_url must be text (an http(s) URL or a path), or null for none (got %s)', v_got),
        jsonb_build_object('field', 'thumbnail_url'));
    END IF;
    v_text := p_value #>> '{}';
    IF v_text = '' THEN
      PERFORM public.ytw_raise('validation',
        'thumbnail_url cannot be empty: give an http(s) URL or a path, or null for none',
        jsonb_build_object('field', 'thumbnail_url'));
    END IF;
    IF char_length(v_text) > 2048 THEN
      PERFORM public.ytw_raise('validation',
        format('thumbnail_url is too long: %s characters, the limit is 2048', char_length(v_text)),
        jsonb_build_object('field', 'thumbnail_url', 'length', char_length(v_text), 'max_length', 2048));
    END IF;
    IF v_text ~ '[[:space:][:cntrl:]]' THEN
      PERFORM public.ytw_raise('validation',
        format('thumbnail_url %s contains spaces or control characters: encode them in the URL', public.ytw_fmt_value(v_text)),
        jsonb_build_object('field', 'thumbnail_url', 'value', left(v_text, 60)));
    END IF;
    IF v_text !~* '^https?://' AND v_text ~ '^[A-Za-z][A-Za-z0-9+.-]*:' THEN
      v_scheme := substring(v_text FROM '^([A-Za-z][A-Za-z0-9+.-]*):');
      PERFORM public.ytw_raise('validation',
        format('thumbnail_url must be an http(s) URL or a path without a scheme; the scheme %s is not accepted (got %s)',
               public.ytw_fmt_value(v_scheme || ':'), public.ytw_fmt_value(v_text)),
        jsonb_build_object('field', 'thumbnail_url', 'value', left(v_text, 60)));
    END IF;

  ELSIF p_field = 'idea_id' THEN
    IF v_type = 'null' THEN
      RETURN;
    END IF;
    IF v_type <> 'string'
       OR (p_value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      PERFORM public.ytw_raise('validation',
        format('idea_id must be the UUID of an idea, or null for none (got %s)',
               CASE WHEN v_type = 'string' THEN public.ytw_fmt_value(p_value #>> '{}') ELSE v_got END),
        jsonb_build_object('field', 'idea_id'));
    END IF;

  ELSE
    RAISE EXCEPTION 'ytw_check_video_field: unknown field %', p_field;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.ytw_check_video_field(text, jsonb) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_check_video_field(text, jsonb) IS
  'Internal: validate one video field (youtube_id, title, published_at, thumbnail_url, idea_id) given as JSON.';

-- One numeric metric given as JSON: a number, or a decimal string for exact values beyond what a
-- JavaScript number holds ("9007199254740993"). JSON null or SQL NULL means "not given" and returns
-- NULL. Refused: NaN and infinity (a CHECK such as `avg_view_duration_s >= 0` lets both through),
-- more than 20 decimal places (a JavaScript double prints at most 17 digits and the YouTube API
-- sends up to 16), a fraction where a whole number is required, and anything outside [p_min, p_max].
-- `p_means` explains the unit in the message. The field name is used as given ("metrics.ctr").
CREATE FUNCTION public.ytw_metric_number(
  p_field text, p_value jsonb, p_min numeric, p_max numeric, p_whole boolean,
  p_means text DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_type text := coalesce(jsonb_typeof(p_value), 'null');
  v_text text;
  v_number numeric;
  v_expected text := format('%s from %s to %s%s',
    CASE WHEN p_whole THEN 'a whole number' ELSE 'a number' END, p_min, p_max,
    coalesce(' (' || p_means || ')', ''));
BEGIN
  IF v_type = 'null' THEN
    RETURN NULL;
  END IF;
  IF v_type = 'number' THEN
    v_number := p_value::numeric;
    v_text := v_number::text;
  ELSIF v_type = 'string' THEN
    v_text := p_value #>> '{}';
    IF char_length(v_text) > 64 OR v_text !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN
      PERFORM public.ytw_raise('validation',
        format('%s must be %s, given as a number or a decimal string such as "4.52" (got %s)',
               p_field, v_expected, public.ytw_fmt_value(v_text)),
        jsonb_build_object('field', p_field, 'value', left(v_text, 60)));
    END IF;
    v_number := v_text::numeric;
  ELSE
    PERFORM public.ytw_raise('validation',
      format('%s must be %s, not %s', p_field, v_expected,
             CASE v_type WHEN 'boolean' THEN 'true or false' WHEN 'array' THEN 'a list' ELSE 'an object' END),
      jsonb_build_object('field', p_field));
  END IF;

  IF scale(v_number) > 20 THEN
    PERFORM public.ytw_raise('validation',
      format('%s has too many decimal places: at most 20 are accepted (got %s)', p_field, left(v_text, 40)),
      jsonb_build_object('field', p_field, 'value', left(v_text, 40)));
  END IF;
  IF p_whole AND v_number <> trunc(v_number) THEN
    PERFORM public.ytw_raise('validation',
      format('%s must be %s (got %s)', p_field, v_expected, left(v_text, 40)),
      jsonb_build_object('field', p_field, 'value', left(v_text, 40)));
  END IF;
  IF v_number < p_min OR v_number > p_max THEN
    PERFORM public.ytw_raise('validation',
      format('%s must be %s (got %s)', p_field, v_expected, left(v_text, 40)),
      jsonb_build_object('field', p_field, 'value', left(v_text, 40), 'min', p_min, 'max', p_max));
  END IF;
  RETURN v_number;
END
$$;

REVOKE ALL ON FUNCTION public.ytw_metric_number(text, jsonb, numeric, numeric, boolean, text) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_metric_number(text, jsonb, numeric, numeric, boolean, text) IS
  'Internal: validate one numeric metric given as JSON (number or decimal string); NULL when not given.';

-- The audience retention curve of a snapshot (video_metrics.retention): a JSON array of 1 to 1000
-- points {"t": seconds from the start of the video, "pct": percent of viewers still watching},
-- sorted by strictly increasing t, at most 64 KiB as jsonb text (the size the CHECK of 0016 measures).
-- pct may exceed 100 when viewers rewatch. NULL / JSON null means no curve.
CREATE FUNCTION public.ytw_check_retention(p_value jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_field CONSTANT text := 'metrics.retention';
  c_example CONSTANT text := '[{"t": 0, "pct": 100}, {"t": 30, "pct": 71.5}]';
  c_max_points CONSTANT integer := 1000;
  c_max_bytes CONSTANT integer := 65536;
  v_type text := coalesce(jsonb_typeof(p_value), 'null');
  v_point record;
  v_key text;
  v_t numeric;
  v_pct numeric;
  v_prev_t numeric;
BEGIN
  IF v_type = 'null' THEN
    RETURN;
  END IF;
  IF v_type <> 'array' THEN
    PERFORM public.ytw_raise('validation',
      format('%s must be a list of points such as %s (t = seconds from the start of the video, pct = percent of viewers still watching), not %s',
             c_field, c_example,
             CASE v_type WHEN 'string' THEN 'text' WHEN 'number' THEN 'a number' WHEN 'boolean' THEN 'true or false' ELSE 'an object' END),
      jsonb_build_object('field', c_field));
  END IF;
  IF jsonb_array_length(p_value) = 0 THEN
    PERFORM public.ytw_raise('validation',
      format('%s is empty: give at least one point such as %s, or leave the curve out', c_field, c_example),
      jsonb_build_object('field', c_field));
  END IF;
  IF jsonb_array_length(p_value) > c_max_points THEN
    PERFORM public.ytw_raise('validation',
      format('%s has too many points: %s, the limit is %s; downsample the curve',
             c_field, jsonb_array_length(p_value), c_max_points),
      jsonb_build_object('field', c_field, 'count', jsonb_array_length(p_value), 'max_count', c_max_points));
  END IF;
  IF octet_length(p_value::text) > c_max_bytes THEN
    PERFORM public.ytw_raise('validation',
      format('%s is too large: %s bytes, the limit is %s; downsample the curve',
             c_field, octet_length(p_value::text), c_max_bytes),
      jsonb_build_object('field', c_field, 'bytes', octet_length(p_value::text), 'max_bytes', c_max_bytes));
  END IF;

  FOR v_point IN
    SELECT e.item, e.ord FROM jsonb_array_elements(p_value) WITH ORDINALITY AS e (item, ord) ORDER BY e.ord
  LOOP
    IF jsonb_typeof(v_point.item) <> 'object' THEN
      PERFORM public.ytw_raise('validation',
        format('%s point %s must be an object like {"t": 30, "pct": 71.5}', c_field, v_point.ord),
        jsonb_build_object('field', c_field, 'position', v_point.ord));
    END IF;
    SELECT k INTO v_key FROM jsonb_object_keys(v_point.item) AS k WHERE k NOT IN ('t', 'pct') ORDER BY k LIMIT 1;
    IF FOUND THEN
      PERFORM public.ytw_raise('validation',
        format('%s point %s has an unknown field %s: a point has exactly "t" and "pct"',
               c_field, v_point.ord, public.ytw_fmt_value(v_key)),
        jsonb_build_object('field', c_field, 'position', v_point.ord));
    END IF;
    IF NOT (v_point.item ? 't' AND v_point.item ? 'pct')
       OR jsonb_typeof(v_point.item -> 't') <> 'number' OR jsonb_typeof(v_point.item -> 'pct') <> 'number' THEN
      PERFORM public.ytw_raise('validation',
        format('%s point %s must have "t" and "pct" as numbers, like {"t": 30, "pct": 71.5}', c_field, v_point.ord),
        jsonb_build_object('field', c_field, 'position', v_point.ord));
    END IF;
    v_t := (v_point.item -> 't')::numeric;
    v_pct := (v_point.item -> 'pct')::numeric;
    IF v_t < 0 OR v_t > 10000000 THEN
      PERFORM public.ytw_raise('validation',
        format('%s point %s: t must be seconds from the start of the video, from 0 to 10000000 (got %s)',
               c_field, v_point.ord, left(v_t::text, 40)),
        jsonb_build_object('field', c_field, 'position', v_point.ord));
    END IF;
    IF v_pct < 0 OR v_pct > 10000 THEN
      PERFORM public.ytw_raise('validation',
        format('%s point %s: pct must be a percentage from 0 to 10000 (above 100 happens when viewers rewatch; got %s)',
               c_field, v_point.ord, left(v_pct::text, 40)),
        jsonb_build_object('field', c_field, 'position', v_point.ord));
    END IF;
    IF v_prev_t IS NOT NULL AND v_t <= v_prev_t THEN
      PERFORM public.ytw_raise('validation',
        format('%s points must be sorted by increasing t: point %s has t %s, not after the previous point''s t %s',
               c_field, v_point.ord, v_t, v_prev_t),
        jsonb_build_object('field', c_field, 'position', v_point.ord));
    END IF;
    v_prev_t := v_t;
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION public.ytw_check_retention(jsonb) FROM PUBLIC;

COMMENT ON FUNCTION public.ytw_check_retention(jsonb) IS
  'Internal: validate the shape of a retention curve (points {t, pct}, sorted, at most 1000 points and 64 KiB).';
