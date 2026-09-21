-- A least-privilege identity for idempotency-key cleanup.
--
-- ## Why a dedicated role is necessary
--
-- `idempotency_keys` is RLS-protected and FORCEd. Cleanup is inherently
-- cross-tenant: it removes expired rows for every tenant at once, and there is
-- no tenant context under which "all tenants" is a legal answer. With no
-- context set, RLS correctly returns zero rows.
--
-- Relying on the migration/admin role would be a trap. Locally, Docker creates
-- POSTGRES_USER as a SUPERUSER, and superusers bypass RLS entirely — so a
-- cleanup run as the admin appears to work in development. Azure PostgreSQL
-- Flexible Server's administrator is **not** a superuser, so the identical code
-- would match zero rows in production and report success while the table grew
-- without bound. A silent no-op is worse than a loud failure.
--
-- `bullion_maintenance` therefore holds `BYPASSRLS` explicitly, and is granted
-- access to exactly one table with exactly two verbs:
--
--   SELECT, DELETE ON idempotency_keys
--
-- It has no rights on tenants, pricing rules, audit logs, users or anything
-- else. Even holding BYPASSRLS it cannot read a single row of tenant data,
-- because the grants are not there to permit it. This is the whole privilege
-- surface of the maintenance path.
--
-- The application role `bullion_app` is untouched: it remains non-superuser,
-- non-owner, without BYPASSRLS, and fully subject to every policy.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bullion_maintenance') THEN
    -- NOLOGIN by default: a deployment attaches a password or, on Azure, a
    -- managed identity. A role that cannot log in cannot be misused if the
    -- grants below are ever widened by accident.
    CREATE ROLE bullion_maintenance WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO bullion_maintenance;

-- The entire privilege surface. Deliberately not INSERT or UPDATE: cleanup only
-- removes, and a stored response must stay immutable.
GRANT SELECT, DELETE ON "idempotency_keys" TO bullion_maintenance;

-- Explicitly withhold everything else, in case a future `GRANT ... ON ALL
-- TABLES` is run carelessly against this schema.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM bullion_maintenance;
GRANT SELECT, DELETE ON "idempotency_keys" TO bullion_maintenance;
