-- 0055_identity_lock_discipline: two corrections to how the identity functions serialise (T14
-- review). Fix-forward of 0050 and 0052: those files stay as they were merged.
--
-- 1. REPEATABLE READ. The first-login rule ("whoever finds no user at all becomes admin") and the
--    last-admin guard run their NOT EXISTS checks after ytw_lock_users() has granted the advisory
--    lock. That is sound only when every statement reads fresh data (READ COMMITTED, the default):
--    under REPEATABLE READ the snapshot is taken by the first statement of the transaction (for
--    withActor() that is ytw_set_actor), before the lock was granted, so two transactions can both read
--    "no user yet" or "another admin exists" and both proceed (two first admins; the last admin
--    demoting themselves after the other one was demoted). SERIALIZABLE is safe: Postgres aborts one of
--    the two transactions with 40001, which the callers already treat as "retry". So ytw_lock_users()
--    refuses a REPEATABLE READ transaction before it takes the lock.
--
-- 2. One lock order. set_user_permission share-locked the acting and the target user and met the
--    advisory lock only when the same transaction went on to call set_user_admin, while a login that
--    already held the advisory lock waited for the target's row: a deadlock (40P01). Every function
--    that writes users, permission rows or revocations now takes ytw_lock_users() FIRST, before it
--    locks any user row, so there is a single order: advisory lock, then rows. set_user_permission
--    joins upsert_user_on_login and set_user_admin (and, from 0057, the revocation functions).
--    Functions that only write token rows (create_api_token, ...) share-lock their owner's row and
--    never wait for the advisory lock, so they cannot be part of a cycle.

CREATE OR REPLACE FUNCTION public.ytw_lock_users()
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

-- set_user_permission with the lock first (otherwise unchanged from 0052).
CREATE OR REPLACE FUNCTION public.set_user_permission(
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
  -- Before any user row is locked: the one lock order of the identity functions (see above).
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

  -- Share-locked until COMMIT, as before: nobody can change this user's row under us. (The advisory
  -- lock already serialises the identity functions; this also covers a caller that locks rows itself.)
  SELECT * INTO v_target FROM public.users u WHERE u.id = p_user_id FOR SHARE;
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
