/**
 * Prints worked pricing examples straight from the engine.
 *
 * Run: npm run pricing:examples
 *
 * Every number in docs/pricing-examples.md is this script's output, so the
 * documentation cannot drift away from the implementation.
 *
 * Each example shows the three precision tiers of ADR-0005 separately:
 * calculation/storage (raw), the configured adjustment, and display.
 */
import {
  rate_from_rupees_per_unit,
  to_rupees_string,
  RATE_SCALE,
  DISPLAY_UNIT_GRAMS,
  type DisplayUnit,
  type RoundingMode,
} from "../src/platform/money.js";
import {
  absolute_rupees_per_gram,
  percentage,
  NO_ADJUSTMENT,
  type Adjustment,
} from "../src/modules/pricing/adjustment.js";
import { PURITY, type Purity, type PurityBasis } from "../src/modules/pricing/purity.js";
import {
  compute_customer_rate,
  type PricingResult,
} from "../src/modules/pricing/pricing_engine.js";

// IBJA published rates, PM session, 18/09/2026.
const GOLD_999 = rate_from_rupees_per_unit("153727", "per_10_gram");
const SILVER_999 = rate_from_rupees_per_unit("236908", "per_kilogram");

interface Example {
  readonly title: string;
  readonly base_rate: bigint;
  readonly base_label: string;
  readonly target_purity: Purity;
  readonly purity_basis: PurityBasis;
  readonly adjustment: Adjustment;
  readonly adjustment_label: string;
  readonly display_unit: DisplayUnit;
  readonly rounding_step_paise: bigint;
  readonly rounding_mode: RoundingMode;
}

const EXAMPLES: readonly Example[] = [
  {
    title: "Gold 999 — no adjustment (reset to market)",
    base_rate: GOLD_999,
    base_label: "IBJA 999 ₹153,727/10g",
    target_purity: PURITY.FINE_999,
    purity_basis: "fine_ratio",
    adjustment: NO_ADJUSTMENT,
    adjustment_label: "none",
    display_unit: "per_10_gram",
    rounding_step_paise: 100n,
    rounding_mode: "half_up",
  },
  {
    title: "Gold 999 — fixed ₹50/g (Sharma Jewellers)",
    base_rate: GOLD_999,
    base_label: "IBJA 999 ₹153,727/10g",
    target_purity: PURITY.FINE_999,
    purity_basis: "fine_ratio",
    adjustment: absolute_rupees_per_gram(50),
    adjustment_label: "+₹50/g configured",
    display_unit: "per_10_gram",
    rounding_step_paise: 100n,
    rounding_mode: "half_up",
  },
  {
    title: "Gold 916 (22K) — fixed ₹50/g, display precision 2 decimals",
    base_rate: GOLD_999,
    base_label: "IBJA 999 ₹153,727/10g",
    target_purity: PURITY.GOLD_916,
    purity_basis: "market_convention",
    adjustment: absolute_rupees_per_gram(50),
    adjustment_label: "+₹50/g configured",
    display_unit: "per_10_gram",
    rounding_step_paise: 1n,
    rounding_mode: "half_up",
  },
  {
    title: "Gold 916 (22K) — fixed ₹50/g, display precision 0 decimals",
    base_rate: GOLD_999,
    base_label: "IBJA 999 ₹153,727/10g",
    target_purity: PURITY.GOLD_916,
    purity_basis: "market_convention",
    adjustment: absolute_rupees_per_gram(50),
    adjustment_label: "+₹50/g configured",
    display_unit: "per_10_gram",
    rounding_step_paise: 100n,
    rounding_mode: "half_up",
  },
  {
    title: "Gold 916 (22K) — percentage 3%, nearest ₹10",
    base_rate: GOLD_999,
    base_label: "IBJA 999 ₹153,727/10g",
    target_purity: PURITY.GOLD_916,
    purity_basis: "market_convention",
    adjustment: percentage(3),
    adjustment_label: "+3% (300 bps)",
    display_unit: "per_10_gram",
    rounding_step_paise: 1000n,
    rounding_mode: "half_up",
  },
  {
    title: "Silver 999 — fixed ₹2/g (Sharma Jewellers)",
    base_rate: SILVER_999,
    base_label: "IBJA 999 ₹236,908/kg",
    target_purity: PURITY.FINE_999,
    purity_basis: "fine_ratio",
    adjustment: absolute_rupees_per_gram(2),
    adjustment_label: "+₹2/g configured",
    display_unit: "per_kilogram",
    rounding_step_paise: 100n,
    rounding_mode: "half_up",
  },
  {
    title: "Silver 999 — discount ₹1/g (Gupta Jewellers)",
    base_rate: SILVER_999,
    base_label: "IBJA 999 ₹236,908/kg",
    target_purity: PURITY.FINE_999,
    purity_basis: "fine_ratio",
    adjustment: absolute_rupees_per_gram("-1"),
    adjustment_label: "−₹1/g configured",
    display_unit: "per_kilogram",
    rounding_step_paise: 100n,
    rounding_mode: "half_up",
  },
];

const UNIT_LABEL: Record<DisplayUnit, string> = {
  per_gram: "per gram",
  per_10_gram: "per 10 g",
  per_kilogram: "per kg",
};

/** Sign before the currency symbol: −₹1,000.00, not ₹-1,000.00. */
function rupees(paise: bigint): string {
  const negative = paise < 0n;
  return `${negative ? "−" : ""}₹${to_rupees_string(negative ? -paise : paise, true)}`;
}

/**
 * Render a storage-precision rate (milli-paise per gram) in the display unit,
 * keeping all three sub-paise digits so the raw tier is visibly distinct from
 * the rounded display tier.
 */
function raw_rupees(rate: bigint, unit: DisplayUnit): string {
  const grams = DISPLAY_UNIT_GRAMS[unit];
  const negative = rate < 0n;
  const scaled = (negative ? -rate : rate) * grams; // milli-paise of the unit
  const paise = scaled / RATE_SCALE;
  const milli = scaled % RATE_SCALE;
  const whole = to_rupees_string(paise, true);
  return `${negative ? "−" : ""}₹${whole}${milli.toString().padStart(3, "0")}`;
}

function precision_label(step: bigint): string {
  if (step === 1n) return "2 decimals (paise)";
  if (step === 100n) return "0 decimals (nearest ₹1)";
  return `nearest ₹${Number(step) / 100}`;
}

function print_example(example: Example): void {
  const result: PricingResult = compute_customer_rate({
    base_rate: example.base_rate,
    base_purity: PURITY.FINE_999,
    target_purity: example.target_purity,
    purity_basis: example.purity_basis,
    adjustment: example.adjustment,
    display_unit: example.display_unit,
    rounding_step_paise: example.rounding_step_paise,
    rounding_mode: example.rounding_mode,
  });

  const unit = UNIT_LABEL[example.display_unit];
  const w = (label: string) => label.padEnd(24);

  process.stdout.write(`\n${example.title}\n`);
  process.stdout.write(`${"─".repeat(example.title.length)}\n`);
  process.stdout.write(`  ${w("Feed")}${example.base_label}\n`);
  process.stdout.write(
    `  ${w("Target purity")}${example.target_purity.num}/${example.target_purity.den} (${example.purity_basis})\n`,
  );
  process.stdout.write(
    `  ${w("Configured adjustment")}${example.adjustment_label}\n`,
  );
  process.stdout.write(
    `  ${w("Display precision")}${precision_label(example.rounding_step_paise)}, ${example.rounding_mode}\n`,
  );

  process.stdout.write(`\n  RAW (calculation/storage precision, ${unit})\n`);
  process.stdout.write(
    `  ${w("  raw base rate")}${raw_rupees(result.raw_base_rate, example.display_unit)}\n`,
  );
  process.stdout.write(
    `  ${w("  raw adjustment")}${raw_rupees(result.raw_adjustment, example.display_unit)}\n`,
  );
  process.stdout.write(
    `  ${w("  raw customer rate")}${raw_rupees(result.raw_customer_rate, example.display_unit)}\n`,
  );

  process.stdout.write(`\n  DISPLAYED BREAKDOWN (${unit})\n`);
  process.stdout.write(
    `  ${w("  market rate")}${rupees(result.base_display_paise)}\n`,
  );
  process.stdout.write(
    `  ${w("  shop adjustment")}${rupees(result.adjustment_display_paise)}\n`,
  );
  process.stdout.write(
    `  ${w("  rounding")}${rupees(result.rounding_delta_paise)}\n`,
  );
  process.stdout.write(
    `  ${w("  CUSTOMER RATE")}${rupees(result.rate_display_paise)}\n`,
  );
}

function print_adjustment_invariant(): void {
  process.stdout.write(
    "\n\nA configured +₹50/g stays +₹50/g under every rounding rule\n",
  );
  process.stdout.write(
    "───────────────────────────────────────────────────────────\n",
  );
  process.stdout.write(
    "  Gold 22K (916). The adjustment column never moves; rounding absorbs the\n" +
      "  difference and is reported on its own line.\n\n",
  );
  process.stdout.write(
    "  precision        mode        market rate    adjustment    rounding   customer rate\n",
  );
  process.stdout.write(
    "  ───────────────  ──────────  ─────────────  ────────────  ─────────  ─────────────\n",
  );

  const steps: ReadonlyArray<[string, bigint]> = [
    ["2 decimals", 1n],
    ["nearest ₹1", 100n],
    ["nearest ₹10", 1000n],
    ["nearest ₹100", 10000n],
  ];

  for (const [label, step] of steps) {
    for (const mode of ["half_up", "half_even"] as const) {
      const result = compute_customer_rate({
        base_rate: GOLD_999,
        base_purity: PURITY.FINE_999,
        target_purity: PURITY.GOLD_916,
        purity_basis: "market_convention",
        adjustment: absolute_rupees_per_gram(50),
        display_unit: "per_10_gram",
        rounding_step_paise: step,
        rounding_mode: mode,
      });
      process.stdout.write(
        `  ${label.padEnd(17)}${mode.padEnd(12)}` +
          `${rupees(result.base_display_paise).padStart(13)}  ` +
          `${rupees(result.adjustment_display_paise).padStart(12)}  ` +
          `${rupees(result.rounding_delta_paise).padStart(9)}  ` +
          `${rupees(result.rate_display_paise).padStart(13)}\n`,
      );
    }
  }
}

function print_rounding_modes(): void {
  process.stdout.write("\n\nRounding modes at an exact half step\n");
  process.stdout.write("────────────────────────────────────\n");
  process.stdout.write(
    "  Base ₹10,000.50/g, nearest ₹1 — the only case where the modes disagree\n\n",
  );

  for (const mode of ["half_up", "half_even", "ceil", "floor"] as const) {
    const result = compute_customer_rate({
      base_rate: 1_000_050_000n,
      base_purity: PURITY.FINE_999,
      target_purity: PURITY.FINE_999,
      purity_basis: "fine_ratio",
      adjustment: NO_ADJUSTMENT,
      display_unit: "per_gram",
      rounding_step_paise: 100n,
      rounding_mode: mode,
    });
    process.stdout.write(
      `  ${mode.padEnd(10)} → ${rupees(result.rate_display_paise)} per gram\n`,
    );
  }
}

function print_ordering_proof(): void {
  const correct = compute_customer_rate({
    base_rate: GOLD_999,
    base_purity: PURITY.FINE_999,
    target_purity: PURITY.GOLD_916,
    purity_basis: "market_convention",
    adjustment: absolute_rupees_per_gram(50),
    display_unit: "per_10_gram",
    rounding_step_paise: 100n,
    rounding_mode: "half_up",
  });

  // What the WRONG order produces: margin added to the 999 rate, then converted.
  const inverted = compute_customer_rate({
    base_rate: GOLD_999 + 5_000_000n,
    base_purity: PURITY.FINE_999,
    target_purity: PURITY.GOLD_916,
    purity_basis: "market_convention",
    adjustment: NO_ADJUSTMENT,
    display_unit: "per_10_gram",
    rounding_step_paise: 100n,
    rounding_mode: "half_up",
  });

  const shortfall = correct.rate_display_paise - inverted.rate_display_paise;

  process.stdout.write("\n\nWhy purity conversion must precede the adjustment\n");
  process.stdout.write("─────────────────────────────────────────────────\n");
  process.stdout.write("  Gold 22K (916), +₹50/g margin\n\n");
  process.stdout.write(
    `  purity → adjustment (correct)   ${rupees(correct.rate_display_paise)} per 10 g\n`,
  );
  process.stdout.write(
    `  adjustment → purity (wrong)     ${rupees(inverted.rate_display_paise)} per 10 g\n`,
  );
  process.stdout.write(
    `  Shortfall if inverted           ${rupees(shortfall)} per 10 g ` +
      `(the ₹50 margin becomes ${rupees((5_000_000n * 916n) / 1000n / 1000n)}/g)\n`,
  );
}

process.stdout.write("Pricing engine — worked examples\n");
process.stdout.write("================================\n");
process.stdout.write(
  "Base rates: IBJA published PM session, 18/09/2026.\n" +
    "All figures produced by src/modules/pricing/pricing_engine.ts.\n" +
    "Precision tiers and breakdown policy: ADR-0005.\n",
);

for (const example of EXAMPLES) {
  print_example(example);
}

print_adjustment_invariant();
print_rounding_modes();
print_ordering_proof();
process.stdout.write("\n");
