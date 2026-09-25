/**
 * Which products a shop sells, and how it shows them.
 *
 * Onboarding enables the whole catalogue with sensible units and the breakdown
 * switched off. This is how a shopkeeper changes that: drop a product they do
 * not deal in, quote silver per kilogram rather than per gram, or publish the
 * market rate beside their own so customers can see the margin.
 *
 * ## `display_unit` is not a display preference
 *
 * It is baked into `published_rates`: the stored `rate_display_paise` is an
 * amount *in that unit*. Changing it makes every stored rate for the product
 * wrong until it is recomputed — ₹14,081 per 10 grams read as per gram is off
 * by a factor of ten, which is exactly the kind of error a customer acts on.
 *
 * So a unit change triggers an immediate recompute through the same hook the
 * pricing API uses. If no market quote is available the recompute is skipped
 * and the next tick corrects it; the stale row is not left to be read as
 * though it were in the new unit, because `published_rates.display_unit` is
 * stored alongside and the public projection reports what it actually is.
 *
 * ## `show_base_rate` needs no recompute
 *
 * It is read at query time by `get_public_rates`, which withholds the
 * components when it is off. Nothing stored changes, and the very next read
 * reflects the new choice.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { require_capability } from "../auth/authorization.js";
import {
  actor_from_context,
  write_audit,
  type AuditRequestContext,
} from "../audit/audit_service.js";
import type { AuthenticatedTenantContext } from "../tenancy/tenant_context.js";
import { with_context } from "../tenancy/tenant_context.js";
import { AppError } from "../../platform/errors.js";

export const DISPLAY_UNITS = ["per_gram", "per_10_gram", "per_kilogram"] as const;

export const update_product_request = z
  .object({
    is_enabled: z.boolean().optional(),
    display_unit: z.enum(DISPLAY_UNITS).optional(),
    show_base_rate: z.boolean().optional(),
    display_order: z.number().int().min(0).max(999).optional(),
  })
  .strict();

export type UpdateProductRequest = z.infer<typeof update_product_request>;

export interface TenantProductView {
  readonly product_id: string;
  readonly label: string;
  readonly metal: string;
  readonly purity: { readonly num: number; readonly den: number };
  readonly is_enabled: boolean;
  readonly display_unit: string;
  readonly show_base_rate: boolean;
  readonly display_order: number;
  /** Whether a pricing rule exists; without one the product cannot publish. */
  readonly has_pricing_rule: boolean;
}

/** Recomputes a product's published rate inside the caller's transaction. */
export type ProductRecompute = (
  tx: Prisma.TransactionClient,
  tenant_id: string,
  rule_id: string,
) => Promise<boolean>;

export async function list_products(
  db: PrismaClient,
  context: AuthenticatedTenantContext,
): Promise<TenantProductView[]> {
  require_capability(context, "tenant:read");

  return with_context(db, context, async (tx) => {
    // The catalogue is global reference data, not tenant-owned, so every shop
    // sees every active product — including ones it has not enabled, which is
    // the point: you cannot turn on what you cannot see.
    const products = await tx.products.findMany({
      where: { is_active: true },
      select: {
        id: true,
        label: true,
        metal_code: true,
        purity_num: true,
        purity_den: true,
        sort_order: true,
      },
      orderBy: { sort_order: "asc" },
    });

    const [enabled, rules] = await Promise.all([
      tx.tenant_products.findMany({
        where: { tenant_id: context.tenant_id },
        select: {
          product_id: true,
          is_enabled: true,
          display_unit: true,
          show_base_rate: true,
          display_order: true,
        },
      }),
      tx.tenant_pricing_rules.findMany({
        where: { tenant_id: context.tenant_id, is_active: true },
        select: { product_id: true },
      }),
    ]);

    const config = new Map(enabled.map((e) => [e.product_id, e]));
    const priced = new Set(rules.map((r) => r.product_id));

    return products.map((product, index) => {
      const own = config.get(product.id);
      return {
        product_id: product.id,
        label: product.label,
        metal: product.metal_code,
        purity: { num: product.purity_num, den: product.purity_den },
        is_enabled: own?.is_enabled ?? false,
        display_unit:
          own?.display_unit ?? (product.metal_code === "SILVER" ? "per_kilogram" : "per_10_gram"),
        show_base_rate: own?.show_base_rate ?? false,
        display_order: own?.display_order ?? index,
        has_pricing_rule: priced.has(product.id),
      };
    });
  });
}

export async function update_product(
  db: PrismaClient,
  context: AuthenticatedTenantContext,
  product_id: string,
  input: UpdateProductRequest,
  request: AuditRequestContext,
  recompute?: ProductRecompute,
): Promise<TenantProductView> {
  require_capability(context, "tenant:branding:write");

  if (Object.keys(input).length === 0) {
    throw AppError.validation("No changes supplied");
  }

  await with_context(db, context, async (tx) => {
    const product = await tx.products.findFirst({
      where: { id: product_id, is_active: true },
      select: { id: true, metal_code: true },
    });

    // A product that does not exist and one that is inactive are the same
    // answer: there is nothing here to configure.
    if (product === null) {
      throw AppError.not_found("No such product");
    }

    const before = await tx.tenant_products.findUnique({
      where: { tenant_id_product_id: { tenant_id: context.tenant_id, product_id } },
      select: {
        is_enabled: true,
        display_unit: true,
        show_base_rate: true,
        display_order: true,
      },
    });

    const defaults = {
      is_enabled: false,
      display_unit: product.metal_code === "SILVER" ? "per_kilogram" : "per_10_gram",
      show_base_rate: false,
      display_order: 0,
    } as const;

    // Every key is present: defaults supply all four, and `before`/`input`
    // only ever narrow them. Typed explicitly so the create below is not
    // handed an `undefined` the column cannot take.
    const merged: {
      is_enabled: boolean;
      display_unit: "per_gram" | "per_10_gram" | "per_kilogram";
      show_base_rate: boolean;
      display_order: number;
    } = {
      is_enabled: input.is_enabled ?? before?.is_enabled ?? defaults.is_enabled,
      display_unit: (input.display_unit ??
        before?.display_unit ??
        defaults.display_unit) as "per_gram" | "per_10_gram" | "per_kilogram",
      show_base_rate:
        input.show_base_rate ?? before?.show_base_rate ?? defaults.show_base_rate,
      display_order: input.display_order ?? before?.display_order ?? defaults.display_order,
    };

    await tx.tenant_products.upsert({
      where: { tenant_id_product_id: { tenant_id: context.tenant_id, product_id } },
      create: {
        tenant_id: context.tenant_id,
        product_id,
        is_enabled: merged.is_enabled,
        display_unit: merged.display_unit,
        show_base_rate: merged.show_base_rate,
        display_order: merged.display_order,
      },
      update: {
        ...(input.is_enabled === undefined ? {} : { is_enabled: input.is_enabled }),
        ...(input.display_unit === undefined ? {} : { display_unit: input.display_unit }),
        ...(input.show_base_rate === undefined ? {} : { show_base_rate: input.show_base_rate }),
        ...(input.display_order === undefined ? {} : { display_order: input.display_order }),
      },
    });

    await write_audit(tx, {
      tenant_id: context.tenant_id,
      actor: actor_from_context(context),
      action: "tenant_product.updated",
      entity_type: "tenant_product",
      entity_id: product_id,
      old_value: before === null ? null : { ...before },
      new_value: { ...merged },
      request,
    });

    // A unit change invalidates the stored rate, which is an amount in the old
    // unit. Recompute inside this transaction so the setting and the rate it
    // governs commit together.
    const unit_changed =
      input.display_unit !== undefined && input.display_unit !== before?.display_unit;

    if (unit_changed && recompute !== undefined) {
      const rule = await tx.tenant_pricing_rules.findFirst({
        where: { tenant_id: context.tenant_id, product_id, is_active: true },
        select: { id: true },
      });
      if (rule !== null) {
        await recompute(tx, context.tenant_id, rule.id);
      }
    }
  });

  const all = await list_products(db, context);
  const view = all.find((p) => p.product_id === product_id);
  if (view === undefined) throw AppError.not_found("No such product");
  return view;
}
