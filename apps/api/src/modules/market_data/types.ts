/**
 * The market-data domain model.
 *
 * Nothing in this file names a vendor. Adapters normalise whatever their
 * provider emits into these types, so the pricing engine, the realtime layer
 * and the database never learn where a quote came from beyond an opaque
 * `provider` string.
 */
import type { RatePerGram } from "../../platform/money.js";
import type { Purity } from "../pricing/purity.js";

export type MetalCode = "GOLD" | "SILVER";

export type CurrencyCode = "INR";

/** Where a quote ultimately originates. Mirrors the `market_source` enum. */
export type MarketSource = "ibja" | "spot" | "mcx" | "mock";

/** The unit a vendor quoted in, retained for traceability after normalisation. */
export type SourceQuoteUnit =
  | "per_gram"
  | "per_10_gram"
  | "per_kilogram"
  | "per_troy_ounce";

/**
 * A normalised market quote.
 *
 * `bid`, `ask` and `mid` are **integer milli-paise per gram** (ADR-0003). No
 * JavaScript number ever carries a monetary value here.
 *
 * `source_timestamp` and `received_at` are deliberately separate: the first is
 * the vendor's own stamp and is what customers are shown; the second is when we
 * saw it. Conflating them is how a system ends up presenting stale data as
 * live.
 */
export interface MarketQuote {
  /** Provider's own identifier for this quote, or one we synthesise. */
  readonly quote_id: string;
  /**
   * Provider sequence number where the feed supplies one, else `null`.
   * Used to order updates when timestamps tie or arrive out of order.
   */
  readonly sequence: number | null;

  /** Opaque provider identifier, e.g. "mock", "goldprice_dev". */
  readonly provider: string;
  readonly source: MarketSource;

  readonly symbol: string;
  readonly metal: MetalCode;
  readonly currency: CurrencyCode;
  /** Unit of `bid`/`ask`/`mid`. Always canonical. */
  readonly unit: "per_gram";
  /** What the vendor actually quoted, before normalisation. */
  readonly source_unit: SourceQuoteUnit;
  /** Reference fineness of the quote — IBJA quotes 999. */
  readonly purity: Purity;

  /** Nullable: not every source quotes two-way. */
  readonly bid: RatePerGram | null;
  readonly ask: RatePerGram | null;
  /** Always present. What the pricing engine consumes. */
  readonly mid: RatePerGram;

  /** The vendor's stamp. Shown to users. */
  readonly source_timestamp: Date;
  /** When this process received it. Never shown as "last updated". */
  readonly received_at: Date;
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/**
 * How current a quote is, derived from `source_timestamp` and the current time.
 *
 * Deliberately **not** a field on `MarketQuote`: freshness changes as time
 * passes without the quote changing at all. Storing it would let a stale value
 * be served with a `fresh` label baked in.
 */
export type Freshness = "fresh" | "stale" | "expired";

/** A quote paired with its freshness at a particular instant. */
export interface QuoteSnapshot {
  readonly quote: MarketQuote;
  readonly freshness: Freshness;
  /** Age against `source_timestamp`, in milliseconds. */
  readonly age_ms: number;
  /** When freshness was evaluated. */
  readonly evaluated_at: Date;
}

// ---------------------------------------------------------------------------
// Provider status
// ---------------------------------------------------------------------------

/**
 * Provider lifecycle state.
 *
 * `not_configured` and `configured` describe the deployment; the rest describe
 * a running connection. `stale` is a distinct state from `healthy`: the
 * connection is up but the data has aged past the freshness threshold, which is
 * a different operational problem from a dropped link.
 */
export type ProviderStatus =
  | "not_configured"
  | "configured"
  | "connecting"
  | "healthy"
  | "stale"
  | "disconnected"
  | "error";

/** Statuses from which a provider can still serve a last-known quote. */
export const SERVING_STATUSES: readonly ProviderStatus[] = [
  "healthy",
  "stale",
];

export interface ProviderHealth {
  readonly provider: string;
  readonly source: MarketSource;
  readonly status: ProviderStatus;
  /** True only for providers whose data must never reach production. */
  readonly is_simulated: boolean;
  readonly connected_since: Date | null;
  readonly last_quote_at: Date | null;
  /** Source timestamp of the most recent accepted quote. */
  readonly last_source_timestamp: Date | null;
  readonly consecutive_failures: number;
  readonly reconnect_attempts: number;
  readonly last_error: string | null;
  readonly evaluated_at: Date;
}

// ---------------------------------------------------------------------------
// Ingestion outcomes
// ---------------------------------------------------------------------------

/**
 * Why an incoming quote was not accepted.
 *
 * Every rejection is explicit and counted. A provider that silently drops
 * malformed quotes hides a broken feed.
 */
export type RejectionReason =
  | "invalid_schema"
  | "duplicate"
  | "out_of_order"
  | "implausible_move"
  | "unknown_symbol";

export type IngestResult =
  | { readonly outcome: "accepted"; readonly quote: MarketQuote }
  | {
      readonly outcome: "rejected";
      readonly reason: RejectionReason;
      readonly detail: string;
    };

// ---------------------------------------------------------------------------
// Base-rate resolution
// ---------------------------------------------------------------------------

/**
 * What the pricing layer receives when it asks for a market rate.
 *
 * A discriminated union rather than `MarketQuote | null`, so a caller cannot
 * accidentally treat "expired" as "fine" — the pricing layer must never invent
 * a rate when the feed has gone.
 */
export type BaseRateResolution =
  | { readonly available: true; readonly snapshot: QuoteSnapshot }
  | {
      readonly available: false;
      readonly reason: "no_quote" | "expired";
      readonly last_known: QuoteSnapshot | null;
    };
