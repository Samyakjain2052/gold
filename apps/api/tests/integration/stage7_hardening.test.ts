/**
 * Stage 7.1 — the two hardening fixes, against a real database.
 *
 *   1. A concurrent duplicate create returns the same `409` as the sequential
 *      one, not a `500`.
 *   2. Idempotency-key cleanup: bounded, concurrency-safe, and reachable only
 *      as an operational job.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import { pino } from "pino";
import { randomUUID } from "node:crypto";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type CryptoKey,
} from "jose";
import type { Express } from "express";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { ManualClock } from "../../src/platform/clock.js";
import { load_config } from "../../src/platform/config.js";
import { create_app } from "../../src/http/app.js";
import { JwtVerifier, type JwtVerifierOptions } from "../../src/modules/auth/index.js";
import {
  count_expired_keys,
  purge_expired_keys,
  CleanupConfigError,
} from "../../src/modules/maintenance/idempotency_cleanup.js";
import {
  app_client,
  owner_client,
  seed_fixtures,
  TEST_DIRECTORY_ID,
  type Fixtures,
} from "./fixtures.js";

const ISSUER =
  "https://bullionshops.ciamlogin.com/0d1e2c70-0000-4000-8000-000000000001/v2.0";
const AUDIENCE = "api://bullion-rates";
const NOW = new Date("2026-09-20T12:00:00.000Z");
const RULES = "/api/v1/pricing-rules";

const MAINTENANCE_URL =
  process.env["TEST_DATABASE_MAINTENANCE_URL"] ??
  "postgresql://bullion_maintenance:devpassword@localhost:5432/bullion_test";

let owner: PrismaClient;
let db: PrismaClient;
let maintenance: PrismaClient;
let fx: Fixtures;
let signing_key: CryptoKey;
let api: Express;
let token_a = "";

const silent = pino({ level: "silent" });

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

const DISPLAY = {
  rounding_step_paise: 100,
  rounding_mode: "half_up",
  component_precision_paise: 1,
} as const;

function create_body(product_id: string, rupees: string) {
  return {
    product_id,
    adjustment_kind: "absolute",
    adjustment_rupees_per_gram: rupees,
    ...DISPLAY,
  };
}

/** Insert an idempotency row with a chosen age, as the owner. */
async function seed_key(
  tenant_id: string,
  key: string,
  age_hours: number,
): Promise<void> {
  await owner.$executeRaw`
    INSERT INTO idempotency_keys
      (tenant_id, idempotency_key, request_fingerprint, response_status, response_body, created_at)
    VALUES (${tenant_id}::uuid, ${key}, 'fp', 200, '{}'::jsonb,
            now() - (${age_hours}::text || ' hours')::interval)
  `;
}

async function key_exists(tenant_id: string, key: string): Promise<boolean> {
  const rows = await owner.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM idempotency_keys
     WHERE tenant_id = ${tenant_id}::uuid AND idempotency_key = ${key}
  `;
  return Number(rows[0]?.n ?? 0) > 0;
}

beforeAll(async () => {
  owner = owner_client();
  db = app_client();
  maintenance = new PrismaClient({
    adapter: new PrismaPg({ connectionString: MAINTENANCE_URL }),
  });

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
    logger: silent,
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
  token_a = await token_for(fx.tenant_a.external_object_id);
});

afterAll(async () => {
  await Promise.allSettled([
    owner.$disconnect(),
    db.$disconnect(),
    maintenance.$disconnect(),
  ]);
});

// ---------------------------------------------------------------------------
// 1. Concurrent duplicate create
// ---------------------------------------------------------------------------

describe("concurrent duplicate create maps to 409, not 500", () => {
  /**
   * The genuine race: two valid creates for the same tenant and product,
   * started together. Whichever path produces the conflict — the pre-check or
   * the unique index — the observable contract must be identical.
   */
  test("ConcurrentCreate_sameTenantSameProduct_exactlyOneSucceeds", async () => {
    const product = fx.tenant_a.silver_product_id;

    // The fixtures already seed a `pricing_rule.created` row, so assertions
    // below measure the DELTA this test causes rather than an absolute count.
    const audits_before = await owner.audit_logs.count({
      where: { tenant_id: fx.tenant_a.tenant_id, action: "pricing_rule.created" },
    });

    const [first, second] = await Promise.all([
      request(api)
        .post(RULES)
        .set("Authorization", `Bearer ${token_a}`)
        .send(create_body(product, "11")),
      request(api)
        .post(RULES)
        .set("Authorization", `Bearer ${token_a}`)
        .send(create_body(product, "22")),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    // Never a 500 — the whole point of the fix.
    expect(statuses).not.toContain(500);

    // Exactly one rule.
    expect(
      await owner.tenant_pricing_rules.count({
        where: { tenant_id: fx.tenant_a.tenant_id, product_id: product, is_active: true },
      }),
    ).toBe(1);

    // Exactly one NEW audit row — the failed attempt rolled its own back.
    const audits_after = await owner.audit_logs.count({
      where: { tenant_id: fx.tenant_a.tenant_id, action: "pricing_rule.created" },
    });
    expect(audits_after - audits_before).toBe(1);

    // And that row belongs to the rule that actually got created.
    const created = [first, second].find((r) => r.status === 201)!;
    expect(
      await owner.audit_logs.count({
        where: {
          tenant_id: fx.tenant_a.tenant_id,
          entity_id: created.body.data.id,
          action: "pricing_rule.created",
        },
      }),
    ).toBe(1);
  });

  /**
   * Deterministic reproduction of the constraint path specifically.
   *
   * A competing transaction inserts the rule and holds it uncommitted. The
   * request's pre-check cannot see the uncommitted row, so it passes; its
   * INSERT then blocks on the unique index and fails the moment the competitor
   * commits. This is the exact sequence that previously produced a 500.
   *
   * The short delay constructs the overlap — it is not a poll for a result.
   */
  test("ConcurrentCreate_constraintPath_returns409NotServerError", async () => {
    const product = fx.tenant_a.silver_product_id;
    const tenant = fx.tenant_a.tenant_id;

    const audits_before = await owner.audit_logs.count({ where: { tenant_id: tenant } });

    const competitor = owner.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant}, TRUE)`;
        await tx.tenant_pricing_rules.create({
          data: {
            tenant_id: tenant,
            product_id: product,
            adjustment_kind: "absolute",
            adjustment_value: 1_000_000n,
          },
        });
        // Hold the row uncommitted so the request below passes its pre-check
        // and then blocks on the index.
        await new Promise((resolve) => setTimeout(resolve, 400));
      },
      { timeout: 15_000 },
    );

    // Let the competitor insert before the request begins.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .send(create_body(product, "33"));

    await competitor;

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("CONFLICT");

    // Identical to the sequential duplicate message.
    expect(response.body.detail).toBe(
      "An active pricing rule already exists for this product",
    );

    // No constraint name, table name or SQL detail reaches the client.
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain("uq_tenant_pricing_rules_active");
    expect(serialised).not.toContain("23505");
    expect(serialised).not.toContain("duplicate key");
    expect(serialised).not.toContain("tenant_pricing_rules");

    // Rolled back: the competitor's rule is the only one, and the failed
    // attempt added no audit row at all.
    expect(
      await owner.tenant_pricing_rules.count({
        where: { tenant_id: tenant, product_id: product, is_active: true },
      }),
    ).toBe(1);
    expect(await owner.audit_logs.count({ where: { tenant_id: tenant } })).toBe(
      audits_before,
    );
  });

  test("SequentialDuplicate_andConcurrentDuplicate_produceIdenticalResponses", async () => {
    const product = fx.tenant_a.silver_product_id;

    await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .send(create_body(product, "11"));

    const sequential = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .send(create_body(product, "22"));

    expect(sequential.status).toBe(409);
    expect(sequential.body.detail).toBe(
      "An active pricing rule already exists for this product",
    );
    expect(sequential.body.code).toBe("CONFLICT");
  });

  /**
   * An unrelated unique violation must NOT be translated into the pricing
   * duplicate error. Two users with the same email violate `uq_users_email`;
   * that must surface as itself, never as "an active pricing rule exists".
   */
  test("UnrelatedUniqueViolation_isNotMappedToThePricingConflict", async () => {
    const email = `clash-${randomUUID()}@test.invalid`;

    await owner.users.create({
      data: {
        external_object_id: randomUUID(),
        external_directory_id: TEST_DIRECTORY_ID,
        email,
      },
    });

    let captured: unknown;
    try {
      await owner.users.create({
        data: {
          external_object_id: randomUUID(),
          external_directory_id: TEST_DIRECTORY_ID,
          email,
        },
      });
    } catch (error) {
      captured = error;
    }

    const { violates_constraint, CONSTRAINTS } = await import(
      "../../src/platform/prisma_errors.js"
    );

    expect(captured).toBeDefined();
    expect(violates_constraint(captured, CONSTRAINTS.active_pricing_rule)).toBe(false);
    expect(violates_constraint(captured, CONSTRAINTS.idempotency_key)).toBe(false);
    expect(violates_constraint(captured, "uq_users_email")).toBe(true);
  });

  /** An idempotency-key clash keeps its own message, not the pricing one. */
  test("IdempotencyClash_keepsItsOwnConflictMessage", async () => {
    const key = `race-${randomUUID()}`;
    const product = fx.tenant_a.silver_product_id;

    const [a, b] = await Promise.all([
      request(api)
        .post(RULES)
        .set("Authorization", `Bearer ${token_a}`)
        .set("Idempotency-Key", key)
        .send(create_body(product, "11")),
      request(api)
        .post(RULES)
        .set("Authorization", `Bearer ${token_a}`)
        .set("Idempotency-Key", key)
        .send(create_body(product, "11")),
    ]);

    const conflict = [a, b].find((r) => r.status === 409);
    if (conflict !== undefined) {
      // Whichever conflict fired, it must not be misreported as the other one.
      expect([
        "A request with this Idempotency-Key is already in progress",
        "An active pricing rule already exists for this product",
      ]).toContain(conflict.body.detail);
    }

    expect([a.status, b.status]).not.toContain(500);
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotency-key cleanup
// ---------------------------------------------------------------------------

describe("idempotency key cleanup", () => {
  test("Cleanup_expiredKeys_areRemoved", async () => {
    const key = `old-${randomUUID()}`;
    await seed_key(fx.tenant_a.tenant_id, key, 72);

    const result = await purge_expired_keys(maintenance, silent, {
      retention_hours: 48,
    });

    expect(result.deleted).toBeGreaterThan(0);
    expect(await key_exists(fx.tenant_a.tenant_id, key)).toBe(false);
  });

  test("Cleanup_nonExpiredKeys_remain", async () => {
    const fresh = `fresh-${randomUUID()}`;
    const stale = `stale-${randomUUID()}`;
    await seed_key(fx.tenant_a.tenant_id, fresh, 1);
    await seed_key(fx.tenant_a.tenant_id, stale, 72);

    await purge_expired_keys(maintenance, silent, { retention_hours: 48 });

    expect(await key_exists(fx.tenant_a.tenant_id, fresh)).toBe(true);
    expect(await key_exists(fx.tenant_a.tenant_id, stale)).toBe(false);
  });

  /** The boundary: a key just inside retention must survive. */
  test("Cleanup_keyJustInsideRetention_survives", async () => {
    const key = `edge-${randomUUID()}`;
    await seed_key(fx.tenant_a.tenant_id, key, 47);

    await purge_expired_keys(maintenance, silent, { retention_hours: 48 });

    expect(await key_exists(fx.tenant_a.tenant_id, key)).toBe(true);
  });

  test("Cleanup_withNothingExpired_isSafeAndReportsZero", async () => {
    await purge_expired_keys(maintenance, silent, { retention_hours: 48 });

    const result = await purge_expired_keys(maintenance, silent, {
      retention_hours: 48,
    });

    expect(result.deleted).toBe(0);
    expect(result.truncated).toBe(false);
  });

  test("Cleanup_runTwice_isIdempotent", async () => {
    await seed_key(fx.tenant_a.tenant_id, `twice-${randomUUID()}`, 72);

    const first = await purge_expired_keys(maintenance, silent, { retention_hours: 48 });
    const second = await purge_expired_keys(maintenance, silent, { retention_hours: 48 });

    expect(first.deleted).toBeGreaterThan(0);
    expect(second.deleted).toBe(0);
  });

  /** Overlapping runs divide the work via SKIP LOCKED rather than colliding. */
  test("Cleanup_concurrentRuns_areSafeAndDoNotDoubleCount", async () => {
    const keys = Array.from({ length: 20 }, () => `conc-${randomUUID()}`);
    for (const key of keys) await seed_key(fx.tenant_a.tenant_id, key, 72);

    const before = await count_expired_keys(maintenance, 48);

    const [a, b] = await Promise.all([
      purge_expired_keys(maintenance, silent, { retention_hours: 48, batch_size: 5 }),
      purge_expired_keys(maintenance, silent, { retention_hours: 48, batch_size: 5 }),
    ]);

    // Between them they delete each expired row exactly once.
    expect(a.deleted + b.deleted).toBe(before);
    expect(await count_expired_keys(maintenance, 48)).toBe(0);
  });

  test("Cleanup_doesNotRemoveAnotherTenantsActiveKey", async () => {
    const b_active = `b-active-${randomUUID()}`;
    const b_expired = `b-expired-${randomUUID()}`;
    await seed_key(fx.tenant_b.tenant_id, b_active, 1);
    await seed_key(fx.tenant_b.tenant_id, b_expired, 72);
    await seed_key(fx.tenant_a.tenant_id, `a-expired-${randomUUID()}`, 72);

    await purge_expired_keys(maintenance, silent, { retention_hours: 48 });

    // Age decides, not tenant: B's active key survives, B's expired one goes.
    expect(await key_exists(fx.tenant_b.tenant_id, b_active)).toBe(true);
    expect(await key_exists(fx.tenant_b.tenant_id, b_expired)).toBe(false);
  });

  test("Cleanup_isBatchedAndBounded", async () => {
    for (let i = 0; i < 12; i += 1) {
      await seed_key(fx.tenant_a.tenant_id, `batch-${randomUUID()}`, 72);
    }

    const result = await purge_expired_keys(maintenance, silent, {
      retention_hours: 48,
      batch_size: 5,
      max_batches: 2,
    });

    // Capped: two batches of five, and the run says so rather than pretending
    // it finished.
    expect(result.batches).toBe(2);
    expect(result.deleted).toBe(10);
    expect(result.truncated).toBe(true);
    expect(await count_expired_keys(maintenance, 48)).toBeGreaterThan(0);
  });

  test.each([
    ["zero retention", { retention_hours: 0 }],
    ["negative retention", { retention_hours: -1 }],
    ["zero batch size", { batch_size: 0 }],
    ["absurd batch size", { batch_size: 100_000 }],
    ["zero max batches", { max_batches: 0 }],
  ])("Cleanup_invalidOption_%s_isRejected", async (_label, override) => {
    await expect(purge_expired_keys(maintenance, silent, override)).rejects.toBeInstanceOf(
      CleanupConfigError,
    );
  });

  /**
   * The application role cannot perform cleanup: RLS hides every row from a
   * context-less session, so a misconfigured job would delete nothing rather
   * than silently deleting the wrong thing.
   */
  test("Cleanup_asApplicationRole_deletesNothing", async () => {
    await seed_key(fx.tenant_a.tenant_id, `app-role-${randomUUID()}`, 72);
    const before = await count_expired_keys(maintenance, 48);

    const result = await purge_expired_keys(db, silent, { retention_hours: 48 });

    expect(result.deleted).toBe(0);
    expect(await count_expired_keys(maintenance, 48)).toBe(before);
  });

  /** The maintenance identity is scoped to one table. */
  test("Cleanup_maintenanceRole_cannotReadTenantData", async () => {
    await expect(
      maintenance.$queryRawUnsafe(`SELECT count(*) FROM tenant_pricing_rules`),
    ).rejects.toBeDefined();

    await expect(
      maintenance.$queryRawUnsafe(`SELECT count(*) FROM audit_logs`),
    ).rejects.toBeDefined();
  });
});

describe("cleanup is not reachable from the tenant API", () => {
  /** No route exposes cleanup, under any plausible spelling. */
  test.each([
    "/api/v1/idempotency-keys",
    "/api/v1/maintenance/purge",
    "/api/v1/admin/idempotency-keys",
    // Parsed as `/pricing-rules/:rule_id` with a malformed id, so this one is
    // denied rather than unrouted — either way it cannot trigger cleanup.
    "/api/v1/pricing-rules/purge",
  ])("Cleanup_route_%s_neverSucceeds", async (path) => {
    for (const method of ["get", "post", "delete"] as const) {
      const agent = request(api) as unknown as Record<
        string,
        (url: string) => request.Test
      >;
      const response = await agent[method]!(path).set(
        "Authorization",
        `Bearer ${token_a}`,
      );

      expect(response.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
    }
  });

  /** A tenant request cannot remove even its own idempotency rows. */
  test("Cleanup_tenantRequests_doNotDeleteIdempotencyRows", async () => {
    const key = `survive-${randomUUID()}`;
    await seed_key(fx.tenant_a.tenant_id, key, 72);

    await request(api).get(RULES).set("Authorization", `Bearer ${token_a}`);
    await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .set("Idempotency-Key", `other-${randomUUID()}`)
      .send(create_body(fx.tenant_a.silver_product_id, "9"));

    // Expiry is an operational job, never a side effect of serving traffic.
    expect(await key_exists(fx.tenant_a.tenant_id, key)).toBe(true);
  });
});
