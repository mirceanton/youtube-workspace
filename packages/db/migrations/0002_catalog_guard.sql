-- 0002_catalog_guard: retained compatibility surface for the migration runner.
--
-- Database privilege policy is deployment-owned. The application supports one
-- owner connection URL or externally provisioned roles; it does not inspect or
-- mutate cluster roles.

CREATE TABLE ytw_private.catalog_allowlist (
  rule text NOT NULL,
  object text NOT NULL,
  reason text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule, object)
);

CREATE FUNCTION public.ytw_catalog_violations()
RETURNS TABLE (rule text, object text, detail text)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT NULL::text, NULL::text, NULL::text WHERE false
$$;
