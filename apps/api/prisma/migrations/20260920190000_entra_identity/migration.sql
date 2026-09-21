-- Move user identity from Supabase to Microsoft Entra External ID.
--
-- ## Why the key changes shape
--
-- Supabase issued one stable `sub` per user. Entra issues **pairwise** subject
-- identifiers: `sub` is unique per (user, application) pair, so the same
-- shopkeeper signing in through a second app registration — a mobile app, an
-- admin portal — presents a different `sub` and would look like a new user.
--
-- `oid` (directory object id) is stable for that user across every application
-- in the directory. Microsoft's guidance is to use `tid` + `oid` together as
-- the immutable key, so that pair becomes the identity for `users`.
--
-- `tid` is stored rather than assumed: it pins each row to the directory that
-- issued it, so a future second directory (a staging tenant, a migration)
-- cannot silently collide with production identities.

-- ---------------------------------------------------------------------------
-- users: supabase_user_id → (external_directory_id, external_object_id)
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS "uq_users_supabase_user_id";

ALTER TABLE "users" RENAME COLUMN "supabase_user_id" TO "external_object_id";

-- Nullable first so existing development rows survive the rename, then
-- backfilled and constrained. There is no production data to migrate.
ALTER TABLE "users" ADD COLUMN "external_directory_id" UUID;

UPDATE "users"
   SET "external_directory_id" = '00000000-0000-0000-0000-000000000000'
 WHERE "external_directory_id" IS NULL;

ALTER TABLE "users" ALTER COLUMN "external_directory_id" SET NOT NULL;

-- The composite identity. Unique on the pair, not on `oid` alone: the same
-- object id could in principle exist in two directories.
CREATE UNIQUE INDEX "uq_users_external_identity"
  ON "users" ("external_directory_id", "external_object_id");

-- ---------------------------------------------------------------------------
-- Resolvers now take (oid, tid)
-- ---------------------------------------------------------------------------
-- Same narrow contract as before: they accept an identity and nothing else.
-- There is still no parameter through which a caller could nominate one of our
-- tenants, so neither can be used to obtain a context for someone else's shop.
--
-- `search_path` stays pinned — without it a SECURITY DEFINER function can be
-- hijacked by a caller-controlled search_path resolving `tenant_users` to an
-- attacker's table.

DROP FUNCTION IF EXISTS resolve_tenant_membership(UUID);
DROP FUNCTION IF EXISTS resolve_principal_identity(UUID);

CREATE OR REPLACE FUNCTION resolve_tenant_membership(
  p_external_object_id    UUID,
  p_external_directory_id UUID
)
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
   WHERE u.external_object_id    = p_external_object_id
     AND u.external_directory_id = p_external_directory_id
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION resolve_principal_identity(
  p_external_object_id    UUID,
  p_external_directory_id UUID
)
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
  WHERE u.external_object_id    = p_external_object_id
    AND u.external_directory_id = p_external_directory_id
  LIMIT 1;
$$;

-- SECURITY DEFINER functions are granted to PUBLIC by default, which would let
-- any role resolve any principal. Revoke first, then grant narrowly.
REVOKE ALL ON FUNCTION resolve_tenant_membership(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_principal_identity(UUID, UUID) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bullion_app') THEN
    GRANT EXECUTE ON FUNCTION resolve_tenant_membership(UUID, UUID) TO bullion_app;
    GRANT EXECUTE ON FUNCTION resolve_principal_identity(UUID, UUID) TO bullion_app;
  END IF;
END;
$$;
