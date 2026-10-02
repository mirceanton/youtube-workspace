-- 0004_audit: the immutable audit log (PRD 4 "events") and the machinery that fills it.
--
-- Two ways in, both writing `events` with the actor that ytw_set_actor() put into the transaction:
--   * ytw_audit(): an AFTER ... FOR EACH ROW trigger that business tables attach (T11), so every
--     INSERT and UPDATE made by a database function is logged without the function doing anything
--     beyond calling ytw_set_actor(p_actor, p_actor_type, p_token_id) first;
--   * ytw_log_event(): for things that are not row changes (MCP tool calls, denied calls, logins).
-- Conventions and payload shapes: docs/database.md.

-- 1. The log itself. Insert and select only: no role holds UPDATE/DELETE/TRUNCATE, and triggers
--    refuse them even for the owner.
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
  CONSTRAINT events_human_without_token CHECK (actor_type <> 'human' OR token_id IS NULL),
  CONSTRAINT events_entity_id_needs_type CHECK (entity_id IS NULL OR entity_type IS NOT NULL)
);

COMMENT ON TABLE public.events IS
  'Immutable audit log (PRD 4): one row per insert/update of a business table and per logged action.';

CREATE INDEX events_created_at_idx ON public.events (created_at DESC, id DESC);
CREATE INDEX events_entity_idx ON public.events (entity_type, entity_id, created_at DESC)
  WHERE entity_id IS NOT NULL;
CREATE INDEX events_actor_idx ON public.events (actor, created_at DESC);

GRANT SELECT ON TABLE public.events TO ytw_web, ytw_mcp, ytw_readonly;

-- 2. Append-only guard, reusable for any table whose rows must never change (T11 attaches it to
--    video_metrics, for example): BEFORE UPDATE OR DELETE FOR EACH ROW and BEFORE TRUNCATE.
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
--    settings (app.actor, app.actor_type, app.token_id) that ytw_audit() reads. SECURITY DEFINER
--    only so that it may call ytw_raise() when withActor() calls it directly as an application
--    role; it touches no table, and the settings it writes are ones any role could set itself.
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

GRANT EXECUTE ON FUNCTION public.ytw_set_actor(text, text, uuid) TO ytw_web, ytw_mcp;

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

-- 4. Payload hygiene for row snapshots, because ytw_readonly and the activity feed can read every
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

GRANT EXECUTE ON FUNCTION public.ytw_log_event(text, text, uuid, text, text, uuid, jsonb)
  TO ytw_web, ytw_mcp;
