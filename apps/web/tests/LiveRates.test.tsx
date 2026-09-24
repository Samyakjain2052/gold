/**
 * The live rate board: initial render, streamed updates, and every way the
 * stream can misbehave.
 *
 * `EventSource` does not exist in jsdom, so a controllable fake is injected.
 * That is also what makes the disconnect and reconnect paths testable at all —
 * they are otherwise only reachable by unplugging a network cable.
 */
import { describe, expect, test } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { PublicRate } from "@bullion/contracts";
import { LiveRates } from "@/components/LiveRates";
import { parse_rate_event } from "@/lib/useRateStream";

/** Minimal stand-in for the browser's EventSource. */
class FakeEventSource {
  static last: FakeEventSource | null = null;

  readyState = 0;
  closed = false;
  readonly listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, handler: (event: Event) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** Simulate the connection opening. */
  open(): void {
    this.readyState = 1;
    this.fire("open", new Event("open"));
  }

  /** Simulate a named SSE event carrying `data`. */
  send(type: string, data: string): void {
    this.fire(type, new MessageEvent(type, { data }));
  }

  /** Simulate a transport error. `fatal` means EventSource has given up. */
  fail(fatal = false): void {
    this.readyState = fatal ? 2 : 0;
    this.fire("error", new Event("error"));
  }

  private fire(type: string, event: Event): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

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

function update(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "rate_update",
    product_key: "GOLD_916",
    rate_display_paise: "1409000",
    display_unit: "per_gram",
    source_timestamp: "2026-09-20T12:05:00.000Z",
    freshness: "fresh",
    emitted_at: "2026-09-20T12:05:01.000Z",
    ...overrides,
  });
}

function setup(rates: PublicRate[] = [rate()]) {
  const view = render(
    <LiveRates
      initial_rates={rates}
      stream_url="http://api.test/stream"
      create_source={(url) => new FakeEventSource(url) as unknown as EventSource}
    />,
  );
  const source = FakeEventSource.last;
  if (source === null) throw new Error("no EventSource was created");
  return { ...view, source };
}

describe("initial render", () => {
  /** The first paint carries a real rate; a customer never meets a spinner. */
  test("LiveRates_beforeAnyEvent_showsServerRenderedRates", () => {
    setup();
    expect(screen.getByText("₹14,081.39")).toBeInTheDocument();
  });

  test("LiveRates_noRates_explainsRatherThanShowingAnEmptyBoard", () => {
    render(<LiveRates initial_rates={[]} stream_url={null} />);

    expect(screen.getByRole("status")).toHaveTextContent(/no rates published/i);
  });

  /** A healthy connection says nothing; only problems are announced. */
  test("LiveRates_whenConnected_showsNoConnectionNotice", () => {
    const { source } = setup();
    act(() => source.open());

    expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
  });
});

describe("live updates", () => {
  test("LiveRates_rateUpdate_replacesTheDisplayedRate", () => {
    const { source } = setup();
    act(() => source.open());
    act(() => source.send("rate_update", update()));

    expect(screen.getByText("₹14,090.00")).toBeInTheDocument();
    expect(screen.queryByText("₹14,081.39")).not.toBeInTheDocument();
  });

  test("LiveRates_updateForOneProduct_leavesOthersAlone", () => {
    const { source } = setup([
      rate(),
      rate({ product_key: "SILVER_999", label: "Silver", rate: "2369080" }),
    ]);

    act(() => source.open());
    act(() => source.send("rate_update", update()));

    expect(screen.getByText("₹14,090.00")).toBeInTheDocument();
    expect(screen.getByText("₹23,690.80")).toBeInTheDocument();
  });

  test("LiveRates_updateCarryingStaleFreshness_downgradesTheBadge", () => {
    const { source } = setup();
    act(() => source.open());
    act(() => source.send("rate_update", update({ freshness: "stale" })));

    expect(screen.getByText("Delayed")).toBeInTheDocument();
  });

  /**
   * A live event carries no breakdown, so the previous one must be cleared —
   * showing an old market rate beside a new total would print a breakdown whose
   * parts do not add up to it.
   */
  test("LiveRates_afterUpdate_dropsTheStaleBreakdown", () => {
    const { source } = setup([
      rate({ market_rate: "1403139", shop_adjustment: "5000", rounding: "0" }),
    ]);

    // The breakdown is available before the update...
    expect(screen.getByRole("button", { name: /show breakdown/i })).toBeInTheDocument();

    act(() => source.open());
    act(() => source.send("rate_update", update()));

    // ...and gone after it, because a live event carries no components. Keeping
    // the old market rate beside a new total would show a breakdown whose parts
    // no longer add up to it.
    expect(screen.queryByRole("button", { name: /breakdown/i })).not.toBeInTheDocument();
    expect(screen.getByText("₹14,090.00")).toBeInTheDocument();
  });

  test("LiveRates_update_isAnnouncedToScreenReaders", () => {
    const { source, container } = setup();
    act(() => source.open());
    act(() => source.send("rate_update", update()));

    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toMatch(/GOLD_916/);
  });
});

describe("connection loss", () => {
  /**
   * During a blip the last known rates stay on screen, with an explanation.
   * Blanking them would be worse than showing slightly old numbers.
   */
  test("LiveRates_transientError_keepsRatesAndSaysReconnecting", () => {
    const { source } = setup();
    act(() => source.open());
    act(() => source.fail(false));

    expect(screen.getByText("₹14,081.39")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/reconnecting/i);
    expect(screen.getByText(/last rates received/i)).toBeInTheDocument();
  });

  test("LiveRates_fatalError_saysUpdatesAreUnavailable", () => {
    const { source } = setup();
    act(() => source.open());
    act(() => source.fail(true));

    expect(screen.getByRole("status")).toHaveTextContent(/live updates unavailable/i);
    expect(screen.getByText("₹14,081.39")).toBeInTheDocument();
  });

  test("LiveRates_reconnectAfterFailure_resumesUpdating", () => {
    const { source } = setup();
    act(() => source.open());
    act(() => source.fail(false));

    // EventSource recovers on its own and delivers the next event.
    act(() => source.open());
    act(() => source.send("rate_update", update()));

    expect(screen.getByText("₹14,090.00")).toBeInTheDocument();
    expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument();
  });

  test("LiveRates_noStreamUrl_rendersRatesWithoutLiveUpdates", () => {
    render(<LiveRates initial_rates={[rate()]} stream_url={null} />);

    expect(screen.getByText("₹14,081.39")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/unavailable/i);
  });

  test("LiveRates_unmount_closesTheConnection", () => {
    const { source, unmount } = setup();
    act(() => source.open());
    unmount();

    expect(source.closed).toBe(true);
  });
});

describe("malformed frames", () => {
  /** None of these may reach the DOM; the previous rate must simply stand. */
  test.each([
    ["not json", "{"],
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "42"],
    ["a string", '"hello"'],
    ["the wrong type", JSON.stringify({ type: "something_else", product_key: "GOLD_916" })],
  ])("LiveRates_%s_isIgnored", (_label, payload) => {
    const { source } = setup();
    act(() => source.open());
    act(() => source.send("rate_update", payload));

    expect(screen.getByText("₹14,081.39")).toBeInTheDocument();
  });

  test.each([
    ["a missing product key", update({ product_key: undefined })],
    ["an empty product key", update({ product_key: "" })],
    ["a numeric rate", update({ rate_display_paise: 1409000 })],
    ["a decimal rate", update({ rate_display_paise: "14090.00" })],
    ["an unknown freshness", update({ freshness: "ancient" })],
    ["a missing timestamp", update({ source_timestamp: undefined })],
  ])("LiveRates_%s_isIgnored", (_label, payload) => {
    const { source } = setup();
    act(() => source.open());
    act(() => source.send("rate_update", payload));

    expect(screen.getByText("₹14,081.39")).toBeInTheDocument();
  });

  /**
   * A float on the wire would mean the server broke the integer-paise contract.
   * Dropping it is safer than rendering a value that has already lost precision.
   */
  test("ParseRateEvent_numericMoney_isRejected", () => {
    expect(parse_rate_event(update({ rate_display_paise: 1409000 }))).toBeNull();
  });

  test("ParseRateEvent_wellFormed_isAccepted", () => {
    const parsed = parse_rate_event(update());
    expect(parsed?.product_key).toBe("GOLD_916");
    expect(parsed?.rate_display_paise).toBe("1409000");
  });

  test("ParseRateEvent_nonString_isRejected", () => {
    expect(parse_rate_event(undefined)).toBeNull();
    expect(parse_rate_event({ type: "rate_update" })).toBeNull();
  });
});
