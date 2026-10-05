-- 0058_token_owner_revocation: the token side of a revoked access (0056), and least privilege for the
-- token authentication functions (T14 review).
--
--   * A token whose owner's access is revoked has the status 'owner_revoked' (after 'revoked' and
--     'expired', which are facts about the token itself), so it can never be mistaken for an active
--     one; its effective levels are none, and so are the owner's levels and the owner's admin flag
--     that lookup_token_by_hash returns (the owner's EFFECTIVE flag: @ytw/policy would otherwise give
--     a revoked admin's tokens the maximum). The token's own stored levels are kept, so the token
--     works again, exactly as it was, when the owner's access is restored.
--   * lookup_token_by_hash and touch_token_last_used authenticate agents: the MCP server needs them,
--     the web server does not (a token never acts as a browser login; it manages tokens through the
--     list and get functions), so ytw_web loses EXECUTE on both.
--   * touch_token_last_used records the use of an ACTIVE token only, and its name check is defence in
--     depth rather than authentication (see the comment on the function).

-- 1. Status of a token as a fact about the token and its owner. 'revoked' wins over 'expired', and
--    both win over 'owner_revoked' (the more specific fact about the token comes first).
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

REVOKE ALL ON FUNCTION public.ytw_token_status(timestamptz, timestamptz, timestamptz) FROM PUBLIC;

-- 2. A token as the settings screens show it (0053), with the status above.
CREATE OR REPLACE FUNCTION public.ytw_api_token_info_of(p_api_token_id uuid)
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

-- 3. The authentication lookup (0053). Same columns; owner_is_admin is the owner's EFFECTIVE admin
--    flag and status may be 'owner_revoked'.
CREATE OR REPLACE FUNCTION public.lookup_token_by_hash(p_token_hash text)
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

-- 4. Recording a use (0053): an active token only (not revoked, not expired, owner's access not
--    revoked).
CREATE OR REPLACE FUNCTION public.touch_token_last_used(p_actor text, p_actor_type text, p_token_id uuid)
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
  -- both appear in the readable audit log (token.created), so knowing them proves nothing. What
  -- keeps a stranger from calling this function is that only the MCP server holds the role that may.
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

-- 5. Nothing calls the two-argument form any more.
DROP FUNCTION public.ytw_token_status(timestamptz, timestamptz);

-- 6. Least privilege: the MCP server authenticates agents, the web server does not.
