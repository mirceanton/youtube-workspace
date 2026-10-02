-- One-time setup a SUPERUSER runs in the application database when the migrations themselves run
-- as a role that is not a superuser (the recommended production setup: the database owner with
-- CREATEROLE). See docs/database.md, "Production setup". Idempotent; run it once per database,
-- before the first `pnpm migrate`:
--
--   psql "postgres://<superuser>@<host>/<database>" -f packages/db/sql/superuser-bootstrap.sql
--
-- Large-object and advisory-lock functions are executable by PUBLIC by default and only a superuser
-- can revoke that. The application roles must not use them (migration 0001 stops while PUBLIC still
-- can; the list must stay equal to ytw_restricted_builtins() in 0001). The database owner, which
-- runs the migrations, gets the advisory-lock functions back: the migration runner and the
-- SECURITY DEFINER functions it owns use them.
DO $$
DECLARE
  f regprocedure;
  v_owner name := (
    SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database
    WHERE datname = current_database()
  );
BEGIN
  IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'superuser-bootstrap.sql must be run by a superuser';
  END IF;
  FOR f IN
    SELECT p.oid::regprocedure
    FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'pg_catalog'::regnamespace
      AND (p.proname ~ '^lo_' OR p.proname IN ('loread', 'lowrite')
           OR p.proname ~ '^pg_(try_)?advisory_')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    IF f::text ~ '^pg_(try_)?advisory_' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, v_owner);
    END IF;
  END LOOP;
END
$$;
