/**
 * Shop settings: branding, contacts, and per-product display.
 *
 * These endpoints write a tenant's own rows, so the questions are the usual
 * ones — can they reach another shop, can the browser name a tenant — plus one
 * specific to this surface: a `display_unit` change silently invalidates every
 * stored rate for that product, because the stored amount *is* an amount in
 * that unit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import { pino } from "pino";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type CryptoKey,
} from "jose";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import { ManualClock } from "../../src/platform/clock.js";
import { load_config } from "../../src/platform/config.js";
import { create_app } from "../../src/http/app.js";
import { JwtVerifier, type JwtVerifierOptions } from "../../src/modules/auth/index.js";
import {
  app_client,
  owner_client,
  seed_fixtures,
  TEST_DIRECTORY_ID,
  type Fixtures,
} from "./fixtures.js";

const ISSUER = "https://bullionshops.ciamlogin.com/0d1e2c70-0000-4000-8000-000000000001/v2.0";
const AUDIENCE = "api://bullion-rates";
const NOW = new Date("2026-09-25T09:00:00.000Z");
const TENANT = "/api/v1/tenant";
const PRODUCTS = "/api/v1/products";

let owner: PrismaClient;
let db: PrismaClient;
let api: Express;
let signing_key: CryptoKey;
let fx: Fixtures;
let token_a = "";
let token_b = "";

/**
 * Records what the pipeline was asked to recompute.
 *
 * A unit change silently invalidates every stored rate for the product, so the
 * thing worth asserting is that the hook fires for a unit change and stays
 * quiet for a setting that needs no recompute. Stubbing it keeps that assertion
 * exact and independent of whether a market quote happens to be available.
 */
const recomputed: { tenant_id: string; rule_id: string }[] = [];

async function token_for(oid: string): Promise<string> {
  const now_s = Math.floor(NOW.getTime() / 1000);
  return new SignJWT({ oid, tid: TEST_DIRECTORY_ID })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(`pairwise-${oid}`)
    .setIssuedAt(now_s)
    .setExpirationTime(now_s + 3600)
    .sign(signing_key);
}

const patch = (token: string, body: object) =>
  request(api).patch(TENANT).set("Authorization", `Bearer ${token}`).send(body);

beforeAll(async () => {
  owner = owner_client();
  db = app_client();

  const pair = await generateKeyPair("ES256", { extractable: true });
  signing_key = pair.privateKey;
  const jwk: JWK = {
    ...(await exportJWK(pair.publicKey)),
    kid: "test-key",
    alg: "ES256",
    use: "sig",
  };

  const verifier_options: JwtVerifierOptions = {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ["ES256"],
    expected_directory_id: TEST_DIRECTORY_ID,
    allowed_client_ids: [],
    clock_tolerance_s: 5,
    max_future_iat_s: 60,
    max_token_age_s: 0,
  };

  api = create_app({
    config: load_config({
      NODE_ENV: "test",
      API_BASE_URL: "http://localhost:8080",
      PUBLIC_WEB_URL: "http://localhost:3000",
      ALLOWED_ORIGINS: "http://localhost:3000",
      DATABASE_URL: "postgresql://bullion_app:devpassword@localhost:5432/bullion_test",
      REDIS_URL: "redis://localhost:6380",
      MARKET_DATA_PROVIDER: "mock",
    }),
    logger: pino({ level: "silent" }),
    db,
    verifier: new JwtVerifier(
      createLocalJWKSet({ keys: [jwk] }),
      verifier_options,
      new ManualClock(NOW),
    ),
    ping_database: async () => {},
    ping_redis: async () => {},
    pipeline: {
      health: () => ({ status: "healthy" as const, checked_at: NOW.toISOString() }),
      detail: () => ({}),
      recompute_rule: async (_tx, tenant_id, rule_id) => {
        recomputed.push({ tenant_id, rule_id });
        return true;
      },
    },
  });
});

beforeEach(async () => {
  fx = await seed_fixtures(owner);
  token_a = await token_for(fx.tenant_a.external_object_id);
  token_b = await token_for(fx.tenant_b.external_object_id);
  recomputed.length = 0;
});

afterAll(async () => {
  await Promise.allSettled([owner.$disconnect(), db.$disconnect()]);
});

// ---------------------------------------------------------------------------
// Reading and writing settings
// ---------------------------------------------------------------------------

describe("shop settings", () => {
  test("Settings_get_returnsBrandingAndContacts", async () => {
    const response = await request(api).get(TENANT).set("Authorization", `Bearer ${token_a}`);

    expect(response.status).toBe(200);
    expect(response.body.data.display_name).toBe(fx.tenant_a.display_name);
    expect(response.body.data.contact).toHaveProperty("show_phone");
    expect(response.body.data.has_logo).toBe(false);
  });

  test("Settings_rename_takesEffectOnThePublicPage", async () => {
    const update = await patch(token_a, { display_name: "Sharma Gold House" });
    expect(update.status).toBe(200);
    expect(update.body.data.display_name).toBe("Sharma Gold House");

    const shop = await request(api).get(`/api/v1/public/shops/${fx.tenant_a.slug}`);
    expect(shop.body.data.display_name).toBe("Sharma Gold House");
  });

  /**
   * A partial update must leave absent fields alone. A form that sends only
   * what changed must not blank everything else.
   */
  test("Settings_partialUpdate_leavesOtherFieldsUntouched", async () => {
    const before = await request(api).get(TENANT).set("Authorization", `Bearer ${token_a}`);

    await patch(token_a, { tagline: "Since 1985, in Zaveri Bazaar" });

    const after = await request(api).get(TENANT).set("Authorization", `Bearer ${token_a}`);
    expect(after.body.data.tagline).toBe("Since 1985, in Zaveri Bazaar");
    expect(after.body.data.display_name).toBe(before.body.data.display_name);
    expect(after.body.data.contact.phone).toBe(before.body.data.contact.phone);
  });

  /** Explicit null clears; absent leaves alone. They are different intentions. */
  test("Settings_null_clearsAField", async () => {
    await patch(token_a, { tagline: "temporary" });
    await patch(token_a, { tagline: null });

    const after = await request(api).get(TENANT).set("Authorization", `Bearer ${token_a}`);
    expect(after.body.data.tagline).toBeNull();
  });

  test("Settings_contacts_reachThePublicPage", async () => {
    await patch(token_a, {
      phone: "+919820099999",
      show_phone: true,
      city: "Mumbai",
      show_address: true,
    });

    const shop = await request(api).get(`/api/v1/public/shops/${fx.tenant_a.slug}`);
    expect(shop.body.data.contact.phone).toBe("+919820099999");
    expect(shop.body.data.contact.city).toBe("Mumbai");
  });

  /** The show flags are the shop's disclosure choice, honoured by the API. */
  test("Settings_hidingAContact_withholdsItFromCustomers", async () => {
    await patch(token_a, { phone: "+919820099999", show_phone: false });

    const shop = await request(api).get(`/api/v1/public/shops/${fx.tenant_a.slug}`);
    expect(shop.body.data.contact.phone).toBeNull();
  });

  test("Settings_change_isAudited", async () => {
    const before = await owner.audit_logs.count({ where: { tenant_id: fx.tenant_a.tenant_id } });

    await patch(token_a, { display_name: "Audited Jewellers" });

    const entry = await owner.audit_logs.findFirst({
      where: { tenant_id: fx.tenant_a.tenant_id, action: "tenant_settings.updated" },
      orderBy: { id: "desc" },
      select: { new_value: true, actor_role: true },
    });

    expect(await owner.audit_logs.count({ where: { tenant_id: fx.tenant_a.tenant_id } })).toBe(
      before + 1,
    );
    expect((entry?.new_value as Record<string, unknown>)["display_name"]).toBe(
      "Audited Jewellers",
    );
    expect(entry?.actor_role).toBe("owner");
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validation", () => {
  /** The accent is rendered into a style attribute on a public page. */
  test.each([
    ["a url", "url(https://evil.test/x)"],
    ["a css variable", "var(--surface-page)"],
    ["a named colour", "red"],
    ["an injection attempt", "#fff; content: 'x'"],
  ])("Settings_accent_%s_isRefused", async (_label, accent_color) => {
    const response = await patch(token_a, { accent_color });
    expect(response.status).toBe(422);
  });

  test("Settings_accent_plainHex_isAccepted", async () => {
    const response = await patch(token_a, { accent_color: "#1d4ed8" });
    expect(response.status).toBe(200);
    expect(response.body.data.accent_color).toBe("#1d4ed8");
  });

  test.each([
    ["an empty name", { display_name: "" }],
    ["a bad pincode", { pincode: "12" }],
    ["a bad email", { email: "not-an-email" }],
    ["a bad phone", { phone: "call-me" }],
    ["an unknown field", { nickname: "bk" }],
  ])("Settings_%s_is422", async (_label, body) => {
    expect((await patch(token_a, body)).status).toBe(422);
  });

  /** Identity and status are not settings; `.strict()` refuses them outright. */
  test.each([
    ["a tenant id", { tenant_id: "00000000-0000-4000-8000-000000000000" }],
    ["a status", { status: "active" }],
    ["a slug", { slug: "something-else" }],
  ])("Settings_%s_inBodyIsRefused", async (_label, body) => {
    expect((await patch(token_a, body)).status).toBe(422);
  });

  test("Settings_emptyBody_is422", async () => {
    expect((await patch(token_a, {})).status).toBe(422);
  });

  test("Settings_withoutToken_is401", async () => {
    expect((await request(api).get(TENANT)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe("isolation", () => {
  test("Settings_tenantA_cannotSeeTenantB", async () => {
    const a = await request(api).get(TENANT).set("Authorization", `Bearer ${token_a}`);
    const b = await request(api).get(TENANT).set("Authorization", `Bearer ${token_b}`);

    expect(a.body.data.display_name).not.toBe(b.body.data.display_name);
    expect(JSON.stringify(a.body)).not.toContain(fx.tenant_b.tenant_id);
  });

  test("Settings_tenantAWrite_neverChangesTenantB", async () => {
    const before = await owner.tenant_branding.findFirst({
      where: { tenant_id: fx.tenant_b.tenant_id },
      select: { display_name: true },
    });

    await patch(token_a, { display_name: "Only A Changed" });

    const after = await owner.tenant_branding.findFirst({
      where: { tenant_id: fx.tenant_b.tenant_id },
      select: { display_name: true },
    });
    expect(after?.display_name).toBe(before?.display_name);
  });
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

describe("product settings", () => {
  test("Products_list_showsTheWholeCatalogueWithOwnConfig", async () => {
    const response = await request(api).get(PRODUCTS).set("Authorization", `Bearer ${token_a}`);

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);

    const gold = response.body.data.find(
      (p: { product_id: string }) => p.product_id === fx.tenant_a.gold_product_id,
    );
    expect(gold.is_enabled).toBe(true);
    expect(gold.has_pricing_rule).toBe(true);
    expect(gold).toHaveProperty("show_base_rate");
  });

  /**
   * The gap this closes: a self-onboarded shop could never show the breakdown,
   * because nothing could switch it on.
   */
  test("Products_showBaseRate_governsTheBreakdownCustomersSee", async () => {
    const gold = async () => {
      const response = await request(api).get(`/api/v1/public/shops/${fx.tenant_a.slug}/rates`);
      return response.body.data.find((r: { metal: string }) => r.metal === "GOLD");
    };

    const set = (show_base_rate: boolean) =>
      request(api)
        .patch(`${PRODUCTS}/${fx.tenant_a.gold_product_id}`)
        .set("Authorization", `Bearer ${token_a}`)
        .send({ show_base_rate });

    // Off: the components are absent from the payload, not merely unrendered.
    expect((await set(false)).status).toBe(200);
    const hidden = await gold();
    expect(hidden.market_rate).toBeNull();
    expect(hidden.shop_adjustment).toBeNull();
    expect(hidden.rate).toEqual(expect.any(String));

    // On: this is the gap being closed — a self-onboarded shop previously had
    // no way to switch the breakdown on at all.
    await set(true);
    const shown = await gold();
    expect(shown.market_rate).toEqual(expect.any(String));
    expect(shown.shop_adjustment).toEqual(expect.any(String));
    expect(shown.rate).toBe(hidden.rate);
  });

  test("Products_disable_removesItFromTheCustomerPage", async () => {
    await request(api)
      .patch(`${PRODUCTS}/${fx.tenant_a.gold_product_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ is_enabled: false });

    const rates = await request(api).get(`/api/v1/public/shops/${fx.tenant_a.slug}/rates`);
    const keys = rates.body.data.map((r: { product_key: string }) => r.product_key);
    expect(keys.some((k: string) => k.startsWith("GOLD_916"))).toBe(false);
  });

  /**
   * The stored `rate_display_paise` is an amount *in* the display unit, so a
   * unit change makes it wrong — ₹14,081 per 10 grams read as per gram is out
   * by a factor of ten, which is exactly the kind of number a customer acts on.
   */
  test("Products_displayUnitChange_triggersARecompute", async () => {
    const response = await request(api)
      .patch(`${PRODUCTS}/${fx.tenant_a.gold_product_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ display_unit: "per_gram" });

    expect(response.status).toBe(200);
    expect(response.body.data.display_unit).toBe("per_gram");
    expect(recomputed).toEqual([
      { tenant_id: fx.tenant_a.tenant_id, rule_id: fx.tenant_a.gold_rule_id },
    ]);
  });

  test("Products_displayUnitUnchanged_doesNotRecompute", async () => {
    await request(api)
      .patch(`${PRODUCTS}/${fx.tenant_a.gold_product_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ display_unit: "per_10_gram" }); // already per_10_gram

    expect(recomputed).toEqual([]);
  });

  /** `show_base_rate` is read at query time; nothing stored goes stale. */
  test("Products_showBaseRate_doesNotRecompute", async () => {
    await request(api)
      .patch(`${PRODUCTS}/${fx.tenant_a.gold_product_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ show_base_rate: true, is_enabled: true });

    expect(recomputed).toEqual([]);
  });

  /** A product with no pricing rule has no rate to recompute, and must not 500. */
  test("Products_displayUnitOnAnUnpricedProduct_succeeds", async () => {
    const response = await request(api)
      .patch(`${PRODUCTS}/${fx.tenant_a.silver_product_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ display_unit: "per_gram" });

    expect(response.status).toBe(200);
    expect(recomputed).toEqual([]);
  });

  test("Products_badUnit_is422", async () => {
    const response = await request(api)
      .patch(`${PRODUCTS}/${fx.tenant_a.gold_product_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ display_unit: "per_tola" });

    expect(response.status).toBe(422);
    expect(recomputed).toEqual([]);
  });

  test("Products_unknownId_is404", async () => {
    const response = await request(api)
      .patch(`${PRODUCTS}/00000000-0000-4000-8000-000000000000`)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ is_enabled: true });

    expect(response.status).toBe(404);
  });

  test("Products_malformedId_is404NotAServerError", async () => {
    const response = await request(api)
      .patch(`${PRODUCTS}/not-a-uuid`)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ is_enabled: true });

    expect(response.status).toBe(404);
  });

  test("Products_unknownField_is422", async () => {
    const response = await request(api)
      .patch(`${PRODUCTS}/${fx.tenant_a.gold_product_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ is_enabled: true, price: 100 });

    expect(response.status).toBe(422);
  });

  test("Products_change_isAudited", async () => {
    await request(api)
      .patch(`${PRODUCTS}/${fx.tenant_a.gold_product_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ show_base_rate: true });

    const entry = await owner.audit_logs.findFirst({
      where: { tenant_id: fx.tenant_a.tenant_id, action: "tenant_product.updated" },
      orderBy: { id: "desc" },
      select: { entity_id: true },
    });

    expect(entry?.entity_id).toBe(fx.tenant_a.gold_product_id);
  });

  test("Products_tenantAChange_neverAffectsTenantB", async () => {
    const before = await owner.tenant_products.findFirst({
      where: { tenant_id: fx.tenant_b.tenant_id, product_id: fx.tenant_b.gold_product_id },
      select: { show_base_rate: true, is_enabled: true },
    });

    await request(api)
      .patch(`${PRODUCTS}/${fx.tenant_a.gold_product_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ show_base_rate: true, is_enabled: false });

    const after = await owner.tenant_products.findFirst({
      where: { tenant_id: fx.tenant_b.tenant_id, product_id: fx.tenant_b.gold_product_id },
      select: { show_base_rate: true, is_enabled: true },
    });

    expect(after).toEqual(before);
  });
});
