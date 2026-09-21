/**
 * Purity conversion.
 *
 * A market feed quotes one fineness (IBJA quotes 999). A shop sells several —
 * 22K (916), 18K (750). Converting between them is the first stage of the
 * pricing pipeline, and it happens **before** the shopkeeper's adjustment.
 */

export interface Purity {
  /** Parts of fine metal. 916 for 22K gold. */
  readonly num: number;
  /** Parts total. Conventionally 1000. */
  readonly den: number;
}

/**
 * Which convention governs the conversion.
 *
 * **IBJA uses both, and which one applies depends on the purity.** This was
 * established against IBJA's own published rates for 18/09/2026 (PM), where
 * Gold 999 = ₹153,727/10g:
 *
 * | Purity | IBJA published | `market_convention` | `fine_ratio` |
 * |--------|---------------:|--------------------:|-------------:|
 * | 995    |      153,111   |   152,958 ✗         | **153,111** ✓ |
 * | 916    |      140,814   |   **140,814** ✓     |   140,955 ✗  |
 * | 750    |      115,295   |   **115,295** ✓     |   115,412 ✗  |
 * | 585    |       89,930   |    **89,930** ✓     |    90,005 ✗  |
 *
 * - `fine_ratio` — scale by the ratio of the two finenesses:
 *   `base × (to.num/to.den) ÷ (from.num/from.den)`. Physically exact, and what
 *   IBJA uses between **bullion** grades (999 ↔ 995). Also the only basis that
 *   makes a 999 → 999 conversion the identity.
 *
 * - `market_convention` — `base × to.num / to.den`, treating the quoted base as
 *   the 1000-scale reference. What the trade uses for **karat jewellery**
 *   grades (916, 750, 585): 22K is quoted as the 24K rate × 0.916.
 *
 * The two differ by roughly 0.1% — around ₹140/10g on gold, which a customer
 * comparing against any Indian rate source would notice. Basis is therefore a
 * per-product attribute (`products.purity_basis`), never a global setting.
 */
export type PurityBasis = "market_convention" | "fine_ratio";

export const PURITY_BASES: readonly PurityBasis[] = [
  "market_convention",
  "fine_ratio",
];

export class PurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurityError";
  }
}

/** An exact rational, kept unevaluated so division can be deferred. */
export interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

export function assert_valid_purity(purity: Purity, label: string): void {
  const { num, den } = purity;

  if (!Number.isInteger(num) || !Number.isInteger(den)) {
    throw new PurityError(`${label} purity must be integers, received ${num}/${den}`);
  }
  if (den <= 0) {
    throw new PurityError(`${label} purity denominator must be positive, received ${den}`);
  }
  if (num <= 0) {
    throw new PurityError(`${label} purity numerator must be positive, received ${num}`);
  }
  if (num > den) {
    throw new PurityError(
      `${label} purity cannot exceed 100% fine, received ${num}/${den}`,
    );
  }
}

/**
 * The multiplier taking a rate quoted at `from` purity to a rate at `to` purity.
 *
 * Returned as an unevaluated ratio rather than a computed value, so the caller
 * can fold it into a single exact expression and round only once at the end.
 */
export function purity_ratio(
  from: Purity,
  to: Purity,
  basis: PurityBasis,
): Ratio {
  assert_valid_purity(from, "source");
  assert_valid_purity(to, "target");

  if (basis === "market_convention") {
    // The quoted base is taken as the reference for the target's scale.
    return { num: BigInt(to.num), den: BigInt(to.den) };
  }

  // fine_ratio: (to.num/to.den) ÷ (from.num/from.den)
  return {
    num: BigInt(to.num) * BigInt(from.den),
    den: BigInt(to.den) * BigInt(from.num),
  };
}

/** True when the two purities describe the same fineness (916/1000 ≡ 458/500). */
export function is_same_purity(a: Purity, b: Purity): boolean {
  return BigInt(a.num) * BigInt(b.den) === BigInt(b.num) * BigInt(a.den);
}

/** Common Indian bullion finenesses, as seeded into the `products` table. */
export const PURITY = {
  FINE_999: { num: 999, den: 1000 },
  FINE_995: { num: 995, den: 1000 },
  GOLD_916: { num: 916, den: 1000 },
  GOLD_750: { num: 750, den: 1000 },
  GOLD_585: { num: 585, den: 1000 },
  SILVER_925: { num: 925, den: 1000 },
} as const satisfies Record<string, Purity>;

/**
 * The basis IBJA applies to each fineness, verified against published rates
 * (see the table on {@link PurityBasis}). Seeded into `products.purity_basis`.
 *
 * Bullion grades relate by true fineness; karat jewellery grades by the
 * ×P/1000 trade convention.
 */
export const DEFAULT_PURITY_BASIS: Readonly<Record<string, PurityBasis>> = {
  FINE_999: "fine_ratio",
  FINE_995: "fine_ratio",
  GOLD_916: "market_convention",
  GOLD_750: "market_convention",
  GOLD_585: "market_convention",
  SILVER_925: "market_convention",
};
