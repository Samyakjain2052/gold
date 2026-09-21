/**
 * Money and exact integer arithmetic.
 *
 * ADR-0003: no floating point appears anywhere on a pricing path — not in
 * storage, not in transit, not in calculation.
 *
 * ## Canonical unit
 *
 * Rates are stored as **milli-paise per gram** (`RATE_SCALE` = 1000), not whole
 * paise per gram. The extra three digits are not decoration: Indian silver is
 * quoted per kilogram, and ₹236,908/kg is 23,690.8 paise per gram. Rounding
 * that to whole paise loses ₹8 per kilogram — material on a metal that trades
 * by the kilo. At milli-paise the value is exact.
 *
 * Every source unit this product accepts (per gram, per 10 g, per kg) converts
 * into milli-paise per gram exactly, with no rounding on the way in.
 *
 *   Gold   ₹153,727 / 10g  →  1_537_270_000 milli-paise/g
 *   Silver ₹236,908 / kg   →     23_690_800 milli-paise/g
 */

/** Integer paise. 100 paise = ₹1. Used for display-unit amounts. */
export type Paise = bigint;

/**
 * The canonical rate unit: integer milli-paise per gram.
 * Never render this directly — convert to a display unit first.
 */
export type RatePerGram = bigint;

export const PAISE_PER_RUPEE = 100n;

/** Sub-paise precision carried by every stored rate. */
export const RATE_SCALE = 1000n;

/** The unit a tenant chooses to quote a product in. */
export type DisplayUnit = "per_gram" | "per_10_gram" | "per_kilogram";

export const DISPLAY_UNIT_GRAMS: Readonly<Record<DisplayUnit, bigint>> = {
  per_gram: 1n,
  per_10_gram: 10n,
  per_kilogram: 1000n,
};

/**
 * How a value falling between two representable amounts is resolved.
 *
 * - `half_up`   — ties away from zero (₹0.5 → ₹1, −₹0.5 → −₹1). Retail default.
 * - `half_even` — ties to the even neighbour; removes `half_up`'s upward bias.
 * - `ceil`      — always toward +∞.
 * - `floor`     — always toward −∞.
 */
export type RoundingMode = "half_up" | "half_even" | "ceil" | "floor";

export const ROUNDING_MODES: readonly RoundingMode[] = [
  "half_up",
  "half_even",
  "ceil",
  "floor",
];

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

// ---------------------------------------------------------------------------
// Rounding — the only place in the codebase where a rounding decision is made
// ---------------------------------------------------------------------------

/**
 * Divide two integers and round according to `mode`.
 *
 * Bare `/` on bigints truncates toward zero, which silently biases every
 * negative adjustment, so pricing code must never divide directly.
 *
 * Correct for negative numerators and negative denominators.
 */
export function divide_and_round(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): bigint {
  if (denominator === 0n) {
    throw new MoneyError("division by zero");
  }

  // Normalise so the denominator is positive; the sign lives in the numerator.
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }

  const quotient = n / d; // truncates toward zero
  const remainder = n % d; // carries the sign of n

  if (remainder === 0n) return quotient;

  const is_negative = n < 0n;
  const away_from_zero = is_negative ? quotient - 1n : quotient + 1n;
  const doubled = abs(remainder) * 2n;

  switch (mode) {
    case "floor":
      return is_negative ? quotient - 1n : quotient;

    case "ceil":
      return is_negative ? quotient : quotient + 1n;

    case "half_up":
      return doubled >= d ? away_from_zero : quotient;

    case "half_even":
      if (doubled > d) return away_from_zero;
      if (doubled < d) return quotient;
      // Exactly half: pick the even neighbour.
      return quotient % 2n === 0n ? quotient : away_from_zero;
  }
}

/**
 * Round a value to a multiple of `step`, expressed in the same unit.
 * 100 paise rounds to the nearest ₹1; 1000 to the nearest ₹10.
 */
export function round_to_step(
  value: bigint,
  step: bigint,
  mode: RoundingMode,
): bigint {
  if (step <= 0n) {
    throw new MoneyError(`rounding step must be positive, received ${step}`);
  }
  if (step === 1n) return value;
  return divide_and_round(value, step, mode) * step;
}

/**
 * Round the exact rational `numerator / denominator` to a multiple of `step`.
 *
 * This is what lets the pricing pipeline defer every division to the end and
 * round **exactly once**. Rounding at each stage compounds error in a way that
 * is hard to reproduce and harder to justify to a jeweller.
 */
export function round_rational_to_step(
  numerator: bigint,
  denominator: bigint,
  step: bigint,
  mode: RoundingMode,
): bigint {
  if (step <= 0n) {
    throw new MoneyError(`rounding step must be positive, received ${step}`);
  }
  if (denominator === 0n) {
    throw new MoneyError("division by zero");
  }
  // value/step = numerator / (denominator × step); round, then rescale.
  return divide_and_round(numerator, denominator * step, mode) * step;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

// ---------------------------------------------------------------------------
// Exact rationals — calculation precision
// ---------------------------------------------------------------------------

/**
 * An unevaluated fraction, carried through the pricing pipeline so that no
 * intermediate value is ever rounded.
 *
 * This is the "calculation precision" tier: exact, unbounded, never stored and
 * never displayed. Values leave it only through an explicit rounding call.
 */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

export function rational(num: bigint, den: bigint = 1n): Rational {
  if (den === 0n) throw new MoneyError("rational denominator must not be zero");
  return { num, den };
}

export function add_rational(a: Rational, b: Rational): Rational {
  return { num: a.num * b.den + b.num * a.den, den: a.den * b.den };
}

/** Multiply a rational by an integer, keeping it exact. */
export function scale_rational(value: Rational, factor: bigint): Rational {
  return { num: value.num * factor, den: value.den };
}

// ---------------------------------------------------------------------------
// Constructors — named, so a bare number is never mistaken for a scaled rate
// ---------------------------------------------------------------------------

/**
 * Parse a rupee amount into paise.
 *
 * Strings are parsed digit-by-digit rather than through `parseFloat`, so no
 * value ever passes through a float.
 */
export function from_rupees(rupees: string | number | bigint): Paise {
  if (typeof rupees === "bigint") return rupees * PAISE_PER_RUPEE;

  if (typeof rupees === "number") {
    if (!Number.isInteger(rupees)) {
      throw new MoneyError(
        `from_rupees received the non-integer number ${rupees}; ` +
          'pass a string such as "9985.50" to preserve exactness',
      );
    }
    return BigInt(rupees) * PAISE_PER_RUPEE;
  }

  const normalised = rupees.trim().replace(/,/g, "");
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(normalised);
  if (!match) {
    throw new MoneyError(
      `"${rupees}" is not a rupee amount with at most 2 decimal places`,
    );
  }

  const [, sign, whole, fraction = ""] = match;
  const total =
    BigInt(whole as string) * PAISE_PER_RUPEE + BigInt(fraction.padEnd(2, "0"));
  return sign === "-" ? -total : total;
}

/** Build paise from an integer paise value. Rejects non-integers outright. */
export function from_paise(paise: number | bigint): Paise {
  if (typeof paise === "bigint") return paise;
  if (!Number.isInteger(paise)) {
    throw new MoneyError(`from_paise received the non-integer value ${paise}`);
  }
  return BigInt(paise);
}

/**
 * Convert a market quote into the canonical rate unit.
 *
 * Exact for every supported unit: multiplying by `RATE_SCALE` (1000) before
 * dividing by the grams in the unit (1, 10 or 1000) never leaves a remainder.
 *
 * @example
 * rate_from_rupees_per_unit("153727", "per_10_gram") // IBJA gold 999
 * rate_from_rupees_per_unit("236908", "per_kilogram") // IBJA silver 999
 */
export function rate_from_rupees_per_unit(
  rupees: string | number | bigint,
  unit: DisplayUnit,
): RatePerGram {
  const paise_per_unit = from_rupees(rupees);
  const grams = DISPLAY_UNIT_GRAMS[unit];
  const scaled = paise_per_unit * RATE_SCALE;

  if (scaled % grams !== 0n) {
    // Unreachable for the supported units; guards future additions.
    throw new MoneyError(
      `quote of ${rupees} per ${unit} cannot be represented exactly at RATE_SCALE=${RATE_SCALE}`,
    );
  }
  return scaled / grams;
}

/** Build a canonical rate directly from integer milli-paise per gram. */
export function rate_from_milli_paise(value: number | bigint): RatePerGram {
  if (typeof value === "bigint") return value;
  if (!Number.isInteger(value)) {
    throw new MoneyError(`rate_from_milli_paise received non-integer ${value}`);
  }
  return BigInt(value);
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Convert a canonical rate into paise of a display unit, rounding explicitly.
 *
 * Indian convention quotes gold per 10 g and silver per kg, but both are
 * *stored* per gram, so no calculation needs to know which unit a product uses.
 */
export function rate_to_display_paise(
  rate: RatePerGram,
  unit: DisplayUnit,
  mode: RoundingMode = "half_even",
): Paise {
  return divide_and_round(rate * DISPLAY_UNIT_GRAMS[unit], RATE_SCALE, mode);
}

/**
 * Convert an exact per-gram rational into paise of a display unit, quantised to
 * `precision_paise`.
 *
 * The single crossing point from calculation precision to display precision.
 * Everything above this line is exact; everything below it is a rounded number
 * fit to show a customer.
 */
export function rational_to_display_paise(
  value: Rational,
  unit: DisplayUnit,
  precision_paise: bigint,
  mode: RoundingMode,
): Paise {
  return round_rational_to_step(
    value.num * DISPLAY_UNIT_GRAMS[unit],
    value.den * RATE_SCALE,
    precision_paise,
    mode,
  );
}

/** Collapse an exact rational to storage precision (milli-paise per gram). */
export function rational_to_rate(value: Rational): RatePerGram {
  return divide_and_round(value.num, value.den, "half_even");
}

/**
 * Format paise as a rupee string with exactly two decimal places.
 * String arithmetic throughout, so large amounts cannot lose precision.
 */
export function to_rupees_string(paise: Paise, use_grouping = false): string {
  const negative = paise < 0n;
  const absolute = abs(paise);
  const whole = absolute / PAISE_PER_RUPEE;
  const fraction = absolute % PAISE_PER_RUPEE;

  const whole_text = use_grouping ? group_indian(whole) : whole.toString();
  return `${negative ? "-" : ""}${whole_text}.${fraction.toString().padStart(2, "0")}`;
}

/**
 * Group digits in the Indian numbering system: last three, then pairs.
 * 15372700 → "1,53,72,700".
 */
function group_indian(value: bigint): string {
  const digits = value.toString();
  if (digits.length <= 3) return digits;

  const last_three = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last_three}`;
}
