/**
 * Recompute and publish customer-facing rates.
 *
 * This is the component Stage 9 found missing: the join between a market quote
 * and a customer's screen. Everything either side of it already existed.
 *
 * ```
 * quote ─▶ per-tenant recompute ─▶ published_rates ─┐
 *                                                   ├─ one transaction
 *                                  outbox row ──────┘
 *                                        │
 *                                        ▼ (after commit)
 *                                   Redis ─▶ rate_hub ─▶ SSE
 * ```
 *
 * ## Tenant isolation
 *
 * One gold tick moves every gold-selling tenant, so choosing *whose* rates to
 * recompute is inherently cross-tenant. That single question is answered by the
 * `tenants_affected_by_metal` SECURITY DEFINER function, which returns tenant
 * ids and nothing else.
 *
 * Every read and write then happens inside that one tenant's context, under
 * RLS, through `with_tenant_context`. No step of this pipeline holds BYPASSRLS,
 * and no tenant id here ever came from a browser — they come from the database.
 *
 * ## Pricing
 *
 * There is exactly one pricing engine and this calls it. Nothing here does
 * arithmetic on money: it assembles a `PricingInput` from the rule and the
 * product, hands it to `compute_customer_rate`, and persists the result
 * verbatim. In particular `raw_adjustment` is stored as the engine reports it —
 * the authored value — and is never recovered from the total.
 *
 * ## Freshness
 *
 * A rate is published only from a quote the freshness policy still considers
 * usable. An `expired` quote yields no publication at all, so the last good
 * rate stays in `published_rates` and ages visibly on the customer page rather
 * than being silently refreshed with a stale number.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Logger } from "../../platform/logger.js";
import type { Clock } from "../../platform/clock.js";
import { with_tenant_context } from "../tenancy/tenant_context.js";
import { compute_customer_rate, PricingError } from "../pricing/pricing_engine.js";
import type { Adjustment } from "../pricing/adjustment.js";
import type { PurityBasis } from "../pricing/purity.js";
import type { DisplayUnit, RoundingMode } from "../../platform/money.js";
import type { Freshness, QuoteSnapshot } from "../market_data/types.js";

/** Why a recompute happened. Mirrors the `rate_trigger` enum. */
export type PublicationTrigger = "market_tick" | "rule_change" | "manual_recompute";

export interface PublicationOutcome {
  readonly tenants: number;
  readonly published: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface PublicationDependencies {
  readonly db: PrismaClient;
  readonly logger: Logger;
  readonly clock: Clock;
}

/** The product/rule pair a recompute acts on, as read inside tenant context. */
interface RuleRow {
  id: string;
  product_id: string;
  adjustment_kind: string;
  adjustment_value: bigint;
  adjustment_bps: number;
  rounding_step_paise: number;
  rounding_mode: string;
  component_precision_paise: number;
  product: {
    metal_code: string;
    purity_num: number;
    purity_den: number;
    purity_basis: string;
  };
}

function to_adjustment(rule: RuleRow): Adjustment {
  // The two kinds stay mutually exclusive, exactly as the rule stores them.
  // Neither is ever derived from the other.
  return rule.adjustment_kind === "percentage"
    ? { kind: "percentage", bps: rule.adjustment_bps }
    : { kind: "absolute", milli_paise_per_gram: rule.adjustment_value };
}

function product_key(metal_code: string, purity_num: number): string {
  return `${metal_code}_${purity_num}`;
}

/**
 * Persist the market quote itself, once per ingestion.
 *
 * `market_rates` carries no `tenant_id` and no RLS — a market quote belongs to
 * nobody. Recording it gives `published_rates.source_market_rate_id` something
 * to point at, which is what makes a published rate traceable to the tick that
 * produced it.
 */
export async function record_market_quote(
  db: PrismaClient,
  snapshot: QuoteSnapshot,
): Promise<bigint> {
  const { quote } = snapshot;

  const row = await db.market_rates.create({
    data: {
      source: quote.source,
      provider_name: quote.provider,
      symbol: quote.symbol,
      bid_per_gram: quote.bid,
      ask_per_gram: quote.ask,
      mid_per_gram: quote.mid,
      purity_num: quote.purity.num,
      purity_den: quote.purity.den,
      provider_timestamp: quote.source_timestamp,
    },
    select: { id: true },
  });

  return row.id;
}

/**
 * Recompute and publish every rate one tenant holds for a metal.
 *
 * Runs in a single transaction under the tenant's own context: the rate and the
 * outbox row commit together or not at all, which is the whole point of the
 * outbox.
 */
export async function publish_for_tenant(
  deps: PublicationDependencies,
  tenant_id: string,
  snapshot: QuoteSnapshot,
  options: {
    readonly market_rate_id: bigint | null;
    readonly trigger: PublicationTrigger;
    /** Restrict to one product; omitted means every product for the metal. */
    readonly product_id?: string;
  },
): Promise<{ published: number; skipped: number }> {
  const { db, clock } = deps;
  const { quote, freshness } = snapshot;

  // An expired quote is not a price. Nothing is written, so the previous rate
  // remains and ages on the customer page.
  if (freshness === "expired") return { published: 0, skipped: 0 };

  return with_tenant_context(db, tenant_id, async (tx) => {
    const rules = (await tx.tenant_pricing_rules.findMany({
      where: {
        tenant_id,
        is_active: true,
        ...(options.product_id === undefined ? {} : { product_id: options.product_id }),
        product: { is_active: true, metal_code: quote.metal },
      },
      select: {
        id: true,
        product_id: true,
        adjustment_kind: true,
        adjustment_value: true,
        adjustment_bps: true,
        rounding_step_paise: true,
        rounding_mode: true,
        component_precision_paise: true,
        product: {
          select: {
            metal_code: true,
            purity_num: true,
            purity_den: true,
            purity_basis: true,
          },
        },
      },
    })) as RuleRow[];

    if (rules.length === 0) return { published: 0, skipped: 0 };

    // Only products the tenant has actually enabled are published; a disabled
    // product must not reappear on the customer page through a market tick.
    const enabled = await tx.tenant_products.findMany({
      where: {
        tenant_id,
        is_enabled: true,
        product_id: { in: rules.map((r) => r.product_id) },
      },
      select: { product_id: true, display_unit: true },
    });

    const units = new Map(enabled.map((e) => [e.product_id, e.display_unit]));

    let published = 0;
    let skipped = 0;

    for (const rule of rules) {
      const display_unit = units.get(rule.product_id);
      if (display_unit === undefined) {
        skipped += 1;
        continue;
      }

      const written = await publish_one(tx, {
        tenant_id,
        rule,
        display_unit: display_unit as DisplayUnit,
        snapshot,
        market_rate_id: options.market_rate_id,
        trigger: options.trigger,
        now: clock.date(),
        logger: deps.logger,
      });

      if (written) published += 1;
      else skipped += 1;
    }

    return { published, skipped };
  });
}

interface PublishOneInput {
  readonly tenant_id: string;
  readonly rule: RuleRow;
  readonly display_unit: DisplayUnit;
  readonly snapshot: QuoteSnapshot;
  readonly market_rate_id: bigint | null;
  readonly trigger: PublicationTrigger;
  readonly now: Date;
  readonly logger: Logger;
}

/**
 * Price one product and write the three rows that make it visible.
 *
 * All inside the caller's transaction:
 *   - `published_rates` — the authoritative current rate (upsert; one row per
 *     tenant/product, so a recompute converges rather than accumulating);
 *   - `rate_update_events` — the human-readable change log;
 *   - `rate_publication_outbox` — the durable prompt for the Redis publisher.
 */
async function publish_one(
  tx: Prisma.TransactionClient,
  input: PublishOneInput,
): Promise<boolean> {
  const { tenant_id, rule, display_unit, snapshot, now } = input;
  const { quote, freshness } = snapshot;

  let result;
  try {
    result = compute_customer_rate({
      base_rate: quote.mid,
      base_purity: quote.purity,
      target_purity: { num: rule.product.purity_num, den: rule.product.purity_den },
      purity_basis: rule.product.purity_basis as PurityBasis,
      adjustment: to_adjustment(rule),
      display_unit,
      rounding_step_paise: BigInt(rule.rounding_step_paise),
      rounding_mode: rule.rounding_mode as RoundingMode,
      component_precision_paise: BigInt(rule.component_precision_paise),
    });
  } catch (error) {
    // A rule that cannot produce a positive rate (a discount below the market
    // rate, say) is a configuration problem, not a pipeline failure. The
    // previous published rate stands.
    if (error instanceof PricingError) {
      input.logger.warn(
        {
          event: "publication.pricing_rejected",
          tenant_id,
          product_id: rule.product_id,
          reason: error.message,
        },
        "pricing rejected a rule during recompute",
      );
      return false;
    }
    throw error;
  }

  const previous = await tx.published_rates.findUnique({
    where: { tenant_id_product_id: { tenant_id, product_id: rule.product_id } },
    select: { rate_display_paise: true },
  });

  const row = {
    raw_base_rate: result.raw_base_rate,
    raw_adjustment: result.raw_adjustment,
    raw_customer_rate: result.raw_customer_rate,
    display_unit,
    component_precision_paise: Number(result.component_precision_paise),
    rounding_step_paise: Number(result.rounding_step_paise),
    base_display_paise: result.base_display_paise,
    adjustment_display_paise: result.adjustment_display_paise,
    rounding_delta_paise: result.rounding_delta_paise,
    rate_display_paise: result.rate_display_paise,
    source_market_rate_id: input.market_rate_id,
    pricing_rule_id: rule.id,
    provider_timestamp: quote.source_timestamp,
    computed_at: now,
  };

  await tx.published_rates.upsert({
    where: { tenant_id_product_id: { tenant_id, product_id: rule.product_id } },
    create: { tenant_id, product_id: rule.product_id, ...row },
    update: row,
  });

  const old_rate = previous?.rate_display_paise ?? null;
  const direction =
    old_rate === null || old_rate === result.rate_display_paise
      ? "unchanged"
      : result.rate_display_paise > old_rate
        ? "up"
        : "down";

  await tx.rate_update_events.create({
    data: {
      tenant_id,
      product_id: rule.product_id,
      old_rate_paise: old_rate,
      new_rate_paise: result.rate_display_paise,
      direction,
      trigger: input.trigger,
      market_rate_id: input.market_rate_id,
    },
  });

  // The outbox row commits with the rate above. If this transaction rolls back,
  // no event exists; if it commits, the event is durable and will be delivered
  // even if this process dies before reaching Redis.
  await tx.rate_publication_outbox.create({
    data: {
      tenant_id,
      product_id: rule.product_id,
      product_key: product_key(rule.product.metal_code, rule.product.purity_num),
      rate_display_paise: result.rate_display_paise,
      display_unit,
      source_timestamp: quote.source_timestamp,
      freshness: freshness satisfies Freshness,
      trigger: input.trigger,
    },
  });

  return true;
}

/**
 * Recompute every tenant affected by a quote.
 *
 * Tenants are processed one at a time, each in its own transaction. A tenant
 * whose recompute fails does not prevent the others from publishing — one
 * shop's misconfigured rule must not freeze the whole market's rates.
 */
export async function publish_for_quote(
  deps: PublicationDependencies,
  snapshot: QuoteSnapshot,
  options: { readonly record_quote?: boolean } = {},
): Promise<PublicationOutcome> {
  const { db, logger } = deps;
  const started = Date.now();

  if (snapshot.freshness === "expired") {
    logger.warn(
      {
        event: "publication.quote_expired",
        symbol: snapshot.quote.symbol,
        age_ms: snapshot.age_ms,
      },
      "quote is expired; nothing published",
    );
    return { tenants: 0, published: 0, skipped: 0, failed: 0 };
  }

  const market_rate_id =
    options.record_quote === false ? null : await record_market_quote(db, snapshot);

  // The one cross-tenant question, answered by a SECURITY DEFINER function that
  // returns ids and nothing else.
  const affected = await db.$queryRaw<{ tenant_id: string }[]>`
    SELECT tenant_id FROM tenants_affected_by_metal(${snapshot.quote.metal})
  `;

  let published = 0;
  let skipped = 0;
  let failed = 0;

  for (const { tenant_id } of affected) {
    try {
      const outcome = await publish_for_tenant(deps, tenant_id, snapshot, {
        market_rate_id,
        trigger: "market_tick",
      });
      published += outcome.published;
      skipped += outcome.skipped;
    } catch (error) {
      failed += 1;
      logger.error(
        {
          event: "publication.tenant_failed",
          tenant_id,
          err: error instanceof Error ? error.message : String(error),
        },
        "recompute failed for one tenant",
      );
    }
  }

  logger.info(
    {
      event: "publication.completed",
      symbol: snapshot.quote.symbol,
      metal: snapshot.quote.metal,
      freshness: snapshot.freshness,
      tenants: affected.length,
      published,
      skipped,
      failed,
      duration_ms: Date.now() - started,
    },
    `published ${published} rate(s) from a ${snapshot.quote.metal} quote`,
  );

  return { tenants: affected.length, published, skipped, failed };
}

// ---------------------------------------------------------------------------
// Pricing-rule mutations
// ---------------------------------------------------------------------------

/**
 * Supplies the market rate a recompute should price against.
 *
 * Injected rather than imported so the pricing service keeps no reference to
 * the market-data layer: a pricing rule is configuration, and it must remain
 * testable and mutable without a live feed.
 */
export type MarketSnapshotResolver = (metal: string) => QuoteSnapshot | null;

/**
 * Recompute one rule's published rate **inside the caller's transaction**.
 *
 * Called from the pricing mutation so the rule, its audit record, the new
 * published rate and the outbox row all commit together. A shopkeeper's change
 * is therefore either fully visible — rule, rate and pending event — or not
 * applied at all. There is no window in which the rule has changed but the
 * customer-facing rate still reflects the old one.
 *
 * Returns false when nothing was published, which is not an error:
 *   - no usable quote yet (a cold start, or an expired feed);
 *   - the product is disabled for this tenant;
 *   - the rule is inactive.
 *
 * In those cases the rule change still commits. The alternative — failing the
 * mutation because the market feed is down — would stop a shopkeeper
 * configuring their shop during an outage, which is precisely when they may
 * need to.
 */
export async function recompute_rule_in_transaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly tenant_id: string;
    readonly rule_id: string;
    readonly resolve_snapshot: MarketSnapshotResolver;
    readonly logger: Logger;
    readonly now: Date;
  },
): Promise<boolean> {
  const rule = (await tx.tenant_pricing_rules.findFirst({
    where: { id: input.rule_id, tenant_id: input.tenant_id, is_active: true },
    select: {
      id: true,
      product_id: true,
      adjustment_kind: true,
      adjustment_value: true,
      adjustment_bps: true,
      rounding_step_paise: true,
      rounding_mode: true,
      component_precision_paise: true,
      product: {
        select: {
          metal_code: true,
          purity_num: true,
          purity_den: true,
          purity_basis: true,
        },
      },
    },
  })) as RuleRow | null;

  if (rule === null) return false;

  const snapshot = input.resolve_snapshot(rule.product.metal_code);
  if (snapshot === null || snapshot.freshness === "expired") return false;

  const enabled = await tx.tenant_products.findUnique({
    where: {
      tenant_id_product_id: { tenant_id: input.tenant_id, product_id: rule.product_id },
    },
    select: { is_enabled: true, display_unit: true },
  });

  if (enabled === null || !enabled.is_enabled) return false;

  return publish_one(tx, {
    tenant_id: input.tenant_id,
    rule,
    display_unit: enabled.display_unit as DisplayUnit,
    snapshot,
    // The quote is already recorded by the poller; a rule change prices against
    // it rather than inserting a duplicate market row.
    market_rate_id: null,
    trigger: "rule_change",
    now: input.now,
    logger: input.logger,
  });
}
