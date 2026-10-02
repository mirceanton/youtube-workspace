-- 0012_api_tokens: API tokens for agents and their level per object (PRD 4 "api_tokens",
-- "api_token_permissions"; PRD 7 "API tokens"). Both tables live in ytw_private: no application
-- role can read them, so token hashes (and who holds which token) are reachable only through T14's
-- SECURITY DEFINER functions, never through query_sql.
--
-- Tokens are never deleted (revoked_at), so events.token_id keeps pointing at a real token.

CREATE TABLE ytw_private.api_tokens (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  -- The owner. A token's effective level is the lower of its own and the owner's current level.
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  -- The audit actor for the token's calls, so the same rules as ytw_set_actor().
  name text NOT NULL
    CONSTRAINT api_tokens_name_check
    CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  -- The first characters of the secret, shown in settings to tell tokens apart.
  token_prefix text NOT NULL
    CONSTRAINT api_tokens_token_prefix_check
    CHECK (token_prefix ~ '^[A-Za-z0-9_-]{4,16}$'),
  -- SHA-256 of the whole secret as 64 lower-case hex digits. The format check also makes it
  -- impossible to store a plain-text secret here by mistake.
  token_hash text NOT NULL
    CONSTRAINT api_tokens_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  CONSTRAINT api_tokens_token_hash_key UNIQUE (token_hash)
);

COMMENT ON TABLE ytw_private.api_tokens IS
  'API tokens (PRD 7): stored as SHA-256 hash + prefix only. expires_at NULL = never; revoked tokens stay for the audit trail.';
COMMENT ON COLUMN ytw_private.api_tokens.token_hash IS
  'SHA-256 of the full secret, 64 lower-case hex digits. The secret itself is never stored.';

CREATE INDEX api_tokens_user_idx ON ytw_private.api_tokens (user_id, created_at);

CREATE TABLE ytw_private.api_token_permissions (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  token_id uuid NOT NULL REFERENCES ytw_private.api_tokens (id) ON DELETE RESTRICT,
  resource text NOT NULL
    CONSTRAINT api_token_permissions_resource_check
    CHECK (resource IN ('ideas', 'scripts', 'experiments', 'videos', 'notes', 'activity')),
  level text NOT NULL
    CONSTRAINT api_token_permissions_level_check
    CHECK (level IN ('none', 'read', 'write')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  CONSTRAINT api_token_permissions_read_only_check
    CHECK (level <> 'write' OR resource NOT IN ('activity')),
  CONSTRAINT api_token_permissions_token_resource_key UNIQUE (token_id, resource)
);

COMMENT ON TABLE ytw_private.api_token_permissions IS
  'A token''s own level per object; never above its owner''s (enforced by T14''s functions).';

CREATE TRIGGER api_tokens_touch
  BEFORE UPDATE ON ytw_private.api_tokens
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch();
-- token_hash would be redacted by its name anyway; listed so the intent is explicit. Tables in
-- ytw_private are audited default-deny: only +id (the entity id) is recorded with its value.
CREATE TRIGGER api_tokens_audit
  AFTER INSERT OR UPDATE OR DELETE ON ytw_private.api_tokens
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('api_token', 'token_hash', '-updated_by', '+id');

CREATE TRIGGER api_token_permissions_touch
  BEFORE UPDATE ON ytw_private.api_token_permissions
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch();
CREATE TRIGGER api_token_permissions_audit
  AFTER INSERT OR UPDATE OR DELETE ON ytw_private.api_token_permissions
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('api_token_permission', '-updated_by', '+id');

-- No grants: ytw_private is reachable only through SECURITY DEFINER functions (T14).
