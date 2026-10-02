-- 0050_identity_helpers: the building blocks of the identity, permission, token and session
-- functions of 0051-0054 (T14). None of them is executable by an application role: they run inside
-- the SECURITY DEFINER functions that call them, as the role that owns the schema, so they are
-- plain (invoker) functions. Conventions: docs/database.md ("Identity, permissions, tokens, sessions").
--
-- The object list and the level rules below mirror RESOURCES, LEVELS and GRANTABLE_LEVELS of
-- @ytw/shared and the admin rule of @ytw/policy; packages/db/test/permissions.test.ts fails when
-- they drift. Adding an object type: docs/policy.md ("How to add a new object type").

-- 1. The objects that carry an access level, in display order (RESOURCES). The only SQL list that
--    the functions below read; the CHECK constraints of user_permissions and api_token_permissions
--    (0011, 0012) spell the same list out and must be replaced together with this function.
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
--    transaction short. Key space 0x59545721 ("YTW!") with object 1 = "users and admins".
CREATE FUNCTION public.ytw_lock_users()
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pg_advisory_xact_lock(1498699553, 1)
$$;

-- 7. A user's EFFECTIVE level on every object, as one jsonb object {"ideas": "write", ...}: admins
--    hold the maximum everywhere whatever rows are stored (@ytw/policy userLevels), everyone else
--    the stored level (none when no row), capped per object. NULL when the user does not exist.
CREATE FUNCTION public.ytw_user_effective_levels(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT jsonb_object_agg(
           r.resource,
           CASE WHEN u.is_admin THEN public.ytw_max_level(r.resource)
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
--    effective level (PRD 7; @ytw/policy effectiveLevels). A missing key counts as none.
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
--     name (so the audit log attributes the change to the person who is allowed to make it) and, when
--     asked, be an admin. The acting user's row is share-locked until the end of the transaction, so a
--     concurrent demotion waits for this call instead of racing it. Returns the acting user.
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
  IF v_user.username <> btrim(p_actor) THEN
    PERFORM public.ytw_raise(
      'forbidden',
      format('the audit actor %s is not the acting user %s: pass the signed-in user''s username as the actor',
             to_json(btrim(p_actor)), to_json(v_user.username)),
      jsonb_build_object('reason', 'actor_mismatch'));
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

  FOR v_resource, v_value IN SELECT e.key, e.value FROM jsonb_each(p_requested) e ORDER BY e.key LOOP
    IF NOT v_resource = ANY (v_resources) THEN
      v_invalid := v_invalid || jsonb_build_object(
        'resource', v_resource, 'reason', 'unknown_resource', 'allowed', to_jsonb(v_resources));
      v_messages := v_messages || format('%s is not an object with access levels; valid objects: %s',
                                         to_json(v_resource), array_to_string(v_resources, ', '));
      CONTINUE;
    END IF;

    v_max := public.ytw_max_level(v_resource);
    v_allowed := ARRAY(
      SELECT l FROM unnest(ARRAY['none', 'read', 'write']::text[]) AS l
      WHERE public.ytw_level_rank(l) <= public.ytw_level_rank(v_max));
    v_level := CASE WHEN jsonb_typeof(v_value) = 'string' THEN v_value #>> '{}' END;
    v_choose := 'choose one of: ' || array_to_string(v_allowed, ', ');

    IF public.ytw_level_rank(v_level) IS NULL THEN
      v_invalid := v_invalid || jsonb_build_object(
        'resource', v_resource, 'requested', v_value, 'reason', 'invalid_level',
        'allowed', to_jsonb(v_allowed));
      v_messages := v_messages || format('%s is not an access level for %s; %s',
                                         v_value::text, v_resource, v_choose);
    ELSIF public.ytw_level_rank(v_level) > public.ytw_level_rank(v_max) THEN
      v_invalid := v_invalid || jsonb_build_object(
        'resource', v_resource, 'requested', v_level, 'reason', 'not_grantable',
        'allowed', to_jsonb(v_allowed));
      v_messages := v_messages || format('%s is never allowed on %s (it allows %s); %s',
                                         v_level, v_resource, array_to_string(v_allowed, ', '), v_choose);
    ELSE
      v_ceiling := public.ytw_cap_level(v_resource, p_owner_levels ->> v_resource);
      IF public.ytw_level_rank(v_level) > public.ytw_level_rank(v_ceiling) THEN
        v_allowed := ARRAY(
          SELECT l FROM unnest(ARRAY['none', 'read', 'write']::text[]) AS l
          WHERE public.ytw_level_rank(l) <= public.ytw_level_rank(v_ceiling));
        v_exceeds := v_exceeds || jsonb_build_object(
          'resource', v_resource, 'requested', v_level, 'reason', 'exceeds_owner',
          'owner_level', v_ceiling, 'allowed', to_jsonb(v_allowed));
        v_messages := v_messages || format(
          '%s on %s is above the owner''s own level (%s); a token never exceeds its owner; choose one of: %s',
          v_level, v_resource, v_ceiling, array_to_string(v_allowed, ', '));
      ELSE
        v_normalised := v_normalised || jsonb_build_object(v_resource, v_level);
      END IF;
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

-- Nobody but the SECURITY DEFINER functions of 0051-0054 calls these.
REVOKE ALL ON FUNCTION public.ytw_resources() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_level_rank(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_max_level(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_least_level(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_cap_level(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_lock_users() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_user_effective_levels(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_token_own_levels(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_effective_levels(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_clean_text(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_clean_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_acting_user(text, text, uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_sync_user_rows(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_check_token_grant(text, jsonb, jsonb) FROM PUBLIC;
