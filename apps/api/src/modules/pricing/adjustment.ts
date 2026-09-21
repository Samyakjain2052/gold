/**
 * The shopkeeper's margin over the market rate.
 *
 * Applied to the **purity-converted** rate, never to the raw market rate —
 * see `pricing_engine.ts` for why that ordering is load-bearing.
 *
 * Absolute adjustments are expressed in the canonical rate unit (milli-paise
 * per gram), matching the rate they are folded into.
 */
import {
  add_rational,
  rational,
  PAISE_PER_RUPEE,
  RATE_SCALE,
  type Rational,
} from "../../platform/money.js";

export type AdjustmentKind = "absolute" | "percentage";

/** Basis points: 1 bp = 0.01%. Integer, so percentages never touch a float. */
export const BPS_SCALE = 10_000n;

/**
 * Bounds mirroring `chk_tenant_pricing_rules_bounds` in the database.
 * A fat-fingered adjustment should be rejected here *and* by PostgreSQL, not
 * discovered by a customer.
 */
/** ±₹100,000 per gram, in milli-paise. */
export const MAX_ABSOLUTE_ADJUSTMENT = 10_000_000_000n;
/** ±100%. */
export const MAX_ADJUSTMENT_BPS = 10_000;

export type Adjustment =
  | { readonly kind: "absolute"; readonly milli_paise_per_gram: bigint }
  | { readonly kind: "percentage"; readonly bps: number };

export class AdjustmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdjustmentError";
  }
}

export function assert_valid_adjustment(adjustment: Adjustment): void {
  if (adjustment.kind === "absolute") {
    const { milli_paise_per_gram } = adjustment;
    if (typeof milli_paise_per_gram !== "bigint") {
      throw new AdjustmentError(
        "absolute adjustment must be a bigint of milli-paise per gram",
      );
    }
    if (abs(milli_paise_per_gram) > MAX_ABSOLUTE_ADJUSTMENT) {
      throw new AdjustmentError(
        `absolute adjustment ${milli_paise_per_gram} exceeds ±${MAX_ABSOLUTE_ADJUSTMENT} milli-paise/g`,
      );
    }
    return;
  }

  const { bps } = adjustment;
  if (!Number.isInteger(bps)) {
    throw new AdjustmentError(
      `percentage adjustment must be integer basis points, received ${bps}`,
    );
  }
  if (Math.abs(bps) > MAX_ADJUSTMENT_BPS) {
    throw new AdjustmentError(
      `percentage adjustment ${bps} bps exceeds ±${MAX_ADJUSTMENT_BPS} bps`,
    );
  }
}

/**
 * The adjustment **as its own exact amount**, in milli-paise per gram.
 *
 * This is the load-bearing change from the earlier design, which derived the
 * adjustment as `final_rate − base_rate`. That subtraction silently folded the
 * final rounding into the adjustment, so a shopkeeper who configured ₹50/g saw
 * ₹50.007/g reported back. The configured adjustment is an *input*: it is
 * computed here from the rule alone and is never back-computed from a rounded
 * output.
 *
 * - `absolute`   — exactly the configured amount, independent of the base rate.
 * - `percentage` — derived from the base, so it is genuinely a computed amount:
 *                  `base × bps / 10000`, kept exact.
 */
export function adjustment_amount(base: Rational, adjustment: Adjustment): Rational {
  assert_valid_adjustment(adjustment);

  if (adjustment.kind === "absolute") {
    return rational(adjustment.milli_paise_per_gram, 1n);
  }

  return rational(base.num * BigInt(adjustment.bps), base.den * BPS_SCALE);
}

/**
 * The customer rate before any rounding: `base + adjustment`, exact.
 *
 * Deliberately expressed as an addition of two independently meaningful values
 * rather than as a single folded formula, so the adjustment remains inspectable
 * on its own.
 */
export function apply_adjustment(base: Rational, adjustment: Adjustment): Rational {
  return add_rational(base, adjustment_amount(base, adjustment));
}

/**
 * Convenience constructor: a rupees-per-gram margin.
 * Accepts a decimal string ("2.50") so sub-rupee silver margins are exact.
 */
export function absolute_rupees_per_gram(rupees: string | number): Adjustment {
  const negative = typeof rupees === "string" && rupees.trim().startsWith("-");
  const text = typeof rupees === "number" ? String(rupees) : rupees.trim();
  const match = /^-?(\d+)(?:\.(\d{1,2}))?$/.exec(text);

  if (!match) {
    throw new AdjustmentError(
      `absolute_rupees_per_gram expects rupees with at most 2 decimals, received "${rupees}"`,
    );
  }

  const [, whole, fraction = ""] = match;
  const paise =
    BigInt(whole as string) * PAISE_PER_RUPEE + BigInt(fraction.padEnd(2, "0"));
  const milli_paise_per_gram = paise * RATE_SCALE;

  return {
    kind: "absolute",
    milli_paise_per_gram: negative ? -milli_paise_per_gram : milli_paise_per_gram,
  };
}

/** Convenience constructor: a percentage margin, e.g. 3 → 300 bps. */
export function percentage(percent: number): Adjustment {
  const bps = Math.round(percent * 100);
  if (Math.abs(bps - percent * 100) > Number.EPSILON * 100) {
    throw new AdjustmentError(
      `percentage ${percent}% is finer than one basis point (0.01%)`,
    );
  }
  return { kind: "percentage", bps };
}

/** A no-op adjustment — "reset to market". */
export const NO_ADJUSTMENT: Adjustment = {
  kind: "absolute",
  milli_paise_per_gram: 0n,
};

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
