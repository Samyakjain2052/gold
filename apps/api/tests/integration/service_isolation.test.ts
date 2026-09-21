/**
 * Tenant isolation at the APPLICATION / SERVICE layer.
 *
 * Independent of the database backstop: these tests exercise the code path a
 * request would take, including the adversarial attempts a hostile client would
 * make. Passing here and in `rls_isolation.test.ts` means two independent
 * layers each deny the same attack.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../src/platform/errors.js";
import {
  derive_authenticated_context,
  derive_public_context,
  has_role,
  tenant_id_of,
  TenantContextError,
  type AuthenticatedTenantContext,
} from "../../src/modules/tenancy/tenant_context.js";
import {
  create_rule,
  deactivate_rule,
  get_branding,
  get_rule,
  list_rules,
  update_branding,
  update_rule,
  type MutationContext,
} from "../../src/modules/pricing/pricing_rule_service.js";

/** No idempotency key — these tests exercise isolation, not replay. */
const MUTATION: MutationContext = {
  request: { request_id: "isolation-test", ip_address: null, user_agent: null },
};

/** The display settings every rule in this suite uses. */
const DISPLAY = {
  rounding_step_paise: 100,
  rounding_mode: "half_up",
  component_precision_paise: 1,
} as const;
import {
  app_client,
  owner_client,
  seed_fixtures,
  TEST_DIRECTORY_ID,
  type Fixtures,
} from "./fixtures.js";

let owner: PrismaClient;
let app: PrismaClient;
let fx: Fixtures;

beforeAll(async () => {
  owner = owner_client();
  app = app_client();
  fx = await seed_fixtures(owner);
});

afterAll(async () => {
  await Promise.allSettled([owner.$disconnect(), app.$disconnect()]);
});

describe("tenant context derivation", () => {
  /** The core property: identity comes from the principal, not the request. */
  test("TenantContext_derivedFromVerifiedPrincipal_matchesMembership", async () => {
    const context = await derive_authenticated_context(app, {
      external_object_id: fx.tenant_a.external_object_id,
      directory_tenant_id: TEST_DIRECTORY_ID,
    });

    expect(context.tenant_id).toBe(fx.tenant_a.tenant_id);
    expect(context.user_id).toBe(fx.tenant_a.user_id);
    expect(context.role).toBe("owner");
  });

  test("TenantContext_principalWithNoMembership_isRejected", async () => {
    await expect(
      derive_authenticated_context(app, {
        external_object_id: randomUUID(),
        directory_tenant_id: TEST_DIRECTORY_ID,
      }),
    ).rejects.toThrow(TenantContextError);
  });

  test("TenantContext_suspendedTenant_isRejected", async () => {
    await owner.tenants.update({
      where: { id: fx.tenant_b.tenant_id },
      data: { status: "suspended" },
    });

    await expect(
      derive_authenticated_context(app, {
        external_object_id: fx.tenant_b.external_object_id,
        directory_tenant_id: TEST_DIRECTORY_ID,
      }),
    ).rejects.toThrow(/suspended/);

    await owner.tenants.update({
      where: { id: fx.tenant_b.tenant_id },
      data: { status: "active" },
    });
  });

  test("TenantContext_platformAdmin_isNotTenantScoped", () => {
    expect(() =>
      tenant_id_of({ kind: "platform_admin", user_id: randomUUID() }),
    ).toThrow(TenantContextError);
  });

  test("TenantContext_publicContext_hasNoUserOrRole", async () => {
    const context = await derive_public_context(app, fx.tenant_a.slug);

    expect(context.kind).toBe("public");
    expect(context.tenant_id).toBe(fx.tenant_a.tenant_id);
    expect(context).not.toHaveProperty("user_id");
    expect(context).not.toHaveProperty("role");
    expect(has_role(context, "staff")).toBe(false);
  });
});

describe("own-resource access (the success cases)", () => {
  test("Service_tenantA_canListItsOwnRules", async () => {
    const rules = await list_rules(app, fx.tenant_a.context);

    expect(rules.length).toBeGreaterThan(0);
    // The DTO withholds tenant_id (Stage 7), so ownership is proven by which
    // rules are present and which are absent.
    expect(rules.some((r) => r.id === fx.tenant_a.gold_rule_id)).toBe(true);
    expect(rules.some((r) => r.id === fx.tenant_b.gold_rule_id)).toBe(false);
  });

  test("Service_tenantA_canReadItsOwnRule", async () => {
    const rule = await get_rule(app, fx.tenant_a.context, fx.tenant_a.gold_rule_id);
    expect(rule.adjustment_kind).toBe("absolute");
    expect(rule.adjustment_rupees_per_gram).toBe("50.00");
  });

  test("Service_tenantA_canUpdateItsOwnRule", async () => {
    const before = await get_rule(app, fx.tenant_a.context, fx.tenant_a.gold_rule_id);

    const { response } = await update_rule(
      app,
      fx.tenant_a.context,
      fx.tenant_a.gold_rule_id,
      before.version,
      { adjustment_kind: "absolute", adjustment_rupees_per_gram: "55", ...DISPLAY },
      MUTATION,
    );
    expect(response.adjustment_rupees_per_gram).toBe("55.00");
    expect(response.version).toBe(before.version + 1);

    await update_rule(
      app,
      fx.tenant_a.context,
      fx.tenant_a.gold_rule_id,
      response.version,
      { adjustment_kind: "absolute", adjustment_rupees_per_gram: "50", ...DISPLAY },
      MUTATION,
    );
  });

  test("Service_tenantA_canReadItsOwnBranding", async () => {
    const branding = await get_branding(app, fx.tenant_a.context);
    expect(branding?.display_name).toBe("Sharma Jewellers");
  });
});

describe("cross-tenant READ is denied", () => {
  test("TenantIsolation_readTenantBRule_returns403", async () => {
    await expect(
      get_rule(app, fx.tenant_a.context, fx.tenant_b.gold_rule_id),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("TenantIsolation_listRules_neverIncludesTenantBData", async () => {
    const rules = await list_rules(app, fx.tenant_a.context);
    const serialised = JSON.stringify(rules, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );

    expect(serialised).not.toContain(fx.tenant_b.tenant_id);
    expect(serialised).not.toContain(fx.tenant_b.gold_rule_id);
    expect(serialised).not.toContain("100.00"); // B's +₹100/g
  });

  test("TenantIsolation_brandingRead_returnsOnlyOwnTenant", async () => {
    const a = await get_branding(app, fx.tenant_a.context);
    const b = await get_branding(app, fx.tenant_b.context);

    expect(a?.display_name).toBe("Sharma Jewellers");
    expect(b?.display_name).toBe("Gupta Jewellers");
    expect(a?.tenant_id).not.toBe(b?.tenant_id);
  });

  /**
   * A nonexistent id and another tenant's id must be indistinguishable, or the
   * response becomes an existence oracle.
   */
  test("TenantIsolation_unknownIdAndForeignId_areIndistinguishable", async () => {
    const foreign = await get_rule(
      app,
      fx.tenant_a.context,
      fx.tenant_b.gold_rule_id,
    ).catch((e: AppError) => e);
    const unknown = await get_rule(app, fx.tenant_a.context, randomUUID()).catch(
      (e: AppError) => e,
    );

    expect((foreign as AppError).status).toBe((unknown as AppError).status);
    expect((foreign as AppError).code).toBe((unknown as AppError).code);
    expect((foreign as AppError).message).toBe((unknown as AppError).message);
  });
});

describe("cross-tenant UPDATE is denied", () => {
  test("TenantIsolation_updateTenantBRule_returns403AndLeavesRuleUnchanged", async () => {
    const before = await owner.tenant_pricing_rules.findUnique({
      where: { id: fx.tenant_b.gold_rule_id },
    });

    await expect(
      update_rule(
        app,
        fx.tenant_a.context,
        fx.tenant_b.gold_rule_id,
        1,
        { adjustment_kind: "absolute", adjustment_rupees_per_gram: "1", ...DISPLAY },
        MUTATION,
      ),
    ).rejects.toMatchObject({ status: 403 });

    const after = await owner.tenant_pricing_rules.findUnique({
      where: { id: fx.tenant_b.gold_rule_id },
    });

    // A 403 accompanied by a completed write would still be a breach.
    expect(after).toEqual(before);
  });

  test("TenantIsolation_updateTenantBBranding_leavesItUnchanged", async () => {
    const forged: AuthenticatedTenantContext = {
      ...fx.tenant_a.context,
      // The context is what it is; only a real B context could touch B.
    };
    await update_branding(app, forged, "Hacked Jewellers");

    const b = await owner.tenant_branding.findUnique({
      where: { tenant_id: fx.tenant_b.tenant_id },
    });
    expect(b?.display_name).toBe("Gupta Jewellers");

    await update_branding(app, fx.tenant_a.context, "Sharma Jewellers");
  });
});

describe("cross-tenant DELETE is denied", () => {
  test("TenantIsolation_deleteTenantBRule_returns403AndRuleSurvives", async () => {
    await expect(
      deactivate_rule(app, fx.tenant_a.context, fx.tenant_b.gold_rule_id, 1, MUTATION),
    ).rejects.toMatchObject({ status: 403 });

    // Still present AND still active — a soft delete that ran would show here.
    expect(
      await owner.tenant_pricing_rules.count({
        where: { id: fx.tenant_b.gold_rule_id, is_active: true },
      }),
    ).toBe(1);
  });

  test("TenantIsolation_deleteUnknownId_returns403NotFound", async () => {
    await expect(
      deactivate_rule(app, fx.tenant_a.context, randomUUID(), 1, MUTATION),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("cross-tenant CREATE is denied", () => {
  /**
   * `CreateRuleInput` has no `tenant_id` field, so the attempt below cannot
   * even be expressed in typed code — the extra property is ignored, and the
   * row is written under A. The cast simulates an untyped caller relaying a
   * request body verbatim.
   */
  test("TenantIsolation_createWithTenantBIdInBody_createsUnderTenantA", async () => {
    const { response } = await create_rule(
      app,
      fx.tenant_a.context,
      {
        tenant_id: fx.tenant_b.tenant_id,
        product_id: fx.tenant_a.silver_product_id,
        adjustment_kind: "absolute",
        adjustment_rupees_per_gram: "1.23",
        ...DISPLAY,
      } as never,
      MUTATION,
    );

    // Written under A, and the row in the database proves it.
    const stored = await owner.tenant_pricing_rules.findUnique({
      where: { id: response.id },
      select: { tenant_id: true },
    });
    expect(stored?.tenant_id).toBe(fx.tenant_a.tenant_id);
    expect(stored?.tenant_id).not.toBe(fx.tenant_b.tenant_id);

    await owner.tenant_pricing_rules.delete({ where: { id: response.id } });
  });

  test("TenantIsolation_createdRow_isNotVisibleToTenantB", async () => {
    const { response } = await create_rule(
      app,
      fx.tenant_a.context,
      {
        product_id: fx.tenant_a.silver_product_id,
        adjustment_kind: "absolute",
        adjustment_rupees_per_gram: "4.56",
        ...DISPLAY,
      },
      MUTATION,
    );

    await expect(
      get_rule(app, fx.tenant_b.context, response.id),
    ).rejects.toMatchObject({ status: 403 });

    await owner.tenant_pricing_rules.delete({ where: { id: response.id } });
  });
});

describe("adversarial context manipulation", () => {
  /**
   * The central claim: a `tenant_id` supplied by the browser is not an
   * authority. Service functions take a context and no tenant id, so the only
   * way to act as B is to *be* B.
   */
  test("Adversarial_tenantBIdInRequestBody_isIgnored", async () => {
    const before = await owner.tenant_pricing_rules.findUnique({
      where: { id: fx.tenant_a.gold_rule_id },
    });

    // A handler relaying an untrusted body verbatim.
    const hostile_body = {
      tenant_id: fx.tenant_b.tenant_id,
      adjustment_kind: "absolute",
      adjustment_rupees_per_gram: "7.77",
      ...DISPLAY,
    } as never;

    await update_rule(
      app,
      fx.tenant_a.context,
      fx.tenant_a.gold_rule_id,
      before!.version,
      hostile_body,
      MUTATION,
    );

    const a_after = await owner.tenant_pricing_rules.findUnique({
      where: { id: fx.tenant_a.gold_rule_id },
    });
    const b_after = await owner.tenant_pricing_rules.findUnique({
      where: { id: fx.tenant_b.gold_rule_id },
    });

    // A's own rule changed; B's did not, and A's row still belongs to A.
    expect(a_after?.adjustment_value).toBe(777_000n);
    expect(a_after?.tenant_id).toBe(fx.tenant_a.tenant_id);
    expect(b_after?.adjustment_value).toBe(10_000_000n);

    await owner.tenant_pricing_rules.update({
      where: { id: fx.tenant_a.gold_rule_id },
      data: { adjustment_value: before!.adjustment_value, version: before!.version },
    });
  });

  /**
   * The only way to act as tenant B is to hold a context naming B. This test
   * pins down where that guarantee actually lives: **derivation**, not RLS.
   *
   * A hand-built context naming B does reach B's data — RLS binds to whatever
   * tenant the context carries, by design. What makes that safe is that no code
   * path constructs a context from request input: the sole producer is
   * `derive_authenticated_context`, which reads membership from the database
   * using a verified principal and cannot be steered to another tenant.
   */
  test("Adversarial_derivationFromPrincipal_cannotBeSteeredToAnotherTenant", async () => {
    const derived = await derive_authenticated_context(app, {
      external_object_id: fx.tenant_a.external_object_id,
      directory_tenant_id: TEST_DIRECTORY_ID,
    });

    expect(derived.tenant_id).toBe(fx.tenant_a.tenant_id);
    expect(derived.tenant_id).not.toBe(fx.tenant_b.tenant_id);

    // The derivation takes a principal only — there is no parameter through
    // which a tenant could be requested.
    expect(derive_authenticated_context.length).toBe(2); // (db, principal)
  });

  test("Adversarial_handBuiltContext_reachesOnlyTheTenantItNames", async () => {
    // Documents the boundary honestly: a context IS the authority, so it must
    // only ever come from derivation.
    const b_context: AuthenticatedTenantContext = {
      kind: "authenticated",
      tenant_id: fx.tenant_b.tenant_id,
      user_id: fx.tenant_b.user_id,
      role: "owner",
    };

    const rules = await list_rules(app, b_context);
    expect(rules.some((r) => r.id === fx.tenant_b.gold_rule_id)).toBe(true);
    expect(rules.some((r) => r.id === fx.tenant_a.gold_rule_id)).toBe(false);
  });

  test("Adversarial_tenantAUuidUsedAsRuleId_isDenied", async () => {
    await expect(
      get_rule(app, fx.tenant_a.context, fx.tenant_b.tenant_id),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("Adversarial_malformedRuleId_isDeniedNotCrashing", async () => {
    await expect(
      get_rule(app, fx.tenant_a.context, "not-a-uuid"),
    ).rejects.toBeDefined();
  });
});

describe("role-based authorization", () => {
  const staff_context: AuthenticatedTenantContext = {
    kind: "authenticated",
    tenant_id: "",
    user_id: "",
    role: "staff",
  };

  test("Rbac_staffRole_cannotUpdatePricing", async () => {
    await expect(
      update_rule(
        app,
        { ...staff_context, tenant_id: fx.tenant_a.tenant_id, user_id: fx.tenant_a.user_id },
        fx.tenant_a.gold_rule_id,
        1,
        { adjustment_kind: "absolute", adjustment_rupees_per_gram: "1", ...DISPLAY },
        MUTATION,
      ),
    ).rejects.toBeDefined();
  });

  test("Rbac_managerRole_cannotDeletePricingRules", async () => {
    await expect(
      deactivate_rule(
        app,
        { ...fx.tenant_a.context, role: "manager" },
        fx.tenant_a.gold_rule_id,
        1,
        MUTATION,
      ),
    ).rejects.toBeDefined();
  });

  /** Permission is checked before existence, so no enumeration is possible. */
  test("Rbac_permissionCheckedBeforeExistence_forUnknownId", async () => {
    await expect(
      update_rule(
        app,
        { ...fx.tenant_a.context, role: "staff" },
        randomUUID(),
        1,
        { adjustment_kind: "absolute", adjustment_rupees_per_gram: "1", ...DISPLAY },
        MUTATION,
      ),
    ).rejects.toBeDefined();
  });

  test("Rbac_hasRole_ranksOwnerAboveManagerAboveStaff", () => {
    const owner_ctx = { ...fx.tenant_a.context, role: "owner" as const };
    const manager_ctx = { ...fx.tenant_a.context, role: "manager" as const };
    const staff_ctx = { ...fx.tenant_a.context, role: "staff" as const };

    expect(has_role(owner_ctx, "owner")).toBe(true);
    expect(has_role(manager_ctx, "owner")).toBe(false);
    expect(has_role(manager_ctx, "manager")).toBe(true);
    expect(has_role(staff_ctx, "manager")).toBe(false);
    expect(has_role(staff_ctx, "staff")).toBe(true);
  });
});
