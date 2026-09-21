/**
 * Display formatting for server-computed money. **No arithmetic on prices.**
 *
 * The API sends integer paise as strings, and everything here is a rendering
 * concern: splitting an integer at the last two digits and grouping the rest in
 * the Indian system. Nothing in this file adds, subtracts, scales or rounds a
 * price.
 *
 * In particular there is no function that derives the shop's adjustment from
 * `rate - market_rate`. `shop_adjustment` arrives from the server as the
 * authored value; recomputing it in the browser is exactly the defect ADR-0005
 * was written to prevent, and it would be invisible — the number would look
 * plausible and be wrong by the rounding delta.
 *
 * ## Why not `Number`
 *
 * ₹236,908/kg is 23,690,800 milli-paise per gram. These integers are already
 * large and will grow with the unit; routing them through a float to insert a
 * decimal point would undo the exact-money design at the last step, for
 * cosmetics. Everything below is string and `BigInt` work.
 */

/** A paise amount that could not be parsed renders as this, never as ₹0.00. */
export const UNAVAILABLE = "—";

/**
 * Split an integer-paise string into rupees and the two-digit paise remainder.
 *
 * Returns null for anything that is not an optionally-signed run of digits, so
 * a malformed or absent value can be rendered as "unavailable" rather than as a
 * confident zero.
 */
export function split_paise(paise: string | null | undefined): {
  negative: boolean;
  rupees: string;
  paise: string;
} | null {
  if (typeof paise !== "string") return null;

  const trimmed = paise.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;

  const negative = trimmed.startsWith("-");
  const digits = negative ? trimmed.slice(1) : trimmed;

  // Pad so a value under ₹1 still has two paise digits to slice off.
  const padded = digits.padStart(3, "0");
  return {
    negative,
    rupees: padded.slice(0, -2).replace(/^0+(?=\d)/, ""),
    paise: padded.slice(-2),
  };
}

/**
 * Group digits in the Indian system: last three, then pairs.
 *
 * `Intl.NumberFormat("en-IN")` would do this, but it takes a `number`, which is
 * the one type these values must not pass through.
 */
export function group_indian(whole: string): string {
  if (whole.length <= 3) return whole;

  const last_three = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last_three}`;
}

/**
 * Render integer paise as rupees, without a currency symbol.
 *
 * `"14081393"` → `"1,40,813.93"`.
 */
export function format_paise(paise: string | null | undefined): string {
  const parts = split_paise(paise);
  if (parts === null) return UNAVAILABLE;

  const sign = parts.negative ? "-" : "";
  return `${sign}${group_indian(parts.rupees)}.${parts.paise}`;
}

/** Render integer paise with the rupee sign. `"14081393"` → `"₹1,40,813.93"`. */
export function format_rupees(paise: string | null | undefined): string {
  const formatted = format_paise(paise);
  return formatted === UNAVAILABLE ? UNAVAILABLE : `₹${formatted}`;
}

/**
 * Signed form for the shop's adjustment, so `+` is explicit.
 *
 * A shop charging ₹50/g over market should read `+₹50.00`, not `₹50.00`, which
 * could be misread as the rate itself.
 */
export function format_adjustment(paise: string | null | undefined): string {
  const parts = split_paise(paise);
  if (parts === null) return UNAVAILABLE;

  const is_zero = /^0*$/.test(parts.rupees) && parts.paise === "00";
  const sign = parts.negative ? "−" : is_zero ? "" : "+";
  return `${sign}₹${group_indian(parts.rupees)}.${parts.paise}`;
}

/** `GOLD_916` → `Gold 916`, used only where the API sends no label. */
export function humanise_product_key(key: string): string {
  const [metal, purity] = key.split("_");
  if (metal === undefined) return key;
  const title = metal.charAt(0) + metal.slice(1).toLowerCase();
  return purity === undefined ? title : `${title} ${purity}`;
}

/**
 * Render the `display_unit` enum as a caption.
 *
 * The API sends `per_gram`, `per_10_gram` or `per_kilogram` — the preposition
 * is already part of the value, so prefixing "per" produced "per per_10_gram"
 * on the live page. An unrecognised value has its underscores opened up rather
 * than being dropped, so a unit added to the enum later degrades to something
 * readable instead of disappearing.
 */
const UNIT_CAPTIONS: Readonly<Record<string, string>> = {
  per_gram: "per gram",
  per_10_gram: "per 10 grams",
  per_kilogram: "per kilogram",
};

export function format_unit(display_unit: string): string {
  return UNIT_CAPTIONS[display_unit] ?? display_unit.replace(/_/g, " ");
}
