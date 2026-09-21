/**
 * Direct tests for the adjustment module.
 *
 * The central property: `adjustment_amount` derives the adjustment from the
 * *rule*, so an absolute margin is independent of the base rate and survives
 * every downstream rounding decision unchanged.
 */
import { describe, expect, test } from "vitest";
import { rational, rational_to_rate } from "../../src/platform/money.js";
import {
  absolute_rupees_per_gram,
  adjustment_amount,
  apply_adjustment,
  assert_valid_adjustment,
  percentage,
  AdjustmentError,
  BPS_SCALE,
  MAX_ABSOLUTE_ADJUSTMENT,
  MAX_ADJUSTMENT_BPS,
  NO_ADJUSTMENT,
} from "../../src/modules/pricing/adjustment.js";

/** Gold 916 at IBJA PM 18/09/2026, in milli-paise per gram. */
const BASE = rational(1_408_139_320n, 1n);

describe("adjustment_amount", () => {
  test("AdjustmentAmount_absolute_equalsConfiguredValueExactly", () => {
    const amount = adjustment_amount(BASE, absolute_rupees_per_gram(50));
    expect(rational_to_rate(amount)).toBe(5_000_000n); // ₹50.00000/g
  });

  /** An absolute margin is a fixed amount, not a function of the metal price. */
  test("AdjustmentAmount_absolute_isIndependentOfBase", () => {
    const rule = absolute_rupees_per_gram(50);
    const cheap = adjustment_amount(rational(1n, 1n), rule);
    const dear = adjustment_amount(rational(999_999_999_999n, 1n), rule);
    expect(rational_to_rate(cheap)).toBe(rational_to_rate(dear));
  });

  test("AdjustmentAmount_percentage_scalesWithBase", () => {
    const amount = adjustment_amount(BASE, percentage(3));
    // 1_408_139_320 × 300 / 10000 = 42_244_179.6 → half_even → 42_244_180
    expect(rational_to_rate(amount)).toBe(42_244_180n);
  });

  test("AdjustmentAmount_percentage_isExactBeforeRounding", () => {
    const amount = adjustment_amount(BASE, percentage(3));
    // Kept unevaluated: numerator/denominator, not a pre-rounded integer.
    expect(amount.num).toBe(1_408_139_320n * 300n);
    expect(amount.den).toBe(BPS_SCALE);
  });

  test("AdjustmentAmount_zeroPercent_isZero", () => {
    expect(rational_to_rate(adjustment_amount(BASE, percentage(0)))).toBe(0n);
  });

  test("AdjustmentAmount_negativeAbsolute_isNegative", () => {
    const amount = adjustment_amount(BASE, absolute_rupees_per_gram("-1"));
    expect(rational_to_rate(amount)).toBe(-100_000n);
  });

  test("AdjustmentAmount_noAdjustment_isZero", () => {
    expect(rational_to_rate(adjustment_amount(BASE, NO_ADJUSTMENT))).toBe(0n);
  });
});

describe("apply_adjustment", () => {
  test("ApplyAdjustment_absolute_addsExactly", () => {
    const result = apply_adjustment(BASE, absolute_rupees_per_gram(50));
    expect(rational_to_rate(result)).toBe(1_413_139_320n);
  });

  test("ApplyAdjustment_isBasePlusAmount", () => {
    for (const rule of [
      absolute_rupees_per_gram(50),
      absolute_rupees_per_gram("-1"),
      percentage(3),
      NO_ADJUSTMENT,
    ]) {
      const amount = adjustment_amount(BASE, rule);
      const total = apply_adjustment(BASE, rule);
      expect(rational_to_rate(total)).toBe(
        rational_to_rate(BASE) + rational_to_rate(amount),
      );
    }
  });

  test("ApplyAdjustment_percentage_multipliesBase", () => {
    const result = apply_adjustment(BASE, percentage(3));
    // 1_408_139_320 × 1.03 = 1_450_383_499.6 → half_even → 1_450_383_500
    expect(rational_to_rate(result)).toBe(1_450_383_500n);
  });
});

describe("assert_valid_adjustment", () => {
  test("AssertValidAdjustment_withinBounds_doesNotThrow", () => {
    expect(() =>
      assert_valid_adjustment({
        kind: "absolute",
        milli_paise_per_gram: MAX_ABSOLUTE_ADJUSTMENT,
      }),
    ).not.toThrow();
    expect(() =>
      assert_valid_adjustment({ kind: "percentage", bps: MAX_ADJUSTMENT_BPS }),
    ).not.toThrow();
  });

  test("AssertValidAdjustment_absoluteBeyondBounds_throws", () => {
    expect(() =>
      assert_valid_adjustment({
        kind: "absolute",
        milli_paise_per_gram: MAX_ABSOLUTE_ADJUSTMENT + 1n,
      }),
    ).toThrow(AdjustmentError);
    expect(() =>
      assert_valid_adjustment({
        kind: "absolute",
        milli_paise_per_gram: -(MAX_ABSOLUTE_ADJUSTMENT + 1n),
      }),
    ).toThrow(AdjustmentError);
  });

  test("AssertValidAdjustment_absoluteNotBigint_throws", () => {
    expect(() =>
      assert_valid_adjustment({
        kind: "absolute",
        milli_paise_per_gram: 500 as unknown as bigint,
      }),
    ).toThrow(AdjustmentError);
  });

  test("AssertValidAdjustment_bpsBeyondBounds_throws", () => {
    expect(() =>
      assert_valid_adjustment({ kind: "percentage", bps: MAX_ADJUSTMENT_BPS + 1 }),
    ).toThrow(AdjustmentError);
  });

  test("AssertValidAdjustment_nonIntegerBps_throws", () => {
    expect(() =>
      assert_valid_adjustment({ kind: "percentage", bps: 12.5 }),
    ).toThrow(AdjustmentError);
  });
});

describe("constructors", () => {
  test("AbsoluteRupeesPerGram_wholeNumber_scalesToMilliPaise", () => {
    expect(absolute_rupees_per_gram(50).kind).toBe("absolute");
    expect(absolute_rupees_per_gram(50)).toEqual({
      kind: "absolute",
      milli_paise_per_gram: 5_000_000n,
    });
  });

  test("AbsoluteRupeesPerGram_oneDecimal_isPaddedToPaise", () => {
    // ₹2.5/g = 250 paise = 250,000 milli-paise
    expect(absolute_rupees_per_gram("2.5")).toEqual({
      kind: "absolute",
      milli_paise_per_gram: 250_000n,
    });
  });

  test("AbsoluteRupeesPerGram_zero_isNoAdjustment", () => {
    expect(absolute_rupees_per_gram(0)).toEqual(NO_ADJUSTMENT);
  });

  test("AbsoluteRupeesPerGram_malformed_throws", () => {
    for (const bad of ["abc", "", "1.2.3", "₹50"]) {
      expect(() => absolute_rupees_per_gram(bad)).toThrow(AdjustmentError);
    }
  });

  test("Percentage_negative_convertsToNegativeBps", () => {
    expect(percentage(-1.5)).toEqual({ kind: "percentage", bps: -150 });
  });

  test("Percentage_hundredths_areRepresentable", () => {
    expect(percentage(0.01)).toEqual({ kind: "percentage", bps: 1 });
  });
});
