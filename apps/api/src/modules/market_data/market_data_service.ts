/**
 * The market-data service: one provider, one ingestion pipeline, one cache of
 * last-known quotes, and an honest answer to "what is the current rate?".
 *
 * This is the only component the pricing layer talks to. It never fabricates a
 * quote: when the feed is gone, `resolve_base_rate` says so and names the last
 * known value rather than quietly extrapolating one.
 */
import type { Clock } from "../../platform/clock.js";
import {
  evaluate_freshness,
  DEFAULT_FRESHNESS_POLICY,
  type FreshnessPolicy,
} from "./freshness.js";
import { parse_quote, QuoteValidationError } from "./quote_schema.js";
import { QuoteStream, type QuoteStreamOptions } from "./quote_stream.js";
import type {
  MarketDataProvider,
  StatusListener,
  Subscription,
} from "./provider.js";
import type {
  BaseRateResolution,
  IngestResult,
  MarketQuote,
  ProviderHealth,
  ProviderStatus,
  QuoteSnapshot,
} from "./types.js";

/** Notified for every quote that survives validation and ingestion. */
export type AcceptedQuoteListener = (snapshot: QuoteSnapshot) => void;

/** Notified for every quote that does not, so a broken feed is visible. */
export type RejectionListener = (result: IngestResult & { outcome: "rejected" }) => void;

export interface MarketDataServiceOptions {
  readonly freshness: FreshnessPolicy;
  readonly stream: Partial<QuoteStreamOptions>;
}

export class MarketDataService {
  readonly #provider: MarketDataProvider;
  readonly #clock: Clock;
  readonly #policy: FreshnessPolicy;
  readonly #stream: QuoteStream;

  readonly #accepted_listeners = new Set<AcceptedQuoteListener>();
  readonly #rejection_listeners = new Set<RejectionListener>();

  #quote_subscription: Subscription | null = null;
  #status_subscription: Subscription | null = null;
  #started = false;

  constructor(
    provider: MarketDataProvider,
    clock: Clock,
    options: Partial<MarketDataServiceOptions> = {},
  ) {
    this.#provider = provider;
    this.#clock = clock;
    this.#policy = options.freshness ?? DEFAULT_FRESHNESS_POLICY;
    this.#stream = new QuoteStream(clock, options.stream ?? {});
  }

  get provider_name(): string {
    return this.#provider.name;
  }

  get is_simulated(): boolean {
    return this.#provider.is_simulated;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    this.#quote_subscription = this.#provider.subscribe((payload) => {
      this.#ingest(payload);
    });

    await this.#provider.start();
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;

    this.#quote_subscription?.unsubscribe();
    this.#status_subscription?.unsubscribe();
    this.#quote_subscription = null;
    this.#status_subscription = null;

    await this.#provider.stop();
    this.#accepted_listeners.clear();
    this.#rejection_listeners.clear();
  }

  on_quote(listener: AcceptedQuoteListener): Subscription {
    this.#accepted_listeners.add(listener);
    return { unsubscribe: () => this.#accepted_listeners.delete(listener) };
  }

  on_rejection(listener: RejectionListener): Subscription {
    this.#rejection_listeners.add(listener);
    return { unsubscribe: () => this.#rejection_listeners.delete(listener) };
  }

  on_provider_status(listener: StatusListener): Subscription {
    return this.#provider.on_status(listener);
  }

  /**
   * The last accepted quote for a symbol, with freshness evaluated now.
   *
   * Freshness is computed at read time, so a quote that was fresh when stored
   * reports as stale once it ages — without anything having to touch it.
   */
  snapshot(symbol: string): QuoteSnapshot | null {
    const quote = this.#stream.last_accepted(symbol);
    if (quote === null) return null;
    return evaluate_freshness(quote, this.#policy, this.#clock);
  }

  snapshots(): QuoteSnapshot[] {
    return this.#stream
      .symbols()
      .map((symbol) => this.snapshot(symbol))
      .filter((snapshot): snapshot is QuoteSnapshot => snapshot !== null);
  }

  /**
   * What the pricing layer asks for.
   *
   * Returns a discriminated result so an expired feed cannot be mistaken for a
   * usable rate. When unavailable, the last known snapshot is still handed back
   * — for display as an explicitly stale figure — but `available: false` means
   * **no new price may be published from it**.
   */
  resolve_base_rate(symbol: string): BaseRateResolution {
    const snapshot = this.snapshot(symbol);

    if (snapshot === null) {
      return { available: false, reason: "no_quote", last_known: null };
    }
    if (snapshot.freshness === "expired") {
      return { available: false, reason: "expired", last_known: snapshot };
    }
    return { available: true, snapshot };
  }

  /**
   * Provider health, upgraded to `stale` when the connection is nominally fine
   * but every symbol has aged past the freshness threshold.
   *
   * Without this the dashboard would show a green provider beside a frozen
   * board — the exact situation that makes stale data look live.
   */
  health(): ProviderHealth {
    const base = this.#provider.health();
    if (base.status !== "healthy") return base;

    const snapshots = this.snapshots();
    if (snapshots.length === 0) return base;

    const all_aged = snapshots.every((s) => s.freshness !== "fresh");
    if (!all_aged) return base;

    const status: ProviderStatus = "stale";
    return { ...base, status };
  }

  stats() {
    return this.#stream.stats();
  }

  /**
   * Pull the latest raw payloads from the provider.
   *
   * Exposed so the poller never holds a provider reference of its own. The
   * payloads are unvalidated by contract — `ingest_many` is what turns them
   * into quotes.
   */
  async provider_latest(symbols: readonly string[]): Promise<unknown[]> {
    return this.#provider.get_latest_quotes(symbols);
  }

  /**
   * Validate and accept a batch of raw payloads, returning those accepted.
   *
   * Rejections are reported to rejection listeners exactly as on the push path.
   * A polling provider and a streaming one therefore share one ingestion path,
   * so neither can wave a quote through the other's checks.
   */
  ingest_many(payloads: readonly unknown[]): QuoteSnapshot[] {
    const accepted: QuoteSnapshot[] = [];
    for (const payload of payloads) {
      if (payload === null || payload === undefined) continue;
      const snapshot = this.#ingest(payload);
      if (snapshot !== null) accepted.push(snapshot);
    }
    return accepted;
  }

  /** Discard ingestion history. Used on a cold reconnect and between tests. */
  reset(): void {
    this.#stream.reset();
  }

  /**
   * Validate and accept one raw payload.
   *
   * Returns the accepted snapshot, or null when the payload was rejected.
   * Listeners are notified either way, so a push subscriber and a pull caller
   * see identical behaviour — there is one ingestion path, not two.
   */
  #ingest(payload: unknown): QuoteSnapshot | null {
    let quote: MarketQuote;

    try {
      quote = parse_quote(payload, this.#clock.date());
    } catch (error) {
      this.#notify_rejection({
        outcome: "rejected",
        reason: "invalid_schema",
        detail:
          error instanceof QuoteValidationError ? error.message : "unknown parse failure",
      });
      return null;
    }

    const result = this.#stream.accept(quote);

    if (result.outcome === "rejected") {
      this.#notify_rejection(result);
      return null;
    }

    const snapshot = evaluate_freshness(result.quote, this.#policy, this.#clock);
    for (const listener of this.#accepted_listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  #notify_rejection(result: IngestResult & { outcome: "rejected" }): void {
    for (const listener of this.#rejection_listeners) {
      listener(result);
    }
  }
}
