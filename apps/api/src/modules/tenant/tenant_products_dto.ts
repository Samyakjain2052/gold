/**
 * The pure half of per-product display settings.
 *
 * Split from `tenant_products_service.ts` for the same reason as
 * `tenant_settings_dto.ts`: what is here is determined entirely by its inputs
 * and is unit-tested directly; what is there is a transaction under RLS.
 */
import { z } from "zod";

export const DISPLAY_UNITS = ["per_gram", "per_10_gram", "per_kilogram"] as const;

export type DisplayUnit = (typeof DISPLAY_UNITS)[number];

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
  readonly display_unit: DisplayUnit;
  readonly show_base_rate: boolean;
  readonly display_order: number;
  /** Whether a pricing rule exists; without one the product cannot publish. */
  readonly has_pricing_rule: boolean;
}

/** How a metal is conventionally quoted in the Indian trade. */
export function default_display_unit(metal_code: string): DisplayUnit {
  return metal_code === "SILVER" ? "per_kilogram" : "per_10_gram";
}

/** A product's configuration before the shop has expressed any preference. */
export interface ProductConfig {
  readonly is_enabled: boolean;
  readonly display_unit: DisplayUnit;
  readonly show_base_rate: boolean;
  readonly display_order: number;
}

export function default_config(metal_code: string): ProductConfig {
  return {
    // Off until chosen: a shop should not find itself quoting a metal it does
    // not deal in because a row appeared.
    is_enabled: false,
    display_unit: default_display_unit(metal_code),
    // Off until chosen: the margin is the shop's business, and revealing it is
    // a decision the shopkeeper makes, not a default they must discover.
    show_base_rate: false,
    display_order: 0,
  };
}

/**
 * Resolve the values a row should hold after an update.
 *
 * Three layers, narrowing: the defaults for the metal, then whatever the shop
 * already stored, then whatever this request asked for. Every key is present in
 * the result, so the row can be created from it as well as updated.
 */
export function merge_config(
  metal_code: string,
  stored: Partial<ProductConfig> | null,
  input: UpdateProductRequest,
): ProductConfig {
  const defaults = default_config(metal_code);
  return {
    is_enabled: input.is_enabled ?? stored?.is_enabled ?? defaults.is_enabled,
    display_unit: input.display_unit ?? stored?.display_unit ?? defaults.display_unit,
    show_base_rate: input.show_base_rate ?? stored?.show_base_rate ?? defaults.show_base_rate,
    display_order: input.display_order ?? stored?.display_order ?? defaults.display_order,
  };
}

/**
 * Whether this update invalidates the product's published rate.
 *
 * `published_rates.rate_display_paise` is an amount **in** its display unit, so
 * changing the unit makes the stored figure wrong until it is recomputed —
 * ₹14,081 per 10 grams read as per gram is out by a factor of ten, which is
 * exactly the kind of number a customer acts on.
 *
 * Asking for the unit it already has is not a change, and must not trigger a
 * recompute: republishing on a no-op would show customers a rate movement that
 * did not happen.
 *
 * `show_base_rate` is absent from this deliberately. It is read at query time
 * by `get_public_rates`, so nothing stored goes stale.
 */
export function requires_recompute(
  stored: Partial<ProductConfig> | null,
  input: UpdateProductRequest,
): boolean {
  return input.display_unit !== undefined && input.display_unit !== stored?.display_unit;
}
