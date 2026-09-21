-- Principal → identity resolver.
--
-- One trusted resolution point for everything the context layer needs about a
-- verified principal: whether they are a platform admin, and which tenant (if
-- any) they belong to with what role.
--
-- Extends the same pattern as 20260920170000_context_resolvers, for the same
-- reason: `tenant_users` is RLS-protected and this lookup runs before any
-- tenant context exists.
--
-- The contract is deliberately narrow — it takes a principal id and nothing
-- else. There is no parameter through which a caller could nominate a tenant,
-- so this function cannot be used to obtain a context for someone else's
-- tenant no matter how it is called.
--
-- A LEFT JOIN is used so the function distinguishes three outcomes that the
-- caller must treat differently:
--   * no row            → the principal is unknown to us
--   * row, tenant NULL  → a known user with no tenant membership
--   * row, tenant set   → a member, with role and tenant status

CREATE OR REPLACE FUNCTION resolve_principal_identity(p_supabase_user_id UUID)
RETURNS TABLE (
  user_id           UUID,
  is_platform_admin BOOLEAN,
  tenant_id         UUID,
  member_role       tenant_role,
  tenant_status     tenant_status
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    u.id,
    (pa.user_id IS NOT NULL) AS is_platform_admin,
    tu.tenant_id,
    tu.role,
    t.status
  FROM users u
  LEFT JOIN platform_admins pa ON pa.user_id = u.id
  LEFT JOIN tenant_users    tu ON tu.user_id = u.id
  LEFT JOIN tenants         t  ON t.id = tu.tenant_id
  WHERE u.supabase_user_id = p_supabase_user_id
  LIMIT 1;
$$;

-- SECURITY DEFINER functions are granted to PUBLIC by default, which would let
-- any role resolve any principal. Revoke first, then grant narrowly.
REVOKE ALL ON FUNCTION resolve_principal_identity(UUID) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bullion_app') THEN
    GRANT EXECUTE ON FUNCTION resolve_principal_identity(UUID) TO bullion_app;
  END IF;
END;
$$;
