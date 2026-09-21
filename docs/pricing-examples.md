# Pricing Engine — Worked Examples

**Every figure below is produced by
[`pricing_engine.ts`](../apps/api/src/modules/pricing/pricing_engine.ts)**, not written by hand.
Regenerate with:

```bash
npm run pricing:examples --workspace apps/api
```

Base rates are IBJA's published PM session rates for 18/09/2026:
Gold 999 ₹153,727/10g, Silver 999 ₹236,908/kg.

---

## The three precisions

[ADR-0005](adr/0005-rounding-and-breakdown-display-policy.md) keeps these deliberately separate.

| Tier | Unit | Rounded |
|---|---|---|
| **Calculation** | exact rational (`num`/`den`) | never — division is deferred to the end |
| **Storage** | milli-paise per gram (`RATE_SCALE` = 1000) | once, `half_even` |
| **Display** | paise of the display unit | per the tenant's configured precision |

```
raw_base_rate     = market rate converted to target purity      (exact)
raw_adjustment    = the shopkeeper's CONFIGURED adjustment      (exact)
raw_customer_rate = raw_base_rate + raw_adjustment              (exact)

rate_display      = round(raw_customer_rate, display precision)
```

The **configured adjustment is an input**. It is computed from the pricing rule alone and is never
back-derived as `rate − base`. A configured +₹50/g reports as exactly ₹500.00 per 10 g at every
rounding step and mode.

## Breakdown policy: independently rounded components (Option A)

Each line is quantised at its own precision, and the residual is disclosed as an explicit
**rounding** line rather than absorbed into the market rate or the shop's margin:

```
base_display + adjustment_display + rounding_delta = rate_display
```

`rounding_delta` is zero whenever component precision and rate precision agree. Two database
constraints stop the old defect returning: `chk_published_rates_breakdown_reconciles` (the lines sum
to the total) and `chk_published_rates_adjustment_matches_configured` (the displayed adjustment
agrees with the configured one). The second is the one that matters — reconciliation alone cannot
distinguish *₹500.00 + ₹0.07 rounding* from *₹500.07 + ₹0.00*.

---

## Output

```text
Pricing engine — worked examples
================================
Base rates: IBJA published PM session, 18/09/2026.
All figures produced by src/modules/pricing/pricing_engine.ts.
Precision tiers and breakdown policy: ADR-0005.

Gold 999 — no adjustment (reset to market)
──────────────────────────────────────────
  Feed                    IBJA 999 ₹153,727/10g
  Target purity           999/1000 (fine_ratio)
  Configured adjustment   none
  Display precision       0 decimals (nearest ₹1), half_up

  RAW (calculation/storage precision, per 10 g)
    raw base rate         ₹1,53,727.00000
    raw adjustment        ₹0.00000
    raw customer rate     ₹1,53,727.00000

  DISPLAYED BREAKDOWN (per 10 g)
    market rate           ₹1,53,727.00
    shop adjustment       ₹0.00
    rounding              ₹0.00
    CUSTOMER RATE         ₹1,53,727.00

Gold 999 — fixed ₹50/g (Sharma Jewellers)
─────────────────────────────────────────
  Feed                    IBJA 999 ₹153,727/10g
  Target purity           999/1000 (fine_ratio)
  Configured adjustment   +₹50/g configured
  Display precision       0 decimals (nearest ₹1), half_up

  RAW (calculation/storage precision, per 10 g)
    raw base rate         ₹1,53,727.00000
    raw adjustment        ₹500.00000
    raw customer rate     ₹1,54,227.00000

  DISPLAYED BREAKDOWN (per 10 g)
    market rate           ₹1,53,727.00
    shop adjustment       ₹500.00
    rounding              ₹0.00
    CUSTOMER RATE         ₹1,54,227.00

Gold 916 (22K) — fixed ₹50/g, display precision 2 decimals
──────────────────────────────────────────────────────────
  Feed                    IBJA 999 ₹153,727/10g
  Target purity           916/1000 (market_convention)
  Configured adjustment   +₹50/g configured
  Display precision       2 decimals (paise), half_up

  RAW (calculation/storage precision, per 10 g)
    raw base rate         ₹1,40,813.93200
    raw adjustment        ₹500.00000
    raw customer rate     ₹1,41,313.93200

  DISPLAYED BREAKDOWN (per 10 g)
    market rate           ₹1,40,813.93
    shop adjustment       ₹500.00
    rounding              ₹0.00
    CUSTOMER RATE         ₹1,41,313.93

Gold 916 (22K) — fixed ₹50/g, display precision 0 decimals
──────────────────────────────────────────────────────────
  Feed                    IBJA 999 ₹153,727/10g
  Target purity           916/1000 (market_convention)
  Configured adjustment   +₹50/g configured
  Display precision       0 decimals (nearest ₹1), half_up

  RAW (calculation/storage precision, per 10 g)
    raw base rate         ₹1,40,813.93200
    raw adjustment        ₹500.00000
    raw customer rate     ₹1,41,313.93200

  DISPLAYED BREAKDOWN (per 10 g)
    market rate           ₹1,40,813.93
    shop adjustment       ₹500.00
    rounding              ₹0.07
    CUSTOMER RATE         ₹1,41,314.00

Gold 916 (22K) — percentage 3%, nearest ₹10
───────────────────────────────────────────
  Feed                    IBJA 999 ₹153,727/10g
  Target purity           916/1000 (market_convention)
  Configured adjustment   +3% (300 bps)
  Display precision       nearest ₹10, half_up

  RAW (calculation/storage precision, per 10 g)
    raw base rate         ₹1,40,813.93200
    raw adjustment        ₹4,224.41800
    raw customer rate     ₹1,45,038.35000

  DISPLAYED BREAKDOWN (per 10 g)
    market rate           ₹1,40,813.93
    shop adjustment       ₹4,224.42
    rounding              ₹1.65
    CUSTOMER RATE         ₹1,45,040.00

Silver 999 — fixed ₹2/g (Sharma Jewellers)
──────────────────────────────────────────
  Feed                    IBJA 999 ₹236,908/kg
  Target purity           999/1000 (fine_ratio)
  Configured adjustment   +₹2/g configured
  Display precision       0 decimals (nearest ₹1), half_up

  RAW (calculation/storage precision, per kg)
    raw base rate         ₹2,36,908.00000
    raw adjustment        ₹2,000.00000
    raw customer rate     ₹2,38,908.00000

  DISPLAYED BREAKDOWN (per kg)
    market rate           ₹2,36,908.00
    shop adjustment       ₹2,000.00
    rounding              ₹0.00
    CUSTOMER RATE         ₹2,38,908.00

Silver 999 — discount ₹1/g (Gupta Jewellers)
────────────────────────────────────────────
  Feed                    IBJA 999 ₹236,908/kg
  Target purity           999/1000 (fine_ratio)
  Configured adjustment   −₹1/g configured
  Display precision       0 decimals (nearest ₹1), half_up

  RAW (calculation/storage precision, per kg)
    raw base rate         ₹2,36,908.00000
    raw adjustment        −₹1,000.00000
    raw customer rate     ₹2,35,908.00000

  DISPLAYED BREAKDOWN (per kg)
    market rate           ₹2,36,908.00
    shop adjustment       −₹1,000.00
    rounding              ₹0.00
    CUSTOMER RATE         ₹2,35,908.00


A configured +₹50/g stays +₹50/g under every rounding rule
───────────────────────────────────────────────────────────
  Gold 22K (916). The adjustment column never moves; rounding absorbs the
  difference and is reported on its own line.

  precision        mode        market rate    adjustment    rounding   customer rate
  ───────────────  ──────────  ─────────────  ────────────  ─────────  ─────────────
  2 decimals       half_up      ₹1,40,813.93       ₹500.00      ₹0.00   ₹1,41,313.93
  2 decimals       half_even    ₹1,40,813.93       ₹500.00      ₹0.00   ₹1,41,313.93
  nearest ₹1       half_up      ₹1,40,813.93       ₹500.00      ₹0.07   ₹1,41,314.00
  nearest ₹1       half_even    ₹1,40,813.93       ₹500.00      ₹0.07   ₹1,41,314.00
  nearest ₹10      half_up      ₹1,40,813.93       ₹500.00     −₹3.93   ₹1,41,310.00
  nearest ₹10      half_even    ₹1,40,813.93       ₹500.00     −₹3.93   ₹1,41,310.00
  nearest ₹100     half_up      ₹1,40,813.93       ₹500.00    −₹13.93   ₹1,41,300.00
  nearest ₹100     half_even    ₹1,40,813.93       ₹500.00    −₹13.93   ₹1,41,300.00


Rounding modes at an exact half step
────────────────────────────────────
  Base ₹10,000.50/g, nearest ₹1 — the only case where the modes disagree

  half_up    → ₹10,001.00 per gram
  half_even  → ₹10,000.00 per gram
  ceil       → ₹10,001.00 per gram
  floor      → ₹10,000.00 per gram


Why purity conversion must precede the adjustment
─────────────────────────────────────────────────
  Gold 22K (916), +₹50/g margin

  purity → adjustment (correct)   ₹1,41,314.00 per 10 g
  adjustment → purity (wrong)     ₹1,41,272.00 per 10 g
  Shortfall if inverted           ₹42.00 per 10 g (the ₹50 margin becomes ₹45.80/g)

```

---

## Notes on the numbers

**Display precision changes the total, never the adjustment.** The invariant table shows the same
configured +₹50/g across four precisions and two rounding modes: the adjustment column reads ₹500.00
in every row while the rounding line moves between ₹0.00 and −₹13.93. That is the property the
earlier design violated.

**Gold 916 market rate is ₹1,40,813.93** against IBJA's published ₹140,814 — a 7-paise difference
that is IBJA's own rounding of the same `×0.916` formula. This is the check that confirmed the karat
conversion convention ([ADR-0004](adr/0004-per-product-purity-basis.md)).

**The percentage example shows a genuinely derived adjustment.** 3% of ₹1,40,813.932 is ₹4,224.418,
displayed as ₹4,224.42. Unlike an absolute margin, a percentage adjustment *is* computed from the
base, so rounding it for display is legitimate — and the raw tier still records ₹4,224.41800.

**Silver survives the round trip exactly** (₹2,36,908.00 in, ₹2,36,908.00 shown). ₹236,908/kg is
23,690.8 paise per gram — not an integer. Whole paise per gram would truncate and lose ₹8 per
kilogram, which is why the canonical unit is milli-paise per gram
([ADR-0003](adr/0003-integer-paise-per-gram.md)).

**Only `half_up` and `ceil` round ₹10,000.50 up.** The four modes agree everywhere except an exact
half step, which is the case the rounding tests target.

**Inverting the pipeline costs ₹42 per 10 g** on 22K gold: the ₹50/g margin becomes ₹45.80/g once a
916 conversion is applied after it instead of before. `PricingEngine_purityBeforeAdjustment_appliesFullMarginOn22K`
fails loudly if anyone reorders it.
