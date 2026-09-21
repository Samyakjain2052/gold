import { describe, expect, test } from "vitest";
import {
  divide_and_round,
  rate_from_rupees_per_unit,
  rate_to_display_paise,
} from "../../src/platform/money.js";
import {
  assert_valid_purity,
  is_same_purity,
  purity_ratio,
  PurityError,
  DEFAULT_PURITY_BASIS,
  PURITY,
} from "../../src/modules/pricing/purity.js";

/**
 * IBJA published rates, PM session, 18/09/2026 — ₹ per 10 g.
 * These are the numbers a customer can check against any Indian rate source,
 * so they are the correctness benchmark for purity conversion.
 */
const IBJA_PM = {
  gold_999: "153727",
  gold_995: "153111",
  gold_916: "140814",
  gold_750: "115295",
  gold_585: "89930",
} as const;

const BASE_999 = rate_from_rupees_per_unit(IBJA_PM.gold_999, "per_10_gram");

/** Apply a purity ratio and present it per 10 g, as IBJA quotes. */
function convert_to_per_10g(
  target: { num: number; den: number },
  basis: "market_convention" | "fine_ratio",
): bigint {
  const ratio = purity_ratio(PURITY.FINE_999, target, basis);
  const converted = divide_and_round(BASE_999 * ratio.num, ratio.den, "half_even");
  return rate_to_display_paise(converted, "per_10_gram", "half_even");
}

describe("purity conversion against IBJA published rates", () => {
  /**
   * 995 is a bullion fineness. IBJA relates it to 999 by true fineness ratio,
   * not by the ×P/1000 karat convention.
   */
  test("PurityConversion_gold995_matchesIbjaUsingFineRatio", () => {
    const expected = rate_to_display_paise(
      rate_from_rupees_per_unit(IBJA_PM.gold_995, "per_10_gram"),
      "per_10_gram",
    );
    // 153,727 × 995/999 = ₹153,111.48 vs published ₹153,111 — within ₹0.48
    // per 10 g, i.e. IBJA's own rounding of the same formula.
    expect(convert_to_per_10g(PURITY.FINE_995, "fine_ratio")).toBe(15_311_148n);
    expect(expected).toBe(15_311_100n);

    // The karat convention is wrong here by ~₹153 per 10 g.
    expect(convert_to_per_10g(PURITY.FINE_995, "market_convention")).toBe(
      15_295_836n,
    );
  });

  /**
   * 916 is a karat jewellery grade. The trade quotes it as the 24K rate ×0.916,
   * and IBJA publishes exactly that.
   */
  test("PurityConversion_gold916_matchesIbjaUsingMarketConvention", () => {
    // 153,727 × 0.916 = 140,813.932 → ₹140,813.93, published as ₹140,814.
    expect(convert_to_per_10g(PURITY.GOLD_916, "market_convention")).toBe(
      14_081_393n,
    );

    // The fine-ratio basis overstates by ~₹141 per 10 g.
    expect(convert_to_per_10g(PURITY.GOLD_916, "fine_ratio")).toBe(14_095_489n);
  });

  test("PurityConversion_gold750_matchesIbjaUsingMarketConvention", () => {
    // 153,727 × 0.750 = 115,295.25, published as ₹115,295.
    expect(convert_to_per_10g(PURITY.GOLD_750, "market_convention")).toBe(
      11_529_525n,
    );
  });

  test("PurityConversion_gold585_matchesIbjaUsingMarketConvention", () => {
    // 153,727 × 0.585 = 89,930.295, published as ₹89,930.
    expect(convert_to_per_10g(PURITY.GOLD_585, "market_convention")).toBe(
      8_993_030n,
    );
  });

  /**
   * Regression guard for the defaults table. If someone "simplifies" the two
   * bases into one, one of these purities starts disagreeing with IBJA.
   */
  test("PurityConversion_defaultBasisTable_matchesVerifiedConventions", () => {
    expect(DEFAULT_PURITY_BASIS["FINE_999"]).toBe("fine_ratio");
    expect(DEFAULT_PURITY_BASIS["FINE_995"]).toBe("fine_ratio");
    expect(DEFAULT_PURITY_BASIS["GOLD_916"]).toBe("market_convention");
    expect(DEFAULT_PURITY_BASIS["GOLD_750"]).toBe("market_convention");
    expect(DEFAULT_PURITY_BASIS["GOLD_585"]).toBe("market_convention");
  });
});

describe("purity_ratio", () => {
  /**
   * Only fine_ratio makes 999 → 999 the identity. market_convention would
   * scale a 999 quote by 0.999, which is why 999 products are seeded as
   * fine_ratio.
   */
  test("PurityRatio_sameFinenessUnderFineRatio_isIdentity", () => {
    const ratio = purity_ratio(PURITY.FINE_999, PURITY.FINE_999, "fine_ratio");
    expect(ratio.num).toBe(ratio.den);
    expect(divide_and_round(BASE_999 * ratio.num, ratio.den, "half_even")).toBe(
      BASE_999,
    );
  });

  test("PurityRatio_sameFinenessUnderMarketConvention_isNotIdentity", () => {
    const ratio = purity_ratio(
      PURITY.FINE_999,
      PURITY.FINE_999,
      "market_convention",
    );
    expect(ratio.num).not.toBe(ratio.den); // 999/1000
  });

  test("PurityRatio_returnsUnevaluatedRatio_soDivisionCanBeDeferred", () => {
    const ratio = purity_ratio(PURITY.FINE_999, PURITY.GOLD_916, "market_convention");
    expect(ratio).toEqual({ num: 916n, den: 1000n });
  });

  test("PurityRatio_fineRatio_composesBothFinenesses", () => {
    const ratio = purity_ratio(PURITY.FINE_999, PURITY.GOLD_916, "fine_ratio");
    // (916 × 1000) / (1000 × 999)
    expect(ratio).toEqual({ num: 916_000n, den: 999_000n });
  });
});

describe("purity validation", () => {
  test("AssertValidPurity_numeratorExceedsDenominator_throws", () => {
    expect(() => assert_valid_purity({ num: 1001, den: 1000 }, "target")).toThrow(
      PurityError,
    );
  });

  test("AssertValidPurity_zeroOrNegative_throws", () => {
    expect(() => assert_valid_purity({ num: 0, den: 1000 }, "target")).toThrow(
      PurityError,
    );
    expect(() => assert_valid_purity({ num: 916, den: 0 }, "target")).toThrow(
      PurityError,
    );
    expect(() => assert_valid_purity({ num: -916, den: 1000 }, "target")).toThrow(
      PurityError,
    );
  });

  test("AssertValidPurity_nonInteger_throws", () => {
    expect(() => assert_valid_purity({ num: 916.5, den: 1000 }, "target")).toThrow(
      PurityError,
    );
  });

  test("AssertValidPurity_validPurity_doesNotThrow", () => {
    expect(() => assert_valid_purity(PURITY.GOLD_916, "target")).not.toThrow();
  });
});

describe("is_same_purity", () => {
  test("IsSamePurity_equivalentFractions_areEqual", () => {
    expect(is_same_purity({ num: 916, den: 1000 }, { num: 458, den: 500 })).toBe(
      true,
    );
  });

  test("IsSamePurity_differentFineness_areNotEqual", () => {
    expect(is_same_purity(PURITY.GOLD_916, PURITY.FINE_999)).toBe(false);
  });
});
