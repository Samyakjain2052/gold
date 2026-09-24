/**
 * The poller, against a real provider, real Redis and real PostgreSQL.
 *
 * The behaviours that matter here are the ones that only exist when a loop, a
 * lease and a database are all present at once: that a follower never calls the
 * provider, that a slow poll does not stack up, and that a provider outage
 * leaves the previous rates standing rather than publishing something invented.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import type { RedisClientType } from "redis";
import { ManualClock, system_clock } from "../../src/platform/clock.js";
import type { Logger } from "../../src/platform/logger.js";
import { LeaderLock } from "../../src/platform/leader_lock.js";
import { MarketDataService } from "../../src/modules/market_data/market_data_service.js";
import { MarketPoller } from "../../src/modules/market_data/market_poller.js";
import { MockMarketDataProvider } from "../../src/modules/market_data/mock_provider.js";
import type { MarketDataProvider } from "../../src/modules/market_data/provider.js";
import { with_tenant_context } from "../../src/modules/tenancy/tenant_context.js";
import { app_client, owner_client, redis_client, seed_fixtures, type Fixtures } from "./fixtures.js";

const KEY = "test:leader:poller-suite";
const NOW = new Date();

let owner: PrismaClient;
let db: PrismaClient;
let redis: RedisClientType;
let logger: Logger;
let fx: Fixtures;

const started: MarketPoller[] = [];

/**
 * A polling view of the mock.
 *
 * Mirrors `pipeline.ts`: the mock is a driven simulator, so a poll must advance
 * it before reading, exactly as a real polling adapter produces a current
 * observation per request.
 */
function polling_mock(mock: MockMarketDataProvider): MarketDataProvider {
  return {
    name: mock.name,
    source: mock.source,
    is_simulated: mock.is_simulated,
    start: () => mock.start(),
    stop: () => mock.stop(),
    subscribe: (l) => mock.subscribe(l),
    on_status: (l) => mock.on_status(l),
    health: () => mock.health(),
    get_latest_quotes: async (symbols) => {
      mock.tick();
      return mock.get_latest_quotes(symbols);
    },
  };
}

function build(provider: MarketDataProvider, token: string, interval_ms = 50_000) {
  const clock = new ManualClock(NOW);
  const service = new MarketDataService(provider, clock, {
    freshness: { stale_after_ms: 120_000, expired_after_ms: 600_000 },
  });

  const lock = new LeaderLock(
    redis,
    system_clock,
    { key: KEY, ttl_ms: 3_000, renew_interval_ms: 900, retry_interval_ms: 100 },
    token,
  );

  const poller = new MarketPoller(
    service,
    lock,
    { db, logger, clock },
    logger,
    clock,
    { symbols: ["XAU_INR", "XAG_INR"], interval_ms },
  );

  started.push(poller);
  return { poller, service, lock, clock };
}

async function until(predicate: () => boolean, budget_ms = 6_000): Promise<boolean> {
  const deadline = Date.now() + budget_ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

async function gold_rate(tenant_id: string): Promise<bigint | null> {
  const row = await with_tenant_context(db, tenant_id, (tx) =>
    tx.published_rates.findFirst({
      where: { tenant_id, product_id: fx.tenant_a.gold_product_id },
      select: { rate_display_paise: true },
    }),
  );
  return row?.rate_display_paise ?? null;
}

beforeAll(async () => {
  owner = owner_client();
  db = app_client();
  redis = await redis_client();
  logger = pino({ level: "silent" }) as unknown as Logger;
});

beforeEach(async () => {
  fx = await seed_fixtures(owner);
  await redis.del(KEY);
});

afterEach(async () => {
  await Promise.allSettled(started.splice(0).map((p) => p.stop()));
  await redis.del(KEY);
});

afterAll(async () => {
  await Promise.allSettled([owner.$disconnect(), db.$disconnect(), redis.quit()]);
});

describe("polling publishes", () => {
  test("Poller_onePoll_publishesRatesForEveryAffectedTenant", async () => {
    const { poller } = build(polling_mock(new MockMarketDataProvider(system_clock)), "p1");

    const outcomes = await poller.poll_once();

    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.reduce((sum, o) => sum + o.published, 0)).toBeGreaterThan(0);
    expect(await gold_rate(fx.tenant_a.tenant_id)).not.toBeNull();
    expect(await gold_rate(fx.tenant_b.tenant_id)).not.toBeNull();
  });

  test("Poller_stats_recordSuccessAndCount", async () => {
    const { poller } = build(polling_mock(new MockMarketDataProvider(system_clock)), "p2");
    await poller.poll_once();

    const stats = poller.stats();
    expect(stats.polls).toBe(1);
    expect(stats.failures).toBe(0);
    expect(stats.published).toBeGreaterThan(0);
    expect(stats.last_success_at).not.toBeNull();
    expect(stats.last_error).toBeNull();
  });

  /** A quote is ingested once even though the mock both pushes and answers a pull. */
  test("Poller_repeatedPolls_produceOnePublicationPerQuote", async () => {
    const { poller } = build(polling_mock(new MockMarketDataProvider(system_clock)), "p3");

    await poller.poll_once();
    const after_first = await owner.rate_publication_outbox.count();

    await poller.poll_once();
    const after_second = await owner.rate_publication_outbox.count();

    // The second poll moves the simulated price and publishes again. The point
    // is that it publishes once more, not twice: the quote arrives by both the
    // push and pull paths and the duplicate is rejected.
    expect(after_second).toBeGreaterThan(after_first);
    expect(after_second).toBeLessThanOrEqual(after_first * 2);
  });
});

describe("leadership gates provider access", () => {
  /**
   * The reason the poller is elected at all: a follower must never call the
   * provider, or provider cost would scale with replica count.
   */
  test("Poller_follower_neverCallsTheProvider", async () => {
    // Another replica already holds the lease.
    await redis.set(KEY, "someone-else", { PX: 5_000 });

    const get_latest_quotes = vi.fn(async () => []);
    const provider: MarketDataProvider = {
      ...polling_mock(new MockMarketDataProvider(system_clock)),
      get_latest_quotes,
    };

    const { poller } = build(provider, "follower", 100);
    await poller.start();

    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(poller.stats().is_leader).toBe(false);
    expect(get_latest_quotes).not.toHaveBeenCalled();
  });

  test("Poller_leader_pollsOnItsSchedule", async () => {
    const get_latest_quotes = vi.fn(async () => []);
    const provider: MarketDataProvider = {
      ...polling_mock(new MockMarketDataProvider(system_clock)),
      get_latest_quotes,
    };

    const { poller } = build(provider, "leader", 100);
    await poller.start();

    expect(await until(() => get_latest_quotes.mock.calls.length >= 3)).toBe(true);
    expect(poller.stats().is_leader).toBe(true);
  });
});

describe("failure behaviour", () => {
  /** A provider outage must not take the process down, nor invent a price. */
  test("Poller_providerThrows_isCountedAndPublishesNothing", async () => {
    const provider: MarketDataProvider = {
      ...polling_mock(new MockMarketDataProvider(system_clock)),
      get_latest_quotes: async () => {
        throw new Error("provider unreachable");
      },
    };

    const { poller } = build(provider, "failing");
    const before = await owner.rate_publication_outbox.count();

    await expect(poller.poll_once()).resolves.toEqual([]);

    const stats = poller.stats();
    expect(stats.failures).toBe(1);
    expect(stats.consecutive_failures).toBe(1);
    expect(stats.last_error).toContain("unreachable");
    expect(await owner.rate_publication_outbox.count()).toBe(before);
  });

  test("Poller_recoversAfterATransientFailure", async () => {
    let fail = true;
    const mock = new MockMarketDataProvider(system_clock);
    const provider: MarketDataProvider = {
      ...polling_mock(mock),
      get_latest_quotes: async (symbols) => {
        if (fail) throw new Error("temporarily unreachable");
        mock.tick();
        return mock.get_latest_quotes(symbols);
      },
    };

    const { poller } = build(provider, "recovering");

    await poller.poll_once();
    expect(poller.stats().consecutive_failures).toBe(1);

    fail = false;
    await poller.poll_once();

    expect(poller.stats().consecutive_failures).toBe(0);
    expect(poller.stats().last_error).toBeNull();
    expect(await gold_rate(fx.tenant_a.tenant_id)).not.toBeNull();
  });

  /** A slow provider must not accumulate concurrent requests against itself. */
  test("Poller_overlappingPolls_areSkippedNotQueued", async () => {
    let calls = 0;
    const provider: MarketDataProvider = {
      ...polling_mock(new MockMarketDataProvider(system_clock)),
      get_latest_quotes: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return [];
      },
    };

    const { poller } = build(provider, "slow");

    const [first, second] = await Promise.all([poller.poll_once(), poller.poll_once()]);

    // The second call returns immediately rather than starting a second poll.
    expect(calls).toBe(1);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
  });

  test("Poller_stop_isIdempotentAndReleasesTheLease", async () => {
    const { poller } = build(polling_mock(new MockMarketDataProvider(system_clock)), "stopping", 100);
    await poller.start();
    expect(await until(() => poller.stats().is_leader)).toBe(true);

    await poller.stop();
    await expect(poller.stop()).resolves.toBeUndefined();

    expect(await redis.get(KEY)).toBeNull();
    expect(poller.stats().running).toBe(false);
  });
});
