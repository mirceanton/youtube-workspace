-- 0064_activity: the activity feed over the audit log (PRD 6 "Activity", "Dashboard", T15):
-- list_events(filters..., limit, cursor), newest first, with keyset pagination. Details:
-- docs/database.md, "Views, search and activity (T15)".
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
-- SECURITY INVOKER: it reads events with the caller's privileges. Executable by ytw_web and
-- ytw_mcp only; the service decides who may read the activity log (resource 'activity', PRD 7)
-- before calling. Errors use the catalogue SQLSTATE YT001 (validation) directly, because an
-- invoker function cannot call the internal ytw_raise helper.
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

REVOKE ALL ON FUNCTION public.list_events(text, text, text, uuid, text, timestamptz, timestamptz, integer, text) FROM PUBLIC;


COMMENT ON FUNCTION public.list_events(text, text, text, uuid, text, timestamptz, timestamptz, integer, text) IS
  'Activity feed over events, newest first: list_events(actor, actor_type, entity_type, entity_id, action_prefix, from (inclusive), to (exclusive), limit 1-100, cursor). next_cursor is NULL on the last page, otherwise pass it back as cursor.';
