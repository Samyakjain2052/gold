/**
 * Freshness policy.
 *
 * Age is measured against the quote's **`source_timestamp`** — the vendor's own
 * stamp — never against `received_at`. A provider that reconnects and replays
 * an hour-old quote has not produced fresh data, and measuring from our receipt
 * time would claim otherwise.
 *
 * ## The three states
 *
 * | State | Condition | Meaning | Customer-facing behaviour |
 * |---|---|---|---|
 * | `fresh`   | `age ≤ stale_after_ms`   | Within the expected update cadence | Shown as live |
 * | `stale`   | `age ≤ expired_after_ms` | Connection may be fine; data has aged | Shown, explicitly marked stale |
 * | `expired` | otherwise                | Too old to price against | Not shown; pricing refuses |
 *
 * ## Where the defaults come from
 *
 * They are derived from the polling interval, not picked for roundness.
 *
 * - **`stale_after_ms` = 120 000 (2 min)** — twice the 60 s default poll
 *   interval plus margin. One missed poll is normal jitter; two consecutive
 *   misses is a signal. Setting this below the poll interval would flap on
 *   every cycle; setting it far above hides a dead feed.
 * - **`expired_after_ms` = 600 000 (10 min)** — ten missed polls. Gold can move
 *   materially in ten minutes, so a rate this old must not underpin a quote a
 *   jeweller would honour at the counter.
 *
 * Both are configurable (`FRESHNESS_STALE_AFTER_MS`, `FRESHNESS_EXPIRED_AFTER_MS`).
 * A deployment polling IBJA's twice-daily fix needs far larger values; one on a
 * streaming feed needs smaller. Raising them to mask a flaky provider means
 * showing customers stale prices styled as live, which is the failure this
 * policy exists to prevent.
 */
import type { Clock } from "../../platform/clock.js";
import type { Freshness, MarketQuote, QuoteSnapshot } from "./types.js";

export interface FreshnessPolicy {
  /** Beyond this age a quote is `stale`. */
  readonly stale_after_ms: number;
  /** Beyond this age a quote is `expired` and must not be priced against. */
  readonly expired_after_ms: number;
}

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  stale_after_ms: 120_000,
  expired_after_ms: 600_000,
};

export class FreshnessPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreshnessPolicyError";
  }
}

export function assert_valid_policy(policy: FreshnessPolicy): void {
  if (policy.stale_after_ms <= 0) {
    throw new FreshnessPolicyError("stale_after_ms must be positive");
  }
  if (policy.expired_after_ms <= policy.stale_after_ms) {
    throw new FreshnessPolicyError(
      "expired_after_ms must exceed stale_after_ms; otherwise no quote is ever merely stale",
    );
  }
}

/**
 * Classify an age in milliseconds.
 *
 * A negative age means the vendor's clock is ahead of ours. Treated as `fresh`
 * rather than rejected — small clock skew between hosts is normal, and refusing
 * data over it would take the feed down for a non-problem.
 */
export function classify_age(age_ms: number, policy: FreshnessPolicy): Freshness {
  if (age_ms <= policy.stale_after_ms) return "fresh";
  if (age_ms <= policy.expired_after_ms) return "stale";
  return "expired";
}

/** Evaluate a quote's freshness at the clock's current instant. */
export function evaluate_freshness(
  quote: MarketQuote,
  policy: FreshnessPolicy,
  clock: Clock,
): QuoteSnapshot {
  const age_ms = clock.now() - quote.source_timestamp.getTime();

  return {
    quote,
    freshness: classify_age(age_ms, policy),
    age_ms,
    evaluated_at: clock.date(),
  };
}

/** Whether a snapshot may be shown to a customer at all. */
export function is_displayable(snapshot: QuoteSnapshot): boolean {
  return snapshot.freshness !== "expired";
}

/** Whether a snapshot may be presented without a staleness warning. */
export function is_live(snapshot: QuoteSnapshot): boolean {
  return snapshot.freshness === "fresh";
}
