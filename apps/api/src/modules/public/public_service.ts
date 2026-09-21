/**
 * The public customer-access path.
 *
 * ## Authorisation model
 *
 * ```
 *   /r/{slug}
 *      │
 *      ▼  derive_public_context(slug)          ← server-side lookup only
 *   customer_links WHERE slug = ? AND is_active
 *      │                                        revoked  → 410
 *      │                                        unknown  → 404
 *      │                                        tenant suspended → 404
 *      ▼
 *   PublicTenantContext { tenant_id, slug }    ← no user, no role
 *      │
 *      ▼  with_context(...)                     ← RLS bound to that tenant
 *   tenant_branding · tenant_contacts · tenant_products · published_rates
 *      │
 *      ▼  to_public_* allowlist projections     ← names every field emitted
 *   PublicShop / PublicRate
 * ```
 *
 * This is **not** the shopkeeper path with authentication skipped. It is a
 * separate model with its own context type, its own queries and its own
 * projections. Reusing the dashboard path with a "public" flag is how private
 * fields reach anonymous visitors, so the two never share a code path.
 *
 * ## What is deliberately never emitted
 *
 * Internal ids (`tenant_id`, `product_id`, rule ids, user ids), pricing
 * configuration, raw rate tiers, audit logs, member lists, provider
 * credentials, and provider/system internals. The projections below are
 * allowlists: adding a column to a table cannot leak it, because someone has to
 * add it here on purpose. `public_access.test.ts` asserts the emitted key sets
 * exactly, so a new field fails the test rather than shipping quietly.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  derive_public_context,
  with_context,
  type PublicTenantContext,
} from "../tenancy/tenant_context.js";
import type { Freshness } from "../market_data/types.js";

// ---------------------------------------------------------------------------
// Public DTOs — the complete set of fields an anonymous visitor may see
// ---------------------------------------------------------------------------

export interface PublicShop {
  /** The slug, not the tenant UUID. The only identifier a visitor receives. */
  readonly slug: string;
  readonly display_name: string;
  readonly tagline: string | null;
  readonly logo_url: string | null;
  readonly accent_color: string | null;
  readonly contact: PublicContact;
}

export interface PublicContact {
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly pincode: string | null;
}

export interface PublicRate {
  /** Stable, non-identifying product key such as "GOLD_916". */
  readonly product_key: string;
  readonly label: string;
  readonly metal: string;
  readonly display_unit: string;
  /** Authoritative customer rate, in paise of `display_unit`, as a string. */
  readonly rate: string;
  /** Present only when the tenant enables the breakdown. */
  readonly market_rate: string | null;
  readonly shop_adjustment: string | null;
  readonly rounding: string | null;
  /** The vendor's own stamp — never our receipt time. */
  readonly source_timestamp: string;
  readonly freshness: Freshness;
}

export class PublicAccessError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 410,
  ) {
    super(message);
    this.name = "PublicAccessError";
  }
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

interface BrandingRow {
  display_name: string;
  tagline: string | null;
  accent_color: string | null;
  logo_blob_path: string | null;
}

interface ContactRow {
  phone_e164: string | null;
  whatsapp_e164: string | null;
  public_email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  show_phone: boolean;
  show_whatsapp: boolean;
  show_address: boolean;
}

/**
 * Build the public shop view.
 *
 * Every field is named explicitly. No entity is ever spread into a response.
 */
export function to_public_shop(
  slug: string,
  branding: BrandingRow | null,
  contact: ContactRow | null,
  logo_base_url: string | null,
): PublicShop {
  return {
    slug,
    display_name: branding?.display_name ?? "",
    tagline: branding?.tagline ?? null,
    // A blob path is an internal storage location; only a resolved URL leaves.
    logo_url:
      branding?.logo_blob_path != null && logo_base_url != null
        ? `${logo_base_url}/${branding.logo_blob_path}`
        : null,
    accent_color: branding?.accent_color ?? null,
    contact: {
      phone: contact?.show_phone === true ? contact.phone_e164 : null,
      whatsapp: contact?.show_whatsapp === true ? contact.whatsapp_e164 : null,
      email: contact?.public_email ?? null,
      address:
        contact?.show_address === true
          ? [contact.address_line1, contact.address_line2].filter(Boolean).join(", ") ||
            null
          : null,
      city: contact?.show_address === true ? contact.city : null,
      state: contact?.show_address === true ? contact.state : null,
      pincode: contact?.show_address === true ? contact.pincode : null,
    },
  };
}

interface PublishedRateRow {
  rate_display_paise: bigint;
  base_display_paise: bigint;
  adjustment_display_paise: bigint;
  rounding_delta_paise: bigint;
  display_unit: string;
  provider_timestamp: Date;
  product: {
    metal_code: string;
    purity_num: number;
    label: string;
  };
}

/**
 * Build a public rate view.
 *
 * `show_base_rate` governs the breakdown. When it is off, the market rate and
 * the shop's margin are absent from the payload entirely — not merely hidden by
 * the UI, which a visitor could read around.
 */
export function to_public_rate(
  row: PublishedRateRow,
  show_base_rate: boolean,
  freshness: Freshness,
): PublicRate {
  return {
    product_key: `${row.product.metal_code}_${row.product.purity_num}`,
    label: row.product.label,
    metal: row.product.metal_code,
    display_unit: row.display_unit,
    rate: row.rate_display_paise.toString(),
    market_rate: show_base_rate ? row.base_display_paise.toString() : null,
    shop_adjustment: show_base_rate ? row.adjustment_display_paise.toString() : null,
    rounding: show_base_rate ? row.rounding_delta_paise.toString() : null,
    source_timestamp: row.provider_timestamp.toISOString(),
    freshness,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface PublicServiceOptions {
  readonly logo_base_url: string | null;
  /** Supplies freshness for a published rate's provider timestamp. */
  readonly classify: (source_timestamp: Date) => Freshness;
}

/** Resolve a slug, translating context failures into public-safe statuses. */
export async function resolve_public_tenant(
  db: PrismaClient,
  slug: string,
): Promise<PublicTenantContext> {
  try {
    return await derive_public_context(db, slug);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "slug_revoked") {
      throw new PublicAccessError("This link has been replaced", 410);
    }
    throw new PublicAccessError("Not found", 404);
  }
}

export async function get_public_shop(
  db: PrismaClient,
  slug: string,
  options: PublicServiceOptions,
): Promise<PublicShop> {
  const context = await resolve_public_tenant(db, slug);

  return with_context(db, context, async (tx) => {
    const [branding, contact] = await Promise.all([
      tx.tenant_branding.findFirst({
        where: { tenant_id: context.tenant_id },
        select: {
          display_name: true,
          tagline: true,
          accent_color: true,
          logo_blob_path: true,
        },
      }),
      tx.tenant_contacts.findFirst({
        where: { tenant_id: context.tenant_id },
        select: {
          phone_e164: true,
          whatsapp_e164: true,
          public_email: true,
          address_line1: true,
          address_line2: true,
          city: true,
          state: true,
          pincode: true,
          show_phone: true,
          show_whatsapp: true,
          show_address: true,
        },
      }),
    ]);

    return to_public_shop(context.slug, branding, contact, options.logo_base_url);
  });
}

export async function get_public_rates(
  db: PrismaClient,
  slug: string,
  options: PublicServiceOptions,
): Promise<PublicRate[]> {
  const context = await resolve_public_tenant(db, slug);

  return with_context(db, context, async (tx) => {
    const enabled = await tx.tenant_products.findMany({
      where: { tenant_id: context.tenant_id, is_enabled: true },
      select: { product_id: true, show_base_rate: true, display_order: true },
      orderBy: { display_order: "asc" },
    });

    if (enabled.length === 0) return [];

    const disclosure = new Map(enabled.map((e) => [e.product_id, e.show_base_rate]));
    const order = new Map(enabled.map((e) => [e.product_id, e.display_order]));

    const rows = await tx.published_rates.findMany({
      where: {
        tenant_id: context.tenant_id,
        product_id: { in: enabled.map((e) => e.product_id) },
      },
      select: {
        product_id: true,
        rate_display_paise: true,
        base_display_paise: true,
        adjustment_display_paise: true,
        rounding_delta_paise: true,
        display_unit: true,
        provider_timestamp: true,
        product: { select: { metal_code: true, purity_num: true, label: true } },
      },
    });

    return rows
      .sort((a, b) => (order.get(a.product_id) ?? 0) - (order.get(b.product_id) ?? 0))
      .map((row) =>
        to_public_rate(
          row as unknown as PublishedRateRow,
          disclosure.get(row.product_id) === true,
          options.classify(row.provider_timestamp),
        ),
      );
  });
}

/** Re-exported so tests can assert the transaction client type is honoured. */
export type PublicTransaction = Prisma.TransactionClient;
