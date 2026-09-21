/**
 * Quote ingestion: deduplication, ordering and plausibility.
 *
 * A provider feed is not a clean sequence. Reconnects replay, HTTP retries
 * double-deliver, and streaming feeds interleave. These are ingestion concerns,
 * not provider concerns, so they live here — every adapter gets the same
 * handling for free, and the rules are testable without a provider at all.
 *
 * ## Duplicate handling
 *
 * A quote is a duplicate when it carries a `quote_id` already seen for that
 * symbol, or when it matches the last accepted quote's sequence. Duplicates are
 * **rejected, not re-published**: re-publishing would refresh the displayed
 * timestamp without any new market information, which is exactly the "faking
 * real-time" this product must not do.
 *
 * A bounded LRU of recent ids per symbol is kept, so a long-running process
 * cannot grow memory without limit.
 *
 * ## Out-of-order handling
 *
 * Ordering uses `sequence` when the provider supplies one, and
 * `source_timestamp` otherwise. A quote that is older than the last accepted
 * one is rejected: publishing it would move the board backwards in time.
 *
 * Equal timestamps with no sequence are treated as duplicates rather than
 * out-of-order, since we cannot tell which came first and re-publishing gains
 * nothing.
 *
 * ## Plausibility
 *
 * A move beyond `max_move_bps` from the last accepted mid is rejected. Vendors
 * do emit decimal-shifted and zeroed prices; publishing one to a jeweller's
 * customers is a commercial incident, so the default is to keep the last known
 * good quote and raise the rejection rather than trust the feed.
 */
import type { Clock } from "../../platform/clock.js";
import type { IngestResult, MarketQuote, RejectionReason } from "./types.js";

export interface QuoteStreamOptions {
  /** Reject moves larger than this from the last accepted mid. */
  readonly max_move_bps: number;
  /** Recent quote ids remembered per symbol, for duplicate detection. */
  readonly dedupe_window: number;
  /** Symbols this stream accepts. Empty means accept any. */
  readonly known_symbols: readonly string[];
}

export const DEFAULT_QUOTE_STREAM_OPTIONS: QuoteStreamOptions = {
  max_move_bps: 500, // 5%
  dedupe_window: 256,
  known_symbols: [],
};

interface SymbolState {
  last_accepted: MarketQuote;
  /** Insertion-ordered recent ids; oldest evicted first. */
  recent_ids: Set<string>;
}

export interface StreamStats {
  readonly accepted: number;
  readonly rejected: Readonly<Record<RejectionReason, number>>;
}

const ZERO_REJECTIONS: Record<RejectionReason, number> = {
  invalid_schema: 0,
  duplicate: 0,
  out_of_order: 0,
  implausible_move: 0,
  unknown_symbol: 0,
};

export class QuoteStream {
  readonly #options: QuoteStreamOptions;
  readonly #clock: Clock;
  readonly #states = new Map<string, SymbolState>();

  #accepted = 0;
  #rejected: Record<RejectionReason, number> = { ...ZERO_REJECTIONS };

  constructor(clock: Clock, options: Partial<QuoteStreamOptions> = {}) {
    this.#clock = clock;
    this.#options = { ...DEFAULT_QUOTE_STREAM_OPTIONS, ...options };
  }

  /**
   * Offer a validated quote to the stream.
   *
   * Returns an explicit outcome rather than throwing: a rejected quote is a
   * normal, countable event, not an exceptional one.
   */
  accept(quote: MarketQuote): IngestResult {
    if (
      this.#options.known_symbols.length > 0 &&
      !this.#options.known_symbols.includes(quote.symbol)
    ) {
      return this.#reject(
        "unknown_symbol",
        `symbol ${quote.symbol} is not subscribed`,
      );
    }

    const state = this.#states.get(quote.symbol);

    if (state === undefined) {
      this.#remember(quote);
      this.#accepted += 1;
      return { outcome: "accepted", quote };
    }

    if (state.recent_ids.has(quote.quote_id)) {
      return this.#reject("duplicate", `quote_id ${quote.quote_id} already seen`);
    }

    const ordering = compare_ordering(quote, state.last_accepted);

    if (ordering === "duplicate") {
      return this.#reject(
        "duplicate",
        `quote for ${quote.symbol} carries no newer sequence or timestamp`,
      );
    }
    if (ordering === "older") {
      return this.#reject(
        "out_of_order",
        `quote for ${quote.symbol} is older than the last accepted quote`,
      );
    }

    const move_bps = move_in_bps(state.last_accepted.mid, quote.mid);
    if (move_bps > this.#options.max_move_bps) {
      return this.#reject(
        "implausible_move",
        `move of ${move_bps} bps exceeds the ${this.#options.max_move_bps} bps limit`,
      );
    }

    this.#remember(quote);
    this.#accepted += 1;
    return { outcome: "accepted", quote };
  }

  /** The most recent accepted quote for a symbol, if any. */
  last_accepted(symbol: string): MarketQuote | null {
    return this.#states.get(symbol)?.last_accepted ?? null;
  }

  symbols(): string[] {
    return [...this.#states.keys()];
  }

  stats(): StreamStats {
    return { accepted: this.#accepted, rejected: { ...this.#rejected } };
  }

  /** Forget all history. Used between test cases and on a cold reconnect. */
  reset(): void {
    this.#states.clear();
    this.#accepted = 0;
    this.#rejected = { ...ZERO_REJECTIONS };
  }

  #remember(quote: MarketQuote): void {
    const existing = this.#states.get(quote.symbol);
    const recent_ids = existing?.recent_ids ?? new Set<string>();

    recent_ids.add(quote.quote_id);
    // Bounded: evict oldest insertions once the window is exceeded.
    while (recent_ids.size > this.#options.dedupe_window) {
      const oldest = recent_ids.values().next();
      if (oldest.done === true) break;
      recent_ids.delete(oldest.value);
    }

    this.#states.set(quote.symbol, { last_accepted: quote, recent_ids });
    void this.#clock; // reserved for future age-based eviction
  }

  #reject(reason: RejectionReason, detail: string): IngestResult {
    this.#rejected[reason] += 1;
    return { outcome: "rejected", reason, detail };
  }
}

type Ordering = "newer" | "older" | "duplicate";

/**
 * Order two quotes. Sequence wins when both carry one, since a provider's own
 * sequence is more reliable than its clock.
 */
export function compare_ordering(
  candidate: MarketQuote,
  last: MarketQuote,
): Ordering {
  if (candidate.sequence !== null && last.sequence !== null) {
    if (candidate.sequence > last.sequence) return "newer";
    if (candidate.sequence < last.sequence) return "older";
    return "duplicate";
  }

  const candidate_at = candidate.source_timestamp.getTime();
  const last_at = last.source_timestamp.getTime();

  if (candidate_at > last_at) return "newer";
  if (candidate_at < last_at) return "older";
  return "duplicate";
}

/** Absolute move between two rates, in basis points of the previous value. */
export function move_in_bps(previous: bigint, next: bigint): number {
  if (previous === 0n) return Number.POSITIVE_INFINITY;
  const delta = next > previous ? next - previous : previous - next;
  return Number((delta * 10_000n) / previous);
}
