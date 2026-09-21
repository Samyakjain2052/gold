-- Separate the three pricing precisions, and stop deriving the shopkeeper's
-- configured adjustment from the rounded total.
--
-- The previous shape stored only (base, adjustment, rate) and constrained
--     base + adjustment = rate
-- which forced the adjustment to absorb the final rounding: a configured ₹50/g
-- was stored and displayed as ₹500.07 per 10 g. The adjustment is an INPUT and
-- must be recorded exactly as configured.
--
-- See ADR-0005.

-- ---------------------------------------------------------------------------
-- published_rates: raw (storage precision) + display precision, kept distinct
-- ---------------------------------------------------------------------------

ALTER TABLE "published_rates"
  DROP COLUMN "rate_per_gram",
  -- Storage precision: milli-paise per gram, before display rounding.
  ADD COLUMN "raw_base_rate"     BIGINT NOT NULL,
  ADD COLUMN "raw_adjustment"    BIGINT NOT NULL,
  ADD COLUMN "raw_customer_rate" BIGINT NOT NULL,
  -- Display precision, recorded so a published rate can be re-derived exactly.
  ADD COLUMN "component_precision_paise" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "rounding_step_paise"       INTEGER NOT NULL DEFAULT 100,
  -- Residual between the quantised components and the quantised total.
  ADD COLUMN "rounding_delta_paise"      BIGINT  NOT NULL DEFAULT 0;

ALTER TABLE "tenant_pricing_rules"
  ADD COLUMN "component_precision_paise" INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- Corrected breakdown invariant
-- ---------------------------------------------------------------------------

-- The old invariant is wrong: it can only hold if the adjustment is allowed to
-- drift from what the shopkeeper configured.
ALTER TABLE "published_rates"
  DROP CONSTRAINT IF EXISTS "chk_published_rates_breakdown_balances";

-- Components plus the explicitly-named rounding residual reconcile to the
-- total. The customer-facing breakdown still adds up, but the rounding is
-- disclosed on its own line instead of being smuggled into the margin.
ALTER TABLE "published_rates"
  ADD CONSTRAINT "chk_published_rates_breakdown_reconciles"
  CHECK (
    "base_display_paise" + "adjustment_display_paise" + "rounding_delta_paise"
      = "rate_display_paise"
  );

-- The raw tier must reconcile exactly, with no residual at all — it is computed
-- before any display rounding, so a mismatch here means a real arithmetic bug.
ALTER TABLE "published_rates"
  ADD CONSTRAINT "chk_published_rates_raw_balances"
  CHECK ("raw_base_rate" + "raw_adjustment" = "raw_customer_rate");

-- Display precisions must be positive; 0 would mean "round to nothing".
ALTER TABLE "published_rates"
  ADD CONSTRAINT "chk_published_rates_precision_positive"
  CHECK ("component_precision_paise" > 0 AND "rounding_step_paise" > 0);

ALTER TABLE "tenant_pricing_rules"
  ADD CONSTRAINT "chk_tenant_pricing_rules_component_precision"
  CHECK ("component_precision_paise" > 0);

-- New columns need the same grants as the rest of the schema.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bullion_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "published_rates" TO bullion_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_pricing_rules" TO bullion_app;
  END IF;
END;
$$;
