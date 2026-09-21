-- Tenant-context resolvers.
--
-- Chicken-and-egg: `tenant_users` and `customer_links` are RLS-protected, but
-- they are exactly the tables that must be read to discover WHICH tenant
-- context to establish. With no context set, RLS correctly returns zero rows,
-- so the application can never bootstrap.
--
-- Two bad ways out, both rejected:
--   * dropping RLS from those tables — they hold membership and public-link
--     data, and would then be readable across tenants;
--   * a policy that grants access when no context is set — that is a
--     fail-open rule, and every query without a context becomes a full scan.
--
-- Instead: two SECURITY DEFINER functions with a deliberately narrow contract.
-- They run as the owner (and so see through RLS) but return only the few
-- columns needed to build a context. They take a principal or a slug — never a
-- tenant_id — so they cannot be used to look up an arbitrary tenant.
--
-- `SET search_path` is pinned on both: without it, a SECURITY DEFINER function
-- can be hijacked by a caller-controlled search_path resolving `tenant_users`
-- to an attacker's table.

-- ---------------------------------------------------------------------------
-- Principal → tenant membership
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION resolve_tenant_membership(p_supabase_user_id UUID)
RETURNS TABLE (
  tenant_id     UUID,
  user_id       UUID,
  member_role   tenant_role,
  tenant_status tenant_status
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT tu.tenant_id, tu.user_id, tu.role, t.status
    FROM tenant_users tu
    JOIN users u   ON u.id = tu.user_id
    JOIN tenants t ON t.id = tu.tenant_id
   WHERE u.supabase_user_id = p_supabase_user_id
   LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- Public slug → tenant
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION resolve_public_link(p_slug TEXT)
RETURNS TABLE (
  tenant_id     UUID,
  slug          TEXT,
  is_active     BOOLEAN,
  tenant_status tenant_status
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT cl.tenant_id, cl.slug, cl.is_active, t.status
    FROM customer_links cl
    JOIN tenants t ON t.id = cl.tenant_id
   WHERE lower(cl.slug) = lower(p_slug)
   ORDER BY cl.is_active DESC, cl.created_at DESC
   LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- EXECUTE is revoked from PUBLIC first: a SECURITY DEFINER function is granted
-- to PUBLIC by default, which would let any role read across tenants.

REVOKE ALL ON FUNCTION resolve_tenant_membership(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_public_link(TEXT) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bullion_app') THEN
    GRANT EXECUTE ON FUNCTION resolve_tenant_membership(UUID) TO bullion_app;
    GRANT EXECUTE ON FUNCTION resolve_public_link(TEXT) TO bullion_app;
  END IF;
END;
$$;
