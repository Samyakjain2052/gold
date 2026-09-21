# ADR-0005: Rounding tiers and the customer-facing breakdown policy

- **Status:** Accepted
- **Date:** 2026-09-20
- **Deciders:** Samyak Jain
- **Supersedes:** the `base + adjustment = rate` invariant introduced in the Stage 2 schema

## Context

The Stage 3 worked examples reported this for Gold 22K with a configured +₹50/g margin:

```
Market (916)     ₹1,40,813.93 / 10g
Adjustment       ₹500.07      / 10g     ← wrong
Customer rate    ₹1,41,314.00 / 10g
```

The three numbers added up, but only because the adjustment was computed as `rate − base`. That
subtraction folded the final ₹1 rounding into the margin. A shopkeeper who typed **₹50/g** was shown
**₹50.007/g** back.

This is not a display nit. The adjustment is the one number in the system the shopkeeper *authored*.
Reporting it back altered breaks the dashboard ("I set ₹50, why does it say ₹500.07?"), the audit
log (old/new values that never match what was configured), and any future per-gram margin reporting.
The system was optimising for an arithmetic identity at the cost of misstating an input.

## Decision

### 1. Three precision tiers, kept structurally distinct

| Tier | Unit | Where it lives | Rounded |
|---|---|---|---|
| **Calculation** | exact `Rational` (`num`/`den`) | inside `compute_customer_rate` only | never |
| **Storage** | milli-paise per gram | `raw_*` columns, `market_rates` | once, `half_even` |
| **Display** | paise of the display unit | `*_display_paise` columns | per the tenant's configured rule |

### 2. The configured adjustment is an input, never a derived value

`adjustment_amount()` computes the adjustment **from the rule alone**:

- `absolute` — exactly the configured amount, independent of the base rate.
- `percentage` — genuinely derived (`base × bps / 10000`), kept exact.

It is never computed as `rate − base`.

### 3. The pipeline

```
raw_base_rate     = market rate converted to target purity      (exact)
raw_adjustment    = the configured adjustment                    (exact)
raw_customer_rate = raw_base_rate + raw_adjustment               (exact)

rate_display_paise = round(raw_customer_rate, rounding_step_paise, rounding_mode)
```

The authoritative rate is rounded **once, from the exact total** — not from rounded components.

### 4. Breakdown display: **Option A**, with the residual disclosed

Of the two options considered:

- **A — independently rounded components.** Each line is quantised at its own precision.
- **B — raw precise values formatted.** Show `₹1,41,313.932`.

**Option A is chosen**, with the residual surfaced as an explicit `rounding_delta_paise` line rather
than absorbed into any other figure:

```
Market (916)     ₹1,40,813.93
Our adjustment   +   ₹500.00      ← exactly what was configured
Rounding         +     ₹0.07      ← named, not hidden
─────────────────────────────
Your rate        ₹1,41,314.00
```

The invariant is therefore:

```
base_display + adjustment_display + rounding_delta = rate_display
```

and `rounding_delta` is **zero** whenever `component_precision_paise == rounding_step_paise`.

## Rationale

**Why not Option B.** `₹1,41,313.932` is not a price. No Indian jeweller quotes sub-paise, no
customer pays it, and printing it would invite the question of what actually gets charged. The
customer rate must be a number that can be transacted.

**Why the components are quantised differently from the total.** They are quantised for different
reasons. The market rate is a fact shown to two decimals because that is the precision it carries.
The adjustment is an authored input shown exactly as authored. The customer rate is quantised to the
shop's chosen step because that is the price honoured at the counter — jewellers quote round rupees,
not paise. Forcing one precision on all three would either clutter the headline price or coarsen the
market rate below its real precision.

**Why disclose the residual instead of hiding it.** Rounding is a real, legitimate part of the price
and it is the shop's own policy. Naming it costs one line and keeps every other line truthful.
Hiding it requires misstating either the market rate or the margin — and the margin is precisely
what a jeweller checks.

**Why a shop may still hide the whole breakdown.** `show_base_rate` already lets a tenant publish
only the final rate. This ADR governs what is shown *when* the breakdown is shown; it does not force
any shop to show it.

## Consequences

**Positive.** A configured ₹50/g reports as ₹500.00 per 10 g at every rounding step and mode —
asserted directly by the test suite. The breakdown reconciles exactly, so the public page can show
all four lines with no arithmetic a customer can fault. Storing the raw tier alongside the display
tier means a published rate can be re-derived and audited long after the fact, and display precision
can change without rewriting history. Percentage adjustments remain honestly derived.

**Negative.** Four columns instead of two on `published_rates`, and one more concept
(`rounding_delta`) for the UI to render. The delta is usually ₹0.00 and hidden, which is arguably a
line that exists for the rare case — accepted, because the rare case is exactly where trust is lost.

Callers must not reconstruct the adjustment by subtraction. Two database constraints enforce this
rather than leaving it to convention:

- `chk_published_rates_breakdown_reconciles` — the displayed lines sum to the total.
- `chk_published_rates_adjustment_matches_configured` — the displayed adjustment agrees with the
  configured `raw_adjustment` to within one unit of component precision. This is the one that
  rejects the original defect: reconciliation alone cannot distinguish
  *₹500.00 + ₹0.07 rounding* from *₹500.07 + ₹0.00*, and both would otherwise pass.

`chk_published_rates_base_matches_raw` applies the same binding to the market rate.

## Alternatives

**Keep `base + adjustment = rate` and let the adjustment absorb rounding** — the original design.
Rejected: it misstates an authored input, which is the whole objection.

**Round the components, then sum them to produce the total.** Makes the identity hold by
construction, but the customer rate would then be the sum of two rounded numbers rather than the
rounded exact total — the double-rounding error ADR-0003 avoids, and the headline price is the one
number that must be computed from the exact value.

**Quantise everything at a single precision.** The delta disappears, but either the headline price
carries paise a jeweller would not quote, or the market rate is coarsened below its true precision.
Rejected on both counts; the per-tenant `component_precision_paise` default of 1 paise makes this
configurable for a shop that disagrees.
