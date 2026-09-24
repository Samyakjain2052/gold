/**
 * Integration test fixtures.
 *
 * Two tenants from the brief, each fully populated, so every isolation test has
 * a real neighbour to try to reach:
 *
 *   Tenant A — Sharma Jewellers, gold +₹50/g, slug `sharma-jewellers`
 *   Tenant B — Gupta Jewellers,  gold +₹100/g, slug `gupta-jewellers`
 *
 * Fixtures are rebuilt per suite and every test creates what it needs, per
 * `testing-best-practices.md` §2 and §8.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createClient, type RedisClientType } from "redis";
import { randomUUID } from "node:crypto";
import type { AuthenticatedTenantContext } from "../../src/modules/tenancy/tenant_context.js";

export const OWNER_URL =
  process.env["TEST_DATABASE_MIGRATION_URL"] ??
  "postgresql://bullion_owner:devpassword@localhost:5432/bullion_test";

/**
 * The application connects as a NON-SUPERUSER, NON-OWNER role.
 *
 * This is not incidental to the tests — it is the precondition that makes them
 * meaningful. PostgreSQL exempts superusers from RLS and lets owners bypass
 * their own policies, so running the suite as either would make every isolation
 * test pass for the wrong reason.
 */
export const APP_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgresql://bullion_app:devpassword@localhost:5432/bullion_test";

export const REDIS_URL = process.env["TEST_REDIS_URL"] ?? "redis://localhost:6380";

export function app_client(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: APP_URL }) });
}

export function owner_client(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
}

export async function redis_client(): Promise<RedisClientType> {
  const client: RedisClientType = createClient({ url: REDIS_URL });
  client.on("error", () => {
    /* surfaced by the awaiting call */
  });
  await client.connect();
  return client;
}

/**
 * The Entra directory the fixtures' identities belong to.
 *
 * Deliberately a synthetic UUID, not a real directory: tests must not depend on
 * any live tenant, and a real id in a fixture invites someone to point a test
 * at production.
 */
export const TEST_DIRECTORY_ID = "0d1e2c70-0000-4000-8000-000000000001";

export interface TenantFixture {
  readonly tenant_id: string;
  readonly user_id: string;
  /** Entra `oid` — the stable user key, with the directory id. */
  readonly external_object_id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly legal_name: string;
  readonly gold_rule_id: string;
  readonly gold_product_id: string;
  readonly silver_product_id: string;
  readonly context: AuthenticatedTenantContext;
}

export interface Fixtures {
  readonly tenant_a: TenantFixture;
  readonly tenant_b: TenantFixture;
}

const PRODUCTS = [
  { metal: "GOLD", num: 999, den: 1000, basis: "fine_ratio", label: "Gold 24K (999)" },
  { metal: "GOLD", num: 916, den: 1000, basis: "market_convention", label: "Gold 22K (916)" },
  { metal: "SILVER", num: 999, den: 1000, basis: "fine_ratio", label: "Silver (999)" },
] as const;

/** Remove all tenant data. Reference data is upserted, so it is left alone. */
export async function reset_database(owner: PrismaClient): Promise<void> {
  await owner.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_logs, rate_publication_outbox, rate_update_events, published_rates,
      tenant_pricing_rules,
      tenant_products, customer_links, tenant_contacts, tenant_branding,
      platform_admins, tenant_users, tenants, users, market_rates
    RESTART IDENTITY CASCADE
  `);
}

async function seed_reference(owner: PrismaClient): Promise<Map<string, string>> {
  await owner.metals.createMany({
    data: [
      {
        code: "GOLD",
        display_name: "Gold",
        reference_purity_num: 999,
        reference_purity_den: 1000,
        conventional_display_unit: "per_10_gram",
      },
      {
        code: "SILVER",
        display_name: "Silver",
        reference_purity_num: 999,
        reference_purity_den: 1000,
        conventional_display_unit: "per_kilogram",
      },
    ],
    skipDuplicates: true,
  });

  const ids = new Map<string, string>();
  for (const product of PRODUCTS) {
    const row = await owner.products.upsert({
      where: {
        metal_code_purity_num_purity_den: {
          metal_code: product.metal,
          purity_num: product.num,
          purity_den: product.den,
        },
      },
      update: {},
      create: {
        metal_code: product.metal,
        purity_num: product.num,
        purity_den: product.den,
        purity_basis: product.basis,
        label: product.label,
      },
    });
    ids.set(`${product.metal}_${product.num}`, row.id);
  }
  return ids;
}

/** Seed one tenant. Runs under that tenant's RLS context, as the app does. */
async function seed_tenant(
  owner: PrismaClient,
  spec: {
    legal_name: string;
    display_name: string;
    slug: string;
    email: string;
    gold_adjustment: bigint;
    show_base_rate: boolean;
  },
  product_ids: Map<string, string>,
): Promise<TenantFixture> {
  const tenant_id = randomUUID();
  const external_object_id = randomUUID();

  const user = await owner.users.create({
    data: {
      external_object_id,
      external_directory_id: TEST_DIRECTORY_ID,
      email: spec.email,
      full_name: `${spec.display_name} Owner`,
    },
  });

  const gold_product_id = product_ids.get("GOLD_916")!;
  const silver_product_id = product_ids.get("SILVER_999")!;

  const gold_rule_id = await owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant_id}, TRUE)`;

    await tx.tenants.create({
      data: { id: tenant_id, legal_name: spec.legal_name, status: "active" },
    });
    await tx.tenant_users.create({
      data: { tenant_id, user_id: user.id, role: "owner" },
    });
    await tx.tenant_branding.create({
      data: { tenant_id, display_name: spec.display_name, tagline: "Trusted since 1985" },
    });
    await tx.tenant_contacts.create({
      data: {
        tenant_id,
        phone_e164: "+919820000000",
        whatsapp_e164: "+919820000000",
        address_line1: "12 Zaveri Bazaar",
        city: "Mumbai",
        state: "Maharashtra",
        pincode: "400002",
      },
    });
    await tx.customer_links.create({
      data: { tenant_id, slug: spec.slug, created_by: user.id },
    });

    for (const product_id of [gold_product_id, silver_product_id]) {
      await tx.tenant_products.create({
        data: {
          tenant_id,
          product_id,
          is_enabled: true,
          display_unit: product_id === gold_product_id ? "per_10_gram" : "per_kilogram",
          show_base_rate: spec.show_base_rate,
        },
      });
    }

    const rule = await tx.tenant_pricing_rules.create({
      data: {
        tenant_id,
        product_id: gold_product_id,
        adjustment_kind: "absolute",
        adjustment_value: spec.gold_adjustment,
        rounding_step_paise: 100,
        created_by: user.id,
      },
    });

    // A published rate so public-page tests have something to read.
    // Figures satisfy the ADR-0005 reconciliation constraints.
    const base = 1_408_139_320n;
    const adjustment = spec.gold_adjustment;
    await tx.published_rates.create({
      data: {
        tenant_id,
        product_id: gold_product_id,
        raw_base_rate: base,
        raw_adjustment: adjustment,
        raw_customer_rate: base + adjustment,
        display_unit: "per_10_gram",
        component_precision_paise: 1,
        rounding_step_paise: 100,
        base_display_paise: 14_081_393n,
        adjustment_display_paise: (adjustment * 10n) / 1000n,
        rounding_delta_paise: 0n,
        rate_display_paise: 14_081_393n + (adjustment * 10n) / 1000n,
        pricing_rule_id: rule.id,
        provider_timestamp: new Date(),
      },
    });

    // Every tenant-owned table carries at least one row, so the "only tenant A
    // rows" sweep actually exercises each one rather than passing on emptiness.
    await tx.rate_update_events.create({
      data: {
        tenant_id,
        product_id: gold_product_id,
        old_rate_paise: 14_081_393n,
        new_rate_paise: 14_081_393n + (adjustment * 10n) / 1000n,
        direction: "up",
        trigger: "rule_change",
      },
    });

    // Already delivered, so the fixture does not give the outbox publisher work
    // to do in tests that are not about publication.
    await tx.rate_publication_outbox.create({
      data: {
        tenant_id,
        product_id: gold_product_id,
        product_key: "GOLD_999",
        rate_display_paise: 14_081_393n + (adjustment * 10n) / 1000n,
        display_unit: "per_10_gram",
        source_timestamp: new Date(),
        freshness: "fresh",
        trigger: "rule_change",
        delivered_at: new Date(),
      },
    });

    await tx.audit_logs.create({
      data: {
        tenant_id,
        actor_user_id: user.id,
        actor_type: "authenticated",
        actor_role: "owner",
        action: "pricing_rule.created",
        entity_type: "tenant_pricing_rules",
        entity_id: rule.id,
      },
    });

    // One idempotency row so the RLS sweep exercises this table too rather
    // than passing on emptiness.
    await tx.idempotency_keys.create({
      data: {
        tenant_id,
        idempotency_key: `seed-${tenant_id}`,
        request_fingerprint: "seed-fingerprint",
        response_status: 200,
        response_body: { seeded: true },
      },
    });

    return rule.id;
  });

  return {
    tenant_id,
    user_id: user.id,
    external_object_id,
    slug: spec.slug,
    display_name: spec.display_name,
    legal_name: spec.legal_name,
    gold_rule_id,
    gold_product_id,
    silver_product_id,
    context: {
      kind: "authenticated",
      tenant_id,
      user_id: user.id,
      role: "owner",
    },
  };
}

export async function seed_fixtures(owner: PrismaClient): Promise<Fixtures> {
  await reset_database(owner);
  const product_ids = await seed_reference(owner);

  const tenant_a = await seed_tenant(
    owner,
    {
      legal_name: "Sharma Jewellers Private Limited",
      display_name: "Sharma Jewellers",
      slug: "sharma-jewellers",
      email: "owner@sharmajewellers.test",
      gold_adjustment: 5_000_000n, // +₹50/g
      show_base_rate: true,
    },
    product_ids,
  );

  const tenant_b = await seed_tenant(
    owner,
    {
      legal_name: "Gupta Jewellers & Sons",
      display_name: "Gupta Jewellers",
      slug: "gupta-jewellers",
      email: "owner@guptajewellers.test",
      gold_adjustment: 10_000_000n, // +₹100/g
      show_base_rate: false,
    },
    product_ids,
  );

  return { tenant_a, tenant_b };
}

/** Every table carrying a `tenant_id` column. Asserted complete by the suite. */
export const TENANT_OWNED_TABLES = [
  "idempotency_keys",
  "tenant_branding",
  "tenant_contacts",
  "tenant_users",
  "customer_links",
  "tenant_products",
  "tenant_pricing_rules",
  "published_rates",
  "rate_update_events",
  "rate_publication_outbox",
  "audit_logs",
] as const;

/** Run raw SQL as the application role under a given (or absent) tenant context. */
export async function query_as_app<T = unknown>(
  app: PrismaClient,
  tenant_context: string | null,
  sql: string,
): Promise<T[]> {
  return app.$transaction(async (tx) => {
    if (tenant_context !== null) {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant_context}, TRUE)`;
    }
    return tx.$queryRawUnsafe<T[]>(sql);
  });
}
