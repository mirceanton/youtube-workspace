-- 0002_catalog_guard: the privilege invariants of PRD 5 and PRD 9, written as one query over the
-- system catalogs. The migration runner calls ytw_catalog_violations() before applying anything and
-- at the end of every migration file, inside that file's transaction, and rolls the file back if any
-- row comes back. Each time it also checks that the guard still reports a set of canary objects, so
-- the guard cannot be dropped or emptied unnoticed. The catalog tests call it too.
-- Rules and how to extend them: docs/database.md.

-- Reviewed exceptions to two rules. Only migrations add rows (no application role can see this
-- schema), each with a reason; `object` is spelled exactly as ytw_catalog_violations() reports it.
CREATE TABLE ytw_private.catalog_allowlist (
  rule text NOT NULL CHECK (rule IN ('private_data_exposure', 'readonly_function_execute')),
  object text NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 10),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule, object)
);

COMMENT ON TABLE ytw_private.catalog_allowlist IS
  'Reviewed exceptions to the private_data_exposure and readonly_function_execute guard rules.';

CREATE FUNCTION public.ytw_catalog_violations()
RETURNS TABLE (rule text, object text, detail text)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH RECURSIVE app_roles AS (
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
    SELECT p.oid,
           quote_ident(s.nspname) || '.' || quote_ident(p.proname)
             || '(' || oidvectortypes(p.proargtypes) || ')' AS name,
           p.prosecdef, p.proconfig, p.proacl, p.proowner
    FROM pg_proc p
    JOIN user_schemas s ON s.oid = p.pronamespace
    -- Functions that belong to an extension follow the extension's own rules.
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
    )
  ),
  allowlist AS (
    SELECT a.rule, a.object FROM ytw_private.catalog_allowlist a
  ),
  -- The role that runs the migrations: it created schema_migrations.
  migration_owner AS (
    SELECT c.relowner AS oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'schema_migrations'
  ),
  -- Views and materialized views that read a ytw_private relation, directly or through other views.
  exposing (oid) AS (
    SELECT r.ev_class
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class c ON c.oid = d.refobjid
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'ytw_private'
    WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
    UNION
    SELECT r.ev_class
    FROM exposing e
    JOIN pg_depend d ON d.refobjid = e.oid
      AND d.refclassid = 'pg_class'::regclass AND d.classid = 'pg_rewrite'::regclass
    JOIN pg_rewrite r ON r.oid = d.objid
    WHERE r.ev_class <> e.oid
  ),
  role_settings AS (
    SELECT r.rolname, s.setdatabase, x.setting
    FROM pg_db_role_setting s
    JOIN app_roles r ON r.oid = s.setrole
    CROSS JOIN LATERAL unnest(s.setconfig) AS x (setting)
    WHERE s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
  ),
  expected_settings AS (
    SELECT e.role_name, e.setting FROM public.ytw_expected_role_settings() e
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
  -- Role-level settings are exactly ytw_expected_role_settings(): a role may change its own
  -- (ALTER ROLE ... SET), and settings stored for this database would override the role's.
  SELECT 'app_role_settings', s.rolname,
         CASE WHEN s.setdatabase <> 0 THEN 'has a setting for this database: '
              ELSE 'has an unexpected setting: ' END || s.setting
  FROM role_settings s
  WHERE s.setdatabase <> 0
     OR NOT EXISTS (
       SELECT 1 FROM expected_settings e WHERE e.role_name = s.rolname AND e.setting = s.setting
     )

  UNION ALL
  SELECT 'app_role_settings', e.role_name, 'is missing the setting ' || e.setting
  FROM expected_settings e
  JOIN app_roles r ON r.rolname = e.role_name
  WHERE NOT EXISTS (
    SELECT 1 FROM role_settings s
    WHERE s.rolname = e.role_name AND s.setdatabase = 0 AND s.setting = e.setting
  )

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
  -- ... and no view or materialized view hands their rows to an application role (a view runs
  -- with its owner's privileges, so schema USAGE does not protect them).
  SELECT 'private_data_exposure', t.name, r.rolname || ' can read ytw_private data through it'
  FROM rels t
  JOIN exposing x ON x.oid = t.oid
  CROSS JOIN app_roles r
  WHERE t.relkind IN ('v', 'm') AND t.nspname <> 'ytw_private'
    AND has_any_column_privilege(r.oid, t.oid, 'SELECT')
    AND NOT EXISTS (
      SELECT 1 FROM allowlist a WHERE a.rule = 'private_data_exposure' AND a.object = t.name
    )

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
  -- SECURITY DEFINER functions pin the search path, with pg_temp last ...
  SELECT 'definer_search_path', f.name,
         'SECURITY DEFINER functions must SET search_path = pg_catalog, public, pg_temp'
  FROM funcs f
  WHERE f.prosecdef
    AND NOT coalesce(f.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp'], false)

  UNION ALL
  -- ... and run as the role that runs the migrations, nobody else.
  SELECT 'definer_owner', f.name,
         'SECURITY DEFINER function owned by ' || pg_get_userbyid(f.proowner)
           || ', not by the migration owner ' || pg_get_userbyid(o.oid)
  FROM funcs f
  CROSS JOIN migration_owner o
  WHERE f.prosecdef AND f.proowner <> o.oid

  UNION ALL
  -- query_sql runs as ytw_readonly: never a SECURITY DEFINER function (it could read ytw_private
  -- or write), and any other function only when allowlisted.
  SELECT 'readonly_function_execute', f.name,
         CASE WHEN f.prosecdef THEN 'ytw_readonly must not execute SECURITY DEFINER functions'
              ELSE 'ytw_readonly may execute only functions listed in ytw_private.catalog_allowlist'
         END
  FROM funcs f
  JOIN app_roles r ON r.rolname = 'ytw_readonly'
  WHERE has_function_privilege(r.oid, f.oid, 'EXECUTE')
    AND (f.prosecdef OR NOT EXISTS (
      SELECT 1 FROM allowlist a WHERE a.rule = 'readonly_function_execute' AND a.object = f.name
    ))

  UNION ALL
  -- Large objects and advisory locks are out of reach of every application role (0001).
  SELECT 'builtin_function_access', b.fn::text, r.rolname || ' can execute it'
  FROM public.ytw_restricted_builtins() AS b (fn)
  CROSS JOIN app_roles r
  WHERE has_function_privilege(r.oid, b.fn, 'EXECUTE')
$$;

COMMENT ON FUNCTION public.ytw_catalog_violations() IS
  'Privilege invariants (docs/database.md). Must return no rows; the migration runner enforces it before and after every file.';
