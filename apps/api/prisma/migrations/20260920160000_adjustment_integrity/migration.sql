-- Bind the displayed adjustment to the configured one.
--
-- The reconciliation constraint added in the previous migration cannot tell
--     adjustment ₹500.00 + rounding ₹0.07
-- apart from
--     adjustment ₹500.07 + rounding ₹0.00
-- because both sum to the same total. The second is exactly the defect
-- ADR-0005 exists to prevent, so the database must reject it.
--
-- `adjustment_display_paise` is the configured adjustment converted into the
-- display unit and quantised. It must therefore agree with `raw_adjustment`
-- (milli-paise per gram) to within one unit of component precision.
--
--   adjustment_display_paise × RATE_SCALE  ==  raw_adjustment × grams_per_unit
--
-- allowing a tolerance of one precision step for the quantisation itself.

ALTER TABLE "published_rates"
  ADD CONSTRAINT "chk_published_rates_adjustment_matches_configured"
  CHECK (
    abs(
      "adjustment_display_paise" * 1000
      - "raw_adjustment" * (
          CASE "display_unit"
            WHEN 'per_gram'     THEN 1
            WHEN 'per_10_gram'  THEN 10
            WHEN 'per_kilogram' THEN 1000
          END
        )
    ) <= 1000 * "component_precision_paise"
  );

-- The same reasoning applies to the market rate: the displayed base must be the
-- raw base, quantised — not the total with the margin subtracted back out.
ALTER TABLE "published_rates"
  ADD CONSTRAINT "chk_published_rates_base_matches_raw"
  CHECK (
    abs(
      "base_display_paise" * 1000
      - "raw_base_rate" * (
          CASE "display_unit"
            WHEN 'per_gram'     THEN 1
            WHEN 'per_10_gram'  THEN 10
            WHEN 'per_kilogram' THEN 1000
          END
        )
    ) <= 1000 * "component_precision_paise"
  );
