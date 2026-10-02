-- 0054_web_sessions: server-side browser sessions of the web app (PLAN.md section 0 "Sessions"; PRD 7:
-- tokens stay on the server, idle timeout 8 hours, absolute timeout 7 days, both configurable).
-- The web server (T40) is the only caller, so only ytw_web may execute these. Conventions:
-- docs/database.md ("Identity, permissions, tokens, sessions").
--
-- Deliberately NOT audited and without an actor parameter (the one exception to the function
-- convention): a session is not a business record, last_seen_at changes on every request, and the
-- session id is the bearer handle behind the session cookie, which must never reach `events`
-- (every application role and the activity feed can read it). Logins and logouts are logged by the
-- caller with ytw_log_event. For the same reason no message here repeats a session id.
--
-- Two clocks, both measured at the start of the call that checks them (statement_timestamp):
--   * idle    expires_at           = last activity + idle timeout, moved forward by touch_web_session
--   * absolute absolute_expires_at = login + absolute timeout, never moved
-- A session is alive only while both lie in the future; expires_at never exceeds absolute_expires_at.
-- The refresh token arrives as opaque ciphertext made by the caller (key derived from
-- SESSION_SECRET); the database stores and returns it without looking inside.

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

-- Timeouts, blob and hint must fit what the table accepts, and the timeouts must be sane: at least a
-- minute (0 or negative would create a dead session) and at most 366 days.
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
  IF p_idle_timeout_seconds IS NULL OR p_idle_timeout_seconds NOT BETWEEN 60 AND 31622400 THEN
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

-- Starts a session for a user who just signed in. Idle expiry = now + idle timeout (capped at the
-- absolute expiry), absolute expiry = now + absolute timeout. The refresh token blob and the ID
-- token hint (for RP-initiated logout) may be NULL when the provider issued none.
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
  v_id uuid;
BEGIN
  IF p_absolute_timeout_seconds IS NULL THEN
    PERFORM public.ytw_raise(
      'validation',
      'the absolute timeout must be between 60 and 31622400 seconds (1 minute to 366 days)',
      jsonb_build_object('field', 'absolute_timeout_seconds'));
  END IF;
  PERFORM public.ytw_check_session_args(
    p_idle_timeout_seconds, p_absolute_timeout_seconds, p_refresh_token_encrypted, p_id_token_hint);
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id) THEN
    PERFORM public.ytw_raise(
      'not_found',
      format('user %s does not exist: a session belongs to a user who has signed in', coalesce(p_user_id::text, 'NULL')),
      jsonb_build_object('entity', 'user', 'id', p_user_id));
  END IF;

  v_absolute := v_now + make_interval(secs => p_absolute_timeout_seconds);
  INSERT INTO ytw_private.web_sessions
    (user_id, refresh_token_encrypted, id_token_hint, created_at, last_seen_at, expires_at,
     absolute_expires_at)
  VALUES
    (p_user_id, p_refresh_token_encrypted, p_id_token_hint, v_now, v_now,
     least(v_now + make_interval(secs => p_idle_timeout_seconds), v_absolute), v_absolute)
  RETURNING id INTO v_id;

  RETURN (SELECT ROW(s.id, s.user_id, 'active', s.created_at, s.last_seen_at, s.expires_at,
                     s.absolute_expires_at)::public.ytw_web_session_info
            FROM ytw_private.web_sessions s WHERE s.id = v_id);
END
$$;

COMMENT ON FUNCTION public.create_web_session(uuid, bytea, text, integer, integer) IS
  'Start a web session: idle expiry now + idle timeout, absolute expiry now + absolute timeout. The refresh token is opaque ciphertext from the caller.';

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
  PERFORM public.ytw_check_session_args(p_idle_timeout_seconds, NULL, NULL, NULL);
  RETURN QUERY
  WITH touched AS (
    UPDATE ytw_private.web_sessions s
       SET last_seen_at = v_now,
           expires_at = least(v_now + make_interval(secs => p_idle_timeout_seconds),
                              s.absolute_expires_at)
     WHERE s.id = p_session_id AND s.expires_at > v_now AND s.absolute_expires_at > v_now
    RETURNING s.id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.absolute_expires_at
  )
  SELECT t.id, t.user_id, 'active'::text, t.created_at, t.last_seen_at, t.expires_at,
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
  SELECT s.id, s.user_id, st.status,
         CASE WHEN st.status = 'active' THEN s.refresh_token_encrypted END,
         s.id_token_hint, s.created_at, s.last_seen_at, s.expires_at, s.absolute_expires_at
  FROM ytw_private.web_sessions s
  CROSS JOIN LATERAL (
    SELECT public.ytw_session_status(s.expires_at, s.absolute_expires_at) AS status
  ) st
  WHERE s.id = p_session_id
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
  PERFORM public.ytw_check_session_args(60, NULL, p_refresh_token_encrypted, p_id_token_hint);
  UPDATE ytw_private.web_sessions s
     SET refresh_token_encrypted = coalesce(p_refresh_token_encrypted, s.refresh_token_encrypted),
         id_token_hint = coalesce(p_id_token_hint, s.id_token_hint)
   WHERE s.id = p_session_id AND s.expires_at > v_now AND s.absolute_expires_at > v_now;
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
  DELETE FROM ytw_private.web_sessions s WHERE s.id = p_session_id;
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

REVOKE ALL ON FUNCTION public.ytw_session_status(timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_check_session_args(integer, integer, bytea, text) FROM PUBLIC;

-- The web server only: sessions are a browser concern, and the MCP server never sees one.
REVOKE ALL ON FUNCTION public.create_web_session(uuid, bytea, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_web_session(uuid, bytea, text, integer, integer) TO ytw_web;
REVOKE ALL ON FUNCTION public.touch_web_session(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_web_session(uuid, integer) TO ytw_web;
REVOKE ALL ON FUNCTION public.get_web_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_web_session(uuid) TO ytw_web;
REVOKE ALL ON FUNCTION public.update_web_session_tokens(uuid, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_web_session_tokens(uuid, bytea, text) TO ytw_web;
REVOKE ALL ON FUNCTION public.delete_web_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_web_session(uuid) TO ytw_web;
REVOKE ALL ON FUNCTION public.purge_expired_web_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_expired_web_sessions() TO ytw_web;
