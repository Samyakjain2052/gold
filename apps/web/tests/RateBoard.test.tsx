/**
 * Rate rendering on the board, including the states a customer most needs told
 * apart.
 *
 * The recurring assertion here is that the card shows what the server sent and
 * nothing it worked out for itself — in particular that the shop's adjustment
 * is the authored figure, not `rate - market_rate`.
 */
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PublicRate } from "@bullion/contracts";
import userEvent from "@testing-library/user-event";
import { RateBoard } from "@/components/RateBoard";

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

/**
 * Render one rate and open its breakdown.
 *
 * The board keeps the breakdown behind a disclosure so several products fit on
 * a phone at once. The shop's decision to publish it is unchanged: no toggle is
 * rendered at all when `market_rate` is null.
 */
async function open_breakdown(rate_row: PublicRate) {
  const user = userEvent.setup();
  render(<RateBoard rates={[rate_row]} />);
  await user.click(screen.getByRole("button", { name: /show breakdown/i }));
}

describe("rate rendering", () => {
  test("RateBoard_showsLabelAndAuthoritativeRate", () => {
    render(<RateBoard rates={[rate()]} />);

    // The product is the row's header cell, not a heading.
    expect(screen.getByRole("rowheader", { name: /Gold 22K/ })).toBeInTheDocument();
    expect(screen.getByText("₹14,081.39")).toBeInTheDocument();
    expect(screen.getByText("per gram")).toBeInTheDocument();
  });

  test("RateBoard_missingLabel_fallsBackToProductKey", () => {
    render(<RateBoard rates={[rate({ label: "" })]} />);
    expect(screen.getByRole("rowheader", { name: /Gold 916/ })).toBeInTheDocument();
  });

  test("RateBoard_withoutDisclosure_showsNoBreakdown", () => {
    render(<RateBoard rates={[rate()]} />);

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
  test("RateBoard_showsAuthoredAdjustment_notADerivedOne", async () => {
    await open_breakdown(
      rate({
        rate: "1408139",
        market_rate: "1403139",
        shop_adjustment: "5000",
        rounding: "0",
      }),
    );

    expect(screen.getByText("₹14,031.39")).toBeInTheDocument();
    expect(screen.getByText("+₹50.00")).toBeInTheDocument();
  });

  /**
   * The case ADR-0005 exists for: rounding makes the components not sum to the
   * total. The adjustment must still read as the configured ₹50.00, and the
   * difference must appear on its own line rather than being folded in.
   */
  test("RateBoard_whenRoundingMovesTheTotal_adjustmentIsStillTheConfiguredValue", async () => {
    await open_breakdown(
      rate({
        rate: "1408200",
        market_rate: "1403139",
        shop_adjustment: "5000",
        rounding: "61",
      }),
    );

    // Not +₹50.61, which is what rate - market_rate would have produced.
    expect(screen.getByText("+₹50.00")).toBeInTheDocument();
    expect(screen.queryByText("+₹50.61")).not.toBeInTheDocument();
    expect(screen.getByText("Rounding")).toBeInTheDocument();
    expect(screen.getByText("+₹0.61")).toBeInTheDocument();
  });

  test("RateBoard_zeroRounding_omitsTheRoundingLine", async () => {
    await open_breakdown(
      rate({ market_rate: "1403139", shop_adjustment: "5000", rounding: "0" }),
    );
    expect(screen.queryByText("Rounding")).not.toBeInTheDocument();
  });

  test("RateBoard_negativeAdjustment_readsAsADiscount", async () => {
    await open_breakdown(
      rate({ market_rate: "1403139", shop_adjustment: "-2500", rounding: "0" }),
    );
    expect(screen.getByText("−₹25.00")).toBeInTheDocument();
  });
});

describe("freshness states", () => {
  test("RateBoard_fresh_isLabelledLive", () => {
    render(<RateBoard rates={[rate({ freshness: "fresh" })]} />);
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  test("RateBoard_stale_saysDelayedInWords", () => {
    render(<RateBoard rates={[rate({ freshness: "stale" })]} />);

    expect(screen.getByText("Delayed")).toBeInTheDocument();
    expect(screen.getByText(/has not updated recently/i)).toBeInTheDocument();
  });

  /** An expired rate must not be presented as a usable price. */
  test("RateBoard_expired_warnsAgainstRelyingOnIt", () => {
    render(<RateBoard rates={[rate({ freshness: "expired" })]} />);

    expect(screen.getByText("Out of date")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/too old to rely on/i);
  });

  /**
   * State is never carried by colour alone: each badge has a distinct word, so
   * the three are distinguishable in monochrome and to a screen reader.
   */
  test("FreshnessBadge_everyState_carriesItsOwnText", () => {
    const labels = (["fresh", "stale", "expired"] as const).map((freshness) => {
      const { container, unmount } = render(<RateBoard rates={[rate({ freshness })]} />);
      const badge = container.querySelector("[data-freshness]");
      const text = badge?.textContent ?? "";
      unmount();
      return text;
    });

    expect(new Set(labels).size).toBe(3);
    for (const label of labels) expect(label.trim()).not.toBe("");
  });
});

describe("the breakdown is the shop's choice", () => {
  test("RateBoard_withoutDisclosure_offersNoToggle", () => {
    render(<RateBoard rates={[rate()]} />);
    expect(screen.queryByRole("button", { name: /breakdown/i })).not.toBeInTheDocument();
  });

  test("RateBoard_withDisclosure_hidesComponentsUntilAsked", () => {
    render(
      <RateBoard
        rates={[rate({ market_rate: "1403139", shop_adjustment: "5000", rounding: "0" })]}
      />,
    );

    expect(screen.queryByText("Market rate")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show breakdown/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  test("RateBoard_toggle_isReversible", async () => {
    const user = userEvent.setup();
    render(
      <RateBoard
        rates={[rate({ market_rate: "1403139", shop_adjustment: "5000", rounding: "0" })]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /show breakdown/i }));
    expect(screen.getByText("Market rate")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /hide breakdown/i }));
    expect(screen.queryByText("Market rate")).not.toBeInTheDocument();
  });
});

describe("board semantics", () => {
  /** Real table markup, so the relationship is announced, not just drawn. */
  test("RateBoard_isATableWithProductAndRateHeaders", () => {
    render(<RateBoard rates={[rate()]} />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /product/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /sell/i })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: /Gold 22K/ })).toBeInTheDocument();
  });

  test("RateBoard_rendersEveryProductAsItsOwnRow", () => {
    render(
      <RateBoard
        rates={[
          rate(),
          rate({ product_key: "SILVER_999", label: "Silver", rate: "2369080" }),
        ]}
      />,
    );

    // One header row plus two product rows.
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("₹14,081.39")).toBeInTheDocument();
    expect(screen.getByText("₹23,690.80")).toBeInTheDocument();
  });

  test("RateBoard_showsTheUnitBesideTheProduct", () => {
    render(<RateBoard rates={[rate()]} />);
    expect(screen.getByText("per gram")).toBeInTheDocument();
  });
});
