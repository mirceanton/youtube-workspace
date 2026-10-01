-- 0003_core_functions: UUIDv7 ids and the error catalogue shared by every database function.
-- Conventions: docs/database.md.

-- UUIDv7 (RFC 9562): 48-bit Unix time in milliseconds, then version 7, variant 10 and random bits,
-- so ids sort by creation time. Postgres 16 has no built-in uuidv7(); this is the default for
-- every primary key.
CREATE FUNCTION public.uuid_generate_v7()
RETURNS uuid
LANGUAGE sql
VOLATILE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid
$$;

COMMENT ON FUNCTION public.uuid_generate_v7() IS 'Time-ordered UUID (version 7) for primary keys.';

-- The SQLSTATE catalogue. Database functions raise these through ytw_raise(); the TypeScript side
-- maps them to typed errors (packages/db/src/errors.ts, kept equal to this table by a test).
-- Class "YT" is outside the ranges the SQL standard and Postgres use.
CREATE FUNCTION public.ytw_error_codes()
RETURNS TABLE (kind text, sqlstate text, description text)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  VALUES
    ('validation', 'YT001', 'An argument is missing, malformed or outside its allowed values.'),
    ('not_found', 'YT002', 'A referenced record does not exist.'),
    ('forbidden', 'YT003', 'The actor is not allowed to do this.'),
    ('version_conflict', 'YT004', 'The expected or base version is not the latest one.'),
    ('invalid_transition', 'YT005', 'The state machine does not allow this status or stage change.'),
    ('duplicate', 'YT006', 'A record with the same natural key already exists.'),
    ('immutable', 'YT007', 'Append-only data cannot be changed or deleted.'),
    ('missing_actor', 'YT008', 'A write ran without an audit actor (ytw_set_actor was not called).')
$$;

COMMENT ON FUNCTION public.ytw_error_codes() IS 'SQLSTATE catalogue for ytw_raise() (docs/database.md).';

-- Raises one of the catalogue errors. MESSAGE is the sentence an LLM or a person reads: say what
-- failed and what the valid values are (or the latest version). DETAIL carries the same facts as a
-- JSON object for programs, e.g. {"latest_version": 4} or {"allowed": ["inbox", "dropped"]}.
CREATE FUNCTION public.ytw_raise(
  p_kind text,
  p_message text,
  p_detail jsonb DEFAULT '{}'::jsonb,
  p_hint text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_code text;
  v_detail text;
BEGIN
  SELECT c.sqlstate INTO v_code FROM public.ytw_error_codes() c WHERE c.kind = p_kind;
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'ytw_raise: unknown error kind %', coalesce(quote_literal(p_kind), 'NULL')
      USING HINT = 'Valid kinds: ' || (SELECT string_agg(kind, ', ') FROM public.ytw_error_codes());
  END IF;

  v_detail := CASE
    WHEN p_detail IS NULL THEN '{}'
    WHEN jsonb_typeof(p_detail) = 'object' THEN p_detail::text
    ELSE jsonb_build_object('value', p_detail)::text
  END;

  IF p_hint IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = v_code, MESSAGE = coalesce(p_message, p_kind), DETAIL = v_detail;
  ELSE
    RAISE EXCEPTION USING ERRCODE = v_code, MESSAGE = coalesce(p_message, p_kind), DETAIL = v_detail,
      HINT = p_hint;
  END IF;
END
$$;

COMMENT ON FUNCTION public.ytw_raise(text, text, jsonb, text) IS
  'Raise a catalogue error: ytw_raise(kind, message, detail jsonb, hint). See ytw_error_codes().';
