/**
 * Display formatting of server-computed money.
 *
 * The rule this file exists to protect: the browser formats, it never
 * calculates. These tests also pin the exactness — a value large enough to lose
 * precision as a double must survive formatting unchanged, because the whole
 * backend was built to avoid exactly that loss.
 */
import { describe, expect, test } from "vitest";
import {
  format_adjustment,
  format_paise,
  format_rupees,
  format_unit,
  group_indian,
  humanise_product_key,
  split_paise,
  UNAVAILABLE,
} from "@/lib/money";

describe("format_rupees", () => {
  test.each([
    ["14081393", "₹1,40,813.93"],
    ["5000", "₹50.00"],
    ["100", "₹1.00"],
    ["1", "₹0.01"],
    ["0", "₹0.00"],
    ["99", "₹0.99"],
  ])("FormatRupees_%s_rendersAs_%s", (paise, expected) => {
    expect(format_rupees(paise)).toBe(expected);
  });

  /** Indian grouping: last three, then pairs. Not the western thousands. */
  test("FormatRupees_largeValue_usesIndianGrouping", () => {
    expect(format_rupees("2369080000")).toBe("₹2,36,90,800.00");
    expect(group_indian("23690800")).toBe("2,36,90,800");
  });

  /**
   * 9007199254740993 paise exceeds Number.MAX_SAFE_INTEGER. If any step routed
   * this through a double it would come back as ...92, silently.
   */
  test("FormatRupees_beyondMaxSafeInteger_isExact", () => {
    // As a double this value rounds to ...92, losing the final paisa.
    expect(Number("9007199254740993").toString()).toBe("9007199254740992");
    expect(format_paise("9007199254740993")).toBe("9,00,71,99,25,47,409.93");
  });

  test("FormatRupees_negative_keepsSign", () => {
    expect(format_rupees("-2500")).toBe("₹-25.00");
  });
});

describe("unparseable values", () => {
  /**
   * A missing or malformed rate must never render as ₹0.00 — a customer would
   * read that as "this shop is selling gold for nothing" rather than "we do not
   * have a price".
   */
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["a float", "12.34"],
    ["text", "abc"],
    ["a number-like object", "12e4"],
    ["whitespace", "   "],
  ])("Format_%s_rendersUnavailableNotZero", (_label, value) => {
    expect(format_rupees(value as string | null | undefined)).toBe(UNAVAILABLE);
    expect(format_rupees(value as string | null | undefined)).not.toContain("0.00");
  });

  test("SplitPaise_malformed_isNull", () => {
    expect(split_paise("nope")).toBeNull();
    expect(split_paise(null)).toBeNull();
  });
});

describe("format_adjustment", () => {
  /** A shop's markup must read as a markup, not as a price. */
  test("Adjustment_positive_carriesAPlus", () => {
    expect(format_adjustment("5000")).toBe("+₹50.00");
  });

  test("Adjustment_negative_carriesAMinus", () => {
    expect(format_adjustment("-5000")).toBe("−₹50.00");
  });

  test("Adjustment_zero_hasNoSign", () => {
    expect(format_adjustment("0")).toBe("₹0.00");
  });

  test("Adjustment_unparseable_isUnavailable", () => {
    expect(format_adjustment("x")).toBe(UNAVAILABLE);
  });
});

describe("labels", () => {
  test("Humanise_productKey_readsAsWords", () => {
    expect(humanise_product_key("GOLD_916")).toBe("Gold 916");
    expect(humanise_product_key("SILVER_999")).toBe("Silver 999");
  });

  test("Humanise_unexpectedKey_isReturnedIntact", () => {
    expect(humanise_product_key("GOLD")).toBe("Gold");
  });

  /**
   * The enum already contains the preposition. Getting this wrong rendered
   * "per per_10_gram" on the live page.
   */
  test.each([
    ["per_gram", "per gram"],
    ["per_10_gram", "per 10 grams"],
    ["per_kilogram", "per kilogram"],
  ])("FormatUnit_%s_readsAs_%s", (unit, expected) => {
    expect(format_unit(unit)).toBe(expected);
  });

  test("FormatUnit_neverDoublesThePreposition", () => {
    for (const unit of ["per_gram", "per_10_gram", "per_kilogram"]) {
      expect(format_unit(unit)).not.toMatch(/per per/);
    }
  });

  test("FormatUnit_unknownUnit_isStillReadable", () => {
    expect(format_unit("per_tola")).toBe("per tola");
  });
});

/**
 * There is deliberately no exported function that derives an adjustment from a
 * rate and a market rate. This asserts the module's surface, so adding one
 * becomes a conscious decision with a failing test attached.
 */
describe("the module computes nothing", () => {
  test("Money_exportsNoArithmeticHelpers", async () => {
    const module = await import("@/lib/money");
    const names = Object.keys(module);

    for (const forbidden of ["derive_adjustment", "add", "subtract", "compute_rate", "apply_adjustment"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});
