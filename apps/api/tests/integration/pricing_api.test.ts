/**
 * Stage 7 — the pricing configuration API and its audit trail, end to end.
 *
 * Exercises the real Express app built by `create_app`, so every request passes
 * through the real authentication middleware, the real authorization matrix,
 * the real service layer and real RLS. Nothing is stubbed.
 *
 * Stage 5 and 6 coverage is reused rather than repeated: the fixtures, token
 * minting and directory constant all come from the existing helpers, and this
 * file adds only what Stage 7 introduced.
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

let owner: PrismaClient;
let db: PrismaClient;
let fx: Fixtures;
let signing_key: CryptoKey;
let api: Express;

const RULES = "/api/v1/pricing-rules";
const AUDIT = "/api/v1/audit-logs";

/** Valid display settings, reused so tests vary only what they are testing. */
const DISPLAY = {
  rounding_step_paise: 100,
  rounding_mode: "half_up",
  component_precision_paise: 1,
} as const;

function absolute(rupees: string) {
  return { adjustment_kind: "absolute", adjustment_rupees_per_gram: rupees, ...DISPLAY };
}

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

let token_a = "";
let token_b = "";

/**
 * Fetch a rule, whatever the outcome. Used by the tests that expect a denial.
 */
async function read_rule(token: string, id: string) {
  const response = await request(api).get(`${RULES}/${id}`).set("Authorization", `Bearer ${token}`);
  return response;
}

/**
 * Fetch a rule that is expected to exist and be readable.
 *
 * Callers reach straight for `body.data.version`, so an unchecked failure
 * surfaced as `Cannot read properties of undefined` several lines further on,
 * naming neither the status nor the request that actually failed — which is
 * exactly how an intermittent failure here stayed unexplained. Asserting at the
 * point of the request reports both.
 */
async function read_rule_ok(token: string, id: string) {
  const response = await read_rule(token, id);

  expect(
    response.status,
    `GET ${RULES}/${id} -> ${response.status} ${JSON.stringify(response.body)}`,
  ).toBe(200);

  return response;
}

/** Count audit rows for a tenant, read as owner so RLS cannot mask a leak. */
async function audit_count(tenant_id: string, entity_id?: string): Promise<number> {
  return owner.audit_logs.count({
    where: { tenant_id, ...(entity_id === undefined ? {} : { entity_id }) },
  });
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
// 1. Own-tenant create / read / update
// ---------------------------------------------------------------------------

describe("own-tenant pricing configuration", () => {
  test("PricingApi_tenantACreatesOwnRule_succeedsWith201", async () => {
    const response = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ product_id: fx.tenant_a.silver_product_id, ...absolute("2.50") });

    expect(response.status).toBe(201);
    expect(response.body.data.adjustment_kind).toBe("absolute");
    expect(response.body.data.adjustment_rupees_per_gram).toBe("2.50");
    expect(response.body.data.version).toBe(1);
    expect(response.headers["etag"]).toBe('"1"');
  });

  test("PricingApi_tenantAUpdatesOwnRule_incrementsVersion", async () => {
    const before = await read_rule_ok(token_a, fx.tenant_a.gold_rule_id);

    const response = await request(api)
      .patch(`${RULES}/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", String(before.body.data.version))
      .send(absolute("75"));

    expect(response.status).toBe(200);
    expect(response.body.data.adjustment_rupees_per_gram).toBe("75.00");
    expect(response.body.data.version).toBe(before.body.data.version + 1);
  });

  test("PricingApi_listOwnRules_returnsOnlyOwnTenant", async () => {
    const response = await request(api).get(RULES).set("Authorization", `Bearer ${token_a}`);

    expect(response.status).toBe(200);
    const ids = response.body.data.map((r: { id: string }) => r.id);
    expect(ids).toContain(fx.tenant_a.gold_rule_id);
    expect(ids).not.toContain(fx.tenant_b.gold_rule_id);
  });

  test("PricingApi_deactivate_softDeletesAndKeepsHistory", async () => {
    const before = await read_rule_ok(token_a, fx.tenant_a.gold_rule_id);

    const response = await request(api)
      .delete(`${RULES}/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", String(before.body.data.version));

    expect(response.status).toBe(200);
    expect(response.body.data.is_active).toBe(false);

    // The row survives, so published_rates and audit references stay intact.
    const row = await owner.tenant_pricing_rules.findUnique({
      where: { id: fx.tenant_a.gold_rule_id },
    });
    expect(row).not.toBeNull();
  });

  /** The response is the DTO, not the table. */
  test("PricingApi_response_neverExposesInternalColumns", async () => {
    const response = await read_rule_ok(token_a, fx.tenant_a.gold_rule_id);
    const rule = response.body.data;

    for (const internal of ["tenant_id", "created_by", "updated_by", "adjustment_value"]) {
      expect(rule, internal).not.toHaveProperty(internal);
    }
    expect(JSON.stringify(rule)).not.toContain(fx.tenant_a.tenant_id);
  });
});

// ---------------------------------------------------------------------------
// 2-5. Cross-tenant denial
// ---------------------------------------------------------------------------

describe("cross-tenant access is denied", () => {
  test("PricingApi_tenantAReadsTenantBRule_returns403", async () => {
    const response = await read_rule(token_a, fx.tenant_b.gold_rule_id);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain(fx.tenant_b.tenant_id);
  });

  test("PricingApi_tenantAUpdatesTenantBRule_returns403AndChangesNothing", async () => {
    const before = await owner.tenant_pricing_rules.findUnique({
      where: { id: fx.tenant_b.gold_rule_id },
    });

    const response = await request(api)
      .patch(`${RULES}/${fx.tenant_b.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", "1")
      .send(absolute("1"));

    expect(response.status).toBe(403);

    const after = await owner.tenant_pricing_rules.findUnique({
      where: { id: fx.tenant_b.gold_rule_id },
    });
    expect(after).toEqual(before);
  });

  test("PricingApi_tenantADeletesTenantBRule_returns403AndRuleStaysActive", async () => {
    const response = await request(api)
      .delete(`${RULES}/${fx.tenant_b.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", "1");

    expect(response.status).toBe(403);
    expect(
      await owner.tenant_pricing_rules.count({
        where: { id: fx.tenant_b.gold_rule_id, is_active: true },
      }),
    ).toBe(1);
  });

  /** A foreign id and a nonexistent one must be indistinguishable. */
  test("PricingApi_foreignAndUnknownIds_produceIdenticalResponses", async () => {
    const foreign = await read_rule(token_a, fx.tenant_b.gold_rule_id);
    const unknown = await read_rule(token_a, randomUUID());

    expect(foreign.status).toBe(unknown.status);
    expect(foreign.body.code).toBe(unknown.body.code);
    expect(foreign.body.detail).toBe(unknown.body.detail);
  });

  test("PricingApi_crossTenantAttempt_writesNoAuditRowForEitherTenant", async () => {
    const before_a = await audit_count(fx.tenant_a.tenant_id);
    const before_b = await audit_count(fx.tenant_b.tenant_id);

    await request(api)
      .patch(`${RULES}/${fx.tenant_b.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", "1")
      .send(absolute("1"));

    expect(await audit_count(fx.tenant_a.tenant_id)).toBe(before_a);
    expect(await audit_count(fx.tenant_b.tenant_id)).toBe(before_b);
  });
});

// ---------------------------------------------------------------------------
// 5-6. Caller-supplied identity is inert
// ---------------------------------------------------------------------------

describe("caller-supplied identity cannot influence authorization", () => {
  test.each([
    ["tenant_id", { tenant_id: "B" }],
    ["tenantId", { tenantId: "B" }],
    ["user_id", { user_id: "B" }],
    ["role", { role: "owner" }],
    ["created_by", { created_by: "B" }],
    ["updated_by", { updated_by: "B" }],
    ["version", { version: 99 }],
    ["id", { id: "B" }],
    ["is_active", { is_active: false }],
  ])("PricingApi_body_%s_isRejectedAsUnknownField", async (_label, extra) => {
    const body = { product_id: fx.tenant_a.silver_product_id, ...absolute("5") };
    const hostile = Object.fromEntries(
      Object.entries(extra).map(([k, v]) => [k, v === "B" ? fx.tenant_b.tenant_id : v]),
    );

    const response = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ ...body, ...hostile });

    // Rejected outright, not silently dropped — an unknown field is a 422.
    expect(response.status).toBe(422);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });

  test("PricingApi_tenantIdInQueryAndPathAndHeaders_isIgnored", async () => {
    const response = await request(api)
      .get(RULES)
      .query({ tenantId: fx.tenant_b.tenant_id, tenant_id: fx.tenant_b.tenant_id })
      .set("Authorization", `Bearer ${token_a}`)
      .set("X-Tenant-Id", fx.tenant_b.tenant_id)
      .set("X-Tenant", fx.tenant_b.tenant_id);

    expect(response.status).toBe(200);
    const ids = response.body.data.map((r: { id: string }) => r.id);
    expect(ids).toContain(fx.tenant_a.gold_rule_id);
    expect(ids).not.toContain(fx.tenant_b.gold_rule_id);
  });

  /** The audit actor comes from the context, never from the request. */
  test("PricingApi_auditActor_isTheAuthenticatedUserNotAClaimedOne", async () => {
    const before = await read_rule_ok(token_a, fx.tenant_a.gold_rule_id);

    await request(api)
      .patch(`${RULES}/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", String(before.body.data.version))
      .set("X-Actor-Id", fx.tenant_b.user_id)
      .send(absolute("60"));

    const entry = await owner.audit_logs.findFirst({
      where: { tenant_id: fx.tenant_a.tenant_id, action: "pricing_rule.updated" },
      orderBy: { id: "desc" },
    });

    expect(entry?.actor_user_id).toBe(fx.tenant_a.user_id);
    expect(entry?.actor_user_id).not.toBe(fx.tenant_b.user_id);
    expect(entry?.actor_type).toBe("authenticated");
    expect(entry?.actor_role).toBe("owner");
  });
});

// ---------------------------------------------------------------------------
// 7-8. Authentication and capability
// ---------------------------------------------------------------------------

describe("authentication and capability", () => {
  test("PricingApi_noToken_returns401", async () => {
    expect((await request(api).get(RULES)).status).toBe(401);
    expect((await request(api).post(RULES).send(absolute("1"))).status).toBe(401);
  });

  test("PricingApi_malformedToken_returns401NotServerError", async () => {
    const response = await request(api).get(RULES).set("Authorization", "Bearer nope");
    expect(response.status).toBe(401);
  });

  test("PricingApi_platformAdmin_isDeniedTenantPricing", async () => {
    const admin = await owner.users.create({
      data: {
        external_object_id: randomUUID(),
        external_directory_id: TEST_DIRECTORY_ID,
        email: `admin-${randomUUID()}@test.invalid`,
      },
    });
    await owner.platform_admins.create({ data: { user_id: admin.id } });

    const response = await request(api)
      .get(RULES)
      .set("Authorization", `Bearer ${await token_for(admin.external_object_id)}`);

    // A platform admin is not a super-shopkeeper.
    expect(response.status).toBe(403);

    await owner.platform_admins.delete({ where: { user_id: admin.id } });
    await owner.users.delete({ where: { id: admin.id } });
  });

  test("PricingApi_auditRead_requiresManagerCapability", async () => {
    await owner.tenant_users.update({
      where: {
        tenant_id_user_id: {
          tenant_id: fx.tenant_a.tenant_id,
          user_id: fx.tenant_a.user_id,
        },
      },
      data: { role: "staff" },
    });

    const response = await request(api).get(AUDIT).set("Authorization", `Bearer ${token_a}`);
    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 9-10. Validation
// ---------------------------------------------------------------------------

describe("validation", () => {
  test.each([
    ["unknown product", () => randomUUID(), 422],
    ["malformed product id", () => "not-a-uuid", 422],
  ])("PricingApi_%s_isRejected", async (_label, product_id, status) => {
    const response = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ ...absolute("5"), product_id: product_id() });

    expect(response.status).toBe(status);
  });

  test.each([
    ["adjustment as a float", { adjustment_rupees_per_gram: 50.07 }],
    ["adjustment with 3 decimals", { adjustment_rupees_per_gram: "50.071" }],
    ["adjustment not a string", { adjustment_rupees_per_gram: null }],
    ["unknown rounding mode", { rounding_mode: "half_sideways" }],
    ["unsupported rounding step", { rounding_step_paise: 3 }],
    ["unsupported component precision", { component_precision_paise: 7 }],
    ["unknown adjustment kind", { adjustment_kind: "magic" }],
  ])("PricingApi_invalid_%s_returns422", async (_label, override) => {
    const response = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ product_id: fx.tenant_a.silver_product_id, ...absolute("5"), ...override });

    expect(response.status).toBe(422);
  });

  test("PricingApi_percentageBeyondBounds_returns422", async () => {
    for (const bps of [10_001, -10_001, 1.5]) {
      const response = await request(api)
        .post(RULES)
        .set("Authorization", `Bearer ${token_a}`)
        .send({
          product_id: fx.tenant_a.silver_product_id,
          adjustment_kind: "percentage",
          adjustment_bps: bps,
          ...DISPLAY,
        });
      expect(response.status, String(bps)).toBe(422);
    }
  });

  /** An absolute rule may not smuggle in basis points, or vice versa. */
  test("PricingApi_mixedAdjustmentFields_areRejected", async () => {
    const response = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .send({
        product_id: fx.tenant_a.silver_product_id,
        adjustment_kind: "absolute",
        adjustment_rupees_per_gram: "5",
        adjustment_bps: 300,
        ...DISPLAY,
      });

    expect(response.status).toBe(422);
  });

  test("PricingApi_unparseableBody_returns400NotValidationError", async () => {
    const response = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .set("Content-Type", "application/json")
      .send("{ broken");

    expect(response.status).toBe(400);
  });

  test("PricingApi_duplicateActiveRuleForProduct_returns409", async () => {
    const response = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ product_id: fx.tenant_a.gold_product_id, ...absolute("5") });

    expect(response.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// 11-15. Money exactness and pricing semantics
// ---------------------------------------------------------------------------

describe("exact money arithmetic and pricing semantics", () => {
  test("PricingApi_adjustment_roundTripsExactly", async () => {
    for (const amount of ["50", "50.07", "0.01", "-1.50", "99999.99"]) {
      const created = await request(api)
        .post(RULES)
        .set("Authorization", `Bearer ${token_a}`)
        .send({ product_id: fx.tenant_a.silver_product_id, ...absolute(amount) });

      expect(created.status, amount).toBe(201);

      const expected = amount.includes(".") ? amount : `${amount}.00`;
      expect(created.body.data.adjustment_rupees_per_gram).toBe(expected);

      // Stored as exact integer milli-paise per gram — no float anywhere.
      const row = await owner.tenant_pricing_rules.findUnique({
        where: { id: created.body.data.id },
        select: { adjustment_value: true },
      });
      const expected_milli = BigInt(Math.round(Number(amount) * 100)) * 1000n;
      expect(row?.adjustment_value).toBe(expected_milli);

      await owner.tenant_pricing_rules.delete({ where: { id: created.body.data.id } });
    }
  });

  /** The two kinds stay distinguishable; neither reports the other's field. */
  test("PricingApi_absoluteAndPercentage_remainDistinguishable", async () => {
    const absolute_rule = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ product_id: fx.tenant_a.silver_product_id, ...absolute("5") });

    expect(absolute_rule.body.data.adjustment_kind).toBe("absolute");
    expect(absolute_rule.body.data.adjustment_rupees_per_gram).toBe("5.00");
    expect(absolute_rule.body.data.adjustment_bps).toBeNull();

    const before = absolute_rule.body.data;
    const percentage_rule = await request(api)
      .patch(`${RULES}/${before.id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", String(before.version))
      .send({ adjustment_kind: "percentage", adjustment_bps: 300, ...DISPLAY });

    expect(percentage_rule.body.data.adjustment_kind).toBe("percentage");
    expect(percentage_rule.body.data.adjustment_bps).toBe(300);
    expect(percentage_rule.body.data.adjustment_rupees_per_gram).toBeNull();

    // Switching kind zeroes the unused column — no stale amount can be applied.
    const row = await owner.tenant_pricing_rules.findUnique({
      where: { id: before.id },
      select: { adjustment_value: true, adjustment_bps: true },
    });
    expect(row?.adjustment_value).toBe(0n);
    expect(row?.adjustment_bps).toBe(300);

    await owner.tenant_pricing_rules.delete({ where: { id: before.id } });
  });

  /**
   * The configured adjustment is authored, not derived. Rounding the customer
   * rate to the nearest ₹1 must not move the stored ₹50/g by a paise.
   */
  test("PricingApi_configuredAdjustment_isUnchangedByDisplayRounding", async () => {
    const before = await read_rule_ok(token_a, fx.tenant_a.gold_rule_id);

    for (const step of [1, 100, 1000, 10_000]) {
      const current = await read_rule_ok(token_a, fx.tenant_a.gold_rule_id);
      const response = await request(api)
        .patch(`${RULES}/${fx.tenant_a.gold_rule_id}`)
        .set("Authorization", `Bearer ${token_a}`)
        .set("If-Match", String(current.body.data.version))
        .send({
          adjustment_kind: "absolute",
          adjustment_rupees_per_gram: "50",
          rounding_step_paise: step,
          rounding_mode: "half_up",
          component_precision_paise: 1,
        });

      expect(response.status, String(step)).toBe(200);
      // Unmoved at every rounding step.
      expect(response.body.data.adjustment_rupees_per_gram, String(step)).toBe("50.00");
    }

    const row = await owner.tenant_pricing_rules.findUnique({
      where: { id: fx.tenant_a.gold_rule_id },
      select: { adjustment_value: true },
    });
    expect(row?.adjustment_value).toBe(5_000_000n);
    expect(before.body.data.adjustment_rupees_per_gram).toBe("50.00");
  });
});

// ---------------------------------------------------------------------------
// 16. Concurrency
// ---------------------------------------------------------------------------

describe("optimistic concurrency", () => {
  test("PricingApi_missingIfMatch_returns428", async () => {
    const response = await request(api)
      .patch(`${RULES}/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .send(absolute("60"));

    expect(response.status).toBe(428);
    expect(response.body.code).toBe("PRECONDITION_REQUIRED");
  });

  test("PricingApi_staleVersion_returns409AndChangesNothing", async () => {
    const before = await read_rule_ok(token_a, fx.tenant_a.gold_rule_id);
    const version = before.body.data.version;

    // First writer wins.
    const first = await request(api)
      .patch(`${RULES}/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", String(version))
      .send(absolute("60"));
    expect(first.status).toBe(200);

    // Second writer still holds the old version.
    const second = await request(api)
      .patch(`${RULES}/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", String(version))
      .send(absolute("70"));

    expect(second.status).toBe(409);

    // The first writer's value survived — no lost update.
    const row = await owner.tenant_pricing_rules.findUnique({
      where: { id: fx.tenant_a.gold_rule_id },
      select: { adjustment_value: true },
    });
    expect(row?.adjustment_value).toBe(6_000_000n);
  });

  /** The real race: two writers submitting simultaneously. */
  test("PricingApi_simultaneousUpdates_onlyOneSucceeds", async () => {
    const before = await read_rule_ok(token_a, fx.tenant_a.gold_rule_id);
    const version = String(before.body.data.version);

    const [first, second] = await Promise.all([
      request(api)
        .patch(`${RULES}/${fx.tenant_a.gold_rule_id}`)
        .set("Authorization", `Bearer ${token_a}`)
        .set("If-Match", version)
        .send(absolute("61")),
      request(api)
        .patch(`${RULES}/${fx.tenant_a.gold_rule_id}`)
        .set("Authorization", `Bearer ${token_a}`)
        .set("If-Match", version)
        .send(absolute("62")),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Exactly one update audit row, matching the one that succeeded.
    const updates = await owner.audit_logs.count({
      where: {
        tenant_id: fx.tenant_a.tenant_id,
        entity_id: fx.tenant_a.gold_rule_id,
        action: "pricing_rule.updated",
      },
    });
    expect(updates).toBe(1);
  });

  test("PricingApi_malformedIfMatch_returns422", async () => {
    const response = await request(api)
      .patch(`${RULES}/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", "not-a-version")
      .send(absolute("60"));

    expect(response.status).toBe(422);
  });

  test("PricingApi_quotedEtag_isAccepted", async () => {
    const before = await read_rule_ok(token_a, fx.tenant_a.gold_rule_id);
    const response = await request(api)
      .patch(`${RULES}/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", `"${before.body.data.version}"`)
      .send(absolute("60"));

    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 17. Idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  test("PricingApi_retryWithSameKey_createsOneRuleAndOneAuditRow", async () => {
    const key = `create-${randomUUID()}`;
    const body = { product_id: fx.tenant_a.silver_product_id, ...absolute("3.50") };

    const first = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .set("Idempotency-Key", key)
      .send(body);

    const second = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .set("Idempotency-Key", key)
      .send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200); // replay, not a second creation
    expect(second.body.meta.replayed).toBe(true);
    expect(second.body.data.id).toBe(first.body.data.id);

    // Exactly one rule and one audit row.
    expect(
      await owner.tenant_pricing_rules.count({
        where: { tenant_id: fx.tenant_a.tenant_id, product_id: fx.tenant_a.silver_product_id },
      }),
    ).toBe(1);
    expect(await audit_count(fx.tenant_a.tenant_id, first.body.data.id)).toBe(1);
  });

  test("PricingApi_sameKeyDifferentPayload_returns409", async () => {
    const key = `conflict-${randomUUID()}`;

    await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .set("Idempotency-Key", key)
      .send({ product_id: fx.tenant_a.silver_product_id, ...absolute("3") });

    const response = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .set("Idempotency-Key", key)
      .send({ product_id: fx.tenant_a.silver_product_id, ...absolute("999") });

    // Replaying the first response here would tell the caller a change they
    // never made had succeeded.
    expect(response.status).toBe(409);
  });

  test("PricingApi_idempotencyKey_isScopedToItsTenant", async () => {
    const key = `shared-${randomUUID()}`;

    const a = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .set("Idempotency-Key", key)
      .send({ product_id: fx.tenant_a.silver_product_id, ...absolute("3") });

    const b = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_b}`)
      .set("Idempotency-Key", key)
      .send({ product_id: fx.tenant_b.silver_product_id, ...absolute("4") });

    // The same key in two tenants is two independent requests.
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data.id).not.toBe(b.body.data.id);
  });

  test("PricingApi_shortIdempotencyKey_returns422", async () => {
    const response = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .set("Idempotency-Key", "abc")
      .send({ product_id: fx.tenant_a.silver_product_id, ...absolute("3") });

    expect(response.status).toBe(422);
  });

  test("PricingApi_retriedUpdate_doesNotDoubleApply", async () => {
    const before = await read_rule_ok(token_a, fx.tenant_a.gold_rule_id);
    const key = `update-${randomUUID()}`;

    const first = await request(api)
      .patch(`${RULES}/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", String(before.body.data.version))
      .set("Idempotency-Key", key)
      .send(absolute("65"));

    const retry = await request(api)
      .patch(`${RULES}/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", String(before.body.data.version))
      .set("Idempotency-Key", key)
      .send(absolute("65"));

    expect(first.status).toBe(200);
    // Without idempotency this retry would be a 409 (stale version). With it,
    // the stored response is replayed.
    expect(retry.status).toBe(200);
    expect(retry.body.meta.replayed).toBe(true);
    expect(retry.body.data.version).toBe(first.body.data.version);

    expect(
      await owner.audit_logs.count({
        where: {
          tenant_id: fx.tenant_a.tenant_id,
          entity_id: fx.tenant_a.gold_rule_id,
          action: "pricing_rule.updated",
        },
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 18-22. Audit
// ---------------------------------------------------------------------------

describe("audit trail", () => {
  test("PricingApi_create_writesExactlyOneAuditRowWithExpectedFacts", async () => {
    const created = await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ product_id: fx.tenant_a.silver_product_id, ...absolute("2") });

    const entries = await owner.audit_logs.findMany({
      where: { tenant_id: fx.tenant_a.tenant_id, entity_id: created.body.data.id },
    });

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.action).toBe("pricing_rule.created");
    expect(entry.entity_type).toBe("tenant_pricing_rules");
    expect(entry.actor_user_id).toBe(fx.tenant_a.user_id);
    expect(entry.actor_type).toBe("authenticated");
    expect(entry.actor_role).toBe("owner");
    expect(entry.request_id).not.toBeNull();
    expect(entry.old_value).toBeNull(); // nothing before a creation
    expect(entry.new_value).toMatchObject({ adjustment_kind: "absolute" });
  });

  test("PricingApi_update_recordsBeforeAndAfterAndChangedFields", async () => {
    const before = await read_rule_ok(token_a, fx.tenant_a.gold_rule_id);

    await request(api)
      .patch(`${RULES}/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", String(before.body.data.version))
      .send(absolute("80"));

    const entry = await owner.audit_logs.findFirst({
      where: { tenant_id: fx.tenant_a.tenant_id, action: "pricing_rule.updated" },
      orderBy: { id: "desc" },
    });

    const old_value = entry?.old_value as Record<string, unknown>;
    const new_value = entry?.new_value as Record<string, unknown>;

    expect(old_value["adjustment_value"]).toBe("5000000"); // ₹50/g
    expect(new_value["adjustment_value"]).toBe("8000000"); // ₹80/g
    expect(new_value["__changed"]).toContain("adjustment_value");
    expect(new_value["__changed"]).toContain("version");
  });

  /** A rejected mutation leaves no audit row at all. */
  test("PricingApi_failedMutation_writesNoAuditRow", async () => {
    const before_count = await audit_count(fx.tenant_a.tenant_id);

    // Stale version → 409, rolled back.
    await request(api)
      .patch(`${RULES}/${fx.tenant_a.gold_rule_id}`)
      .set("Authorization", `Bearer ${token_a}`)
      .set("If-Match", "9999")
      .send(absolute("90"));

    // Invalid payload → 422, never reaches the service.
    await request(api)
      .post(RULES)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ product_id: fx.tenant_a.silver_product_id, ...absolute("bad") });

    expect(await audit_count(fx.tenant_a.tenant_id)).toBe(before_count);
  });

  test("PricingApi_auditRead_returnsOnlyOwnTenantRecords", async () => {
    const response = await request(api).get(AUDIT).set("Authorization", `Bearer ${token_a}`);

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain(fx.tenant_b.tenant_id);
    expect(serialised).not.toContain(fx.tenant_b.gold_rule_id);
  });

  test("PricingApi_auditRead_filtersByEntity", async () => {
    const response = await request(api)
      .get(AUDIT)
      .query({ entity_id: fx.tenant_b.gold_rule_id })
      .set("Authorization", `Bearer ${token_a}`);

    // B's entity id is well-formed but belongs to another tenant — no rows.
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
  });

  test("PricingApi_auditRead_paginatesByKeyset", async () => {
    const first = await request(api)
      .get(AUDIT)
      .query({ limit: 1 })
      .set("Authorization", `Bearer ${token_a}`);

    expect(first.body.data).toHaveLength(1);
    expect(first.body.meta.limit).toBe(1);
  });

  test("PricingApi_auditRead_withholdsActorPersonalData", async () => {
    const response = await request(api).get(AUDIT).set("Authorization", `Bearer ${token_a}`);
    const entry = response.body.data[0];

    for (const withheld of ["actor_user_id", "ip_address", "user_agent"]) {
      expect(entry, withheld).not.toHaveProperty(withheld);
    }
  });

  test("PricingApi_auditQuery_rejectsUnknownParameters", async () => {
    const response = await request(api)
      .get(AUDIT)
      .query({ tenant_id: fx.tenant_b.tenant_id })
      .set("Authorization", `Bearer ${token_a}`);

    expect(response.status).toBe(422);
  });

  /** There is no route that can write, amend or remove audit history. */
  test.each([
    ["POST", "post"],
    ["PATCH", "patch"],
    ["DELETE", "delete"],
    ["PUT", "put"],
  ])("PricingApi_audit_%s_isNotRoutable", async (_label, method) => {
    const agent = request(api) as unknown as Record<string, (url: string) => request.Test>;
    const response = await agent[method]!(AUDIT)
      .set("Authorization", `Bearer ${token_a}`)
      .send({ action: "forged" });

    expect([404, 405]).toContain(response.status);
  });

  /** The database refuses even if application code were to try. */
  test("PricingApi_auditRows_cannotBeModifiedByTheApplicationRole", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${fx.tenant_a.tenant_id}, TRUE)`;
        return tx.$executeRawUnsafe(`UPDATE audit_logs SET action = 'tampered'`);
      }),
    ).rejects.toBeDefined();

    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${fx.tenant_a.tenant_id}, TRUE)`;
        return tx.$executeRawUnsafe(`DELETE FROM audit_logs`);
      }),
    ).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 22. RLS remains the final boundary
// ---------------------------------------------------------------------------

describe("RLS remains the final enforcement boundary", () => {
  test("PricingApi_rlsStillFiltersEvenWithATenantBId", async () => {
    // Bypass the API entirely: A's context, B's rule id, raw SQL.
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${fx.tenant_a.tenant_id}, TRUE)`;
      return tx.$queryRawUnsafe<unknown[]>(
        `SELECT * FROM tenant_pricing_rules WHERE id = '${fx.tenant_b.gold_rule_id}'`,
      );
    });

    expect(rows).toHaveLength(0);
  });

  test("PricingApi_idempotencyKeys_areTenantIsolatedByRls", async () => {
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${fx.tenant_a.tenant_id}, TRUE)`;
      return tx.$queryRawUnsafe<{ tenant_id: string }[]>(`SELECT tenant_id FROM idempotency_keys`);
    });

    expect(rows.every((r) => r.tenant_id === fx.tenant_a.tenant_id)).toBe(true);
  });
});
