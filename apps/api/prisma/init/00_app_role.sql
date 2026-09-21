-- Creates the application role used at runtime.
--
-- This role is deliberately NOT a superuser and NOT the owner of the tables.
-- PostgreSQL exempts superusers from row-level security entirely, and table
-- owners bypass their own policies unless FORCE ROW LEVEL SECURITY is set — so
-- connecting the application as either would silently disable every
-- tenant-isolation policy in the schema while appearing to work perfectly.
--
-- Migrations run as bullion_owner; the application connects as bullion_app.
--
-- ## Passwords and database name are parameters, not literals
--
--   psql -v app_password=... -v maintenance_password=... -f 00_app_role.sql
--
-- They default to the local development values only so the Docker entrypoint
-- can run this unattended on a fresh volume. Every other environment must pass
-- them. Hardcoding them here was a live defect in two directions: CI creates
-- these roles with one password and connects with another, so every test that
-- used the application role failed authentication; and `infra/README.md`
-- instructs an operator to run this same file against Azure, which would have
-- handed production a role whose password is the string "devpassword".
--
-- The database name is a parameter for the same reason — locally it is
-- `bullion`, in CI `bullion_test`, and the GRANT is silently skipped when the
-- name does not match.

\if :{?app_password}
\else
  \set app_password 'devpassword'
\endif

\if :{?maintenance_password}
\else
  \set maintenance_password 'devpassword'
\endif

\if :{?db_name}
\else
  \set db_name 'bullion'
\endif

-- Anything below that fails should stop the script rather than leave a
-- half-provisioned role behind that looks fine until first connection.
\set ON_ERROR_STOP on

CREATE ROLE bullion_app WITH LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;

GRANT CONNECT ON DATABASE :"db_name" TO bullion_app;
GRANT USAGE ON SCHEMA public TO bullion_app;

-- Rights on tables that already exist, plus anything migrations create later.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bullion_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bullion_app;

ALTER DEFAULT PRIVILEGES FOR ROLE bullion_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bullion_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bullion_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO bullion_app;

-- ---------------------------------------------------------------------------
-- Maintenance role
-- ---------------------------------------------------------------------------
-- Idempotency-key cleanup is inherently cross-tenant: it removes expired rows
-- for every tenant, and no tenant context makes "all tenants" a legal answer.
-- It therefore needs BYPASSRLS — but nothing else.
--
-- Relying on bullion_owner instead would be a trap: Docker creates
-- POSTGRES_USER as a SUPERUSER, so cleanup would appear to work locally, while
-- Azure PostgreSQL Flexible Server's administrator is NOT a superuser and the
-- identical code would match zero rows in production and report success.
--
-- Grants for this role are applied by migration 20260920210000, which limits
-- it to SELECT + DELETE on `idempotency_keys` alone. Even holding BYPASSRLS it
-- cannot read a single row of tenant data.

CREATE ROLE bullion_maintenance WITH LOGIN PASSWORD :'maintenance_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;

GRANT CONNECT ON DATABASE :"db_name" TO bullion_maintenance;
GRANT USAGE ON SCHEMA public TO bullion_maintenance;
