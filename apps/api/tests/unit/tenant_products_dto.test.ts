/**
 * Per-product display settings: defaults, merge order, and the one change that
 * invalidates a published rate.
 *
 * `requires_recompute` is the consequential function here. A stored
 * `rate_display_paise` is an amount *in* its display unit, so getting this
 * wrong either leaves customers reading a per-10g figure as per gram, or
 * republishes on a no-op and shows them a movement that never happened.
 */
import { describe, expect, test } from "vitest";
import {
  DISPLAY_UNITS,
  default_config,
  default_display_unit,
  merge_config,
  requires_recompute,
  update_product_request,
  type ProductConfig,
} from "../../src/modules/tenant/tenant_products_dto.js";

const parse = (input: unknown) => update_product_request.safeParse(input);

const stored = (overrides: Partial<ProductConfig> = {}): ProductConfig => ({
  is_enabled: true,
  display_unit: "per_10_gram",
  show_base_rate: false,
  display_order: 3,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe("the request schema", () => {
  test.each(DISPLAY_UNITS)("Schema_%s_isAccepted", (display_unit) => {
    expect(parse({ display_unit }).success).toBe(true);
  });

  test.each([
    ["an unknown unit", { display_unit: "per_tola" }],
    ["a unit in the wrong case", { display_unit: "PER_GRAM" }],
    ["a negative order", { display_order: -1 }],
    ["a fractional order", { display_order: 1.5 }],
    ["an order beyond the range", { display_order: 1000 }],
    ["a flag as a string", { is_enabled: "true" }],
    ["a price", { price: 100 }],
    ["a product id", { product_id: "00000000-0000-4000-8000-000000000000" }],
    ["a tenant id", { tenant_id: "00000000-0000-4000-8000-000000000000" }],
  ])("Schema_%s_isRefused", (_label, input) => {
    expect(parse(input).success).toBe(false);
  });

  test("Schema_severalFieldsAtOnce_isAccepted", () => {
    expect(
      parse({
        is_enabled: true,
        display_unit: "per_gram",
        show_base_rate: true,
        display_order: 0,
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("defaults", () => {
  /** Indian trade convention: gold by the tola-equivalent, silver by the kilo. */
  test.each([
    ["GOLD", "per_10_gram"],
    ["SILVER", "per_kilogram"],
    ["PLATINUM", "per_10_gram"],
  ])("Default_%s_isQuoted_%s", (metal, expected) => {
    expect(default_display_unit(metal)).toBe(expected);
  });

  /**
   * Both switches start off. A shop should not find itself quoting a metal it
   * does not deal in, nor publishing its margin, because a row appeared.
   */
  test("Default_config_startsOff", () => {
    const config = default_config("GOLD");

    expect(config.is_enabled).toBe(false);
    expect(config.show_base_rate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Merge order
// ---------------------------------------------------------------------------

describe("merging a change", () => {
  test("Merge_noStoredRow_takesDefaultsThenInput", () => {
    expect(merge_config("SILVER", null, { is_enabled: true })).toEqual({
      is_enabled: true,
      display_unit: "per_kilogram",
      show_base_rate: false,
      display_order: 0,
    });
  });

  test("Merge_storedRow_beatsDefaults", () => {
    expect(merge_config("GOLD", stored({ display_unit: "per_gram" }), {}).display_unit).toBe(
      "per_gram",
    );
  });

  test("Merge_input_beatsStoredRow", () => {
    expect(
      merge_config("GOLD", stored({ display_unit: "per_gram" }), {
        display_unit: "per_kilogram",
      }).display_unit,
    ).toBe("per_kilogram");
  });

  /** An untouched field keeps what the shop already chose. */
  test("Merge_absentField_keepsTheStoredValue", () => {
    const merged = merge_config("GOLD", stored({ display_order: 7 }), {
      show_base_rate: true,
    });

    expect(merged.display_order).toBe(7);
    expect(merged.is_enabled).toBe(true);
    expect(merged.show_base_rate).toBe(true);
  });

  /**
   * `false` and `0` must survive the `??` chain. With `||` they would fall
   * through to the stored value and a shopkeeper could never turn anything off.
   */
  test("Merge_false_isARealValueNotAnAbsence", () => {
    const merged = merge_config("GOLD", stored({ is_enabled: true }), { is_enabled: false });
    expect(merged.is_enabled).toBe(false);
  });

  test("Merge_zeroOrder_isARealValueNotAnAbsence", () => {
    const merged = merge_config("GOLD", stored({ display_order: 3 }), { display_order: 0 });
    expect(merged.display_order).toBe(0);
  });

  /** Every key present, so the result can create a row as well as update one. */
  test("Merge_alwaysProducesACompleteConfig", () => {
    expect(Object.keys(merge_config("GOLD", null, {})).sort()).toEqual([
      "display_order",
      "display_unit",
      "is_enabled",
      "show_base_rate",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The recompute decision
// ---------------------------------------------------------------------------

describe("when a published rate is invalidated", () => {
  test("Recompute_unitChanged_isRequired", () => {
    expect(requires_recompute(stored({ display_unit: "per_10_gram" }), {
      display_unit: "per_gram",
    })).toBe(true);
  });

  /**
   * Asking for the unit it already has is not a change. Republishing anyway
   * would show customers a rate movement that did not happen.
   */
  test("Recompute_sameUnit_isNotRequired", () => {
    expect(
      requires_recompute(stored({ display_unit: "per_10_gram" }), {
        display_unit: "per_10_gram",
      }),
    ).toBe(false);
  });

  test("Recompute_unitNotMentioned_isNotRequired", () => {
    expect(requires_recompute(stored(), { show_base_rate: true, is_enabled: false })).toBe(
      false,
    );
  });

  /**
   * `show_base_rate` is read at query time by `get_public_rates`, so nothing
   * stored goes stale and the next read already reflects the change.
   */
  test("Recompute_showBaseRate_neverRequiresOne", () => {
    expect(requires_recompute(stored(), { show_base_rate: true })).toBe(false);
    expect(requires_recompute(stored(), { show_base_rate: false })).toBe(false);
  });

  /**
   * No stored row means no published rate in a stale unit. The unit differs
   * from `undefined`, so this is reported as a change; the service finds no
   * pricing rule and does nothing, which is the same outcome either way.
   */
  test("Recompute_noStoredRow_reportsAChange", () => {
    expect(requires_recompute(null, { display_unit: "per_gram" })).toBe(true);
  });

  test("Recompute_emptyInput_isNotRequired", () => {
    expect(requires_recompute(stored(), {})).toBe(false);
  });
});
