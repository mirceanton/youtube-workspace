-- Baseline schema of the YouTube workspace database.
--
-- Applied by `pnpm migrate` (and by the server on boot) as the role that owns the database, and
-- nothing more: it creates no role and no extension, so a managed Postgres works as it is (for
-- example the `app` user that CloudNativePG creates).
--
--   1. Core         UUIDv7 ids and the error catalogue
--   2. Audit        the append-only `events` log and the triggers that fill it
--   3. Row helpers  triggers and checks shared by the tables
--   4. Tables       users, access levels, API tokens, web sessions, ideas, scripts, videos,
--                   metrics, experiments, notes
--   5. Content      the write functions of ideas, scripts, notes, videos, metrics, experiments
--   6. Identity     sign-in, access levels, API tokens, web sessions, access revocation, the
--                   seeded API token
--   7. Reads        pipeline, performance and result views, full-text search, activity feed
--
-- Every mutation goes through a SECURITY DEFINER function with a pinned search_path that calls
-- ytw_set_actor() first, so validation, versioning and the audit log apply to people and agents
-- alike. With one database role that is a convention, not a privilege boundary: anything that can
-- run SQL can read every table, so nothing stored here may be usable as a credential (API tokens
-- and session ids are stored as SHA-256 hashes, refresh tokens as ciphertext, and the audit log
-- never receives a secret).

CREATE SCHEMA ytw_private;

COMMENT ON SCHEMA ytw_private IS
  'Tables whose rows are credential hashes or session data (api_tokens, web_sessions), kept apart from the business tables in public. Written only through SECURITY DEFINER functions.';

-- =============================================================================================
-- 1. Core: ids and errors
-- =============================================================================================

-- UUIDv7 (RFC 9562): 48-bit Unix time in milliseconds, then version 7, variant 10 and random bits,
-- so ids sort by creation time. Postgres only has a built-in uuidv7() from version 18; this is
-- the default for every primary key.
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

COMMENT ON FUNCTION public.ytw_error_codes() IS 'SQLSTATE catalogue for ytw_raise().';

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

-- =============================================================================================
-- 2. Audit log
-- =============================================================================================
--
-- Two ways in, both writing `events` with the actor that ytw_set_actor() put into the transaction:
--   * ytw_audit(): an AFTER ... FOR EACH ROW trigger that business tables attach, so every INSERT
--     and UPDATE made by a database function is logged without the function doing anything beyond
--     calling ytw_set_actor(p_actor, p_actor_type, p_token_id) first;
--   * ytw_log_event(): for things that are not row changes (MCP tool calls, denied calls, logins).

-- 1. The log itself. Append-only: triggers refuse UPDATE, DELETE and TRUNCATE, even for the
--    owner.
CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Username for humans, API token name for agents. The token owner is reached through token_id
  -- (tokens are never deleted, so the link is permanent).
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 200 AND actor = btrim(actor)),
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'agent')),
  token_id uuid,
  -- Row changes: insert | update | delete. Other events: dotted names such as tool.call, auth.login.
  action text NOT NULL CHECK (
    char_length(action) <= 100 AND action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
  ),
  entity_type text CHECK (char_length(entity_type) <= 64 AND entity_type ~ '^[a-z][a-z0-9_]*$'),
  entity_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  -- created_at is the start time of the writing transaction, so it cannot serve as a commit
  -- watermark: a long transaction can commit an event that sorts before one already seen. The
  -- full top-level transaction id lets the live poll compare commits across two snapshots.
  transaction_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT events_human_without_token CHECK (actor_type <> 'human' OR token_id IS NULL),
  CONSTRAINT events_entity_id_needs_type CHECK (entity_id IS NULL OR entity_type IS NOT NULL)
);

COMMENT ON TABLE public.events IS
  'Immutable audit log: one row per insert/update of a business table and per logged action.';
COMMENT ON COLUMN public.events.transaction_xid IS
  'Full top-level transaction ID that inserted this event, used by the live poll to detect commits since a PostgreSQL snapshot.';

CREATE INDEX events_created_at_idx ON public.events (created_at DESC, id DESC);
CREATE INDEX events_entity_idx ON public.events (entity_type, entity_id, created_at DESC)
  WHERE entity_id IS NOT NULL;
CREATE INDEX events_actor_idx ON public.events (actor, created_at DESC);
CREATE INDEX events_transaction_xid_idx ON public.events (transaction_xid);

-- 2. Append-only guard, reusable for any table whose rows must never change (video_metrics, for
--    example): BEFORE UPDATE OR DELETE FOR EACH ROW and BEFORE TRUNCATE.
CREATE FUNCTION public.ytw_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.ytw_raise(
    'immutable',
    format('%s is append-only: %s is not allowed; add a new row instead', TG_TABLE_NAME, TG_OP),
    jsonb_build_object('table', TG_TABLE_NAME, 'operation', lower(TG_OP))
  );
  RETURN NULL;
END
$$;

CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.ytw_append_only();
CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON public.events
  FOR EACH STATEMENT EXECUTE FUNCTION public.ytw_append_only();

-- 3. The actor of the current transaction. Every mutating database function calls this first, with
--    its own p_actor, p_actor_type, p_token_id parameters. The values live in transaction-local
--    settings (app.actor, app.actor_type, app.token_id) that ytw_audit() reads. withActor() calls
--    it as the first statement of every transaction.
CREATE FUNCTION public.ytw_set_actor(p_actor text, p_actor_type text, p_token_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    PERFORM public.ytw_raise(
      'validation',
      'actor is required: pass the username for a person or the API token name for an agent',
      jsonb_build_object('field', 'actor'));
  END IF;
  IF char_length(btrim(p_actor)) > 200 OR p_actor ~ '[[:cntrl:]]' THEN
    PERFORM public.ytw_raise(
      'validation',
      'actor must be at most 200 characters and contain no control characters',
      jsonb_build_object('field', 'actor'));
  END IF;
  IF p_actor_type IS NULL OR p_actor_type NOT IN ('human', 'agent') THEN
    PERFORM public.ytw_raise(
      'validation',
      format('actor_type %s is not valid; valid values: "human", "agent"',
             coalesce(quote_literal(p_actor_type), 'NULL')),
      jsonb_build_object('field', 'actor_type', 'value', p_actor_type,
                         'allowed', jsonb_build_array('human', 'agent')));
  END IF;
  IF p_actor_type = 'human' AND p_token_id IS NOT NULL THEN
    PERFORM public.ytw_raise(
      'validation',
      'token_id must be NULL when actor_type is "human": people act through web sessions, agents through API tokens',
      jsonb_build_object('field', 'token_id'));
  END IF;

  PERFORM set_config('app.actor', btrim(p_actor), true);
  PERFORM set_config('app.actor_type', p_actor_type, true);
  PERFORM set_config('app.token_id', coalesce(p_token_id::text, ''), true);
END
$$;

COMMENT ON FUNCTION public.ytw_set_actor(text, text, uuid) IS
  'Set the audit actor for the rest of the transaction. Called first by every mutating function.';

-- The actor set by ytw_set_actor(), for column defaults such as created_by. Raises missing_actor
-- when nothing was set, so a forgotten ytw_set_actor() fails loudly instead of writing NULL.
CREATE FUNCTION public.ytw_current_actor()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor text := nullif(current_setting('app.actor', true), '');
BEGIN
  IF v_actor IS NULL THEN
    PERFORM public.ytw_raise(
      'missing_actor',
      'no audit actor is set for this transaction: call ytw_set_actor(actor, actor_type, token_id) first',
      '{}'::jsonb);
  END IF;
  RETURN v_actor;
END
$$;

-- 4. Payload hygiene for row snapshots, because query_sql and the activity feed can read every
--    event. ytw_is_secret_key() recognises names that look secret (ending in token, secret,
--    password, hash, blob, cookie, authorization, credential, api_key, private_key, ciphertext or
--    encrypted, or containing password, secret, refresh/access/id/session token or bearer, any case).
--    ytw_redact_json() replaces such keys' values with "[redacted]" at any depth of a JSON value.
--    ytw_audit_scrub() applies the column rules of ytw_audit() (section 5) to one row.
CREATE FUNCTION public.ytw_is_secret_key(p_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_key ~* '(token|tokens|secret|secrets|password|passwd|hash|blob|cookie|cookies|authorization|credential|credentials|apikey|api_key|private_key|ciphertext|encrypted)$'
      OR p_key ~* '(password|passwd|secret|refresh_?token|access_?token|id_?token|session_?token|bearer)'
$$;

CREATE FUNCTION public.ytw_redact_json(p_value jsonb, p_depth integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Bounded, so a deeply nested value cannot exhaust the stack and fail the audited write.
  IF p_depth >= 32 AND jsonb_typeof(p_value) IN ('object', 'array') THEN
    RETURN to_jsonb('[omitted: nested too deeply]'::text);
  END IF;
  IF jsonb_typeof(p_value) = 'object' THEN
    RETURN coalesce((
      SELECT jsonb_object_agg(
               e.key,
               CASE WHEN public.ytw_is_secret_key(e.key) THEN to_jsonb('[redacted]'::text)
                    ELSE public.ytw_redact_json(e.value, p_depth + 1) END)
      FROM jsonb_each(p_value) e
    ), '{}'::jsonb);
  ELSIF jsonb_typeof(p_value) = 'array' THEN
    RETURN coalesce((
      SELECT jsonb_agg(public.ytw_redact_json(e.value, p_depth + 1) ORDER BY e.ordinality)
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS e (value, ordinality)
    ), '[]'::jsonb);
  END IF;
  RETURN p_value;
END
$$;

CREATE FUNCTION public.ytw_audit_scrub(
  p_row jsonb,
  p_redact text[],
  p_allow text[],
  p_deny_by_default boolean
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT coalesce(
    jsonb_object_agg(
      e.key,
      CASE
        WHEN e.key = ANY (coalesce(p_redact, '{}'))
          OR (NOT e.key = ANY (coalesce(p_allow, '{}'))
              AND (p_deny_by_default OR public.ytw_is_secret_key(e.key)))
          THEN to_jsonb('[redacted]'::text)
        WHEN octet_length(e.value::text) > 8192
          THEN jsonb_build_object(
            'omitted', 'too_large',
            'bytes', octet_length(CASE WHEN jsonb_typeof(e.value) = 'string'
                                       THEN e.value #>> '{}' ELSE e.value::text END))
        ELSE public.ytw_redact_json(e.value)
      END
    ),
    '{}'::jsonb
  )
  FROM jsonb_each(p_row) e
$$;

-- 5. The generic audit trigger. Attach it to every business table:
--      CREATE TRIGGER ideas_audit AFTER INSERT OR UPDATE ON ideas
--        FOR EACH ROW EXECUTE FUNCTION ytw_audit('idea');
--    Argument 1: entity_type written to events (default: the table name). Further arguments name
--    columns: `col` keeps the column with its value replaced by "[redacted]"; `-col` leaves it out
--    entirely (derived data such as a generated tsvector); `+col` shows its value even where it
--    would be redacted. Values are redacted when the column name looks secret
--    (ytw_is_secret_key) and, in tables of schema ytw_private, for every column that is not +col;
--    there events.entity_id is recorded only with +id. Values over 8 KiB are summarised, and JSON
--    values have secret-looking keys redacted at any depth. The row's `id` becomes
--    events.entity_id. Payloads: insert {"new": row}; update {"old": changed columns, "new":
--    changed columns} (updated_at and omitted columns are not counted as changes); delete
--    {"old": row}. An update whose only change is last_used_at (API token use) is not logged.
CREATE FUNCTION public.ytw_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor text := nullif(current_setting('app.actor', true), '');
  v_actor_type text := nullif(current_setting('app.actor_type', true), '');
  v_token_id text := nullif(current_setting('app.token_id', true), '');
  v_entity_type text := coalesce(nullif(TG_ARGV[0], ''), TG_TABLE_NAME);
  v_args text[] := CASE WHEN TG_NARGS > 1 THEN TG_ARGV[1:TG_NARGS - 1] ELSE '{}'::text[] END;
  v_redact text[] := ARRAY(SELECT a FROM unnest(v_args) a WHERE a !~ '^[-+]');
  v_omit text[] := ARRAY(SELECT substr(a, 2) FROM unnest(v_args) a WHERE a LIKE '-%');
  v_allow text[] := ARRAY(SELECT substr(a, 2) FROM unnest(v_args) a WHERE a LIKE '+%');
  v_private boolean := TG_TABLE_SCHEMA = 'ytw_private';
  v_old jsonb;
  v_new jsonb;
  v_changed text[];
  v_payload jsonb;
  v_id text;
BEGIN
  IF TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
    -- A BEFORE trigger returning NULL would silently discard the row: refuse to run that way.
    RAISE EXCEPTION 'ytw_audit() must be attached AFTER INSERT OR UPDATE ... FOR EACH ROW (table %)',
      TG_TABLE_NAME;
  END IF;
  IF v_actor IS NULL OR v_actor_type IS NULL THEN
    PERFORM public.ytw_raise(
      'missing_actor',
      format('cannot %s %s without an audit actor: the database function must call ytw_set_actor(actor, actor_type, token_id) first',
             lower(TG_OP), TG_TABLE_NAME),
      jsonb_build_object('table', TG_TABLE_NAME, 'operation', lower(TG_OP)));
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old := to_jsonb(OLD);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new := to_jsonb(NEW);
  END IF;
  v_id := coalesce(v_new, v_old) ->> 'id';
  IF v_private AND NOT 'id' = ANY (v_allow) THEN
    -- A private table's id may itself be a credential (a session id, say).
    v_id := NULL;
  END IF;
  v_old := v_old - v_omit;
  v_new := v_new - v_omit;

  IF TG_OP = 'UPDATE' THEN
    SELECT coalesce(array_agg(n.key ORDER BY n.key), '{}'::text[]) INTO v_changed
    FROM jsonb_each(v_new) n
    WHERE n.key <> 'updated_at' AND (v_old -> n.key) IS DISTINCT FROM n.value;

    IF v_changed = ARRAY['last_used_at'] THEN
      RETURN NULL;
    END IF;

    v_payload := jsonb_build_object(
      'old', public.ytw_audit_scrub(
        (SELECT jsonb_object_agg(key, value) FROM jsonb_each(v_old) WHERE key = ANY (v_changed)),
        v_redact, v_allow, v_private),
      'new', public.ytw_audit_scrub(
        (SELECT jsonb_object_agg(key, value) FROM jsonb_each(v_new) WHERE key = ANY (v_changed)),
        v_redact, v_allow, v_private));
  ELSIF TG_OP = 'INSERT' THEN
    v_payload := jsonb_build_object(
      'new', public.ytw_audit_scrub(v_new, v_redact, v_allow, v_private));
  ELSE
    v_payload := jsonb_build_object(
      'old', public.ytw_audit_scrub(v_old, v_redact, v_allow, v_private));
  END IF;

  INSERT INTO public.events (actor, actor_type, token_id, action, entity_type, entity_id, payload)
  VALUES (
    v_actor,
    v_actor_type,
    v_token_id::uuid,
    lower(TG_OP),
    v_entity_type,
    CASE WHEN v_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN v_id::uuid END,
    v_payload
  );
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.ytw_audit() IS
  'AFTER INSERT OR UPDATE row trigger writing events. Args: entity_type, then columns: col (redact), -col (omit), +col (show).';

-- 6. Events that are not row changes: MCP tool calls (allowed, failed and denied), logins, logouts.
--    Same leading actor parameters as every other function. action is a dotted lower-case name
--    (at least one dot, so it can never be mistaken for a row change); payload is a JSON object of
--    at most 64 KiB and must never contain secrets.
CREATE FUNCTION public.ytw_log_event(
  p_actor text,
  p_actor_type text,
  p_token_id uuid,
  p_action text,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_action IS NULL OR char_length(p_action) > 100
     OR p_action !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' THEN
    PERFORM public.ytw_raise(
      'validation',
      format('action %s is not valid: use a dotted lower-case name such as "tool.call" or "auth.login" (at most 100 characters)',
             coalesce(quote_literal(p_action), 'NULL')),
      jsonb_build_object('field', 'action', 'value', p_action));
  END IF;
  IF p_entity_type IS NOT NULL
     AND (char_length(p_entity_type) > 64 OR p_entity_type !~ '^[a-z][a-z0-9_]*$') THEN
    PERFORM public.ytw_raise(
      'validation',
      format('entity_type %s is not valid: use a lower-case name such as "idea" (at most 64 characters)',
             quote_literal(p_entity_type)),
      jsonb_build_object('field', 'entity_type', 'value', p_entity_type));
  END IF;
  IF p_entity_id IS NOT NULL AND p_entity_type IS NULL THEN
    PERFORM public.ytw_raise(
      'validation', 'entity_type is required when entity_id is given',
      jsonb_build_object('field', 'entity_type'));
  END IF;
  IF jsonb_typeof(v_payload) <> 'object' THEN
    PERFORM public.ytw_raise(
      'validation',
      format('payload must be a JSON object, not %s', jsonb_typeof(v_payload)),
      jsonb_build_object('field', 'payload'));
  END IF;
  IF octet_length(v_payload::text) > 65536 THEN
    PERFORM public.ytw_raise(
      'validation',
      format('payload is %s bytes; the limit is 65536: summarise large values (for example a script body as its byte length)',
             octet_length(v_payload::text)),
      jsonb_build_object('field', 'payload', 'bytes', octet_length(v_payload::text), 'max_bytes', 65536));
  END IF;

  INSERT INTO public.events (actor, actor_type, token_id, action, entity_type, entity_id, payload)
  VALUES (btrim(p_actor), p_actor_type, p_token_id, p_action, p_entity_type, p_entity_id, v_payload)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

COMMENT ON FUNCTION public.ytw_log_event(text, text, uuid, text, text, uuid, jsonb) IS
  'Log a non-DML event (tool call, denied call, login). Returns the event id.';

-- =============================================================================================
-- 3. Row helpers
-- =============================================================================================
--
-- Functions shared by the tables below. They run inside triggers, CHECK constraints and generated
-- columns, i.e. as the role that writes the row.

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

-- =============================================================================================
-- 4. Tables
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Users and access levels
-- ---------------------------------------------------------------------------------------------
--
-- The resource and level lists mirror RESOURCES, LEVELS and GRANTABLE_LEVELS of @ytw/shared;
-- test/constants.test.ts fails when they drift.

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  oidc_issuer text NOT NULL
    CONSTRAINT users_oidc_issuer_check
    CHECK (char_length(oidc_issuer) BETWEEN 1 AND 2048 AND oidc_issuer !~ '[[:space:][:cntrl:]]'),
  -- OIDC Core: "sub" is at most 255 ASCII characters and case-sensitive.
  oidc_sub text NOT NULL
    CONSTRAINT users_oidc_sub_check
    CHECK (char_length(oidc_sub) BETWEEN 1 AND 255 AND oidc_sub !~ '[[:cntrl:]]'),
  -- preferred_username: the audit actor for this person, so the same rules as ytw_set_actor().
  username text NOT NULL
    CONSTRAINT users_username_check
    CHECK (char_length(username) BETWEEN 1 AND 200 AND username = btrim(username)
           AND username !~ '[[:cntrl:]]'),
  email text
    CONSTRAINT users_email_check
    CHECK (char_length(email) BETWEEN 3 AND 320 AND email !~ '[[:space:][:cntrl:]]'),
  display_name text
    CONSTRAINT users_display_name_check
    CHECK (char_length(display_name) <= 200 AND display_name !~ '[[:cntrl:]]'),
  is_admin boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  -- Set while the person has no access at all (outside the identity provider's access group, or
  -- locked out by an admin); see the access revocation functions.
  access_revoked_at timestamptz,
  -- The built-in non-interactive user that owns the seeded API token (see seed_api_token). Not a
  -- person: it cannot log in, is never an admin, is hidden from the user lists and does not
  -- count as "the first user".
  is_system boolean NOT NULL DEFAULT false,
  CONSTRAINT users_oidc_identity_key UNIQUE (oidc_issuer, oidc_sub),
  CONSTRAINT users_system_not_admin_check CHECK (NOT is_system OR NOT is_admin)
);

CREATE UNIQUE INDEX users_one_system_idx ON public.users ((true)) WHERE is_system;

COMMENT ON TABLE public.users IS
  'App users, created on first login and linked to their OIDC identity (issuer + sub), plus the built-in system user that owns the seeded API token.';
COMMENT ON COLUMN public.users.username IS 'preferred_username; the audit actor for this person.';
COMMENT ON COLUMN public.users.is_admin IS
  'Admins have Write on everything (activity: Read) and manage other users'' access.';
COMMENT ON COLUMN public.users.access_revoked_at IS
  'Set while the person has no access at all (outside the identity provider''s access group, or locked out by an admin): effective levels none, not an admin, their tokens dead. NULL = access as stored. Cleared by the next sign-in that passed the group check.';
COMMENT ON COLUMN public.users.is_system IS
  'The built-in system user that owns the seeded API token: not a person, cannot log in, effective level is the maximum on every object so the token''s own levels are what applies.';

-- One row per user and object. Levels: none < read < write (write includes read). The activity
-- log is read-only: no row may grant write on it. Admins hold full access whatever is stored
-- here (@ytw/policy); the identity functions store matching rows for them.
CREATE TABLE public.user_permissions (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  resource text NOT NULL
    CONSTRAINT user_permissions_resource_check
    CHECK (resource IN ('ideas', 'scripts', 'experiments', 'videos', 'notes', 'activity')),
  level text NOT NULL
    CONSTRAINT user_permissions_level_check
    CHECK (level IN ('none', 'read', 'write')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  -- Objects whose maximum level is read (GRANTABLE_LEVELS without "write").
  CONSTRAINT user_permissions_read_only_check
    CHECK (level <> 'write' OR resource NOT IN ('activity')),
  CONSTRAINT user_permissions_user_resource_key UNIQUE (user_id, resource)
);

COMMENT ON TABLE public.user_permissions IS
  'Access level (none, read, write) per user and object; activity is none or read.';

CREATE TRIGGER users_touch
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch();
CREATE TRIGGER users_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('user', 'email', 'oidc_sub', '-updated_by');

CREATE TRIGGER user_permissions_touch
  BEFORE UPDATE ON public.user_permissions
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch();
CREATE TRIGGER user_permissions_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.user_permissions
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('user_permission', '-updated_by');


-- ---------------------------------------------------------------------------------------------
-- API tokens
-- ---------------------------------------------------------------------------------------------
--
-- Both tables live in ytw_private. Tokens are never deleted (revoked_at), so events.token_id keeps
-- pointing at a real token.

CREATE TABLE ytw_private.api_tokens (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  -- The owner. A token's effective level is the lower of its own and the owner's current level.
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  -- The audit actor for the token's calls, so the same rules as ytw_set_actor().
  name text NOT NULL
    CONSTRAINT api_tokens_name_check
    CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  -- The first characters of the secret, shown in settings to tell tokens apart.
  token_prefix text NOT NULL
    CONSTRAINT api_tokens_token_prefix_check
    CHECK (token_prefix ~ '^[A-Za-z0-9_-]{4,16}$'),
  -- SHA-256 of the whole secret as 64 lower-case hex digits. The format check also makes it
  -- impossible to store a plain-text secret here by mistake.
  token_hash text NOT NULL
    CONSTRAINT api_tokens_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  -- True only for the one token the operator configures through the environment
  -- (seed_api_token), which is the only token that seeding ever touches. It never expires.
  seeded boolean NOT NULL DEFAULT false,
  CONSTRAINT api_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT api_tokens_seeded_no_expiry_check CHECK (NOT seeded OR expires_at IS NULL)
);

-- Two replicas booting at once must not end up with two seeded tokens.
CREATE UNIQUE INDEX api_tokens_one_active_seeded_idx ON ytw_private.api_tokens ((true))
  WHERE seeded AND revoked_at IS NULL;

COMMENT ON TABLE ytw_private.api_tokens IS
  'API tokens: stored as SHA-256 hash + prefix only. expires_at NULL = never; revoked tokens stay for the audit trail.';
COMMENT ON COLUMN ytw_private.api_tokens.token_hash IS
  'SHA-256 of the full secret, 64 lower-case hex digits. The secret itself is never stored.';
COMMENT ON COLUMN ytw_private.api_tokens.seeded IS
  'The token configured through the environment (seed_api_token); at most one is active at a time. Owned by the system user, never expires.';

CREATE INDEX api_tokens_user_idx ON ytw_private.api_tokens (user_id, created_at);

CREATE TABLE ytw_private.api_token_permissions (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  token_id uuid NOT NULL REFERENCES ytw_private.api_tokens (id) ON DELETE RESTRICT,
  resource text NOT NULL
    CONSTRAINT api_token_permissions_resource_check
    CHECK (resource IN ('ideas', 'scripts', 'experiments', 'videos', 'notes', 'activity')),
  level text NOT NULL
    CONSTRAINT api_token_permissions_level_check
    CHECK (level IN ('none', 'read', 'write')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  CONSTRAINT api_token_permissions_read_only_check
    CHECK (level <> 'write' OR resource NOT IN ('activity')),
  CONSTRAINT api_token_permissions_token_resource_key UNIQUE (token_id, resource)
);

COMMENT ON TABLE ytw_private.api_token_permissions IS
  'A token''s own level per object; never above its owner''s (enforced by the token functions).';

CREATE TRIGGER api_tokens_touch
  BEFORE UPDATE ON ytw_private.api_tokens
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch();
-- token_hash would be redacted by its name anyway; listed so the intent is explicit. Tables in
-- ytw_private are audited default-deny: only +id (the entity id) is recorded with its value.
CREATE TRIGGER api_tokens_audit
  AFTER INSERT OR UPDATE OR DELETE ON ytw_private.api_tokens
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('api_token', 'token_hash', '-updated_by', '+id');

CREATE TRIGGER api_token_permissions_touch
  BEFORE UPDATE ON ytw_private.api_token_permissions
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch();
CREATE TRIGGER api_token_permissions_audit
  AFTER INSERT OR UPDATE OR DELETE ON ytw_private.api_token_permissions
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('api_token_permission', '-updated_by', '+id');


-- ---------------------------------------------------------------------------------------------
-- Web sessions
-- ---------------------------------------------------------------------------------------------

-- Not audited: a session is not a business record (logins and logouts are logged with
-- ytw_log_event as auth.login / auth.logout), and last_seen_at changes on every request.
--
-- Only a SHA-256 of the session id is stored. The id is the bearer handle behind the session
-- cookie (the web server keeps it, signed, in the HttpOnly cookie), and anything that can run SQL
-- (query_sql included) can read this table: a stored id would be a working login for every live
-- session, its hash is not. The id is a random v4 UUID (122 random bits), so a plain hash needs
-- no salt or stretching. It is a v4 rather than the time-ordered v7 used elsewhere so that it
-- does not reveal when the session started. The id appears in no event and no message.
CREATE TABLE ytw_private.web_sessions (
  id_hash bytea PRIMARY KEY
    CONSTRAINT web_sessions_id_hash_check CHECK (octet_length(id_hash) = 32),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  -- The OIDC refresh token, encrypted by the web server (key derived from SESSION_SECRET). NULL when
  -- the provider issued none.
  refresh_token_encrypted bytea
    CONSTRAINT web_sessions_refresh_token_encrypted_check
    CHECK (octet_length(refresh_token_encrypted) BETWEEN 1 AND 16384),
  -- The ID token, sent as id_token_hint for RP-initiated logout.
  id_token_hint text
    CONSTRAINT web_sessions_id_token_hint_check
    CHECK (char_length(id_token_hint) BETWEEN 1 AND 16384),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Idle expiry (moves forward on activity) and absolute expiry (fixed at login). A session never
  -- outlives its absolute expiry.
  expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  CONSTRAINT web_sessions_expiry_check CHECK (expires_at <= absolute_expires_at)
);

COMMENT ON TABLE ytw_private.web_sessions IS
  'Server-side web sessions, keyed by the SHA-256 of the session id: refresh token encrypted at rest, idle (expires_at) and absolute (absolute_expires_at) expiry.';

CREATE INDEX web_sessions_user_idx ON ytw_private.web_sessions (user_id);
CREATE INDEX web_sessions_expires_idx ON ytw_private.web_sessions (expires_at);


-- ---------------------------------------------------------------------------------------------
-- Ideas
-- ---------------------------------------------------------------------------------------------
--
-- Stage moves are decided by advance_idea; this table only guarantees that the stage is a known one
-- and that status_changed_at ("age in stage") and version are always right. The stage list mirrors
-- IDEA_STAGES of @ytw/shared (test/constants.test.ts checks it).

CREATE TABLE public.ideas (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  title text NOT NULL
    CONSTRAINT ideas_title_check CHECK (btrim(title) <> '' AND char_length(title) <= 500),
  pitch text
    CONSTRAINT ideas_pitch_check CHECK (char_length(pitch) <= 20000),
  -- The stage. New ideas start in the inbox.
  status text NOT NULL DEFAULT 'inbox'
    CONSTRAINT ideas_status_check
    CHECK (status IN ('inbox', 'shortlisted', 'scripting', 'filming', 'editing', 'published', 'dropped')),
  -- When the idea entered its current stage. Maintained by ytw_touch(): moves only when status does.
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  -- Priority score, 0-100 (higher is better); NULL = not scored yet.
  score integer
    CONSTRAINT ideas_score_check CHECK (score BETWEEN 0 AND 100),
  -- Where the idea came from (an agent, a viewer comment, the owner, ...); free text.
  source text
    CONSTRAINT ideas_source_check CHECK (btrim(source) <> '' AND char_length(source) <= 200),
  tags text[] NOT NULL DEFAULT '{}'
    CONSTRAINT ideas_tags_check CHECK (public.ytw_valid_tags(tags)),
  -- Optimistic concurrency: +1 on every change (ytw_touch()); updates pass the version they read.
  version integer NOT NULL DEFAULT 1
    CONSTRAINT ideas_version_check CHECK (version >= 1),
  -- Soft delete: ideas are archived, never deleted.
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  -- Full-text search over title (weight A) and pitch (weight B); query it with the 'english'
  -- configuration, e.g. websearch_to_tsquery('english', $1).
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, title), 'A')
    || setweight(to_tsvector('english'::regconfig, coalesce(pitch, '')), 'B')
  ) STORED
);

COMMENT ON TABLE public.ideas IS
  'Video ideas. Stages: inbox -> shortlisted -> scripting -> filming -> editing -> published, plus dropped; moves only through advance_idea.';
COMMENT ON COLUMN public.ideas.status IS 'The stage (IDEA_STAGES). Changed only by advance_idea.';
COMMENT ON COLUMN public.ideas.status_changed_at IS 'When the idea entered its current stage (age in stage).';
COMMENT ON COLUMN public.ideas.score IS 'Priority score from 0 to 100, higher is better; NULL when not scored.';
COMMENT ON COLUMN public.ideas.version IS 'Optimistic-concurrency version, incremented on every change.';

-- Filters of the ideas screen (stage, tag, score, source) and full-text search.
CREATE INDEX ideas_status_idx ON public.ideas (status, status_changed_at);
CREATE INDEX ideas_score_idx ON public.ideas (score);
CREATE INDEX ideas_source_idx ON public.ideas (source);
CREATE INDEX ideas_tags_idx ON public.ideas USING gin (tags);
CREATE INDEX ideas_search_idx ON public.ideas USING gin (search_vector);

CREATE TRIGGER ideas_touch
  BEFORE UPDATE ON public.ideas
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch('version', 'status_changed_at');
CREATE TRIGGER ideas_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.ideas
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('idea', '-search_vector', '-updated_by');

-- ---------------------------------------------------------------------------------------------
-- Scripts
-- ---------------------------------------------------------------------------------------------
--
-- Append-only revisions of an idea's script and packaging doc. A revision is never edited:
-- save_script_version inserts the next version, and the only column that may change afterwards is
-- its review status (set_script_status). Deleting or truncating is refused.
--
-- kind and status mirror SCRIPT_KINDS and SCRIPT_STATUSES, and the body limit SCRIPT_BODY_MAX_BYTES,
-- of @ytw/shared.

CREATE TABLE public.scripts (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  idea_id uuid NOT NULL REFERENCES public.ideas (id) ON DELETE RESTRICT,
  kind text NOT NULL
    CONSTRAINT scripts_kind_check CHECK (kind IN ('script', 'packaging')),
  -- Revision number per (idea_id, kind): 1, 2, 3, ...
  version integer NOT NULL
    CONSTRAINT scripts_version_check CHECK (version >= 1),
  -- Markdown, at most 1 MiB of UTF-8.
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
  'Append-only script and packaging revisions: unique (idea_id, kind, version); only status may change after insert.';
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

-- ---------------------------------------------------------------------------------------------
-- Videos and metric snapshots
-- ---------------------------------------------------------------------------------------------

CREATE TABLE public.videos (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  -- The idea the video came from, if any.
  idea_id uuid REFERENCES public.ideas (id) ON DELETE RESTRICT,
  -- YouTube's 11-character video id (the v= parameter), not a URL.
  youtube_id text NOT NULL
    CONSTRAINT videos_youtube_id_check CHECK (youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  title text NOT NULL
    CONSTRAINT videos_title_check CHECK (btrim(title) <> '' AND char_length(title) <= 500),
  -- Publication time; in the future for a scheduled video, NULL while unscheduled.
  published_at timestamptz,
  -- URL or path of the thumbnail (no files are stored here). http(s) URLs or scheme-less paths only,
  -- so a stored value can never be a javascript: or data: URL.
  thumbnail_url text
    CONSTRAINT videos_thumbnail_url_check
    CHECK (char_length(thumbnail_url) BETWEEN 1 AND 2048
           AND thumbnail_url !~ '[[:space:][:cntrl:]]'
           AND (thumbnail_url ~* '^https?://' OR thumbnail_url !~ '^[A-Za-z][A-Za-z0-9+.-]*:')),
  version integer NOT NULL DEFAULT 1
    CONSTRAINT videos_version_check CHECK (version >= 1),
  -- Soft delete: videos are archived, never deleted.
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  CONSTRAINT videos_youtube_id_key UNIQUE (youtube_id)
);

COMMENT ON TABLE public.videos IS 'Published or scheduled videos; youtube_id is unique.';
COMMENT ON COLUMN public.videos.youtube_id IS 'YouTube video id (11 characters), unique.';
COMMENT ON COLUMN public.videos.version IS 'Optimistic-concurrency version, incremented on every change.';

CREATE INDEX videos_idea_idx ON public.videos (idea_id);
CREATE INDEX videos_published_at_idx ON public.videos (published_at DESC);

CREATE TRIGGER videos_touch
  BEFORE UPDATE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch('version');
CREATE TRIGGER videos_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('video', '-updated_by');

-- Metric snapshots. A row is never changed: rows that never change carry no updated_at/updated_by
-- (as events). Every metric is optional, but a snapshot must hold at least one. Exact numerics so a
-- replayed snapshot compares equal (log_metrics is idempotent on (video_id, captured_at)).
CREATE TABLE public.video_metrics (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  video_id uuid NOT NULL REFERENCES public.videos (id) ON DELETE RESTRICT,
  -- When the numbers were read (from YouTube Studio or the Analytics API).
  captured_at timestamptz NOT NULL,
  views bigint CONSTRAINT video_metrics_views_check CHECK (views >= 0),
  impressions bigint CONSTRAINT video_metrics_impressions_check CHECK (impressions >= 0),
  -- Impressions click-through rate in percent (4.5 means 4.5 %).
  ctr numeric CONSTRAINT video_metrics_ctr_check CHECK (ctr BETWEEN 0 AND 100),
  avg_view_duration_s numeric
    CONSTRAINT video_metrics_avg_view_duration_s_check CHECK (avg_view_duration_s >= 0),
  -- Average percentage viewed; can exceed 100 when viewers rewatch.
  avg_view_pct numeric CONSTRAINT video_metrics_avg_view_pct_check CHECK (avg_view_pct >= 0),
  watch_time_min numeric CONSTRAINT video_metrics_watch_time_min_check CHECK (watch_time_min >= 0),
  -- Net subscribers gained in the period; negative when more were lost.
  subs_gained integer,
  -- Audience retention curve: a JSON array (shape checked by log_metrics), at most 64 KiB.
  retention jsonb
    CONSTRAINT video_metrics_retention_check
    CHECK (jsonb_typeof(retention) = 'array' AND octet_length(retention::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  CONSTRAINT video_metrics_any_metric_check
    CHECK (num_nonnulls(views, impressions, ctr, avg_view_duration_s, avg_view_pct, watch_time_min,
                        subs_gained, retention) >= 1),
  CONSTRAINT video_metrics_video_captured_key UNIQUE (video_id, captured_at)
);

COMMENT ON TABLE public.video_metrics IS
  'Append-only metric snapshots: unique (video_id, captured_at); rows are never updated or deleted.';
COMMENT ON COLUMN public.video_metrics.ctr IS 'Impressions click-through rate in percent (0-100).';
COMMENT ON COLUMN public.video_metrics.avg_view_pct IS 'Average percentage viewed (may exceed 100).';
COMMENT ON COLUMN public.video_metrics.subs_gained IS 'Net subscribers gained; negative when more were lost.';

CREATE TRIGGER video_metrics_append_only
  BEFORE UPDATE OR DELETE ON public.video_metrics
  FOR EACH ROW EXECUTE FUNCTION public.ytw_append_only();
CREATE TRIGGER video_metrics_no_truncate
  BEFORE TRUNCATE ON public.video_metrics
  FOR EACH STATEMENT EXECUTE FUNCTION public.ytw_append_only();
CREATE TRIGGER video_metrics_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.video_metrics
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('video_metric');

-- ---------------------------------------------------------------------------------------------
-- Experiments
-- ---------------------------------------------------------------------------------------------
--
-- A/B tests of a video's packaging and their variants. The status machine (planned -> running ->
-- concluded | cancelled) lives in the functions; the schema guarantees that a winner is one of the
-- experiment's own variants, that only a concluded experiment has one, and that an experiment has at
-- most one control. type and status mirror EXPERIMENT_TYPES and EXPERIMENT_STATUSES of @ytw/shared.

CREATE TABLE public.experiments (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  video_id uuid NOT NULL REFERENCES public.videos (id) ON DELETE RESTRICT,
  type text NOT NULL
    CONSTRAINT experiments_type_check CHECK (type IN ('title', 'thumbnail', 'description')),
  hypothesis text
    CONSTRAINT experiments_hypothesis_check CHECK (char_length(hypothesis) <= 20000),
  status text NOT NULL DEFAULT 'planned'
    CONSTRAINT experiments_status_check
    CHECK (status IN ('planned', 'running', 'concluded', 'cancelled')),
  starts_at timestamptz,
  ends_at timestamptz,
  -- References experiment_variants (constraint experiments_winner_variant_fkey, added below).
  winner_variant_id uuid,
  conclusion text
    CONSTRAINT experiments_conclusion_check CHECK (char_length(conclusion) <= 20000),
  version integer NOT NULL DEFAULT 1
    CONSTRAINT experiments_version_check CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  CONSTRAINT experiments_period_check CHECK (ends_at >= starts_at),
  CONSTRAINT experiments_winner_concluded_check
    CHECK (winner_variant_id IS NULL OR status = 'concluded')
);

COMMENT ON TABLE public.experiments IS
  'Packaging A/B tests on a video. Status: planned -> running -> concluded | cancelled.';
COMMENT ON COLUMN public.experiments.winner_variant_id IS
  'The winning variant; must belong to this experiment and is set only when concluded.';
COMMENT ON COLUMN public.experiments.version IS 'Optimistic-concurrency version, incremented on every change.';

CREATE INDEX experiments_video_idx ON public.experiments (video_id);
CREATE INDEX experiments_status_idx ON public.experiments (status);

CREATE TABLE public.experiment_variants (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  experiment_id uuid NOT NULL REFERENCES public.experiments (id) ON DELETE RESTRICT,
  -- Short name shown side by side, e.g. "A" or "Control".
  label text NOT NULL
    CONSTRAINT experiment_variants_label_check CHECK (btrim(label) <> '' AND char_length(label) <= 200),
  -- What is being tested: the title or description text, or the thumbnail's URL or path.
  content text NOT NULL
    CONSTRAINT experiment_variants_content_check CHECK (char_length(content) <= 20000),
  is_control boolean NOT NULL DEFAULT false,
  impressions bigint
    CONSTRAINT experiment_variants_impressions_check CHECK (impressions >= 0),
  -- Click-through rate in percent (4.5 means 4.5 %), as video_metrics.ctr.
  ctr numeric
    CONSTRAINT experiment_variants_ctr_check CHECK (ctr BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  CONSTRAINT experiment_variants_label_key UNIQUE (experiment_id, label),
  -- Target of the composite winner foreign key below.
  CONSTRAINT experiment_variants_experiment_variant_key UNIQUE (experiment_id, id)
);

COMMENT ON TABLE public.experiment_variants IS
  'Variants of an experiment with their results; at most one control per experiment.';
COMMENT ON COLUMN public.experiment_variants.ctr IS 'Click-through rate in percent (0-100).';

CREATE UNIQUE INDEX experiment_variants_one_control_idx
  ON public.experiment_variants (experiment_id) WHERE is_control;

-- The circular reference: an experiment's winner is a variant of that same experiment. The key
-- (id, winner_variant_id) makes "winner belongs to the experiment" a schema rule; it is checked
-- only when winner_variant_id is set. Deferrable, initially deferred, so an experiment and its
-- variants can be written in any order within one transaction.
ALTER TABLE public.experiments
  ADD CONSTRAINT experiments_winner_variant_fkey
  FOREIGN KEY (id, winner_variant_id)
  REFERENCES public.experiment_variants (experiment_id, id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX experiments_winner_idx ON public.experiments (winner_variant_id)
  WHERE winner_variant_id IS NOT NULL;

CREATE TRIGGER experiments_touch
  BEFORE UPDATE ON public.experiments
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch('version');
CREATE TRIGGER experiments_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.experiments
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('experiment', '-updated_by');

CREATE TRIGGER experiment_variants_touch
  BEFORE UPDATE ON public.experiment_variants
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch();
CREATE TRIGGER experiment_variants_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.experiment_variants
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('experiment_variant', '-updated_by');

-- ---------------------------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------------------------
--
-- Human and agent comments on ideas, scripts, videos and experiments. Notes are append-only: a
-- comment is never edited, moved or deleted. The target is polymorphic (entity_type + entity_id), so
-- a trigger stands in for the foreign key: the entity must exist when the note is written.
--
-- entity_type mirrors NOTE_ENTITY_TYPES of @ytw/shared, actor_type ACTOR_TYPES, and the body limit
-- NOTE_BODY_MAX_BYTES.

CREATE TABLE public.notes (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  entity_type text NOT NULL
    CONSTRAINT notes_entity_type_check
    CHECK (entity_type IN ('idea', 'script', 'video', 'experiment')),
  -- The id of the idea, script revision, video or experiment.
  entity_id uuid NOT NULL,
  -- The actor who wrote the note: a username or an API token name (always equals created_by).
  author text GENERATED ALWAYS AS (created_by) STORED,
  actor_type text NOT NULL DEFAULT public.ytw_current_actor_type()
    CONSTRAINT notes_actor_type_check CHECK (actor_type IN ('human', 'agent')),
  -- Markdown, not blank, at most 64 KiB of UTF-8 (NOTE_BODY_MAX_BYTES).
  body_md text NOT NULL
    CONSTRAINT notes_body_md_size_check CHECK (btrim(body_md) <> '' AND octet_length(body_md) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor()
);

COMMENT ON TABLE public.notes IS
  'Append-only comments by people and agents on an idea, script revision, video or experiment.';
COMMENT ON COLUMN public.notes.author IS 'Username or API token name of the writer (equals created_by).';
COMMENT ON COLUMN public.notes.actor_type IS 'human or agent.';

CREATE INDEX notes_entity_idx ON public.notes (entity_type, entity_id, created_at);

-- The polymorphic foreign key: the target must exist.
CREATE FUNCTION public.ytw_notes_entity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_exists boolean;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'ytw_notes_entity_guard() must be attached BEFORE INSERT ... FOR EACH ROW (table %)',
      TG_TABLE_NAME;
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

CREATE TRIGGER notes_entity_guard
  BEFORE INSERT ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.ytw_notes_entity_guard();
CREATE TRIGGER notes_append_only
  BEFORE UPDATE OR DELETE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.ytw_append_only();
CREATE TRIGGER notes_no_truncate
  BEFORE TRUNCATE ON public.notes
  FOR EACH STATEMENT EXECUTE FUNCTION public.ytw_append_only();
-- Fires only if a later migration ever allows edits: the bookkeeping is then already right.
CREATE TRIGGER notes_touch
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch();
CREATE TRIGGER notes_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('note', '-author', '-updated_by');

-- =============================================================================================
-- 5. Content: write functions
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------------------------
--
-- Internal helpers for the write functions below: how to print a caller's value inside an error
-- message, and the errors every idea or script function raises the same way. They run inside the
-- SECURITY DEFINER functions that call them.

-- Prints a caller-supplied value for an error message: JSON-quoted, so quotes, newlines and control
-- characters cannot break the sentence or forge a second one, and cut after 60 characters, so a
-- 1 MiB argument is never echoed back.
CREATE FUNCTION public.ytw_fmt_value(p_value text)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_value IS NULL THEN 'NULL'
    WHEN char_length(p_value) > 60 THEN to_json(left(p_value, 60))::text || '...'
    ELSE to_json(p_value)::text
  END
$$;

COMMENT ON FUNCTION public.ytw_fmt_value(text) IS
  'Internal: a caller value as a JSON-quoted, truncated string for error messages.';

-- Lists allowed values the way formatAllowed() of @ytw/db does: "a", "b", "c".
CREATE FUNCTION public.ytw_fmt_list(p_values text[])
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT coalesce(string_agg(to_json(v.item)::text, ', ' ORDER BY v.ord), '')
  FROM unnest(p_values) WITH ORDINALITY AS v (item, ord)
$$;

COMMENT ON FUNCTION public.ytw_fmt_list(text[]) IS
  'Internal: allowed values as "a", "b", "c" for error messages.';

-- not_found: the record a caller named does not exist.
CREATE FUNCTION public.ytw_raise_not_found(p_entity text, p_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.ytw_raise(
    'not_found',
    format('%s %s does not exist: check the id', p_entity, p_id),
    jsonb_build_object('entity', p_entity, 'id', p_id));
END
$$;

COMMENT ON FUNCTION public.ytw_raise_not_found(text, uuid) IS
  'Internal: raise not_found for an entity id.';

-- version_conflict on a row that carries a version column (ideas): says what the caller sent, what
-- is current, and what to do. The latest version is also in DETAIL for programs. `p_expected` is
-- NULL when the caller named no version (advance_idea and archive_idea take it as optional) and the
-- idea was changed by somebody else while the call was running.
CREATE FUNCTION public.ytw_raise_version_conflict(
  p_entity text, p_id uuid, p_expected integer, p_latest integer
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.ytw_raise(
    'version_conflict',
    CASE
      WHEN p_expected IS NULL THEN
        format('%s %s was changed by someone else while this call was running: the latest version is %s; reload it and try again',
               p_entity, p_id, p_latest)
      ELSE
        format('%s %s has changed since you read it: you sent expected_version %s but the latest version is %s; reload it, apply your change again and retry with expected_version %s',
               p_entity, p_id, p_expected, p_latest, p_latest)
    END,
    jsonb_build_object('entity', p_entity, 'id', p_id,
                       'expected_version', p_expected, 'latest_version', p_latest));
END
$$;

COMMENT ON FUNCTION public.ytw_raise_version_conflict(text, uuid, integer, integer) IS
  'Internal: raise version_conflict (entity, id, expected, latest).';

-- invalid_transition: an archived idea (soft-deleted) is frozen. `p_what` completes the
-- sentence "... and cannot be <p_what>".
CREATE FUNCTION public.ytw_raise_idea_archived(p_id uuid, p_what text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.ytw_raise(
    'invalid_transition',
    format('idea %s is archived and cannot be %s', p_id, p_what),
    jsonb_build_object('entity', 'idea', 'id', p_id, 'reason', 'archived'),
    'Archived ideas are read-only. Create a new idea instead.');
END
$$;

COMMENT ON FUNCTION public.ytw_raise_idea_archived(uuid, text) IS
  'Internal: raise invalid_transition (reason archived) for an archived idea.';

-- ---------------------------------------------------------------------------------------------
-- Ideas
-- ---------------------------------------------------------------------------------------------
--
--   create_idea    inserts an idea in the inbox
--   update_idea    edits title, pitch, source, tags and score; needs the version the caller read
--   advance_idea   the stage machine; a move back needs a note, which is written in the same call
--   archive_idea   soft delete (archived_at); an archived idea is frozen
--
-- The stage rules mirror IDEA_STAGES and IDEA_STAGE_TRANSITIONS of @ytw/shared (test/constants.test.ts
-- compares them row by row). The field limits mirror the CHECK constraints of the ideas table: a
-- violated CHECK is a bare SQLSTATE 23514, so every limit is validated here first with a readable
-- error.

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

COMMENT ON FUNCTION public.ytw_check_idea_field(text, jsonb) IS
  'Internal: validate one editable idea field (title, pitch, source, tags, score) given as JSON.';

-- 3. create_idea: a new idea always starts in the inbox. Only title is required.
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

COMMENT ON FUNCTION public.update_idea(text, text, uuid, uuid, integer, jsonb) IS
  'Edit title, pitch, source, tags or score of an idea; p_expected_version must be the version read. Errors: validation, not_found, invalid_transition (archived), version_conflict.';

-- 5. archive_idea: soft delete. The idea keeps its row, scripts and notes but can no longer
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

COMMENT ON FUNCTION public.archive_idea(text, text, uuid, uuid, integer) IS
  'Soft-delete an idea (archived_at). Errors: validation, not_found, version_conflict.';

-- 6. advance_idea: the stage machine, the only way to change ideas.status.
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

COMMENT ON FUNCTION public.advance_idea(text, text, uuid, uuid, text, text, integer) IS
  'Move an idea to another stage under the stage rules; a note is required for a move back and is written as a note on the idea. Errors: validation, not_found, invalid_transition, version_conflict.';

-- ---------------------------------------------------------------------------------------------
-- Scripts
-- ---------------------------------------------------------------------------------------------
--
--   save_script_version  appends the next revision of an idea's script or packaging doc, if the
--                        caller edited the latest one (optimistic concurrency without a version
--                        column: scripts are append-only)
--   set_script_status    the one thing about a saved revision that may change: draft, review, approved
--
-- A violated CHECK is a bare SQLSTATE 23514, so the limits are validated here first with readable
-- errors.

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

COMMENT ON FUNCTION public.save_script_version(text, text, uuid, uuid, text, integer, text) IS
  'Append the next draft revision of an idea''s script or packaging doc if base_version is the latest (0 for the first). Errors: validation, not_found, invalid_transition (archived idea), version_conflict (latest_version).';

-- set_script_status: draft, review or approved, for one saved revision, in any order. The only
-- column of a saved revision that may change (the append-only guard of the scripts table allows
-- exactly this).
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

COMMENT ON FUNCTION public.set_script_status(text, text, uuid, uuid, text) IS
  'Set the review status (draft, review, approved) of one saved script revision. Errors: validation, not_found.';

-- ---------------------------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------------------------
--
-- Whether the target of a note exists is decided by the trigger on the notes table (a missing record
-- is not_found), which also rejects an unknown entity_type; add_note relies on it for both. What the
-- trigger cannot do is explain a violated CHECK or bound what it echoes: the entity_type is
-- pre-checked here only so that a hostile 1 MB value is not repeated in the error, and the body rules
-- (not blank, at most NOTE_BODY_MAX_BYTES of UTF-8) are validated here first.

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

COMMENT ON FUNCTION public.add_note(text, text, uuid, text, uuid, text) IS
  'Add a comment to an idea, script revision, video or experiment. Errors: validation, not_found.';

-- ---------------------------------------------------------------------------------------------
-- Video, metric and experiment helpers
-- ---------------------------------------------------------------------------------------------
--
-- Internal helpers for the functions below; the helpers above (ytw_fmt_value, ytw_fmt_list,
-- ytw_raise_not_found, ytw_raise_version_conflict) are reused. They run inside the SECURITY DEFINER
-- functions, after those have called ytw_set_actor().
--
-- A violated CHECK is a bare SQLSTATE 23514, so every rule of the videos and metrics tables is
-- validated here first with a message that says what is allowed. The checks accept nothing the
-- constraints refuse; where they are stricter (a time window, whole-number metrics, the retention
-- shape) the limit is in the message.

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

COMMENT ON FUNCTION public.ytw_metric_fmt_ts(timestamptz) IS
  'Internal: an instant as ISO 8601 UTC text for error messages.';

-- invalid_transition: an archived video (soft-deleted) is frozen. `p_what` completes the
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

COMMENT ON FUNCTION public.ytw_metric_number(text, jsonb, numeric, numeric, boolean, text) IS
  'Internal: validate one numeric metric given as JSON (number or decimal string); NULL when not given.';

-- The audience retention curve of a snapshot (video_metrics.retention): a JSON array of 1 to 1000
-- points {"t": seconds from the start of the video, "pct": percent of viewers still watching},
-- sorted by strictly increasing t, at most 64 KiB as jsonb text (the size the CHECK of the table measures).
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

COMMENT ON FUNCTION public.ytw_check_retention(jsonb) IS
  'Internal: validate the shape of a retention curve (points {t, pct}, sorted, at most 1000 points and 64 KiB).';

-- ---------------------------------------------------------------------------------------------
-- Videos
-- ---------------------------------------------------------------------------------------------
--
--   register_video  creates the record of a video that exists on YouTube (idea optional, youtube_id unique)
--   update_video    edits title, published_at, thumbnail_url and the idea link; needs the version the caller read
--   archive_video   soft delete (archived_at); an archived video is frozen
--
-- Registering a video never moves its idea to another stage: advance_idea is the only way to do that.

-- register_video(idea_id, youtube_id, title, published_at) plus an optional thumbnail. p_idea_id is NULL for a video without an idea; when given, the idea must exist (it may
-- be archived: the video's life does not depend on it). p_published_at is NULL while a video is not
-- scheduled yet and may lie in the future for a scheduled one. A youtube_id that is already
-- registered is a `duplicate` error that names the existing video, also when two callers register it
-- at the same time.
CREATE FUNCTION public.register_video(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_idea_id uuid, p_youtube_id text, p_title text,
  p_published_at timestamptz DEFAULT NULL,
  p_thumbnail_url text DEFAULT NULL
)
RETURNS public.videos
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_video public.videos;
  v_existing public.videos;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  PERFORM public.ytw_check_video_field('youtube_id', to_jsonb(p_youtube_id));
  PERFORM public.ytw_check_video_field('title', to_jsonb(p_title));
  IF p_published_at IS NOT NULL THEN
    PERFORM public.ytw_check_video_time('published_at', p_published_at, now() + interval '2 years',
                                        'scheduled videos can be at most 2 years ahead');
  END IF;
  PERFORM public.ytw_check_video_field('thumbnail_url', to_jsonb(p_thumbnail_url));
  IF p_idea_id IS NOT NULL THEN
    PERFORM 1 FROM public.ideas AS i WHERE i.id = p_idea_id;
    IF NOT FOUND THEN
      PERFORM public.ytw_raise_not_found('idea', p_idea_id);
    END IF;
  END IF;

  INSERT INTO public.videos (idea_id, youtube_id, title, published_at, thumbnail_url)
  VALUES (p_idea_id, p_youtube_id, p_title, p_published_at, p_thumbnail_url)
  ON CONFLICT ON CONSTRAINT videos_youtube_id_key DO NOTHING
  RETURNING * INTO v_video;
  IF FOUND THEN
    RETURN v_video;
  END IF;

  -- The conflicting row is committed (the insert waited for its transaction), so it can be read.
  SELECT * INTO v_existing FROM public.videos AS v WHERE v.youtube_id = p_youtube_id;
  PERFORM public.ytw_raise(
    'duplicate',
    format('youtube_id %s is already registered as video %s (%s)%s: work with that video instead of registering it again',
           public.ytw_fmt_value(p_youtube_id), v_existing.id, public.ytw_fmt_value(v_existing.title),
           CASE WHEN v_existing.archived_at IS NOT NULL THEN ', which is archived and read-only' ELSE '' END),
    jsonb_build_object('entity', 'video', 'field', 'youtube_id', 'value', p_youtube_id,
                       'existing_id', v_existing.id, 'existing_archived', v_existing.archived_at IS NOT NULL));
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.register_video(text, text, uuid, uuid, text, text, timestamptz, text) IS
  'Create the record of a YouTube video (idea optional, youtube_id unique). Errors: validation, not_found (idea), duplicate (existing_id).';

-- update_video: edits the fields named in p_fields (a JSON object; a key that is present is set,
-- "thumbnail_url": null clears it, an absent key is left alone). Editable: title, published_at,
-- thumbnail_url and idea_id (link or unlink the originating idea). youtube_id is the identity of the
-- video on YouTube, and its metrics and experiments belong to that video, so it cannot be changed.
-- The caller passes the version it read; if the video changed since, version_conflict carries
-- latest_version. Saving values equal to the stored ones changes nothing: no new version, no audit row.
CREATE FUNCTION public.update_video(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_id uuid, p_expected_version integer, p_fields jsonb
)
RETURNS public.videos
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_editable CONSTANT text[] := ARRAY['title', 'published_at', 'thumbnail_url', 'idea_id'];
  v_key text;
  v_video public.videos;
  v_title text;
  v_published_at timestamptz;
  v_thumbnail_url text;
  v_idea_id uuid;
  v_latest integer;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_id IS NULL THEN
    PERFORM public.ytw_raise('validation', 'id is required: pass the id of the video to update',
                             jsonb_build_object('field', 'id'));
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    PERFORM public.ytw_raise('validation',
      'expected_version is required: pass the version of the video you read (a whole number, at least 1)',
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
    IF v_key = 'youtube_id' THEN
      PERFORM public.ytw_raise('validation',
        'youtube_id cannot be changed: it identifies the video on YouTube, and its metrics and experiments belong to that video. If it was registered with the wrong id, archive this video and register the right one',
        jsonb_build_object('field', 'youtube_id', 'allowed', to_jsonb(c_editable)));
    END IF;
    IF NOT v_key = ANY (c_editable) THEN
      PERFORM public.ytw_raise('validation',
        format('field %s cannot be edited; editable fields: %s',
               public.ytw_fmt_value(v_key), public.ytw_fmt_list(c_editable)),
        jsonb_build_object('field', left(v_key, 60), 'allowed', to_jsonb(c_editable)));
    END IF;
    PERFORM public.ytw_check_video_field(v_key, p_fields -> v_key);
  END LOOP;

  -- The row lock serialises writers of this video; the version check below then sees the winner.
  SELECT * INTO v_video FROM public.videos WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_not_found('video', p_id);
  END IF;
  IF v_video.archived_at IS NOT NULL THEN
    PERFORM public.ytw_raise_video_archived(p_id, 'edited');
  END IF;
  IF v_video.version <> p_expected_version THEN
    PERFORM public.ytw_raise_version_conflict('video', p_id, p_expected_version, v_video.version);
  END IF;

  v_title := CASE WHEN p_fields ? 'title' THEN p_fields ->> 'title' ELSE v_video.title END;
  v_published_at := CASE WHEN p_fields ? 'published_at'
                         THEN (p_fields ->> 'published_at')::timestamptz ELSE v_video.published_at END;
  v_thumbnail_url := CASE WHEN p_fields ? 'thumbnail_url'
                          THEN p_fields ->> 'thumbnail_url' ELSE v_video.thumbnail_url END;
  v_idea_id := CASE WHEN p_fields ? 'idea_id' THEN (p_fields ->> 'idea_id')::uuid ELSE v_video.idea_id END;

  IF v_idea_id IS NOT NULL AND v_idea_id IS DISTINCT FROM v_video.idea_id THEN
    PERFORM 1 FROM public.ideas AS i WHERE i.id = v_idea_id;
    IF NOT FOUND THEN
      PERFORM public.ytw_raise_not_found('idea', v_idea_id);
    END IF;
  END IF;

  IF (v_title, v_published_at, v_thumbnail_url, v_idea_id)
     IS NOT DISTINCT FROM (v_video.title, v_video.published_at, v_video.thumbnail_url, v_video.idea_id) THEN
    RETURN v_video;
  END IF;

  -- The update names the version that was read: if the row lock were ever bypassed, a concurrent
  -- change finds no row here and is reported as the conflict it is, never overwritten.
  UPDATE public.videos
     SET title = v_title, published_at = v_published_at, thumbnail_url = v_thumbnail_url,
         idea_id = v_idea_id
   WHERE id = p_id AND version = v_video.version
  RETURNING * INTO v_video;
  IF NOT FOUND THEN
    SELECT v.version INTO v_latest FROM public.videos AS v WHERE v.id = p_id;
    PERFORM public.ytw_raise_version_conflict('video', p_id, p_expected_version, v_latest);
  END IF;
  RETURN v_video;
END
$$;

COMMENT ON FUNCTION public.update_video(text, text, uuid, uuid, integer, jsonb) IS
  'Edit title, published_at, thumbnail_url or idea_id of a video; p_expected_version must be the version read. Errors: validation, not_found, invalid_transition (archived), version_conflict.';

-- archive_video: soft delete. The video keeps its row, metrics, experiments and notes but
-- can no longer be edited, given metric snapshots or given experiments (its existing experiments
-- can still be recorded, concluded or cancelled, so that none is left running for good). Archiving
-- twice is a no-op. p_expected_version is optional: pass it when the caller acts on a version it read.
CREATE FUNCTION public.archive_video(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_id uuid, p_expected_version integer DEFAULT NULL
)
RETURNS public.videos
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_video public.videos;
  v_latest integer;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_id IS NULL THEN
    PERFORM public.ytw_raise('validation', 'id is required: pass the id of the video to archive',
                             jsonb_build_object('field', 'id'));
  END IF;
  IF p_expected_version IS NOT NULL AND p_expected_version < 1 THEN
    PERFORM public.ytw_raise('validation',
      'expected_version must be a whole number of at least 1, or omitted to archive whatever the latest version is',
      jsonb_build_object('field', 'expected_version'));
  END IF;

  SELECT * INTO v_video FROM public.videos WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_not_found('video', p_id);
  END IF;
  IF p_expected_version IS NOT NULL AND v_video.version <> p_expected_version THEN
    PERFORM public.ytw_raise_version_conflict('video', p_id, p_expected_version, v_video.version);
  END IF;
  IF v_video.archived_at IS NOT NULL THEN
    RETURN v_video;
  END IF;

  UPDATE public.videos SET archived_at = now()
   WHERE id = p_id AND version = v_video.version
  RETURNING * INTO v_video;
  IF NOT FOUND THEN
    SELECT v.version INTO v_latest FROM public.videos AS v WHERE v.id = p_id;
    PERFORM public.ytw_raise_version_conflict('video', p_id, p_expected_version, v_latest);
  END IF;
  RETURN v_video;
END
$$;

COMMENT ON FUNCTION public.archive_video(text, text, uuid, uuid, integer) IS
  'Soft-delete a video (archived_at). Errors: validation, not_found, version_conflict.';

-- ---------------------------------------------------------------------------------------------
-- Metric snapshots
-- ---------------------------------------------------------------------------------------------
--
-- video_metrics is append-only with a unique key (video_id, captured_at). log_metrics is idempotent
-- on that key: an agent that repeats a call (a timeout, a retry) gets the stored snapshot back with
-- created = false, and a *different* payload for an existing key is refused with a readable error
-- that shows both sets of numbers, because a snapshot never changes.

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

COMMENT ON FUNCTION public.log_metrics(text, text, uuid, uuid, timestamptz, jsonb) IS
  'Append a metric snapshot of a video; idempotent on (video_id, captured_at): a repeat returns the stored row with created = false, other numbers for the same key are refused. Errors: validation, not_found, invalid_transition (archived), duplicate.';

-- ---------------------------------------------------------------------------------------------
-- Experiments
-- ---------------------------------------------------------------------------------------------
--
--   create_experiment        an experiment (status planned) with its variants, in one call
--   update_experiment_status the status machine: planned -> running -> concluded | cancelled
--   record_variant_stats     impressions and CTR of one variant, while the experiment is planned or running
--   conclude_experiment      running -> concluded, with the winner (optional) and the conclusion
--
-- type and status mirror EXPERIMENT_TYPES and EXPERIMENT_STATUSES of @ytw/shared, and the status
-- machine is compared row by row in test/constants.test.ts.
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

COMMENT ON FUNCTION public.ytw_check_variants(jsonb) IS
  'Internal: validate the variants argument of create_experiment.';

-- create_experiment(video_id, type, hypothesis, variants). The experiment
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

COMMENT ON FUNCTION public.conclude_experiment(text, text, uuid, uuid, integer, uuid, text) IS
  'Conclude a running experiment with a winner (one of its variants, or NULL) and a conclusion; final. Errors: validation (winner_variant_id lists the valid ids), not_found, version_conflict, invalid_transition.';

-- =============================================================================================
-- 6. Identity
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
--
-- The building blocks of the identity, permission, token and session functions below. They run
-- inside the SECURITY DEFINER functions that call them, so they are plain (invoker) functions.
--
-- The object list and the level rules mirror RESOURCES, LEVELS and GRANTABLE_LEVELS of @ytw/shared
-- and the admin rule of @ytw/policy; test/constants.test.ts checks the lists. Adding an object type
-- means replacing ytw_resources(), ytw_max_level() and the CHECK constraints of user_permissions and
-- api_token_permissions together.

-- 1. The objects that carry an access level, in display order (RESOURCES). The only SQL list that
--    the functions below read; the CHECK constraints of user_permissions and api_token_permissions
--    spell the same list out and must be replaced together with this function.
CREATE FUNCTION public.ytw_resources()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT ARRAY['ideas', 'scripts', 'experiments', 'videos', 'notes', 'activity']::text[]
$$;

-- 2. Levels are none < read < write; Write includes Read. NULL for anything else, so a corrupt value
--    can never compare as "high enough" (callers treat NULL as none).
CREATE FUNCTION public.ytw_level_rank(p_level text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE p_level WHEN 'none' THEN 0 WHEN 'read' THEN 1 WHEN 'write' THEN 2 END
$$;

-- 3. The highest level an object can ever hold (GRANTABLE_LEVELS): read for the activity log (it is
--    none or read only), write for everything else, NULL for an unknown object.
CREATE FUNCTION public.ytw_max_level(p_resource text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_resource = ANY (ARRAY['activity']::text[]) THEN 'read'
    WHEN p_resource = ANY (public.ytw_resources()) THEN 'write'
  END
$$;

-- 4. The lower of two levels. An unknown level counts as none: fail closed.
CREATE FUNCTION public.ytw_least_level(p_a text, p_b text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT (ARRAY['none', 'read', 'write']::text[])[
    least(coalesce(public.ytw_level_rank(p_a), 0), coalesce(public.ytw_level_rank(p_b), 0)) + 1
  ]
$$;

-- 5. A level capped at what the object allows (@ytw/policy capLevel).
CREATE FUNCTION public.ytw_cap_level(p_resource text, p_level text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.ytw_least_level(p_level, public.ytw_max_level(p_resource))
$$;

-- 6. The lock that serialises everything deciding who is an admin: the first login (the first user
--    ever becomes admin), promotions and demotions (the last admin stays). Transaction-scoped, so it
--    is released at COMMIT or ROLLBACK and cannot leak out of a pooled connection; keep the
--    transaction short. Key space 0x59545721 ("YTW!") with object 1 = "users and admins" (object 2
--    serialises the seeding of the API token).
--
--    The NOT EXISTS checks that run after the lock (first login, last admin) are sound only when
--    every statement reads fresh data (READ COMMITTED, the default): under REPEATABLE READ the
--    snapshot is taken by the first statement of the transaction (for withActor() that is
--    ytw_set_actor), before the lock was granted, so two transactions could both read "no user yet"
--    or "another admin exists" and both proceed. SERIALIZABLE is safe: Postgres aborts one of the two
--    with 40001, which callers treat as "retry". So this refuses a REPEATABLE READ transaction before
--    it takes the lock.
CREATE FUNCTION public.ytw_lock_users()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    PERFORM public.ytw_raise(
      'validation',
      'users, admins and access levels cannot be changed in a REPEATABLE READ transaction: its snapshot is taken before the lock that keeps the first admin the only one and the last admin in place is granted, so two requests could both pass the check. Use the default isolation level (READ COMMITTED) or SERIALIZABLE',
      jsonb_build_object('reason', 'isolation_level', 'isolation', 'repeatable read',
                         'allowed', jsonb_build_array('read committed', 'serializable')),
      'Remove the isolation level override of the connection or transaction: withActor() uses READ COMMITTED.');
  END IF;
  PERFORM pg_advisory_xact_lock(1498699553, 1);
END
$$;

-- 7. A user's EFFECTIVE level on every object, as one jsonb object {"ideas": "write", ...}: none
--    everywhere while access is revoked (admins included); otherwise the maximum everywhere for an
--    admin or the system user whatever rows are stored (@ytw/policy userLevels), and for everyone
--    else the stored level (none when no row), capped per object. NULL when the user does not exist.
--    The system user owns the seeded API token: its ceiling is the maximum on every object, so the
--    token's own levels are what applies.
CREATE FUNCTION public.ytw_user_effective_levels(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT jsonb_object_agg(
           r.resource,
           CASE WHEN u.access_revoked_at IS NOT NULL THEN 'none'
                WHEN u.is_admin OR u.is_system THEN public.ytw_max_level(r.resource)
                ELSE public.ytw_cap_level(r.resource, coalesce(p.level, 'none')) END)
  FROM public.users u
  CROSS JOIN LATERAL unnest(public.ytw_resources()) AS r (resource)
  LEFT JOIN public.user_permissions p ON p.user_id = u.id AND p.resource = r.resource
  WHERE u.id = p_user_id
$$;

-- 8. A token's OWN level on every object ({"ideas": "read", ...}; none when no row), capped per
--    object. Not limited by the owner: see ytw_effective_levels().
CREATE FUNCTION public.ytw_token_own_levels(p_api_token_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT jsonb_object_agg(
           r.resource,
           public.ytw_cap_level(r.resource, coalesce(p.level, 'none')))
  FROM unnest(public.ytw_resources()) AS r (resource)
  LEFT JOIN ytw_private.api_token_permissions p
         ON p.token_id = p_api_token_id AND p.resource = r.resource
$$;

-- 9. What a token can actually do: per object the lower of its own level and its owner's current
--    effective level (@ytw/policy effectiveLevels). A missing key counts as none.
CREATE FUNCTION public.ytw_effective_levels(p_token_levels jsonb, p_owner_levels jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT jsonb_object_agg(
           r.resource,
           public.ytw_cap_level(
             r.resource,
             public.ytw_least_level(p_token_levels ->> r.resource, p_owner_levels ->> r.resource)))
  FROM unnest(public.ytw_resources()) AS r (resource)
$$;

-- 10. Optional profile text from the identity provider: control characters become spaces, the text is
--     trimmed and cut to p_max characters; nothing left means NULL. Login must never fail because an
--     optional claim is odd.
CREATE FUNCTION public.ytw_clean_text(p_value text, p_max integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT nullif(btrim(left(btrim(regexp_replace(p_value, '[[:cntrl:]]+', ' ', 'g')), p_max)), '')
$$;

-- 11. An email claim, or NULL when it cannot be stored (users_email_check: 3-320 characters, no
--     whitespace or control characters).
CREATE FUNCTION public.ytw_clean_email(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN char_length(btrim(p_value)) BETWEEN 3 AND 320
     AND btrim(p_value) !~ '[[:space:][:cntrl:]]' THEN btrim(p_value)
  END
$$;

-- 12. Gate of every function that manages users, access or tokens: the actor must be a signed-in
--     PERSON (API tokens never act as users or admins), the acting user must exist, carry the actor's
--     name (so the audit log attributes the change to the person who is allowed to make it), have
--     access that is not revoked and, when asked, be an admin. The acting user's row is share-locked
--     until the end of the transaction, so a concurrent demotion waits for this call instead of
--     racing it. Returns the acting user.
CREATE FUNCTION public.ytw_acting_user(
  p_actor text,
  p_actor_type text,
  p_acting_user_id uuid,
  p_what text,
  p_require_admin boolean
)
RETURNS public.users
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user public.users;
BEGIN
  IF p_actor_type IS DISTINCT FROM 'human' THEN
    PERFORM public.ytw_raise(
      'forbidden',
      format('only a signed-in person can %s: API tokens never manage users, access levels or tokens (use the web app)',
             p_what),
      jsonb_build_object('reason', 'not_human'));
  END IF;
  IF p_acting_user_id IS NULL THEN
    PERFORM public.ytw_raise(
      'validation', 'the acting user id is required', jsonb_build_object('field', 'acting_user_id'));
  END IF;

  SELECT * INTO v_user FROM public.users u WHERE u.id = p_acting_user_id FOR SHARE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise(
      'not_found',
      format('the acting user %s does not exist', p_acting_user_id),
      jsonb_build_object('entity', 'user', 'id', p_acting_user_id));
  END IF;
  IF v_user.is_system THEN
    PERFORM public.ytw_raise(
      'forbidden',
      format('the built-in system user is not a person and cannot %s', p_what),
      jsonb_build_object('reason', 'system_user'));
  END IF;
  IF v_user.username <> btrim(p_actor) THEN
    PERFORM public.ytw_raise(
      'forbidden',
      format('the audit actor %s is not the acting user %s: pass the signed-in user''s username as the actor',
             to_json(btrim(p_actor)), to_json(v_user.username)),
      jsonb_build_object('reason', 'actor_mismatch'));
  END IF;
  IF v_user.access_revoked_at IS NOT NULL THEN
    PERFORM public.ytw_raise(
      'forbidden',
      format('the access of %s is revoked, so they cannot %s: they are outside the access group of the identity provider or an admin locked them out, and it returns when they sign in again with access',
             to_json(v_user.username), p_what),
      jsonb_build_object('reason', 'access_revoked'));
  END IF;
  IF p_require_admin AND NOT v_user.is_admin THEN
    PERFORM public.ytw_raise(
      'forbidden',
      format('only an admin can %s, and %s is not an admin', p_what, to_json(v_user.username)),
      jsonb_build_object('reason', 'not_admin'));
  END IF;
  RETURN v_user;
END
$$;

-- 13. Makes sure a user has a row for every object: none for everyone, and for an admin the maximum
--     (rows that are lower are raised, never lowered). Idempotent; writes nothing when the rows are
--     already right, so it leaves no audit events then.
CREATE FUNCTION public.ytw_sync_user_rows(p_user_id uuid, p_is_admin boolean)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
  INSERT INTO public.user_permissions AS up (user_id, resource, level)
  SELECT p_user_id, r.resource,
         CASE WHEN p_is_admin THEN public.ytw_max_level(r.resource) ELSE 'none' END
  FROM unnest(public.ytw_resources()) AS r (resource)
  ON CONFLICT (user_id, resource) DO UPDATE
    SET level = EXCLUDED.level
    WHERE p_is_admin
      AND coalesce(public.ytw_level_rank(up.level), 0) < public.ytw_level_rank(EXCLUDED.level)
$$;

-- 14a. A caller-supplied JSON value inside an error message, bounded like ytw_fmt_value(): a
--      string JSON-quoted and cut after 60 characters, a number, boolean or null as it is (cut the
--      same way), an array or object by its type, so a megabyte-sized request is never echoed back.
CREATE FUNCTION public.ytw_fmt_json(p_value jsonb)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE jsonb_typeof(p_value)
    WHEN 'string' THEN public.ytw_fmt_value(p_value #>> '{}')
    WHEN 'array' THEN 'an array'
    WHEN 'object' THEN 'an object'
    ELSE coalesce(left(p_value::text, 60), 'NULL')
  END
$$;

-- 14b. The same value for the DETAIL of an error (a bounded jsonb): scalars as they are, strings and
--      numbers cut after 60 characters, arrays and objects by their type.
CREATE FUNCTION public.ytw_brief_json(p_value jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE jsonb_typeof(p_value)
    WHEN 'string' THEN to_jsonb(left(p_value #>> '{}', 60))
    WHEN 'array' THEN to_jsonb('array'::text)
    WHEN 'object' THEN to_jsonb('object'::text)
    WHEN 'number' THEN CASE WHEN char_length(p_value::text) > 60 THEN to_jsonb(left(p_value::text, 60))
                            ELSE p_value END
    ELSE p_value
  END
$$;

-- 14. Validates the levels requested for a token and returns them normalised ({"ideas": "read"}:
--     only the objects asked for). Every problem is reported at once, in the wording of @ytw/policy
--     grantViolations: an unknown object or level is a validation error; a level above what the
--     owner holds (or never allowed on the object) is a forbidden error that lists what is allowed.
CREATE FUNCTION public.ytw_check_token_grant(
  p_owner_username text,
  p_owner_levels jsonb,
  p_requested jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_resources text[] := public.ytw_resources();
  v_normalised jsonb := '{}'::jsonb;
  v_invalid jsonb := '[]'::jsonb;
  v_exceeds jsonb := '[]'::jsonb;
  v_messages text[] := '{}';
  v_resource text;
  v_value jsonb;
  v_level text;
  v_ceiling text;
  v_max text;
  v_allowed text[];
  v_choose text;
BEGIN
  IF p_requested IS NULL OR jsonb_typeof(p_requested) <> 'object' THEN
    PERFORM public.ytw_raise(
      'validation',
      format('permissions must be a JSON object such as {"ideas": "read"}; valid objects: %s; valid levels: none, read, write',
             array_to_string(v_resources, ', ')),
      jsonb_build_object('field', 'permissions', 'allowed', to_jsonb(v_resources)));
  END IF;

  -- A request names each object at most once, so more entries than objects can only be junk; do not
  -- walk (or describe) an arbitrarily large map.
  IF (SELECT count(*) FROM jsonb_object_keys(p_requested)) > 2 * cardinality(v_resources) THEN
    PERFORM public.ytw_raise(
      'validation',
      format('permissions names %s entries, but only %s objects have access levels (%s)',
             (SELECT count(*) FROM jsonb_object_keys(p_requested)), cardinality(v_resources),
             array_to_string(v_resources, ', ')),
      jsonb_build_object('field', 'permissions', 'allowed', to_jsonb(v_resources)));
  END IF;

  FOR v_resource, v_value IN SELECT e.key, e.value FROM jsonb_each(p_requested) e ORDER BY e.key LOOP
    IF NOT v_resource = ANY (v_resources) THEN
      v_invalid := v_invalid || jsonb_build_object(
        'resource', left(v_resource, 60), 'reason', 'unknown_resource', 'allowed', to_jsonb(v_resources));
      v_messages := v_messages || format('%s is not an object with access levels; valid objects: %s',
                                         public.ytw_fmt_value(v_resource),
                                         array_to_string(v_resources, ', '));
      CONTINUE;
    END IF;

    -- What the object can ever hold, and what this owner may hand out on it (never more than that).
    v_max := public.ytw_max_level(v_resource);
    v_ceiling := public.ytw_cap_level(v_resource, p_owner_levels ->> v_resource);
    v_allowed := ARRAY(
      SELECT l FROM unnest(ARRAY['none', 'read', 'write']::text[]) AS l
      WHERE public.ytw_level_rank(l) <= public.ytw_level_rank(v_ceiling));
    v_level := CASE WHEN jsonb_typeof(v_value) = 'string' THEN v_value #>> '{}' END;
    v_choose := 'choose one of: ' || array_to_string(v_allowed, ', ');

    IF public.ytw_level_rank(v_level) IS NULL THEN
      v_invalid := v_invalid || jsonb_build_object(
        'resource', v_resource, 'requested', public.ytw_brief_json(v_value), 'reason', 'invalid_level',
        'allowed', to_jsonb(v_allowed));
      v_messages := v_messages || format('%s is not an access level for %s; %s',
                                         public.ytw_fmt_json(v_value), v_resource, v_choose);
    ELSIF public.ytw_level_rank(v_level) > public.ytw_level_rank(v_max) THEN
      v_invalid := v_invalid || jsonb_build_object(
        'resource', v_resource, 'requested', v_level, 'reason', 'not_grantable',
        'allowed', to_jsonb(v_allowed));
      v_messages := v_messages || format(
        '%s is never allowed on %s (it allows %s); %s',
        v_level, v_resource,
        array_to_string(ARRAY(
          SELECT l FROM unnest(ARRAY['none', 'read', 'write']::text[]) AS l
          WHERE public.ytw_level_rank(l) <= public.ytw_level_rank(v_max)), ', '),
        v_choose);
    ELSIF public.ytw_level_rank(v_level) > public.ytw_level_rank(v_ceiling) THEN
      v_exceeds := v_exceeds || jsonb_build_object(
        'resource', v_resource, 'requested', v_level, 'reason', 'exceeds_owner',
        'owner_level', v_ceiling, 'allowed', to_jsonb(v_allowed));
      v_messages := v_messages || format(
        '%s on %s is above the owner''s own level (%s); a token never exceeds its owner; %s',
        v_level, v_resource, v_ceiling, v_choose);
    ELSE
      v_normalised := v_normalised || jsonb_build_object(v_resource, v_level);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_invalid) > 0 THEN
    PERFORM public.ytw_raise(
      'validation',
      format('token permissions rejected: %s', array_to_string(v_messages, '; ')),
      jsonb_build_object('field', 'permissions', 'violations', v_invalid || v_exceeds));
  ELSIF jsonb_array_length(v_exceeds) > 0 THEN
    PERFORM public.ytw_raise(
      'forbidden',
      format('token permissions rejected for %s: %s', to_json(p_owner_username),
             array_to_string(v_messages, '; ')),
      jsonb_build_object('reason', 'exceeds_owner', 'violations', v_exceeds));
  END IF;
  RETURN v_normalised;
END
$$;

-- 15. The checks of an OIDC identity (issuer and subject), shared by the sign-in and the
--     revocation that name a person by it.
CREATE FUNCTION public.ytw_check_identity_claims(p_issuer text, p_sub text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_issuer IS NULL OR char_length(p_issuer) NOT BETWEEN 1 AND 2048
     OR p_issuer ~ '[[:space:][:cntrl:]]' THEN
    PERFORM public.ytw_raise(
      'validation',
      'issuer is required: the OIDC issuer URL, 1-2048 characters without whitespace',
      jsonb_build_object('field', 'issuer'));
  END IF;
  IF p_sub IS NULL OR char_length(p_sub) NOT BETWEEN 1 AND 255 OR p_sub ~ '[[:cntrl:]]' THEN
    PERFORM public.ytw_raise(
      'validation',
      'sub is required: the OIDC subject of the user, 1-255 characters without control characters',
      jsonb_build_object('field', 'sub'));
  END IF;
END
$$;


-- ---------------------------------------------------------------------------------------------
-- Sign-in
-- ---------------------------------------------------------------------------------------------
--
-- upsert_user_on_login creates or updates the app user behind an OIDC identity: the very first user
-- ever becomes admin with the maximum level on every object, in the same transaction and race-free;
-- every later user starts with none everywhere until an admin sets their levels. get_user_access
-- reads a user back with the levels they hold right now. The built-in system user is not a person: it
-- does not count as the first user and cannot sign in.

-- A user as the web contract needs them (GET /api/me, the access matrix). `levels` holds the
-- EFFECTIVE level on every object (what @ytw/policy userLevels computes): admins have the maximum
-- everywhere, everyone else their stored level (none without a row), and none while access is
-- revoked (`access_revoked_at` says why).
CREATE TYPE public.ytw_user_access AS (
  user_id uuid,
  oidc_issuer text,
  oidc_sub text,
  username text,
  email text,
  display_name text,
  is_admin boolean,
  last_login_at timestamptz,
  created_at timestamptz,
  levels jsonb,
  access_revoked_at timestamptz
);

-- Signs a person in. The audit actor must be the person themselves: actor = their preferred_username,
-- type human. Returns the user (profile mirrored from the identity provider's latest claims) and the
-- levels they hold, with created = true when this call made the account.
--
--   * The user is looked up by (issuer, sub); the username may change, the identity may not.
--   * ytw_lock_users() serialises every login: whoever finds no user at all becomes admin, so any
--     number of simultaneous first logins produce exactly one admin.
--   * email and display_name are optional: values that cannot be stored are dropped (NULL) instead of
--     failing the login. issuer, sub and username are required.
--   * Every user gets one row per object (none; the maximum for an admin), so lists never have holes.
--   * last_login_at is an audited change, so every login leaves an `update` event on the user.
--   * A person whose access was revoked has it back: they passed the group check to get here. The
--     restoration is logged as user.access_restored.
CREATE FUNCTION public.upsert_user_on_login(
  p_actor text,
  p_actor_type text,
  p_token_id uuid,
  p_issuer text,
  p_sub text,
  p_username text,
  p_email text DEFAULT NULL,
  p_display_name text DEFAULT NULL
)
RETURNS TABLE (
  user_id uuid,
  oidc_issuer text,
  oidc_sub text,
  username text,
  email text,
  display_name text,
  is_admin boolean,
  last_login_at timestamptz,
  created_at timestamptz,
  levels jsonb,
  created boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_username text := btrim(p_username);
  v_email text := public.ytw_clean_email(p_email);
  v_display_name text := public.ytw_clean_text(p_display_name, 200);
  v_now timestamptz := statement_timestamp();
  v_user public.users;
  v_created boolean := false;
  v_was_revoked boolean := false;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_actor_type <> 'human' THEN
    PERFORM public.ytw_raise(
      'forbidden',
      'only a person signs in through the identity provider: API tokens cannot log in',
      jsonb_build_object('reason', 'not_human'));
  END IF;
  PERFORM public.ytw_check_identity_claims(p_issuer, p_sub);
  IF v_username IS NULL OR v_username = '' OR char_length(v_username) > 200
     OR v_username ~ '[[:cntrl:]]' THEN
    PERFORM public.ytw_raise(
      'validation',
      'username is required: the OIDC preferred_username, 1-200 characters without control characters',
      jsonb_build_object('field', 'username'));
  END IF;
  IF btrim(p_actor) <> v_username THEN
    PERFORM public.ytw_raise(
      'forbidden',
      format('the audit actor %s is not the signing-in user %s: a login is recorded under the username of the person signing in',
             to_json(btrim(p_actor)), to_json(v_username)),
      jsonb_build_object('reason', 'actor_mismatch'));
  END IF;

  PERFORM public.ytw_lock_users();

  SELECT * INTO v_user FROM public.users u
   WHERE u.oidc_issuer = p_issuer AND u.oidc_sub = p_sub
   FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.users (oidc_issuer, oidc_sub, username, email, display_name, is_admin, last_login_at)
    VALUES (p_issuer, p_sub, v_username, v_email, v_display_name,
            NOT EXISTS (SELECT 1 FROM public.users x WHERE NOT x.is_system), v_now)
    RETURNING * INTO v_user;
    v_created := true;
  ELSIF v_user.is_system THEN
    PERFORM public.ytw_raise(
      'forbidden',
      'the built-in system user is not a person and cannot sign in',
      jsonb_build_object('reason', 'system_user'));
  ELSE
    v_was_revoked := v_user.access_revoked_at IS NOT NULL;
    UPDATE public.users u
       SET username = v_username, email = v_email, display_name = v_display_name,
           last_login_at = v_now, access_revoked_at = NULL
     WHERE u.id = v_user.id
    RETURNING * INTO v_user;
    IF v_was_revoked THEN
      PERFORM public.ytw_log_event(
        p_actor, p_actor_type, p_token_id, 'user.access_restored', 'user', v_user.id,
        jsonb_build_object('user', v_user.username, 'via', 'sign_in'));
    END IF;
  END IF;

  PERFORM public.ytw_sync_user_rows(v_user.id, v_user.is_admin);

  RETURN QUERY
  SELECT v_user.id, v_user.oidc_issuer, v_user.oidc_sub, v_user.username, v_user.email,
         v_user.display_name, v_user.is_admin, v_user.last_login_at, v_user.created_at,
         public.ytw_user_effective_levels(v_user.id), v_created;
END
$$;

COMMENT ON FUNCTION public.upsert_user_on_login(text, text, uuid, text, text, text, text, text) IS
  'Sign a person in: create or update the user for an OIDC identity. The first user ever becomes admin (race-free); later users start with none everywhere. Lifts a revoked access. Call it only after the access group check passed. The system user never counts as the first user and cannot sign in.';

-- The user and the levels they hold right now (admins: the maximum everywhere). is_admin is the
-- EFFECTIVE flag (an admin whose access is revoked is not one), levels the effective levels,
-- access_revoked_at says why they are none. No rows for an unknown id, and none for the system user.
-- The web server calls this on every request: levels are never cached.
CREATE FUNCTION public.get_user_access(p_user_id uuid)
RETURNS SETOF public.ytw_user_access
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT u.id, u.oidc_issuer, u.oidc_sub, u.username, u.email, u.display_name,
         (u.is_admin AND u.access_revoked_at IS NULL),
         u.last_login_at, u.created_at, public.ytw_user_effective_levels(u.id),
         u.access_revoked_at
  FROM public.users u
  WHERE u.id = p_user_id AND NOT u.is_system
$$;

COMMENT ON FUNCTION public.get_user_access(uuid) IS
  'A user with the levels they hold right now (admins: the maximum everywhere; revoked access: none and not an admin, with access_revoked_at). No row when the id is unknown or belongs to the system user.';

-- ---------------------------------------------------------------------------------------------
-- Access levels
-- ---------------------------------------------------------------------------------------------
--
-- An admin sets a user's level per object, promotes and demotes admins, and lists the access matrix.
-- The rules live here, not in the callers:
--   * only a signed-in person who is an admin may change access; API tokens never can;
--   * the activity log is never write;
--   * an admin holds the maximum on every object, so their rows are never lowered, and promoting a
--     user raises their stored rows to the maximum in the same transaction (the database then agrees
--     with @ytw/policy userLevels, which gives admins the maximum whatever rows are stored);
--   * the last admin whose access is active cannot be demoted. Promotions, demotions and logins are
--     serialised with ytw_lock_users(), so two admins demoting each other at the same moment cannot
--     leave the system without one;
--   * demoting an admin resets their levels to none, so it lowers their tokens too (see the token
--     functions).
-- Besides the row-level events of the audit triggers, each change writes one readable event
-- (user.permission_changed, user.admin_granted, user.admin_revoked) that names the person and the
-- object: the trigger payloads carry only the changed columns.
--
-- One lock order: every function that writes users, permission rows or revocations takes
-- ytw_lock_users() FIRST, before it locks any user row (advisory lock, then rows). Functions that
-- only write token rows share-lock their owner's row and never wait for the advisory lock, so they
-- cannot be part of a cycle.
-- The system user is invisible to all of these: a lookup of it answers "unknown user".

-- Sets one cell of the access matrix. A no-op (the level already holds) writes nothing and reports
-- changed = false. Lowering an admin's level is refused.
CREATE FUNCTION public.set_user_permission(
  p_actor text,
  p_actor_type text,
  p_token_id uuid,
  p_acting_user_id uuid,
  p_user_id uuid,
  p_resource text,
  p_level text
)
RETURNS TABLE (
  user_id uuid,
  resource text,
  previous_level text,
  level text,
  changed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_resources text[] := public.ytw_resources();
  v_max text;
  v_target public.users;
  v_row_id uuid;
  v_old text;
  v_previous text;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  -- Before any user row is locked: the one lock order of the identity functions.
  PERFORM public.ytw_lock_users();
  PERFORM public.ytw_acting_user(p_actor, p_actor_type, p_acting_user_id, 'change access levels', true);

  IF p_user_id IS NULL THEN
    PERFORM public.ytw_raise(
      'validation', 'user_id is required', jsonb_build_object('field', 'user_id'));
  END IF;
  IF p_resource IS NULL OR NOT p_resource = ANY (v_resources) THEN
    PERFORM public.ytw_raise(
      'validation',
      format('resource %s is not an object with access levels; valid objects: %s',
             public.ytw_fmt_value(p_resource), array_to_string(v_resources, ', ')),
      jsonb_build_object('field', 'resource', 'value', left(p_resource, 60),
                         'allowed', to_jsonb(v_resources)));
  END IF;
  IF public.ytw_level_rank(p_level) IS NULL THEN
    PERFORM public.ytw_raise(
      'validation',
      format('level %s is not an access level; valid levels: none, read, write',
             public.ytw_fmt_value(p_level)),
      jsonb_build_object('field', 'level', 'value', left(p_level, 60),
                         'allowed', jsonb_build_array('none', 'read', 'write')));
  END IF;
  v_max := public.ytw_max_level(p_resource);
  IF public.ytw_level_rank(p_level) > public.ytw_level_rank(v_max) THEN
    PERFORM public.ytw_raise(
      'validation',
      format('%s is never allowed on %s (the maximum is %s); choose one of: %s',
             p_level, p_resource, v_max,
             array_to_string(ARRAY(SELECT l FROM unnest(ARRAY['none', 'read', 'write']::text[]) AS l
                                   WHERE public.ytw_level_rank(l) <= public.ytw_level_rank(v_max)), ', ')),
      jsonb_build_object('field', 'level', 'value', p_level, 'resource', p_resource,
                         'allowed', to_jsonb(ARRAY(SELECT l FROM unnest(ARRAY['none', 'read', 'write']::text[]) AS l
                                                   WHERE public.ytw_level_rank(l) <= public.ytw_level_rank(v_max)))));
  END IF;

  -- Share-locked until COMMIT: nobody can change this user's row under us. (The advisory lock
  -- already serialises the identity functions; this also covers a caller that locks rows itself.)
  SELECT * INTO v_target FROM public.users u WHERE u.id = p_user_id AND NOT u.is_system FOR SHARE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise(
      'not_found',
      format('user %s does not exist: users appear after their first login', p_user_id),
      jsonb_build_object('entity', 'user', 'id', p_user_id));
  END IF;

  IF v_target.is_admin THEN
    IF public.ytw_level_rank(p_level) < public.ytw_level_rank(v_max) THEN
      PERFORM public.ytw_raise(
        'forbidden',
        format('%s is an admin and always holds %s on %s: demote them first (set_user_admin) before lowering their access',
               to_json(v_target.username), v_max, p_resource),
        jsonb_build_object('reason', 'target_is_admin', 'resource', p_resource, 'level', v_max));
    END IF;
    PERFORM public.ytw_sync_user_rows(v_target.id, true);
    RETURN QUERY SELECT v_target.id, p_resource, v_max, v_max, false;
    RETURN;
  END IF;

  SELECT up.id, up.level INTO v_row_id, v_old
    FROM public.user_permissions up
   WHERE up.user_id = v_target.id AND up.resource = p_resource
   FOR UPDATE;
  v_previous := coalesce(v_old, 'none');

  IF v_row_id IS NULL THEN
    INSERT INTO public.user_permissions (user_id, resource, level)
    VALUES (v_target.id, p_resource, p_level);
  ELSIF v_old <> p_level THEN
    UPDATE public.user_permissions up SET level = p_level WHERE up.id = v_row_id;
  END IF;

  IF v_previous <> p_level THEN
    PERFORM public.ytw_log_event(
      p_actor, p_actor_type, p_token_id, 'user.permission_changed', 'user', v_target.id,
      jsonb_build_object('user', v_target.username, 'resource', p_resource,
                         'from', v_previous, 'to', p_level));
  END IF;
  RETURN QUERY SELECT v_target.id, p_resource, v_previous, p_level, v_previous <> p_level;
END
$$;

COMMENT ON FUNCTION public.set_user_permission(text, text, uuid, uuid, uuid, text, text) IS
  'Admin only: set a user''s level on one object. Activity is never write; an admin''s levels cannot be lowered.';

-- Promotes or demotes an admin.
--   * Promoting raises the user's stored rows to the maximum (their effective levels already are, by
--     the admin rule), so the stored rows agree with @ytw/policy.
--   * Demoting resets the user to none on every object (the state of a new user) unless
--     p_keep_levels is true: a demotion then lowers the person and every token they own at once, and
--     the admin grants back what the person should keep. With p_keep_levels the rows stay as they
--     are, which for a former admin means the maximum everywhere.
--   * Only an admin whose access is NOT revoked counts when the last admin is protected: demoting the
--     last active admin is refused even when revoked admins exist, and demoting a revoked admin never
--     is (it changes nobody's ability to administer). The result reports the STORED admin flag it
--     changed; access_revoked_at of get_user_access says whether it currently counts.
-- Asking for the state a user already has changes nothing (changed = false).
CREATE FUNCTION public.set_user_admin(
  p_actor text,
  p_actor_type text,
  p_token_id uuid,
  p_acting_user_id uuid,
  p_user_id uuid,
  p_is_admin boolean,
  p_keep_levels boolean DEFAULT false
)
RETURNS TABLE (
  user_id uuid,
  username text,
  is_admin boolean,
  previous_is_admin boolean,
  changed boolean,
  levels jsonb
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_target public.users;
  v_was boolean;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  -- Before anything reads is_admin: every promotion, demotion and first login queues here.
  PERFORM public.ytw_lock_users();
  PERFORM public.ytw_acting_user(p_actor, p_actor_type, p_acting_user_id, 'change who is an admin', true);

  IF p_user_id IS NULL THEN
    PERFORM public.ytw_raise(
      'validation', 'user_id is required', jsonb_build_object('field', 'user_id'));
  END IF;
  IF p_is_admin IS NULL THEN
    PERFORM public.ytw_raise(
      'validation', 'is_admin is required: true to promote, false to demote',
      jsonb_build_object('field', 'is_admin', 'allowed', jsonb_build_array(true, false)));
  END IF;

  SELECT * INTO v_target FROM public.users u WHERE u.id = p_user_id AND NOT u.is_system FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise(
      'not_found',
      format('user %s does not exist: users appear after their first login', p_user_id),
      jsonb_build_object('entity', 'user', 'id', p_user_id));
  END IF;
  v_was := v_target.is_admin;

  IF p_is_admin THEN
    IF NOT v_was THEN
      UPDATE public.users u SET is_admin = true WHERE u.id = v_target.id;
      PERFORM public.ytw_log_event(
        p_actor, p_actor_type, p_token_id, 'user.admin_granted', 'user', v_target.id,
        jsonb_build_object('user', v_target.username));
    END IF;
    PERFORM public.ytw_sync_user_rows(v_target.id, true);
  ELSIF v_was THEN
    IF v_target.access_revoked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.users u
                        WHERE u.is_admin AND u.access_revoked_at IS NULL AND u.id <> v_target.id) THEN
      PERFORM public.ytw_raise(
        'forbidden',
        format('%s is the last admin and cannot be demoted: promote another user to admin first%s',
               to_json(v_target.username),
               CASE WHEN EXISTS (SELECT 1 FROM public.users u
                                  WHERE u.is_admin AND u.access_revoked_at IS NOT NULL)
                    THEN ' (admins whose access is revoked do not count)' ELSE '' END),
        jsonb_build_object('reason', 'last_admin', 'user_id', v_target.id));
    END IF;
    UPDATE public.users u SET is_admin = false WHERE u.id = v_target.id;
    IF NOT coalesce(p_keep_levels, false) THEN
      UPDATE public.user_permissions up SET level = 'none'
       WHERE up.user_id = v_target.id AND up.level <> 'none';
    END IF;
    PERFORM public.ytw_log_event(
      p_actor, p_actor_type, p_token_id, 'user.admin_revoked', 'user', v_target.id,
      jsonb_build_object('user', v_target.username,
                         'levels_reset', NOT coalesce(p_keep_levels, false)));
  END IF;

  RETURN QUERY
  SELECT v_target.id, v_target.username, p_is_admin, v_was, v_was <> p_is_admin,
         public.ytw_user_effective_levels(v_target.id);
END
$$;

COMMENT ON FUNCTION public.set_user_admin(text, text, uuid, uuid, uuid, boolean, boolean) IS
  'Admin only: promote (rows raised to the maximum) or demote (levels reset to none unless p_keep_levels) a user. The last admin whose access is not revoked cannot be demoted. Reports the stored admin flag.';

-- The access matrix: every user with the levels they hold, oldest account first, for an admin whose
-- access is not revoked. The system user is not listed.
CREATE FUNCTION public.list_users_with_levels(p_acting_user_id uuid)
RETURNS SETOF public.ytw_user_access
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_is_admin boolean;
  v_revoked timestamptz;
BEGIN
  SELECT u.is_admin, u.access_revoked_at INTO v_is_admin, v_revoked
    FROM public.users u WHERE u.id = p_acting_user_id;
  IF v_revoked IS NOT NULL THEN
    PERFORM public.ytw_raise(
      'forbidden',
      'your access is revoked, so you cannot list the access levels of all users',
      jsonb_build_object('reason', 'access_revoked'));
  END IF;
  IF NOT coalesce(v_is_admin, false) THEN
    PERFORM public.ytw_raise(
      'forbidden', 'only an admin can list the access levels of all users',
      jsonb_build_object('reason', 'not_admin'));
  END IF;
  RETURN QUERY
  SELECT u.id, u.oidc_issuer, u.oidc_sub, u.username, u.email, u.display_name,
         (u.is_admin AND u.access_revoked_at IS NULL),
         u.last_login_at, u.created_at, public.ytw_user_effective_levels(u.id),
         u.access_revoked_at
  FROM public.users u
  WHERE NOT u.is_system
  ORDER BY u.created_at, u.id;
END
$$;

COMMENT ON FUNCTION public.list_users_with_levels(uuid) IS
  'Admin only: all users with their effective levels and access_revoked_at (the access matrix of the settings page).';

-- ---------------------------------------------------------------------------------------------
-- API tokens
-- ---------------------------------------------------------------------------------------------
--
-- The caller generates the secret and passes only its SHA-256 hash and a short prefix; the secret
-- itself never reaches the database, its logs or the audit trail.
--
-- The rules live here, not in the callers:
--   * only a signed-in PERSON manages tokens, and only their own (a stolen token cannot mint, widen
--     or rotate tokens): the actor must be the owner;
--   * every level a token is given is at or below its owner's CURRENT effective level, and an owner
--     with no access at all cannot create tokens. The error lists the values that would have been
--     accepted;
--   * what a token may do is always min(token level, owner's current level), computed when the token
--     is looked up, so lowering a user (or demoting an admin, or revoking their access) lowers their
--     tokens at once;
--   * revoked tokens stay in the table for the audit trail and cannot be changed or rotated;
--   * the token hash is validated before it is stored and never echoed in an error or an event.
-- Besides the row-level events of the audit triggers, each management call writes one readable event
-- (token.created, token.permissions_changed, token.rotated, token.revoked) that names the token and
-- its owner. The secret, its hash and its prefix are never part of an event.

-- A token as the settings screens show it. `levels` is the token's OWN stored level on every object;
-- `effective_levels` is what it may do right now: the lower of that and its owner's current level
-- on each object, and none unless the token is active.
CREATE TYPE public.ytw_api_token_info AS (
  token_id uuid,
  owner_id uuid,
  name text,
  token_prefix text,
  status text,
  created_at timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  levels jsonb,
  effective_levels jsonb
);

-- Status of a token as a fact about the token and its owner. 'revoked' wins over 'expired', and
-- both win over 'owner_revoked' (the more specific fact about the token comes first). A token whose
-- owner's access is revoked is itself fine and works again, unchanged, when the access returns.
CREATE FUNCTION public.ytw_token_status(
  p_revoked_at timestamptz,
  p_expires_at timestamptz,
  p_owner_access_revoked_at timestamptz
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_revoked_at IS NOT NULL THEN 'revoked'
    WHEN p_expires_at IS NOT NULL AND p_expires_at <= statement_timestamp() THEN 'expired'
    WHEN p_owner_access_revoked_at IS NOT NULL THEN 'owner_revoked'
    ELSE 'active'
  END
$$;

CREATE FUNCTION public.ytw_api_token_info_of(p_api_token_id uuid)
RETURNS public.ytw_api_token_info
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT t.id, t.user_id, t.name, t.token_prefix, s.status,
         t.created_at, t.expires_at, t.last_used_at, t.revoked_at,
         own.levels,
         CASE WHEN s.status = 'active'
              THEN public.ytw_effective_levels(own.levels, public.ytw_user_effective_levels(t.user_id))
              ELSE public.ytw_effective_levels('{}'::jsonb, '{}'::jsonb) END
  FROM ytw_private.api_tokens t
  JOIN public.users u ON u.id = t.user_id
  CROSS JOIN LATERAL (SELECT public.ytw_token_own_levels(t.id) AS levels) own
  CROSS JOIN LATERAL (
    SELECT public.ytw_token_status(t.revoked_at, t.expires_at, u.access_revoked_at) AS status
  ) s
  WHERE t.id = p_api_token_id
$$;

-- Checks the shape of the secret-derived values of a token: a prefix of `ytw_` plus at most 11
-- more characters and a SHA-256 hash as 64 lower-case hex digits. The messages never contain the
-- hash: a caller that passed the secret itself by mistake must not see it echoed back.
CREATE FUNCTION public.ytw_check_token_secret_shape(p_token_prefix text, p_token_hash text)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_token_prefix IS NULL OR p_token_prefix !~ '^ytw_[A-Za-z0-9_-]{0,11}$' THEN
    PERFORM public.ytw_raise(
      'validation',
      'token_prefix must be "ytw_" followed by at most 11 letters, digits, "_" or "-" (the first characters of the secret, shown in settings)',
      jsonb_build_object('field', 'token_prefix'));
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    PERFORM public.ytw_raise(
      'validation',
      'token_hash must be the SHA-256 of the token as 64 lower-case hexadecimal digits: hash the secret and pass the digest, never the secret itself',
      jsonb_build_object('field', 'token_hash'));
  END IF;
END
$$;

-- The shape check plus: no token uses the hash yet.
CREATE FUNCTION public.ytw_check_token_secret(p_token_prefix text, p_token_hash text)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.ytw_check_token_secret_shape(p_token_prefix, p_token_hash);
  IF EXISTS (SELECT 1 FROM ytw_private.api_tokens t WHERE t.token_hash = p_token_hash) THEN
    PERFORM public.ytw_raise(
      'duplicate',
      'a token with this hash already exists: generate a new secret',
      jsonb_build_object('field', 'token_hash'));
  END IF;
END
$$;

-- Creates a token for the acting person (owner = actor). permissions: {"ideas": "read", ...};
-- objects left out get none. expires_at NULL = never expires, otherwise it must lie in the future.
-- Returns the new token (never its hash).
CREATE FUNCTION public.create_api_token(
  p_actor text,
  p_actor_type text,
  p_token_id uuid,
  p_owner_user_id uuid,
  p_name text,
  p_token_prefix text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_permissions jsonb
)
RETURNS public.ytw_api_token_info
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_owner public.users;
  v_owner_levels jsonb;
  v_name text := btrim(p_name);
  v_requested jsonb;
  v_levels jsonb;
  v_id uuid;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  v_owner := public.ytw_acting_user(p_actor, p_actor_type, p_owner_user_id, 'create API tokens', false);

  IF v_name IS NULL OR v_name = '' OR char_length(v_name) > 100 OR v_name ~ '[[:cntrl:]]' THEN
    PERFORM public.ytw_raise(
      'validation',
      'name is required: 1-100 characters without control characters (it is the actor name in the audit log)',
      jsonb_build_object('field', 'name'));
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= statement_timestamp() THEN
    PERFORM public.ytw_raise(
      'validation',
      'expires_at must lie in the future (or be empty for a token that never expires)',
      jsonb_build_object('field', 'expires_at'));
  END IF;
  PERFORM public.ytw_check_token_secret(p_token_prefix, p_token_hash);

  v_owner_levels := public.ytw_user_effective_levels(v_owner.id);
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_each_text(v_owner_levels) l WHERE public.ytw_level_rank(l.value) >= 1
  ) THEN
    PERFORM public.ytw_raise(
      'forbidden',
      format('%s has no access to any object, so cannot create API tokens: an admin must grant Read or Write on at least one object first',
             to_json(v_owner.username)),
      jsonb_build_object('reason', 'no_access'));
  END IF;
  v_requested := public.ytw_check_token_grant(v_owner.username, v_owner_levels, p_permissions);

  INSERT INTO ytw_private.api_tokens (user_id, name, token_prefix, token_hash, expires_at)
  VALUES (v_owner.id, v_name, p_token_prefix, p_token_hash, p_expires_at)
  RETURNING id INTO v_id;

  INSERT INTO ytw_private.api_token_permissions (token_id, resource, level)
  SELECT v_id, r.resource, coalesce(v_requested ->> r.resource, 'none')
  FROM unnest(public.ytw_resources()) AS r (resource);

  v_levels := public.ytw_token_own_levels(v_id);
  PERFORM public.ytw_log_event(
    p_actor, p_actor_type, p_token_id, 'token.created', 'api_token', v_id,
    jsonb_build_object('token_name', v_name, 'owner', v_owner.username,
                       'expires_at', p_expires_at, 'levels', v_levels));
  RETURN public.ytw_api_token_info_of(v_id);
END
$$;

COMMENT ON FUNCTION public.create_api_token(text, text, uuid, uuid, text, text, text, timestamptz, jsonb) IS
  'Create a token for the acting person. Every level is checked against the owner''s current effective level; only the SHA-256 hash and a short prefix are stored.';

-- Finds one of the owner's tokens and locks its row until the end of the transaction, so changing,
-- rotating and revoking it queue up instead of interleaving. A token that does not exist and a
-- token of somebody else are the same answer (not_found), so nobody learns which ids are in use.
CREATE FUNCTION public.ytw_lock_own_token(p_api_token_id uuid, p_owner_id uuid)
RETURNS ytw_private.api_tokens
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_token ytw_private.api_tokens;
BEGIN
  IF p_api_token_id IS NULL THEN
    PERFORM public.ytw_raise(
      'validation', 'api_token_id is required', jsonb_build_object('field', 'api_token_id'));
  END IF;
  SELECT * INTO v_token FROM ytw_private.api_tokens t
   WHERE t.id = p_api_token_id AND t.user_id = p_owner_id
   FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise(
      'not_found',
      format('you have no API token with id %s', p_api_token_id),
      jsonb_build_object('entity', 'api_token', 'id', p_api_token_id));
  END IF;
  RETURN v_token;
END
$$;

-- Changes some or all levels of one of the acting person's tokens. Only the objects named are
-- touched (the rest keep their level); the ceiling is checked again against the owner's current
-- level, so a token can never be raised above its owner. Revoked tokens cannot be changed.
CREATE FUNCTION public.update_token_permissions(
  p_actor text,
  p_actor_type text,
  p_token_id uuid,
  p_acting_user_id uuid,
  p_api_token_id uuid,
  p_permissions jsonb
)
RETURNS public.ytw_api_token_info
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_owner public.users;
  v_token ytw_private.api_tokens;
  v_requested jsonb;
  v_resource text;
  v_level text;
  v_old text;
  v_row_id uuid;
  v_changes jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  v_owner := public.ytw_acting_user(p_actor, p_actor_type, p_acting_user_id, 'change API tokens', false);
  v_token := public.ytw_lock_own_token(p_api_token_id, v_owner.id);
  IF v_token.revoked_at IS NOT NULL THEN
    PERFORM public.ytw_raise(
      'invalid_transition',
      format('token %s was revoked and cannot be changed: create a new token', to_json(v_token.name)),
      jsonb_build_object('entity', 'api_token', 'id', v_token.id, 'from', 'revoked'));
  END IF;

  v_requested := public.ytw_check_token_grant(
    v_owner.username, public.ytw_user_effective_levels(v_owner.id), p_permissions);

  FOR v_resource, v_level IN SELECT e.key, e.value FROM jsonb_each_text(v_requested) e ORDER BY e.key LOOP
    SELECT p.id, p.level INTO v_row_id, v_old
      FROM ytw_private.api_token_permissions p
     WHERE p.token_id = v_token.id AND p.resource = v_resource
     FOR UPDATE;
    IF v_row_id IS NULL THEN
      INSERT INTO ytw_private.api_token_permissions (token_id, resource, level)
      VALUES (v_token.id, v_resource, v_level);
      v_old := 'none';
    ELSIF v_old <> v_level THEN
      UPDATE ytw_private.api_token_permissions p SET level = v_level WHERE p.id = v_row_id;
    END IF;
    IF v_old <> v_level THEN
      v_changes := v_changes || jsonb_build_object('resource', v_resource, 'from', v_old, 'to', v_level);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_changes) > 0 THEN
    PERFORM public.ytw_log_event(
      p_actor, p_actor_type, p_token_id, 'token.permissions_changed', 'api_token', v_token.id,
      jsonb_build_object('token_name', v_token.name, 'owner', v_owner.username, 'changes', v_changes));
  END IF;
  RETURN public.ytw_api_token_info_of(v_token.id);
END
$$;

COMMENT ON FUNCTION public.update_token_permissions(text, text, uuid, uuid, uuid, jsonb) IS
  'Change the levels of one of the acting person''s tokens (only the objects named). Checked against the owner''s current level again.';

-- Replaces the secret of one of the acting person's tokens: the new hash and prefix take over and the
-- OLD SECRET STOPS WORKING IMMEDIATELY. Id, name, owner and levels stay; last use starts over. The
-- expiry stays unless p_set_expiry is true, in which case p_expires_at (NULL = never) replaces it; an
-- expired token must be given a new expiry or the new secret would be dead on arrival.
CREATE FUNCTION public.rotate_api_token(
  p_actor text,
  p_actor_type text,
  p_token_id uuid,
  p_acting_user_id uuid,
  p_api_token_id uuid,
  p_new_token_prefix text,
  p_new_token_hash text,
  p_set_expiry boolean DEFAULT false,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS public.ytw_api_token_info
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_owner public.users;
  v_token ytw_private.api_tokens;
  v_now timestamptz := statement_timestamp();
  v_expires_at timestamptz;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  v_owner := public.ytw_acting_user(p_actor, p_actor_type, p_acting_user_id, 'rotate API tokens', false);
  v_token := public.ytw_lock_own_token(p_api_token_id, v_owner.id);
  IF v_token.revoked_at IS NOT NULL THEN
    PERFORM public.ytw_raise(
      'invalid_transition',
      format('token %s was revoked and cannot be rotated: create a new token', to_json(v_token.name)),
      jsonb_build_object('entity', 'api_token', 'id', v_token.id, 'from', 'revoked'));
  END IF;

  IF coalesce(p_set_expiry, false) THEN
    IF p_expires_at IS NOT NULL AND p_expires_at <= v_now THEN
      PERFORM public.ytw_raise(
        'validation',
        'expires_at must lie in the future (or be empty for a token that never expires)',
        jsonb_build_object('field', 'expires_at'));
    END IF;
    v_expires_at := p_expires_at;
  ELSE
    v_expires_at := v_token.expires_at;
    IF v_expires_at IS NOT NULL AND v_expires_at <= v_now THEN
      PERFORM public.ytw_raise(
        'validation',
        format('token %s expired on %s: rotate it with a new expiry (or none for a token that never expires), or create a new token',
               to_json(v_token.name), to_char(v_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
        jsonb_build_object('field', 'expires_at', 'expired_at', v_expires_at));
    END IF;
  END IF;
  PERFORM public.ytw_check_token_secret(p_new_token_prefix, p_new_token_hash);

  UPDATE ytw_private.api_tokens t
     SET token_prefix = p_new_token_prefix, token_hash = p_new_token_hash,
         expires_at = v_expires_at, last_used_at = NULL
   WHERE t.id = v_token.id;

  PERFORM public.ytw_log_event(
    p_actor, p_actor_type, p_token_id, 'token.rotated', 'api_token', v_token.id,
    jsonb_build_object('token_name', v_token.name, 'owner', v_owner.username,
                       'expires_at', v_expires_at));
  RETURN public.ytw_api_token_info_of(v_token.id);
END
$$;

COMMENT ON FUNCTION public.rotate_api_token(text, text, uuid, uuid, uuid, text, text, boolean, timestamptz) IS
  'Replace the secret of one of the acting person''s tokens; the old secret stops working at once. Id, name and levels stay.';

-- Revokes one of the acting person's tokens; it stops working at once and stays listed. Revoking a
-- revoked token changes nothing (the first revocation time is kept).
CREATE FUNCTION public.revoke_api_token(
  p_actor text,
  p_actor_type text,
  p_token_id uuid,
  p_acting_user_id uuid,
  p_api_token_id uuid
)
RETURNS public.ytw_api_token_info
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_owner public.users;
  v_token ytw_private.api_tokens;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  v_owner := public.ytw_acting_user(p_actor, p_actor_type, p_acting_user_id, 'revoke API tokens', false);
  v_token := public.ytw_lock_own_token(p_api_token_id, v_owner.id);

  IF v_token.revoked_at IS NULL THEN
    UPDATE ytw_private.api_tokens t SET revoked_at = statement_timestamp() WHERE t.id = v_token.id;
    PERFORM public.ytw_log_event(
      p_actor, p_actor_type, p_token_id, 'token.revoked', 'api_token', v_token.id,
      jsonb_build_object('token_name', v_token.name, 'owner', v_owner.username));
  END IF;
  RETURN public.ytw_api_token_info_of(v_token.id);
END
$$;

COMMENT ON FUNCTION public.revoke_api_token(text, text, uuid, uuid, uuid) IS
  'Revoke one of the acting person''s tokens; it stops working at once and stays listed.';

-- Records that a token was just used. Called by the service that authenticated the token, as that
-- token (actor = its name, type agent, token id = its id): only the last_used_at column changes, so
-- the audit trigger writes nothing and `updated_at` stays (no event spam). Only an active token is
-- touched (not revoked, not expired, owner's access not revoked), and only under its own name.
-- Returns whether a token was updated.
CREATE FUNCTION public.touch_token_last_used(p_actor text, p_actor_type text, p_token_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_rows integer;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  IF p_actor_type <> 'agent' OR p_token_id IS NULL THEN
    PERFORM public.ytw_raise(
      'validation',
      'touch_token_last_used is called as the token itself: actor type "agent" with the token''s name and id',
      jsonb_build_object('field', 'actor_type', 'allowed', jsonb_build_array('agent')));
  END IF;

  -- The name must match too. That is defence in depth, not authentication: a token's id and name
  -- both appear in the readable audit log (token.created), so knowing them proves nothing. The
  -- authentication is the lookup by hash.
  UPDATE ytw_private.api_tokens t
     SET last_used_at = greatest(coalesce(t.last_used_at, '-infinity'::timestamptz), v_now)
   WHERE t.id = p_token_id
     AND t.name = btrim(p_actor)
     AND t.revoked_at IS NULL
     AND (t.expires_at IS NULL OR t.expires_at > v_now)
     AND NOT EXISTS (SELECT 1 FROM public.users u
                      WHERE u.id = t.user_id AND u.access_revoked_at IS NOT NULL);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END
$$;

COMMENT ON FUNCTION public.touch_token_last_used(text, text, uuid) IS
  'Record a use of an active token (last_used_at only, not audited). Called as the token: actor = its name, type agent, token id = its id. The name check is defence in depth, not authentication.';

-- The authentication lookup: finds a token by the SHA-256 of its secret and returns everything the
-- caller needs to build the @ytw/policy TokenPrincipal, with the owner's levels read in the same
-- statement (never cached, so lowering a user lowers their tokens at once). No row = unknown token.
-- `status` tells the failure modes apart: 'active', 'revoked' (wins over expired), 'expired' or
-- 'owner_revoked' (the owner's access is revoked; the token works again when it returns). Only an
-- active token may act.
--   token_levels      the token's own stored level per object
--   owner_levels      the owner's EFFECTIVE level per object (admins: the maximum everywhere), to be
--                     used with owner_is_admin as the TokenOwner of @ytw/policy
--   owner_is_admin    the owner's EFFECTIVE admin flag: false while their access is revoked
--   effective_levels  what the token may do now: the lower of the two per object; all none unless
--                     the token is active, so a caller that forgets to look at `status` still gets no access
CREATE FUNCTION public.lookup_token_by_hash(p_token_hash text)
RETURNS TABLE (
  token_id uuid,
  token_name text,
  token_prefix text,
  status text,
  created_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  owner_id uuid,
  owner_username text,
  owner_is_admin boolean,
  token_levels jsonb,
  owner_levels jsonb,
  effective_levels jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    PERFORM public.ytw_raise(
      'validation',
      'token_hash must be the SHA-256 of the token as 64 lower-case hexadecimal digits: hash the secret and pass the digest, never the secret itself',
      jsonb_build_object('field', 'token_hash'));
  END IF;
  RETURN QUERY
  SELECT t.id, t.name, t.token_prefix,
         s.status,
         t.created_at, t.expires_at, t.revoked_at, t.last_used_at,
         u.id, u.username,
         (u.is_admin AND u.access_revoked_at IS NULL),
         tl.levels, ul.levels,
         CASE WHEN s.status = 'active'
              THEN public.ytw_effective_levels(tl.levels, ul.levels)
              ELSE public.ytw_effective_levels('{}'::jsonb, '{}'::jsonb) END
  FROM ytw_private.api_tokens t
  JOIN public.users u ON u.id = t.user_id
  CROSS JOIN LATERAL (
    SELECT public.ytw_token_status(t.revoked_at, t.expires_at, u.access_revoked_at) AS status
  ) s
  CROSS JOIN LATERAL (SELECT public.ytw_token_own_levels(t.id) AS levels) tl
  CROSS JOIN LATERAL (SELECT public.ytw_user_effective_levels(u.id) AS levels) ul
  WHERE t.token_hash = p_token_hash;
END
$$;

COMMENT ON FUNCTION public.lookup_token_by_hash(text) IS
  'Authenticate: the token with this SHA-256 hash, its owner and both level sets, with status active, revoked, expired or owner_revoked. Only an active token may act. owner_is_admin is the owner''s effective flag. No row = unknown.';

-- The acting person's own tokens, newest first, revoked ones included (status tells them apart).
CREATE FUNCTION public.list_api_tokens(p_owner_user_id uuid)
RETURNS SETOF public.ytw_api_token_info
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT i.*
  FROM ytw_private.api_tokens t
  CROSS JOIN LATERAL public.ytw_api_token_info_of(t.id) i
  WHERE t.user_id = p_owner_user_id
  ORDER BY t.created_at DESC, t.id DESC
$$;

COMMENT ON FUNCTION public.list_api_tokens(uuid) IS
  'The tokens of one owner, newest first, with their own and effective levels, last use and expiry. Never returns hashes.';

-- One of the owner's tokens, for the phone screen of a single token. No row when the token does not
-- exist or belongs to someone else.
CREATE FUNCTION public.get_api_token(p_owner_user_id uuid, p_api_token_id uuid)
RETURNS SETOF public.ytw_api_token_info
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT i.*
  FROM ytw_private.api_tokens t
  CROSS JOIN LATERAL public.ytw_api_token_info_of(t.id) i
  WHERE t.id = p_api_token_id AND t.user_id = p_owner_user_id
$$;

COMMENT ON FUNCTION public.get_api_token(uuid, uuid) IS
  'One token of one owner with its levels, last use and expiry; no row when it is not theirs.';

-- ---------------------------------------------------------------------------------------------
-- Web sessions
-- ---------------------------------------------------------------------------------------------
--
-- Server-side browser sessions of the web app: refresh tokens stay on the server, with an idle and an
-- absolute timeout (both configurable by the caller).
--
-- Deliberately NOT audited and without an actor parameter (the one exception to the function
-- convention): a session is not a business record, and last_seen_at changes on every request. Logins
-- and logouts are logged by the caller with ytw_log_event. The session id is the bearer handle behind
-- the session cookie: callers pass and receive the raw id, the table keeps only its hash
-- (ytw_session_hash), and no message here repeats an id.
--
-- Two clocks, both measured at the start of the call that checks them (statement_timestamp):
--   * idle     expires_at          = last activity + idle timeout, moved forward by touch_web_session
--   * absolute absolute_expires_at = login + absolute timeout, never moved
-- A session is alive only while both lie in the future; expires_at never exceeds absolute_expires_at.
-- The refresh token arrives as opaque ciphertext made by the caller (key derived from the session
-- secret); the database stores and returns it without looking inside.

-- The stored form of a session id: SHA-256 of its 16 bytes. See the web_sessions table.
CREATE FUNCTION public.ytw_session_hash(p_session_id uuid)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT sha256(uuid_send(p_session_id))
$$;

-- A session without its secrets, as create/touch return it.
CREATE TYPE public.ytw_web_session_info AS (
  session_id uuid,
  user_id uuid,
  status text,
  created_at timestamptz,
  last_seen_at timestamptz,
  expires_at timestamptz,
  absolute_expires_at timestamptz
);

-- 'active', 'idle_expired' (not used for longer than the idle timeout) or 'absolute_expired' (older
-- than the absolute timeout, which wins when both hold).
CREATE FUNCTION public.ytw_session_status(p_expires_at timestamptz, p_absolute_expires_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_absolute_expires_at <= statement_timestamp() THEN 'absolute_expired'
    WHEN p_expires_at <= statement_timestamp() THEN 'idle_expired'
    ELSE 'active'
  END
$$;

-- Checks the arguments the session functions share. Every check applies only to a value that is
-- given (NULL is skipped; the functions that need a value say so themselves): timeouts between a
-- minute (0 or negative would create a dead session) and 366 days, a refresh token blob and an ID
-- token hint of a size the table accepts.
CREATE FUNCTION public.ytw_check_session_args(
  p_idle_timeout_seconds integer,
  p_absolute_timeout_seconds integer,
  p_refresh_token_encrypted bytea,
  p_id_token_hint text
)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_idle_timeout_seconds IS NOT NULL AND p_idle_timeout_seconds NOT BETWEEN 60 AND 31622400 THEN
    PERFORM public.ytw_raise(
      'validation',
      'the idle timeout must be between 60 and 31622400 seconds (1 minute to 366 days)',
      jsonb_build_object('field', 'idle_timeout_seconds'));
  END IF;
  IF p_absolute_timeout_seconds IS NOT NULL
     AND p_absolute_timeout_seconds NOT BETWEEN 60 AND 31622400 THEN
    PERFORM public.ytw_raise(
      'validation',
      'the absolute timeout must be between 60 and 31622400 seconds (1 minute to 366 days)',
      jsonb_build_object('field', 'absolute_timeout_seconds'));
  END IF;
  IF p_refresh_token_encrypted IS NOT NULL
     AND octet_length(p_refresh_token_encrypted) NOT BETWEEN 1 AND 16384 THEN
    PERFORM public.ytw_raise(
      'validation',
      'the encrypted refresh token must be 1 to 16384 bytes',
      jsonb_build_object('field', 'refresh_token_encrypted'));
  END IF;
  IF p_id_token_hint IS NOT NULL AND char_length(p_id_token_hint) NOT BETWEEN 1 AND 16384 THEN
    PERFORM public.ytw_raise(
      'validation',
      'the ID token hint must be 1 to 16384 characters',
      jsonb_build_object('field', 'id_token_hint'));
  END IF;
END
$$;

-- Starts a session for a user who just signed in and returns it with its raw id, the only time the
-- id is visible: the database keeps its hash. Idle expiry = now + idle timeout (capped at the
-- absolute expiry), absolute expiry = now + absolute timeout. The refresh token blob and the ID
-- token hint (for RP-initiated logout) may be NULL when the provider issued none. A person whose
-- access is revoked gets no session, and neither does the system user. The user row is share-locked
-- until COMMIT, so a revocation (which updates the row) waits for the insert and then ends the new
-- session too; the other way round the insert sees the revocation and is refused.
CREATE FUNCTION public.create_web_session(
  p_user_id uuid,
  p_refresh_token_encrypted bytea,
  p_id_token_hint text,
  p_idle_timeout_seconds integer,
  p_absolute_timeout_seconds integer
)
RETURNS public.ytw_web_session_info
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_absolute timestamptz;
  v_idle timestamptz;
  v_id uuid := gen_random_uuid();
  v_username text;
  v_revoked timestamptz;
  v_system boolean;
BEGIN
  IF p_idle_timeout_seconds IS NULL THEN
    PERFORM public.ytw_raise(
      'validation',
      'the idle timeout must be between 60 and 31622400 seconds (1 minute to 366 days)',
      jsonb_build_object('field', 'idle_timeout_seconds'));
  END IF;
  IF p_absolute_timeout_seconds IS NULL THEN
    PERFORM public.ytw_raise(
      'validation',
      'the absolute timeout must be between 60 and 31622400 seconds (1 minute to 366 days)',
      jsonb_build_object('field', 'absolute_timeout_seconds'));
  END IF;
  PERFORM public.ytw_check_session_args(
    p_idle_timeout_seconds, p_absolute_timeout_seconds, p_refresh_token_encrypted, p_id_token_hint);
  IF p_user_id IS NULL THEN
    PERFORM public.ytw_raise(
      'validation', 'user_id is required', jsonb_build_object('field', 'user_id'));
  END IF;
  SELECT u.username, u.access_revoked_at, u.is_system INTO v_username, v_revoked, v_system
    FROM public.users u WHERE u.id = p_user_id FOR SHARE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise(
      'not_found',
      format('user %s does not exist: a session belongs to a user who has signed in', p_user_id),
      jsonb_build_object('entity', 'user', 'id', p_user_id));
  END IF;
  IF v_system THEN
    PERFORM public.ytw_raise(
      'forbidden',
      'the built-in system user is not a person and cannot have a session',
      jsonb_build_object('reason', 'system_user'));
  END IF;
  IF v_revoked IS NOT NULL THEN
    PERFORM public.ytw_raise(
      'forbidden',
      format('the access of %s is revoked, so no session can start for them: they must sign in again with access',
             to_json(v_username)),
      jsonb_build_object('reason', 'access_revoked'));
  END IF;

  v_absolute := v_now + make_interval(secs => p_absolute_timeout_seconds);
  v_idle := least(v_now + make_interval(secs => p_idle_timeout_seconds), v_absolute);
  INSERT INTO ytw_private.web_sessions
    (id_hash, user_id, refresh_token_encrypted, id_token_hint, created_at, last_seen_at, expires_at,
     absolute_expires_at)
  VALUES
    (public.ytw_session_hash(v_id), p_user_id, p_refresh_token_encrypted, p_id_token_hint, v_now,
     v_now, v_idle, v_absolute);

  RETURN ROW(v_id, p_user_id, 'active', v_now, v_now, v_idle, v_absolute)::public.ytw_web_session_info;
END
$$;

COMMENT ON FUNCTION public.create_web_session(uuid, bytea, text, integer, integer) IS
  'Start a web session: idle expiry now + idle timeout, absolute expiry now + absolute timeout. Returns the raw session id once; only its hash is stored. The refresh token is opaque ciphertext from the caller. Refused for a person whose access is revoked and for the system user.';

-- Records activity: if the session is still alive (neither expiry has passed) its idle expiry moves to
-- now + idle timeout, but never past the absolute expiry, and the session is returned. An expired or
-- unknown session returns no row and is left as it is (purge_expired_web_sessions removes it).
CREATE FUNCTION public.touch_web_session(p_session_id uuid, p_idle_timeout_seconds integer)
RETURNS SETOF public.ytw_web_session_info
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
BEGIN
  IF p_idle_timeout_seconds IS NULL THEN
    PERFORM public.ytw_raise(
      'validation',
      'the idle timeout must be between 60 and 31622400 seconds (1 minute to 366 days)',
      jsonb_build_object('field', 'idle_timeout_seconds'));
  END IF;
  PERFORM public.ytw_check_session_args(p_idle_timeout_seconds, NULL, NULL, NULL);
  RETURN QUERY
  WITH touched AS (
    UPDATE ytw_private.web_sessions s
       SET last_seen_at = v_now,
           expires_at = least(v_now + make_interval(secs => p_idle_timeout_seconds),
                              s.absolute_expires_at)
     WHERE s.id_hash = public.ytw_session_hash(p_session_id)
       AND s.expires_at > v_now AND s.absolute_expires_at > v_now
    RETURNING s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.absolute_expires_at
  )
  SELECT p_session_id, t.user_id, 'active'::text, t.created_at, t.last_seen_at, t.expires_at,
         t.absolute_expires_at
  FROM touched t;
END
$$;

COMMENT ON FUNCTION public.touch_web_session(uuid, integer) IS
  'Record activity on a live session: idle expiry moves to now + idle timeout (never past the absolute expiry). No row when it is expired or unknown.';

-- Reads a session, expired or not, with its status ('active', 'idle_expired', 'absolute_expired').
-- The refresh token is returned only while the session is active: a dead session must not be
-- refreshed. The ID token hint is kept for the logout redirect. No row when the id is unknown.
CREATE FUNCTION public.get_web_session(p_session_id uuid)
RETURNS TABLE (
  session_id uuid,
  user_id uuid,
  status text,
  refresh_token_encrypted bytea,
  id_token_hint text,
  created_at timestamptz,
  last_seen_at timestamptz,
  expires_at timestamptz,
  absolute_expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_session_id, s.user_id, st.status,
         CASE WHEN st.status = 'active' THEN s.refresh_token_encrypted END,
         s.id_token_hint, s.created_at, s.last_seen_at, s.expires_at, s.absolute_expires_at
  FROM ytw_private.web_sessions s
  CROSS JOIN LATERAL (
    SELECT public.ytw_session_status(s.expires_at, s.absolute_expires_at) AS status
  ) st
  WHERE s.id_hash = public.ytw_session_hash(p_session_id)
$$;

COMMENT ON FUNCTION public.get_web_session(uuid) IS
  'A session with its status; the encrypted refresh token only while it is active. No row when unknown.';

-- Stores the tokens of a silent refresh. NULL keeps the stored value (a provider that does not rotate
-- refresh tokens returns none); only a live session is updated, so a dead one cannot be revived.
-- Returns whether a session was updated.
CREATE FUNCTION public.update_web_session_tokens(
  p_session_id uuid,
  p_refresh_token_encrypted bytea,
  p_id_token_hint text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_rows integer;
BEGIN
  PERFORM public.ytw_check_session_args(NULL, NULL, p_refresh_token_encrypted, p_id_token_hint);
  UPDATE ytw_private.web_sessions s
     SET refresh_token_encrypted = coalesce(p_refresh_token_encrypted, s.refresh_token_encrypted),
         id_token_hint = coalesce(p_id_token_hint, s.id_token_hint)
   WHERE s.id_hash = public.ytw_session_hash(p_session_id)
     AND s.expires_at > v_now AND s.absolute_expires_at > v_now;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END
$$;

COMMENT ON FUNCTION public.update_web_session_tokens(uuid, bytea, text) IS
  'Store the tokens of a silent refresh on a live session (NULL keeps the stored value). Returns whether a session was updated.';

-- Ends a session (logout, or a refresh that found the user out of the access group). Returns whether
-- a session was deleted.
CREATE FUNCTION public.delete_web_session(p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  DELETE FROM ytw_private.web_sessions s WHERE s.id_hash = public.ytw_session_hash(p_session_id);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END
$$;

COMMENT ON FUNCTION public.delete_web_session(uuid) IS 'End a session. Returns whether one was deleted.';

-- Housekeeping for the web server to run now and then: deletes every session whose idle or absolute
-- expiry has passed and returns how many.
CREATE FUNCTION public.purge_expired_web_sessions()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_rows integer;
BEGIN
  DELETE FROM ytw_private.web_sessions s
   WHERE s.expires_at <= v_now OR s.absolute_expires_at <= v_now;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$$;

COMMENT ON FUNCTION public.purge_expired_web_sessions() IS
  'Delete the sessions whose idle or absolute expiry has passed; returns the number deleted.';


-- ---------------------------------------------------------------------------------------------
-- Access revocation
-- ---------------------------------------------------------------------------------------------
--
-- Setting and lifting users.access_revoked_at, and keeping a revoked person out of the browser
-- sessions.
--
--   * mark_user_outside_access_group: the identity provider said the person is not in the access
--     group any more (the check repeated on every token refresh). Sets the flag, ends every browser
--     session of the person on every device, logs user.access_revoked. It NEVER creates a user: an
--     unknown identity answers no row and writes nothing. It is not subject to the last-admin guard:
--     the identity provider outranks it, otherwise the one admin removed from the group would keep
--     their tokens and sessions. The workspace may then have no admin whose access is active; signing
--     in again with access restores the person (their admin flag is kept), and the event says so
--     (no_active_admin).
--   * set_user_access_revoked: an admin locks a person out by hand, or restores them (offboarding of
--     somebody who never comes back to the web app, so the group check never reaches them). The
--     acting user must be an admin whose access is active; the last admin whose access is active
--     cannot be locked out. Locking out ends the person's sessions as well.
--
-- While access is revoked the effective level of the person is none on every object, admins
-- included, and so is the effective level of every token they own; the effective admin flag is false
-- wherever it is returned; a revoked person cannot manage anything (ytw_acting_user) and does not
-- count as an admin when the last admin is protected. The stored levels, the admin flag and the
-- tokens are kept, so restoring access restores exactly what was there. Signing in again after the
-- group check passed clears the flag (upsert_user_on_login). Both functions take ytw_lock_users()
-- before any row.

CREATE FUNCTION public.mark_user_outside_access_group(
  p_actor text,
  p_actor_type text,
  p_token_id uuid,
  p_issuer text,
  p_sub text
)
RETURNS TABLE (
  user_id uuid,
  username text,
  access_revoked_at timestamptz,
  changed boolean,
  sessions_ended integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := statement_timestamp();
  v_user public.users;
  v_changed boolean := false;
  v_ended integer;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  IF p_actor_type <> 'human' THEN
    PERFORM public.ytw_raise(
      'forbidden',
      'only the web server acting for the person (type human) can mark them as outside the access group: API tokens cannot',
      jsonb_build_object('reason', 'not_human'));
  END IF;
  PERFORM public.ytw_check_identity_claims(p_issuer, p_sub);
  PERFORM public.ytw_lock_users();

  SELECT * INTO v_user FROM public.users u
   WHERE u.oidc_issuer = p_issuer AND u.oidc_sub = p_sub AND NOT u.is_system
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;  -- Never had an account: nothing to revoke, and no account is made for them.
  END IF;

  IF v_user.access_revoked_at IS NULL THEN
    UPDATE public.users u SET access_revoked_at = v_now WHERE u.id = v_user.id
    RETURNING * INTO v_user;
    v_changed := true;
  END IF;
  DELETE FROM ytw_private.web_sessions s WHERE s.user_id = v_user.id;
  GET DIAGNOSTICS v_ended = ROW_COUNT;

  IF v_changed THEN
    PERFORM public.ytw_log_event(
      p_actor, p_actor_type, p_token_id, 'user.access_revoked', 'user', v_user.id,
      jsonb_build_object(
        'user', v_user.username, 'via', 'identity_provider', 'sessions_ended', v_ended,
        'no_active_admin',
        NOT EXISTS (SELECT 1 FROM public.users u WHERE u.is_admin AND u.access_revoked_at IS NULL)));
  END IF;
  RETURN QUERY SELECT v_user.id, v_user.username, v_user.access_revoked_at, v_changed, v_ended;
END
$$;

COMMENT ON FUNCTION public.mark_user_outside_access_group(text, text, uuid, text, text) IS
  'The identity provider says this person is outside the access group: revoke their access (levels none, tokens dead) and end all their sessions. Never creates a user: an unknown identity returns no row.';

CREATE FUNCTION public.set_user_access_revoked(
  p_actor text,
  p_actor_type text,
  p_token_id uuid,
  p_acting_user_id uuid,
  p_user_id uuid,
  p_revoked boolean
)
RETURNS TABLE (
  user_id uuid,
  username text,
  access_revoked_at timestamptz,
  changed boolean,
  sessions_ended integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := statement_timestamp();
  v_target public.users;
  v_changed boolean := false;
  v_ended integer := 0;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  PERFORM public.ytw_lock_users();
  PERFORM public.ytw_acting_user(
    p_actor, p_actor_type, p_acting_user_id, 'lock a user out or restore their access', true);

  IF p_user_id IS NULL THEN
    PERFORM public.ytw_raise(
      'validation', 'user_id is required', jsonb_build_object('field', 'user_id'));
  END IF;
  IF p_revoked IS NULL THEN
    PERFORM public.ytw_raise(
      'validation', 'revoked is required: true to lock the user out, false to restore their access',
      jsonb_build_object('field', 'revoked', 'allowed', jsonb_build_array(true, false)));
  END IF;

  SELECT * INTO v_target FROM public.users u WHERE u.id = p_user_id AND NOT u.is_system FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise(
      'not_found',
      format('user %s does not exist: users appear after their first login', p_user_id),
      jsonb_build_object('entity', 'user', 'id', p_user_id));
  END IF;

  IF p_revoked THEN
    IF v_target.access_revoked_at IS NULL THEN
      IF v_target.is_admin
         AND NOT EXISTS (SELECT 1 FROM public.users u
                          WHERE u.is_admin AND u.access_revoked_at IS NULL AND u.id <> v_target.id) THEN
        PERFORM public.ytw_raise(
          'forbidden',
          format('%s is the last admin whose access is active and cannot be locked out: promote another user to admin first',
                 to_json(v_target.username)),
          jsonb_build_object('reason', 'last_admin', 'user_id', v_target.id));
      END IF;
      UPDATE public.users u SET access_revoked_at = v_now WHERE u.id = v_target.id
      RETURNING * INTO v_target;
      v_changed := true;
    END IF;
    DELETE FROM ytw_private.web_sessions s WHERE s.user_id = v_target.id;
    GET DIAGNOSTICS v_ended = ROW_COUNT;
    IF v_changed THEN
      PERFORM public.ytw_log_event(
        p_actor, p_actor_type, p_token_id, 'user.access_revoked', 'user', v_target.id,
        jsonb_build_object('user', v_target.username, 'via', 'admin', 'sessions_ended', v_ended));
    END IF;
  ELSIF v_target.access_revoked_at IS NOT NULL THEN
    UPDATE public.users u SET access_revoked_at = NULL WHERE u.id = v_target.id
    RETURNING * INTO v_target;
    v_changed := true;
    PERFORM public.ytw_log_event(
      p_actor, p_actor_type, p_token_id, 'user.access_restored', 'user', v_target.id,
      jsonb_build_object('user', v_target.username, 'via', 'admin'));
  END IF;

  RETURN QUERY SELECT v_target.id, v_target.username, v_target.access_revoked_at, v_changed, v_ended;
END
$$;

COMMENT ON FUNCTION public.set_user_access_revoked(text, text, uuid, uuid, uuid, boolean) IS
  'Admin only: lock a user out (levels none, tokens dead, sessions ended) or restore their access. The last admin whose access is active cannot be locked out.';

-- ---------------------------------------------------------------------------------------------
-- Seeded API token
-- ---------------------------------------------------------------------------------------------
--
-- An operator can hand the system one API token through configuration, so agents can connect before
-- anyone has opened the web app. The server calls seed_api_token on every boot and the configuration
-- wins:
--
--   token configured, no seeded token active    'created'
--   same hash, same name and levels             'unchanged' (writes nothing)
--   same hash, other name or levels             'updated'
--   other hash                                  the active seeded token is revoked, the new one 'created'
--   nothing configured, a seeded token active   'revoked'
--   nothing configured, none active             'none'
--
-- Only the token marked `seeded` is ever touched; tokens created in the web app are not. It belongs
-- to the built-in system user (users.is_system), never expires, and acts under its own name in the
-- audit log (actor type agent, like every token). The secret never reaches the database: the caller
-- passes its SHA-256 hash and prefix, as for any token. A seeded token that was revoked and is then
-- configured again with the same secret is brought back instead of being created twice (the hash is
-- unique).
--
-- Concurrency: an advisory lock serialises the function, so replicas booting at the same moment end
-- up with one token, and a partial unique index guarantees there is never more than one active
-- seeded token.

-- Makes the stored levels of a token equal to p_levels (a full {resource: level} map), touching only
-- the rows that differ; returns the changes as [{"resource", "from", "to"}].
CREATE FUNCTION public.ytw_set_token_levels(p_token_id uuid, p_levels jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_resource text;
  v_level text;
  v_previous text;
  v_changes jsonb := '[]'::jsonb;
BEGIN
  FOR v_resource, v_level IN
    SELECT e.key, e.value FROM jsonb_each_text(p_levels) e ORDER BY e.key
  LOOP
    SELECT p.level INTO v_previous
      FROM ytw_private.api_token_permissions p
     WHERE p.token_id = p_token_id AND p.resource = v_resource
     FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO ytw_private.api_token_permissions (token_id, resource, level)
      VALUES (p_token_id, v_resource, v_level);
      v_previous := 'none';
    ELSIF v_previous <> v_level THEN
      UPDATE ytw_private.api_token_permissions p SET level = v_level
       WHERE p.token_id = p_token_id AND p.resource = v_resource;
    END IF;
    IF v_previous <> v_level THEN
      v_changes := v_changes
        || jsonb_build_object('resource', v_resource, 'from', v_previous, 'to', v_level);
    END IF;
  END LOOP;
  RETURN v_changes;
END
$$;

-- Applies the configured seed token. All four arguments NULL means "nothing configured". Takes no
-- actor parameters (the one exception to the function convention besides sessions): the actor is the
-- token itself, named in the arguments or, when it is revoked, in its row. Returns what happened and
-- the id of the token concerned (NULL for 'none').
CREATE FUNCTION public.seed_api_token(
  p_name text,
  p_token_prefix text,
  p_token_hash text,
  p_permissions jsonb
)
RETURNS TABLE (action text, token_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_name text := btrim(p_name);
  v_active ytw_private.api_tokens;
  v_have_active boolean;
  v_old ytw_private.api_tokens;
  v_system public.users;
  v_wanted jsonb;
  v_levels jsonb;
  v_changes jsonb;
  v_payload jsonb;
  v_id uuid;
BEGIN
  -- One seed at a time: the key space of ytw_lock_users(), object 2 = "the seeded token".
  PERFORM pg_advisory_xact_lock(1498699553, 2);

  SELECT * INTO v_active FROM ytw_private.api_tokens t
   WHERE t.seeded AND t.revoked_at IS NULL
   FOR UPDATE;
  v_have_active := FOUND;

  -- Nothing configured: a seeded token that is still active goes away.
  IF p_name IS NULL AND p_token_prefix IS NULL AND p_token_hash IS NULL AND p_permissions IS NULL THEN
    IF NOT v_have_active THEN
      RETURN QUERY SELECT 'none'::text, NULL::uuid;
      RETURN;
    END IF;
    PERFORM public.ytw_set_actor(v_active.name, 'agent', v_active.id);
    UPDATE ytw_private.api_tokens t SET revoked_at = statement_timestamp() WHERE t.id = v_active.id;
    PERFORM public.ytw_log_event(
      v_active.name, 'agent', v_active.id, 'token.revoked', 'api_token', v_active.id,
      jsonb_build_object('token_name', v_active.name, 'seeded', true,
                         'reason', 'no seeded token is configured'));
    RETURN QUERY SELECT 'revoked'::text, v_active.id;
    RETURN;
  END IF;

  IF v_name IS NULL OR v_name = '' OR char_length(v_name) > 100 OR v_name ~ '[[:cntrl:]]' THEN
    PERFORM public.ytw_raise(
      'validation',
      'name is required: 1-100 characters without control characters (it is the actor name in the audit log)',
      jsonb_build_object('field', 'name'));
  END IF;
  PERFORM public.ytw_check_token_secret_shape(p_token_prefix, p_token_hash);
  -- The system user's ceiling is the maximum on every object, so only an unknown object or level,
  -- or write on the activity log, is rejected.
  v_wanted := public.ytw_check_token_grant(
    'system',
    (SELECT jsonb_object_agg(r.resource, public.ytw_max_level(r.resource))
       FROM unnest(public.ytw_resources()) AS r (resource)),
    p_permissions);
  v_levels := (SELECT jsonb_object_agg(r.resource, coalesce(v_wanted ->> r.resource, 'none'))
                 FROM unnest(public.ytw_resources()) AS r (resource));

  IF v_have_active AND v_active.token_hash = p_token_hash THEN
    IF v_active.name = v_name AND v_active.token_prefix = p_token_prefix
       AND public.ytw_token_own_levels(v_active.id) = v_levels THEN
      RETURN QUERY SELECT 'unchanged'::text, v_active.id;
      RETURN;
    END IF;
    PERFORM public.ytw_set_actor(v_name, 'agent', v_active.id);
    v_changes := public.ytw_set_token_levels(v_active.id, v_levels);
    UPDATE ytw_private.api_tokens t SET name = v_name, token_prefix = p_token_prefix
     WHERE t.id = v_active.id;
    v_payload := jsonb_build_object('token_name', v_name, 'seeded', true, 'changes', v_changes);
    IF v_active.name <> v_name THEN
      v_payload := v_payload || jsonb_build_object('renamed_from', v_active.name);
    END IF;
    PERFORM public.ytw_log_event(
      v_name, 'agent', v_active.id, 'token.permissions_changed', 'api_token', v_active.id, v_payload);
    RETURN QUERY SELECT 'updated'::text, v_active.id;
    RETURN;
  END IF;

  -- Another secret than the active seeded token's: that token is replaced.
  IF v_have_active THEN
    PERFORM public.ytw_set_actor(v_active.name, 'agent', v_active.id);
    UPDATE ytw_private.api_tokens t SET revoked_at = statement_timestamp() WHERE t.id = v_active.id;
    PERFORM public.ytw_log_event(
      v_active.name, 'agent', v_active.id, 'token.revoked', 'api_token', v_active.id,
      jsonb_build_object('token_name', v_active.name, 'seeded', true,
                         'reason', 'replaced by another seeded token'));
  END IF;

  SELECT * INTO v_old FROM ytw_private.api_tokens t WHERE t.token_hash = p_token_hash FOR UPDATE;
  IF FOUND AND NOT v_old.seeded THEN
    PERFORM public.ytw_raise(
      'duplicate',
      'a token with this hash already exists and was not seeded: generate a new secret for the seeded token',
      jsonb_build_object('field', 'token_hash'));
  END IF;
  v_id := coalesce(v_old.id, public.uuid_generate_v7());

  -- The system user, created the first time a token is seeded.
  SELECT * INTO v_system FROM public.users u WHERE u.is_system;
  IF NOT FOUND THEN
    PERFORM public.ytw_set_actor('system', 'agent', NULL);
    INSERT INTO public.users (oidc_issuer, oidc_sub, username, display_name, is_system)
    VALUES ('urn:ytw:system', 'system', 'system', 'System', true)
    RETURNING * INTO v_system;
  END IF;

  PERFORM public.ytw_set_actor(v_name, 'agent', v_id);
  IF v_old.id IS NULL THEN
    INSERT INTO ytw_private.api_tokens (id, user_id, name, token_prefix, token_hash, seeded)
    VALUES (v_id, v_system.id, v_name, p_token_prefix, p_token_hash, true);
    INSERT INTO ytw_private.api_token_permissions (token_id, resource, level)
    SELECT v_id, r.resource, v_levels ->> r.resource
      FROM unnest(public.ytw_resources()) AS r (resource);
  ELSE
    UPDATE ytw_private.api_tokens t
       SET revoked_at = NULL, name = v_name, token_prefix = p_token_prefix
     WHERE t.id = v_id;
    PERFORM public.ytw_set_token_levels(v_id, v_levels);
  END IF;
  PERFORM public.ytw_log_event(
    v_name, 'agent', v_id, 'token.created', 'api_token', v_id,
    jsonb_build_object('token_name', v_name, 'owner', v_system.username, 'seeded', true,
                       'levels', public.ytw_token_own_levels(v_id)));
  RETURN QUERY SELECT 'created'::text, v_id;
END
$$;

COMMENT ON FUNCTION public.seed_api_token(text, text, text, jsonb) IS
  'Make the API token configured through the environment the seeded token: created, updated, replaced or revoked as needed (see the section comment). All arguments NULL = nothing configured. Returns (action, token_id).';

-- =============================================================================================
-- 7. Reads: views, search, activity
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Idea pipeline
-- ---------------------------------------------------------------------------------------------
--
-- The idea pipeline for the board, the idea table and `query_sql` agents. One row per idea: the idea
-- itself, how long it has been in its stage, and the latest revision of each script kind.
--
-- Both views are security_invoker and read nothing but business tables in public (never users,
-- user_permissions or ytw_private).
--
-- A view cannot take a parameter, so "archived ideas only when asked for" is two views over one
-- definition: ideas_pipeline hides archived ideas, ideas_pipeline_all keeps them.
--
-- The latest_<kind>_* columns mirror SCRIPT_KINDS of @ytw/shared: a new kind needs a new migration
-- that replaces these views.

CREATE VIEW public.ideas_pipeline_all
WITH (security_invoker = true) AS
SELECT
  i.id,
  i.title,
  i.pitch,
  i.status,
  i.score,
  i.source,
  i.tags,
  i.version,
  i.status_changed_at,
  greatest(now() - i.status_changed_at, interval '0') AS age_in_stage,
  floor(extract(epoch FROM greatest(now() - i.status_changed_at, interval '0')) / 86400)::integer
    AS days_in_stage,
  ls.id AS latest_script_id,
  ls.version AS latest_script_version,
  ls.status AS latest_script_status,
  ls.created_at AS latest_script_at,
  lp.id AS latest_packaging_id,
  lp.version AS latest_packaging_version,
  lp.status AS latest_packaging_status,
  lp.created_at AS latest_packaging_at,
  i.archived_at,
  i.created_at,
  i.updated_at,
  i.created_by,
  i.updated_by
FROM public.ideas i
LEFT JOIN LATERAL (
  SELECT s.id, s.version, s.status, s.created_at
  FROM public.scripts s
  WHERE s.idea_id = i.id AND s.kind = 'script'
  ORDER BY s.version DESC
  LIMIT 1
) ls ON true
LEFT JOIN LATERAL (
  SELECT s.id, s.version, s.status, s.created_at
  FROM public.scripts s
  WHERE s.idea_id = i.id AND s.kind = 'packaging'
  ORDER BY s.version DESC
  LIMIT 1
) lp ON true;

CREATE VIEW public.ideas_pipeline
WITH (security_invoker = true) AS
SELECT * FROM public.ideas_pipeline_all
WHERE archived_at IS NULL;

COMMENT ON VIEW public.ideas_pipeline IS
  'Ideas that are not archived, one row each: stage (status), age in stage and the latest script and packaging revision (NULL when none was saved). Use ideas_pipeline_all to include archived ideas.';
COMMENT ON VIEW public.ideas_pipeline_all IS
  'Like ideas_pipeline, but archived ideas are included (archived_at is set for them).';

COMMENT ON COLUMN public.ideas_pipeline.status IS 'The stage: inbox, shortlisted, scripting, filming, editing, published or dropped.';
COMMENT ON COLUMN public.ideas_pipeline.status_changed_at IS 'When the idea entered its current stage; only a stage change moves it.';
COMMENT ON COLUMN public.ideas_pipeline.age_in_stage IS 'Time since status_changed_at (never negative).';
COMMENT ON COLUMN public.ideas_pipeline.days_in_stage IS 'age_in_stage in whole days.';
COMMENT ON COLUMN public.ideas_pipeline.latest_script_version IS 'Highest saved version of the idea''s script; NULL when no script exists.';
COMMENT ON COLUMN public.ideas_pipeline.latest_script_status IS 'Review status (draft, review, approved) of that latest script version.';
COMMENT ON COLUMN public.ideas_pipeline.latest_script_at IS 'When that latest script version was saved.';
COMMENT ON COLUMN public.ideas_pipeline.latest_packaging_version IS 'Highest saved version of the idea''s packaging doc; NULL when none exists.';
COMMENT ON COLUMN public.ideas_pipeline.latest_packaging_status IS 'Review status (draft, review, approved) of that latest packaging version.';
COMMENT ON COLUMN public.ideas_pipeline.latest_packaging_at IS 'When that latest packaging version was saved.';

-- Both views have the same columns: describe them once, on ideas_pipeline, and copy the text.
DO $$
DECLARE
  v_column record;
BEGIN
  FOR v_column IN
    SELECT a.attname, d.description
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_description d
      ON d.classoid = 'pg_catalog.pg_class'::regclass
     AND d.objoid = a.attrelid AND d.objsubid = a.attnum
    WHERE a.attrelid = 'public.ideas_pipeline'::regclass AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    EXECUTE format('COMMENT ON COLUMN public.ideas_pipeline_all.%I IS %L',
                   v_column.attname, v_column.description);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Video performance
-- ---------------------------------------------------------------------------------------------
--
-- How each video does, next to the channel. One row per video that is not archived: the video, its
-- latest metric snapshot and, for every metric, the channel median and the video's difference from it.
--
--   * latest snapshot = the row with the greatest captured_at of that video, as stored: a metric the
--     snapshot did not measure is NULL, even when an older snapshot had it;
--   * channel median = percentile_cont(0.5) over the latest snapshots of all videos that are not
--     archived (the video itself included) that measured the metric. percentile_cont works in double
--     precision and the result is cast back to numeric, so a median of values beyond 2^53 is
--     approximate; the per-video values stay exact;
--   * <metric>_vs_median = the video's value minus that median; NULL when either is NULL;
--   * a video without a snapshot keeps its row with NULL metrics and NULL differences; a channel
--     with a single video has that video's own values as medians (all differences 0); a channel
--     without any snapshot has NULL medians and median_sample_size 0.
-- Archived videos are left out of the rows and out of the medians: they are frozen and would skew the
-- baseline of the videos that are still live.
--
-- security_invoker: reads videos and video_metrics with the caller's privileges; no ytw_private or
-- users relation is involved.

CREATE VIEW public.video_performance_summary
WITH (security_invoker = true) AS
WITH latest AS (
  SELECT
    v.id,
    v.idea_id,
    v.youtube_id,
    v.title,
    v.published_at,
    v.thumbnail_url,
    m.id AS snapshot_id,
    m.captured_at,
    m.views,
    m.impressions,
    m.ctr,
    m.avg_view_duration_s,
    m.avg_view_pct,
    m.watch_time_min,
    m.subs_gained
  FROM public.videos v
  LEFT JOIN LATERAL (
    SELECT x.id, x.captured_at, x.views, x.impressions, x.ctr, x.avg_view_duration_s,
           x.avg_view_pct, x.watch_time_min, x.subs_gained
    FROM public.video_metrics x
    WHERE x.video_id = v.id
    ORDER BY x.captured_at DESC
    LIMIT 1
  ) m ON true
  WHERE v.archived_at IS NULL
),
channel AS (
  SELECT
    count(l.snapshot_id)::integer AS sample_size,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.views))::numeric AS views,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.impressions))::numeric AS impressions,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.ctr))::numeric AS ctr,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.avg_view_duration_s))::numeric AS avg_view_duration_s,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.avg_view_pct))::numeric AS avg_view_pct,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.watch_time_min))::numeric AS watch_time_min,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.subs_gained))::numeric AS subs_gained
  FROM latest l
)
SELECT
  l.id,
  l.idea_id,
  l.youtube_id,
  l.title,
  l.published_at,
  l.thumbnail_url,
  l.snapshot_id,
  l.captured_at,
  l.views,
  l.impressions,
  l.ctr,
  l.avg_view_duration_s,
  l.avg_view_pct,
  l.watch_time_min,
  l.subs_gained,
  c.sample_size AS median_sample_size,
  c.views AS median_views,
  c.impressions AS median_impressions,
  c.ctr AS median_ctr,
  c.avg_view_duration_s AS median_avg_view_duration_s,
  c.avg_view_pct AS median_avg_view_pct,
  c.watch_time_min AS median_watch_time_min,
  c.subs_gained AS median_subs_gained,
  l.views - c.views AS views_vs_median,
  l.impressions - c.impressions AS impressions_vs_median,
  l.ctr - c.ctr AS ctr_vs_median,
  l.avg_view_duration_s - c.avg_view_duration_s AS avg_view_duration_s_vs_median,
  l.avg_view_pct - c.avg_view_pct AS avg_view_pct_vs_median,
  l.watch_time_min - c.watch_time_min AS watch_time_min_vs_median,
  l.subs_gained - c.subs_gained AS subs_gained_vs_median
FROM latest l
CROSS JOIN channel c;

COMMENT ON VIEW public.video_performance_summary IS
  'Videos that are not archived with their latest metric snapshot and, per metric, the channel median (of the latest snapshots) and the difference from it. NULL metrics mean not measured; a video without snapshots has NULL metrics and differences.';

COMMENT ON COLUMN public.video_performance_summary.id IS 'The video id.';
COMMENT ON COLUMN public.video_performance_summary.snapshot_id IS 'The latest metric snapshot of the video; NULL when it has none.';
COMMENT ON COLUMN public.video_performance_summary.captured_at IS 'When the latest snapshot was captured.';
COMMENT ON COLUMN public.video_performance_summary.ctr IS 'Impressions click-through rate of the latest snapshot, in percent (4.5 means 4.5 %).';
COMMENT ON COLUMN public.video_performance_summary.avg_view_pct IS 'Average percentage viewed (above 100 when viewers rewatch).';
COMMENT ON COLUMN public.video_performance_summary.subs_gained IS 'Net subscribers gained (negative when more were lost).';
COMMENT ON COLUMN public.video_performance_summary.median_sample_size IS 'How many videos have a snapshot, i.e. how many the medians are computed over (per metric, only those that measured it count).';
COMMENT ON COLUMN public.video_performance_summary.median_views IS 'Channel median of views over the latest snapshots, the video itself included; the other median_* columns do the same for their metric.';
COMMENT ON COLUMN public.video_performance_summary.views_vs_median IS 'views minus median_views (negative: below the channel median); the other *_vs_median columns do the same for their metric.';

-- ---------------------------------------------------------------------------------------------
-- Experiment results
-- ---------------------------------------------------------------------------------------------
--
-- The variants of every packaging experiment side by side, with the click-through difference from the
-- control and the winner flagged. One row per variant; the experiment's own columns repeat on each of
-- its rows.
--
--   * ctr_vs_control = the variant's ctr minus the control's ctr, in percentage points (0 for the
--     control itself); NULL when either ctr is not recorded yet;
--   * ctr_lift_pct = that difference as a percentage of the control's ctr (the relative gain:
--     control 4.0, variant 5.0 gives 25), rounded to 4 decimal places; NULL when it is not defined
--     (a missing ctr, or a control with ctr 0);
--   * is_winner is true for the variant that conclude_experiment named; false for every variant of an
--     experiment that is not concluded or ended without a winner. The view never decides a winner by
--     itself: that is the owner's call (conclude_experiment).
-- Experiments of archived videos are included (they can still be concluded); video_title names the
-- video. A video's experiments can be told apart by experiment_id; order rows by experiment, then
-- is_control DESC, then label, as the wrapper does: a view has no order of its own.
--
-- security_invoker: reads experiments, experiment_variants and videos with the caller's privileges;
-- no ytw_private or users relation is involved.

CREATE VIEW public.experiment_results
WITH (security_invoker = true) AS
SELECT
  e.id AS experiment_id,
  e.video_id,
  v.title AS video_title,
  e.type,
  e.status,
  e.hypothesis,
  e.starts_at,
  e.ends_at,
  e.conclusion,
  e.winner_variant_id,
  e.created_at AS experiment_created_at,
  x.id AS variant_id,
  x.label,
  x.content,
  x.is_control,
  x.impressions,
  x.ctr,
  c.id AS control_variant_id,
  c.ctr AS control_ctr,
  x.ctr - c.ctr AS ctr_vs_control,
  CASE WHEN c.ctr > 0 THEN round((x.ctr - c.ctr) / c.ctr * 100, 4) END AS ctr_lift_pct,
  (e.winner_variant_id IS NOT NULL AND x.id = e.winner_variant_id) AS is_winner
FROM public.experiments e
JOIN public.videos v ON v.id = e.video_id
JOIN public.experiment_variants x ON x.experiment_id = e.id
LEFT JOIN public.experiment_variants c ON c.experiment_id = e.id AND c.is_control;

COMMENT ON VIEW public.experiment_results IS
  'One row per experiment variant, side by side: impressions, ctr, the ctr difference from the control and whether the variant won. The experiment columns repeat on every row of the experiment.';

COMMENT ON COLUMN public.experiment_results.status IS 'planned, running, concluded or cancelled.';
COMMENT ON COLUMN public.experiment_results.ctr IS 'Click-through rate of the variant in percent (4.5 means 4.5 %); NULL until recorded.';
COMMENT ON COLUMN public.experiment_results.control_variant_id IS 'The experiment''s control variant (every experiment made by create_experiment has exactly one).';
COMMENT ON COLUMN public.experiment_results.ctr_vs_control IS 'ctr minus the control''s ctr, in percentage points; 0 for the control; NULL when either ctr is missing.';
COMMENT ON COLUMN public.experiment_results.ctr_lift_pct IS 'ctr_vs_control as a percentage of the control''s ctr, rounded to 4 decimals; NULL when undefined (missing ctr or a control ctr of 0).';
COMMENT ON COLUMN public.experiment_results.is_winner IS 'True for the variant named by conclude_experiment; no variant is a winner before the conclusion or when none won.';

-- ---------------------------------------------------------------------------------------------
-- Search
-- ---------------------------------------------------------------------------------------------
--
-- Global full-text search over idea titles, idea pitches and script bodies: search_all(query, limit,
-- resources), for the web UI and the MCP tools.
--
-- What it searches. Ideas that are not archived (title weight A, pitch weight B: the stored
-- search_vector) and the LATEST revision of each (idea, kind) of those ideas' scripts (the body,
-- weight D). Older revisions are never searched, so a document is one hit however often it was
-- saved, and what was removed from the latest text cannot be found any more. The query goes through
-- websearch_to_tsquery('english', ...), the configuration the vectors were built with.
--
-- Rank. ts_rank scaled into [0, 1) (flag 32: rank / (rank + 1)), without length normalisation, so
-- that the field weights decide: a match in a title (weight A) outranks one in a pitch (B), which
-- outranks any number of matches in a script body (D); within one field more occurrences rank
-- higher. Ties are ordered by entity type, then id, so the order is the same every time. Ranks are
-- only comparable within one result.
--
-- Permissions. The function cannot know what the caller's token may read, so the SERVICE passes the
-- resources it may read ('ideas', 'scripts') and the function searches exactly those: no default,
-- NULL or an unknown name is a validation error, an empty list finds nothing. A script hit carries
-- its idea's title only when 'ideas' is listed too (a title is idea data).
--
-- Robustness. Whatever the query text is (empty, NULL, only stop words, operator soup, unbalanced
-- quotes, 10 MB of noise) the function answers with rows or with none, never with an error:
-- websearch_to_tsquery accepts any text, and only the first 1000 characters are used. The limit is
-- 1 to 50 (NULL means 20), anything else is a validation error that names the range.
--
-- SECURITY INVOKER. Errors are raised with the catalogue SQLSTATE directly (YT001 = validation, the
-- code ytw_raise uses).
--
-- Snippet. Plain text of at most 400 characters; the matched words are wrapped in U+27E6 (start) and
-- U+27E7 (stop). Those two characters are removed from the source text first, so a marker is always
-- one this function put there. Everything else in the snippet is the author's text and must be
-- escaped before it is shown as HTML. Whitespace and control characters are collapsed to single
-- spaces. A script body is highlighted only up to its first 100 000 characters (ts_headline costs
-- time in proportion to the text it parses): a match further in is still found and ranked, but its
-- snippet is the start of the body without markers.

CREATE FUNCTION public.search_all(p_query text, p_limit integer, p_resources text[])
RETURNS TABLE (
  entity_type text,
  id uuid,
  idea_id uuid,
  kind text,
  version integer,
  title text,
  rank real,
  snippet text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  c_mark_start constant text := U&'\27E6';
  c_mark_stop constant text := U&'\27E7';
  c_default_limit constant integer := 20;
  c_max_limit constant integer := 50;
  c_max_query_chars constant integer := 1000;
  c_snippet_chars constant integer := 400;
  c_source_chars constant integer := 100000;
  c_headline_options constant text :=
    'StartSel=' || U&'\27E6' || ', StopSel=' || U&'\27E7' || ', MaxWords=35, MinWords=15, MaxFragments=0';
  v_limit integer := coalesce(p_limit, c_default_limit);
  v_ideas boolean;
  v_scripts boolean;
  v_query tsquery;
  v_hit record;
  v_snippet text;
BEGIN
  IF p_resources IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'YT001',
      MESSAGE = 'resources is required: list the resources the caller may read, from "ideas" and "scripts" (an empty list searches nothing)',
      DETAIL = '{"field": "resources", "allowed": ["ideas", "scripts"]}';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_resources) AS r (name) WHERE r.name IS NULL OR r.name NOT IN ('ideas', 'scripts')) THEN
    RAISE EXCEPTION USING ERRCODE = 'YT001',
      MESSAGE = format('resources may only list "ideas" and "scripts" (got %s)',
                       to_json(left(array_to_string(p_resources, ','), 60))::text),
      DETAIL = '{"field": "resources", "allowed": ["ideas", "scripts"]}';
  END IF;
  IF v_limit < 1 OR v_limit > c_max_limit THEN
    RAISE EXCEPTION USING ERRCODE = 'YT001',
      MESSAGE = format('limit must be a whole number from 1 to %s (got %s)', c_max_limit, v_limit),
      DETAIL = jsonb_build_object('field', 'limit', 'value', v_limit, 'min', 1, 'max', c_max_limit)::text;
  END IF;

  v_ideas := 'ideas' = ANY (p_resources);
  v_scripts := 'scripts' = ANY (p_resources);
  IF NOT (v_ideas OR v_scripts) THEN
    RETURN;
  END IF;

  -- Any text is a query; one without a searchable word (empty, stop words, punctuation) finds nothing.
  v_query := websearch_to_tsquery('english', btrim(left(coalesce(p_query, ''), c_max_query_chars)));
  IF numnode(v_query) = 0 THEN
    RETURN;
  END IF;

  FOR v_hit IN
    WITH hits AS (
      SELECT 'idea'::text AS entity_type, i.id, i.id AS idea_id, NULL::text AS kind,
             NULL::integer AS version, i.title, ts_rank(i.search_vector, v_query, 32) AS rank
      FROM public.ideas i
      WHERE v_ideas AND i.archived_at IS NULL AND i.search_vector @@ v_query
      UNION ALL
      SELECT 'script'::text, s.id, s.idea_id, s.kind, s.version,
             CASE WHEN v_ideas THEN i.title END, ts_rank(s.search_vector, v_query, 32)
      FROM public.scripts s
      JOIN public.ideas i ON i.id = s.idea_id
      WHERE v_scripts AND i.archived_at IS NULL AND s.search_vector @@ v_query
        AND NOT EXISTS (
          SELECT 1 FROM public.scripts newer
          WHERE newer.idea_id = s.idea_id AND newer.kind = s.kind AND newer.version > s.version)
    ),
    top AS (
      SELECT h.* FROM hits h ORDER BY h.rank DESC, h.entity_type, h.id LIMIT v_limit
    )
    SELECT t.entity_type, t.id, t.idea_id, t.kind, t.version, t.title, t.rank,
           CASE WHEN t.entity_type = 'idea' THEN concat_ws(E'\n', i.title, i.pitch)
                ELSE substr(s.body_md, 1, c_source_chars) END AS source
    FROM top t
    LEFT JOIN public.ideas i ON t.entity_type = 'idea' AND i.id = t.id
    LEFT JOIN public.scripts s ON t.entity_type = 'script' AND s.id = t.id
    ORDER BY t.rank DESC, t.entity_type, t.id
  LOOP
    v_snippet := ts_headline('english', translate(v_hit.source, c_mark_start || c_mark_stop, ''),
                             v_query, c_headline_options);
    v_snippet := btrim(regexp_replace(v_snippet, '[[:space:][:cntrl:]]+', ' ', 'g'));
    IF char_length(v_snippet) > c_snippet_chars THEN
      -- One character short of the cap, so that closing an unfinished highlight still fits.
      v_snippet := left(v_snippet, c_snippet_chars - 1);
      IF char_length(v_snippet) - char_length(replace(v_snippet, c_mark_start, ''))
         > char_length(v_snippet) - char_length(replace(v_snippet, c_mark_stop, '')) THEN
        v_snippet := v_snippet || c_mark_stop;
      END IF;
    END IF;

    entity_type := v_hit.entity_type;
    id := v_hit.id;
    idea_id := v_hit.idea_id;
    kind := v_hit.kind;
    version := v_hit.version;
    title := v_hit.title;
    rank := v_hit.rank;
    snippet := v_snippet;
    RETURN NEXT;
  END LOOP;
END
$$;

COMMENT ON FUNCTION public.search_all(text, integer, text[]) IS
  'Full-text search (websearch syntax, english) over idea titles/pitches and the latest script revisions: search_all(query, limit 1-50, resources subset of {ideas, scripts}). Returns entity_type, id, idea_id, kind, version, title, rank and a plain-text snippet with U+27E6/U+27E7 around the matches.';

-- ---------------------------------------------------------------------------------------------
-- Activity feed
-- ---------------------------------------------------------------------------------------------
--
-- The activity feed over the audit log: list_events(filters..., limit, cursor), newest first, with
-- keyset pagination.
--
-- Filters (all optional, all combined with AND): actor (exact name), actor_type ('human' or
-- 'agent'), entity_type (exact), entity_id, action prefix (a plain prefix: '%' and '_' mean
-- themselves, so 'tool.' finds tool.call and nothing else), and a time range on created_at that
-- includes p_from and excludes p_to (p_from after p_to is a validation error; equal bounds are an
-- empty range). payload comes back exactly as stored: the audit layer redacted it when it wrote it.
--
-- Pagination. Rows are ordered by (created_at DESC, id DESC), a total order. next_cursor is NULL on
-- the last page; otherwise it is an opaque string (base64url of the position of the page's last
-- row) that continues right after that row when passed as p_cursor with the same filters. New
-- events always sort in front of the cursor, so pages already read neither repeat nor skip rows
-- when events arrive between two calls. One limit remains, inherent in ordering by commit time:
-- an event of a transaction that started before the cursor's position but commits after the
-- caller passed that position is not seen by that walk. created_at is the start of the writing
-- transaction (now()), the position is exact to the microsecond. A cursor that does not decode
-- is a validation error, never a driver error; NULL or the empty string starts at the newest
-- event. p_limit is 1 to 100 (NULL means 50).
--
-- SECURITY INVOKER: it reads events with the caller's privileges; the service decides who may read
-- the activity log (resource 'activity') before calling. Errors use the catalogue SQLSTATE YT001
-- (validation) directly.
--
-- plan_cache_mode: every call is planned for its own filter values, because a generic plan for
-- "(param IS NULL OR column = param)" cannot use the right index when a filter is given.

CREATE FUNCTION public.list_events(
  p_actor text DEFAULT NULL,
  p_actor_type text DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_action_prefix text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT NULL,
  p_cursor text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  created_at timestamptz,
  actor text,
  actor_type text,
  token_id uuid,
  action text,
  entity_type text,
  entity_id uuid,
  payload jsonb,
  next_cursor text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
  c_default_limit constant integer := 50;
  c_max_limit constant integer := 100;
  v_limit integer := coalesce(p_limit, c_default_limit);
  v_text text;
  v_cursor_at timestamptz;
  v_cursor_id uuid;
BEGIN
  IF p_actor_type IS NOT NULL AND p_actor_type NOT IN ('human', 'agent') THEN
    RAISE EXCEPTION USING ERRCODE = 'YT001',
      MESSAGE = format('actor_type must be "human" or "agent" (got %s)',
                       to_json(left(p_actor_type, 60))::text),
      DETAIL = '{"field": "actor_type", "allowed": ["human", "agent"]}';
  END IF;
  IF v_limit < 1 OR v_limit > c_max_limit THEN
    RAISE EXCEPTION USING ERRCODE = 'YT001',
      MESSAGE = format('limit must be a whole number from 1 to %s (got %s)', c_max_limit, v_limit),
      DETAIL = jsonb_build_object('field', 'limit', 'value', v_limit, 'min', 1, 'max', c_max_limit)::text;
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION USING ERRCODE = 'YT001',
      MESSAGE = 'from must not be after to: the range includes from and excludes to',
      DETAIL = '{"field": "from"}';
  END IF;

  IF nullif(p_cursor, '') IS NOT NULL THEN
    -- The cursor is base64url of 'v1|<UTC time with microseconds>|<event id>'.
    BEGIN
      IF p_cursor !~ '^[A-Za-z0-9_-]{1,200}$' THEN
        RAISE EXCEPTION 'not a cursor';
      END IF;
      v_text := convert_from(
        decode(rpad(translate(p_cursor, '-_', '+/'), ((char_length(p_cursor) + 3) / 4) * 4, '='), 'base64'),
        'UTF8');
      IF v_text !~ '^v1\|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'not a cursor';
      END IF;
      v_cursor_at := split_part(v_text, '|', 2)::timestamptz;
      v_cursor_id := split_part(v_text, '|', 3)::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE = 'YT001',
        MESSAGE = 'cursor is not valid: pass the next_cursor of a previous list_events call unchanged, with the same filters',
        DETAIL = '{"field": "cursor"}';
    END;
  END IF;

  RETURN QUERY
  WITH raw AS (
    SELECT e.id, e.created_at, e.actor, e.actor_type, e.token_id, e.action, e.entity_type,
           e.entity_id, e.payload
    FROM public.events e
    WHERE (p_actor IS NULL OR e.actor = p_actor)
      AND (p_actor_type IS NULL OR e.actor_type = p_actor_type)
      AND (p_entity_type IS NULL OR e.entity_type = p_entity_type)
      AND (p_entity_id IS NULL OR e.entity_id = p_entity_id)
      AND (p_action_prefix IS NULL OR starts_with(e.action, p_action_prefix))
      AND (p_from IS NULL OR e.created_at >= p_from)
      AND (p_to IS NULL OR e.created_at < p_to)
      AND (v_cursor_at IS NULL OR (e.created_at, e.id) < (v_cursor_at, v_cursor_id))
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT v_limit + 1
  ),
  page AS (
    SELECT r.*, row_number() OVER (ORDER BY r.created_at DESC, r.id DESC) AS pos
    FROM raw r
  ),
  more AS (
    SELECT CASE WHEN count(*) > v_limit THEN
             translate(
               encode(convert_to('v1|' || to_char((max(p.created_at) FILTER (WHERE p.pos = v_limit)) AT TIME ZONE 'UTC',
                                                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                                 || '|' || (array_agg(p.id) FILTER (WHERE p.pos = v_limit))[1]::text, 'UTF8'),
                      'base64'),
               E'+/=\n', '-_')
           END AS next_cursor
    FROM page p
  )
  SELECT p.id, p.created_at, p.actor, p.actor_type, p.token_id, p.action, p.entity_type,
         p.entity_id, p.payload, m.next_cursor
  FROM page p
  CROSS JOIN more m
  WHERE p.pos <= v_limit
  ORDER BY p.pos;
END
$$;

COMMENT ON FUNCTION public.list_events(text, text, text, uuid, text, timestamptz, timestamptz, integer, text) IS
  'Activity feed over events, newest first: list_events(actor, actor_type, entity_type, entity_id, action_prefix, from (inclusive), to (exclusive), limit 1-100, cursor). next_cursor is NULL on the last page, otherwise pass it back as cursor.';
