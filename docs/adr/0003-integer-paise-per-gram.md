# ADR-0003: All rates as integer milli-paise per gram

- **Status:** Accepted (revised during Stage 3 implementation)
- **Date:** 2026-09-20
- **Deciders:** Samyak Jain

> **Revision note.** This ADR originally specified *paise* per gram. Implementation against real
> IBJA data showed that loses money on silver: ₹236,908/kg is 23,690.**8** paise per gram, and
> truncating to whole paise costs ₹8 per kilogram. The canonical unit is now **milli-paise per
> gram** (`RATE_SCALE = 1000`). Everything else in this decision stands.

## Context

Bullion pricing in India mixes units freely: gold is quoted per 10 grams, silver per kilogram, retail
sometimes per gram. Purity conversion (999 → 916) and percentage margins both invite fractional arithmetic.

IEEE-754 floats cannot represent common decimal values exactly. Applied to money and compounded across a
purity conversion, a percentage margin, and a rounding step, the error becomes visible in rupees — and these
numbers underwrite real transactions.

Mixed units are the second hazard: a function receiving "9985" cannot tell whether that is ₹/g or ₹/10g, and
unit-confusion bugs are silent and expensive.

## Decision

**Every rate in the system is a `BIGINT` of milli-paise per gram** (1/1000 paise per gram). One canonical
unit, one integer type, everywhere: database columns, pricing engine, API payloads, cache entries.

- Storage: PostgreSQL `BIGINT`. No `FLOAT`/`REAL`/`DOUBLE PRECISION` in any rate column.
- Application: `bigint`. Never `number` on a pricing path.
- Purity: integer `purity_num` / `purity_den` (916/1000), never `0.916`.
- Percentages: **basis points** as integers (`adjustment_bps`; 1 bp = 0.01%).
- Rounding: explicit step and mode, applied **once**, over an exact rational.
- Display unit (`per_gram` | `per_10_gram` | `per_kilogram`) is per-tenant presentation, applied at the edge.

## Rationale

Choosing **per gram** — rather than per 10 g, matching the Indian gold convention — means no calculation
ever needs to know which unit a product uses. Gold and silver traverse identical code paths; only the final
display conversion differs. Since silver is conventionally quoted per kg and gold per 10 g, a
"canonical = conventional" rule would have required branching inside the pricing engine.

Choosing **milli-paise** rather than paise is what makes that per-gram choice safe. Indian silver is quoted
per kilogram, and dividing a per-kg quote by 1000 does not land on a whole paise: ₹236,908/kg is 23,690.8
paise per gram. At whole paise the stored rate truncates to 23,690 and the shop loses ₹8 on every kilogram.
Three extra digits make every supported quote unit (per gram, per 10 g, per kg) convert in with no
rounding at all.

Precision is ample: gold at ₹15,372.70/g is `1_537_270_000` milli-paise/g; a 64-bit integer overflows
somewhere past ₹92 trillion per gram.

Basis points keep percentages integral. `market × (10000 + bps) / 10000` in integer arithmetic gives a
deterministic, testable result where `market × 1.03` in floating point does not.

Rounding once at the end matters: applying it after purity conversion *and* after adjustment compounds error
in a way that is hard to reproduce and harder to explain to a jeweller.

## Consequences

**Positive.** Exact arithmetic. Unit confusion structurally impossible. Rounding is explicit and configurable
per tenant per product. Every pricing function is a pure integer function and exhaustively testable.

**Negative.** `bigint` does not serialise to JSON natively — the API emits rates as strings, with Zod
transforms on both sides handling the boundary (`packages/contracts`). Developers must remember paise, not
rupees; the `money` module exposes only named constructors (`from_rupees`, `from_paise`) rather than raw
numbers, and a CI guard greps pricing paths for `parseFloat`, `Number(`, and bare `/ 100`.

Division is not exact — `(base × 916) / 1000` truncates. The engine uses an explicit
`divide_and_round(numerator, denominator, mode)` helper rather than bare `/`, so the rounding decision is
always deliberate and always tested.

## Alternatives

**`NUMERIC(14,4)` in PostgreSQL** — exact and arguably more natural for currency. Rejected because Prisma maps
`NUMERIC` to `Decimal.js`, spreading a decimal library through the pricing engine and reintroducing the
question of where rounding happens. Integers keep the engine dependency-free.

**Float with rounding at the edges** — rejected. The brief prohibits it, and correctly.

**Per-10-gram canonical unit** — matches the gold convention but forces silver conversions into the engine.
Rejected in favour of a single unit that requires no branching.

**Whole paise per gram** — the original form of this decision. Rejected once real IBJA silver data showed
the ₹8/kg truncation loss described above.
