-- 0052_permissions: who may do what (PRD 7 "Access model", "Enforcement rules", "Settings page"):
-- an admin sets a user's level per object, promotes and demotes admins, and lists the access matrix.
-- Web server only (T42). Conventions: docs/database.md.
--
-- The rules live here, not in the callers:
--   * only a signed-in person who is an admin may change access; API tokens never can;
--   * the activity log is never write;
--   * an admin holds the maximum on every object, so their rows are never lowered, and promoting a
--     user raises their stored rows to the maximum in the same transaction (the database then agrees
--     with @ytw/policy userLevels, which gives admins the maximum whatever rows are stored);
--   * the last admin cannot be demoted. Promotions and demotions are serialised with ytw_lock_users(),
--     so two admins demoting each other at the same moment cannot leave the system without one;
--   * demoting an admin resets their levels to none, so it lowers their tokens too (see below).
-- Besides the row-level events of the audit triggers, each change writes one readable event
-- (user.permission_changed, user.admin_granted, user.admin_revoked) that names the person and the
-- object: the trigger payloads carry only the changed columns.

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

  -- Share-locked until COMMIT: promoting this user waits for us, so we never write below the
  -- maximum into a row that is being raised, and demoting waits as well.
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

COMMENT ON FUNCTION public.set_user_permission(text, text, uuid, uuid, uuid, text, text) IS
  'Admin only: set a user''s level on one object. Activity is never write; an admin''s levels cannot be lowered.';

-- Promotes or demotes an admin.
--   * Promoting raises the user's stored rows to the maximum (their effective levels already are, by
--     the admin rule), so the stored rows agree with @ytw/policy.
--   * Demoting resets the user to none on every object (the state of a new user) unless
--     p_keep_levels is true: a demotion then lowers the person and every token they own at once
--     (docs/policy.md), and the admin grants back what the person should keep. With p_keep_levels the
--     rows stay as they are, which for a former admin means the maximum everywhere.
--   * The last admin cannot be demoted.
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

  SELECT * INTO v_target FROM public.users u WHERE u.id = p_user_id FOR UPDATE;
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
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.is_admin AND u.id <> v_target.id) THEN
      PERFORM public.ytw_raise(
        'forbidden',
        format('%s is the last admin and cannot be demoted: promote another user to admin first',
               to_json(v_target.username)),
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
  'Admin only: promote (rows raised to the maximum) or demote (levels reset to none unless p_keep_levels) a user. The last admin cannot be demoted.';

-- The access matrix: every user with the levels they hold, oldest account first. Admins only.
CREATE FUNCTION public.list_users_with_levels(p_acting_user_id uuid)
RETURNS SETOF public.ytw_user_access
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_acting_user_id AND u.is_admin) THEN
    PERFORM public.ytw_raise(
      'forbidden', 'only an admin can list the access levels of all users',
      jsonb_build_object('reason', 'not_admin'));
  END IF;
  RETURN QUERY
  SELECT u.id, u.oidc_issuer, u.oidc_sub, u.username, u.email, u.display_name, u.is_admin,
         u.last_login_at, u.created_at, public.ytw_user_effective_levels(u.id)
  FROM public.users u
  ORDER BY u.created_at, u.id;
END
$$;

COMMENT ON FUNCTION public.list_users_with_levels(uuid) IS
  'Admin only: all users with their effective levels (the access matrix of the settings page).';

REVOKE ALL ON FUNCTION public.set_user_permission(text, text, uuid, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_user_permission(text, text, uuid, uuid, uuid, text, text) TO ytw_web;
REVOKE ALL ON FUNCTION public.set_user_admin(text, text, uuid, uuid, uuid, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_user_admin(text, text, uuid, uuid, uuid, boolean, boolean) TO ytw_web;
REVOKE ALL ON FUNCTION public.list_users_with_levels(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_users_with_levels(uuid) TO ytw_web;
