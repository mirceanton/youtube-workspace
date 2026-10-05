-- 0051_identity: signing in. upsert_user_on_login creates or updates the app user behind an OIDC
-- identity (PRD 7 "Access model"): the very first user ever becomes admin with the maximum level on
-- every object, in the same transaction and race-free; every later user starts with none everywhere
-- until an admin sets their levels (0052). get_user_access reads a user back with the levels they
-- hold right now. Used by the web server only (T40). Conventions: docs/database.md.

-- A user as the web contract needs them (GET /api/me, the access matrix). `levels` holds the
-- EFFECTIVE level on every object (what @ytw/policy userLevels computes): admins have the maximum
-- everywhere, everyone else their stored level (none without a row).
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
  levels jsonb
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
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_actor_type <> 'human' THEN
    PERFORM public.ytw_raise(
      'forbidden',
      'only a person signs in through the identity provider: API tokens cannot log in',
      jsonb_build_object('reason', 'not_human'));
  END IF;
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
    UPDATE public.users u
       SET username = v_username, email = v_email, display_name = v_display_name,
           last_login_at = v_now
     WHERE u.id = v_user.id
    RETURNING * INTO v_user;
  END IF;

  PERFORM public.ytw_sync_user_rows(v_user.id, v_user.is_admin);

  RETURN QUERY
  SELECT v_user.id, v_user.oidc_issuer, v_user.oidc_sub, v_user.username, v_user.email,
         v_user.display_name, v_user.is_admin, v_user.last_login_at, v_user.created_at,
         public.ytw_user_effective_levels(v_user.id), v_created;
END
$$;

COMMENT ON FUNCTION public.upsert_user_on_login(text, text, uuid, text, text, text, text, text) IS
  'Sign a person in: create or update the user for an OIDC identity. The first user ever becomes admin (race-free); later users start with none everywhere.';

-- The user and the levels they hold right now (admins: the maximum everywhere). No rows for an
-- unknown id. The web server calls this on every request: levels are never cached (PRD 7).
CREATE FUNCTION public.get_user_access(p_user_id uuid)
RETURNS SETOF public.ytw_user_access
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT u.id, u.oidc_issuer, u.oidc_sub, u.username, u.email, u.display_name, u.is_admin,
         u.last_login_at, u.created_at, public.ytw_user_effective_levels(u.id)
  FROM public.users u
  WHERE u.id = p_user_id
$$;

COMMENT ON FUNCTION public.get_user_access(uuid) IS
  'A user with the levels they hold right now (admins: the maximum everywhere). No row when the id is unknown.';

REVOKE ALL ON FUNCTION public.upsert_user_on_login(text, text, uuid, text, text, text, text, text)
  FROM PUBLIC;

REVOKE ALL ON FUNCTION public.get_user_access(uuid) FROM PUBLIC;
