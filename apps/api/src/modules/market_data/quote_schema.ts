/**
 * Validation of raw provider payloads.
 *
 * `api-standards.md` §9: "External responses must be schema validated before
 * use." A vendor emitting `null`, `0`, a string where a number belongs, or a
 * decimal-shifted price is not hypothetical — and any of those reaching the
 * pricing engine becomes a wrong price on a jeweller's board.
 *
 * Money is parsed through the `money` module's string parser, never through
 * `parseFloat`, so no monetary value passes through a float.
 */
import { z } from "zod";
import {
  rate_from_rupees_per_unit,
  MoneyError,
  type RatePerGram,
} from "../../platform/money.js";
import type { MarketQuote, SourceQuoteUnit } from "./types.js";

/** Troy ounce in grams, exact to the definition (31.1034768 g). */
const GRAMS_PER_TROY_OUNCE_MICRO = 31_103_476_8n; // ×10^7

const metal_schema = z.enum(["GOLD", "SILVER"]);
const source_schema = z.enum(["ibja", "spot", "mcx", "mock"]);
const currency_schema = z.literal("INR");
const source_unit_schema = z.enum([
  "per_gram",
  "per_10_gram",
  "per_kilogram",
  "per_troy_ounce",
]);

/**
 * A decimal money string. Deliberately a string, not a number: JSON numbers
 * are IEEE-754 doubles and a large rupee-per-kg value can already have lost
 * precision by the time it reaches us.
 */
const money_string = z
  .string()
  .regex(/^-?\d+(\.\d{1,6})?$/, "expected a decimal amount");

/**
 * The wire shape a provider adapter must produce before normalisation.
 * Adapters translate vendor-specific JSON into this; this schema is the gate.
 */
export const raw_quote_schema = z.object({
  quote_id: z.string().min(1).max(200).optional(),
  sequence: z.number().int().nonnegative().optional(),
  provider: z.string().min(1).max(64),
  source: source_schema,
  symbol: z.string().min(1).max(64),
  metal: metal_schema,
  currency: currency_schema,
  source_unit: source_unit_schema,
  purity_num: z.number().int().positive(),
  purity_den: z.number().int().positive(),
  bid: money_string.nullable().optional(),
  ask: money_string.nullable().optional(),
  mid: money_string,
  /** ISO 8601. The vendor's own stamp. */
  source_timestamp: z.iso.datetime({ offset: true }),
});

export type RawQuote = z.infer<typeof raw_quote_schema>;

export class QuoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteValidationError";
  }
}

/**
 * Convert a vendor amount into canonical milli-paise per gram.
 *
 * Troy ounces are handled separately: 31.1034768 g does not divide evenly, so
 * the conversion is done in scaled integer arithmetic and rounded once, rather
 * than via a float.
 */
function to_rate_per_gram(
  amount: string,
  unit: SourceQuoteUnit,
): RatePerGram {
  if (unit === "per_troy_ounce") {
    // rupees/oz → milli-paise/g, keeping the division exact until the end.
    const per_ounce = rate_from_rupees_per_unit(amount, "per_gram"); // scaled, not yet per-gram
    return (per_ounce * 10_000_000n) / GRAMS_PER_TROY_OUNCE_MICRO;
  }
  return rate_from_rupees_per_unit(amount, unit);
}

/**
 * Validate and normalise a raw payload into a `MarketQuote`.
 *
 * @throws {QuoteValidationError} with a description safe to log — it never
 * echoes the raw payload, which could carry provider credentials.
 */
export function parse_quote(payload: unknown, received_at: Date): MarketQuote {
  const parsed = raw_quote_schema.safeParse(payload);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new QuoteValidationError(`quote failed validation — ${problems}`);
  }

  const raw = parsed.data;

  if (raw.purity_num > raw.purity_den) {
    throw new QuoteValidationError(
      `purity ${raw.purity_num}/${raw.purity_den} exceeds 100% fine`,
    );
  }

  let mid: RatePerGram;
  let bid: RatePerGram | null = null;
  let ask: RatePerGram | null = null;

  try {
    mid = to_rate_per_gram(raw.mid, raw.source_unit);
    if (raw.bid != null) bid = to_rate_per_gram(raw.bid, raw.source_unit);
    if (raw.ask != null) ask = to_rate_per_gram(raw.ask, raw.source_unit);
  } catch (error) {
    throw new QuoteValidationError(
      `quote amount could not be converted — ${
        error instanceof MoneyError ? error.message : "unknown conversion failure"
      }`,
    );
  }

  if (mid <= 0n) {
    throw new QuoteValidationError(`mid price must be positive, received ${raw.mid}`);
  }
  if (bid !== null && ask !== null && bid > ask) {
    throw new QuoteValidationError(
      `crossed quote: bid ${raw.bid} exceeds ask ${raw.ask}`,
    );
  }

  const source_timestamp = new Date(raw.source_timestamp);
  if (Number.isNaN(source_timestamp.getTime())) {
    throw new QuoteValidationError("source_timestamp is not a valid instant");
  }

  return {
    quote_id: raw.quote_id ?? `${raw.provider}:${raw.symbol}:${raw.source_timestamp}`,
    sequence: raw.sequence ?? null,
    provider: raw.provider,
    source: raw.source,
    symbol: raw.symbol,
    metal: raw.metal,
    currency: raw.currency,
    unit: "per_gram",
    source_unit: raw.source_unit,
    purity: { num: raw.purity_num, den: raw.purity_den },
    bid,
    ask,
    mid,
    source_timestamp,
    received_at,
  };
}
