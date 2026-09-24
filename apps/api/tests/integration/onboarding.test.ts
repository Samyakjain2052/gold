/**
 * Onboarding: a verified identity becomes a shop.
 *
 * This is the one route that runs without a tenant context, so the questions
 * that matter are about what it can reach. A bug here does not leak one field —
 * it creates a tenant that somebody else owns, or writes into an existing
 * shop's rows while pretending to create a new one.
 *
 * Real PostgreSQL with RLS enforced throughout; the app role holds no
 * BYPASSRLS, so anything these tests write had to satisfy a policy.
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
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PrismaClient } from "@prisma/client";
import { ManualClock } from "../../src/platform/clock.js";
import { load_config } from "../../src/platform/config.js";
import { create_app } from "../../src/http/app.js";
import { JwtVerifier, type JwtVerifierOptions } from "../../src/modules/auth/index.js";
import {
  is_valid_slug,
  slugify,
  RESERVED_SLUGS,
} from "../../src/modules/onboarding/onboarding_service.js";
import { app_client, owner_client, seed_fixtures, TEST_DIRECTORY_ID, type Fixtures } from "./fixtures.js";

const ISSUER = "https://bullionshops.ciamlogin.com/0d1e2c70-0000-4000-8000-000000000001/v2.0";
const AUDIENCE = "api://bullion-rates";
const NOW = new Date("2026-09-25T09:00:00.000Z");
const ONBOARD = "/api/v1/onboarding";

let owner: PrismaClient;
let db: PrismaClient;
let api: Express;
let signing_key: CryptoKey;
let fx: Fixtures;

/** A token for an identity that has never been seen before. */
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

async function onboard(token: string, body: object) {
  return request(api).post(ONBOARD).set("Authorization", `Bearer ${token}`).send(body);
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
  });
});

beforeEach(async () => {
  fx = await seed_fixtures(owner);
});

afterAll(async () => {
  await Promise.allSettled([owner.$disconnect(), db.$disconnect()]);
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe("creating a shop", () => {
  test("Onboarding_newIdentity_createsAWorkingShop", async () => {
    const response = await onboard(await token_for(randomUUID()), {
      shop_name: "Radhika Jewellers",
    });

    expect(response.status).toBe(201);
    expect(response.body.data.slug).toBe("radhika-jewellers");
    expect(response.body.data.products).toBeGreaterThan(0);
  });

  /** Everything a shop needs, or nothing: a half-built shop strands the user. */
  test("Onboarding_createsEveryRowAShopNeeds", async () => {
    const oid = randomUUID();
    await onboard(await token_for(oid), { shop_name: "Verma Jewellers" });

    const link = await owner.customer_links.findFirst({
      where: { slug: "verma-jewellers" },
      select: { tenant_id: true, is_active: true },
    });
    expect(link?.is_active).toBe(true);

    const tenant_id = link!.tenant_id;
    const [tenant, membership, branding, products, rules] = await Promise.all([
      owner.tenants.findUnique({ where: { id: tenant_id }, select: { status: true, legal_name: true } }),
      owner.tenant_users.findFirst({ where: { tenant_id }, select: { role: true, user_id: true } }),
      owner.tenant_branding.findFirst({ where: { tenant_id }, select: { display_name: true } }),
      owner.tenant_products.count({ where: { tenant_id, is_enabled: true } }),
      owner.tenant_pricing_rules.count({ where: { tenant_id, is_active: true } }),
    ]);

    expect(tenant?.status).toBe("active");
    expect(tenant?.legal_name).toBe("Verma Jewellers");
    expect(membership?.role).toBe("owner");
    expect(branding?.display_name).toBe("Verma Jewellers");
    expect(products).toBeGreaterThan(0);
    expect(rules).toBe(products);

    // The identity is keyed on oid+tid, never the pairwise sub.
    const user = await owner.users.findUnique({
      where: { id: membership!.user_id },
      select: { external_object_id: true, external_directory_id: true },
    });
    expect(user?.external_object_id).toBe(oid);
    expect(user?.external_directory_id).toBe(TEST_DIRECTORY_ID);
  });

  /**
   * A new shop publishes no margin it was not given. Zero is the honest
   * default; inventing one would publish a price the shopkeeper never chose.
   */
  test("Onboarding_defaultRules_carryNoInventedMargin", async () => {
    await onboard(await token_for(randomUUID()), { shop_name: "Neutral Jewellers" });

    const link = await owner.customer_links.findFirst({
      where: { slug: "neutral-jewellers" },
      select: { tenant_id: true },
    });

    const rules = await owner.tenant_pricing_rules.findMany({
      where: { tenant_id: link!.tenant_id },
      select: { adjustment_value: true, adjustment_bps: true, adjustment_kind: true },
    });

    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.adjustment_value).toBe(0n);
      expect(rule.adjustment_bps).toBe(0);
      expect(rule.adjustment_kind).toBe("absolute");
    }
  });

  test("Onboarding_thenMe_returnsTheNewShop", async () => {
    const token = await token_for(randomUUID());
    await onboard(token, { shop_name: "Kapoor Jewellers" });

    const me = await request(api).get("/api/v1/me").set("Authorization", `Bearer ${token}`);

    expect(me.status).toBe(200);
    expect(me.body.data.tenant.display_name).toBe("Kapoor Jewellers");
    expect(me.body.data.tenant.public_slug).toBe("kapoor-jewellers");
    expect(me.body.data.user.role).toBe("owner");
  });

  test("Onboarding_newShop_isImmediatelyVisibleToCustomers", async () => {
    await onboard(await token_for(randomUUID()), { shop_name: "Mehta Jewellers" });

    const shop = await request(api).get("/api/v1/public/shops/mehta-jewellers");
    expect(shop.status).toBe(200);
    expect(shop.body.data.display_name).toBe("Mehta Jewellers");
  });
});

// ---------------------------------------------------------------------------
// Isolation — the property a context-less route most threatens
// ---------------------------------------------------------------------------

describe("isolation", () => {
  /** Onboarding must create a tenant, never join an existing one. */
  test("Onboarding_neverTouchesAnExistingTenant", async () => {
    const before = await owner.tenant_users.count({ where: { tenant_id: fx.tenant_a.tenant_id } });
    const rules_before = await owner.tenant_pricing_rules.count({
      where: { tenant_id: fx.tenant_a.tenant_id },
    });

    await onboard(await token_for(randomUUID()), { shop_name: "Interloper Jewellers" });

    expect(await owner.tenant_users.count({ where: { tenant_id: fx.tenant_a.tenant_id } })).toBe(before);
    expect(
      await owner.tenant_pricing_rules.count({ where: { tenant_id: fx.tenant_a.tenant_id } }),
    ).toBe(rules_before);
  });

  /** A tenant id in the body is not a tenant selector; `.strict()` refuses it. */
  test("Onboarding_tenantIdInBody_isRejected", async () => {
    const response = await onboard(await token_for(randomUUID()), {
      shop_name: "Sneaky Jewellers",
      tenant_id: fx.tenant_a.tenant_id,
    });

    expect(response.status).toBe(422);
  });

  test("Onboarding_roleInBody_isRejected", async () => {
    const response = await onboard(await token_for(randomUUID()), {
      shop_name: "Sneaky Jewellers",
      role: "owner",
    });

    expect(response.status).toBe(422);
  });

  test("Onboarding_twoShops_areFullyIndependent", async () => {
    await onboard(await token_for(randomUUID()), { shop_name: "First Jewellers" });
    await onboard(await token_for(randomUUID()), { shop_name: "Second Jewellers" });

    const [a, b] = await Promise.all([
      owner.customer_links.findFirst({ where: { slug: "first-jewellers" }, select: { tenant_id: true } }),
      owner.customer_links.findFirst({ where: { slug: "second-jewellers" }, select: { tenant_id: true } }),
    ]);

    expect(a?.tenant_id).not.toBe(b?.tenant_id);

    const a_page = await request(api).get("/api/v1/public/shops/first-jewellers");
    expect(JSON.stringify(a_page.body)).not.toContain(b!.tenant_id);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("refusals", () => {
  test("Onboarding_withoutToken_is401", async () => {
    const response = await request(api).post(ONBOARD).send({ shop_name: "No Token" });
    expect(response.status).toBe(401);
  });

  test("Onboarding_malformedToken_is401", async () => {
    const response = await request(api)
      .post(ONBOARD)
      .set("Authorization", "Bearer not-a-token")
      .send({ shop_name: "Bad Token" });
    expect(response.status).toBe(401);
  });

  /**
   * A repeat is a conflict, not a validation error: nothing about the request
   * is wrong, it conflicts with state that already exists.
   */
  test("Onboarding_twice_is409", async () => {
    const token = await token_for(randomUUID());

    expect((await onboard(token, { shop_name: "Once Jewellers" })).status).toBe(201);

    const second = await onboard(token, { shop_name: "Twice Jewellers" });
    expect(second.status).toBe(409);
    expect(second.body.detail).toMatch(/already has a shop/i);
  });

  test("Onboarding_alreadySeededUser_is409", async () => {
    // The fixture's owner already has a membership.
    const token = await token_for(fx.tenant_a.external_object_id);
    const response = await onboard(token, { shop_name: "Duplicate Jewellers" });

    expect(response.status).toBe(409);
  });

  test.each([
    ["an empty name", { shop_name: "" }],
    ["a one-character name", { shop_name: "A" }],
    ["no name at all", {}],
    ["a reserved link", { shop_name: "Admin Shop", slug: "admin" }],
    ["a link with spaces", { shop_name: "Shop", slug: "two words" }],
  ])("Onboarding_%s_is422", async (_label, body) => {
    const response = await onboard(await token_for(randomUUID()), body);
    expect(response.status).toBe(422);
  });

  /** A name with no Latin characters cannot yield a slug; say so. */
  test("Onboarding_nameWithNoUsableCharacters_is422", async () => {
    const response = await onboard(await token_for(randomUUID()), { shop_name: "राधिका" });
    expect(response.status).toBe(422);
  });

  /** An uppercase link is normalised rather than refused: the shopkeeper meant
   * the same thing, and rejecting it would be pedantry. */
  test("Onboarding_uppercaseSlug_isNormalisedNotRejected", async () => {
    const response = await onboard(await token_for(randomUUID()), {
      shop_name: "Caps Jewellers",
      slug: "CAPS-SHOP",
    });

    expect(response.status).toBe(201);
    expect(response.body.data.slug).toBe("caps-shop");
  });

  test("Onboarding_explicitSlug_isHonoured", async () => {
    const response = await onboard(await token_for(randomUUID()), {
      shop_name: "Radhika Jewellers Pvt Ltd",
      slug: "radhika-bk",
    });

    expect(response.status).toBe(201);
    expect(response.body.data.slug).toBe("radhika-bk");
  });
});

// ---------------------------------------------------------------------------
// Slug collisions
// ---------------------------------------------------------------------------

describe("slug collisions", () => {
  test("Onboarding_sameName_getsADistinctLink", async () => {
    const first = await onboard(await token_for(randomUUID()), { shop_name: "Popular Jewellers" });
    const second = await onboard(await token_for(randomUUID()), { shop_name: "Popular Jewellers" });

    expect(first.body.data.slug).toBe("popular-jewellers");
    expect(second.body.data.slug).toBe("popular-jewellers-2");
    expect(second.status).toBe(201);
  });

  /**
   * A revoked slug stays taken. Reassigning it would make an old shared link
   * resolve to a different shop's rates — exactly what rotation prevents.
   */
  test("Onboarding_revokedSlug_isNotReassigned", async () => {
    await owner.customer_links.updateMany({
      where: { slug: fx.tenant_a.slug },
      data: { is_active: false, revoked_at: new Date() },
    });

    const response = await onboard(await token_for(randomUUID()), {
      shop_name: "Sharma Jewellers",
    });

    expect(response.status).toBe(201);
    expect(response.body.data.slug).not.toBe(fx.tenant_a.slug);
  });

  test("Onboarding_collidingWithASeededShop_getsASuffix", async () => {
    const response = await onboard(await token_for(randomUUID()), {
      shop_name: "Sharma Jewellers",
    });

    expect(response.body.data.slug).toBe("sharma-jewellers-2");
  });
});

// ---------------------------------------------------------------------------
// Slug derivation, in isolation
// ---------------------------------------------------------------------------

describe("slug derivation", () => {
  test.each([
    ["Sharma Jewellers", "sharma-jewellers"],
    ["  Spaced   Out  ", "spaced-out"],
    ["Ravi & Sons Jewellers", "ravi-sons-jewellers"],
    ["Café Jewellers", "cafe-jewellers"],
    ["A.B.C. Jewellers Pvt. Ltd.", "a-b-c-jewellers-pvt-ltd"],
  ])("Slugify_%s_becomes_%s", (name, expected) => {
    expect(slugify(name)).toBe(expected);
  });

  test("Slugify_nonLatinScript_yieldsNothingRatherThanAGuess", () => {
    expect(slugify("राधिका ज्वेलर्स")).toBe("");
  });

  test("Slugify_neverEndsWithAHyphen", () => {
    expect(slugify("Jewellers!!!")).toBe("jewellers");
    expect(slugify("-leading and trailing-")).toBe("leading-and-trailing");
  });

  test.each(RESERVED_SLUGS.map((s) => [s]))("IsValidSlug_reserved_%s_isRefused", (slug) => {
    expect(is_valid_slug(slug)).toBe(false);
  });

  test.each([["ab"], ["a"], [""], ["-abc"], ["abc-"], ["Abc"], ["a b"], ["a_b"]])(
    "IsValidSlug_%s_isRefused",
    (slug) => {
      expect(is_valid_slug(slug)).toBe(false);
    },
  );

  test("IsValidSlug_ordinaryShopName_isAccepted", () => {
    expect(is_valid_slug("sharma-jewellers")).toBe(true);
    expect(is_valid_slug("bk1")).toBe(true);
  });
});
