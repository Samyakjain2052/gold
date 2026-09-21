/**
 * API contracts for pricing rules.
 *
 * ## Why DTOs exist at all
 *
 * A Prisma model is a storage shape. Exposing it directly would make every
 * column a public API promise — so adding `updated_by` or `version` would be a
 * breaking change, and removing one would break clients. Worse, a column added
 * later would be published automatically, which is how internal fields leak.
 *
 * These schemas name every field that crosses the boundary, in both directions.
 *
 * ## Strictness is the security control
 *
 * Every request schema is `.strict()`. An unknown field is a **422**, not a
 * silent drop. That is what stops `tenant_id`, `user_id`, `role`, `created_by`
 * and friends riding in on a request body: they are not in the schema, so they
 * are rejected outright rather than ignored and possibly picked up later by a
 * careless spread.
 *
 * ## Money on the wire
 *
 * `bigint` has no JSON representation, and `Number` would silently lose
 * precision on exactly the values this system exists to keep exact. Monetary
 * fields cross the boundary as **decimal strings**, parsed with the money
 * module's string parser — never `parseFloat`.
 */
import { z } from "zod";
import { MAX_ADJUSTMENT_BPS } from "./adjustment.js";
import { ROUNDING_MODES, type RoundingMode } from "../../platform/money.js";

/** Display precisions a tenant may choose, in paise of the display unit. */
export const ALLOWED_ROUNDING_STEPS = [1, 5, 10, 25, 50, 100, 500, 1000, 10_000] as const;
export const ALLOWED_COMPONENT_PRECISIONS = [1, 5, 10, 100] as const;

/**
 * Rupees-per-gram as a decimal string.
 *
 * A string, not a number: `{"adjustment": 50.07}` is an IEEE-754 double by the
 * time it is parsed, and the whole pricing architecture exists to avoid that.
 * Two decimal places is the paise limit.
 */
const rupees_per_gram = z
  .string()
  .regex(
    /^-?\d{1,9}(\.\d{1,2})?$/,
    "expected rupees per gram with at most 2 decimal places, e.g. \"50\" or \"-1.50\"",
  );

const uuid = z.uuid("expected a UUID");

const rounding_mode_schema = z.enum(
  ROUNDING_MODES as unknown as [RoundingMode, ...RoundingMode[]],
);

/**
 * Shared shape for the pricing fields.
 *
 * A discriminated union on `adjustment_kind`: an absolute rule carries an
 * amount and a percentage rule carries basis points, and **neither may carry
 * the other**. Accepting both would make "which one applies?" ambiguous and
 * invite a later reader to derive one from the other — the confusion ADR-0005
 * exists to prevent.
 */
const absolute_adjustment = z.object({
  adjustment_kind: z.literal("absolute"),
  /** Signed. Negative is a discount. */
  adjustment_rupees_per_gram: rupees_per_gram,
});

const percentage_adjustment = z.object({
  adjustment_kind: z.literal("percentage"),
  /** Basis points. Integer, so a percentage never touches a float. */
  adjustment_bps: z
    .int()
    .min(-MAX_ADJUSTMENT_BPS, `must be at least -${MAX_ADJUSTMENT_BPS} bps (-100%)`)
    .max(MAX_ADJUSTMENT_BPS, `must be at most ${MAX_ADJUSTMENT_BPS} bps (100%)`),
});

const display_settings = {
  rounding_step_paise: z
    .literal(ALLOWED_ROUNDING_STEPS)
    .describe("Display precision for the final customer rate"),
  rounding_mode: rounding_mode_schema,
  component_precision_paise: z
    .literal(ALLOWED_COMPONENT_PRECISIONS)
    .describe("Display precision for the breakdown lines"),
};

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Create.
 *
 * Note what is **absent and unacceptable**: `tenant_id`, `user_id`, `role`,
 * `created_by`, `updated_by`, `version`, `id`. Identity and ownership come from
 * the authenticated context; `.strict()` turns any attempt to supply them into
 * a 422.
 */
export const create_pricing_rule_request = z
  .discriminatedUnion("adjustment_kind", [
    absolute_adjustment
      .extend({ product_id: uuid, ...display_settings })
      .strict(),
    percentage_adjustment
      .extend({ product_id: uuid, ...display_settings })
      .strict(),
  ]);

export type CreatePricingRuleRequest = z.infer<typeof create_pricing_rule_request>;

/**
 * Update.
 *
 * The full pricing shape is required rather than patched field-by-field: a
 * partial update of a discriminated union invites a rule that claims
 * `percentage` while retaining a stale absolute amount. Replacing the whole
 * pricing block keeps the two kinds mutually exclusive by construction.
 *
 * `product_id` is absent — a rule's product is its identity. Changing it would
 * be a different rule, created and deleted explicitly.
 */
export const update_pricing_rule_request = z.discriminatedUnion("adjustment_kind", [
  absolute_adjustment.extend(display_settings).strict(),
  percentage_adjustment.extend(display_settings).strict(),
]);

export type UpdatePricingRuleRequest = z.infer<typeof update_pricing_rule_request>;

export const list_audit_query = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    /** Opaque cursor: the id of the last row seen. */
    cursor: z.string().regex(/^\d{1,19}$/).optional(),
    entity_id: uuid.optional(),
  })
  .strict();

export type ListAuditQuery = z.infer<typeof list_audit_query>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * The rule as clients see it.
 *
 * `version` is exposed because clients need it for `If-Match`. Internal
 * columns — `tenant_id`, `created_by`, `updated_by` — are not: a client has no
 * use for them, and the tenant is implied by the authenticated context.
 */
export interface PricingRuleResponse {
  readonly id: string;
  readonly product_id: string;
  readonly product_label: string;
  readonly metal: string;
  readonly purity: { readonly num: number; readonly den: number };
  readonly adjustment_kind: "absolute" | "percentage";
  /** Present only for absolute rules. */
  readonly adjustment_rupees_per_gram: string | null;
  /** Present only for percentage rules. */
  readonly adjustment_bps: number | null;
  readonly rounding_step_paise: number;
  readonly rounding_mode: RoundingMode;
  readonly component_precision_paise: number;
  readonly is_active: boolean;
  /** Quote in `If-Match` to update. */
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * A computed preview.
 *
 * Mirrors `PricingResult` exactly, because the breakdown's whole purpose is to
 * show the tiers separately. The configured adjustment appears as configured —
 * never as `rate − base`.
 */
export interface PricingPreviewResponse {
  readonly product_id: string;
  readonly product_label: string;
  readonly display_unit: string;
  readonly freshness: string;
  readonly source_timestamp: string;
  /** Storage precision, milli-paise per gram, as strings. */
  readonly raw: {
    readonly base_rate: string;
    readonly adjustment: string;
    readonly customer_rate: string;
  };
  /** Display precision, paise of the display unit, as strings. */
  readonly display: {
    readonly market_rate: string;
    readonly shop_adjustment: string;
    readonly rounding_delta: string;
    readonly customer_rate: string;
  };
}
