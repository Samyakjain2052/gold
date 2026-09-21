/**
 * The vendor-independent provider contract.
 *
 * ## Lifecycle
 *
 * ```
 *              ┌──────────────────┐
 *              │  not_configured  │   no provider selected for this deployment
 *              └────────┬─────────┘
 *                       │ construct
 *              ┌────────▼─────────┐
 *              │    configured    │   constructed, start() not yet called
 *              └────────┬─────────┘
 *                       │ start()
 *              ┌────────▼─────────┐
 *        ┌────▶│    connecting    │◀────────────┐
 *        │     └────────┬─────────┘             │ retry with backoff
 *        │              │ first accepted quote  │
 *        │     ┌────────▼─────────┐             │
 *        │     │     healthy      │             │
 *        │     └───┬──────────┬───┘             │
 *        │         │          │ age > stale_after_ms
 *        │         │     ┌────▼─────┐           │
 *        │         │     │  stale   │           │
 *        │         │     └────┬─────┘           │
 *        │         │          │ fresh quote     │
 *        │         │◀─────────┘                 │
 *        │         │ connection lost            │
 *        │    ┌────▼─────────┐                  │
 *        └────│ disconnected │──────────────────┘
 *             └────┬─────────┘
 *                  │ unrecoverable / start() failed
 *             ┌────▼─────┐        stop()      ┌──────────────┐
 *             │  error   │───────────────────▶│ disconnected │
 *             └──────────┘                    └──────────────┘
 * ```
 *
 * `stale` is reachable only from `healthy`: it means the link is up but the
 * data has aged. That is operationally different from `disconnected`, and
 * collapsing the two would hide a silently-frozen feed behind a green light.
 *
 * ## Reconnect behaviour
 *
 * Reconnection is the provider's own responsibility, using capped exponential
 * backoff with full jitter per `api-standards.md` §9:
 * `random(0, min(30s, base × 2^attempt))`. Jitter matters because every replica
 * would otherwise retry in lockstep after a provider outage.
 *
 * Callers never drive reconnection. They observe it through `health()` and the
 * status listener.
 *
 * ## Failure behaviour
 *
 * A provider never throws from its subscription path. Failures surface as a
 * status transition plus `last_error`; the last known quote is retained and
 * ages naturally into `stale` and then `expired`. Nothing fabricates a quote to
 * fill a gap.
 */
import type { MarketSource, ProviderHealth, ProviderStatus } from "./types.js";

/** Called for every quote the provider emits, before validation. */
export type QuoteListener = (payload: unknown) => void;

export type StatusListener = (
  status: ProviderStatus,
  detail: { readonly previous: ProviderStatus; readonly error?: string },
) => void;

export interface Subscription {
  unsubscribe(): void;
}

/**
 * A market data source.
 *
 * Implementations normalise nothing — they emit raw payloads, which
 * `parse_quote` validates. Keeping validation outside the adapter means every
 * provider is held to the same schema, and an adapter cannot wave through a
 * malformed quote by constructing the domain type directly.
 */
export interface MarketDataProvider {
  readonly name: string;
  readonly source: MarketSource;
  /**
   * True for providers that emit simulated prices.
   *
   * The composition root refuses to start a simulated provider in production,
   * so mock data cannot be mistaken for a real feed.
   */
  readonly is_simulated: boolean;

  /** Connect and begin emitting. Idempotent. */
  start(): Promise<void>;

  /** Stop emitting and release resources. Idempotent; never throws. */
  stop(): Promise<void>;

  /** Pull the latest quotes. Used for the initial snapshot and by polling adapters. */
  get_latest_quotes(symbols: readonly string[]): Promise<unknown[]>;

  /** Receive pushed updates. Polling adapters invoke the listener on their own timer. */
  subscribe(listener: QuoteListener): Subscription;

  /** Observe lifecycle transitions. */
  on_status(listener: StatusListener): Subscription;

  /** Current health. Never throws. */
  health(): ProviderHealth;
}

/** Backoff schedule shared by every provider implementation. */
export interface BackoffOptions {
  readonly base_ms: number;
  readonly max_ms: number;
  readonly max_attempts: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  base_ms: 250,
  max_ms: 30_000,
  max_attempts: Number.POSITIVE_INFINITY,
};

/**
 * Full-jitter backoff: `random(0, min(max, base × 2^attempt))`.
 *
 * Full jitter rather than equal jitter because the failure mode being defended
 * against is every replica retrying simultaneously after a provider outage.
 *
 * @param attempt zero-based retry number
 * @param random injected for deterministic tests
 */
export function backoff_delay_ms(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(
    options.max_ms,
    options.base_ms * 2 ** Math.min(attempt, 32),
  );
  return Math.floor(random() * exponential);
}

/** Whether a transition between two statuses is permitted by the state machine. */
const ALLOWED_TRANSITIONS: Readonly<Record<ProviderStatus, readonly ProviderStatus[]>> = {
  not_configured: ["configured"],
  configured: ["connecting", "error"],
  connecting: ["healthy", "disconnected", "error"],
  healthy: ["stale", "disconnected", "error"],
  stale: ["healthy", "disconnected", "error"],
  disconnected: ["connecting", "error"],
  error: ["connecting", "disconnected"],
};

export function is_valid_transition(
  from: ProviderStatus,
  to: ProviderStatus,
): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class ProviderStateError extends Error {
  constructor(from: ProviderStatus, to: ProviderStatus) {
    super(`illegal provider transition ${from} → ${to}`);
    this.name = "ProviderStateError";
  }
}
