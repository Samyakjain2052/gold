/**
 * Stage 4 — provider abstraction, mock provider, ingestion and freshness.
 *
 * Every test drives time through `ManualClock`. Nothing sleeps, so the suite is
 * deterministic and can step across a ten-minute expiry threshold instantly.
 */
import { describe, expect, test } from "vitest";
import { ManualClock } from "../../src/platform/clock.js";
import { rate_from_rupees_per_unit } from "../../src/platform/money.js";
import {
  backoff_delay_ms,
  classify_age,
  compare_ordering,
  evaluate_freshness,
  is_displayable,
  is_live,
  is_valid_transition,
  move_in_bps,
  parse_quote,
  assert_valid_policy,
  MarketDataService,
  MockMarketDataProvider,
  QuoteStream,
  ProviderStateError,
  QuoteValidationError,
  FreshnessPolicyError,
  DEFAULT_FRESHNESS_POLICY,
  type FreshnessPolicy,
  type MarketQuote,
  type ProviderStatus,
  type QuoteSnapshot,
} from "../../src/modules/market_data/index.js";

const T0 = new Date("2026-09-20T12:00:00.000Z");

function make_clock(): ManualClock {
  return new ManualClock(T0);
}

/** A valid raw payload, as a provider would put it on the wire. */
function raw_payload(overrides: Record<string, unknown> = {}) {
  return {
    quote_id: "mock:XAU_INR:1",
    sequence: 1,
    provider: "mock",
    source: "mock",
    symbol: "XAU_INR",
    metal: "GOLD",
    currency: "INR",
    source_unit: "per_10_gram",
    purity_num: 999,
    purity_den: 1000,
    bid: "153607",
    ask: "153847",
    mid: "153727",
    source_timestamp: T0.toISOString(),
    ...overrides,
  };
}

function quote(overrides: Partial<MarketQuote> = {}): MarketQuote {
  return {
    ...parse_quote(raw_payload(), T0),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Quote schema
// ---------------------------------------------------------------------------

describe("quote schema", () => {
  test("ParseQuote_validPayload_normalisesToCanonicalUnit", () => {
    const result = parse_quote(raw_payload(), T0);

    expect(result.mid).toBe(1_537_270_000n); // milli-paise per gram
    expect(result.unit).toBe("per_gram");
    expect(result.source_unit).toBe("per_10_gram");
    expect(result.metal).toBe("GOLD");
    expect(result.currency).toBe("INR");
  });

  test("ParseQuote_keepsSourceTimestampAndReceivedAtSeparate", () => {
    const received = new Date(T0.getTime() + 5_000);
    const result = parse_quote(raw_payload(), received);

    expect(result.source_timestamp.toISOString()).toBe(T0.toISOString());
    expect(result.received_at.toISOString()).toBe(received.toISOString());
    expect(result.source_timestamp).not.toEqual(result.received_at);
  });

  test("ParseQuote_bidAndAsk_normaliseAlongsideMid", () => {
    const result = parse_quote(raw_payload(), T0);
    expect(result.bid).toBe(1_536_070_000n);
    expect(result.ask).toBe(1_538_470_000n);
    expect(result.bid! < result.mid).toBe(true);
    expect(result.ask! > result.mid).toBe(true);
  });

  test("ParseQuote_oneWayQuote_leavesBidAndAskNull", () => {
    const result = parse_quote(raw_payload({ bid: null, ask: null }), T0);
    expect(result.bid).toBeNull();
    expect(result.ask).toBeNull();
    expect(result.mid).toBeGreaterThan(0n);
  });

  test("ParseQuote_perKilogramSilver_keepsSubPaisePrecision", () => {
    const result = parse_quote(
      raw_payload({
        symbol: "XAG_INR",
        metal: "SILVER",
        source_unit: "per_kilogram",
        mid: "236908",
        bid: null,
        ask: null,
      }),
      T0,
    );
    expect(result.mid).toBe(23_690_800n);
    expect(result.mid).toBe(rate_from_rupees_per_unit("236908", "per_kilogram"));
  });

  test.each([
    ["missing mid", { mid: undefined }],
    ["non-numeric mid", { mid: "not-a-number" }],
    ["unknown metal", { metal: "PLATINUM" }],
    ["unknown source", { source: "bloomberg" }],
    ["wrong currency", { currency: "USD" }],
    ["bad timestamp", { source_timestamp: "yesterday" }],
    ["negative purity", { purity_num: -1 }],
  ])("ParseQuote_malformed_%s_throws", (_label, override) => {
    expect(() => parse_quote(raw_payload(override), T0)).toThrow(QuoteValidationError);
  });

  test("ParseQuote_zeroMid_throws", () => {
    // Vendors do emit zeroes; publishing one is a commercial incident.
    expect(() => parse_quote(raw_payload({ mid: "0" }), T0)).toThrow(
      QuoteValidationError,
    );
  });

  test("ParseQuote_crossedQuote_throws", () => {
    expect(() =>
      parse_quote(raw_payload({ bid: "153900", ask: "153800" }), T0),
    ).toThrow(/crossed quote/);
  });

  test("ParseQuote_purityAboveFine_throws", () => {
    expect(() =>
      parse_quote(raw_payload({ purity_num: 1001, purity_den: 1000 }), T0),
    ).toThrow(/exceeds 100%/);
  });

  test("ParseQuote_errorMessage_doesNotEchoRawPayload", () => {
    try {
      parse_quote({ ...raw_payload(), mid: "bad", api_key: "super-secret" }, T0);
      expect.unreachable("expected a validation error");
    } catch (error) {
      expect(String(error)).not.toContain("super-secret");
    }
  });

  test("ParseQuote_missingQuoteId_synthesisesStableId", () => {
    const a = parse_quote(raw_payload({ quote_id: undefined }), T0);
    const b = parse_quote(raw_payload({ quote_id: undefined }), T0);
    expect(a.quote_id).toBe(b.quote_id);
  });

  /**
   * International spot feeds quote per troy ounce. 31.1034768 g does not divide
   * evenly, so the conversion runs in scaled integer arithmetic rather than
   * through a float.
   */
  test("ParseQuote_perTroyOunce_convertsToPerGram", () => {
    const result = parse_quote(
      raw_payload({ source_unit: "per_troy_ounce", mid: "100000", bid: null, ask: null }),
      T0,
    );

    // ₹100,000 / 31.1034768 g = ₹3,215.07…/g
    expect(result.mid / 1000n).toBe(321_507n); // paise per gram
    expect(result.source_unit).toBe("per_troy_ounce");
    expect(result.unit).toBe("per_gram");
  });

  test("ParseQuote_perTroyOunce_roundTripsBackToTheOunceQuote", () => {
    const result = parse_quote(
      raw_payload({ source_unit: "per_troy_ounce", mid: "100000", bid: null, ask: null }),
      T0,
    );
    // Back to rupees per ounce, within a rupee of the original.
    const rupees_per_ounce = (result.mid * 311_034_768n) / 10_000_000n / 100_000n;
    expect(rupees_per_ounce).toBe(99_999n);
  });

  test("ParseQuote_amountWithTooManyDecimals_isRejected", () => {
    expect(() => parse_quote(raw_payload({ mid: "1.1234567" }), T0)).toThrow(
      QuoteValidationError,
    );
  });

  test("ParseQuote_amountBeyondTwoDecimals_failsConversionCleanly", () => {
    // Passes the regex (≤6 decimals) but the money parser accepts only 2.
    expect(() => parse_quote(raw_payload({ mid: "153727.123" }), T0)).toThrow(
      /could not be converted/,
    );
  });
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

describe("freshness policy", () => {
  const policy: FreshnessPolicy = { stale_after_ms: 120_000, expired_after_ms: 600_000 };

  test("ClassifyAge_withinStaleThreshold_isFresh", () => {
    expect(classify_age(0, policy)).toBe("fresh");
    expect(classify_age(119_999, policy)).toBe("fresh");
    expect(classify_age(120_000, policy)).toBe("fresh"); // inclusive boundary
  });

  test("ClassifyAge_betweenThresholds_isStale", () => {
    expect(classify_age(120_001, policy)).toBe("stale");
    expect(classify_age(600_000, policy)).toBe("stale");
  });

  test("ClassifyAge_beyondExpiredThreshold_isExpired", () => {
    expect(classify_age(600_001, policy)).toBe("expired");
  });

  /** Small clock skew between hosts is normal and must not take the feed down. */
  test("ClassifyAge_negativeAgeFromClockSkew_isFresh", () => {
    expect(classify_age(-5_000, policy)).toBe("fresh");
  });

  test("EvaluateFreshness_agesAgainstSourceTimestampNotReceivedAt", () => {
    const clock = make_clock();
    // Received now, but the vendor stamped it ten minutes ago.
    const old_quote = quote({
      source_timestamp: new Date(T0.getTime() - 700_000),
      received_at: T0,
    });

    const snapshot = evaluate_freshness(old_quote, policy, clock);
    expect(snapshot.freshness).toBe("expired");
    expect(snapshot.age_ms).toBe(700_000);
  });

  test("EvaluateFreshness_asTimePasses_transitionsFreshToStaleToExpired", () => {
    const clock = make_clock();
    const q = quote();

    expect(evaluate_freshness(q, policy, clock).freshness).toBe("fresh");
    clock.advance(120_001);
    expect(evaluate_freshness(q, policy, clock).freshness).toBe("stale");
    clock.advance(480_000);
    expect(evaluate_freshness(q, policy, clock).freshness).toBe("expired");
  });

  test("IsDisplayable_expired_isFalse", () => {
    const clock = make_clock();
    const snapshot = evaluate_freshness(quote(), policy, clock);
    expect(is_displayable(snapshot)).toBe(true);
    expect(is_live(snapshot)).toBe(true);

    clock.advance(600_001);
    const aged = evaluate_freshness(quote(), policy, clock);
    expect(is_displayable(aged)).toBe(false);
    expect(is_live(aged)).toBe(false);
  });

  test("AssertValidPolicy_expiredNotAboveStale_throws", () => {
    expect(() =>
      assert_valid_policy({ stale_after_ms: 100, expired_after_ms: 100 }),
    ).toThrow(FreshnessPolicyError);
    expect(() =>
      assert_valid_policy({ stale_after_ms: 0, expired_after_ms: 100 }),
    ).toThrow(FreshnessPolicyError);
  });

  test("DefaultPolicy_isDerivedFromPollInterval", () => {
    // 2× and 10× the 60s default poll interval.
    expect(DEFAULT_FRESHNESS_POLICY.stale_after_ms).toBe(120_000);
    expect(DEFAULT_FRESHNESS_POLICY.expired_after_ms).toBe(600_000);
    expect(() => assert_valid_policy(DEFAULT_FRESHNESS_POLICY)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Ingestion: duplicates, ordering, plausibility
// ---------------------------------------------------------------------------

describe("quote stream", () => {
  test("QuoteStream_firstQuote_isAccepted", () => {
    const stream = new QuoteStream(make_clock());
    expect(stream.accept(quote()).outcome).toBe("accepted");
    expect(stream.last_accepted("XAU_INR")).not.toBeNull();
  });

  test("QuoteStream_identicalQuoteId_isRejectedAsDuplicate", () => {
    const stream = new QuoteStream(make_clock());
    stream.accept(quote());
    const result = stream.accept(quote());

    expect(result).toMatchObject({ outcome: "rejected", reason: "duplicate" });
    expect(stream.stats().rejected.duplicate).toBe(1);
  });

  /** A replayed duplicate must not refresh the displayed timestamp. */
  test("QuoteStream_duplicate_doesNotAdvanceLastAccepted", () => {
    const stream = new QuoteStream(make_clock());
    const first = quote();
    stream.accept(first);
    stream.accept(quote({ quote_id: first.quote_id, received_at: new Date() }));

    expect(stream.last_accepted("XAU_INR")?.received_at).toEqual(first.received_at);
  });

  test("QuoteStream_olderSequence_isRejectedAsOutOfOrder", () => {
    const stream = new QuoteStream(make_clock());
    stream.accept(quote({ quote_id: "a", sequence: 5 }));
    const result = stream.accept(quote({ quote_id: "b", sequence: 4 }));

    expect(result).toMatchObject({ outcome: "rejected", reason: "out_of_order" });
  });

  test("QuoteStream_olderTimestampWithoutSequence_isRejectedAsOutOfOrder", () => {
    const stream = new QuoteStream(make_clock());
    stream.accept(quote({ quote_id: "a", sequence: null }));
    const result = stream.accept(
      quote({
        quote_id: "b",
        sequence: null,
        source_timestamp: new Date(T0.getTime() - 60_000),
      }),
    );

    expect(result).toMatchObject({ outcome: "rejected", reason: "out_of_order" });
  });

  test("QuoteStream_sequenceTakesPrecedenceOverTimestamp", () => {
    // Newer sequence but older timestamp: the provider's sequence wins.
    const stream = new QuoteStream(make_clock());
    stream.accept(quote({ quote_id: "a", sequence: 1 }));
    const result = stream.accept(
      quote({
        quote_id: "b",
        sequence: 2,
        source_timestamp: new Date(T0.getTime() - 1_000),
      }),
    );
    expect(result.outcome).toBe("accepted");
  });

  test("QuoteStream_equalTimestampNoSequence_isTreatedAsDuplicate", () => {
    const stream = new QuoteStream(make_clock());
    stream.accept(quote({ quote_id: "a", sequence: null }));
    const result = stream.accept(quote({ quote_id: "b", sequence: null }));
    expect(result).toMatchObject({ outcome: "rejected", reason: "duplicate" });
  });

  test("QuoteStream_implausibleMove_isRejectedAndLastGoodRetained", () => {
    const stream = new QuoteStream(make_clock(), { max_move_bps: 500 });
    const first = quote({ quote_id: "a", sequence: 1 });
    stream.accept(first);

    const result = stream.accept(
      quote({ quote_id: "b", sequence: 2, mid: first.mid * 10n }),
    );

    expect(result).toMatchObject({ outcome: "rejected", reason: "implausible_move" });
    expect(stream.last_accepted("XAU_INR")?.mid).toBe(first.mid);
  });

  test("QuoteStream_moveWithinBand_isAccepted", () => {
    const stream = new QuoteStream(make_clock(), { max_move_bps: 500 });
    const first = quote({ quote_id: "a", sequence: 1 });
    stream.accept(first);
    // +1%
    const result = stream.accept(
      quote({ quote_id: "b", sequence: 2, mid: (first.mid * 101n) / 100n }),
    );
    expect(result.outcome).toBe("accepted");
  });

  test("QuoteStream_unknownSymbol_isRejected", () => {
    const stream = new QuoteStream(make_clock(), { known_symbols: ["XAG_INR"] });
    const result = stream.accept(quote());
    expect(result).toMatchObject({ outcome: "rejected", reason: "unknown_symbol" });
  });

  test("QuoteStream_multipleSymbols_trackedIndependently", () => {
    const stream = new QuoteStream(make_clock());
    stream.accept(quote({ quote_id: "g1", symbol: "XAU_INR" }));
    stream.accept(quote({ quote_id: "s1", symbol: "XAG_INR", metal: "SILVER" }));

    expect(stream.symbols().sort()).toEqual(["XAG_INR", "XAU_INR"]);
    expect(stream.last_accepted("XAU_INR")?.symbol).toBe("XAU_INR");
    expect(stream.last_accepted("XAG_INR")?.symbol).toBe("XAG_INR");
  });

  test("QuoteStream_dedupeWindow_isBounded", () => {
    const stream = new QuoteStream(make_clock(), { dedupe_window: 4 });
    for (let i = 1; i <= 10; i += 1) {
      stream.accept(quote({ quote_id: `q${i}`, sequence: i }));
    }
    // The earliest id has been evicted, so it is no longer seen as a duplicate;
    // it is rejected on ordering instead. Either way memory stays bounded.
    const result = stream.accept(quote({ quote_id: "q1", sequence: 1 }));
    expect(result).toMatchObject({ outcome: "rejected", reason: "out_of_order" });
  });

  test("QuoteStream_stats_countEveryRejectionReason", () => {
    const stream = new QuoteStream(make_clock(), { max_move_bps: 100 });
    stream.accept(quote({ quote_id: "a", sequence: 2 }));
    stream.accept(quote({ quote_id: "a", sequence: 3 })); // duplicate id
    stream.accept(quote({ quote_id: "b", sequence: 1 })); // out of order
    stream.accept(quote({ quote_id: "c", sequence: 4, mid: 9_999_999_999n })); // implausible

    const stats = stream.stats();
    expect(stats.accepted).toBe(1);
    expect(stats.rejected.duplicate).toBe(1);
    expect(stats.rejected.out_of_order).toBe(1);
    expect(stats.rejected.implausible_move).toBe(1);
  });

  test("CompareOrdering_and_MoveInBps_areTotal", () => {
    const a = quote({ quote_id: "a", sequence: 2 });
    const b = quote({ quote_id: "b", sequence: 1 });
    expect(compare_ordering(a, b)).toBe("newer");
    expect(compare_ordering(b, a)).toBe("older");
    expect(compare_ordering(a, a)).toBe("duplicate");
    expect(move_in_bps(100n, 105n)).toBe(500);
    expect(move_in_bps(100n, 95n)).toBe(500);
    expect(move_in_bps(0n, 5n)).toBe(Number.POSITIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------
// Provider state machine and backoff
// ---------------------------------------------------------------------------

describe("provider state machine", () => {
  test.each([
    ["configured", "connecting", true],
    ["connecting", "healthy", true],
    ["healthy", "stale", true],
    ["stale", "healthy", true],
    ["healthy", "disconnected", true],
    ["disconnected", "connecting", true],
    ["error", "connecting", true],
    // `stale` means the link is up but data has aged — it is not reachable
    // from a dead connection, which is a different failure.
    ["disconnected", "stale", false],
    ["configured", "healthy", false],
    ["not_configured", "healthy", false],
  ])("IsValidTransition_%s_to_%s_is_%s", (from, to, expected) => {
    expect(is_valid_transition(from as ProviderStatus, to as ProviderStatus)).toBe(
      expected,
    );
  });

  test("BackoffDelay_growsExponentiallyAndIsCapped", () => {
    const always_max = () => 1;
    const options = { base_ms: 250, max_ms: 30_000, max_attempts: 10 };

    expect(backoff_delay_ms(0, options, always_max)).toBe(250);
    expect(backoff_delay_ms(1, options, always_max)).toBe(500);
    expect(backoff_delay_ms(2, options, always_max)).toBe(1_000);
    expect(backoff_delay_ms(20, options, always_max)).toBe(30_000); // capped
  });

  /** Full jitter: every replica must not retry in lockstep after an outage. */
  test("BackoffDelay_fullJitter_spansZeroToCeiling", () => {
    const options = { base_ms: 250, max_ms: 30_000, max_attempts: 10 };
    expect(backoff_delay_ms(3, options, () => 0)).toBe(0);
    expect(backoff_delay_ms(3, options, () => 0.999999)).toBeLessThanOrEqual(2_000);
  });

  test("BackoffDelay_defaultOptions_areUsable", () => {
    expect(backoff_delay_ms(0)).toBeGreaterThanOrEqual(0);
    expect(backoff_delay_ms(0)).toBeLessThanOrEqual(250);
  });

  test("ProviderStateError_namesBothStates", () => {
    const error = new ProviderStateError("disconnected", "stale");
    expect(error.message).toContain("disconnected");
    expect(error.message).toContain("stale");
    expect(error.name).toBe("ProviderStateError");
  });
});

// ---------------------------------------------------------------------------
// Mock provider — the twelve simulated behaviours
// ---------------------------------------------------------------------------

describe("mock provider", () => {
  function setup() {
    const clock = make_clock();
    const provider = new MockMarketDataProvider(clock, { random: () => 0.5 });
    const received: unknown[] = [];
    provider.subscribe((payload) => received.push(payload));
    return { clock, provider, received };
  }

  test("MockProvider_isFlaggedSimulated", () => {
    const { provider } = setup();
    expect(provider.is_simulated).toBe(true);
    expect(provider.health().is_simulated).toBe(true);
  });

  test("MockProvider_beforeStart_isConfigured", () => {
    const { provider } = setup();
    expect(provider.health().status).toBe("configured");
  });

  test("MockProvider_start_transitionsThroughConnectingToHealthy", async () => {
    const { provider } = setup();
    const seen: ProviderStatus[] = [];
    provider.on_status((status) => seen.push(status));

    await provider.start();

    expect(seen).toEqual(["connecting", "healthy"]);
    expect(provider.health().status).toBe("healthy");
    expect(provider.health().connected_since).not.toBeNull();
  });

  // 1. Normal rate updates
  test("MockProvider_tick_emitsOnePayloadPerSymbol", async () => {
    const { provider, received } = setup();
    await provider.start();
    provider.tick();

    expect(received).toHaveLength(2); // gold + silver
  });

  // 2. Multiple symbols/metals
  test("MockProvider_multipleSymbols_coverGoldAndSilver", async () => {
    const { provider, received } = setup();
    await provider.start();
    provider.tick();

    const metals = received.map((p) => (p as { metal: string }).metal).sort();
    expect(metals).toEqual(["GOLD", "SILVER"]);
  });

  // 3. Bid/ask updates
  test("MockProvider_emitsBidAskAroundMid", async () => {
    const { provider, received } = setup();
    await provider.start();
    provider.tick_symbol("XAU_INR");

    const parsed = parse_quote(received[0], T0);
    expect(parsed.bid).not.toBeNull();
    expect(parsed.ask).not.toBeNull();
    expect(parsed.bid! < parsed.mid).toBe(true);
    expect(parsed.ask! > parsed.mid).toBe(true);
  });

  // 4. Source timestamps
  test("MockProvider_sourceTimestamp_tracksTheInjectedClock", async () => {
    const { clock, provider, received } = setup();
    await provider.start();
    clock.advance(45_000);
    provider.tick_symbol("XAU_INR");

    const parsed = parse_quote(received[0], clock.date());
    expect(parsed.source_timestamp.getTime()).toBe(T0.getTime() + 45_000);
  });

  test("MockProvider_emittedPayloads_surviveRealValidation", async () => {
    const { provider, received } = setup();
    await provider.start();
    provider.tick();

    // The mock emits raw payloads on the same path a vendor would, so the
    // schema layer is exercised rather than bypassed.
    for (const payload of received) {
      expect(() => parse_quote(payload, T0)).not.toThrow();
    }
  });

  // 5. Provider disconnection
  test("MockProvider_disconnect_stopsEmittingAndReportsDisconnected", async () => {
    const { provider, received } = setup();
    await provider.start();
    provider.disconnect();
    provider.tick();

    expect(provider.health().status).toBe("disconnected");
    expect(received).toHaveLength(0);
  });

  // 6. Reconnection
  test("MockProvider_reconnect_resumesEmittingAndCountsAttempts", async () => {
    const { provider, received } = setup();
    await provider.start();
    provider.disconnect();
    provider.reconnect();
    provider.tick();

    expect(provider.health().status).toBe("healthy");
    expect(provider.health().reconnect_attempts).toBe(1);
    expect(received.length).toBeGreaterThan(0);
  });

  test("MockProvider_failNext_makesReconnectFailThenRecover", async () => {
    const { provider } = setup();
    await provider.start();
    provider.disconnect();
    provider.fail_next(1);

    provider.reconnect();
    expect(provider.health().status).toBe("error");
    expect(provider.health().consecutive_failures).toBe(1);
    expect(provider.health().last_error).toContain("simulated");

    provider.reconnect();
    expect(provider.health().status).toBe("healthy");
    expect(provider.health().consecutive_failures).toBe(0);
  });

  test("MockProvider_reconnect_returnsBackoffDelay", async () => {
    const { provider } = setup();
    await provider.start();
    provider.disconnect();
    const delay = provider.reconnect();
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  // 7. Delayed/stale data
  test("MockProvider_emitStale_producesAnAgedSourceTimestamp", async () => {
    const { clock, provider, received } = setup();
    await provider.start();
    provider.emit_stale("XAU_INR", 300_000);

    const parsed = parse_quote(received[0], clock.date());
    expect(clock.now() - parsed.source_timestamp.getTime()).toBe(300_000);
  });

  test("MockProvider_goSilent_emitsNothingWhileConnected", async () => {
    const { provider, received } = setup();
    await provider.start();
    provider.go_silent();
    provider.tick();

    expect(received).toHaveLength(0);
    expect(provider.health().status).toBe("healthy"); // link is up, data is not flowing

    provider.resume();
    provider.tick();
    expect(received.length).toBeGreaterThan(0);
  });

  // 8. Malformed/invalid quotes
  test("MockProvider_emitMalformed_producesAPayloadValidationRejects", async () => {
    const { provider, received } = setup();
    await provider.start();
    provider.emit_malformed();

    expect(received).toHaveLength(1);
    expect(() => parse_quote(received[0], T0)).toThrow(QuoteValidationError);
  });

  // 9. Duplicate updates
  test("MockProvider_emitDuplicate_repeatsTheLastPayloadVerbatim", async () => {
    const { provider, received } = setup();
    await provider.start();
    provider.tick_symbol("XAU_INR");
    provider.emit_duplicate("XAU_INR");

    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(received[0]);
  });

  // 10. Out-of-order updates
  test("MockProvider_emitOutOfOrder_producesOlderSequenceAndTimestamp", async () => {
    const { provider, received } = setup();
    await provider.start();
    provider.tick_symbol("XAU_INR");
    provider.emit_out_of_order("XAU_INR");

    const first = received[0] as { sequence: number; source_timestamp: string };
    const late = received[1] as { sequence: number; source_timestamp: string };

    expect(late.sequence).toBeLessThan(first.sequence);
    expect(new Date(late.source_timestamp).getTime()).toBeLessThan(
      new Date(first.source_timestamp).getTime(),
    );
  });

  // 11. Graceful shutdown
  test("MockProvider_stop_releasesListenersAndEmitsNothingAfterwards", async () => {
    const { provider, received } = setup();
    await provider.start();
    await provider.stop();
    provider.tick();

    expect(received).toHaveLength(0);
    expect(provider.health().status).toBe("disconnected");
    expect(provider.health().connected_since).toBeNull();
  });

  test("MockProvider_stop_isIdempotent", async () => {
    const { provider } = setup();
    await provider.start();
    await provider.stop();
    await expect(provider.stop()).resolves.toBeUndefined();
  });

  test("MockProvider_start_isIdempotent", async () => {
    const { provider } = setup();
    await provider.start();
    const first = provider.health().connected_since;
    await provider.start();
    expect(provider.health().connected_since).toEqual(first);
  });

  // 12. Health state transitions
  test("MockProvider_markStale_movesHealthyToStaleAndBack", async () => {
    const { provider } = setup();
    await provider.start();

    provider.mark_stale();
    expect(provider.health().status).toBe("stale");

    provider.mark_healthy();
    expect(provider.health().status).toBe("healthy");
  });

  test("MockProvider_statusListeners_receiveEveryTransition", async () => {
    const { provider } = setup();
    const seen: Array<{ to: ProviderStatus; from: ProviderStatus }> = [];
    provider.on_status((status, detail) => seen.push({ to: status, from: detail.previous }));

    await provider.start();
    provider.mark_stale();
    provider.disconnect();
    provider.reconnect();

    expect(seen.map((s) => s.to)).toEqual([
      "connecting",
      "healthy",
      "stale",
      "disconnected",
      "connecting",
      "healthy",
    ]);
  });

  test("MockProvider_getLatestQuotes_failsWhileDisconnected", async () => {
    const { provider } = setup();
    await provider.start();
    provider.tick();
    await expect(provider.get_latest_quotes([])).resolves.toHaveLength(2);

    provider.disconnect();
    await expect(provider.get_latest_quotes([])).rejects.toThrow(/disconnected/);
  });

  test.each([
    ["tick_symbol", (p: MockMarketDataProvider) => p.tick_symbol("NOPE")],
    ["emit_duplicate", (p: MockMarketDataProvider) => p.emit_duplicate("NOPE")],
    ["emit_out_of_order", (p: MockMarketDataProvider) => p.emit_out_of_order("NOPE")],
    ["emit_stale", (p: MockMarketDataProvider) => p.emit_stale("NOPE", 1000)],
    ["emit_implausible", (p: MockMarketDataProvider) => p.emit_implausible("NOPE")],
  ])("MockProvider_%s_unknownSymbol_throws", async (_label, invoke) => {
    const { provider } = setup();
    await provider.start();
    expect(() => invoke(provider)).toThrow(/unknown mock symbol|no previous payload/);
  });

  test("MockProvider_duplicateBeforeAnyTick_throws", async () => {
    const { provider } = setup();
    await provider.start();
    expect(() => provider.emit_duplicate("XAU_INR")).toThrow(/no previous payload/);
    expect(() => provider.emit_out_of_order("XAU_INR")).toThrow(/no previous payload/);
  });

  test("MockProvider_getLatestQuotes_filtersToRequestedSymbols", async () => {
    const { provider } = setup();
    await provider.start();
    provider.tick();

    const gold_only = await provider.get_latest_quotes(["XAU_INR"]);
    expect(gold_only).toHaveLength(1);
    expect((gold_only[0] as { symbol: string }).symbol).toBe("XAU_INR");

    // An unknown symbol yields nothing rather than throwing.
    expect(await provider.get_latest_quotes(["NOPE"])).toHaveLength(0);
  });

  test("MockProvider_downwardDrift_neverProducesNonPositiveMid", async () => {
    const clock = make_clock();
    // Always drift maximally downward.
    const provider = new MockMarketDataProvider(clock, {
      random: () => 0,
      drift_bps: 9_999,
    });
    const received: unknown[] = [];
    provider.subscribe((p) => received.push(p));
    await provider.start();

    for (let i = 0; i < 20; i += 1) provider.tick_symbol("XAU_INR");

    for (const payload of received) {
      const parsed = parse_quote(payload, T0);
      expect(parsed.mid).toBeGreaterThan(0n);
    }
  });

  /** Illegal transitions are recorded, not thrown — a status path must not
   *  take the feed down. */
  test("MockProvider_illegalTransition_isIgnoredNotThrown", async () => {
    const { provider } = setup();
    await provider.start();
    provider.disconnect();

    // `stale` is unreachable from `disconnected`.
    expect(() => provider.mark_stale()).not.toThrow();
    expect(provider.health().status).toBe("disconnected");
  });

  test("MockProvider_markHealthyFromHealthy_isANoOp", async () => {
    const { provider } = setup();
    await provider.start();
    provider.mark_healthy();
    expect(provider.health().status).toBe("healthy");
  });

  test("MockProvider_startFailure_reportsErrorThenRecovers", async () => {
    const { provider } = setup();
    provider.fail_next(1);

    await provider.start();
    expect(provider.health().status).toBe("error");
    expect(provider.health().consecutive_failures).toBe(1);

    await provider.start();
    expect(provider.health().status).toBe("healthy");
  });

  test("MockProvider_emitDuplicateWhileSilent_emitsNothing", async () => {
    const { provider, received } = setup();
    await provider.start();
    provider.tick_symbol("XAU_INR");
    const count = received.length;

    provider.go_silent();
    provider.emit_duplicate("XAU_INR");
    provider.emit_malformed();
    provider.emit_stale("XAU_INR", 1000);
    provider.emit_implausible("XAU_INR");

    expect(received).toHaveLength(count);
  });

  test("MockProvider_implausibleEmission_isAvailableForTesting", async () => {
    const { provider, received } = setup();
    await provider.start();
    provider.tick_symbol("XAU_INR");
    provider.emit_implausible("XAU_INR", 10n);

    const normal = parse_quote(received[0], T0);
    const bad = parse_quote(received[1], T0);
    expect(bad.mid).toBeGreaterThan(normal.mid * 5n);
  });
});

// ---------------------------------------------------------------------------
// Service: freshness, base-rate resolution, health
// ---------------------------------------------------------------------------

describe("market data service", () => {
  async function setup(policy: FreshnessPolicy = DEFAULT_FRESHNESS_POLICY) {
    const clock = make_clock();
    const provider = new MockMarketDataProvider(clock, { random: () => 0.5 });
    const service = new MarketDataService(provider, clock, { freshness: policy });
    const accepted: QuoteSnapshot[] = [];
    const rejected: string[] = [];

    service.on_quote((snapshot) => accepted.push(snapshot));
    service.on_rejection((result) => rejected.push(result.reason));
    await service.start();

    return { clock, provider, service, accepted, rejected };
  }

  test("Service_normalTick_publishesAcceptedSnapshot", async () => {
    const { provider, accepted } = await setup();
    provider.tick_symbol("XAU_INR");

    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.freshness).toBe("fresh");
    expect(accepted[0]!.quote.symbol).toBe("XAU_INR");
  });

  test("Service_malformedPayload_isRejectedNotPublished", async () => {
    const { provider, accepted, rejected } = await setup();
    provider.emit_malformed();

    expect(accepted).toHaveLength(0);
    expect(rejected).toEqual(["invalid_schema"]);
  });

  test("Service_duplicate_isRejectedNotRepublished", async () => {
    const { provider, accepted, rejected } = await setup();
    provider.tick_symbol("XAU_INR");
    provider.emit_duplicate("XAU_INR");

    expect(accepted).toHaveLength(1);
    expect(rejected).toEqual(["duplicate"]);
  });

  test("Service_outOfOrder_isRejectedNotPublished", async () => {
    const { provider, accepted, rejected } = await setup();
    provider.tick_symbol("XAU_INR");
    provider.emit_out_of_order("XAU_INR");

    expect(accepted).toHaveLength(1);
    expect(rejected).toEqual(["out_of_order"]);
  });

  test("Service_snapshotFreshness_isEvaluatedAtReadTime", async () => {
    const { clock, provider, service } = await setup();
    provider.tick_symbol("XAU_INR");

    expect(service.snapshot("XAU_INR")?.freshness).toBe("fresh");
    clock.advance(200_000);
    expect(service.snapshot("XAU_INR")?.freshness).toBe("stale");
    clock.advance(500_000);
    expect(service.snapshot("XAU_INR")?.freshness).toBe("expired");
  });

  test("Service_staleQuote_isRetainedAndMarkedNotDiscarded", async () => {
    const { clock, provider, service } = await setup();
    provider.tick_symbol("XAU_INR");
    const original_mid = service.snapshot("XAU_INR")!.quote.mid;

    clock.advance(200_000);
    const snapshot = service.snapshot("XAU_INR")!;

    expect(snapshot.freshness).toBe("stale");
    expect(snapshot.quote.mid).toBe(original_mid); // last known value retained
    expect(snapshot.quote.source_timestamp).toBeInstanceOf(Date);
    expect(snapshot.quote.received_at).toBeInstanceOf(Date);
  });

  /** The invariant that keeps pricing honest when the feed dies. */
  test("Service_expiredQuote_resolvesUnavailableSoPricingCannotInventARate", async () => {
    const { clock, provider, service } = await setup();
    provider.tick_symbol("XAU_INR");
    clock.advance(600_001);

    const resolution = service.resolve_base_rate("XAU_INR");

    expect(resolution.available).toBe(false);
    if (resolution.available) throw new Error("unreachable");
    expect(resolution.reason).toBe("expired");
    // Last known value is still available for explicitly-stale display.
    expect(resolution.last_known?.quote.mid).toBeGreaterThan(0n);
  });

  test("Service_noQuoteYet_resolvesUnavailableWithNoLastKnown", async () => {
    const { service } = await setup();
    const resolution = service.resolve_base_rate("XAU_INR");

    expect(resolution.available).toBe(false);
    if (resolution.available) throw new Error("unreachable");
    expect(resolution.reason).toBe("no_quote");
    expect(resolution.last_known).toBeNull();
  });

  test("Service_freshQuote_resolvesAvailable", async () => {
    const { provider, service } = await setup();
    provider.tick_symbol("XAU_INR");

    const resolution = service.resolve_base_rate("XAU_INR");
    expect(resolution.available).toBe(true);
  });

  test("Service_staleQuote_stillResolvesAvailableButMarkedStale", async () => {
    const { clock, provider, service } = await setup();
    provider.tick_symbol("XAU_INR");
    clock.advance(200_000);

    const resolution = service.resolve_base_rate("XAU_INR");
    expect(resolution.available).toBe(true);
    if (!resolution.available) throw new Error("unreachable");
    expect(resolution.snapshot.freshness).toBe("stale");
  });

  /**
   * A connected provider with a frozen feed must not report healthy — that is
   * exactly the state in which stale data looks live.
   */
  test("Service_connectedButAllQuotesAged_reportsStaleNotHealthy", async () => {
    const { clock, provider, service } = await setup();
    provider.tick();
    expect(service.health().status).toBe("healthy");

    clock.advance(200_000);
    expect(provider.health().status).toBe("healthy"); // link is fine
    expect(service.health().status).toBe("stale"); // data is not
  });

  test("Service_disconnectedProvider_reportsDisconnected", async () => {
    const { provider, service } = await setup();
    provider.tick();
    provider.disconnect();

    expect(service.health().status).toBe("disconnected");
  });

  test("Service_recoveryAfterSilence_returnsToFresh", async () => {
    const { clock, provider, service } = await setup();
    provider.tick_symbol("XAU_INR");

    provider.go_silent();
    clock.advance(200_000);
    expect(service.snapshot("XAU_INR")?.freshness).toBe("stale");

    provider.resume();
    provider.tick_symbol("XAU_INR");
    expect(service.snapshot("XAU_INR")?.freshness).toBe("fresh");
    expect(service.health().status).toBe("healthy");
  });

  test("Service_stop_isGracefulAndStopsPublishing", async () => {
    const { provider, service, accepted } = await setup();
    provider.tick_symbol("XAU_INR");
    const count = accepted.length;

    await service.stop();
    provider.tick();

    expect(accepted).toHaveLength(count);
  });

  test("Service_multipleSymbols_resolveIndependently", async () => {
    const { clock, provider, service } = await setup();
    provider.tick_symbol("XAU_INR");
    clock.advance(200_000);
    provider.tick_symbol("XAG_INR");

    expect(service.snapshot("XAU_INR")?.freshness).toBe("stale");
    expect(service.snapshot("XAG_INR")?.freshness).toBe("fresh");
    expect(service.snapshots()).toHaveLength(2);
  });

  test("Service_exposesSimulatedFlagFromProvider", async () => {
    const { service } = await setup();
    expect(service.is_simulated).toBe(true);
    expect(service.provider_name).toBe("mock");
  });
});
