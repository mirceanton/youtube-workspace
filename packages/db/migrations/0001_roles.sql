-- 0001_roles: the fixed application roles and the privileges every later migration builds on
-- (PRD 5 "Database roles", PRD 9 "Security"). Conventions: docs/database.md.
--
-- Roles are cluster-wide while this file runs once per database, so everything here is idempotent:
-- a second database in the same cluster finds the roles already present and only checks them.
-- Passwords are never written here; the migration runner sets them from the environment.

-- 1. Default privileges first, so that every function created from here on (in this file and in
--    every later one) starts without EXECUTE for PUBLIC and each grant to a role is explicit.
--    Tables, views and sequences already default to owner-only.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 2. The three login roles. Least privilege by construction: no superuser, no role or database
--    creation, no replication, no row-level-security bypass.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['ytw_web', 'ytw_mcp', 'ytw_readonly'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      BEGIN
        EXECUTE format(
          'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        -- Created at the same moment by a migration of another database in this cluster.
        NULL;
      END;
    END IF;
  END LOOP;
END
$$;

-- 3. Roles that already existed (created by a DBA, or by an older deployment) must be just as
--    restricted. Changing SUPERUSER and friends needs a superuser, so refuse instead of fixing.
DO $$
DECLARE
  bad text;
  r text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO bad
  FROM pg_catalog.pg_roles
  WHERE rolname IN ('ytw_web', 'ytw_mcp', 'ytw_readonly')
    AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'application roles must not be superuser or have CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS: %', bad
      USING HINT = 'Remove those attributes as a superuser (ALTER ROLE ... NOSUPERUSER ...) and run the migrations again.';
  END IF;

  SELECT string_agg(r.rolname || ' in ' || g.rolname, ', ' ORDER BY r.rolname, g.rolname) INTO bad
  FROM pg_catalog.pg_auth_members m
  JOIN pg_catalog.pg_roles r ON r.oid = m.member
  JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
  WHERE r.rolname IN ('ytw_web', 'ytw_mcp', 'ytw_readonly');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'application roles must not be members of other roles: %', bad
      USING HINT = 'Revoke those memberships (REVOKE <role> FROM <app role>) and run the migrations again.';
  END IF;

  -- A pre-existing NOLOGIN role is harmless to fix (needs only ADMIN on the role).
  FOR r IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname IN ('ytw_web', 'ytw_mcp', 'ytw_readonly') AND NOT rolcanlogin
  LOOP
    EXECUTE format('ALTER ROLE %I LOGIN', r);
  END LOOP;
END
$$;

-- 4. Role-level settings. ytw_readonly (the MCP query_sql role) starts every session read-only with
--    a 10 s statement timeout. Postgres lets any role change its own settings (ALTER ROLE ... SET)
--    and nothing can forbid that, so: the expected settings are data, ytw_enforce_role_settings()
--    puts them back (here, and from the migration runner before every run), the catalog guard
--    reports any drift, and the services pin the same settings on every connection they open
--    (client.ts), which overrides whatever is stored for the role.
CREATE FUNCTION public.ytw_expected_role_settings()
RETURNS TABLE (role_name text, setting text)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  VALUES ('ytw_readonly', 'default_transaction_read_only=on'),
         ('ytw_readonly', 'statement_timeout=10s')
$$;

COMMENT ON FUNCTION public.ytw_expected_role_settings() IS
  'Role-level settings the application roles must have (all others: none). Checked by ytw_catalog_violations().';

CREATE FUNCTION public.ytw_enforce_role_settings()
RETURNS SETOF text
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r record;
  v_db oid := (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database());
  v_expected text[];
  v_actual text[];
  v_setting text;
BEGIN
  FOR r IN
    SELECT oid, rolname FROM pg_catalog.pg_roles
    WHERE rolname IN ('ytw_web', 'ytw_mcp', 'ytw_readonly')
    ORDER BY rolname
  LOOP
    SELECT coalesce(array_agg(e.setting ORDER BY e.setting), '{}') INTO v_expected
    FROM public.ytw_expected_role_settings() e
    WHERE e.role_name = r.rolname;

    SELECT coalesce(array_agg(x.setting ORDER BY x.setting), '{}') INTO v_actual
    FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) AS x (setting)
    WHERE s.setrole = r.oid AND s.setdatabase = 0;

    -- Written only on drift, so migrating more databases of the cluster changes nothing shared.
    IF v_actual IS DISTINCT FROM v_expected THEN
      EXECUTE format('ALTER ROLE %I RESET ALL', r.rolname);
      FOREACH v_setting IN ARRAY v_expected LOOP
        EXECUTE format('ALTER ROLE %I SET %I = %L', r.rolname,
                       split_part(v_setting, '=', 1),
                       substr(v_setting, strpos(v_setting, '=') + 1));
      END LOOP;
      RETURN NEXT format('%s: role settings restored (they were %s)', r.rolname, v_actual);
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_db_role_setting s
      WHERE s.setrole = r.oid AND s.setdatabase = v_db
    ) THEN
      EXECUTE format('ALTER ROLE %I IN DATABASE %I RESET ALL', r.rolname, current_database());
      RETURN NEXT format('%s: settings for database %s removed', r.rolname, current_database());
    END IF;
  END LOOP;
END
$$;

COMMENT ON FUNCTION public.ytw_enforce_role_settings() IS
  'Restores the application roles'' settings to ytw_expected_role_settings(); returns what it changed.';

REVOKE ALL ON FUNCTION public.ytw_expected_role_settings() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ytw_enforce_role_settings() FROM PUBLIC;
SELECT count(*) FROM public.ytw_enforce_role_settings();

-- 5. Built-in functions the application roles must not call, because PUBLIC may execute them by
--    default: large objects (a way to store data outside every table and privilege) and advisory
--    locks (a role holding a lock key that a database function or the migration runner uses could
--    block them). SECURITY DEFINER functions still use advisory locks: they run as the owner.
--    Revoking from PUBLIC on pg_catalog functions needs a superuser; when the migrations run as a
--    non-superuser owner, superuser-bootstrap.sql must have done it already.
CREATE FUNCTION public.ytw_restricted_builtins()
RETURNS SETOF regprocedure
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p.oid::regprocedure
  FROM pg_catalog.pg_proc p
  WHERE p.pronamespace = 'pg_catalog'::regnamespace
    AND (p.proname ~ '^lo_' OR p.proname IN ('loread', 'lowrite')
         OR p.proname ~ '^pg_(try_)?advisory_')
$$;

COMMENT ON FUNCTION public.ytw_restricted_builtins() IS
  'pg_catalog functions no application role may execute (large objects, advisory locks).';

REVOKE ALL ON FUNCTION public.ytw_restricted_builtins() FROM PUBLIC;

DO $$
DECLARE
  f regprocedure;
  v_superuser boolean := (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user);
  v_open text[] := '{}';
BEGIN
  FOR f IN SELECT fn FROM public.ytw_restricted_builtins() AS fn LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = f
        AND (p.proacl IS NULL OR EXISTS (
          SELECT 1 FROM aclexplode(p.proacl) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
    ) THEN
      IF v_superuser THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
      ELSE
        v_open := v_open || f::text;
      END IF;
    END IF;
  END LOOP;
  IF cardinality(v_open) > 0 THEN
    RAISE EXCEPTION 'built-in functions the application roles must not call are executable by PUBLIC in this database: %',
      array_to_string(v_open, ', ')
      USING HINT = 'Only a superuser can revoke them: run packages/db/sql/superuser-bootstrap.sql once in this database as a superuser (docs/database.md, "Production setup"), then run the migrations again.';
  END IF;
END
$$;

-- 6. Database: only the application roles may connect, and nobody but the owner may create
--    schemas or temporary tables. No temporary tables also closes the pg_temp search_path hijack of
--    SECURITY DEFINER functions (the functions pin pg_temp last as well).
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ytw_web, ytw_mcp, ytw_readonly', current_database());
END
$$;

-- 7. Schemas. `public` holds the business tables, views and functions; the application roles may
--    look in it but never create objects. `ytw_private` holds secret-bearing tables (api_tokens,
--    web_sessions): no application role gets USAGE on it, so the only way in is a SECURITY DEFINER
--    function. This is what keeps token hashes and session blobs away from query_sql.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ytw_web, ytw_mcp, ytw_readonly;

CREATE SCHEMA IF NOT EXISTS ytw_private;
REVOKE ALL ON SCHEMA ytw_private FROM PUBLIC;
COMMENT ON SCHEMA ytw_private IS
  'Secret-bearing tables (api_tokens, web_sessions). No application role may use this schema; access only through SECURITY DEFINER functions.';

-- 8. The migration runner creates schema_migrations before the first file; /readyz on both services
--    reads it to check that the schema is current.
GRANT SELECT ON TABLE schema_migrations TO ytw_web, ytw_mcp;
