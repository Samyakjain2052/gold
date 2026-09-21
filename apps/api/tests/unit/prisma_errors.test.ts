/**
 * Constraint identification.
 *
 * Prisma reports every unique violation as `P2002`, so the difference between
 * "an active rule already exists" and any other conflict lives entirely in the
 * constraint name. Getting this wrong means either a `500` for a real conflict
 * or — worse — an unrelated failure disguised as an expected one.
 *
 * The fixtures below are **verbatim** captures from the running driver, not
 * invented shapes.
 */
import { describe, expect, test } from "vitest";
import {
  is_unique_violation,
  unique_constraint_name,
  violates_constraint,
  CONSTRAINTS,
  UNIQUE_VIOLATION,
} from "../../src/platform/prisma_errors.js";

/** Captured from @prisma/adapter-pg against the real database. */
function driver_adapter_error(index: string, table: string) {
  return {
    code: UNIQUE_VIOLATION,
    meta: {
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "23505",
          originalMessage: `duplicate key value violates unique constraint "${index}"`,
          kind: "UniqueConstraintViolation",
          constraint: { index },
          table,
        },
      },
      modelName: table,
    },
  };
}

/** The classic engine shape, still handled for robustness. */
function classic_error(target: string | string[]) {
  return { code: UNIQUE_VIOLATION, meta: { target } };
}

describe("is_unique_violation", () => {
  test("IsUniqueViolation_p2002_isTrue", () => {
    expect(is_unique_violation({ code: "P2002" })).toBe(true);
  });

  test.each([
    ["a different Prisma code", { code: "P2003" }],
    ["a plain Error", new Error("boom")],
    ["null", null],
    ["undefined", undefined],
    ["a string", "P2002"],
  ])("IsUniqueViolation_%s_isFalse", (_label, error) => {
    expect(is_unique_violation(error)).toBe(false);
  });
});

describe("unique_constraint_name", () => {
  test("ConstraintName_driverAdapterShape_isExtracted", () => {
    const error = driver_adapter_error(
      "uq_tenant_pricing_rules_active",
      "tenant_pricing_rules",
    );
    expect(unique_constraint_name(error)).toBe("uq_tenant_pricing_rules_active");
  });

  test("ConstraintName_classicTargetString_isExtracted", () => {
    expect(unique_constraint_name(classic_error("uq_users_email"))).toBe(
      "uq_users_email",
    );
  });

  test("ConstraintName_classicTargetArray_isJoined", () => {
    expect(unique_constraint_name(classic_error(["tenant_id", "product_id"]))).toBe(
      "tenant_id,product_id",
    );
  });

  /** Anything unrecognised yields null so the original error propagates. */
  test.each([
    ["a non-unique error", { code: "P2025", meta: {} }],
    ["no meta", { code: "P2002" }],
    ["empty meta", { code: "P2002", meta: {} }],
    ["a plain Error", new Error("boom")],
    ["null", null],
  ])("ConstraintName_%s_isNull", (_label, error) => {
    expect(unique_constraint_name(error)).toBeNull();
  });
});

describe("violates_constraint", () => {
  const pricing = driver_adapter_error(
    CONSTRAINTS.active_pricing_rule,
    "tenant_pricing_rules",
  );
  const email = driver_adapter_error("uq_users_email", "users");
  const idempotency = driver_adapter_error(
    CONSTRAINTS.idempotency_key,
    "idempotency_keys",
  );

  test("Violates_matchingConstraint_isTrue", () => {
    expect(violates_constraint(pricing, CONSTRAINTS.active_pricing_rule)).toBe(true);
    expect(violates_constraint(idempotency, CONSTRAINTS.idempotency_key)).toBe(true);
  });

  /**
   * The case that motivated this module: an unrelated unique violation must not
   * be reported as a duplicate pricing rule.
   */
  test("Violates_unrelatedUniqueViolation_isNotThePricingConstraint", () => {
    expect(violates_constraint(email, CONSTRAINTS.active_pricing_rule)).toBe(false);
    expect(violates_constraint(idempotency, CONSTRAINTS.active_pricing_rule)).toBe(false);
  });

  test("Violates_pricingConstraint_isNotTheIdempotencyConstraint", () => {
    // Before the fix, run_mutation mapped every P2002 to the idempotency
    // message, which would have disguised this one.
    expect(violates_constraint(pricing, CONSTRAINTS.idempotency_key)).toBe(false);
  });

  test("Violates_nonUniqueError_isFalse", () => {
    expect(violates_constraint(new Error("boom"), CONSTRAINTS.active_pricing_rule)).toBe(
      false,
    );
  });

  test("Constraints_matchTheNamesInTheMigrations", () => {
    // These strings must track the SQL exactly; a rename in one place without
    // the other silently disables the mapping.
    expect(CONSTRAINTS.active_pricing_rule).toBe("uq_tenant_pricing_rules_active");
    expect(CONSTRAINTS.idempotency_key).toBe("pk_idempotency_keys");
  });
});
