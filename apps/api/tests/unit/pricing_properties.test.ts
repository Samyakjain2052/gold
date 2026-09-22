/**
 * Stage 9 — property-oriented pricing checks.
 *
 * The existing suites assert specific worked examples. This one asserts
 * *invariants* over generated inputs: properties that must hold for every
 * combination of metal, purity, unit, precision and adjustment, not just the
 * ones someone thought to write down.
 *
 * Inputs are generated from a deterministic seed so a failure is reproducible.
 * No randomness reaches CI unrepeatably.
 */
import { describe, expect, test } from "vitest";
import {
  compute_customer_rate,
  PricingError,
  type PricingInput,
} from "../../src/modules/pricing/pricing_engine.js";
import {
  MAX_ABSOLUTE_ADJUSTMENT,
  MAX_ADJUSTMENT_BPS,
  NO_ADJUSTMENT,
  type Adjustment,
} from "../../src/modules/pricing/adjustment.js";
import { PURITY, type Purity, type PurityBasis } from "../../src/modules/pricing/purity.js";
import {
  DISPLAY_UNIT_GRAMS,
  RATE_SCALE,
  type DisplayUnit,
  type RoundingMode,
} from "../../src/platform/money.js";

/** Deterministic 32-bit PRNG, so a failing case is always reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const UNITS: readonly DisplayUnit[] = ["per_gram", "per_10_gram", "per_kilogram"];
const MODES: readonly RoundingMode[] = ["half_up", "half_even", "ceil", "floor"];
const STEPS = [1n, 5n, 10n, 25n, 50n, 100n, 500n, 1000n, 10_000n];
const BASES: readonly PurityBasis[] = ["market_convention", "fine_ratio"];

/** Realistic INR bounds: ~₹60/g silver to ~₹15,000/g gold, in milli-paise. */
const MIN_BASE = 6_000_000n;
const MAX_BASE = 1_500_000_000n;

const PURITIES: readonly Purity[] = [
  PURITY.FINE_999,
  PURITY.FINE_995,
  PURITY.GOLD_916,
  PURITY.GOLD_750,
  PURITY.GOLD_585,
];

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("empty pool");
  return item;
}

function big_between(random: () => number, min: bigint, max: bigint): bigint {
  const span = max - min;
  return min + (BigInt(Math.floor(random() * 1_000_000)) * span) / 1_000_000n;
}

function generate(random: () => number): PricingInput {
  const absolute = random() < 0.5;

  const adjustment: Adjustment = absolute
    ? {
        kind: "absolute",
        // Signed: discounts are legal, and must be exercised.
        milli_paise_per_gram: big_between(random, -2_000_000n, 20_000_000n),
      }
    : {
        kind: "percentage",
        bps: Math.floor(random() * 2_000) - 500,
      };

  return {
    base_rate: big_between(random, MIN_BASE, MAX_BASE),
    base_purity: PURITY.FINE_999,
    target_purity: pick(random, PURITIES),
    purity_basis: pick(random, BASES),
    adjustment,
    display_unit: pick(random, UNITS),
    rounding_step_paise: pick(random, STEPS),
    rounding_mode: pick(random, MODES),
    component_precision_paise: pick(random, [1n, 5n, 10n, 100n]),
  };
}

/** 400 deterministic cases, skipping any the engine legitimately rejects. */
function* cases(count = 400, seed = 0x5eed) {
  const random = prng(seed);
  for (let i = 0; i < count; i += 1) {
    const input = generate(random);
    try {
      yield { input, result: compute_customer_rate(input) };
    } catch (error) {
      // A negative adjustment can legally drive the rate to zero; that is a
      // rejection, not a property violation.
      if (error instanceof PricingError) continue;
      throw error;
    }
  }
}

describe("breakdown reconciliation", () => {
  /**
   * The ADR-0005 invariant. The three displayed lines must sum to the
   * authoritative rate exactly — that is what makes the breakdown honest rather
   * than decorative.
   */
  test("Pricing_breakdownAlwaysSumsToTheAuthoritativeRate", () => {
    let checked = 0;
    for (const { result } of cases()) {
      expect(
        result.base_display_paise +
          result.adjustment_display_paise +
          result.rounding_delta_paise,
      ).toBe(result.rate_display_paise);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(300);
  });

  /**
   * The configured adjustment is authored, never recovered from the total.
   * For an absolute rule the displayed adjustment must equal the configured
   * amount converted to the display unit — independent of rounding.
   */
  test("Pricing_displayedAdjustment_isUnmovedByTheRoundingOfTheTotal", () => {
    let checked = 0;

    for (const { input, result } of cases()) {
      // Re-price the same rule at the coarsest and finest display steps. The
      // shop configured one adjustment; changing how the *total* is rounded
      // must not restate it. Deriving the adjustment as
      // `rate - market_rate` would move it by the rounding delta, which is
      // exactly the defect ADR-0005 exists to prevent.
      const coarse = compute_customer_rate({ ...input, rounding_step_paise: 10_000n });
      const fine = compute_customer_rate({ ...input, rounding_step_paise: 1n });

      expect(coarse.adjustment_display_paise).toBe(result.adjustment_display_paise);
      expect(fine.adjustment_display_paise).toBe(result.adjustment_display_paise);

      // The totals genuinely do differ, so this is not a vacuous comparison.
      if (coarse.rate_display_paise !== fine.rate_display_paise) checked += 1;
    }

    expect(checked).toBeGreaterThan(100);
  });

  /**
   * `raw_base_rate`, `raw_adjustment` and `raw_customer_rate` are each rounded
   * to milli-paise from their own exact rational, so their sum may differ from
   * the total by one unit of the last place. That is the deferred-rounding
   * design working: the engine keeps exact rationals through the pipeline and
   * quantises at the edges, rather than summing pre-rounded parts.
   *
   * One milli-paise is 1/100,000 of a rupee. The bound is asserted so a
   * genuine arithmetic error cannot hide inside it.
   */
  test("Pricing_rawTotal_matchesBasePlusAdjustmentToTheLastMilliPaise", () => {
    for (const { result } of cases()) {
      const sum = result.raw_base_rate + result.raw_adjustment;
      const drift = sum > result.raw_customer_rate
        ? sum - result.raw_customer_rate
        : result.raw_customer_rate - sum;

      expect(drift).toBeLessThanOrEqual(1n);
    }
  });
});

describe("rounding", () => {
  test("Pricing_finalRate_isAlwaysAMultipleOfItsStep", () => {
    for (const { result } of cases()) {
      expect(result.rate_display_paise % result.rounding_step_paise).toBe(0n);
    }
  });

  /** One rounding, from the exact total — never a sum of rounded parts. */
  test("Pricing_roundingError_neverExceedsOneStep", () => {
    for (const { result } of cases()) {
      const grams = DISPLAY_UNIT_GRAMS[result.display_unit];
      const exact = (result.raw_customer_rate * grams) / RATE_SCALE;
      const drift =
        result.rate_display_paise > exact
          ? result.rate_display_paise - exact
          : exact - result.rate_display_paise;

      expect(drift).toBeLessThanOrEqual(result.rounding_step_paise);
    }
  });

  test("Pricing_componentPrecisionOne_leavesNoDeltaWhenStepIsAlsoOne", () => {
    const result = compute_customer_rate({
      base_rate: 1_408_139_320n,
      base_purity: PURITY.FINE_999,
      target_purity: PURITY.FINE_999,
      purity_basis: "market_convention",
      adjustment: { kind: "absolute", milli_paise_per_gram: 5_000_000n },
      display_unit: "per_10_gram",
      rounding_step_paise: 1n,
      rounding_mode: "half_up",
      component_precision_paise: 1n,
    });

    expect(result.rounding_delta_paise).toBe(0n);
  });
});

describe("monotonicity", () => {
  /** A larger market rate can never produce a smaller customer rate. */
  test("Pricing_isMonotonicInTheBaseRate", () => {
    const random = prng(0xb45e);

    for (let i = 0; i < 120; i += 1) {
      const input = generate(random);
      const higher: PricingInput = { ...input, base_rate: input.base_rate + 1_000_000n };

      try {
        const a = compute_customer_rate(input);
        const b = compute_customer_rate(higher);
        expect(b.rate_display_paise).toBeGreaterThanOrEqual(a.rate_display_paise);
      } catch (error) {
        if (!(error instanceof PricingError)) throw error;
      }
    }
  });

  /** A larger absolute adjustment can never produce a smaller rate. */
  test("Pricing_isMonotonicInTheAdjustment", () => {
    const random = prng(0xadd1);

    for (let i = 0; i < 120; i += 1) {
      const input = generate(random);
      if (input.adjustment.kind !== "absolute") continue;

      const higher: PricingInput = {
        ...input,
        adjustment: {
          kind: "absolute",
          milli_paise_per_gram: input.adjustment.milli_paise_per_gram + 100_000n,
        },
      };

      try {
        const a = compute_customer_rate(input);
        const b = compute_customer_rate(higher);
        expect(b.rate_display_paise).toBeGreaterThanOrEqual(a.rate_display_paise);
      } catch (error) {
        if (!(error instanceof PricingError)) throw error;
      }
    }
  });
});

describe("purity", () => {
  /** Converting to a lower fineness can never raise the rate. */
  test("Pricing_lowerPurity_neverCostsMore", () => {
    const base: Omit<PricingInput, "target_purity"> = {
      base_rate: 1_408_139_320n,
      base_purity: PURITY.FINE_999,
      purity_basis: "market_convention",
      adjustment: NO_ADJUSTMENT,
      display_unit: "per_10_gram",
      rounding_step_paise: 1n,
      rounding_mode: "half_up",
      component_precision_paise: 1n,
    };

    const ordered = [PURITY.FINE_999, PURITY.FINE_995, PURITY.GOLD_916, PURITY.GOLD_750, PURITY.GOLD_585];
    const rates = ordered.map(
      (target_purity) => compute_customer_rate({ ...base, target_purity }).rate_display_paise,
    );

    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i]!).toBeLessThanOrEqual(rates[i - 1]!);
    }
  });

  test("Pricing_samePurity_isTheIdentityConversion", () => {
    for (const purity of PURITIES) {
      const result = compute_customer_rate({
        base_rate: 1_000_000_000n,
        base_purity: purity,
        target_purity: purity,
        // fine_ratio is target.num / base.num, which is the identity when the
        // two finenesses are the same. market_convention is target.num / 1000,
        // which is deliberately NOT the identity for 999 — see ADR-0004.
        purity_basis: "fine_ratio",
        adjustment: NO_ADJUSTMENT,
        display_unit: "per_gram",
        rounding_step_paise: 1n,
        rounding_mode: "half_up",
        component_precision_paise: 1n,
      });

      expect(result.raw_base_rate).toBe(1_000_000_000n);
    }
  });
});

describe("boundaries", () => {
  test("Pricing_zeroAdjustment_leavesTheBaseUnchanged", () => {
    const result = compute_customer_rate({
      base_rate: 1_408_139_320n,
      base_purity: PURITY.FINE_999,
      target_purity: PURITY.FINE_999,
      purity_basis: "market_convention",
      adjustment: NO_ADJUSTMENT,
      display_unit: "per_10_gram",
      rounding_step_paise: 1n,
      rounding_mode: "half_up",
      component_precision_paise: 1n,
    });

    expect(result.raw_adjustment).toBe(0n);
    expect(result.raw_customer_rate).toBe(result.raw_base_rate);
    expect(result.adjustment_display_paise).toBe(0n);
  });

  test("Pricing_negativeAdjustment_isADiscountNotAnError", () => {
    const result = compute_customer_rate({
      base_rate: 1_408_139_320n,
      base_purity: PURITY.FINE_999,
      target_purity: PURITY.FINE_999,
      purity_basis: "market_convention",
      adjustment: { kind: "absolute", milli_paise_per_gram: -5_000_000n },
      display_unit: "per_10_gram",
      rounding_step_paise: 1n,
      rounding_mode: "half_up",
      component_precision_paise: 1n,
    });

    expect(result.raw_adjustment).toBeLessThan(0n);
    expect(result.rate_display_paise).toBeLessThan(result.base_display_paise);
  });

  /** An adjustment that drives the rate to zero is refused, not published. */
  test("Pricing_adjustmentBelowNegativeBase_isRejected", () => {
    expect(() =>
      compute_customer_rate({
        base_rate: 1_000_000n,
        base_purity: PURITY.FINE_999,
        target_purity: PURITY.FINE_999,
        purity_basis: "market_convention",
        adjustment: { kind: "absolute", milli_paise_per_gram: -1_000_000n },
        display_unit: "per_gram",
        rounding_step_paise: 1n,
        rounding_mode: "half_up",
        component_precision_paise: 1n,
      }),
    ).toThrow(PricingError);
  });

  test("Pricing_maximumPercentage_isAccepted", () => {
    const result = compute_customer_rate({
      base_rate: 1_000_000_000n,
      base_purity: PURITY.FINE_999,
      target_purity: PURITY.FINE_999,
      purity_basis: "fine_ratio",
      adjustment: { kind: "percentage", bps: MAX_ADJUSTMENT_BPS },
      display_unit: "per_gram",
      rounding_step_paise: 1n,
      rounding_mode: "half_up",
      component_precision_paise: 1n,
    });

    // +100% doubles the rate exactly.
    expect(result.raw_customer_rate).toBe(2_000_000_000n);
  });

  /**
   * Silver per kilogram is the largest realistic value in the system and the
   * case that originally motivated milli-paise: ₹236,908/kg is 23,690.8
   * paise/gram, which whole paise cannot represent.
   */
  test("Pricing_silverPerKilogram_keepsSubPaisePrecision", () => {
    const result = compute_customer_rate({
      base_rate: 23_690_800n,
      base_purity: PURITY.FINE_999,
      target_purity: PURITY.FINE_999,
      purity_basis: "fine_ratio",
      adjustment: NO_ADJUSTMENT,
      display_unit: "per_kilogram",
      rounding_step_paise: 1n,
      rounding_mode: "half_up",
      component_precision_paise: 1n,
    });

    // 23,690,800 milli-paise/g × 1000 g ÷ 1000 = 23,690,800 paise = ₹236,908.00
    expect(result.rate_display_paise).toBe(23_690_800n);
  });

  test("Pricing_largeAbsoluteAdjustment_staysExact", () => {
    const result = compute_customer_rate({
      base_rate: MAX_BASE,
      base_purity: PURITY.FINE_999,
      target_purity: PURITY.FINE_999,
      purity_basis: "fine_ratio",
      adjustment: { kind: "absolute", milli_paise_per_gram: MAX_ABSOLUTE_ADJUSTMENT },
      display_unit: "per_kilogram",
      rounding_step_paise: 1n,
      rounding_mode: "half_up",
      component_precision_paise: 1n,
    });

    const sum = MAX_BASE + MAX_ABSOLUTE_ADJUSTMENT;
    const drift = result.raw_customer_rate > sum
      ? result.raw_customer_rate - sum
      : sum - result.raw_customer_rate;
    expect(drift).toBeLessThanOrEqual(1n);
    expect(typeof result.rate_display_paise).toBe("bigint");
  });
});

describe("no floating point reaches the result", () => {
  /**
   * A value past `Number.MAX_SAFE_INTEGER` survives the pipeline unchanged.
   *
   * Realistic bullion rates do not reach this magnitude — ₹115M in paise is
   * only ~1.15e10 — so the guarantee is demonstrated with a deliberately
   * enormous rate. As a double, the input below rounds to ...92 and the final
   * paisa is lost before any arithmetic happens.
   */
  test("Pricing_valueBeyondMaxSafeInteger_isCarriedExactly", () => {
    const base = 9_007_199_254_740_993n; // 2^53 + 1, in milli-paise per gram
    expect(Number(base).toString()).toBe("9007199254740992");

    const result = compute_customer_rate({
      base_rate: base,
      base_purity: PURITY.FINE_999,
      target_purity: PURITY.FINE_999,
      purity_basis: "fine_ratio",
      adjustment: NO_ADJUSTMENT,
      display_unit: "per_gram",
      rounding_step_paise: 1n,
      rounding_mode: "half_up",
      component_precision_paise: 1n,
    });

    expect(result.raw_base_rate).toBe(base);

    // 9_007_199_254_740_993 milli-paise is 9_007_199_254_740.993 paise, which
    // half_up rounds to ...741. Truncation would give ...740, and a double
    // would never have had the .993 to round in the first place.
    expect(result.rate_display_paise).toBe(9_007_199_254_741n);
  });

  /**
   * Every monetary field is a bigint. A `number` anywhere here would mean a
   * value had passed through a double, which is the one thing the money design
   * exists to prevent.
   */
  test("Pricing_everyMonetaryField_isABigint", () => {
    for (const { result } of cases(60)) {
      for (const field of [
        result.raw_base_rate,
        result.raw_adjustment,
        result.raw_customer_rate,
        result.base_display_paise,
        result.adjustment_display_paise,
        result.rounding_delta_paise,
        result.rate_display_paise,
      ]) {
        expect(typeof field).toBe("bigint");
        expect(Number.isNaN(Number(field))).toBe(false);
      }
    }
  });
});
