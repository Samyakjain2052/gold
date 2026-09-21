/**
 * Pricing rule operations for authenticated tenant staff.
 *
 * Composes the existing infrastructure rather than reimplementing any of it:
 * identity from `modules/auth`, tenant from `modules/tenancy`, capabilities
 * from the authorization matrix, arithmetic from the Stage 3 pricing engine,
 * isolation from PostgreSQL RLS.
 *
 * ## Isolation, three times over
 *
 * Every call carries a `TenantContext` and **no tenant id**:
 *   1. the tenant comes from the derived context;
 *   2. the query carries an explicit `tenant_id` filter;
 *   3. the transaction runs under RLS, which filters again in the database.
 *
 * Any one failing alone leaks nothing.
 *
 * ## One transaction per mutation
 *
 * A mutation, its audit row, and its idempotency record commit together or not
 * at all. `with_context` opens the transaction; everything below runs inside
 * it. That is what makes "mutation without audit" unreachable rather than
 * merely unlikely.
 *
 * ## Concurrency
 *
 * Updates are conditional on `version`. The `UPDATE … WHERE version = $expected`
 * either matches one row or none; zero means someone else moved first, and the
 * caller gets `409` rather than silently overwriting them.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "../../platform/errors.js";
import {
  require_capability,
  type Capability,
} from "../auth/authorization.js";
import {
  with_context,
  type AuthenticatedTenantContext,
} from "../tenancy/tenant_context.js";
import {
  actor_from_context,
  to_audit_snapshot,
  write_audit,
  type AuditRequestContext,
} from "../audit/audit_service.js";
import {
  find_stored_response,
  store_response,
  type StoredResponse,
} from "../idempotency/idempotency_service.js";
import {
  violates_constraint,
  CONSTRAINTS,
} from "../../platform/prisma_errors.js";
import {
  from_rupees,
  RATE_SCALE,
  type RoundingMode,
} from "../../platform/money.js";
import type {
  CreatePricingRuleRequest,
  PricingRuleResponse,
  UpdatePricingRuleRequest,
} from "./pricing_rule_dto.js";

const ENTITY_TYPE = "tenant_pricing_rules";

/**
 * The duplicate-rule conflict message.
 *
 * Defined once so the sequential pre-check and the concurrent
 * constraint-violation path return byte-identical responses — the same logical
 * conflict must not look different depending on timing. It names no constraint
 * and no internal detail.
 */
const DUPLICATE_ACTIVE_RULE = "An active pricing rule already exists for this product";

/** Columns the API reads. Never `select: *` — see pricing_rule_dto.ts. */
const RULE_SELECT = {
  id: true,
  tenant_id: true,
  product_id: true,
  adjustment_kind: true,
  adjustment_value: true,
  adjustment_bps: true,
  rounding_step_paise: true,
  rounding_mode: true,
  component_precision_paise: true,
  is_active: true,
  version: true,
  created_at: true,
  updated_at: true,
  product: {
    select: { label: true, metal_code: true, purity_num: true, purity_den: true },
  },
} satisfies Prisma.tenant_pricing_rulesSelect;

type RuleRow = Prisma.tenant_pricing_rulesGetPayload<{ select: typeof RULE_SELECT }>;

/**
 * Convert a stored rule into its API shape.
 *
 * The adjustment is rendered from whichever field the rule's *kind* selects.
 * A percentage rule never reports an amount and an absolute rule never reports
 * basis points, so a client cannot confuse the two or derive one from the
 * other.
 */
export function to_rule_response(row: RuleRow): PricingRuleResponse {
  const is_absolute = row.adjustment_kind === "absolute";

  return {
    id: row.id,
    product_id: row.product_id,
    product_label: row.product.label,
    metal: row.product.metal_code,
    purity: { num: row.product.purity_num, den: row.product.purity_den },
    adjustment_kind: row.adjustment_kind,
    adjustment_rupees_per_gram: is_absolute
      ? milli_paise_to_rupee_string(row.adjustment_value)
      : null,
    adjustment_bps: is_absolute ? null : row.adjustment_bps,
    rounding_step_paise: row.rounding_step_paise,
    rounding_mode: row.rounding_mode as RoundingMode,
    component_precision_paise: row.component_precision_paise,
    is_active: row.is_active,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * Milli-paise per gram → a rupee decimal string.
 *
 * Integer arithmetic throughout. Dividing by 100_000 in floating point would
 * reintroduce exactly the imprecision ADR-0003 removes.
 */
export function milli_paise_to_rupee_string(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;

  const whole = absolute / (100n * RATE_SCALE);
  const fraction = (absolute % (100n * RATE_SCALE)) / RATE_SCALE;

  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(2, "0")}`;
}

/** A rupee decimal string → milli-paise per gram. Exact. */
export function rupee_string_to_milli_paise(value: string): bigint {
  return from_rupees(value) * RATE_SCALE;
}

/** Request metadata threaded through to the audit row. */
export interface MutationContext {
  readonly request: AuditRequestContext;
  /** Present when the caller supplied `Idempotency-Key`. */
  readonly idempotency?: { readonly key: string; readonly fingerprint: string };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function list_rules(
  db: PrismaClient,
  context: AuthenticatedTenantContext,
): Promise<PricingRuleResponse[]> {
  require_capability(context, "tenant:pricing:read");

  return with_context(db, context, async (tx) => {
    const rows = await tx.tenant_pricing_rules.findMany({
      where: { tenant_id: context.tenant_id },
      select: RULE_SELECT,
      orderBy: [{ is_active: "desc" }, { created_at: "asc" }],
    });
    return rows.map(to_rule_response);
  });
}

/**
 * Fetch one rule.
 *
 * A rule belonging to another tenant produces the same `403` as one that does
 * not exist. Returning `404` for the latter would let a caller enumerate which
 * ids are real.
 */
export async function get_rule(
  db: PrismaClient,
  context: AuthenticatedTenantContext,
  rule_id: string,
): Promise<PricingRuleResponse> {
  require_capability(context, "tenant:pricing:read");

  const row = await with_context(db, context, async (tx) =>
    tx.tenant_pricing_rules.findFirst({
      where: { id: rule_id, tenant_id: context.tenant_id },
      select: RULE_SELECT,
    }),
  );

  if (row === null) throw AppError.forbidden("Not permitted");
  return to_rule_response(row);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function create_rule(
  db: PrismaClient,
  context: AuthenticatedTenantContext,
  input: CreatePricingRuleRequest,
  mutation: MutationContext,
): Promise<{ response: PricingRuleResponse; replayed: boolean }> {
  require_capability(context, "tenant:pricing:write");

  return run_mutation(db, context, mutation, 201, async (tx) => {
    await assert_product_is_supported(tx, input.product_id);

    // One active rule per product per tenant — `uq_tenant_pricing_rules_active`
    // enforces it, but checking here yields a 409 rather than a raw constraint
    // error the caller cannot interpret.
    const existing = await tx.tenant_pricing_rules.findFirst({
      where: {
        tenant_id: context.tenant_id,
        product_id: input.product_id,
        is_active: true,
      },
      select: { id: true },
    });

    // Normal-path check: gives a clean 409 without relying on an exception,
    // and catches the overwhelmingly common sequential case.
    if (existing !== null) {
      throw new AppError("CONFLICT", DUPLICATE_ACTIVE_RULE);
    }

    // The check above cannot close the race — two concurrent requests can both
    // pass it before either inserts. `uq_tenant_pricing_rules_active` is what
    // actually prevents the duplicate; this only translates its rejection into
    // the same response the sequential path returns.
    let created: RuleRow;
    try {
      created = await tx.tenant_pricing_rules.create({
        data: {
          // Ownership and identity come from the context. There is no path by
          // which a request body could supply any of these.
          tenant_id: context.tenant_id,
          created_by: context.user_id,
          updated_by: context.user_id,
          product_id: input.product_id,
          ...to_adjustment_columns(input),
          rounding_step_paise: input.rounding_step_paise,
          rounding_mode: input.rounding_mode,
          component_precision_paise: input.component_precision_paise,
        },
        select: RULE_SELECT,
      });
    } catch (error) {
      // Exactly this constraint. Any other unique violation is a different
      // problem and must not be disguised as a duplicate pricing rule.
      if (violates_constraint(error, CONSTRAINTS.active_pricing_rule)) {
        // Thrown, so the transaction rolls back: no rule, and no audit row —
        // `write_audit` below is never reached.
        throw new AppError("CONFLICT", DUPLICATE_ACTIVE_RULE);
      }
      throw error;
    }

    await write_audit(tx, {
      tenant_id: context.tenant_id,
      actor: actor_from_context(context),
      action: "pricing_rule.created",
      entity_type: ENTITY_TYPE,
      entity_id: created.id,
      old_value: null,
      new_value: to_audit_snapshot(created),
      request: mutation.request,
    });

    return to_rule_response(created);
  });
}

export async function update_rule(
  db: PrismaClient,
  context: AuthenticatedTenantContext,
  rule_id: string,
  expected_version: number,
  input: UpdatePricingRuleRequest,
  mutation: MutationContext,
): Promise<{ response: PricingRuleResponse; replayed: boolean }> {
  require_capability(context, "tenant:pricing:write");

  return run_mutation(db, context, mutation, 200, async (tx) => {
    const before = await load_own_rule(tx, context, rule_id);

    // The conditional update. `updateMany` carries both the tenant filter and
    // the version guard into the WHERE clause; `update` matches on the primary
    // key alone and would reach another tenant's row before RLS rejected it.
    const result = await tx.tenant_pricing_rules.updateMany({
      where: {
        id: rule_id,
        tenant_id: context.tenant_id,
        version: expected_version,
      },
      data: {
        ...to_adjustment_columns(input),
        rounding_step_paise: input.rounding_step_paise,
        rounding_mode: input.rounding_mode,
        component_precision_paise: input.component_precision_paise,
        updated_by: context.user_id,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      // The rule exists and is ours — `load_own_rule` proved that — so the only
      // remaining explanation is that the version moved.
      throw new AppError(
        "CONFLICT",
        `This pricing rule was modified by someone else (expected version ${expected_version}, found ${before.version}). Re-read it and retry.`,
      );
    }

    const after = await load_own_rule(tx, context, rule_id);

    await write_audit(tx, {
      tenant_id: context.tenant_id,
      actor: actor_from_context(context),
      action: "pricing_rule.updated",
      entity_type: ENTITY_TYPE,
      entity_id: rule_id,
      old_value: to_audit_snapshot(before),
      new_value: to_audit_snapshot(after),
      request: mutation.request,
    });

    return to_rule_response(after);
  });
}

/**
 * Deactivate a rule.
 *
 * Deliberately a soft delete. `published_rates` references the rule that
 * produced a live price, and audit history references its id; hard-deleting
 * would strand both. A tenant sees it gone, and the trail stays intact.
 */
export async function deactivate_rule(
  db: PrismaClient,
  context: AuthenticatedTenantContext,
  rule_id: string,
  expected_version: number,
  mutation: MutationContext,
): Promise<{ response: PricingRuleResponse; replayed: boolean }> {
  require_capability(context, "tenant:pricing:delete");

  return run_mutation(db, context, mutation, 200, async (tx) => {
    const before = await load_own_rule(tx, context, rule_id);

    const result = await tx.tenant_pricing_rules.updateMany({
      where: {
        id: rule_id,
        tenant_id: context.tenant_id,
        version: expected_version,
        is_active: true,
      },
      data: {
        is_active: false,
        updated_by: context.user_id,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      throw new AppError(
        "CONFLICT",
        before.is_active
          ? `This pricing rule was modified by someone else (expected version ${expected_version}, found ${before.version}). Re-read it and retry.`
          : "This pricing rule is already inactive",
      );
    }

    const after = await load_own_rule(tx, context, rule_id);

    await write_audit(tx, {
      tenant_id: context.tenant_id,
      actor: actor_from_context(context),
      action: "pricing_rule.deactivated",
      entity_type: ENTITY_TYPE,
      entity_id: rule_id,
      old_value: to_audit_snapshot(before),
      new_value: to_audit_snapshot(after),
      request: mutation.request,
    });

    return to_rule_response(after);
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Run a mutation with idempotency, inside one transaction.
 *
 * Ordering matters: the stored-response lookup, the mutation, the audit row and
 * the stored response all share a transaction, so a retry can never observe a
 * partially applied state.
 */
async function run_mutation(
  db: PrismaClient,
  context: AuthenticatedTenantContext,
  mutation: MutationContext,
  success_status: number,
  work: (tx: Prisma.TransactionClient) => Promise<PricingRuleResponse>,
): Promise<{ response: PricingRuleResponse; replayed: boolean }> {
  try {
    return await with_context(db, context, async (tx) => {
      if (mutation.idempotency !== undefined) {
        const stored = await find_stored_response(
          tx,
          context.tenant_id,
          mutation.idempotency.key,
          mutation.idempotency.fingerprint,
        );
        if (stored !== null) {
          return {
            response: stored.body as PricingRuleResponse,
            replayed: true,
          };
        }
      }

      const response = await work(tx);

      if (mutation.idempotency !== undefined) {
        await store_response(
          tx,
          context.tenant_id,
          mutation.idempotency.key,
          mutation.idempotency.fingerprint,
          { status: success_status, body: response },
        );
      }

      return { response, replayed: false };
    });
  } catch (error) {
    // A concurrent request with the same key lost the primary-key race. Scoped
    // to that constraint alone: mapping every P2002 here would have disguised
    // a duplicate pricing rule as an idempotency conflict.
    if (violates_constraint(error, CONSTRAINTS.idempotency_key)) {
      throw new AppError(
        "CONFLICT",
        "A request with this Idempotency-Key is already in progress",
      );
    }
    throw error;
  }
}

/** Load a rule that must belong to this tenant, or refuse. */
async function load_own_rule(
  tx: Prisma.TransactionClient,
  context: AuthenticatedTenantContext,
  rule_id: string,
): Promise<RuleRow> {
  const row = await tx.tenant_pricing_rules.findFirst({
    where: { id: rule_id, tenant_id: context.tenant_id },
    select: RULE_SELECT,
  });

  if (row === null) throw AppError.forbidden("Not permitted");
  return row;
}

/**
 * Map a validated request onto storage columns.
 *
 * The unused field is explicitly zeroed rather than left alone: a rule switched
 * from percentage to absolute must not retain stale basis points that a later
 * reader — or a later bug — could apply.
 */
function to_adjustment_columns(
  input: CreatePricingRuleRequest | UpdatePricingRuleRequest,
): { adjustment_kind: "absolute" | "percentage"; adjustment_value: bigint; adjustment_bps: number } {
  if (input.adjustment_kind === "absolute") {
    const value = rupee_string_to_milli_paise(input.adjustment_rupees_per_gram);

    // Mirrors chk_tenant_pricing_rules_bounds. Checked here so the caller gets
    // a 422 naming the field rather than a raw constraint violation.
    if (value > 10_000_000_000n || value < -10_000_000_000n) {
      throw AppError.validation("Adjustment is outside the permitted range", [
        { field: "adjustment_rupees_per_gram", message: "must be within ±₹100,000/g" },
      ]);
    }
    return { adjustment_kind: "absolute", adjustment_value: value, adjustment_bps: 0 };
  }

  return {
    adjustment_kind: "percentage",
    adjustment_value: 0n,
    adjustment_bps: input.adjustment_bps,
  };
}

/** Reject a product that does not exist or is retired. */
async function assert_product_is_supported(
  tx: Prisma.TransactionClient,
  product_id: string,
): Promise<void> {
  const product = await tx.products.findFirst({
    where: { id: product_id },
    select: { is_active: true },
  });

  if (product === null) {
    throw AppError.validation("Unknown product", [
      { field: "product_id", message: "no such product" },
    ]);
  }
  if (!product.is_active) {
    throw AppError.validation("Product is no longer supported", [
      { field: "product_id", message: "product is retired" },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Branding — kept here so the isolation suite covers a second resource type
// ---------------------------------------------------------------------------

export async function get_branding(
  db: PrismaClient,
  context: AuthenticatedTenantContext,
): Promise<{ tenant_id: string; display_name: string } | null> {
  return with_context(db, context, async (tx) =>
    tx.tenant_branding.findFirst({
      where: { tenant_id: context.tenant_id },
      select: { tenant_id: true, display_name: true },
    }),
  );
}

export async function update_branding(
  db: PrismaClient,
  context: AuthenticatedTenantContext,
  display_name: string,
): Promise<void> {
  require_capability(context, "tenant:branding:write" as Capability);

  const result = await with_context(db, context, async (tx) =>
    tx.tenant_branding.updateMany({
      where: { tenant_id: context.tenant_id },
      data: { display_name },
    }),
  );

  if (result.count === 0) throw AppError.forbidden("Not permitted");
}

export type { StoredResponse };
