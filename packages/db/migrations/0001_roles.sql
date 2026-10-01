-- 0001_roles: the fixed application roles and the privileges every later migration builds on
-- (PRD 5 "Database roles", PRD 9 "Security"). Conventions: docs/database.md.
--
-- Roles are cluster-wide while this file runs once per database, so everything here is idempotent:
-- a second database in the same cluster finds the roles already present and only re-applies the
-- settings. Passwords are never written here; the migration runner sets them from the environment.

-- 1. The three login roles. Least privilege by construction: no superuser, no role or database
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

-- 2. Roles that already existed (created by a DBA, or by an older deployment) must be just as
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

-- 3. The read-only role behind the MCP query_sql tool. These are session defaults applied at login;
--    a session can still change them, so query_sql must also run every statement inside
--    BEGIN READ ONLY ... ROLLBACK with SET LOCAL statement_timeout (see docs/database.md). The real
--    guarantee is that ytw_readonly holds no write privilege at all. Written only when missing, so
--    migrating more databases of the same cluster does not touch shared catalog rows again.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting s
    JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
    WHERE r.rolname = 'ytw_readonly'
      AND s.setdatabase = 0
      AND s.setconfig @> ARRAY['default_transaction_read_only=on', 'statement_timeout=10s']
  ) THEN
    ALTER ROLE ytw_readonly SET default_transaction_read_only = on;
    ALTER ROLE ytw_readonly SET statement_timeout = '10s';
  END IF;
END
$$;

-- 4. Database: only the application roles may connect, and nobody but the owner may create
--    schemas or temporary tables. No temporary tables also closes the pg_temp search_path hijack of
--    SECURITY DEFINER functions (the functions pin pg_temp last as well).
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ytw_web, ytw_mcp, ytw_readonly', current_database());
END
$$;

-- 5. Schemas. `public` holds the business tables, views and functions; the application roles may
--    look in it but never create objects. `ytw_private` holds secret-bearing tables (api_tokens,
--    web_sessions): no application role gets USAGE on it, so the only way in is a SECURITY DEFINER
--    function. This is what keeps token hashes and session blobs away from query_sql.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ytw_web, ytw_mcp, ytw_readonly;

CREATE SCHEMA IF NOT EXISTS ytw_private;
REVOKE ALL ON SCHEMA ytw_private FROM PUBLIC;
COMMENT ON SCHEMA ytw_private IS
  'Secret-bearing tables (api_tokens, web_sessions). No application role may use this schema; access only through SECURITY DEFINER functions.';

-- 6. Default privileges for everything the migration role creates from now on in this database:
--    Postgres grants EXECUTE on new functions to PUBLIC unless told otherwise. Tables, views and
--    sequences already default to owner-only, so every grant to an application role is explicit.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 7. The migration runner creates schema_migrations before the first file; /readyz on both services
--    reads it to check that the schema is current.
GRANT SELECT ON TABLE schema_migrations TO ytw_web, ytw_mcp;
