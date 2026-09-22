/**
 * Stage 9 — regressions for the production-readiness audit.
 *
 * Each test here corresponds to a defect the audit found, so that re-opening
 * one is a red build rather than a rediscovery.
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
import { market_data_health } from "../../src/platform/health.js";
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
let api: Express;
let signing_key: CryptoKey;
let token_a = "";

function base_env(): Record<string, string> {
  return {
    NODE_ENV: "test",
    API_BASE_URL: "http://localhost:8080",
    PUBLIC_WEB_URL: "http://localhost:3000",
    ALLOWED_ORIGINS: "http://localhost:3000",
    DATABASE_URL: "postgresql://bullion_app:devpassword@localhost:5432/bullion_test",
    REDIS_URL: "redis://localhost:6380",
    MARKET_DATA_PROVIDER: "mock",
  };
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
    config: load_config(base_env()),
    logger: pino({ level: "silent" }),
    db,
    verifier: new JwtVerifier(
      createLocalJWKSet({ keys: [jwk] }),
      verifier_options,
      new ManualClock(NOW),
    ),
    ping_database: async () => {},
    ping_redis: async () => {},
  });
});

beforeEach(async () => {
  fx = await seed_fixtures(owner);
  const now_s = Math.floor(NOW.getTime() / 1000);
  token_a = await new SignJWT({
    oid: fx.tenant_a.external_object_id,
    tid: TEST_DIRECTORY_ID,
  })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("pairwise-a")
    .setIssuedAt(now_s)
    .setExpirationTime(now_s + 3600)
    .sign(signing_key);
});

afterAll(async () => {
  await Promise.allSettled([owner.$disconnect(), db.$disconnect()]);
});

// ---------------------------------------------------------------------------
// Caching of authenticated responses
// ---------------------------------------------------------------------------

describe("authenticated responses are never stored", () => {
  /**
   * `pricing_rules` sends an ETag, which makes a response heuristically
   * cacheable when no `Cache-Control` accompanies it. A browser on a shared
   * showroom machine could then retain one tenant's pricing after sign-out.
   */
  test.each([
    ["/api/v1/me"],
    ["/api/v1/pricing-rules"],
    ["/api/v1/audit-logs"],
  ])("Readiness_%s_sendsNoStore", async (path) => {
    const response = await request(api).get(path).set("Authorization", `Bearer ${token_a}`);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  test("Readiness_pricingRule_hasAnEtagAndStillForbidsStorage", async () => {
    const response = await request(api)
      .get(`/api/v1/pricing-rules/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`);

    expect(response.headers["etag"]).toBeDefined();
    expect(response.headers["cache-control"]).toContain("no-store");
  });
});

// ---------------------------------------------------------------------------
// Caching of public, tenant-specific responses
// ---------------------------------------------------------------------------

describe("public responses cannot be shared across tenants", () => {
  /**
   * The shop document is cacheable, but only ever under its own slug. Two
   * tenants must produce different bodies at different URLs, so a shared cache
   * keyed on the URL can never answer one shop's request with another's.
   */
  test("Readiness_shopResponses_areKeyedBySlugAndDiffer", async () => {
    const a = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}`);
    const b = await request(api).get(`${PUBLIC}/${fx.tenant_b.slug}`);

    expect(a.body.data.display_name).not.toBe(b.body.data.display_name);
    expect(a.headers["cache-control"]).toContain("max-age");
    // No Vary on a credential or cookie: there is no request dimension other
    // than the path that changes this body, so caching it is safe.
    expect(a.headers["vary"] ?? "").not.toContain("Authorization");
  });

  /** Rates must never be stored by an intermediary: freshness is the product. */
  test("Readiness_rates_areNeverStored", async () => {
    const response = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}/rates`);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  test("Readiness_publicEndpoints_neverSetAPrivateCacheOnAnotherTenant", async () => {
    const a = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}`);
    expect(JSON.stringify(a.body)).not.toContain(fx.tenant_b.tenant_id);
    expect(JSON.stringify(a.body)).not.toContain(fx.tenant_b.slug);
  });
});

// ---------------------------------------------------------------------------
// Readiness must not claim health without a market feed
// ---------------------------------------------------------------------------

describe("readiness reflects the missing rate pipeline", () => {
  /**
   * Nothing converts quotes into `published_rates` or emits rate events. In
   * production that must read as unhealthy: `aggregate` treats
   * `not_configured` as a non-failure, so leaving it there would let
   * `/health/ready` return 200 — which is precisely what `cd.yml` gates a
   * deployment on.
   */
  test("Readiness_marketData_isUnhealthyInProduction", () => {
    const health = market_data_health({
      ...load_config(base_env()),
      NODE_ENV: "production",
    } as never);

    expect(health.status).toBe("unhealthy");
    expect(health.detail).toMatch(/publication pipeline/i);
  });

  test("Readiness_marketData_isNotConfiguredOutsideProduction", () => {
    expect(market_data_health(load_config(base_env())).status).toBe("not_configured");
  });

  /** Local and CI work must not be blocked by the knowingly-absent component. */
  test("Readiness_endpoint_isStillServableInTest", async () => {
    const response = await request(api).get("/health/ready");
    expect(response.status).toBe(200);
    expect(response.body.components.market_data.status).toBe("not_configured");
  });
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

describe("CORS", () => {
  test("Readiness_cors_reflectsOnlyAllowedOrigins", async () => {
    const allowed = await request(api)
      .get(`${PUBLIC}/${fx.tenant_a.slug}`)
      .set("Origin", "http://localhost:3000");

    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  test("Readiness_cors_refusesAnUnlistedOrigin", async () => {
    const denied = await request(api)
      .get(`${PUBLIC}/${fx.tenant_a.slug}`)
      .set("Origin", "https://evil.test");

    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  /**
   * Credentials are off because this is a Bearer API with no cookie auth. That
   * is also what makes the absence of CSRF defences correct, so it must not
   * drift.
   */
  test("Readiness_cors_neverAllowsCredentials", async () => {
    const response = await request(api)
      .get(`${PUBLIC}/${fx.tenant_a.slug}`)
      .set("Origin", "http://localhost:3000");

    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});
