/**
 * Rate rendering, including the states a customer most needs told apart.
 *
 * The recurring assertion here is that the card shows what the server sent and
 * nothing it worked out for itself — in particular that the shop's adjustment
 * is the authored figure, not `rate - market_rate`.
 */
import { describe, expect, test } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { PublicRate } from "@bullion/contracts";
import { RateCard } from "@/components/RateCard";

function rate(overrides: Partial<PublicRate> = {}): PublicRate {
  return {
    product_key: "GOLD_916",
    label: "Gold 22K",
    metal: "GOLD",
    display_unit: "per_gram",
    rate: "1408139",
    market_rate: null,
    shop_adjustment: null,
    rounding: null,
    source_timestamp: "2026-09-20T12:00:00.000Z",
    freshness: "fresh",
    ...overrides,
  };
}

describe("rate rendering", () => {
  test("RateCard_showsLabelAndAuthoritativeRate", () => {
    render(<RateCard rate={rate()} />);

    expect(screen.getByRole("heading", { name: "Gold 22K" })).toBeInTheDocument();
    expect(screen.getByText("₹14,081.39")).toBeInTheDocument();
    expect(screen.getByText("per gram")).toBeInTheDocument();
  });

  test("RateCard_missingLabel_fallsBackToProductKey", () => {
    render(<RateCard rate={rate({ label: "" })} />);
    expect(screen.getByRole("heading", { name: "Gold 916" })).toBeInTheDocument();
  });

  test("RateCard_withoutDisclosure_showsNoBreakdown", () => {
    render(<RateCard rate={rate()} />);

    expect(screen.queryByText("Market rate")).not.toBeInTheDocument();
    expect(screen.queryByText("Shop adjustment")).not.toBeInTheDocument();
  });
});

describe("breakdown", () => {
  /**
   * The central pricing invariant, on screen.
   *
   * market 1,403,139 + adjustment 5,000 = 1,408,139, and the card must print
   * the authored +₹50.00 rather than anything it derived.
   */
  test("RateCard_showsAuthoredAdjustment_notADerivedOne", () => {
    render(
      <RateCard
        rate={rate({
          rate: "1408139",
          market_rate: "1403139",
          shop_adjustment: "5000",
          rounding: "0",
        })}
      />,
    );

    expect(screen.getByText("₹14,031.39")).toBeInTheDocument();
    expect(screen.getByText("+₹50.00")).toBeInTheDocument();
  });

  /**
   * The case ADR-0005 exists for: rounding makes the components not sum to the
   * total. The adjustment must still read as the configured ₹50.00, and the
   * difference must appear on its own line rather than being folded in.
   */
  test("RateCard_whenRoundingMovesTheTotal_adjustmentIsStillTheConfiguredValue", () => {
    render(
      <RateCard
        rate={rate({
          rate: "1408200",
          market_rate: "1403139",
          shop_adjustment: "5000",
          rounding: "61",
        })}
      />,
    );

    // Not +₹50.61, which is what rate - market_rate would have produced.
    expect(screen.getByText("+₹50.00")).toBeInTheDocument();
    expect(screen.queryByText("+₹50.61")).not.toBeInTheDocument();
    expect(screen.getByText("Rounding")).toBeInTheDocument();
    expect(screen.getByText("+₹0.61")).toBeInTheDocument();
  });

  test("RateCard_zeroRounding_omitsTheRoundingLine", () => {
    render(
      <RateCard
        rate={rate({ market_rate: "1403139", shop_adjustment: "5000", rounding: "0" })}
      />,
    );
    expect(screen.queryByText("Rounding")).not.toBeInTheDocument();
  });

  test("RateCard_negativeAdjustment_readsAsADiscount", () => {
    render(
      <RateCard
        rate={rate({ market_rate: "1403139", shop_adjustment: "-2500", rounding: "0" })}
      />,
    );
    expect(screen.getByText("−₹25.00")).toBeInTheDocument();
  });
});

describe("freshness states", () => {
  test("RateCard_fresh_isLabelledLive", () => {
    render(<RateCard rate={rate({ freshness: "fresh" })} />);
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  test("RateCard_stale_saysDelayedInWords", () => {
    render(<RateCard rate={rate({ freshness: "stale" })} />);

    expect(screen.getByText("Delayed")).toBeInTheDocument();
    expect(screen.getByText(/has not updated recently/i)).toBeInTheDocument();
  });

  /** An expired rate must not be presented as a usable price. */
  test("RateCard_expired_warnsAgainstRelyingOnIt", () => {
    render(<RateCard rate={rate({ freshness: "expired" })} />);

    expect(screen.getByText("Out of date")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/too old to rely on/i);
  });

  /**
   * State is never carried by colour alone: each badge has a distinct word, so
   * the three are distinguishable in monochrome and to a screen reader.
   */
  test("FreshnessBadge_everyState_carriesItsOwnText", () => {
    const labels = (["fresh", "stale", "expired"] as const).map((freshness) => {
      const { container, unmount } = render(<RateCard rate={rate({ freshness })} />);
      const badge = container.querySelector("[data-freshness]");
      const text = badge?.textContent ?? "";
      unmount();
      return text;
    });

    expect(new Set(labels).size).toBe(3);
    for (const label of labels) expect(label.trim()).not.toBe("");
  });
});

describe("timestamps", () => {
  test("RateCard_rendersMachineReadableTime", () => {
    render(<RateCard rate={rate()} />);
    const time = screen.getByText(/Updated/).querySelector("time");
    expect(time).toHaveAttribute("dateTime", "2026-09-20T12:00:00.000Z");
  });

  test("RateCard_malformedTimestamp_doesNotRenderInvalidDate", () => {
    render(<RateCard rate={rate({ source_timestamp: "not-a-date" })} />);

    const footer = screen.getByText(/Updated/);
    expect(within(footer).getByText(/unknown time/i)).toBeInTheDocument();
    expect(footer.textContent).not.toMatch(/Invalid Date/);
  });
});
