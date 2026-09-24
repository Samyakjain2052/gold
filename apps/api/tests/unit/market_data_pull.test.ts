/**
 * The pull-based ingestion path.
 *
 * A streaming provider pushes; a polling provider is asked. Both must reach the
 * same validation, deduplication and freshness logic, or one of them becomes a
 * way to get an unchecked quote into the system.
 */
import { describe, expect, test, vi } from "vitest";
import { MarketDataService } from "../../src/modules/market_data/market_data_service.js";
import type { MarketDataProvider } from "../../src/modules/market_data/provider.js";
import { ManualClock } from "../../src/platform/clock.js";
import type { IngestResult } from "../../src/modules/market_data/types.js";

const NOW = new Date("2026-09-23T06:30:00.000Z");

function payload(overrides: Record<string, unknown> = {}) {
  return {
    quote_id: "q-1",
    sequence: 1,
    provider: "mock",
    source: "mock",
    symbol: "XAU_INR",
    metal: "GOLD",
    currency: "INR",
    source_unit: "per_10_gram",
    purity_num: 999,
    purity_den: 1000,
    bid: null,
    ask: null,
    mid: "140813.93",
    source_timestamp: NOW.toISOString(),
    ...overrides,
  };
}

function service(latest: unknown[] = []) {
  const get_latest_quotes = vi.fn(async () => latest);

  const provider: MarketDataProvider = {
    name: "mock",
    source: "mock",
    is_simulated: true,
    start: async () => {},
    stop: async () => {},
    get_latest_quotes,
    subscribe: () => ({ unsubscribe: () => {} }),
    on_status: () => ({ unsubscribe: () => {} }),
    health: () => ({
      provider: "mock",
      source: "mock",
      status: "healthy",
      is_simulated: true,
      connected_since: NOW,
      last_quote_at: NOW,
      last_source_timestamp: NOW,
      consecutive_failures: 0,
      reconnect_attempts: 0,
      last_error: null,
      evaluated_at: NOW,
    }),
  };

  return {
    service: new MarketDataService(provider, new ManualClock(NOW)),
    get_latest_quotes,
  };
}

describe("provider_latest", () => {
  test("PullPath_delegatesToTheProvider", async () => {
    const { service: s, get_latest_quotes } = service([payload()]);

    await expect(s.provider_latest(["XAU_INR"])).resolves.toHaveLength(1);
    expect(get_latest_quotes).toHaveBeenCalledWith(["XAU_INR"]);
  });

  /** The poller holds no provider reference of its own; this is the only door. */
  test("PullPath_returnsRawPayloads_notQuotes", async () => {
    const { service: s } = service([payload()]);
    const [raw] = await s.provider_latest([]);

    // Still the vendor shape: validation has not run yet.
    expect(raw).toHaveProperty("mid", "140813.93");
  });
});

describe("ingest_many", () => {
  test("PullPath_validPayload_isAcceptedWithFreshness", () => {
    const { service: s } = service();
    const accepted = s.ingest_many([payload()]);

    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.freshness).toBe("fresh");
    expect(accepted[0]?.quote.mid).toBe(1_408_139_300n);
  });

  test("PullPath_nullAndUndefined_areSkippedWithoutRejection", () => {
    const { service: s } = service();
    const rejections: IngestResult[] = [];
    s.on_rejection((r) => rejections.push(r));

    expect(s.ingest_many([null, undefined])).toHaveLength(0);
    // Absent data is not malformed data; it must not inflate the rejection count.
    expect(rejections).toHaveLength(0);
  });

  test("PullPath_malformedPayload_isRejectedAndReported", () => {
    const { service: s } = service();
    const rejections: IngestResult[] = [];
    s.on_rejection((r) => rejections.push(r));

    expect(s.ingest_many([{ not: "a quote" }])).toHaveLength(0);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ outcome: "rejected", reason: "invalid_schema" });
  });

  /** The same quote arriving by both the push and pull paths must publish once. */
  test("PullPath_duplicate_isRejectedOnTheSecondArrival", () => {
    const { service: s } = service();

    expect(s.ingest_many([payload()])).toHaveLength(1);
    expect(s.ingest_many([payload()])).toHaveLength(0);
  });

  test("PullPath_notifiesQuoteListeners_exactlyAsThePushPathDoes", () => {
    const { service: s } = service();
    const seen: string[] = [];
    s.on_quote((snapshot) => seen.push(snapshot.quote.symbol));

    s.ingest_many([payload()]);

    expect(seen).toEqual(["XAU_INR"]);
  });

  test("PullPath_mixedBatch_acceptsOnlyTheValidOnes", () => {
    const { service: s } = service();

    const accepted = s.ingest_many([
      payload({ quote_id: "a", sequence: 1 }),
      { rubbish: true },
      null,
      payload({
        quote_id: "b",
        sequence: 2,
        symbol: "XAG_INR",
        metal: "SILVER",
        source_unit: "per_kilogram",
        mid: "236908",
      }),
    ]);

    expect(accepted.map((a) => a.quote.symbol)).toEqual(["XAU_INR", "XAG_INR"]);
  });

  test("PullPath_emptyBatch_isHarmless", () => {
    const { service: s } = service();
    expect(s.ingest_many([])).toHaveLength(0);
  });
});
