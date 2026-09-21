/**
 * Development seed data.
 *
 * Creates the two tenants from the brief so tenant isolation is visible from
 * the very first run:
 *
 *   Sharma Jewellers — gold +₹50/g, silver +₹2/g
 *   Gupta Jewellers  — gold +₹100/g, silver −₹1/g
 *
 * Note how tenant-owned rows are inserted: each block first sets
 * `app.current_tenant_id`, because RLS is FORCEd and therefore applies to the
 * migration role too. The seed uses exactly the same path the application does.
 *
 * Never runs against production — see the guard in `main`.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../../../.env"), quiet: true });

const RUPEE_TO_MILLI_PAISE = 100_000n; // ₹1/g = 100 paise × 1000

interface SeedTenant {
  readonly id: string;
  readonly legal_name: string;
  readonly display_name: string;
  readonly slug: string;
  readonly owner_email: string;
  readonly owner_name: string;
  readonly phone: string;
  readonly city: string;
  readonly gold_adjustment_rupees_per_gram: bigint;
  readonly silver_adjustment_rupees_per_gram: bigint;
  readonly show_base_rate: boolean;
}

const TENANTS: readonly SeedTenant[] = [
  {
    id: randomUUID(),
    legal_name: "Sharma Jewellers Private Limited",
    display_name: "Sharma Jewellers",
    slug: "sharma-jewellers",
    owner_email: "owner@sharmajewellers.test",
    owner_name: "Rajesh Sharma",
    phone: "+919820011111",
    city: "Mumbai",
    gold_adjustment_rupees_per_gram: 50n,
    silver_adjustment_rupees_per_gram: 2n,
    show_base_rate: true,
  },
  {
    id: randomUUID(),
    legal_name: "Gupta Jewellers & Sons",
    display_name: "Gupta Jewellers",
    slug: "gupta-jewellers",
    owner_email: "owner@guptajewellers.test",
    owner_name: "Anil Gupta",
    phone: "+919820022222",
    city: "Jaipur",
    gold_adjustment_rupees_per_gram: 100n,
    silver_adjustment_rupees_per_gram: -1n,
    show_base_rate: false,
  },
];

/**
 * Reference catalog. `purity_basis` is per product because IBJA relates bullion
 * grades by true fineness but karat grades by the ×P/1000 trade convention —
 * verified against published rates in src/modules/pricing/purity.ts.
 */
const PRODUCTS = [
  { metal: "GOLD", num: 999, den: 1000, basis: "fine_ratio", label: "Gold 24K (999)", order: 10 },
  { metal: "GOLD", num: 995, den: 1000, basis: "fine_ratio", label: "Gold 24K (995)", order: 20 },
  { metal: "GOLD", num: 916, den: 1000, basis: "market_convention", label: "Gold 22K (916)", order: 30 },
  { metal: "GOLD", num: 750, den: 1000, basis: "market_convention", label: "Gold 18K (750)", order: 40 },
  { metal: "GOLD", num: 585, den: 1000, basis: "market_convention", label: "Gold 14K (585)", order: 50 },
  { metal: "SILVER", num: 999, den: 1000, basis: "fine_ratio", label: "Silver (999)", order: 60 },
  { metal: "SILVER", num: 925, den: 1000, basis: "market_convention", label: "Sterling Silver (925)", order: 70 },
] as const;

function create_client(): PrismaClient {
  const url = process.env["DATABASE_MIGRATION_URL"] ?? process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_MIGRATION_URL or DATABASE_URL must be set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/** Run `work` with a tenant's RLS context bound to the transaction. */
async function as_tenant<T>(
  db: PrismaClient,
  tenant_id: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant_id}, TRUE)`;
    return work(tx);
  });
}

async function seed_reference_data(db: PrismaClient): Promise<Map<string, string>> {
  await db.metals.createMany({
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

  const product_ids = new Map<string, string>();

  for (const product of PRODUCTS) {
    const row = await db.products.upsert({
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
        sort_order: product.order,
      },
    });
    product_ids.set(`${product.metal}_${product.num}`, row.id);
  }

  return product_ids;
}

async function seed_tenant(
  db: PrismaClient,
  tenant: SeedTenant,
  product_ids: Map<string, string>,
): Promise<void> {
  // `users` is global (not tenant-scoped), so it is created outside the context.
  const user = await db.users.upsert({
    where: { email: tenant.owner_email },
    update: {},
    create: {
      external_object_id: randomUUID(),
      // Placeholder directory until an Entra External ID tenant exists.
      // Development identities only; production users arrive via Entra.
      external_directory_id: "00000000-0000-0000-0000-000000000000",
      email: tenant.owner_email,
      full_name: tenant.owner_name,
    },
  });

  await as_tenant(db, tenant.id, async (tx) => {
    await tx.tenants.create({
      data: {
        id: tenant.id,
        legal_name: tenant.legal_name,
        status: "active",
      },
    });

    await tx.tenant_users.create({
      data: { tenant_id: tenant.id, user_id: user.id, role: "owner" },
    });

    await tx.tenant_branding.create({
      data: {
        tenant_id: tenant.id,
        display_name: tenant.display_name,
        accent_color: "#b8860b",
        tagline: "Trusted since 1985",
      },
    });

    await tx.tenant_contacts.create({
      data: {
        tenant_id: tenant.id,
        phone_e164: tenant.phone,
        whatsapp_e164: tenant.phone,
        address_line1: `12 Zaveri Bazaar`,
        city: tenant.city,
        state: tenant.city === "Mumbai" ? "Maharashtra" : "Rajasthan",
        pincode: tenant.city === "Mumbai" ? "400002" : "302001",
      },
    });

    await tx.customer_links.create({
      data: { tenant_id: tenant.id, slug: tenant.slug, created_by: user.id },
    });

    for (const product of PRODUCTS) {
      const product_id = product_ids.get(`${product.metal}_${product.num}`);
      if (!product_id) continue;

      const is_gold = product.metal === "GOLD";
      const rupees = is_gold
        ? tenant.gold_adjustment_rupees_per_gram
        : tenant.silver_adjustment_rupees_per_gram;

      await tx.tenant_products.create({
        data: {
          tenant_id: tenant.id,
          product_id,
          // Headline products enabled; the rest available but off by default.
          is_enabled: product.num === 999 || product.num === 916,
          display_order: product.order,
          display_unit: is_gold ? "per_10_gram" : "per_kilogram",
          show_base_rate: tenant.show_base_rate,
        },
      });

      await tx.tenant_pricing_rules.create({
        data: {
          tenant_id: tenant.id,
          product_id,
          adjustment_kind: "absolute",
          adjustment_value: rupees * RUPEE_TO_MILLI_PAISE,
          rounding_step_paise: 100, // nearest ₹1
          rounding_mode: "half_up",
          created_by: user.id,
        },
      });
    }
  });
}

async function main(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("Refusing to seed: NODE_ENV=production");
  }

  const db = create_client();

  try {
    const existing = await db.tenants.count();
    if (existing > 0) {
      process.stdout.write(
        `Database already has ${existing} tenant(s); skipping seed.\n` +
          "Run `npm run db:reset` to rebuild from scratch.\n",
      );
      return;
    }

    const product_ids = await seed_reference_data(db);
    for (const tenant of TENANTS) {
      await seed_tenant(db, tenant, product_ids);
    }

    process.stdout.write("Seeded development data:\n");
    for (const tenant of TENANTS) {
      process.stdout.write(
        `  ${tenant.display_name.padEnd(18)} /r/${tenant.slug.padEnd(20)} ` +
          `gold ${tenant.gold_adjustment_rupees_per_gram >= 0n ? "+" : ""}` +
          `₹${tenant.gold_adjustment_rupees_per_gram}/g\n`,
      );
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Seed failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
