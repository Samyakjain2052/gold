/**
 * Tenant isolation at the PUBLIC CUSTOMER-ACCESS layer.
 *
 * The public page is intentionally unauthenticated, so it gets its own
 * authorisation model and its own tests. Two properties are proven here:
 *
 *   1. Tenant A's public URL exposes only Tenant A's intended public data.
 *   2. It exposes nothing private — not internal ids, pricing configuration,
 *      audit history, members, provider details or system state.
 *
 * The leakage checks compare **exact key sets**, not a denylist. A field added
 * to a table or a projection fails these tests rather than shipping quietly.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  get_public_rates,
  get_public_shop,
  resolve_public_tenant,
  PublicAccessError,
  type PublicServiceOptions,
} from "../../src/modules/public/public_service.js";
import { app_client, owner_client, seed_fixtures, type Fixtures } from "./fixtures.js";

let owner: PrismaClient;
let app: PrismaClient;
let fx: Fixtures;

const options: PublicServiceOptions = {
  logo_base_url: "https://cdn.example.test/logos",
  classify: () => "fresh",
};

beforeAll(async () => {
  owner = owner_client();
  app = app_client();
  fx = await seed_fixtures(owner);
});

afterAll(async () => {
  await Promise.allSettled([owner.$disconnect(), app.$disconnect()]);
});

/** Every key a visitor may receive, at every level of the shop payload. */
const SHOP_KEYS = [
  "slug",
  "display_name",
  "tagline",
  "logo_url",
  "accent_color",
  "contact",
].sort();

const CONTACT_KEYS = [
  "phone",
  "whatsapp",
  "email",
  "address",
  "city",
  "state",
  "pincode",
].sort();

const RATE_KEYS = [
  "product_key",
  "label",
  "metal",
  "display_unit",
  "rate",
  "market_rate",
  "shop_adjustment",
  "rounding",
  "source_timestamp",
  "freshness",
].sort();

describe("slug resolution", () => {
  test("PublicAccess_activeSlug_resolvesToItsTenant", async () => {
    const context = await resolve_public_tenant(app, fx.tenant_a.slug);
    expect(context.tenant_id).toBe(fx.tenant_a.tenant_id);
    expect(context.kind).toBe("public");
  });

  test("PublicAccess_slugIsCaseInsensitive", async () => {
    const context = await resolve_public_tenant(app, "SHARMA-JEWELLERS");
    expect(context.tenant_id).toBe(fx.tenant_a.tenant_id);
  });

  test("PublicAccess_unknownSlug_returns404WithoutRevealingExistence", async () => {
    await expect(resolve_public_tenant(app, "no-such-shop")).rejects.toMatchObject({
      status: 404,
    });
  });

  test("PublicAccess_revokedSlug_returns410NotSilentlyAnotherShop", async () => {
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${fx.tenant_b.tenant_id}, TRUE)`;
      await tx.customer_links.updateMany({
        where: { tenant_id: fx.tenant_b.tenant_id },
        data: { is_active: false, revoked_at: new Date() },
      });
    });

    await expect(resolve_public_tenant(app, fx.tenant_b.slug)).rejects.toMatchObject({
      status: 410,
    });

    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${fx.tenant_b.tenant_id}, TRUE)`;
      await tx.customer_links.updateMany({
        where: { tenant_id: fx.tenant_b.tenant_id },
        data: { is_active: true, revoked_at: null },
      });
    });
  });

  test("PublicAccess_suspendedTenant_isIndistinguishableFromMissing", async () => {
    await owner.tenants.update({
      where: { id: fx.tenant_b.tenant_id },
      data: { status: "suspended" },
    });

    const suspended = await resolve_public_tenant(app, fx.tenant_b.slug).catch(
      (e: PublicAccessError) => e,
    );
    const missing = await resolve_public_tenant(app, "definitely-not-a-shop").catch(
      (e: PublicAccessError) => e,
    );

    expect((suspended as PublicAccessError).status).toBe(
      (missing as PublicAccessError).status,
    );
    expect((suspended as PublicAccessError).message).toBe(
      (missing as PublicAccessError).message,
    );

    await owner.tenants.update({
      where: { id: fx.tenant_b.tenant_id },
      data: { status: "active" },
    });
  });
});

describe("public shop payload", () => {
  test("PublicShop_tenantASlug_returnsTenantABranding", async () => {
    const shop = await get_public_shop(app, fx.tenant_a.slug, options);
    expect(shop.display_name).toBe("Sharma Jewellers");
    expect(shop.slug).toBe(fx.tenant_a.slug);
  });

  test("PublicShop_tenantBSlug_returnsTenantBBranding", async () => {
    const shop = await get_public_shop(app, fx.tenant_b.slug, options);
    expect(shop.display_name).toBe("Gupta Jewellers");
  });

  /** The core public-isolation claim from the brief. */
  test("PublicShop_tenantASlug_containsNoTenantBData", async () => {
    const shop = await get_public_shop(app, fx.tenant_a.slug, options);
    const serialised = JSON.stringify(shop);

    expect(serialised).not.toContain(fx.tenant_b.tenant_id);
    expect(serialised).not.toContain(fx.tenant_b.slug);
    expect(serialised).not.toContain("Gupta");
    expect(serialised).not.toContain(fx.tenant_b.legal_name);
  });

  test("PublicShop_emitsExactlyTheAllowlistedKeys", async () => {
    const shop = await get_public_shop(app, fx.tenant_a.slug, options);

    expect(Object.keys(shop).sort()).toEqual(SHOP_KEYS);
    expect(Object.keys(shop.contact).sort()).toEqual(CONTACT_KEYS);
  });

  /** Internal identifiers must never reach a visitor. */
  test("PublicShop_exposesNoInternalIdentifiers", async () => {
    const shop = await get_public_shop(app, fx.tenant_a.slug, options);
    const serialised = JSON.stringify(shop);

    expect(serialised).not.toContain(fx.tenant_a.tenant_id);
    expect(serialised).not.toContain(fx.tenant_a.user_id);
    expect(serialised).not.toContain(fx.tenant_a.gold_rule_id);
    expect(serialised).not.toContain(fx.tenant_a.gold_product_id);
    expect(serialised).not.toContain(fx.tenant_a.external_object_id);
    expect(shop).not.toHaveProperty("tenant_id");
  });

  test("PublicShop_exposesNoLegalNameOrMemberDetails", async () => {
    const shop = await get_public_shop(app, fx.tenant_a.slug, options);
    const serialised = JSON.stringify(shop);

    // The registered legal name is private; the display name is what is shared.
    expect(serialised).not.toContain(fx.tenant_a.legal_name);
    expect(serialised).not.toContain("owner@sharmajewellers.test");
  });

  test("PublicShop_logoBlobPath_isNeverEmittedRaw", async () => {
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${fx.tenant_a.tenant_id}, TRUE)`;
      await tx.tenant_branding.updateMany({
        where: { tenant_id: fx.tenant_a.tenant_id },
        data: { logo_blob_path: "internal/container/path/logo.png" },
      });
    });

    const shop = await get_public_shop(app, fx.tenant_a.slug, options);
    expect(shop.logo_url).toBe(
      "https://cdn.example.test/logos/internal/container/path/logo.png",
    );
    expect(shop).not.toHaveProperty("logo_blob_path");
  });

  test("PublicShop_contactFlagsOff_withholdThoseFields", async () => {
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${fx.tenant_a.tenant_id}, TRUE)`;
      await tx.tenant_contacts.updateMany({
        where: { tenant_id: fx.tenant_a.tenant_id },
        data: { show_phone: false, show_address: false },
      });
    });

    const shop = await get_public_shop(app, fx.tenant_a.slug, options);
    expect(shop.contact.phone).toBeNull();
    expect(shop.contact.address).toBeNull();
    expect(shop.contact.city).toBeNull();
    // Still present as keys, so the shape is stable for the client.
    expect(Object.keys(shop.contact).sort()).toEqual(CONTACT_KEYS);

    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${fx.tenant_a.tenant_id}, TRUE)`;
      await tx.tenant_contacts.updateMany({
        where: { tenant_id: fx.tenant_a.tenant_id },
        data: { show_phone: true, show_address: true },
      });
    });
  });
});

describe("public rates payload", () => {
  test("PublicRates_tenantASlug_returnsOnlyTenantARates", async () => {
    const rates = await get_public_rates(app, fx.tenant_a.slug, options);

    expect(rates.length).toBeGreaterThan(0);
    // A's gold rate: ₹1,40,813.93 market + ₹500 adjustment.
    expect(rates[0]?.rate).toBe("14131393");
  });

  test("PublicRates_tenantBSlug_returnsItsOwnDifferentRates", async () => {
    const a = await get_public_rates(app, fx.tenant_a.slug, options);
    const b = await get_public_rates(app, fx.tenant_b.slug, options);

    expect(a[0]?.rate).not.toBe(b[0]?.rate);
    // B's +₹100/g is ₹1,000 per 10 g over the same market rate.
    expect(b[0]?.rate).toBe("14181393");
  });

  test("PublicRates_emitsExactlyTheAllowlistedKeys", async () => {
    const rates = await get_public_rates(app, fx.tenant_a.slug, options);
    expect(Object.keys(rates[0]!).sort()).toEqual(RATE_KEYS);
  });

  test("PublicRates_exposeNoInternalIdentifiers", async () => {
    const rates = await get_public_rates(app, fx.tenant_a.slug, options);
    const serialised = JSON.stringify(rates);

    expect(serialised).not.toContain(fx.tenant_a.tenant_id);
    expect(serialised).not.toContain(fx.tenant_a.gold_product_id);
    expect(serialised).not.toContain(fx.tenant_a.gold_rule_id);
    expect(serialised).not.toContain(fx.tenant_b.tenant_id);
  });

  /** `show_base_rate` off must remove the fields, not merely hide them. */
  test("PublicRates_showBaseRateOff_omitsMarketRateAndAdjustment", async () => {
    const b = await get_public_rates(app, fx.tenant_b.slug, options);

    expect(b[0]?.market_rate).toBeNull();
    expect(b[0]?.shop_adjustment).toBeNull();
    expect(b[0]?.rounding).toBeNull();
    // The final rate is still present — that is the point of the page.
    expect(b[0]?.rate).toBe("14181393");
  });

  test("PublicRates_showBaseRateOn_includesTheBreakdown", async () => {
    const a = await get_public_rates(app, fx.tenant_a.slug, options);

    expect(a[0]?.market_rate).toBe("14081393");
    expect(a[0]?.shop_adjustment).toBe("50000");
    expect(a[0]?.rounding).toBe("0");
  });

  test("PublicRates_breakdownAddsUpExactly", async () => {
    const a = await get_public_rates(app, fx.tenant_a.slug, options);
    const rate = a[0]!;

    const sum =
      BigInt(rate.market_rate!) + BigInt(rate.shop_adjustment!) + BigInt(rate.rounding!);
    expect(sum.toString()).toBe(rate.rate);
  });

  test("PublicRates_exposeSourceTimestampNotReceivedAt", async () => {
    const rates = await get_public_rates(app, fx.tenant_a.slug, options);

    expect(rates[0]?.source_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rates[0]).not.toHaveProperty("received_at");
    expect(rates[0]).not.toHaveProperty("computed_at");
    expect(rates[0]?.freshness).toBe("fresh");
  });

  test("PublicRates_exposeNoRawPricingTiers", async () => {
    const rates = await get_public_rates(app, fx.tenant_a.slug, options);

    // The raw milli-paise tier is internal; only display figures are published.
    expect(rates[0]).not.toHaveProperty("raw_base_rate");
    expect(rates[0]).not.toHaveProperty("raw_adjustment");
    expect(rates[0]).not.toHaveProperty("raw_customer_rate");
    expect(rates[0]).not.toHaveProperty("pricing_rule_id");
  });

  test("PublicRates_disabledProducts_areAbsent", async () => {
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${fx.tenant_a.tenant_id}, TRUE)`;
      await tx.tenant_products.updateMany({
        where: { tenant_id: fx.tenant_a.tenant_id },
        data: { is_enabled: false },
      });
    });

    expect(await get_public_rates(app, fx.tenant_a.slug, options)).toHaveLength(0);

    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${fx.tenant_a.tenant_id}, TRUE)`;
      await tx.tenant_products.updateMany({
        where: { tenant_id: fx.tenant_a.tenant_id },
        data: { is_enabled: true },
      });
    });
  });
});

describe("adversarial public access", () => {
  test("Adversarial_tenantBUuidAsSlug_returns404", async () => {
    await expect(
      resolve_public_tenant(app, fx.tenant_b.tenant_id),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("Adversarial_sqlInjectionInSlug_isParameterisedAndDenied", async () => {
    for (const payload of [
      "sharma-jewellers' OR '1'='1",
      "'; DROP TABLE tenants; --",
      "sharma-jewellers%",
      "%",
      "_harma-jewellers",
    ]) {
      await expect(resolve_public_tenant(app, payload)).rejects.toMatchObject({
        status: 404,
      });
    }

    // The table is still there.
    expect(await owner.tenants.count()).toBe(2);
  });

  test("Adversarial_emptyOrWhitespaceSlug_returns404", async () => {
    for (const payload of ["", "   ", "\n"]) {
      await expect(resolve_public_tenant(app, payload)).rejects.toMatchObject({
        status: 404,
      });
    }
  });

  test("Adversarial_publicPayloads_neverMentionProviderOrSystemInternals", async () => {
    const shop = await get_public_shop(app, fx.tenant_a.slug, options);
    const rates = await get_public_rates(app, fx.tenant_a.slug, options);
    const serialised = JSON.stringify({ shop, rates }).toLowerCase();

    for (const forbidden of [
      "api_key",
      "apikey",
      "secret",
      "password",
      "token",
      "database_url",
      "postgres",
      "redis",
      "supabase",
      "provider",
      "audit",
      "adjustment_value",
      "adjustment_bps",
      "rounding_step",
      "is_active",
      "created_by",
      "external_object_id",
      "external_directory_id",
    ]) {
      expect(serialised, `public payload leaked "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
  });
});
