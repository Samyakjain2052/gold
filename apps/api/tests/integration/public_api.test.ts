/**
 * Stage 8 — the public customer surface and `/me`, over real HTTP.
 *
 * These are the endpoints an anonymous stranger can reach, so the questions
 * that matter are not "does it return the shop" but "can it be made to return
 * someone else's shop, or a field the shop chose not to publish".
 *
 * The app under test is the real one from `create_app`, with real RLS beneath
 * it. Nothing is stubbed except the clock and the token signing key.
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
const NOW = new Date("2026-09-20T12:00:00.000Z");
const PUBLIC = "/api/v1/public/shops";

let owner: PrismaClient;
let db: PrismaClient;
let fx: Fixtures;
let signing_key: CryptoKey;
let api: Express;
let token_a = "";
let token_b = "";

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

  const clock = new ManualClock(NOW);
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

  const config = load_config({
    NODE_ENV: "test",
    API_BASE_URL: "http://localhost:8080",
    PUBLIC_WEB_URL: "http://localhost:3000",
    ALLOWED_ORIGINS: "http://localhost:3000",
    DATABASE_URL: "postgresql://bullion_app:devpassword@localhost:5432/bullion_test",
    REDIS_URL: "redis://localhost:6380",
    MARKET_DATA_PROVIDER: "mock",
  });

  api = create_app({
    config,
    logger: pino({ level: "silent" }),
    db,
    verifier: new JwtVerifier(createLocalJWKSet({ keys: [jwk] }), verifier_options, clock),
    ping_database: async () => {},
    ping_redis: async () => {},
  });
});

beforeEach(async () => {
  fx = await seed_fixtures(owner);
  token_a = await token_for(fx.tenant_a.external_object_id);
  token_b = await token_for(fx.tenant_b.external_object_id);
});

afterAll(async () => {
  await Promise.allSettled([owner.$disconnect(), db.$disconnect()]);
});

// ---------------------------------------------------------------------------
// Slug resolution
// ---------------------------------------------------------------------------

describe("public shop by slug", () => {
  test("PublicApi_activeSlug_returnsThatShop", async () => {
    const response = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}`);

    expect(response.status).toBe(200);
    expect(response.body.data.slug).toBe(fx.tenant_a.slug);
    expect(response.body.data.display_name).not.toBe("");
  });

  test("PublicApi_noAuthenticationRequired", async () => {
    // The whole point of the surface: no Authorization header anywhere.
    const response = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}`);
    expect(response.status).toBe(200);
  });

  test("PublicApi_unknownSlug_returns404", async () => {
    const response = await request(api).get(`${PUBLIC}/no-such-shop`);
    expect(response.status).toBe(404);
  });

  /** A malformed slug must not be distinguishable from an unknown one. */
  test("PublicApi_malformedSlug_returns404NotValidationError", async () => {
    for (const bad of ["UPPERCASE", "has_underscore", "-leading", "trailing-", "a".repeat(80)]) {
      const response = await request(api).get(`${PUBLIC}/${bad}`);
      expect(response.status, bad).toBe(404);
    }
  });

  test("PublicApi_neverExposesTenantIdOrLegalName", async () => {
    const response = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}`);
    const body = JSON.stringify(response.body);

    expect(body).not.toContain(fx.tenant_a.tenant_id);
    expect(body).not.toContain("legal_name");
    expect(response.body.data).not.toHaveProperty("tenant_id");
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant isolation — the property that matters most on this surface
// ---------------------------------------------------------------------------

describe("public tenant isolation", () => {
  test("PublicApi_tenantASlug_neverReturnsTenantBBranding", async () => {
    const a = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}`);
    const b = await request(api).get(`${PUBLIC}/${fx.tenant_b.slug}`);

    expect(a.body.data.display_name).not.toBe(b.body.data.display_name);
    expect(JSON.stringify(a.body)).not.toContain(fx.tenant_b.tenant_id);
    expect(JSON.stringify(a.body)).not.toContain(b.body.data.display_name);
  });

  test("PublicApi_tenantASlug_returnsOnlyItsOwnRates", async () => {
    const a = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}/rates`);
    const b = await request(api).get(`${PUBLIC}/${fx.tenant_b.slug}/rates`);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const a_rates = a.body.data.map((r: { rate: string }) => r.rate);
    const b_rates = b.body.data.map((r: { rate: string }) => r.rate);

    // The fixtures give the two shops different adjustments, so identical
    // published rates would mean one page is showing the other's numbers.
    expect(a_rates).not.toEqual(b_rates);
    expect(JSON.stringify(a.body)).not.toContain(fx.tenant_b.tenant_id);
  });
});

// ---------------------------------------------------------------------------
// Rates payload
// ---------------------------------------------------------------------------

describe("public rates", () => {
  test("PublicRates_returnsAuthoritativeRateAndFreshness", async () => {
    const response = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}/rates`);

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);

    for (const rate of response.body.data) {
      expect(typeof rate.rate).toBe("string");
      expect(rate.product_key).toMatch(/^[A-Z]+_\d+$/);
      expect(["fresh", "stale", "expired"]).toContain(rate.freshness);
      expect(typeof rate.source_timestamp).toBe("string");
    }
  });

  /**
   * The breakdown is the shop's disclosure choice, not the client's. A tenant
   * with show_base_rate off must not receive the components at all — hiding
   * them in CSS would still ship them to the browser.
   */
  test("PublicRates_showBaseRateOff_omitsComponentsEntirely", async () => {
    const response = await request(api).get(`${PUBLIC}/${fx.tenant_b.slug}/rates`);
    const hidden = response.body.data.filter(
      (r: { market_rate: string | null }) => r.market_rate === null,
    );

    expect(hidden.length).toBeGreaterThan(0);
    for (const rate of hidden) {
      expect(rate.shop_adjustment).toBeNull();
      expect(rate.rounding).toBeNull();
    }
  });

  test("PublicRates_neverExposesInternalColumns", async () => {
    const response = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}/rates`);

    for (const rate of response.body.data) {
      for (const internal of [
        "tenant_id",
        "product_id",
        "raw_base_rate",
        "raw_customer_rate",
        "rate_display_paise",
      ]) {
        expect(rate, internal).not.toHaveProperty(internal);
      }
    }
  });

  /**
   * Nothing must be able to mistake simulated rates for live ones — including
   * the UI, which reads this flag to render its development banner.
   */
  test("PublicRates_mockProvider_isDeclaredInMeta", async () => {
    const response = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}/rates`);
    expect(response.body.meta.simulated).toBe(true);
  });

  test("PublicRates_areNeverSharedCached", async () => {
    const response = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}/rates`);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

// ---------------------------------------------------------------------------
// /me
// ---------------------------------------------------------------------------

describe("session summary", () => {
  test("Me_authenticatedShopkeeper_returnsOwnTenantAndRole", async () => {
    const response = await request(api)
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${token_a}`);

    expect(response.status).toBe(200);
    expect(response.body.data.tenant.display_name).not.toBe("");
    expect(["owner", "manager", "staff"]).toContain(response.body.data.user.role);
    expect(response.body.data.tenant.public_slug).toBe(fx.tenant_a.slug);
  });

  test("Me_withoutToken_returns401", async () => {
    const response = await request(api).get("/api/v1/me");
    expect(response.status).toBe(401);
  });

  /** The browser derives the tenant from nothing; it never receives the UUID. */
  test("Me_neverReturnsTenantUuid", async () => {
    const response = await request(api)
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${token_a}`);

    expect(JSON.stringify(response.body)).not.toContain(fx.tenant_a.tenant_id);
  });

  test("Me_returnsTenantAOnly_forTenantAToken", async () => {
    const response = await request(api)
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${token_a}`);

    const b = await request(api).get(`${PUBLIC}/${fx.tenant_b.slug}`);
    expect(response.body.data.tenant.display_name).not.toBe(b.body.data.display_name);
    expect(response.body.data.tenant.public_slug).not.toBe(fx.tenant_b.slug);
  });
});

// ---------------------------------------------------------------------------
// Stream route mounting
// ---------------------------------------------------------------------------

describe("realtime route", () => {
  /**
   * This app was composed without a hub, so the stream must not exist. An
   * endpoint that accepts an EventSource and then never delivers anything is
   * worse than an honest 404 — the page would sit on a connection that can
   * never produce an update.
   */
  test("PublicStream_withoutHub_isNotMounted", async () => {
    const response = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}/stream`);
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// A shop that has not finished setting itself up
// ---------------------------------------------------------------------------

describe("incomplete tenant records", () => {
  /**
   * Branding is created during onboarding and can legitimately be absent. The
   * dashboard must still be able to name the shop rather than rendering a blank
   * heading, so the tenant's legal name is the fallback.
   */
  test("Me_withoutBranding_fallsBackToTheLegalName", async () => {
    await owner.tenant_branding.deleteMany({ where: { tenant_id: fx.tenant_b.tenant_id } });

    const response = await request(api)
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${token_b}`);

    expect(response.status).toBe(200);
    expect(response.body.data.tenant.display_name).toBe(fx.tenant_b.legal_name);
    expect(response.body.data.tenant.tagline).toBeNull();
  });

  /**
   * Before a customer link is issued there is no public page, and the dashboard
   * says so rather than linking to a slug that does not resolve.
   */
  test("Me_withoutCustomerLink_reportsNoPublicSlug", async () => {
    await owner.customer_links.deleteMany({ where: { tenant_id: fx.tenant_b.tenant_id } });

    const response = await request(api)
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${token_b}`);

    expect(response.status).toBe(200);
    expect(response.body.data.tenant.public_slug).toBeNull();
  });

  /**
   * A revoked link is not the shop's current address.
   *
   * Revocation is `is_active`, which is what `resolve_public_link` reads.
   * `/me` must agree with it, or the dashboard shows a link the public page
   * answers 410 for.
   */
  test("Me_withOnlyARevokedLink_reportsNoPublicSlug", async () => {
    await owner.customer_links.updateMany({
      where: { tenant_id: fx.tenant_b.tenant_id },
      data: { is_active: false, revoked_at: new Date() },
    });

    const response = await request(api)
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${token_b}`);

    expect(response.body.data.tenant.public_slug).toBeNull();
  });

  test("PublicShop_withoutBranding_stillResolvesTheSlug", async () => {
    await owner.tenant_branding.deleteMany({ where: { tenant_id: fx.tenant_b.tenant_id } });

    const response = await request(api).get(`${PUBLIC}/${fx.tenant_b.slug}`);

    expect(response.status).toBe(200);
    expect(response.body.data.slug).toBe(fx.tenant_b.slug);
    // Deliberately empty rather than the legal name: the public surface never
    // discloses it.
    expect(response.body.data.display_name).toBe("");
  });

  test("PublicRates_revokedSlug_returns410NotSilentlyAnotherShop", async () => {
    await owner.customer_links.updateMany({
      where: { tenant_id: fx.tenant_b.tenant_id },
      data: { is_active: false, revoked_at: new Date() },
    });

    const response = await request(api).get(`${PUBLIC}/${fx.tenant_b.slug}/rates`);
    expect(response.status).toBe(410);
  });
});
