/**
 * `MockMarketDataProvider` — a simulated feed for development and tests.
 *
 * Deliberately not a `setInterval` that nudges a price. It models the parts of
 * a real feed that actually break: disconnects, replays, out-of-order delivery,
 * malformed payloads, silence, and recovery. Every one of those is driven
 * explicitly by the caller, so tests are deterministic and never sleep.
 *
 * It emits **raw payloads**, exactly like a real adapter, so `parse_quote`
 * validates mock data on the same path as vendor data. A mock that emitted
 * pre-built domain objects would let a whole layer go untested.
 *
 * ## Safety
 *
 * `is_simulated` is `true`, and configuration refuses `MARKET_DATA_PROVIDER=mock`
 * when `NODE_ENV=production`. Simulated prices cannot reach a real customer.
 */
import type { Clock } from "../../platform/clock.js";
import { ManualClock } from "../../platform/clock.js";
import {
  backoff_delay_ms,
  is_valid_transition,
  type BackoffOptions,
  type MarketDataProvider,

  type QuoteListener,
  type StatusListener,
  type Subscription,
} from "./provider.js";
import { DEFAULT_BACKOFF } from "./provider.js";
import type {
  MarketSource,
  MetalCode,
  ProviderHealth,
  ProviderStatus,
  SourceQuoteUnit,
} from "./types.js";

export interface MockSymbolDefinition {
  readonly symbol: string;
  readonly metal: MetalCode;
  readonly source_unit: SourceQuoteUnit;
  readonly purity_num: number;
  readonly purity_den: number;
  /** Starting mid, as a decimal rupee string in `source_unit`. */
  readonly start_mid: string;
  /** Half-spread in rupees, applied either side of the mid. */
  readonly half_spread: string;
}

/**
 * IBJA's published PM rates for 18/09/2026, so local development starts from
 * numbers that match the real market rather than invented ones.
 */
export const DEFAULT_MOCK_SYMBOLS: readonly MockSymbolDefinition[] = [
  {
    symbol: "XAU_INR",
    metal: "GOLD",
    source_unit: "per_10_gram",
    purity_num: 999,
    purity_den: 1000,
    start_mid: "153727",
    half_spread: "120",
  },
  {
    symbol: "XAG_INR",
    metal: "SILVER",
    source_unit: "per_kilogram",
    purity_num: 999,
    purity_den: 1000,
    start_mid: "236908",
    half_spread: "300",
  },
];

export interface MockProviderOptions {
  readonly symbols: readonly MockSymbolDefinition[];
  /** Deterministic PRNG for price walks. */
  readonly random: () => number;
  /** Maximum drift per tick, in basis points. */
  readonly drift_bps: number;
  readonly backoff: BackoffOptions;
}

const DEFAULT_OPTIONS: MockProviderOptions = {
  symbols: DEFAULT_MOCK_SYMBOLS,
  random: Math.random,
  drift_bps: 15,
  backoff: DEFAULT_BACKOFF,
};

/** A payload as a provider would put it on the wire. */
interface RawPayload {
  quote_id: string;
  sequence: number;
  provider: string;
  source: MarketSource;
  symbol: string;
  metal: MetalCode;
  currency: "INR";
  source_unit: SourceQuoteUnit;
  purity_num: number;
  purity_den: number;
  bid: string;
  ask: string;
  mid: string;
  source_timestamp: string;
}

interface SymbolRuntime {
  readonly definition: MockSymbolDefinition;
  /** Current mid in whole paise of `source_unit`, as an integer. */
  mid_paise: bigint;
  sequence: number;
  last_payload: RawPayload | null;
}

function paise_from_decimal(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`mock symbol amount "${value}" is not a decimal`);
  const [, sign, whole, fraction = ""] = match;
  const total = BigInt(whole as string) * 100n + BigInt(fraction.padEnd(2, "0"));
  return sign === "-" ? -total : total;
}

function decimal_from_paise(paise: bigint): string {
  const negative = paise < 0n;
  const absolute = negative ? -paise : paise;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n)
    .toString()
    .padStart(2, "0")}`;
}

export class MockMarketDataProvider implements MarketDataProvider {
  readonly name = "mock";
  readonly source: MarketSource = "mock";
  readonly is_simulated = true;

  readonly #clock: Clock;
  readonly #options: MockProviderOptions;
  readonly #symbols = new Map<string, SymbolRuntime>();
  readonly #quote_listeners = new Set<QuoteListener>();
  readonly #status_listeners = new Set<StatusListener>();

  #status: ProviderStatus = "configured";
  #connected_since: Date | null = null;
  #last_quote_at: Date | null = null;
  #last_source_timestamp: Date | null = null;
  #consecutive_failures = 0;
  #reconnect_attempts = 0;
  #last_error: string | null = null;
  #pending_failures = 0;
  #silent = false;
  #stopped = false;

  constructor(clock: Clock = new ManualClock(), options: Partial<MockProviderOptions> = {}) {
    this.#clock = clock;
    this.#options = { ...DEFAULT_OPTIONS, ...options };

    for (const definition of this.#options.symbols) {
      this.#symbols.set(definition.symbol, {
        definition,
        mid_paise: paise_from_decimal(definition.start_mid),
        sequence: 0,
        last_payload: null,
      });
    }
  }

  // --- Lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    if (this.#status === "healthy" || this.#status === "stale") return;

    this.#stopped = false;
    this.#transition("connecting");

    if (this.#pending_failures > 0) {
      this.#pending_failures -= 1;
      this.#consecutive_failures += 1;
      this.#last_error = "simulated connection failure";
      this.#transition("error", this.#last_error);
      return;
    }

    this.#consecutive_failures = 0;
    this.#last_error = null;
    this.#connected_since = this.#clock.date();
    this.#transition("healthy");
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;

    this.#stopped = true;
    this.#silent = false;
    // Graceful shutdown: listeners are released so no callback fires after
    // stop() resolves, and the status settles on `disconnected`, not `error`.
    if (this.#status !== "disconnected") {
      this.#transition("disconnected");
    }
    this.#quote_listeners.clear();
    this.#status_listeners.clear();
    this.#connected_since = null;
  }

  // --- Subscription -------------------------------------------------------

  subscribe(listener: QuoteListener): Subscription {
    this.#quote_listeners.add(listener);
    return {
      unsubscribe: () => {
        this.#quote_listeners.delete(listener);
      },
    };
  }

  on_status(listener: StatusListener): Subscription {
    this.#status_listeners.add(listener);
    return {
      unsubscribe: () => {
        this.#status_listeners.delete(listener);
      },
    };
  }

  async get_latest_quotes(symbols: readonly string[]): Promise<unknown[]> {
    if (this.#status === "disconnected" || this.#status === "error") {
      throw new Error(`provider is ${this.#status}`);
    }
    const wanted = symbols.length > 0 ? symbols : [...this.#symbols.keys()];
    return wanted
      .map((symbol) => this.#symbols.get(symbol)?.last_payload ?? null)
      .filter((payload): payload is RawPayload => payload !== null);
  }

  health(): ProviderHealth {
    return {
      provider: this.name,
      source: this.source,
      status: this.#status,
      is_simulated: true,
      connected_since: this.#connected_since,
      last_quote_at: this.#last_quote_at,
      last_source_timestamp: this.#last_source_timestamp,
      consecutive_failures: this.#consecutive_failures,
      reconnect_attempts: this.#reconnect_attempts,
      last_error: this.#last_error,
      evaluated_at: this.#clock.date(),
    };
  }

  // --- Simulation controls ------------------------------------------------

  /**
   * Emit one update per symbol, walking each price by a bounded random drift.
   *
   * No-op while silent, disconnected or stopped — the caller drives time, so a
   * "silent" provider genuinely emits nothing rather than emitting slowly.
   */
  tick(): void {
    if (!this.#can_emit()) return;

    for (const runtime of this.#symbols.values()) {
      const drift = this.#next_drift(runtime.mid_paise);
      runtime.mid_paise += drift;
      if (runtime.mid_paise <= 0n) runtime.mid_paise = 1n;
      this.#emit(runtime);
    }
  }

  /** Emit for one symbol only, optionally overriding the mid. */
  tick_symbol(symbol: string, mid_override?: string): void {
    if (!this.#can_emit()) return;

    const runtime = this.#symbols.get(symbol);
    if (runtime === undefined) throw new Error(`unknown mock symbol ${symbol}`);

    if (mid_override !== undefined) {
      runtime.mid_paise = paise_from_decimal(mid_override);
    } else {
      runtime.mid_paise += this.#next_drift(runtime.mid_paise);
    }
    this.#emit(runtime);
  }

  /** Re-send the last payload verbatim, as a reconnecting feed replaying does. */
  emit_duplicate(symbol: string): void {
    const runtime = this.#symbols.get(symbol);
    if (runtime?.last_payload == null) {
      throw new Error(`no previous payload for ${symbol}`);
    }
    if (!this.#can_emit()) return;
    this.#publish(runtime.last_payload);
  }

  /**
   * Emit a payload that is older than the last one, by both sequence and
   * source timestamp — an interleaved delivery.
   */
  emit_out_of_order(symbol: string, age_ms = 60_000): void {
    const runtime = this.#symbols.get(symbol);
    if (runtime?.last_payload == null) {
      throw new Error(`no previous payload for ${symbol}`);
    }
    if (!this.#can_emit()) return;

    const previous = runtime.last_payload;
    this.#publish({
      ...previous,
      quote_id: `${previous.quote_id}:late`,
      sequence: Math.max(0, previous.sequence - 1),
      source_timestamp: new Date(
        new Date(previous.source_timestamp).getTime() - age_ms,
      ).toISOString(),
    });
  }

  /** Emit something that will not survive schema validation. */
  emit_malformed(payload: unknown = { provider: "mock", mid: "not-a-number" }): void {
    if (!this.#can_emit()) return;
    this.#publish(payload);
  }

  /** Emit a quote whose source timestamp is already old. */
  emit_stale(symbol: string, age_ms: number): void {
    if (!this.#can_emit()) return;

    const runtime = this.#symbols.get(symbol);
    if (runtime === undefined) throw new Error(`unknown mock symbol ${symbol}`);

    runtime.sequence += 1;
    this.#publish(
      this.#build_payload(runtime, new Date(this.#clock.now() - age_ms)),
    );
  }

  /** Emit a price far outside the plausibility band, as a bad feed does. */
  emit_implausible(symbol: string, multiplier = 10n): void {
    if (!this.#can_emit()) return;

    const runtime = this.#symbols.get(symbol);
    if (runtime === undefined) throw new Error(`unknown mock symbol ${symbol}`);

    runtime.sequence += 1;
    const inflated = { ...runtime, mid_paise: runtime.mid_paise * multiplier };
    this.#publish(this.#build_payload(inflated, this.#clock.date()));
  }

  /** Drop the connection. Retains prices so a reconnect can resume from them. */
  disconnect(reason = "simulated disconnect"): void {
    if (this.#status === "disconnected") return;
    this.#last_error = reason;
    this.#transition("disconnected", reason);
    this.#connected_since = null;
  }

  /** Reconnect, counting the attempt and reporting the backoff it would use. */
  reconnect(): number {
    this.#reconnect_attempts += 1;
    const delay = backoff_delay_ms(
      this.#reconnect_attempts - 1,
      this.#options.backoff,
      this.#options.random,
    );

    this.#transition("connecting");

    if (this.#pending_failures > 0) {
      this.#pending_failures -= 1;
      this.#consecutive_failures += 1;
      this.#last_error = "simulated reconnect failure";
      this.#transition("error", this.#last_error);
      return delay;
    }

    this.#consecutive_failures = 0;
    this.#last_error = null;
    this.#connected_since = this.#clock.date();
    this.#stopped = false;
    this.#transition("healthy");
    return delay;
  }

  /** Cause the next `n` start/reconnect attempts to fail. */
  fail_next(attempts: number): void {
    this.#pending_failures = attempts;
  }

  /** Stay connected but stop emitting, so quotes age into stale then expired. */
  go_silent(): void {
    this.#silent = true;
  }

  resume(): void {
    this.#silent = false;
  }

  /**
   * Mark the feed stale without dropping the connection — the transition a
   * supervisor makes when the last quote ages past the freshness threshold.
   */
  mark_stale(): void {
    if (this.#status === "healthy") this.#transition("stale");
  }

  mark_healthy(): void {
    if (this.#status === "stale") this.#transition("healthy");
  }

  // --- Internals ----------------------------------------------------------

  #can_emit(): boolean {
    return (
      !this.#stopped &&
      !this.#silent &&
      (this.#status === "healthy" || this.#status === "stale")
    );
  }

  #next_drift(current: bigint): bigint {
    // Symmetric walk in ±drift_bps of the current mid.
    const span = BigInt(this.#options.drift_bps);
    const magnitude = (current * span) / 10_000n;
    const signed = this.#options.random() * 2 - 1;
    return BigInt(Math.trunc(Number(magnitude) * signed));
  }

  #emit(runtime: SymbolRuntime): void {
    runtime.sequence += 1;
    this.#publish(this.#build_payload(runtime, this.#clock.date()));
  }

  #build_payload(
    runtime: { definition: MockSymbolDefinition; mid_paise: bigint; sequence: number },
    source_timestamp: Date,
  ): RawPayload {
    const { definition } = runtime;
    const half_spread = paise_from_decimal(definition.half_spread);

    return {
      quote_id: `mock:${definition.symbol}:${runtime.sequence}`,
      sequence: runtime.sequence,
      provider: this.name,
      source: this.source,
      symbol: definition.symbol,
      metal: definition.metal,
      currency: "INR",
      source_unit: definition.source_unit,
      purity_num: definition.purity_num,
      purity_den: definition.purity_den,
      bid: decimal_from_paise(runtime.mid_paise - half_spread),
      ask: decimal_from_paise(runtime.mid_paise + half_spread),
      mid: decimal_from_paise(runtime.mid_paise),
      source_timestamp: source_timestamp.toISOString(),
    };
  }

  #publish(payload: unknown): void {
    if (
      typeof payload === "object" &&
      payload !== null &&
      "symbol" in payload &&
      "sequence" in payload
    ) {
      const typed = payload as RawPayload;
      const runtime = this.#symbols.get(typed.symbol);
      if (runtime !== undefined) runtime.last_payload = typed;
      this.#last_source_timestamp = new Date(typed.source_timestamp);
    }

    this.#last_quote_at = this.#clock.date();

    for (const listener of this.#quote_listeners) {
      listener(payload);
    }
  }

  #transition(next: ProviderStatus, error?: string): void {
    const previous = this.#status;
    if (previous === next) return;

    if (!is_valid_transition(previous, next)) {
      // Surfaced rather than thrown: an illegal transition is a bug in the
      // provider, and throwing from a status path would take the feed down.
      this.#last_error = `illegal transition ${previous} → ${next}`;
      return;
    }

    this.#status = next;
    for (const listener of this.#status_listeners) {
      listener(next, error === undefined ? { previous } : { previous, error });
    }
  }
}

