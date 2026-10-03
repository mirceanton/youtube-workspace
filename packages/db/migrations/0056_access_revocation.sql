-- 0056_access_revocation: ending a person's access without deleting them (T14 review). PRD 7 ("OIDC
-- requirements"): the Keycloak group check "is repeated on every token refresh, so removing someone
-- from the group in Keycloak ends their access", and a token's level is the lower of its own and its
-- owner's CURRENT level. This file is the user side; 0057 adds the functions that set the flag and
-- 0058 the token side.
--
-- users.access_revoked_at is set while the person has no access at all:
--   * the web server sets it when the identity provider says the person is outside the access group
--     (mark_user_outside_access_group), an admin sets it by hand for offboarding
--     (set_user_access_revoked), both in 0057;
--   * the effective level of a revoked user is none on every object, admins included, and so is the
--     effective level of every token they own (token = lower of its own level and its owner's);
--   * the effective admin flag is false everywhere it is returned (get_user_access,
--     list_users_with_levels, lookup_token_by_hash): @ytw/policy userLevels gives an admin the maximum
--     whatever stored levels come with them, so a revoked admin must not look like one;
--   * a revoked person cannot manage anything (ytw_acting_user) and does not count as an admin when
--     the last admin is protected;
--   * signing in again after the group check passed clears it (upsert_user_on_login), or an admin
--     restores it (set_user_access_revoked). Nothing else does.
-- The stored levels, the admin flag and the tokens are kept, so restoring access restores exactly
-- what was there.

ALTER TABLE public.users ADD COLUMN access_revoked_at timestamptz;

COMMENT ON COLUMN public.users.access_revoked_at IS
  'Set while the person has no access at all (outside the identity provider''s access group, or locked out by an admin): effective levels none, not an admin, their tokens dead. NULL = access as stored. Cleared by the next sign-in that passed the group check.';

ALTER TYPE public.ytw_user_access ADD ATTRIBUTE access_revoked_at timestamptz;

-- 1. A user's EFFECTIVE level on every object: none everywhere while access is revoked (admins
--    included), otherwise as in 0050 (admins the maximum, everyone else the stored level).
CREATE OR REPLACE FUNCTION public.ytw_user_effective_levels(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT jsonb_object_agg(
           r.resource,
           CASE WHEN u.access_revoked_at IS NOT NULL THEN 'none'
                WHEN u.is_admin THEN public.ytw_max_level(r.resource)
                ELSE public.ytw_cap_level(r.resource, coalesce(p.level, 'none')) END)
  FROM public.users u
  CROSS JOIN LATERAL unnest(public.ytw_resources()) AS r (resource)
  LEFT JOIN public.user_permissions p ON p.user_id = u.id AND p.resource = r.resource
  WHERE u.id = p_user_id
$$;

-- 2. The gate of every function that manages users, access or tokens (0050), now also refusing a
--    person whose access is revoked: they may not do anything until they are back.
CREATE OR REPLACE FUNCTION public.ytw_acting_user(
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

-- 3. The checks of an OIDC identity (issuer and subject), shared by the sign-in and the revocation
--    that name a person by it.
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

REVOKE ALL ON FUNCTION public.ytw_check_identity_claims(text, text) FROM PUBLIC;

-- 4. Signing in (0051), now lifting a revocation: a person who passed the group check has access
--    again, with exactly the levels and admin flag they had. The restoration is logged as
--    user.access_restored (the audit trigger of users also records the changed column).
CREATE OR REPLACE FUNCTION public.upsert_user_on_login(
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
            NOT EXISTS (SELECT 1 FROM public.users), v_now)
    RETURNING * INTO v_user;
    v_created := true;
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
  'Sign a person in: create or update the user for an OIDC identity. The first user ever becomes admin (race-free); later users start with none everywhere. Lifts a revoked access. Call it only after the access group check passed.';

-- 5. Reading a user back (0051): is_admin is the EFFECTIVE flag (an admin whose access is revoked is
--    not one), levels the effective levels, access_revoked_at says why they are none.
CREATE OR REPLACE FUNCTION public.get_user_access(p_user_id uuid)
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
  WHERE u.id = p_user_id
$$;

COMMENT ON FUNCTION public.get_user_access(uuid) IS
  'A user with the levels they hold right now (admins: the maximum everywhere; revoked access: none and not an admin, with access_revoked_at). No row when the id is unknown.';

-- 6. The access matrix (0052), for an admin whose access is not revoked.
CREATE OR REPLACE FUNCTION public.list_users_with_levels(p_acting_user_id uuid)
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
  ORDER BY u.created_at, u.id;
END
$$;

COMMENT ON FUNCTION public.list_users_with_levels(uuid) IS
  'Admin only: all users with their effective levels and access_revoked_at (the access matrix of the settings page).';

-- 7. Promoting and demoting (0052). Only an admin whose access is NOT revoked counts when the last
--    admin is protected: demoting the last active admin is refused even when revoked admins exist,
--    and demoting a revoked admin never is (it changes nobody's ability to administer). The result
--    reports the STORED admin flag it changed; access_revoked_at of get_user_access says whether it
--    currently counts.
CREATE OR REPLACE FUNCTION public.set_user_admin(
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
