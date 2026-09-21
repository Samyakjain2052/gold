# ADR-0002: IBJA-anchored rate basis with spot for intraday movement

- **Status:** Accepted
- **Date:** 2026-09-20
- **Deciders:** Samyak Jain

## Context

The brief framed the market input as XAU/USD and XAG/USD spot converted to INR. Research into how Indian
jewellery pricing actually works showed this would produce a number that is *wrong for the market the product
serves*.

Indian jewellers do not quote international spot. They quote from **IBJA** (India Bullion and Jewellers
Association) rates or **MCX** futures. Both already incorporate import duty, local premium, and domestic
supply-demand. IBJA publishes AM and PM fixes for 999/995/916/750/585 gold and 999 silver, and is the
benchmark banks use for gold loan valuation.

Spot converted at the USD/INR rate is materially lower than the Indian retail benchmark. A jeweller whose
customer compares the app against any Indian rate source would see a discrepancy — fatal for a product whose
entire value is the shopkeeper's credibility with their own customer.

## Decision

**IBJA is the authoritative base rate. XAU/INR and XAG/INR spot supply intraday movement between fixes.**

```
base_rate = ibja_fix(purity, session)            authoritative, 2×/day
          + spot_delta_since_fix                  intraday movement
```

Rate basis is per-tenant configurable (`ibja_999` | `mcx_near` | `spot`) so a jeweller preferring an MCX
anchor can be served once that licence exists, but IBJA-anchored is the default and the shipped production
configuration.

The customer page states its basis explicitly — *"IBJA PM fix · 20 Sep + live spot movement"* — rather than
implying a single continuous live feed.

## Rationale

Correctness for the actual market beats architectural convenience. IBJA is also the most favourably licensed
source evaluated: it *expects* downstream valuation and pricing use, which is precisely this product's case,
where most commodity APIs prohibit redistribution to third parties.

Spot alone would be cheaper and simpler but produces a wrong number. MCX alone is the most accurate intraday
but carries a redistribution agreement, ~₹1.5L/yr link charges, and quarterly subscriber reporting —
unjustifiable pre-revenue.

## Consequences

**Positive.** Rates match what Indian customers see elsewhere. Native purity coverage means 916 and 750 come
from the source rather than being derived. Strongest licensing position. Honest freshness is natural: the
product states the fix it used.

**Negative.** Two providers to integrate and monitor, behind a `CompositeProvider`. IBJA pricing is
quote-only, so cost is unknown until procurement. Intraday accuracy between fixes depends on spot delta being
a good proxy for domestic movement — acceptable for indicative display, and the page already carries "rates
are indicative and subject to confirmation."

Freshness has **two independent clocks**: the IBJA fix age (hours) and the spot tick age (seconds). The UI must
not present the spot timestamp as if it were the fix timestamp. Both appear in the payload.

## Alternatives

**Spot-derived only** — rejected: visibly wrong for India.
**MCX-anchored** — correct and truly intraday; deferred on compliance cost. The abstraction accommodates it.
**IBJA only, no spot** — fully licensed and simplest, but a rate board that changes twice a day is not a
live rate board. Remains the graceful degradation path when spot is unavailable.
