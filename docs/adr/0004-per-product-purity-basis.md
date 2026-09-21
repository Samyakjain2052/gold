# ADR-0004: Purity conversion basis is per-product, not global

- **Status:** Accepted
- **Date:** 2026-09-20
- **Deciders:** Samyak Jain
- **Discovered during:** Stage 3 implementation

## Context

The pricing engine converts a quoted fineness (IBJA publishes 999) to the fineness a shop actually sells
(916 for 22K, 750 for 18K). The architecture assumed one conversion formula would serve every purity.

Checking the engine against IBJA's own published rates showed that assumption is wrong. With
Gold 999 = ₹153,727/10g (PM session, 18/09/2026):

| Purity | IBJA published | `base × P/1000` | `base × P/999` |
|--------|---------------:|----------------:|---------------:|
| 995    |      ₹153,111  |  ₹152,958 ✗     | **₹153,111** ✓ |
| 916    |      ₹140,814  | **₹140,814** ✓  |   ₹140,955 ✗   |
| 750    |      ₹115,295  | **₹115,295** ✓  |   ₹115,412 ✗   |
| 585    |       ₹89,930  |  **₹89,930** ✓  |    ₹90,005 ✗   |

**IBJA uses both formulas, and which one applies depends on the purity.** Verified against the AM session
independently, which agrees.

## Decision

`purity_basis` is a column on `products`, not a global setting:

- **`fine_ratio`** — `base × (to.num/to.den) ÷ (from.num/from.den)`. Physically exact. Used between
  **bullion** grades (999 ↔ 995), which relate by true fineness.
- **`market_convention`** — `base × to.num / to.den`. Used for **karat jewellery** grades (916, 750, 585),
  which the trade quotes as the 24K rate × 0.916 and so on.

Seeded accordingly; the defaults table is asserted by a regression test.

## Rationale

There is no single correct formula because the market does not use one. The distinction is not arbitrary:
bullion bars are traded on assayed fineness, while karat jewellery grades are a nominal scale where
"916" means 91.6% by convention. IBJA's published numbers follow that split exactly.

Picking one formula for everything would put roughly 0.1% error — about ₹140 per 10 g of gold — into
whichever grades got the wrong one. That is visible to any customer comparing against another Indian rate
source, which is precisely the credibility failure ADR-0002 exists to avoid.

Only `fine_ratio` makes a 999 → 999 conversion the identity, so 999 products must use it regardless.

## Consequences

**Positive.** Every purity matches the benchmark customers can independently check. New purities are added
as data with the appropriate basis, not as code branches. The verification table is embedded in
`purity.ts` so the reasoning travels with the code.

**Negative.** One more column, and one more thing to get right when seeding a new product — mitigated by
`DEFAULT_PURITY_BASIS` and its regression test. The basis is deliberately not tenant-configurable: it
describes how the *market* quotes a purity, not a shop's pricing preference. A shop that disagrees should
express that through its adjustment, which is what adjustments are for.

If a future feed publishes each purity directly (IBJA does), conversion becomes unnecessary for those
products, and this decision only governs derived purities.
