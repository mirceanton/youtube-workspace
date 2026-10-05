-- 0011_users_permissions: app users linked to their OIDC identity and their access level per object
-- (PRD 4 "users", "user_permissions"; PRD 7 "Access model"). Writes arrive with T14's functions.
--
-- The resource and level lists mirror RESOURCES, LEVELS and GRANTABLE_LEVELS of @ytw/shared;
-- packages/db/test/schema.test.ts fails when they drift. Adding an object type: docs/policy.md.

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  oidc_issuer text NOT NULL
    CONSTRAINT users_oidc_issuer_check
    CHECK (char_length(oidc_issuer) BETWEEN 1 AND 2048 AND oidc_issuer !~ '[[:space:][:cntrl:]]'),
  -- OIDC Core: "sub" is at most 255 ASCII characters and case-sensitive.
  oidc_sub text NOT NULL
    CONSTRAINT users_oidc_sub_check
    CHECK (char_length(oidc_sub) BETWEEN 1 AND 255 AND oidc_sub !~ '[[:cntrl:]]'),
  -- preferred_username: the audit actor for this person, so the same rules as ytw_set_actor().
  username text NOT NULL
    CONSTRAINT users_username_check
    CHECK (char_length(username) BETWEEN 1 AND 200 AND username = btrim(username)
           AND username !~ '[[:cntrl:]]'),
  email text
    CONSTRAINT users_email_check
    CHECK (char_length(email) BETWEEN 3 AND 320 AND email !~ '[[:space:][:cntrl:]]'),
  display_name text
    CONSTRAINT users_display_name_check
    CHECK (char_length(display_name) <= 200 AND display_name !~ '[[:cntrl:]]'),
  is_admin boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  CONSTRAINT users_oidc_identity_key UNIQUE (oidc_issuer, oidc_sub)
);

COMMENT ON TABLE public.users IS
  'App users, created on first login and linked to their OIDC identity (issuer + sub). PRD 7.';
COMMENT ON COLUMN public.users.username IS 'preferred_username; the audit actor for this person.';
COMMENT ON COLUMN public.users.is_admin IS
  'Admins have Write on everything (activity: Read) and manage other users'' access.';

-- One row per user and object. Levels: none < read < write (write includes read). The activity
-- log is read-only: no row may grant write on it. Admins hold full access whatever is stored
-- here (@ytw/policy); T14 stores matching rows for them.
CREATE TABLE public.user_permissions (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  resource text NOT NULL
    CONSTRAINT user_permissions_resource_check
    CHECK (resource IN ('ideas', 'scripts', 'experiments', 'videos', 'notes', 'activity')),
  level text NOT NULL
    CONSTRAINT user_permissions_level_check
    CHECK (level IN ('none', 'read', 'write')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  -- Objects whose maximum level is read (GRANTABLE_LEVELS without "write").
  CONSTRAINT user_permissions_read_only_check
    CHECK (level <> 'write' OR resource NOT IN ('activity')),
  CONSTRAINT user_permissions_user_resource_key UNIQUE (user_id, resource)
);

COMMENT ON TABLE public.user_permissions IS
  'Access level (none, read, write) per user and object; activity is none or read. PRD 7.';

CREATE TRIGGER users_touch
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch();
CREATE TRIGGER users_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('user', 'email', 'oidc_sub', '-updated_by');

CREATE TRIGGER user_permissions_touch
  BEFORE UPDATE ON public.user_permissions
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch();
CREATE TRIGGER user_permissions_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.user_permissions
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('user_permission', '-updated_by');

-- Only the web server reads identities and the access matrix (sign-in, /api/me, settings). The MCP
-- server gets a token's owner and levels from T14's SECURITY DEFINER lookup, and ytw_readonly
-- (query_sql) gets neither: access data is not one of the objects a Read level covers, and the
-- access matrix is admin-only in the web UI (PRD 7).
