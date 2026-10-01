-- 0002_catalog_guard: the privilege invariants of PRD 5 and PRD 9, written as one query over the
-- system catalogs. The migration runner calls ytw_catalog_violations() at the end of every
-- migration file, inside that file's transaction, and rolls the file back if any row comes back.
-- So no migration can ever be applied that, for example, grants INSERT to an application role.
-- The catalog tests (packages/db/test/catalog.test.ts) call it too. Rules: docs/database.md.

CREATE FUNCTION public.ytw_catalog_violations()
RETURNS TABLE (rule text, object text, detail text)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH app_roles AS (
    SELECT oid, rolname
    FROM pg_roles
    WHERE rolname IN ('ytw_web', 'ytw_mcp', 'ytw_readonly')
  ),
  user_schemas AS (
    SELECT oid, nspname, nspowner
    FROM pg_namespace
    WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
  ),
  rels AS (
    SELECT c.oid, c.relkind, c.relname, c.relowner, s.nspname,
           quote_ident(s.nspname) || '.' || quote_ident(c.relname) AS name
    FROM pg_class c
    JOIN user_schemas s ON s.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  ),
  funcs AS (
    SELECT p.oid, p.oid::regprocedure::text AS name, p.prosecdef, p.provolatile, p.proconfig,
           p.proacl, p.proowner
    FROM pg_proc p
    JOIN user_schemas s ON s.oid = p.pronamespace
    -- Functions that belong to an extension follow the extension's own rules.
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
    )
  ),
  write_privs (priv) AS (
    VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
  )

  -- Application roles are plain login roles.
  SELECT 'app_role_attributes', r.rolname,
         'must not be superuser or have CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS'
  FROM pg_roles r
  WHERE r.rolname IN ('ytw_web', 'ytw_mcp', 'ytw_readonly')
    AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)

  UNION ALL
  -- ... that inherit nothing (pg_read_all_data or pg_write_all_data would bypass every rule below).
  SELECT 'app_role_membership', r.rolname, 'is a member of ' || g.rolname
  FROM pg_auth_members m
  JOIN app_roles r ON r.oid = m.member
  JOIN pg_roles g ON g.oid = m.roleid

  UNION ALL
  -- ... and own nothing (an owner can grant itself anything).
  SELECT 'app_role_owns_object', x.name, 'is owned by ' || r.rolname
  FROM (
    SELECT name, relowner AS owner FROM rels
    UNION ALL SELECT name, proowner FROM funcs
    UNION ALL SELECT quote_ident(nspname), nspowner FROM user_schemas
    UNION ALL SELECT 'database ' || quote_ident(datname), datdba
              FROM pg_database WHERE datname = current_database()
  ) x
  JOIN app_roles r ON r.oid = x.owner

  UNION ALL
  -- No table-level INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on any table, view or
  -- materialized view (an updatable view would be a write path too).
  SELECT 'table_write_privilege', t.name, r.rolname || ' has ' || w.priv
  FROM rels t
  CROSS JOIN app_roles r
  CROSS JOIN write_privs w
  WHERE t.relkind <> 'S' AND has_table_privilege(r.oid, t.oid, w.priv)

  UNION ALL
  -- ... nor the column-level variants.
  SELECT 'table_write_privilege', t.name, r.rolname || ' has column-level ' || w.priv
  FROM rels t
  CROSS JOIN app_roles r
  CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) w (priv)
  WHERE t.relkind <> 'S'
    AND NOT has_table_privilege(r.oid, t.oid, w.priv)
    AND has_any_column_privilege(r.oid, t.oid, w.priv)

  UNION ALL
  -- nextval()/setval() are writes as well.
  SELECT 'sequence_privilege', t.name, r.rolname || ' has ' || w.priv
  FROM rels t
  CROSS JOIN app_roles r
  CROSS JOIN (VALUES ('USAGE'), ('UPDATE')) w (priv)
  WHERE t.relkind = 'S' AND has_sequence_privilege(r.oid, t.oid, w.priv)

  UNION ALL
  -- No schemas, no temporary tables (temporary tables would also let a caller shadow tables that a
  -- SECURITY DEFINER function refers to).
  SELECT 'database_privilege', quote_ident(current_database()), r.rolname || ' has ' || w.priv
  FROM app_roles r
  CROSS JOIN (VALUES ('CREATE'), ('TEMPORARY')) w (priv)
  WHERE has_database_privilege(r.oid, current_database(), w.priv)

  UNION ALL
  SELECT 'schema_create', quote_ident(s.nspname), r.rolname || ' has CREATE'
  FROM user_schemas s
  CROSS JOIN app_roles r
  WHERE has_schema_privilege(r.oid, s.oid, 'CREATE')

  UNION ALL
  -- ytw_private is reachable only through SECURITY DEFINER functions.
  SELECT 'private_schema_access', quote_ident(s.nspname), r.rolname || ' has USAGE'
  FROM user_schemas s
  CROSS JOIN app_roles r
  WHERE s.nspname = 'ytw_private' AND has_schema_privilege(r.oid, s.oid, 'USAGE')

  UNION ALL
  SELECT 'private_schema_access', t.name, r.rolname || ' has SELECT'
  FROM rels t
  CROSS JOIN app_roles r
  WHERE t.nspname = 'ytw_private' AND has_any_column_privilege(r.oid, t.oid, 'SELECT')

  UNION ALL
  -- The secret-bearing tables named by PRD 7 / PLAN.md must live in ytw_private.
  SELECT 'secret_table_location', t.name, 'secret-bearing tables belong in schema ytw_private'
  FROM rels t
  WHERE t.relname IN ('api_tokens', 'web_sessions') AND t.nspname <> 'ytw_private'

  UNION ALL
  -- Every function is granted explicitly; none is executable by PUBLIC (a NULL ACL means the
  -- built-in default, which includes PUBLIC).
  SELECT 'function_public_execute', f.name, 'EXECUTE is granted to PUBLIC'
  FROM funcs f
  WHERE f.proacl IS NULL
     OR EXISTS (
       SELECT 1 FROM aclexplode(f.proacl) a
       WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
     )

  UNION ALL
  -- SECURITY DEFINER functions pin the search path, with pg_temp last.
  SELECT 'definer_search_path', f.name,
         'SECURITY DEFINER functions must SET search_path = pg_catalog, public, pg_temp'
  FROM funcs f
  WHERE f.prosecdef
    AND NOT coalesce(f.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp'], false)

  UNION ALL
  -- query_sql runs as ytw_readonly: it may call read functions, never a writing one.
  SELECT 'readonly_volatile_definer', f.name,
         'ytw_readonly may execute only STABLE or IMMUTABLE SECURITY DEFINER functions'
  FROM funcs f
  JOIN app_roles r ON r.rolname = 'ytw_readonly'
  WHERE f.prosecdef AND f.provolatile = 'v' AND has_function_privilege(r.oid, f.oid, 'EXECUTE')
$$;

COMMENT ON FUNCTION public.ytw_catalog_violations() IS
  'Privilege invariants (docs/database.md). Must return no rows; the migration runner enforces it after every file.';
