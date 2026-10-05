-- 0001_roles: owner-only baseline
--
-- The deployment owns PostgreSQL users and passes its chosen DATABASE_URL to every
-- process. The application never creates, alters, or grants database roles.

ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS ytw_private;
REVOKE ALL ON SCHEMA ytw_private FROM PUBLIC;

COMMENT ON SCHEMA ytw_private IS
  'Secret-bearing tables used only through application database functions.';
