import { describe, expect, test } from "vitest";
import {
  add_rational,
  divide_and_round,
  from_paise,
  from_rupees,
  rate_from_milli_paise,
  rate_from_rupees_per_unit,
  rate_to_display_paise,
  rational,
  rational_to_display_paise,
  rational_to_rate,
  round_rational_to_step,
  round_to_step,
  scale_rational,
  to_rupees_string,
  MoneyError,
  ROUNDING_MODES,
  type RoundingMode,
} from "../../src/platform/money.js";

describe("divide_and_round", () => {
  test("DivideAndRound_exactDivision_returnsQuotientForEveryMode", () => {
    for (const mode of ROUNDING_MODES) {
      expect(divide_and_round(100n, 4n, mode)).toBe(25n);
      expect(divide_and_round(-100n, 4n, mode)).toBe(-25n);
    }
  });

  test("DivideAndRound_zeroDenominator_throws", () => {
    expect(() => divide_and_round(1n, 0n, "half_up")).toThrow(MoneyError);
  });

  // 7/2 = 3.5 — the boundary where the modes disagree.
  test("DivideAndRound_exactHalfPositive_resolvesPerMode", () => {
    expect(divide_and_round(7n, 2n, "half_up")).toBe(4n);
    expect(divide_and_round(7n, 2n, "half_even")).toBe(4n); // 4 is even
    expect(divide_and_round(7n, 2n, "ceil")).toBe(4n);
    expect(divide_and_round(7n, 2n, "floor")).toBe(3n);
  });

  // 5/2 = 2.5 — half_even differs from half_up here, which is the point of it.
  test("DivideAndRound_exactHalfToEvenNeighbour_roundsDown", () => {
    expect(divide_and_round(5n, 2n, "half_up")).toBe(3n);
    expect(divide_and_round(5n, 2n, "half_even")).toBe(2n); // 2 is even
  });

  test("DivideAndRound_exactHalfNegative_tiesAwayFromZero", () => {
    expect(divide_and_round(-7n, 2n, "half_up")).toBe(-4n);
    expect(divide_and_round(-5n, 2n, "half_up")).toBe(-3n);
    expect(divide_and_round(-5n, 2n, "half_even")).toBe(-2n);
  });

  // Truncation toward zero is what makes bare `/` unsafe for negatives.
  test("DivideAndRound_negativeValue_floorGoesTowardNegativeInfinity", () => {
    expect(divide_and_round(-7n, 2n, "floor")).toBe(-4n);
    expect(divide_and_round(-7n, 2n, "ceil")).toBe(-3n);
    expect(-7n / 2n).toBe(-3n); // bare division truncates — the bug being guarded
  });

  test("DivideAndRound_negativeDenominator_matchesNegatedNumerator", () => {
    for (const mode of ROUNDING_MODES) {
      expect(divide_and_round(7n, -2n, mode)).toBe(divide_and_round(-7n, 2n, mode));
    }
  });

  test("DivideAndRound_justBelowHalf_roundsDownForHalfModes", () => {
    // 49/100 = 0.49
    expect(divide_and_round(49n, 100n, "half_up")).toBe(0n);
    expect(divide_and_round(51n, 100n, "half_up")).toBe(1n);
  });
});

describe("round_to_step", () => {
  test("RoundToStep_stepOfOne_isIdentity", () => {
    expect(round_to_step(15_372_749n, 1n, "half_up")).toBe(15_372_749n);
  });

  test("RoundToStep_nearestRupee_roundsToHundredPaise", () => {
    expect(round_to_step(15_372_749n, 100n, "half_up")).toBe(15_372_700n);
    expect(round_to_step(15_372_750n, 100n, "half_up")).toBe(15_372_800n);
    expect(round_to_step(15_372_751n, 100n, "half_up")).toBe(15_372_800n);
  });

  test("RoundToStep_nearestTenRupees_roundsToThousandPaise", () => {
    expect(round_to_step(15_372_400n, 1000n, "half_up")).toBe(15_372_000n);
    expect(round_to_step(15_372_500n, 1000n, "half_up")).toBe(15_373_000n);
  });

  test("RoundToStep_nonPositiveStep_throws", () => {
    expect(() => round_to_step(100n, 0n, "half_up")).toThrow(MoneyError);
    expect(() => round_to_step(100n, -100n, "half_up")).toThrow(MoneyError);
  });
});

describe("round_rational_to_step", () => {
  // The whole point: one rounding over an exact rational, not two roundings.
  test("RoundRationalToStep_deferredDivision_matchesSingleRounding", () => {
    // 1000/3 = 333.33… rounded to nearest 10 → 330
    expect(round_rational_to_step(1000n, 3n, 10n, "half_up")).toBe(330n);
  });

  test("RoundRationalToStep_avoidsDoubleRoundingError", () => {
    // Rounding 1004/2 = 502 to the nearest 5 gives 500.
    // Rounding to whole units first (502) then to 5 also gives 500 here, but
    // the deferred form is what stays correct as stages compose.
    expect(round_rational_to_step(1004n, 2n, 5n, "half_up")).toBe(500n);
  });

  test("RoundRationalToStep_zeroDenominator_throws", () => {
    expect(() => round_rational_to_step(1n, 0n, 1n, "half_up")).toThrow(MoneyError);
  });

  test("RoundRationalToStep_nonPositiveStep_throws", () => {
    expect(() => round_rational_to_step(1n, 1n, 0n, "half_up")).toThrow(MoneyError);
  });
});

describe("from_rupees", () => {
  test("FromRupees_decimalString_parsesWithoutFloat", () => {
    expect(from_rupees("9985.50")).toBe(998_550n);
    expect(from_rupees("0.01")).toBe(1n);
    expect(from_rupees("0.1")).toBe(10n);
    expect(from_rupees("153727")).toBe(15_372_700n);
  });

  test("FromRupees_negativeString_preservesSign", () => {
    expect(from_rupees("-1.25")).toBe(-125n);
  });

  test("FromRupees_groupedString_stripsSeparators", () => {
    expect(from_rupees("1,53,727")).toBe(15_372_700n);
  });

  test("FromRupees_wholeNumber_convertsExactly", () => {
    expect(from_rupees(9985)).toBe(998_500n);
    expect(from_rupees(9985n)).toBe(998_500n);
  });

  // Guards ADR-0003: a float must never reach a money constructor.
  test("FromRupees_nonIntegerNumber_throwsRatherThanRoundSilently", () => {
    expect(() => from_rupees(9985.5)).toThrow(MoneyError);
  });

  test("FromRupees_moreThanTwoDecimals_throws", () => {
    expect(() => from_rupees("1.234")).toThrow(MoneyError);
  });

  test("FromRupees_nonNumericString_throws", () => {
    expect(() => from_rupees("abc")).toThrow(MoneyError);
  });
});

describe("from_paise", () => {
  test("FromPaise_nonIntegerNumber_throws", () => {
    expect(() => from_paise(1.5)).toThrow(MoneyError);
  });

  test("FromPaise_integer_converts", () => {
    expect(from_paise(150)).toBe(150n);
    expect(from_paise(150n)).toBe(150n);
  });
});

describe("rate_from_milli_paise", () => {
  test("RateFromMilliPaise_integer_converts", () => {
    expect(rate_from_milli_paise(1_537_270_000)).toBe(1_537_270_000n);
    expect(rate_from_milli_paise(1_537_270_000n)).toBe(1_537_270_000n);
  });

  test("RateFromMilliPaise_nonInteger_throws", () => {
    expect(() => rate_from_milli_paise(1.5)).toThrow(MoneyError);
  });
});

describe("rate_from_rupees_per_unit", () => {
  // IBJA PM 18/09/2026, Gold 999 = ₹153,727 per 10g.
  test("RateFromRupeesPerUnit_goldPer10Gram_convertsExactly", () => {
    expect(rate_from_rupees_per_unit("153727", "per_10_gram")).toBe(1_537_270_000n);
  });

  /**
   * The reason the canonical unit is milli-paise rather than paise.
   * ₹236,908/kg is 23,690.8 paise per gram — not an integer. Whole paise would
   * truncate to 23,690, losing ₹8 per kilogram.
   */
  test("RateFromRupeesPerUnit_silverPerKilogram_keepsSubPaisePrecision", () => {
    const rate = rate_from_rupees_per_unit("236908", "per_kilogram");
    expect(rate).toBe(23_690_800n);
    // Round-trips back to the published figure with no loss.
    expect(rate_to_display_paise(rate, "per_kilogram")).toBe(23_690_800n);
    expect(to_rupees_string(rate_to_display_paise(rate, "per_kilogram"))).toBe(
      "236908.00",
    );
  });

  test("RateFromRupeesPerUnit_perGram_convertsExactly", () => {
    expect(rate_from_rupees_per_unit("15372.70", "per_gram")).toBe(1_537_270_000n);
  });

  test("RateFromRupeesPerUnit_equivalentQuotesInDifferentUnits_agree", () => {
    const from_10g = rate_from_rupees_per_unit("153727", "per_10_gram");
    const from_1g = rate_from_rupees_per_unit("15372.70", "per_gram");
    expect(from_10g).toBe(from_1g);
  });
});

describe("rate_to_display_paise", () => {
  const gold_999 = 1_537_270_000n; // ₹153,727 / 10g

  test("RateToDisplayPaise_per10Gram_matchesPublishedQuote", () => {
    expect(rate_to_display_paise(gold_999, "per_10_gram")).toBe(15_372_700n);
  });

  test("RateToDisplayPaise_perGram_isOneTenthOfPer10Gram", () => {
    expect(rate_to_display_paise(gold_999, "per_gram")).toBe(1_537_270n);
  });

  test("RateToDisplayPaise_roundsSubPaiseExplicitly", () => {
    const silver = 23_690_800n; // 23,690.8 paise/g
    // Per gram the .8 must resolve; half_even on 23,690.8 → 23,691.
    expect(rate_to_display_paise(silver, "per_gram")).toBe(23_691n);
    // Per kg it is exact, so no rounding occurs.
    expect(rate_to_display_paise(silver, "per_kilogram")).toBe(23_690_800n);
  });
});

describe("to_rupees_string", () => {
  test("ToRupeesString_always2DecimalPlaces", () => {
    expect(to_rupees_string(15_372_700n)).toBe("153727.00");
    expect(to_rupees_string(1n)).toBe("0.01");
    expect(to_rupees_string(0n)).toBe("0.00");
    expect(to_rupees_string(10n)).toBe("0.10");
  });

  test("ToRupeesString_negative_keepsSignBeforeDigits", () => {
    expect(to_rupees_string(-125n)).toBe("-1.25");
  });

  test("ToRupeesString_indianGrouping_groupsLastThreeThenPairs", () => {
    expect(to_rupees_string(15_372_700n, true)).toBe("1,53,727.00");
    expect(to_rupees_string(100_000n, true)).toBe("1,000.00");
    expect(to_rupees_string(23_690_800n, true)).toBe("2,36,908.00");
  });

  test("ToRupeesString_veryLargeValue_losesNoPrecision", () => {
    // Far beyond Number.MAX_SAFE_INTEGER — a float would corrupt this.
    const huge = 9_007_199_254_740_993_00n;
    expect(to_rupees_string(huge)).toBe("9007199254740993.00");
  });
});

describe("exact rationals — calculation precision", () => {
  test("Rational_zeroDenominator_throws", () => {
    expect(() => rational(1n, 0n)).toThrow(MoneyError);
  });

  test("Rational_defaultDenominator_isOne", () => {
    expect(rational(5n)).toEqual({ num: 5n, den: 1n });
  });

  test("AddRational_sameDenominator_addsExactly", () => {
    expect(add_rational(rational(1n, 3n), rational(1n, 3n))).toEqual({
      num: 6n,
      den: 9n,
    });
  });

  /**
   * The property the pipeline depends on: a sum of rationals is exact, so the
   * result can be rounded once at the end rather than at each step.
   */
  test("AddRational_thirds_sumExactlyToOneWithoutRounding", () => {
    const third = rational(1n, 3n);
    const sum = add_rational(add_rational(third, third), third);
    expect(sum.num).toBe(sum.den); // exactly 1, with no rounding anywhere
  });

  test("ScaleRational_multipliesNumeratorOnly", () => {
    expect(scale_rational(rational(3n, 7n), 5n)).toEqual({ num: 15n, den: 7n });
  });

  test("RationalToRate_collapsesToStoragePrecision", () => {
    // 10/4 = 2.5 → half_even → 2
    expect(rational_to_rate(rational(10n, 4n))).toBe(2n);
    // 14/4 = 3.5 → half_even → 4
    expect(rational_to_rate(rational(14n, 4n))).toBe(4n);
  });

  test("RationalToDisplayPaise_convertsUnitAndQuantises", () => {
    // 1_537_270_000 milli-paise/g, per 10 g, to the paise
    const value = rational(1_537_270_000n, 1n);
    expect(rational_to_display_paise(value, "per_10_gram", 1n, "half_even")).toBe(
      15_372_700n,
    );
    // Same value quantised to the nearest ₹10
    expect(rational_to_display_paise(value, "per_10_gram", 1000n, "half_up")).toBe(
      15_373_000n,
    );
  });

  test("RationalToDisplayPaise_subPaiseValue_roundsExplicitly", () => {
    // 23_690_800 milli-paise/g = 23,690.8 paise/g
    const silver = rational(23_690_800n, 1n);
    expect(rational_to_display_paise(silver, "per_gram", 1n, "half_even")).toBe(
      23_691n,
    );
    // Per kg it is exact, so no rounding occurs.
    expect(rational_to_display_paise(silver, "per_kilogram", 1n, "half_even")).toBe(
      23_690_800n,
    );
  });
});

describe("rounding mode coverage", () => {
  test.each(ROUNDING_MODES)(
    "RoundingMode_%s_isImplementedAndTotal",
    (mode: RoundingMode) => {
      expect(typeof divide_and_round(7n, 2n, mode)).toBe("bigint");
    },
  );
});
