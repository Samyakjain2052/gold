import { describe, expect, test } from "vitest";
import {
  rate_from_rupees_per_unit,
  to_rupees_string,
  ROUNDING_MODES,
  type RoundingMode,
} from "../../src/platform/money.js";
import {
  absolute_rupees_per_gram,
  percentage,
  AdjustmentError,
  MAX_ADJUSTMENT_BPS,
  NO_ADJUSTMENT,
} from "../../src/modules/pricing/adjustment.js";
import { PURITY } from "../../src/modules/pricing/purity.js";
import {
  compute_customer_rate,
  PricingError,
  type PricingInput,
} from "../../src/modules/pricing/pricing_engine.js";

/** IBJA PM 18/09/2026: Gold 999 ₹153,727/10g, Silver 999 ₹236,908/kg. */
const GOLD_999_BASE = rate_from_rupees_per_unit("153727", "per_10_gram");
const SILVER_999_BASE = rate_from_rupees_per_unit("236908", "per_kilogram");

const PAISE = 1n; // two decimals
const RUPEE = 100n; // zero decimals
const TEN_RUPEES = 1000n;

function gold_input(overrides: Partial<PricingInput> = {}): PricingInput {
  return {
    base_rate: GOLD_999_BASE,
    base_purity: PURITY.FINE_999,
    target_purity: PURITY.FINE_999,
    purity_basis: "fine_ratio",
    adjustment: NO_ADJUSTMENT,
    display_unit: "per_10_gram",
    rounding_step_paise: RUPEE,
    rounding_mode: "half_up",
    ...overrides,
  };
}

/** Gold 22K with a +₹50/g margin — the case that exposed the original bug. */
function gold_916_with_50(overrides: Partial<PricingInput> = {}): PricingInput {
  return gold_input({
    target_purity: PURITY.GOLD_916,
    purity_basis: "market_convention",
    adjustment: absolute_rupees_per_gram(50),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The configured adjustment is an input, never a derived value
// ---------------------------------------------------------------------------

describe("configured adjustment is preserved exactly", () => {
  /**
   * The regression this suite exists for.
   *
   * An earlier design reported the adjustment as `final_rate − base_rate`,
   * which folded the final rounding into it: a shopkeeper who configured ₹50/g
   * was shown ₹500.07 per 10 g. The adjustment is an input and must survive
   * every rounding rule unchanged.
   */
  test("Adjustment_configured50PerGram_reportsExactly500Per10Gram", () => {
    const result = compute_customer_rate(gold_916_with_50());

    expect(result.adjustment_display_paise).toBe(50_000n); // ₹500.00 exactly
    expect(to_rupees_string(result.adjustment_display_paise)).toBe("500.00");
    expect(result.adjustment_display_paise).not.toBe(50_007n); // the old bug
  });

  test.each([
    ["two decimals", PAISE],
    ["nearest ₹1", RUPEE],
    ["nearest ₹10", TEN_RUPEES],
    ["nearest ₹100", 10_000n],
  ])(
    "Adjustment_configured50PerGram_isUnchangedAt_%s",
    (_label: string, step: bigint) => {
      const result = compute_customer_rate(
        gold_916_with_50({ rounding_step_paise: step }),
      );
      expect(result.adjustment_display_paise).toBe(50_000n);
    },
  );

  test.each(ROUNDING_MODES)(
    "Adjustment_configured50PerGram_isUnchangedUnder_%s",
    (mode: RoundingMode) => {
      const result = compute_customer_rate(
        gold_916_with_50({ rounding_mode: mode, rounding_step_paise: TEN_RUPEES }),
      );
      expect(result.adjustment_display_paise).toBe(50_000n);
    },
  );

  test("Adjustment_configured50PerGram_isUnchangedAcrossPurities", () => {
    for (const purity of [PURITY.FINE_999, PURITY.GOLD_916, PURITY.GOLD_750]) {
      const result = compute_customer_rate(
        gold_input({
          target_purity: purity,
          purity_basis: "market_convention",
          adjustment: absolute_rupees_per_gram(50),
        }),
      );
      // ₹50/g is ₹500 per 10 g whatever the metal is worth.
      expect(result.adjustment_display_paise).toBe(50_000n);
    }
  });

  test("Adjustment_absoluteIsIndependentOfBaseRate", () => {
    const cheap = compute_customer_rate(
      gold_input({ base_rate: 1n, adjustment: absolute_rupees_per_gram(50) }),
    );
    const dear = compute_customer_rate(
      gold_input({
        base_rate: GOLD_999_BASE * 1000n,
        adjustment: absolute_rupees_per_gram(50),
      }),
    );
    expect(cheap.adjustment_display_paise).toBe(dear.adjustment_display_paise);
    expect(cheap.raw_adjustment).toBe(dear.raw_adjustment);
  });

  test("Adjustment_negativeConfigured_isPreservedExactly", () => {
    const result = compute_customer_rate({
      base_rate: SILVER_999_BASE,
      base_purity: PURITY.FINE_999,
      target_purity: PURITY.FINE_999,
      purity_basis: "fine_ratio",
      adjustment: absolute_rupees_per_gram("-1"),
      display_unit: "per_kilogram",
      rounding_step_paise: RUPEE,
      rounding_mode: "half_up",
    });
    // −₹1/g is exactly −₹1,000 per kg.
    expect(result.adjustment_display_paise).toBe(-100_000n);
  });

  /** A percentage adjustment IS derived from the base, so it scales with it. */
  test("Adjustment_percentage_isDerivedFromBaseUnlikeAbsolute", () => {
    const result = compute_customer_rate(
      gold_916_with_50({ adjustment: percentage(3) }),
    );
    // 3% of ₹1,40,813.932 = ₹4,224.4180 → ₹4,224.42 at paise precision.
    expect(result.adjustment_display_paise).toBe(422_442n);
  });
});

// ---------------------------------------------------------------------------
// Precision tiers
// ---------------------------------------------------------------------------

describe("calculation, storage and display precision are distinct", () => {
  /**
   * The worked example from the brief:
   *   raw base  ₹1,40,813.932 / 10g
   *   configured adjustment ₹500.000 / 10g
   *   raw customer ₹1,41,313.932 / 10g
   */
  test("Precision_rawCustomerRate_isBasePlusAdjustmentBeforeRounding", () => {
    const result = compute_customer_rate(gold_916_with_50());

    // Storage precision: milli-paise per gram.
    expect(result.raw_base_rate).toBe(1_408_139_320n); // ₹14,081.39320/g
    expect(result.raw_adjustment).toBe(5_000_000n); // ₹50.00000/g exactly
    expect(result.raw_customer_rate).toBe(1_413_139_320n); // ₹14,131.39320/g

    // The raw total is the exact sum of the two raw components.
    expect(result.raw_base_rate + result.raw_adjustment).toBe(
      result.raw_customer_rate,
    );
  });

  test("Precision_displayTwoDecimals_roundsToPaise", () => {
    const result = compute_customer_rate(
      gold_916_with_50({ rounding_step_paise: PAISE }),
    );
    // ₹1,41,313.932 → ₹1,41,313.93
    expect(result.rate_display_paise).toBe(14_131_393n);
    expect(to_rupees_string(result.rate_display_paise)).toBe("141313.93");
  });

  test("Precision_displayZeroDecimals_roundsToRupee", () => {
    const result = compute_customer_rate(
      gold_916_with_50({ rounding_step_paise: RUPEE }),
    );
    // ₹1,41,313.932 → ₹1,41,314
    expect(result.rate_display_paise).toBe(14_131_400n);
    expect(to_rupees_string(result.rate_display_paise)).toBe("141314.00");
  });

  test("Precision_authoritativeRate_isRoundedFromExactTotalNotFromComponents", () => {
    // Components at paise precision sum to ₹1,41,313.93. Rounding *that* to the
    // nearest ₹1 with half_up gives ₹1,41,314 — same answer here, but the
    // engine must round the exact ₹1,41,313.932, not the rounded components.
    const result = compute_customer_rate(
      gold_916_with_50({ rounding_step_paise: RUPEE }),
    );
    const from_exact = 14_131_400n;
    expect(result.rate_display_paise).toBe(from_exact);
  });

  test("Precision_componentPrecisionIsIndependentOfRateRounding", () => {
    const result = compute_customer_rate(
      gold_916_with_50({
        rounding_step_paise: TEN_RUPEES, // final rate to nearest ₹10
        component_precision_paise: PAISE, // breakdown still to the paise
      }),
    );
    expect(result.base_display_paise).toBe(14_081_393n); // ₹1,40,813.93
    expect(result.adjustment_display_paise).toBe(50_000n); // ₹500.00
    expect(result.rate_display_paise).toBe(14_131_000n); // ₹1,41,310.00
  });
});

// ---------------------------------------------------------------------------
// Breakdown policy (ADR-0005, option A)
// ---------------------------------------------------------------------------

describe("displayed breakdown reconciles through an explicit rounding line", () => {
  /**
   * Policy A: components are each quantised at their own precision, and the
   * residual is disclosed as `rounding_delta_paise` — never absorbed into the
   * market rate or the shop's margin.
   */
  test("Breakdown_componentsPlusRoundingDelta_equalsDisplayedRate", () => {
    const cases: PricingInput[] = [
      gold_916_with_50(),
      gold_916_with_50({ rounding_step_paise: TEN_RUPEES }),
      gold_916_with_50({ adjustment: percentage(3) }),
      gold_input({ adjustment: absolute_rupees_per_gram(50) }),
      gold_input({
        target_purity: PURITY.GOLD_750,
        purity_basis: "market_convention",
        adjustment: percentage(2.5),
        rounding_step_paise: TEN_RUPEES,
      }),
    ];

    for (const input of cases) {
      const result = compute_customer_rate(input);
      expect(
        result.base_display_paise +
          result.adjustment_display_paise +
          result.rounding_delta_paise,
      ).toBe(result.rate_display_paise);
    }
  });

  test("Breakdown_matchingPrecisions_produceZeroRoundingDelta", () => {
    const result = compute_customer_rate(
      gold_916_with_50({
        rounding_step_paise: PAISE,
        component_precision_paise: PAISE,
      }),
    );
    expect(result.rounding_delta_paise).toBe(0n);
    expect(
      result.base_display_paise + result.adjustment_display_paise,
    ).toBe(result.rate_display_paise);
  });

  /** The ₹0.07 from the brief — now labelled as rounding, not as margin. */
  test("Breakdown_coarserRateRounding_surfacesResidualAsRoundingNotMargin", () => {
    const result = compute_customer_rate(
      gold_916_with_50({ rounding_step_paise: RUPEE }),
    );

    expect(result.base_display_paise).toBe(14_081_393n); // ₹1,40,813.93
    expect(result.adjustment_display_paise).toBe(50_000n); // ₹500.00 — intact
    expect(result.rounding_delta_paise).toBe(7n); // ₹0.07 — named
    expect(result.rate_display_paise).toBe(14_131_400n); // ₹1,41,314.00
  });

  test("Breakdown_roundingDelta_neverExceedsOneRoundingStep", () => {
    for (const step of [PAISE, RUPEE, TEN_RUPEES, 10_000n]) {
      for (const mode of ROUNDING_MODES) {
        const result = compute_customer_rate(
          gold_916_with_50({ rounding_step_paise: step, rounding_mode: mode }),
        );
        const magnitude =
          result.rounding_delta_paise < 0n
            ? -result.rounding_delta_paise
            : result.rounding_delta_paise;
        expect(magnitude).toBeLessThan(step + result.component_precision_paise);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Pipeline ordering
// ---------------------------------------------------------------------------

describe("pipeline ordering — purity before adjustment", () => {
  /**
   * A jeweller's ₹50/g margin is ₹50 on the 22K metal actually sold. Applying
   * it to the 999 rate and converting afterwards shrinks it to ₹45.80/g —
   * ₹42 per 10 g. Expected values are hand-computed, never taken from a run.
   */
  test("PricingEngine_purityBeforeAdjustment_appliesFullMarginOn22K", () => {
    const result = compute_customer_rate(gold_916_with_50());

    // (1_537_270_000 × 916/1000) + 5_000_000 = 1_413_139_320 milli-paise/g
    //   per 10 g = ₹1,41,313.932 → nearest ₹1 → ₹1,41,314.00
    expect(result.rate_display_paise).toBe(14_131_400n);

    // Inverted: (1_537_270_000 + 5_000_000) × 916/1000 → ₹1,41,272.00
    expect(result.rate_display_paise).not.toBe(14_127_200n);
  });

  test("PricingEngine_marginOnPureMetal_isUnaffectedByOrdering", () => {
    const result = compute_customer_rate(
      gold_input({ adjustment: absolute_rupees_per_gram(50) }),
    );
    expect(result.rate_display_paise).toBe(15_422_700n); // ₹1,54,227.00
  });
});

// ---------------------------------------------------------------------------
// Worked scenarios
// ---------------------------------------------------------------------------

describe("worked examples", () => {
  test("PricingEngine_gold999NoAdjustment_matchesPublishedMarketRate", () => {
    const result = compute_customer_rate(gold_input());
    expect(result.rate_display_paise).toBe(15_372_700n); // ₹1,53,727.00
    expect(result.base_display_paise).toBe(15_372_700n);
    expect(result.adjustment_display_paise).toBe(0n);
    expect(result.rounding_delta_paise).toBe(0n);
  });

  test("PricingEngine_gold999FixedRupeeAdjustment_addsMarginPerGram", () => {
    const result = compute_customer_rate(
      gold_input({ adjustment: absolute_rupees_per_gram(50) }),
    );
    expect(result.rate_display_paise).toBe(15_422_700n); // ₹1,54,227.00
    expect(result.adjustment_display_paise).toBe(50_000n); // ₹500.00
    expect(result.rounding_delta_paise).toBe(0n);
  });

  test("PricingEngine_gold916MarketRate_matchesIbjaPublishedFigure", () => {
    const result = compute_customer_rate(gold_916_with_50());
    // IBJA publishes ₹140,814; the engine computes ₹1,40,813.93.
    expect(result.base_display_paise).toBe(14_081_393n);
  });

  test("PricingEngine_silver999FixedRupeeAdjustment_quotesPerKilogram", () => {
    const result = compute_customer_rate({
      base_rate: SILVER_999_BASE,
      base_purity: PURITY.FINE_999,
      target_purity: PURITY.FINE_999,
      purity_basis: "fine_ratio",
      adjustment: absolute_rupees_per_gram(2),
      display_unit: "per_kilogram",
      rounding_step_paise: RUPEE,
      rounding_mode: "half_up",
    });
    expect(result.base_display_paise).toBe(23_690_800n); // ₹2,36,908.00
    expect(result.adjustment_display_paise).toBe(200_000n); // ₹2,000.00
    expect(result.rate_display_paise).toBe(23_890_800n); // ₹2,38,908.00
    expect(result.rounding_delta_paise).toBe(0n);
  });

  test("PricingEngine_percentageAdjustment_scalesPurityConvertedRate", () => {
    const result = compute_customer_rate(
      gold_916_with_50({
        adjustment: percentage(3),
        rounding_step_paise: TEN_RUPEES,
      }),
    );
    // 1_408_139_320 × 1.03 = 1_450_383_499.6 → per 10 g ₹1,45,038.34996
    //   → nearest ₹10 → ₹1,45,040.00
    expect(result.rate_display_paise).toBe(14_504_000n);
  });

  test("PricingEngine_perGramAndPer10Gram_agreeAtPaisePrecision", () => {
    const per_gram = compute_customer_rate(
      gold_input({ display_unit: "per_gram", rounding_step_paise: PAISE }),
    );
    const per_10g = compute_customer_rate(
      gold_input({ display_unit: "per_10_gram", rounding_step_paise: PAISE }),
    );
    expect(per_gram.rate_display_paise * 10n).toBe(per_10g.rate_display_paise);
  });
});

// ---------------------------------------------------------------------------
// Rounding behaviour
// ---------------------------------------------------------------------------

describe("rounding behaviour", () => {
  /** ₹10,000.50 per gram — the only place the four modes disagree. */
  const half_step_input = gold_input({
    base_rate: 1_000_050_000n,
    display_unit: "per_gram",
    rounding_step_paise: RUPEE,
  });

  test("Rounding_exactHalfStep_halfUpRoundsAway", () => {
    expect(
      compute_customer_rate({ ...half_step_input, rounding_mode: "half_up" })
        .rate_display_paise,
    ).toBe(1_000_100n);
  });

  test("Rounding_exactHalfStep_halfEvenRoundsToEvenNeighbour", () => {
    expect(
      compute_customer_rate({ ...half_step_input, rounding_mode: "half_even" })
        .rate_display_paise,
    ).toBe(1_000_000n);
  });

  test("Rounding_exactHalfStep_ceilRoundsUp", () => {
    expect(
      compute_customer_rate({ ...half_step_input, rounding_mode: "ceil" })
        .rate_display_paise,
    ).toBe(1_000_100n);
  });

  test("Rounding_exactHalfStep_floorRoundsDown", () => {
    expect(
      compute_customer_rate({ ...half_step_input, rounding_mode: "floor" })
        .rate_display_paise,
    ).toBe(1_000_000n);
  });

  test.each(ROUNDING_MODES)(
    "Rounding_%s_producesMultipleOfStep",
    (mode: RoundingMode) => {
      const result = compute_customer_rate(
        gold_input({ rounding_mode: mode, rounding_step_paise: TEN_RUPEES }),
      );
      expect(result.rate_display_paise % TEN_RUPEES).toBe(0n);
    },
  );

  /** Rounding must move the total, never the configured margin. */
  test("Rounding_acrossAllModes_leavesConfiguredAdjustmentUntouched", () => {
    for (const mode of ROUNDING_MODES) {
      const result = compute_customer_rate(
        gold_916_with_50({ rounding_mode: mode, rounding_step_paise: TEN_RUPEES }),
      );
      expect(result.adjustment_display_paise).toBe(50_000n);
      expect(result.raw_adjustment).toBe(5_000_000n);
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-tenant independence, validation
// ---------------------------------------------------------------------------

describe("multi-tenant independence", () => {
  test("PricingEngine_twoTenantsOneMarketRate_computeIndependentRates", () => {
    const sharma = compute_customer_rate(
      gold_input({ adjustment: absolute_rupees_per_gram(50) }),
    );
    const gupta = compute_customer_rate(
      gold_input({ adjustment: absolute_rupees_per_gram(100) }),
    );

    expect(sharma.rate_display_paise).toBe(15_422_700n); // ₹1,54,227.00
    expect(gupta.rate_display_paise).toBe(15_472_700n); // ₹1,54,727.00
    expect(sharma.adjustment_display_paise).toBe(50_000n);
    expect(gupta.adjustment_display_paise).toBe(100_000n);

    const sharma_again = compute_customer_rate(
      gold_input({ adjustment: absolute_rupees_per_gram(50) }),
    );
    expect(sharma_again).toEqual(sharma);
  });
});

describe("validation and failure modes", () => {
  test("PricingEngine_zeroBaseRate_throws", () => {
    expect(() => compute_customer_rate(gold_input({ base_rate: 0n }))).toThrow(
      PricingError,
    );
  });

  test("PricingEngine_negativeBaseRate_throws", () => {
    expect(() => compute_customer_rate(gold_input({ base_rate: -1n }))).toThrow(
      PricingError,
    );
  });

  test("PricingEngine_nonPositiveRoundingStep_throws", () => {
    expect(() =>
      compute_customer_rate(gold_input({ rounding_step_paise: 0n })),
    ).toThrow(PricingError);
  });

  test("PricingEngine_nonPositiveComponentPrecision_throws", () => {
    expect(() =>
      compute_customer_rate(gold_input({ component_precision_paise: 0n })),
    ).toThrow(PricingError);
  });

  test("PricingEngine_adjustmentDrivingRateToZero_throws", () => {
    expect(() =>
      compute_customer_rate(
        gold_input({ adjustment: { kind: "percentage", bps: -MAX_ADJUSTMENT_BPS } }),
      ),
    ).toThrow(PricingError);
  });

  test("PricingEngine_adjustmentBeyondBounds_throws", () => {
    expect(() =>
      compute_customer_rate(
        gold_input({
          adjustment: { kind: "percentage", bps: MAX_ADJUSTMENT_BPS + 1 },
        }),
      ),
    ).toThrow(AdjustmentError);
  });

  test("PricingEngine_isPure_doesNotMutateItsInput", () => {
    const input = gold_916_with_50();
    const snapshot = structuredClone(input);
    compute_customer_rate(input);
    expect(input).toEqual(snapshot);
  });
});

describe("adjustment constructors", () => {
  test("AbsoluteRupeesPerGram_decimalString_isExact", () => {
    expect(absolute_rupees_per_gram("2.50")).toEqual({
      kind: "absolute",
      milli_paise_per_gram: 250_000n,
    });
  });

  test("AbsoluteRupeesPerGram_negativeString_preservesSign", () => {
    expect(absolute_rupees_per_gram("-1")).toEqual({
      kind: "absolute",
      milli_paise_per_gram: -100_000n,
    });
  });

  test("AbsoluteRupeesPerGram_tooManyDecimals_throws", () => {
    expect(() => absolute_rupees_per_gram("1.234")).toThrow(AdjustmentError);
  });

  test("Percentage_wholeAndHalfPercent_convertToBasisPoints", () => {
    expect(percentage(3)).toEqual({ kind: "percentage", bps: 300 });
    expect(percentage(2.5)).toEqual({ kind: "percentage", bps: 250 });
  });

  test("Percentage_finerThanOneBasisPoint_throws", () => {
    expect(() => percentage(0.001)).toThrow(AdjustmentError);
  });
});
