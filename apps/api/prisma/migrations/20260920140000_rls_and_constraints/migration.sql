-- Tenant isolation (layer 3) and the integrity constraints Prisma cannot express.
--
-- Layers 1 and 2 (derived tenant identity, repository signatures) live in
-- application code. This migration is the backstop that holds when application
-- code is wrong: PostgreSQL itself refuses to return another tenant's rows,
-- regardless of what the ORM asked for.
--
-- See ARCHITECTURE.md §4 and docs/database-schema.md.

-- ---------------------------------------------------------------------------
-- Check constraints
-- ---------------------------------------------------------------------------

-- Purity must be a sane fraction. Prevents a 1001/1000 product existing at all.
ALTER TABLE "products"
  ADD CONSTRAINT "chk_products_purity_positive"
  CHECK ("purity_num" > 0 AND "purity_den" > 0 AND "purity_num" <= "purity_den");

-- A fat-fingered adjustment is rejected by the database, not discovered by a
-- customer. Mirrors MAX_ABSOLUTE_ADJUSTMENT / MAX_ADJUSTMENT_BPS in
-- src/modules/pricing/adjustment.ts.
ALTER TABLE "tenant_pricing_rules"
  ADD CONSTRAINT "chk_tenant_pricing_rules_bounds"
  CHECK (
    "adjustment_value" BETWEEN -10000000000 AND 10000000000
    AND "adjustment_bps" BETWEEN -10000 AND 10000
    AND "rounding_step_paise" > 0
  );

-- Market rates must be positive; a zero or negative tick is a bad feed, not a price.
ALTER TABLE "market_rates"
  ADD CONSTRAINT "chk_market_rates_positive"
  CHECK ("mid_per_gram" > 0);

ALTER TABLE "published_rates"
  ADD CONSTRAINT "chk_published_rates_positive"
  CHECK ("rate_display_paise" > 0);

-- The customer-facing breakdown must always add up. If base + adjustment ever
-- disagreed with the total, a customer would see arithmetic that does not work.
ALTER TABLE "published_rates"
  ADD CONSTRAINT "chk_published_rates_breakdown_balances"
  CHECK ("base_display_paise" + "adjustment_display_paise" = "rate_display_paise");

-- Public slug format, plus a reserved-word denylist so a tenant cannot claim a
-- routing path.
ALTER TABLE "customer_links"
  ADD CONSTRAINT "chk_customer_links_slug_format"
  CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{1,47}[a-z0-9]$');

ALTER TABLE "customer_links"
  ADD CONSTRAINT "chk_customer_links_slug_not_reserved"
  CHECK ("slug" NOT IN (
    'api', 'admin', 'health', 'auth', 'login', 'logout', 'dashboard',
    'static', 'assets', 'public', 'www', 'app', 'r', 'settings', 'help'
  ));

-- Slugs are unique among ACTIVE links only. Revoked slugs are retained so an
-- old shared link resolves to "this link was replaced" rather than silently
-- landing on a different shop.
CREATE UNIQUE INDEX "uq_customer_links_active_slug"
  ON "customer_links" ("slug") WHERE "is_active";

-- Exactly one live rule per product per tenant, so "which rule applied?" is
-- never ambiguous.
CREATE UNIQUE INDEX "uq_tenant_pricing_rules_active"
  ON "tenant_pricing_rules" ("tenant_id", "product_id") WHERE "is_active";

-- ---------------------------------------------------------------------------
-- Audit log is append-only
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
--
-- Every request runs inside a transaction opening with
--   SELECT set_config('app.current_tenant_id', $1, TRUE)
-- The TRUE scopes the setting to the transaction, so a pooled connection
-- cannot carry one tenant's context into the next request.
--
-- current_setting(..., TRUE) returns NULL rather than erroring when unset, and
-- `tenant_id = NULL` is never true — so a query with no tenant context returns
-- ZERO rows. Fail closed, not open.

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', TRUE), '')::UUID;
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  target_table TEXT;
  tenant_tables TEXT[] := ARRAY[
    'tenant_branding',
    'tenant_contacts',
    'tenant_users',
    'customer_links',
    'tenant_products',
    'tenant_pricing_rules',
    'published_rates',
    'rate_update_events',
    'audit_logs'
  ];
BEGIN
  FOREACH target_table IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target_table);

    -- FORCE is essential: without it the table OWNER bypasses its own policies,
    -- and the migration role is the owner.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target_table);

    -- USING filters reads; WITH CHECK blocks writes that would create a row
    -- under another tenant.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())',
      target_table
    );
  END LOOP;
END;
$$;

-- `tenants` is keyed by id rather than tenant_id, so it gets its own policy.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "tenants"
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Application role grants
-- ---------------------------------------------------------------------------
-- Tables created by this migration are owned by the migration role, so the
-- runtime role needs explicit grants. It gets DML only — never DDL, and never
-- BYPASSRLS.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bullion_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bullion_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bullion_app;
    -- Audit rows are immutable for the application too.
    REVOKE UPDATE, DELETE ON "audit_logs" FROM bullion_app;
  END IF;
END;
$$;
