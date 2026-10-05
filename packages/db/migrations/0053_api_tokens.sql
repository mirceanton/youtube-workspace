-- 0053_api_tokens: API tokens for agents (PRD 7 "API tokens", PRD 5 "Transport and auth").
-- The caller (T21) generates the secret and passes only its SHA-256 hash and a short prefix; the
-- secret itself never reaches the database, its logs or the audit trail. Conventions:
-- docs/database.md ("Identity, permissions, tokens, sessions").
--
-- The rules live here, not in the callers:
--   * only a signed-in PERSON manages tokens, and only their own (a stolen token cannot mint,
--     widen or rotate tokens): the actor must be the owner;
--   * every level a token is given is at or below its owner's CURRENT effective level, and an owner
--     with no access at all cannot create tokens (PRD 7). The error lists the values that would
--     have been accepted;
--   * what a token may do is always min(token level, owner's current level), computed when the
--     token is looked up, so lowering a user (or demoting an admin) lowers their tokens at once;
--   * revoked tokens stay in the table for the audit trail and cannot be changed or rotated;
--   * the token hash is validated before it is stored and never echoed in an error or an event.
-- Besides the row-level events of the audit triggers, each management call writes one readable event
-- (token.created, token.permissions_changed, token.rotated, token.revoked) that names the token and
-- its owner. The secret, its hash and its prefix are never part of an event.

-- A token as the settings screens show it. `levels` is the token's OWN stored level on every object;
-- `effective_levels` is what it may do right now: the lower of that and its owner's current level
-- on each object, and none while the token is revoked or expired.
CREATE TYPE public.ytw_api_token_info AS (
  token_id uuid,
  owner_id uuid,
  name text,
  token_prefix text,
  status text,
  created_at timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  levels jsonb,
  effective_levels jsonb
);

-- 'revoked' wins over 'expired': revocation is the stronger fact.
CREATE FUNCTION public.ytw_token_status(p_revoked_at timestamptz, p_expires_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_revoked_at IS NOT NULL THEN 'revoked'
    WHEN p_expires_at IS NOT NULL AND p_expires_at <= statement_timestamp() THEN 'expired'
    ELSE 'active'
  END
$$;

CREATE FUNCTION public.ytw_api_token_info_of(p_api_token_id uuid)
RETURNS public.ytw_api_token_info
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT t.id, t.user_id, t.name, t.token_prefix,
         public.ytw_token_status(t.revoked_at, t.expires_at),
         t.created_at, t.expires_at, t.last_used_at, t.revoked_at,
         own.levels,
         CASE WHEN public.ytw_token_status(t.revoked_at, t.expires_at) = 'active'
              THEN public.ytw_effective_levels(own.levels, public.ytw_user_effective_levels(t.user_id))
              ELSE public.ytw_effective_levels('{}'::jsonb, '{}'::jsonb) END
  FROM ytw_private.api_tokens t
  CROSS JOIN LATERAL (SELECT public.ytw_token_own_levels(t.id) AS levels) own
  WHERE t.id = p_api_token_id
$$;

-- Checks the secret-derived values of a token: a prefix of `ytw_` plus at most 11 more characters
-- and a SHA-256 hash as 64 lower-case hex digits that no token uses yet. The messages never contain
-- the hash: a caller that passed the secret itself by mistake must not see it echoed back.
CREATE FUNCTION public.ytw_check_token_secret(p_token_prefix text, p_token_hash text)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_token_prefix IS NULL OR p_token_prefix !~ '^ytw_[A-Za-z0-9_-]{0,11}$' THEN
    PERFORM public.ytw_raise(
      'validation',
      'token_prefix must be "ytw_" followed by at most 11 letters, digits, "_" or "-" (the first characters of the secret, shown in settings)',
      jsonb_build_object('field', 'token_prefix'));
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    PERFORM public.ytw_raise(
      'validation',
      'token_hash must be the SHA-256 of the token as 64 lower-case hexadecimal digits: hash the secret and pass the digest, never the secret itself',
      jsonb_build_object('field', 'token_hash'));
  END IF;
  IF EXISTS (SELECT 1 FROM ytw_private.api_tokens t WHERE t.token_hash = p_token_hash) THEN
    PERFORM public.ytw_raise(
      'duplicate',
      'a token with this hash already exists: generate a new secret',
      jsonb_build_object('field', 'token_hash'));
  END IF;
END
$$;

-- Creates a token for the acting person (owner = actor). permissions: {"ideas": "read", ...};
-- objects left out get none. expires_at NULL = never expires, otherwise it must lie in the future.
-- Returns the new token (never its hash).
CREATE FUNCTION public.create_api_token(
  p_actor text,
  p_actor_type text,
  p_token_id uuid,
  p_owner_user_id uuid,
  p_name text,
  p_token_prefix text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_permissions jsonb
)
RETURNS public.ytw_api_token_info
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_owner public.users;
  v_owner_levels jsonb;
  v_name text := btrim(p_name);
  v_requested jsonb;
  v_levels jsonb;
  v_id uuid;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  v_owner := public.ytw_acting_user(p_actor, p_actor_type, p_owner_user_id, 'create API tokens', false);

  IF v_name IS NULL OR v_name = '' OR char_length(v_name) > 100 OR v_name ~ '[[:cntrl:]]' THEN
    PERFORM public.ytw_raise(
      'validation',
      'name is required: 1-100 characters without control characters (it is the actor name in the audit log)',
      jsonb_build_object('field', 'name'));
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= statement_timestamp() THEN
    PERFORM public.ytw_raise(
      'validation',
      'expires_at must lie in the future (or be empty for a token that never expires)',
      jsonb_build_object('field', 'expires_at'));
  END IF;
  PERFORM public.ytw_check_token_secret(p_token_prefix, p_token_hash);

  v_owner_levels := public.ytw_user_effective_levels(v_owner.id);
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_each_text(v_owner_levels) l WHERE public.ytw_level_rank(l.value) >= 1
  ) THEN
    PERFORM public.ytw_raise(
      'forbidden',
      format('%s has no access to any object, so cannot create API tokens: an admin must grant Read or Write on at least one object first',
             to_json(v_owner.username)),
      jsonb_build_object('reason', 'no_access'));
  END IF;
  v_requested := public.ytw_check_token_grant(v_owner.username, v_owner_levels, p_permissions);

  INSERT INTO ytw_private.api_tokens (user_id, name, token_prefix, token_hash, expires_at)
  VALUES (v_owner.id, v_name, p_token_prefix, p_token_hash, p_expires_at)
  RETURNING id INTO v_id;

  INSERT INTO ytw_private.api_token_permissions (token_id, resource, level)
  SELECT v_id, r.resource, coalesce(v_requested ->> r.resource, 'none')
  FROM unnest(public.ytw_resources()) AS r (resource);

  v_levels := public.ytw_token_own_levels(v_id);
  PERFORM public.ytw_log_event(
    p_actor, p_actor_type, p_token_id, 'token.created', 'api_token', v_id,
    jsonb_build_object('token_name', v_name, 'owner', v_owner.username,
                       'expires_at', p_expires_at, 'levels', v_levels));
  RETURN public.ytw_api_token_info_of(v_id);
END
$$;

COMMENT ON FUNCTION public.create_api_token(text, text, uuid, uuid, text, text, text, timestamptz, jsonb) IS
  'Create a token for the acting person. Every level is checked against the owner''s current effective level; only the SHA-256 hash and a short prefix are stored.';

-- Finds one of the owner's tokens and locks its row until the end of the transaction, so changing,
-- rotating and revoking it queue up instead of interleaving. A token that does not exist and a
-- token of somebody else are the same answer (not_found), so nobody learns which ids are in use.
CREATE FUNCTION public.ytw_lock_own_token(p_api_token_id uuid, p_owner_id uuid)
RETURNS ytw_private.api_tokens
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_token ytw_private.api_tokens;
BEGIN
  IF p_api_token_id IS NULL THEN
    PERFORM public.ytw_raise(
      'validation', 'api_token_id is required', jsonb_build_object('field', 'api_token_id'));
  END IF;
  SELECT * INTO v_token FROM ytw_private.api_tokens t
   WHERE t.id = p_api_token_id AND t.user_id = p_owner_id
   FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise(
      'not_found',
      format('you have no API token with id %s', p_api_token_id),
      jsonb_build_object('entity', 'api_token', 'id', p_api_token_id));
  END IF;
  RETURN v_token;
END
$$;

-- Changes some or all levels of one of the acting person's tokens. Only the objects named are
-- touched (the rest keep their level); the ceiling is checked again against the owner's current
-- level, so a token can never be raised above its owner. Revoked tokens cannot be changed.
CREATE FUNCTION public.update_token_permissions(
  p_actor text,
  p_actor_type text,
  p_token_id uuid,
  p_acting_user_id uuid,
  p_api_token_id uuid,
  p_permissions jsonb
)
RETURNS public.ytw_api_token_info
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_owner public.users;
  v_token ytw_private.api_tokens;
  v_requested jsonb;
  v_resource text;
  v_level text;
  v_old text;
  v_row_id uuid;
  v_changes jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  v_owner := public.ytw_acting_user(p_actor, p_actor_type, p_acting_user_id, 'change API tokens', false);
  v_token := public.ytw_lock_own_token(p_api_token_id, v_owner.id);
  IF v_token.revoked_at IS NOT NULL THEN
    PERFORM public.ytw_raise(
      'invalid_transition',
      format('token %s was revoked and cannot be changed: create a new token', to_json(v_token.name)),
      jsonb_build_object('entity', 'api_token', 'id', v_token.id, 'from', 'revoked'));
  END IF;

  v_requested := public.ytw_check_token_grant(
    v_owner.username, public.ytw_user_effective_levels(v_owner.id), p_permissions);

  FOR v_resource, v_level IN SELECT e.key, e.value FROM jsonb_each_text(v_requested) e ORDER BY e.key LOOP
    SELECT p.id, p.level INTO v_row_id, v_old
      FROM ytw_private.api_token_permissions p
     WHERE p.token_id = v_token.id AND p.resource = v_resource
     FOR UPDATE;
    IF v_row_id IS NULL THEN
      INSERT INTO ytw_private.api_token_permissions (token_id, resource, level)
      VALUES (v_token.id, v_resource, v_level);
      v_old := 'none';
    ELSIF v_old <> v_level THEN
      UPDATE ytw_private.api_token_permissions p SET level = v_level WHERE p.id = v_row_id;
    END IF;
    IF v_old <> v_level THEN
      v_changes := v_changes || jsonb_build_object('resource', v_resource, 'from', v_old, 'to', v_level);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_changes) > 0 THEN
    PERFORM public.ytw_log_event(
      p_actor, p_actor_type, p_token_id, 'token.permissions_changed', 'api_token', v_token.id,
      jsonb_build_object('token_name', v_token.name, 'owner', v_owner.username, 'changes', v_changes));
  END IF;
  RETURN public.ytw_api_token_info_of(v_token.id);
END
$$;

COMMENT ON FUNCTION public.update_token_permissions(text, text, uuid, uuid, uuid, jsonb) IS
  'Change the levels of one of the acting person''s tokens (only the objects named). Checked against the owner''s current level again.';

-- Replaces the secret of one of the acting person's tokens: the new hash and prefix take over and the
-- OLD SECRET STOPS WORKING IMMEDIATELY. Id, name, owner and levels stay; last use starts over. The
-- expiry stays unless p_set_expiry is true, in which case p_expires_at (NULL = never) replaces it; an
-- expired token must be given a new expiry or the new secret would be dead on arrival.
CREATE FUNCTION public.rotate_api_token(
  p_actor text,
  p_actor_type text,
  p_token_id uuid,
  p_acting_user_id uuid,
  p_api_token_id uuid,
  p_new_token_prefix text,
  p_new_token_hash text,
  p_set_expiry boolean DEFAULT false,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS public.ytw_api_token_info
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_owner public.users;
  v_token ytw_private.api_tokens;
  v_now timestamptz := statement_timestamp();
  v_expires_at timestamptz;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  v_owner := public.ytw_acting_user(p_actor, p_actor_type, p_acting_user_id, 'rotate API tokens', false);
  v_token := public.ytw_lock_own_token(p_api_token_id, v_owner.id);
  IF v_token.revoked_at IS NOT NULL THEN
    PERFORM public.ytw_raise(
      'invalid_transition',
      format('token %s was revoked and cannot be rotated: create a new token', to_json(v_token.name)),
      jsonb_build_object('entity', 'api_token', 'id', v_token.id, 'from', 'revoked'));
  END IF;

  IF coalesce(p_set_expiry, false) THEN
    IF p_expires_at IS NOT NULL AND p_expires_at <= v_now THEN
      PERFORM public.ytw_raise(
        'validation',
        'expires_at must lie in the future (or be empty for a token that never expires)',
        jsonb_build_object('field', 'expires_at'));
    END IF;
    v_expires_at := p_expires_at;
  ELSE
    v_expires_at := v_token.expires_at;
    IF v_expires_at IS NOT NULL AND v_expires_at <= v_now THEN
      PERFORM public.ytw_raise(
        'validation',
        format('token %s expired on %s: rotate it with a new expiry (or none for a token that never expires), or create a new token',
               to_json(v_token.name), to_char(v_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
        jsonb_build_object('field', 'expires_at', 'expired_at', v_expires_at));
    END IF;
  END IF;
  PERFORM public.ytw_check_token_secret(p_new_token_prefix, p_new_token_hash);

  UPDATE ytw_private.api_tokens t
     SET token_prefix = p_new_token_prefix, token_hash = p_new_token_hash,
         expires_at = v_expires_at, last_used_at = NULL
   WHERE t.id = v_token.id;

  PERFORM public.ytw_log_event(
    p_actor, p_actor_type, p_token_id, 'token.rotated', 'api_token', v_token.id,
    jsonb_build_object('token_name', v_token.name, 'owner', v_owner.username,
                       'expires_at', v_expires_at));
  RETURN public.ytw_api_token_info_of(v_token.id);
END
$$;

COMMENT ON FUNCTION public.rotate_api_token(text, text, uuid, uuid, uuid, text, text, boolean, timestamptz) IS
  'Replace the secret of one of the acting person''s tokens; the old secret stops working at once. Id, name and levels stay.';

-- Revokes one of the acting person's tokens; it stops working at once and stays listed. Revoking a
-- revoked token changes nothing (the first revocation time is kept).
CREATE FUNCTION public.revoke_api_token(
  p_actor text,
  p_actor_type text,
  p_token_id uuid,
  p_acting_user_id uuid,
  p_api_token_id uuid
)
RETURNS public.ytw_api_token_info
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_owner public.users;
  v_token ytw_private.api_tokens;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  v_owner := public.ytw_acting_user(p_actor, p_actor_type, p_acting_user_id, 'revoke API tokens', false);
  v_token := public.ytw_lock_own_token(p_api_token_id, v_owner.id);

  IF v_token.revoked_at IS NULL THEN
    UPDATE ytw_private.api_tokens t SET revoked_at = statement_timestamp() WHERE t.id = v_token.id;
    PERFORM public.ytw_log_event(
      p_actor, p_actor_type, p_token_id, 'token.revoked', 'api_token', v_token.id,
      jsonb_build_object('token_name', v_token.name, 'owner', v_owner.username));
  END IF;
  RETURN public.ytw_api_token_info_of(v_token.id);
END
$$;

COMMENT ON FUNCTION public.revoke_api_token(text, text, uuid, uuid, uuid) IS
  'Revoke one of the acting person''s tokens; it stops working at once and stays listed.';

-- Records that a token was just used. Called by the service that authenticated the token, as that
-- token (actor = its name, type agent, token id = its id): only the last_used_at column changes, so
-- the audit trigger writes nothing and `updated_at` stays (no event spam). Revoked and expired
-- tokens are left alone, and so is a token whose name is not the actor's. Returns whether a token
-- was updated.
CREATE FUNCTION public.touch_token_last_used(p_actor text, p_actor_type text, p_token_id uuid)
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

  -- Only as the token itself (its id and its name), so a caller that merely knows a token id (ids
  -- appear in the readable audit log) cannot make an unused token look used.
  UPDATE ytw_private.api_tokens t
     SET last_used_at = greatest(coalesce(t.last_used_at, '-infinity'::timestamptz), v_now)
   WHERE t.id = p_token_id
     AND t.name = btrim(p_actor)
     AND t.revoked_at IS NULL
     AND (t.expires_at IS NULL OR t.expires_at > v_now);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END
$$;

COMMENT ON FUNCTION public.touch_token_last_used(text, text, uuid) IS
  'Record a use of a token (last_used_at only, not audited). Called as the token: actor = its name, type agent, token id = its id.';

-- The authentication lookup: finds a token by the SHA-256 of its secret and returns everything the
-- caller needs to build the @ytw/policy TokenPrincipal, with the owner's levels read in the same
-- statement (never cached, so lowering a user lowers their tokens at once). No row = unknown token.
-- `status` tells the failure modes apart: 'active', 'revoked' (wins over expired) or 'expired'.
--   token_levels      the token's own stored level per object
--   owner_levels      the owner's EFFECTIVE level per object (admins: the maximum everywhere), to be
--                     used with owner_is_admin as the TokenOwner of @ytw/policy
--   effective_levels  what the token may do now: the lower of the two per object; all none unless
--                     the token is active, so a caller that forgets to look at `status` still gets no access
CREATE FUNCTION public.lookup_token_by_hash(p_token_hash text)
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
         public.ytw_token_status(t.revoked_at, t.expires_at),
         t.created_at, t.expires_at, t.revoked_at, t.last_used_at,
         u.id, u.username, u.is_admin,
         tl.levels, ul.levels,
         CASE WHEN public.ytw_token_status(t.revoked_at, t.expires_at) = 'active'
              THEN public.ytw_effective_levels(tl.levels, ul.levels)
              ELSE public.ytw_effective_levels('{}'::jsonb, '{}'::jsonb) END
  FROM ytw_private.api_tokens t
  JOIN public.users u ON u.id = t.user_id
  CROSS JOIN LATERAL (SELECT public.ytw_token_own_levels(t.id) AS levels) tl
  CROSS JOIN LATERAL (SELECT public.ytw_user_effective_levels(u.id) AS levels) ul
  WHERE t.token_hash = p_token_hash;
END
$$;

COMMENT ON FUNCTION public.lookup_token_by_hash(text) IS
  'Authenticate: the token with this SHA-256 hash, its owner and both level sets, with status active, revoked or expired. No row = unknown.';

-- The acting person's own tokens, newest first, revoked ones included (status tells them apart).
CREATE FUNCTION public.list_api_tokens(p_owner_user_id uuid)
RETURNS SETOF public.ytw_api_token_info
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT i.*
  FROM ytw_private.api_tokens t
  CROSS JOIN LATERAL public.ytw_api_token_info_of(t.id) i
  WHERE t.user_id = p_owner_user_id
  ORDER BY t.created_at DESC, t.id DESC
$$;

COMMENT ON FUNCTION public.list_api_tokens(uuid) IS
  'The tokens of one owner, newest first, with their own and effective levels, last use and expiry. Never returns hashes.';

-- One of the owner's tokens, for the phone screen of a single token. No row when the token does not
-- exist or belongs to someone else.
CREATE FUNCTION public.get_api_token(p_owner_user_id uuid, p_api_token_id uuid)
RETURNS SETOF public.ytw_api_token_info
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT i.*
  FROM ytw_private.api_tokens t
  CROSS JOIN LATERAL public.ytw_api_token_info_of(t.id) i
  WHERE t.id = p_api_token_id AND t.user_id = p_owner_user_id
$$;

COMMENT ON FUNCTION public.get_api_token(uuid, uuid) IS
  'One token of one owner with its levels, last use and expiry; no row when it is not theirs.';

-- Helpers: nothing outside the SECURITY DEFINER functions above calls them.
REVOKE ALL ON FUNCTION public.ytw_token_status(timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_api_token_info_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_check_token_secret(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_lock_own_token(uuid, uuid) FROM PUBLIC;

-- Settings (web server): the acting person's own tokens.
REVOKE ALL ON FUNCTION public.create_api_token(text, text, uuid, uuid, text, text, text, timestamptz, jsonb)
  FROM PUBLIC;

REVOKE ALL ON FUNCTION public.update_token_permissions(text, text, uuid, uuid, uuid, jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.rotate_api_token(text, text, uuid, uuid, uuid, text, text, boolean, timestamptz)
  FROM PUBLIC;

REVOKE ALL ON FUNCTION public.revoke_api_token(text, text, uuid, uuid, uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.list_api_tokens(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.get_api_token(uuid, uuid) FROM PUBLIC;


-- Token authentication: the MCP server (and the web server, should it ever authenticate a token).
REVOKE ALL ON FUNCTION public.lookup_token_by_hash(text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.touch_token_last_used(text, text, uuid) FROM PUBLIC;
