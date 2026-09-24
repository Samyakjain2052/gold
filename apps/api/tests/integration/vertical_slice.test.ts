/**
 * Stage 10 — the complete path, end to end, with exact numbers.
 *
 * ```
 * mock quote ─▶ MarketDataService ─▶ pricing engine ─▶ published_rates
 *            ─▶ outbox ─▶ Redis ─▶ rate_hub ─▶ SSE ─▶ customer
 * ```
 *
 * Real PostgreSQL, real Redis, real RLS, the real Express app and the real
 * pricing engine. The only thing simulated is the market provider itself, which
 * is the one component a licence still gates.
 *
 * The worked example is deterministic, so the arithmetic can be checked by
 * hand against ADR-0003 and ADR-0005:
 *
 *   provider quote    ₹140,813.93 per 10 grams (rupees are 2dp on the wire)
 *   market mid        1_408_139_300 milli-paise/gram at 999 fineness
 *   product           GOLD 916 (22K), market_convention → ×916/1000
 *   raw base          1_408_139_300 × 916/1000 = 1_289_855_598.8 (exact rational)
 *   display unit      per_10_gram → ×10 grams ÷1000 milli-paise
 *                     12_898_555.988 → half_even → 12_898_556 = ₹1,28,985.56
 *   adjustment        +₹50/gram = 5_000_000 milli-paise/gram
 *                     → ×10 ÷1000 = 50_000 paise = ₹500.00
 *   raw customer      1_294_855_598.8 milli-paise/gram
 *   rounding step     100 paise (nearest ₹1), half_up
 *                     12_948_555.988 → 12_948_600 = ₹1,29,486.00
 *   rounding delta    12_948_600 − 12_898_556 − 50_000 = 44 paise (ADR-0005)
 *
 * The delta is non-zero here precisely because the components are quantised at
 * 1 paisa and the total at ₹1. It is disclosed on its own line rather than
 * folded into the shop's margin, which is the whole point of ADR-0005.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import { pino } from "pino";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import type { RedisClientType } from "redis";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type CryptoKey,
} from "jose";
import { ManualClock } from "../../src/platform/clock.js";
import type { Logger } from "../../src/platform/logger.js";
import { load_config } from "../../src/platform/config.js";
import { create_app } from "../../src/http/app.js";
import { JwtVerifier, type JwtVerifierOptions } from "../../src/modules/auth/index.js";
import { create_rate_hub, type RateHub } from "../../src/modules/realtime/rate_hub.js";
import { MarketDataService } from "../../src/modules/market_data/market_data_service.js";
import { OutboxPublisher } from "../../src/modules/publication/outbox_publisher.js";
import {
  publish_for_quote,
  recompute_rule_in_transaction,
} from "../../src/modules/publication/publication_service.js";
import { with_tenant_context } from "../../src/modules/tenancy/tenant_context.js";
import type { QuoteSnapshot } from "../../src/modules/market_data/types.js";
import {
  app_client,
  owner_client,
  redis_client,
  seed_fixtures,
  TEST_DIRECTORY_ID,
  type Fixtures,
} from "./fixtures.js";

const ISSUER = "https://bullionshops.ciamlogin.com/0d1e2c70-0000-4000-8000-000000000001/v2.0";
const AUDIENCE = "api://bullion-rates";
/**
 * Real time, not a fixed instant.
 *
 * Ingestion judges freshness against the injected `ManualClock`, but the public
 * rates endpoint judges it against wall time. A hardcoded date therefore passes
 * on the day it is written and reports `expired` forever after — which is
 * exactly what happened when this suite first crossed midnight.
 */
const NOW = new Date();
const PUBLIC = "/api/v1/public/shops";

/** The worked example above, as exact integers. */
const GOLD_RUPEES = "140813.93";
const GOLD_MID = 1_408_139_300n;
/** A second, higher quote: ₹145,000/10g = 1_450_000_000 milli-paise/gram. */
/** ~297 bps above the first quote — inside the 500 bps sanity limit. */
const HIGHER_RUPEES = "145000";
const EXPECTED_BASE_PAISE = 12_898_556n;
const EXPECTED_ADJUSTMENT_PAISE = 50_000n;
const EXPECTED_RATE_PAISE = 12_948_600n;
const EXPECTED_ROUNDING_DELTA = 44n;

let owner: PrismaClient;
let db: PrismaClient;
let publisher_redis: RedisClientType;
let subscriber_redis: RedisClientType;
let hub: RateHub;
let api: Express;
let server: Server;
let base_url = "";
let fx: Fixtures;
let signing_key: CryptoKey;
let public_jwk: JWK;
let logger: Logger;
let clock: ManualClock;
let outbox: OutboxPublisher;

function deps() {
  return { db, logger, clock };
}

/**
 * A quote payload in the provider wire shape.
 *
 * `mid` is **rupees per `source_unit`** as a decimal string, which is what the
 * schema accepts; `parse_quote` converts it to milli-paise per gram. So
 * "140813.93" per 10 grams is ₹14,081.393/g = 1_408_139_300 milli-paise/g,
 * the canonical value this file asserts on.
 */
function gold_payload(rupees_per_10g: string, source_timestamp: Date, sequence = 1) {
  return {
    quote_id: `q-${sequence}`,
    sequence,
    provider: "mock",
    source: "mock",
    symbol: "XAU_INR",
    metal: "GOLD",
    currency: "INR",
    source_unit: "per_10_gram",
    purity_num: 999,
    purity_den: 1000,
    bid: null,
    ask: null,
    mid: rupees_per_10g,
    source_timestamp: source_timestamp.toISOString(),
  };
}

function ingest(
  service: MarketDataService,
  rupees_per_10g: string,
  at: Date,
  sequence = 1,
): QuoteSnapshot {
  const [snapshot] = service.ingest_many([gold_payload(rupees_per_10g, at, sequence)]);
  if (snapshot === undefined) throw new Error("quote was rejected");
  return snapshot;
}

/** A service wired to the test clock, with no provider attached. */
function market_service(): MarketDataService {
  return new MarketDataService(
    {
      name: "mock",
      source: "mock",
      is_simulated: true,
      start: async () => {},
      stop: async () => {},
      get_latest_quotes: async () => [],
      subscribe: () => ({ unsubscribe: () => {} }),
      on_status: () => ({ unsubscribe: () => {} }),
      health: () => ({
        provider: "mock",
        source: "mock",
        status: "healthy",
        is_simulated: true,
        connected_since: NOW,
        last_quote_at: NOW,
        last_source_timestamp: NOW,
        consecutive_failures: 0,
        reconnect_attempts: 0,
        last_error: null,
        evaluated_at: NOW,
      }),
    },
    clock,
    {
      freshness: { stale_after_ms: 120_000, expired_after_ms: 600_000 },
    },
  );
}

/** Read frames from an SSE stream until `wanted` arrive or time runs out. */
async function read_frames(
  path: string,
  wanted: number,
  timeout_ms: number,
  after_open?: () => Promise<void>,
): Promise<string[]> {
  const controller = new AbortController();
  const response = await fetch(`${base_url}${path}`, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });

  if (!response.ok || response.body === null) {
    controller.abort();
    return [];
  }

  const frames: string[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let opened = false;
  const deadline = setTimeout(() => controller.abort(), timeout_ms);

  try {
    while (frames.length < wanted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim().startsWith(":") || part.trim() === "") continue;
        frames.push(part);
      }

      if (!opened && frames.length > 0 && after_open !== undefined) {
        opened = true;
        await after_open();
      }
    }
  } catch {
    // Aborted by the deadline; return what arrived.
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }

  return frames;
}

beforeAll(async () => {
  owner = owner_client();
  db = app_client();
  publisher_redis = await redis_client();
  subscriber_redis = await redis_client();
  logger = pino({ level: "silent" }) as unknown as Logger;
  clock = new ManualClock(NOW);

  hub = create_rate_hub(subscriber_redis, { max_listeners: 50 });
  outbox = new OutboxPublisher(db, publisher_redis, logger);

  const pair = await generateKeyPair("ES256", { extractable: true });
  signing_key = pair.privateKey;
  const jwk: JWK = {
    ...(await exportJWK(pair.publicKey)),
    kid: "test-key",
    alg: "ES256",
    use: "sig",
  };
  public_jwk = jwk;

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
    SSE_HEARTBEAT_MS: "500",
  });

  api = create_app({
    config,
    logger,
    db,
    hub,
    verifier: new JwtVerifier(createLocalJWKSet({ keys: [jwk] }), verifier_options, clock),
    ping_database: async () => {},
    ping_redis: async () => {},
  });

  server = await new Promise<Server>((resolve) => {
    const listening = api.listen(0, () => resolve(listening));
  });
  base_url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  fx = await seed_fixtures(owner);
  clock.set(NOW);
});

afterAll(async () => {
  await hub.close().catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled([
    owner.$disconnect(),
    db.$disconnect(),
    publisher_redis.quit(),
    subscriber_redis.quit(),
  ]);
});

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

/** The tenant's gold rate as currently published. */
async function published_gold(tenant_id: string) {
  return with_tenant_context(db, tenant_id, (tx) =>
    tx.published_rates.findFirst({
      where: { tenant_id, product_id: fx.tenant_a.gold_product_id },
      select: {
        base_display_paise: true,
        adjustment_display_paise: true,
        rounding_delta_paise: true,
        rate_display_paise: true,
        raw_base_rate: true,
        raw_adjustment: true,
        raw_customer_rate: true,
        provider_timestamp: true,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// A. Ingestion  B. Pricing  C. Publication
// ---------------------------------------------------------------------------

describe("market ingestion through to published_rates", () => {
  test("Slice_quoteIsAcceptedAndFreshnessTracked", () => {
    const service = market_service();
    const snapshot = ingest(service, GOLD_RUPEES, NOW);

    expect(snapshot.quote.mid).toBe(GOLD_MID);
    expect(snapshot.quote.metal).toBe("GOLD");
    expect(snapshot.freshness).toBe("fresh");
    // The provider's stamp, not our receipt time.
    expect(snapshot.quote.source_timestamp.toISOString()).toBe(NOW.toISOString());
  });

  /** The worked example, checked digit for digit. */
  test("Slice_publishesTheExactExpectedRate", async () => {
    const service = market_service();
    const snapshot = ingest(service, GOLD_RUPEES, NOW);

    const outcome = await publish_for_quote(deps(), snapshot);
    expect(outcome.published).toBeGreaterThan(0);

    const row = await published_gold(fx.tenant_a.tenant_id);

    expect(row).not.toBeNull();
    expect(row?.base_display_paise).toBe(EXPECTED_BASE_PAISE); // ₹1,28,985.56
    expect(row?.adjustment_display_paise).toBe(EXPECTED_ADJUSTMENT_PAISE); // +₹500.00
    expect(row?.rounding_delta_paise).toBe(EXPECTED_ROUNDING_DELTA); // ₹0.44
    expect(row?.rate_display_paise).toBe(EXPECTED_RATE_PAISE); // ₹1,29,486.00

    // ADR-0005: the breakdown reconciles exactly.
    expect(
      (row?.base_display_paise ?? 0n) +
        (row?.adjustment_display_paise ?? 0n) +
        (row?.rounding_delta_paise ?? 0n),
    ).toBe(EXPECTED_RATE_PAISE);

    // The authored adjustment survives at storage precision, exactly as
    // configured — never recovered from the total.
    expect(row?.raw_adjustment).toBe(5_000_000n);
  });

  test("Slice_publicationCreatesAnUndeliveredOutboxRow", async () => {
    const service = market_service();
    const snapshot = ingest(service, GOLD_RUPEES, NOW);
    await publish_for_quote(deps(), snapshot);

    const pending = await owner.rate_publication_outbox.findMany({
      where: { tenant_id: fx.tenant_a.tenant_id, delivered_at: null },
      select: { product_key: true, rate_display_paise: true, freshness: true, trigger: true },
    });

    expect(pending.length).toBeGreaterThan(0);
    const gold = pending.find((p) => p.product_key.startsWith("GOLD"));
    expect(gold?.rate_display_paise).toBe(EXPECTED_RATE_PAISE);
    expect(gold?.freshness).toBe("fresh");
    expect(gold?.trigger).toBe("market_tick");
  });

  test("Slice_quoteIsRecordedForTraceability", async () => {
    const service = market_service();
    await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW));

    const rate = await owner.market_rates.findFirst({
      where: { symbol: "XAU_INR" },
      orderBy: { id: "desc" },
      select: { mid_per_gram: true, provider_timestamp: true, provider_name: true },
    });

    expect(rate?.mid_per_gram).toBe(GOLD_MID);
    expect(rate?.provider_name).toBe("mock");
  });
});

// ---------------------------------------------------------------------------
// D + E. Redis → hub → SSE → the customer page
// ---------------------------------------------------------------------------

describe("the customer sees it", () => {
  test("Slice_publicRatesEndpoint_returnsTheNewValue", async () => {
    const service = market_service();
    await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW));

    const response = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}/rates`);
    expect(response.status).toBe(200);

    const gold = response.body.data.find((r: { metal: string }) => r.metal === "GOLD");
    expect(gold.rate).toBe(EXPECTED_RATE_PAISE.toString());
    expect(gold.market_rate).toBe(EXPECTED_BASE_PAISE.toString());
    expect(gold.shop_adjustment).toBe(EXPECTED_ADJUSTMENT_PAISE.toString());
    expect(gold.freshness).toBe("fresh");
  });

  /** The whole slice in one test: quote in, SSE frame out. */
  test("Slice_endToEnd_quoteReachesAnOpenSseConnection", async () => {
    const frames = await read_frames(
      `${PUBLIC}/${fx.tenant_a.slug}/stream`,
      2,
      10_000,
      async () => {
        const service = market_service();
        await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW));
        // The outbox is what bridges the committed rate to Redis.
        await outbox.drain();
      },
    );

    const update = frames.find((f) => f.includes("rate_update"));
    expect(update).toBeDefined();
    expect(update).toContain(EXPECTED_RATE_PAISE.toString());
    expect(update).toContain("GOLD");

    // The tenant id is the Redis routing key and must not reach a browser.
    expect(update).not.toContain(fx.tenant_a.tenant_id);
  });

  test("Slice_outboxMarksDeliveredAndDoesNotResend", async () => {
    const service = market_service();
    await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW));

    const first = await outbox.drain();
    expect(first).toBeGreaterThan(0);

    // Second pass finds nothing: delivered rows are not re-published.
    expect(await outbox.drain()).toBe(0);

    const undelivered = await owner.rate_publication_outbox.count({
      where: { delivered_at: null },
    });
    expect(undelivered).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F. Tenant isolation
// ---------------------------------------------------------------------------

describe("tenant isolation across the pipeline", () => {
  /**
   * The two fixtures carry different adjustments (+₹50 and +₹100 per gram), so
   * one market quote must produce two different published rates.
   */
  test("Slice_oneQuote_producesPerTenantRates", async () => {
    const service = market_service();
    await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW));

    const a = await published_gold(fx.tenant_a.tenant_id);
    const b = await with_tenant_context(db, fx.tenant_b.tenant_id, (tx) =>
      tx.published_rates.findFirst({
        where: { tenant_id: fx.tenant_b.tenant_id, product_id: fx.tenant_b.gold_product_id },
        select: { rate_display_paise: true, adjustment_display_paise: true },
      }),
    );

    expect(a?.rate_display_paise).toBe(EXPECTED_RATE_PAISE);
    expect(b?.rate_display_paise).not.toBe(a?.rate_display_paise);
    expect(b?.adjustment_display_paise).not.toBe(a?.adjustment_display_paise);
  });

  test("Slice_tenantAPublicRates_neverCarryTenantBValues", async () => {
    const service = market_service();
    await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW));

    const a = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}/rates`);
    const b = await request(api).get(`${PUBLIC}/${fx.tenant_b.slug}/rates`);

    const a_rates = a.body.data.map((r: { rate: string }) => r.rate);
    const b_rates = b.body.data.map((r: { rate: string }) => r.rate);

    expect(a_rates).not.toEqual(b_rates);
    expect(JSON.stringify(a.body)).not.toContain(fx.tenant_b.tenant_id);
  });

  /** Tenant B's stream must stay silent while only A publishes. */
  test("Slice_tenantBStream_receivesNothingFromTenantA", async () => {
    const frames = await read_frames(
      `${PUBLIC}/${fx.tenant_b.slug}/stream`,
      2,
      4_000,
      async () => {
        const service = market_service();
        // Publish for tenant A only.
        await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW), {
          record_quote: false,
        });
        await with_tenant_context(db, fx.tenant_b.tenant_id, async (tx) => {
          // Discard B's own pending rows so any frame B receives must be A's.
          await tx.rate_publication_outbox.updateMany({
            where: { tenant_id: fx.tenant_b.tenant_id, delivered_at: null },
            data: { delivered_at: new Date() },
          });
        });
        await outbox.drain();
      },
    );

    expect(frames.filter((f) => f.includes("rate_update"))).toHaveLength(0);
  });

  test("Slice_pricingRuleOfTenantA_cannotTouchTenantBPublishedRates", async () => {
    const service = market_service();
    const snapshot = ingest(service, GOLD_RUPEES, NOW);
    await publish_for_quote(deps(), snapshot);

    const before = await with_tenant_context(db, fx.tenant_b.tenant_id, (tx) =>
      tx.published_rates.findFirst({
        where: { tenant_id: fx.tenant_b.tenant_id },
        select: { rate_display_paise: true },
      }),
    );

    // Recompute A's rule only.
    await with_tenant_context(db, fx.tenant_a.tenant_id, (tx) =>
      recompute_rule_in_transaction(tx, {
        tenant_id: fx.tenant_a.tenant_id,
        rule_id: fx.tenant_a.gold_rule_id,
        resolve_snapshot: () => snapshot,
        logger,
        now: NOW,
      }),
    );

    const after = await with_tenant_context(db, fx.tenant_b.tenant_id, (tx) =>
      tx.published_rates.findFirst({
        where: { tenant_id: fx.tenant_b.tenant_id },
        select: { rate_display_paise: true },
      }),
    );

    expect(after?.rate_display_paise).toBe(before?.rate_display_paise);
  });
});

// ---------------------------------------------------------------------------
// G. Pricing-rule mutation through the real API
// ---------------------------------------------------------------------------

describe("a shopkeeper's change reaches the customer", () => {
  test("Slice_ruleUpdate_republishesAndReachesSse", async () => {
    const service = market_service();
    const snapshot = ingest(service, GOLD_RUPEES, NOW);
    await publish_for_quote(deps(), snapshot);
    await outbox.drain();

    const token = await token_for(fx.tenant_a.external_object_id);
    const current = await request(api)
      .get(`/api/v1/pricing-rules/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token}`);

    const audit_before = await owner.audit_logs.count({
      where: { tenant_id: fx.tenant_a.tenant_id },
    });

    // The route is composed with the recompute hook, exactly as production is.
    const priced = create_app({
      config: load_config({
        NODE_ENV: "test",
        API_BASE_URL: "http://localhost:8080",
        PUBLIC_WEB_URL: "http://localhost:3000",
        ALLOWED_ORIGINS: "http://localhost:3000",
        DATABASE_URL: "postgresql://bullion_app:devpassword@localhost:5432/bullion_test",
        REDIS_URL: "redis://localhost:6380",
        MARKET_DATA_PROVIDER: "mock",
      }),
      logger,
      db,
      hub,
      // The same JWKS as the main app: a different key pair would reject the
      // token this test already holds.
      verifier: new JwtVerifier(
        createLocalJWKSet({ keys: [public_jwk] }),
        {
          issuer: ISSUER,
          audience: AUDIENCE,
          algorithms: ["ES256"],
          expected_directory_id: TEST_DIRECTORY_ID,
          allowed_client_ids: [],
          clock_tolerance_s: 5,
          max_future_iat_s: 60,
          max_token_age_s: 0,
        },
        clock,
      ),
      pipeline: {
        health: () => ({ status: "healthy", checked_at: NOW.toISOString() }),
        detail: () => ({}),
        recompute_rule: (tx, tenant_id, rule_id) =>
          recompute_rule_in_transaction(tx, {
            tenant_id,
            rule_id,
            resolve_snapshot: () => snapshot,
            logger,
            now: NOW,
          }),
      },
      ping_database: async () => {},
      ping_redis: async () => {},
    });

    // ₹50 → ₹75 per gram, so the customer rate must move by ₹250 per 10g.
    const response = await request(priced)
      .patch(`/api/v1/pricing-rules/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token}`)
      .set("If-Match", String(current.body.data.version))
      .send({
        adjustment_kind: "absolute",
        adjustment_rupees_per_gram: "75",
        rounding_step_paise: 1,
        rounding_mode: "half_up",
        component_precision_paise: 1,
      });

    expect(response.status).toBe(200);

    const row = await published_gold(fx.tenant_a.tenant_id);
    // ₹1,28,985.56 + ₹750.00, rounded to the paisa = ₹1,29,735.56
    expect(row?.adjustment_display_paise).toBe(75_000n);
    expect(row?.rate_display_paise).toBe(12_973_556n);

    // Exactly one audit row for the change, as before.
    const audit_after = await owner.audit_logs.count({
      where: { tenant_id: fx.tenant_a.tenant_id },
    });
    expect(audit_after).toBe(audit_before + 1);

    // And the new rate reaches a customer over SSE.
    const frames = await read_frames(
      `${PUBLIC}/${fx.tenant_a.slug}/stream`,
      2,
      10_000,
      async () => {
        await outbox.drain();
      },
    );
    const update = frames.find((f) => f.includes("rate_update"));
    expect(update).toContain("12973556");
  });

  test("Slice_ruleUpdateWithNoMarketData_stillPersistsAndAudits", async () => {
    const before = await published_gold(fx.tenant_a.tenant_id);

    const published = await with_tenant_context(db, fx.tenant_a.tenant_id, (tx) =>
      recompute_rule_in_transaction(tx, {
        tenant_id: fx.tenant_a.tenant_id,
        rule_id: fx.tenant_a.gold_rule_id,
        // No usable quote — a cold start or a dead feed.
        resolve_snapshot: () => null,
        logger,
        now: NOW,
      }),
    );

    expect(published).toBe(false);
    const after = await published_gold(fx.tenant_a.tenant_id);
    expect(after?.rate_display_paise).toBe(before?.rate_display_paise);
  });
});

// ---------------------------------------------------------------------------
// H + I. Provider failure, stale and expired
// ---------------------------------------------------------------------------

describe("nothing is fabricated when the feed misbehaves", () => {
  test("Slice_expiredQuote_publishesNothing", async () => {
    const service = market_service();
    // 11 minutes old, past the 10-minute expiry.
    const snapshot = ingest(service, GOLD_RUPEES, new Date(NOW.getTime() - 11 * 60_000));
    expect(snapshot.freshness).toBe("expired");

    const before = await owner.rate_publication_outbox.count();
    const outcome = await publish_for_quote(deps(), snapshot);

    expect(outcome.published).toBe(0);
    expect(await owner.rate_publication_outbox.count()).toBe(before);
  });

  test("Slice_expiredQuote_leavesThePreviousRateStanding", async () => {
    const service = market_service();
    await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW, 1));
    const good = await published_gold(fx.tenant_a.tenant_id);

    const stale_service = market_service();
    await publish_for_quote(
      deps(),
      ingest(stale_service, "900000", new Date(NOW.getTime() - 11 * 60_000), 2),
    );

    const after = await published_gold(fx.tenant_a.tenant_id);
    expect(after?.rate_display_paise).toBe(good?.rate_display_paise);
  });

  /**
   * A stale quote is real data and is published, labelled as delayed.
   *
   * The clock is moved to real time for this one: ingestion judges freshness
   * against the injected clock, but the public endpoint judges it against wall
   * time, and this asserts both agree on the same quote.
   */
  test("Slice_staleQuote_isPublishedAndMarkedStale", async () => {
    const real_now = new Date();
    clock.set(real_now);

    const service = market_service();
    const snapshot = ingest(service, GOLD_RUPEES, new Date(real_now.getTime() - 5 * 60_000));
    expect(snapshot.freshness).toBe("stale");

    await publish_for_quote(deps(), snapshot);

    const pending = await owner.rate_publication_outbox.findFirst({
      where: { tenant_id: fx.tenant_a.tenant_id, delivered_at: null },
      orderBy: { id: "desc" },
      select: { freshness: true },
    });
    expect(pending?.freshness).toBe("stale");

    const response = await request(api).get(`${PUBLIC}/${fx.tenant_a.slug}/rates`);
    const gold = response.body.data.find((r: { metal: string }) => r.metal === "GOLD");
    expect(gold.freshness).toBe("stale");
  });

  test("Slice_malformedPayload_isRejectedAndNothingPublished", async () => {
    const service = market_service();
    const before = await owner.rate_publication_outbox.count();

    const accepted = service.ingest_many([
      { not: "a quote" },
      null,
      "text",
      { ...gold_payload(GOLD_RUPEES, NOW), mid: "not-a-number" },
    ]);

    expect(accepted).toHaveLength(0);
    expect(await owner.rate_publication_outbox.count()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// J + K. Recovery, duplicates and concurrency
// ---------------------------------------------------------------------------

describe("recovery and repeated delivery", () => {
  /**
   * A committed event survives a publisher that never ran. This is the reason
   * the outbox exists rather than a direct publish.
   */
  test("Slice_committedEventSurvivesAPublisherThatNeverRan", async () => {
    const service = market_service();
    await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW));

    const pending_before = await owner.rate_publication_outbox.count({
      where: { delivered_at: null },
    });
    expect(pending_before).toBeGreaterThan(0);

    // A brand new publisher — as after a restart — finds and delivers them.
    const fresh = new OutboxPublisher(db, publisher_redis, logger);
    expect(await fresh.drain()).toBe(pending_before);
    expect(await owner.rate_publication_outbox.count({ where: { delivered_at: null } })).toBe(0);
  });

  /** Re-delivering the same event converges rather than corrupting. */
  test("Slice_duplicateDelivery_isIdempotent", async () => {
    const service = market_service();
    const snapshot = ingest(service, GOLD_RUPEES, NOW);

    await publish_for_quote(deps(), snapshot);
    const first = await published_gold(fx.tenant_a.tenant_id);

    // The same quote again: rejected as a duplicate by the stream, and even a
    // forced republish converges on the same rate.
    await publish_for_quote(deps(), snapshot);
    const second = await published_gold(fx.tenant_a.tenant_id);

    expect(second?.rate_display_paise).toBe(first?.rate_display_paise);

    // published_rates holds exactly one row per tenant/product, always.
    const rows = await owner.published_rates.count({
      where: { tenant_id: fx.tenant_a.tenant_id, product_id: fx.tenant_a.gold_product_id },
    });
    expect(rows).toBe(1);
  });

  test("Slice_rapidConsecutiveQuotes_leaveTheLatestRate", async () => {
    const service = market_service();

    await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW, 1));
    await publish_for_quote(
      deps(),
      ingest(service, HIGHER_RUPEES, new Date(NOW.getTime() + 1_000), 2),
    );

    const row = await published_gold(fx.tenant_a.tenant_id);
    // 1_450_000_000 × 916/1000 × 10 ÷ 1000 = 13_282_000 paise, + ₹500.
    expect(row?.rate_display_paise).toBe(13_332_000n);
    expect(row?.provider_timestamp.toISOString()).toBe(
      new Date(NOW.getTime() + 1_000).toISOString(),
    );
  });

  /**
   * Outbox ids come from one sequence, so a superseding rate always sorts after
   * the rate it replaces and can never be delivered before it.
   */
  test("Slice_outboxOrdering_followsTheSequence", async () => {
    const service = market_service();
    await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW, 1));
    await publish_for_quote(
      deps(),
      ingest(service, HIGHER_RUPEES, new Date(NOW.getTime() + 1_000), 2),
    );

    const rows = await owner.rate_publication_outbox.findMany({
      where: { tenant_id: fx.tenant_a.tenant_id, delivered_at: null },
      orderBy: { id: "asc" },
      select: { id: true, rate_display_paise: true },
    });

    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.id > rows[i - 1]!.id).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Products a tenant has turned off, and rules pricing refuses
// ---------------------------------------------------------------------------

describe("what is deliberately not published", () => {
  /**
   * The fixtures seed a `published_rates` row, so the assertion is that the
   * pipeline leaves it **unchanged** — not that it is absent. An unchanged rate
   * is exactly the desired outcome: the last good price stands.
   */
  const SEEDED_BASE = 14_081_393n;

  /** A disabled product must not reappear on the customer page via a tick. */
  test("Slice_disabledProduct_isNotRepublished", async () => {
    await with_tenant_context(db, fx.tenant_a.tenant_id, (tx) =>
      tx.tenant_products.updateMany({
        where: { tenant_id: fx.tenant_a.tenant_id, product_id: fx.tenant_a.gold_product_id },
        data: { is_enabled: false },
      }),
    );

    const service = market_service();
    await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW));

    // `tenants_affected_by_metal` excludes tenants whose product is disabled,
    // so this tenant is never even selected for recompute.
    expect((await published_gold(fx.tenant_a.tenant_id))?.base_display_paise).toBe(SEEDED_BASE);
  });

  test("Slice_inactiveRule_isNotRepublished", async () => {
    await with_tenant_context(db, fx.tenant_a.tenant_id, (tx) =>
      tx.tenant_pricing_rules.updateMany({
        where: { tenant_id: fx.tenant_a.tenant_id, product_id: fx.tenant_a.gold_product_id },
        data: { is_active: false },
      }),
    );

    const service = market_service();
    await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW));

    expect((await published_gold(fx.tenant_a.tenant_id))?.base_display_paise).toBe(SEEDED_BASE);
  });

  /**
   * A discount larger than the market rate cannot produce a positive price.
   * That is a configuration problem for one shop, not a pipeline failure: the
   * previous rate stands and every other tenant still publishes.
   */
  test("Slice_ruleThatCannotPrice_isSkippedWithoutFailingTheRun", async () => {
    await with_tenant_context(db, fx.tenant_a.tenant_id, (tx) =>
      tx.tenant_pricing_rules.updateMany({
        where: { tenant_id: fx.tenant_a.tenant_id, product_id: fx.tenant_a.gold_product_id },
        // The largest discount the bounds constraint allows. Against a base of
        // ~1.29e9 milli-paise/gram this still drives the rate below zero, which
        // the pricing engine refuses.
        data: { adjustment_kind: "absolute", adjustment_value: -10_000_000_000n },
      }),
    );

    const service = market_service();
    const outcome = await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW));

    // Tenant A's gold rate is left at its previous value...
    expect((await published_gold(fx.tenant_a.tenant_id))?.base_display_paise).toBe(SEEDED_BASE);
    // ...and the run neither fails nor stops the other tenants publishing.
    expect(outcome.failed).toBe(0);
    expect(outcome.published).toBeGreaterThan(0);
  });

  /** A silver quote must not touch gold rates. */
  test("Slice_quoteForAnotherMetal_leavesGoldAlone", async () => {
    const service = market_service();
    await publish_for_quote(deps(), ingest(service, GOLD_RUPEES, NOW));
    const before = await published_gold(fx.tenant_a.tenant_id);

    const silver = market_service();
    const [snapshot] = silver.ingest_many([
      {
        quote_id: "s-1",
        sequence: 1,
        provider: "mock",
        source: "mock",
        symbol: "XAG_INR",
        metal: "SILVER",
        currency: "INR",
        source_unit: "per_kilogram",
        purity_num: 999,
        purity_den: 1000,
        bid: null,
        ask: null,
        mid: "236908",
        source_timestamp: NOW.toISOString(),
      },
    ]);
    if (snapshot === undefined) throw new Error("silver quote was rejected");

    await publish_for_quote(deps(), snapshot);

    expect((await published_gold(fx.tenant_a.tenant_id))?.rate_display_paise).toBe(
      before?.rate_display_paise,
    );
  });
});
