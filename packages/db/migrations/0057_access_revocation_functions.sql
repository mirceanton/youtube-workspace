-- 0057_access_revocation_functions: setting and lifting users.access_revoked_at (0056), and keeping a
-- revoked person out of the browser sessions. Web server only (T40 for the group check, the admin
-- CLI for offboarding). Conventions: docs/database.md ("Identity, permissions, tokens, sessions").
--
--   * mark_user_outside_access_group: the identity provider said the person is not in the access
--     group any more (the check PRD 7 repeats on every token refresh). Sets the flag, ends every
--     browser session of the person on every device, logs user.access_revoked. It NEVER creates a
--     user ("no user record is created" for someone without the group, PRD 7): an unknown identity
--     answers no row and writes nothing. It is not subject to the last-admin guard: the identity
--     provider outranks it, otherwise the one admin removed from the group would keep their tokens
--     and sessions. The workspace may then have no admin whose access is active; signing in again with
--     access restores the person (their admin flag is kept), and the event says so (no_active_admin).
--   * set_user_access_revoked: an admin locks a person out by hand, or restores them (offboarding of
--     somebody who never comes back to the web app, so the group check never reaches them). The acting
--     user must be an admin whose access is active; the last admin whose access is active cannot be
--     locked out. Locking out ends the person's sessions as well.
--   * create_web_session refuses a person whose access is revoked, and locks their row while it
--     inserts, so a session cannot slip in between the revocation and the deletion of the sessions.
-- A revocation is the lock-first kind of change: both functions take ytw_lock_users() before any row.

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
   WHERE u.oidc_issuer = p_issuer AND u.oidc_sub = p_sub
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

  SELECT * INTO v_target FROM public.users u WHERE u.id = p_user_id FOR UPDATE;
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

-- create_web_session (0054) for a person whose access is not revoked. The user row is share-locked
-- until COMMIT, so a revocation (which updates the row) waits for the insert and then ends the new
-- session too; the other way round the insert sees the revocation and is refused.
CREATE OR REPLACE FUNCTION public.create_web_session(
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
  v_username text;
  v_revoked timestamptz;
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
  SELECT u.username, u.access_revoked_at INTO v_username, v_revoked
    FROM public.users u WHERE u.id = p_user_id FOR SHARE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise(
      'not_found',
      format('user %s does not exist: a session belongs to a user who has signed in', p_user_id),
      jsonb_build_object('entity', 'user', 'id', p_user_id));
  END IF;
  IF v_revoked IS NOT NULL THEN
    PERFORM public.ytw_raise(
      'forbidden',
      format('the access of %s is revoked, so no session can start for them: they must sign in again with access',
             to_json(v_username)),
      jsonb_build_object('reason', 'access_revoked'));
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

REVOKE ALL ON FUNCTION public.mark_user_outside_access_group(text, text, uuid, text, text)
  FROM PUBLIC;

REVOKE ALL ON FUNCTION public.set_user_access_revoked(text, text, uuid, uuid, uuid, boolean)
  FROM PUBLIC;
