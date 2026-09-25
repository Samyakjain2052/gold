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
 * pricing API uses, inside the same transaction, so the setting and the rate it
 * governs commit together. If no pricing rule exists there is nothing to
 * recompute; `published_rates.display_unit` is stored alongside the amount and
 * the public projection reports the unit the row actually carries, so a stale
 * row is never reinterpreted as though it were in the new unit.
 *
 * The decisions themselves — defaults, merge order, and whether a recompute is
 * needed — live in `tenant_products_dto.ts` and are unit-tested there.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { require_capability } from "../auth/authorization.js";
import {
  actor_from_context,
  write_audit,
  type AuditRequestContext,
} from "../audit/audit_service.js";
import type { AuthenticatedTenantContext } from "../tenancy/tenant_context.js";
import { with_context } from "../tenancy/tenant_context.js";
import { AppError } from "../../platform/errors.js";
import {
  default_display_unit,
  merge_config,
  requires_recompute,
  type ProductConfig,
  type TenantProductView,
  type UpdateProductRequest,
} from "./tenant_products_dto.js";

export {
  DISPLAY_UNITS,
  update_product_request,
  type DisplayUnit,
  type TenantProductView,
  type UpdateProductRequest,
} from "./tenant_products_dto.js";

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
          (own?.display_unit as TenantProductView["display_unit"] | undefined) ??
          default_display_unit(product.metal_code),
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

    const before = (await tx.tenant_products.findUnique({
      where: { tenant_id_product_id: { tenant_id: context.tenant_id, product_id } },
      select: {
        is_enabled: true,
        display_unit: true,
        show_base_rate: true,
        display_order: true,
      },
    })) as ProductConfig | null;

    const merged = merge_config(product.metal_code, before, input);

    await tx.tenant_products.upsert({
      where: { tenant_id_product_id: { tenant_id: context.tenant_id, product_id } },
      create: { tenant_id: context.tenant_id, product_id, ...merged },
      // Only the keys the request carried, so a concurrent change to a field
      // this request did not mention survives.
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

    if (requires_recompute(before, input) && recompute !== undefined) {
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
