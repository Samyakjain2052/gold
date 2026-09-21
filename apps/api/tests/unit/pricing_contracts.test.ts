/**
 * Request contracts and idempotency fingerprinting — the pure parts.
 *
 * These schemas are the security boundary for request bodies, so they are
 * tested directly rather than only through HTTP. The interesting cases are all
 * negative: what must be refused.
 */
import { describe, expect, test } from "vitest";
import {
  create_pricing_rule_request,
  list_audit_query,
  update_pricing_rule_request,
} from "../../src/modules/pricing/pricing_rule_dto.js";
import {
  assert_valid_key,
  fingerprint_request,
} from "../../src/modules/idempotency/idempotency_service.js";
import {
  milli_paise_to_rupee_string,
  rupee_string_to_milli_paise,
} from "../../src/modules/pricing/pricing_rule_service.js";

const PRODUCT = "9f381372-68b5-4d68-b500-9ecf8dba477a";
const DISPLAY = {
  rounding_step_paise: 100,
  rounding_mode: "half_up",
  component_precision_paise: 1,
} as const;

const valid_absolute = {
  product_id: PRODUCT,
  adjustment_kind: "absolute",
  adjustment_rupees_per_gram: "50",
  ...DISPLAY,
};

describe("create request schema", () => {
  test("Create_validAbsoluteRule_isAccepted", () => {
    expect(create_pricing_rule_request.safeParse(valid_absolute).success).toBe(true);
  });

  test("Create_validPercentageRule_isAccepted", () => {
    const parsed = create_pricing_rule_request.safeParse({
      product_id: PRODUCT,
      adjustment_kind: "percentage",
      adjustment_bps: 300,
      ...DISPLAY,
    });
    expect(parsed.success).toBe(true);
  });

  /**
   * The security control. These fields are not in the schema, and `.strict()`
   * turns supplying them into a rejection rather than a silent drop — a
   * dropped field could be picked up later by a careless spread.
   */
  test.each([
    "tenant_id",
    "tenantId",
    "user_id",
    "role",
    "created_by",
    "updated_by",
    "version",
    "id",
    "is_active",
    "__proto__x",
  ])("Create_unknownField_%s_isRejected", (field) => {
    const parsed = create_pricing_rule_request.safeParse({
      ...valid_absolute,
      [field]: "anything",
    });
    expect(parsed.success).toBe(false);
  });

  /** An absolute rule must not carry basis points, or vice versa. */
  test("Create_mixedAdjustmentFields_areRejected", () => {
    expect(
      create_pricing_rule_request.safeParse({ ...valid_absolute, adjustment_bps: 300 })
        .success,
    ).toBe(false);

    expect(
      create_pricing_rule_request.safeParse({
        product_id: PRODUCT,
        adjustment_kind: "percentage",
        adjustment_bps: 300,
        adjustment_rupees_per_gram: "50",
        ...DISPLAY,
      }).success,
    ).toBe(false);
  });

  /**
   * A JSON number is an IEEE-754 double by the time it is parsed. The whole
   * pricing architecture exists to keep floats out of money, so the wire format
   * is a decimal string.
   */
  test("Create_adjustmentAsANumber_isRejected", () => {
    for (const value of [50, 50.07, 0]) {
      expect(
        create_pricing_rule_request.safeParse({
          ...valid_absolute,
          adjustment_rupees_per_gram: value,
        }).success,
        String(value),
      ).toBe(false);
    }
  });

  test.each(["50.071", "abc", "", "1e5", "0x10", " 50", "50 ", "٥٠"])(
    "Create_malformedAmount_%s_isRejected",
    (amount) => {
      expect(
        create_pricing_rule_request.safeParse({
          ...valid_absolute,
          adjustment_rupees_per_gram: amount,
        }).success,
      ).toBe(false);
    },
  );

  test.each(["50", "50.0", "50.07", "-1.50", "0", "0.01"])(
    "Create_wellFormedAmount_%s_isAccepted",
    (amount) => {
      expect(
        create_pricing_rule_request.safeParse({
          ...valid_absolute,
          adjustment_rupees_per_gram: amount,
        }).success,
      ).toBe(true);
    },
  );

  test.each([10_001, -10_001, 1.5, Number.NaN])(
    "Create_basisPointsOutOfRange_%s_isRejected",
    (bps) => {
      expect(
        create_pricing_rule_request.safeParse({
          product_id: PRODUCT,
          adjustment_kind: "percentage",
          adjustment_bps: bps,
          ...DISPLAY,
        }).success,
      ).toBe(false);
    },
  );

  test.each([3, 7, 0, -100, 99_999])(
    "Create_unsupportedRoundingStep_%s_isRejected",
    (step) => {
      expect(
        create_pricing_rule_request.safeParse({
          ...valid_absolute,
          rounding_step_paise: step,
        }).success,
      ).toBe(false);
    },
  );

  test("Create_unknownRoundingMode_isRejected", () => {
    expect(
      create_pricing_rule_request.safeParse({
        ...valid_absolute,
        rounding_mode: "half_sideways",
      }).success,
    ).toBe(false);
  });

  test("Create_malformedProductId_isRejected", () => {
    expect(
      create_pricing_rule_request.safeParse({ ...valid_absolute, product_id: "nope" })
        .success,
    ).toBe(false);
  });

  test("Create_missingProductId_isRejected", () => {
    const { product_id: _omitted, ...without } = valid_absolute;
    expect(create_pricing_rule_request.safeParse(without).success).toBe(false);
  });
});

describe("update request schema", () => {
  /** A rule's product is its identity; changing it would be a different rule. */
  test("Update_productId_isNotAcceptedAsAField", () => {
    expect(
      update_pricing_rule_request.safeParse({
        product_id: PRODUCT,
        adjustment_kind: "absolute",
        adjustment_rupees_per_gram: "50",
        ...DISPLAY,
      }).success,
    ).toBe(false);
  });

  test("Update_fullPricingBlock_isAccepted", () => {
    expect(
      update_pricing_rule_request.safeParse({
        adjustment_kind: "absolute",
        adjustment_rupees_per_gram: "50",
        ...DISPLAY,
      }).success,
    ).toBe(true);
  });

  /**
   * A partial update of a discriminated union invites a rule that claims
   * `percentage` while retaining a stale absolute amount.
   */
  test("Update_partialPricingBlock_isRejected", () => {
    expect(
      update_pricing_rule_request.safeParse({
        adjustment_kind: "absolute",
        adjustment_rupees_per_gram: "50",
      }).success,
    ).toBe(false);
  });
});

describe("audit query schema", () => {
  test("AuditQuery_defaults_areApplied", () => {
    const parsed = list_audit_query.safeParse({});
    expect(parsed.success && parsed.data.limit).toBe(25);
  });

  test("AuditQuery_limitBounds_areEnforced", () => {
    expect(list_audit_query.safeParse({ limit: 0 }).success).toBe(false);
    expect(list_audit_query.safeParse({ limit: 101 }).success).toBe(false);
    expect(list_audit_query.safeParse({ limit: 100 }).success).toBe(true);
  });

  test("AuditQuery_unknownParameter_isRejected", () => {
    expect(list_audit_query.safeParse({ tenant_id: "x" }).success).toBe(false);
  });

  test("AuditQuery_malformedCursor_isRejected", () => {
    expect(list_audit_query.safeParse({ cursor: "abc" }).success).toBe(false);
    expect(list_audit_query.safeParse({ cursor: "-1" }).success).toBe(false);
    expect(list_audit_query.safeParse({ cursor: "42" }).success).toBe(true);
  });
});

describe("money round trip on the wire", () => {
  test.each([
    ["50", 5_000_000n, "50.00"],
    ["50.07", 5_007_000n, "50.07"],
    ["0.01", 1_000n, "0.01"],
    ["-1.50", -150_000n, "-1.50"],
    ["0", 0n, "0.00"],
    ["99999.99", 9_999_999_000n, "99999.99"],
  ])("Money_%s_roundTripsExactly", (input, expected_milli, expected_out) => {
    const milli = rupee_string_to_milli_paise(input);
    expect(milli).toBe(expected_milli);
    expect(milli_paise_to_rupee_string(milli)).toBe(expected_out);
  });

  /** Integer arithmetic throughout — no float in the conversion path. */
  test("Money_largeValue_losesNoPrecision", () => {
    const milli = 9_999_999_000n;
    expect(milli_paise_to_rupee_string(milli)).toBe("99999.99");
  });

  test("Money_negativeSubRupee_keepsItsSign", () => {
    expect(milli_paise_to_rupee_string(-50_000n)).toBe("-0.50");
  });
});

describe("idempotency key validation", () => {
  test("Key_wellFormed_isAccepted", () => {
    expect(() => assert_valid_key("create-rule-2026-09-20-001")).not.toThrow();
  });

  /** Short keys collide by accident, which is worse than no key at all. */
  test("Key_tooShort_isRejected", () => {
    expect(() => assert_valid_key("abc")).toThrow(/8-200/);
  });

  test("Key_tooLong_isRejected", () => {
    expect(() => assert_valid_key("x".repeat(201))).toThrow(/8-200/);
  });

  test.each(["has space", "has/slash", "has;semi", "has\nnewline", "emoji😀key"])(
    "Key_illegalCharacters_%s_isRejected",
    (key) => {
      expect(() => assert_valid_key(key)).toThrow();
    },
  );
});

describe("request fingerprinting", () => {
  const body = { adjustment_kind: "absolute", adjustment_rupees_per_gram: "50" };

  test("Fingerprint_identicalRequests_match", () => {
    expect(fingerprint_request("POST", "/rules", body)).toBe(
      fingerprint_request("POST", "/rules", body),
    );
  });

  /**
   * A retry may serialise its JSON in a different key order. Treating that as a
   * different request would turn a legitimate retry into a 409.
   */
  test("Fingerprint_reorderedKeys_stillMatch", () => {
    const reordered = {
      adjustment_rupees_per_gram: "50",
      adjustment_kind: "absolute",
    };
    expect(fingerprint_request("POST", "/rules", body)).toBe(
      fingerprint_request("POST", "/rules", reordered),
    );
  });

  test("Fingerprint_nestedReorderedKeys_stillMatch", () => {
    const a = { outer: { x: 1, y: 2 }, list: [1, 2] };
    const b = { list: [1, 2], outer: { y: 2, x: 1 } };
    expect(fingerprint_request("POST", "/r", a)).toBe(fingerprint_request("POST", "/r", b));
  });

  /** Array order IS meaningful and must not be normalised away. */
  test("Fingerprint_reorderedArray_differs", () => {
    expect(fingerprint_request("POST", "/r", { list: [1, 2] })).not.toBe(
      fingerprint_request("POST", "/r", { list: [2, 1] }),
    );
  });

  test.each([
    ["different value", { ...body, adjustment_rupees_per_gram: "51" }],
    ["extra field", { ...body, extra: true }],
    ["missing field", { adjustment_kind: "absolute" }],
  ])("Fingerprint_%s_differs", (_label, other) => {
    expect(fingerprint_request("POST", "/rules", body)).not.toBe(
      fingerprint_request("POST", "/rules", other),
    );
  });

  test("Fingerprint_differentPathOrMethod_differs", () => {
    expect(fingerprint_request("POST", "/rules", body)).not.toBe(
      fingerprint_request("POST", "/other", body),
    );
    expect(fingerprint_request("POST", "/rules", body)).not.toBe(
      fingerprint_request("PATCH", "/rules", body),
    );
  });

  test("Fingerprint_methodCaseIsNormalised", () => {
    expect(fingerprint_request("post", "/rules", body)).toBe(
      fingerprint_request("POST", "/rules", body),
    );
  });
});
