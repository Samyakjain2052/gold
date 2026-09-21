/**
 * The pricing engine.
 *
 * A pure function of (market rate, tenant rule). No database handle, no clock,
 * no configuration lookup, no I/O of any kind — which is what makes its tests
 * worth trusting.
 *
 * ## Three precisions, deliberately distinct
 *
 * | Tier | Unit | Where it lives | Rounded? |
 * |------|------|----------------|----------|
 * | **Calculation** | exact `Rational` | inside this function only | never |
 * | **Storage** | milli-paise per gram | `raw_*` fields, `market_rates` | once, half_even |
 * | **Display** | paise of the display unit | `*_display_paise` fields | per the tenant's rule |
 *
 * ## Pipeline
 *
 *   raw_base_rate      = market rate converted to the target purity   (exact)
 *   raw_adjustment     = the shopkeeper's configured adjustment       (exact)
 *   raw_customer_rate  = raw_base_rate + raw_adjustment               (exact)
 *   rate_display_paise = round(raw_customer_rate, display precision)
 *
 * Purity conversion precedes the adjustment because a jeweller's ₹50 margin is
 * ₹50 on the metal actually being sold. Inverting it costs ₹42 per 10 g on 22K
 * gold, and `pricing_engine.test.ts` fails loudly if anyone reorders it.
 *
 * ## What the adjustment is, and is not
 *
 * `adjustment_display_paise` is computed from the **rule**, never as
 * `rate − base`. A configured +₹50/g reports as exactly ₹500.00 per 10 g at any
 * rounding step. Any residual between the displayed components and the
 * displayed total is rounding, and it is surfaced as `rounding_delta_paise`
 * rather than hidden inside the adjustment. See ADR-0005.
 */
import {
  add_rational,
  rational,
  rational_to_display_paise,
  rational_to_rate,
  type DisplayUnit,
  type Paise,
  type Rational,
  type RatePerGram,
  type RoundingMode,
} from "../../platform/money.js";
import { adjustment_amount, type Adjustment } from "./adjustment.js";
import { purity_ratio, type Purity, type PurityBasis } from "./purity.js";

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

/** Paise precision for the explanatory breakdown lines. 1 = two decimals. */
export const DEFAULT_COMPONENT_PRECISION_PAISE = 1n;

export interface PricingInput {
  /** Market rate in canonical milli-paise per gram, quoted at `base_purity`. */
  readonly base_rate: RatePerGram;
  /** The fineness the feed quotes. IBJA quotes 999. */
  readonly base_purity: Purity;
  /** The fineness being sold to the customer. */
  readonly target_purity: Purity;
  /** Per-product conversion convention — see {@link PurityBasis}. */
  readonly purity_basis: PurityBasis;
  /** The shopkeeper's configured margin, expressed per gram. */
  readonly adjustment: Adjustment;
  /** The unit the customer sees this product quoted in. */
  readonly display_unit: DisplayUnit;
  /**
   * Display precision for the **final customer rate**, in paise of the display
   * unit. 1 = two decimals, 100 = nearest ₹1, 1000 = nearest ₹10.
   */
  readonly rounding_step_paise: bigint;
  readonly rounding_mode: RoundingMode;
  /**
   * Display precision for the breakdown lines. Defaults to whole paise, so the
   * market rate reads ₹1,40,813.93 rather than being quantised to the coarser
   * step applied to the final rate.
   */
  readonly component_precision_paise?: bigint;
}

export interface PricingResult {
  // --- Storage precision: milli-paise per gram, exact to 1/1000 paise --------
  /** Market rate converted to the target fineness, before any adjustment. */
  readonly raw_base_rate: RatePerGram;
  /** The configured adjustment as its own amount. Never derived from the total. */
  readonly raw_adjustment: RatePerGram;
  /** `raw_base_rate + raw_adjustment`, before display rounding. */
  readonly raw_customer_rate: RatePerGram;

  // --- Display precision: paise of `display_unit` ---------------------------
  readonly display_unit: DisplayUnit;
  readonly component_precision_paise: bigint;
  readonly rounding_step_paise: bigint;
  /** Market rate for the breakdown, at component precision. */
  readonly base_display_paise: Paise;
  /** The configured adjustment, at component precision. Exact for `absolute`. */
  readonly adjustment_display_paise: Paise;
  /**
   * `rate_display_paise − base_display_paise − adjustment_display_paise`.
   *
   * The residual created by quantising the total and the components at
   * different precisions. Disclosed as its own line so the breakdown reconciles
   * without misstating either the market rate or the shop's margin. Zero
   * whenever both precisions agree.
   */
  readonly rounding_delta_paise: Paise;
  /** **The authoritative customer rate.** One rounding, from the exact total. */
  readonly rate_display_paise: Paise;
}

/**
 * Compute a customer rate.
 *
 * @throws {PricingError} on a non-positive base rate, an invalid precision, or
 * an adjustment that drives the rate to zero or below.
 */
export function compute_customer_rate(input: PricingInput): PricingResult {
  const {
    base_rate,
    base_purity,
    target_purity,
    purity_basis,
    adjustment,
    display_unit,
    rounding_step_paise,
    rounding_mode,
    component_precision_paise = DEFAULT_COMPONENT_PRECISION_PAISE,
  } = input;

  if (typeof base_rate !== "bigint") {
    throw new PricingError("base_rate must be a bigint of milli-paise per gram");
  }
  if (base_rate <= 0n) {
    throw new PricingError(`base rate must be positive, received ${base_rate}`);
  }
  if (rounding_step_paise <= 0n) {
    throw new PricingError(
      `rounding_step_paise must be positive, received ${rounding_step_paise}`,
    );
  }
  if (component_precision_paise <= 0n) {
    throw new PricingError(
      `component_precision_paise must be positive, received ${component_precision_paise}`,
    );
  }

  // Stage 1 — purity conversion. Exact; nothing is rounded here.
  const ratio = purity_ratio(base_purity, target_purity, purity_basis);
  const raw_base: Rational = rational(base_rate * ratio.num, ratio.den);

  // Stage 2 — the configured adjustment, computed from the rule on its own.
  const raw_adjustment: Rational = adjustment_amount(raw_base, adjustment);

  // Stage 3 — the exact customer rate.
  const raw_customer: Rational = add_rational(raw_base, raw_adjustment);

  // Stage 4 — the pipeline's single rounding of the authoritative figure,
  // taken from the exact total rather than from rounded components.
  const rate_display_paise = rational_to_display_paise(
    raw_customer,
    display_unit,
    rounding_step_paise,
    rounding_mode,
  );

  if (rate_display_paise <= 0n) {
    throw new PricingError(
      "computed customer rate is not positive; check the adjustment bounds",
    );
  }

  // Breakdown lines, each quantised independently at component precision.
  const base_display_paise = rational_to_display_paise(
    raw_base,
    display_unit,
    component_precision_paise,
    "half_even",
  );
  const adjustment_display_paise = rational_to_display_paise(
    raw_adjustment,
    display_unit,
    component_precision_paise,
    "half_even",
  );

  return {
    raw_base_rate: rational_to_rate(raw_base),
    raw_adjustment: rational_to_rate(raw_adjustment),
    raw_customer_rate: rational_to_rate(raw_customer),

    display_unit,
    component_precision_paise,
    rounding_step_paise,
    base_display_paise,
    adjustment_display_paise,
    rounding_delta_paise:
      rate_display_paise - base_display_paise - adjustment_display_paise,
    rate_display_paise,
  };
}
