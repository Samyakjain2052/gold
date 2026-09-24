/**
 * Assembles the rate pipeline.
 *
 * One place where the provider, the poller, the leader lease and the outbox
 * publisher are constructed and connected, so `index.ts` stays a composition
 * root rather than a wiring diagram, and tests can build the same pipeline
 * against real PostgreSQL and Redis.
 *
 * ## Provider selection
 *
 * Only the mock provider is constructible today, and `config.ts` refuses it in
 * production. A licensed provider is added here — one `case` — and nothing
 * downstream changes: the poller, publication, outbox, Redis, SSE and the
 * frontend all consume the abstraction, not the vendor.
 */
import type { PrismaClient } from "@prisma/client";
import type { RedisClientType } from "redis";
import type { AppConfig } from "../../platform/config.js";
import type { Logger } from "../../platform/logger.js";
import type { Clock } from "../../platform/clock.js";
import type { ComponentHealth } from "../../platform/health.js";
import { LeaderLock, default_lock_options } from "../../platform/leader_lock.js";
import { MarketDataService } from "../market_data/market_data_service.js";
import { MarketPoller } from "../market_data/market_poller.js";
import { MockMarketDataProvider } from "../market_data/mock_provider.js";
import type { MarketDataProvider } from "../market_data/provider.js";
import type { Freshness, QuoteSnapshot } from "../market_data/types.js";
import { OutboxPublisher } from "./outbox_publisher.js";
import {
  pipeline_detail,
  pipeline_health,
  type PipelineSnapshot,
} from "./pipeline_health.js";
import { recompute_rule_in_transaction } from "./publication_service.js";
import type { Prisma } from "@prisma/client";

export class PipelineConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineConfigError";
  }
}

/**
 * Build the configured provider.
 *
 * The mock is gated twice: `config.ts` refuses `MARKET_DATA_PROVIDER=mock` in
 * production before this is reached, and this refuses to construct a simulated
 * provider in production regardless. Two independent checks, because a
 * simulated price reaching a customer is the most damaging thing this system
 * can do.
 */
export function create_provider(config: AppConfig, clock: Clock): MarketDataProvider {
  if (config.MARKET_DATA_PROVIDER === "mock") {
    if (config.NODE_ENV === "production") {
      throw new PipelineConfigError(
        "refusing to construct the mock provider in production",
      );
    }
    return polling_mock(new MockMarketDataProvider(clock));
  }

  // Every other provider is licence-blocked and has no adapter. Reaching here
  // means configuration allowed a provider that does not exist yet, which must
  // fail loudly rather than start a service that silently never publishes.
  throw new PipelineConfigError(
    `no adapter is implemented for MARKET_DATA_PROVIDER="${config.MARKET_DATA_PROVIDER}". ` +
      "See docs/production-provider-readiness.md.",
  );
}

/**
 * Make the mock behave like a polling adapter.
 *
 * `MockMarketDataProvider` is deliberately driven rather than timed — its
 * simulated behaviours (silence, drift, bad ticks) are reproducible only if a
 * test decides when a price moves. That makes it correct as a simulator and
 * useless to a poller, whose `get_latest_quotes` would return the same stale
 * payload forever, or nothing at all before the first tick.
 *
 * A real polling adapter produces a current observation on each poll, so this
 * advances the simulation once per poll and then reads it. The wrapper lives
 * here rather than in the poller because it is a property of this one
 * provider: the poller must not know which vendor it is driving.
 */
function polling_mock(mock: MockMarketDataProvider): MarketDataProvider {
  return {
    name: mock.name,
    source: mock.source,
    is_simulated: mock.is_simulated,
    start: () => mock.start(),
    stop: () => mock.stop(),
    subscribe: (listener) => mock.subscribe(listener),
    on_status: (listener) => mock.on_status(listener),
    health: () => mock.health(),
    get_latest_quotes: async (symbols) => {
      mock.tick();
      return mock.get_latest_quotes(symbols);
    },
  };
}

export interface RatePipeline {
  readonly service: MarketDataService;
  readonly poller: MarketPoller;
  readonly publisher: OutboxPublisher;
  readonly lock: LeaderLock;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Health for `/health/ready`. */
  health(): ComponentHealth;
  /** Operator detail for `/health/market-data`. */
  detail(): object;
  snapshot(): PipelineSnapshot;
  /** The hook the pricing API uses to republish on a rule change. */
  recompute_rule(
    tx: Prisma.TransactionClient,
    tenant_id: string,
    rule_id: string,
  ): Promise<boolean>;
}

export function create_rate_pipeline(deps: {
  readonly config: AppConfig;
  readonly db: PrismaClient;
  readonly redis: RedisClientType;
  readonly logger: Logger;
  readonly clock: Clock;
}): RatePipeline {
  const { config, db, redis, logger, clock } = deps;

  const provider = create_provider(config, clock);

  const service = new MarketDataService(provider, clock, {
    freshness: {
      stale_after_ms: config.FRESHNESS_STALE_AFTER_MS,
      expired_after_ms: config.FRESHNESS_EXPIRED_AFTER_MS,
    },
  });

  const lock = new LeaderLock(
    redis,
    clock,
    default_lock_options(config.MARKET_POLLER_LEADER_LOCK_TTL_MS),
  );

  const publication = { db, logger, clock };

  const poller = new MarketPoller(service, lock, publication, logger, clock, {
    symbols: config.MARKET_DATA_SYMBOLS,
    interval_ms: config.MARKET_POLL_INTERVAL_MS,
  });

  const publisher = new OutboxPublisher(db, redis, logger);

  service.on_rejection((rejection) => {
    logger.warn(
      {
        event: "market_data.quote_rejected",
        reason: rejection.reason,
        detail: rejection.detail,
      },
      "provider quote rejected",
    );
  });

  function snapshot(): PipelineSnapshot {
    const snapshots: QuoteSnapshot[] = service.snapshots();

    // The best freshness across symbols: one fresh symbol means the feed is
    // alive, even if another has not ticked recently.
    const order: Record<Freshness, number> = { fresh: 0, stale: 1, expired: 2 };
    const freshness =
      snapshots.length === 0
        ? null
        : snapshots
            .map((s) => s.freshness)
            .reduce((best, next) => (order[next] < order[best] ? next : best));

    const last_quote_at = snapshots.reduce<Date | null>((latest, s) => {
      const at = s.quote.received_at;
      return latest === null || at > latest ? at : latest;
    }, null);

    return {
      provider: service.health(),
      poller: poller.stats(),
      outbox: publisher.stats(),
      freshness,
      last_quote_at,
      symbols: snapshots.length,
    };
  }

  return {
    service,
    poller,
    publisher,
    lock,

    async start(): Promise<void> {
      if (!config.MARKET_POLLER_ENABLED) {
        logger.warn(
          { event: "pipeline.poller_disabled" },
          "MARKET_POLLER_ENABLED is false; no rates will be published by this replica",
        );
      } else {
        await poller.start();
      }

      // The publisher runs regardless of the poller flag: a replica that does
      // not poll can still drain events another replica committed.
      publisher.start();

      logger.info(
        {
          event: "pipeline.started",
          provider: provider.name,
          is_simulated: provider.is_simulated,
          symbols: config.MARKET_DATA_SYMBOLS,
          poll_interval_ms: config.MARKET_POLL_INTERVAL_MS,
        },
        "rate pipeline started",
      );
    },

    async stop(): Promise<void> {
      await poller.stop().catch(() => {});
      await publisher.stop().catch(() => {});
      // One last drain so events committed moments before shutdown are not
      // left for the next leader to find a lease-length later.
      await publisher.drain().catch(() => {});
    },

    health: () => pipeline_health(snapshot(), config.is_production, clock.date()),
    detail: () => pipeline_detail(snapshot()),
    snapshot,

    recompute_rule: (tx, tenant_id, rule_id) =>
      recompute_rule_in_transaction(tx, {
        tenant_id,
        rule_id,
        resolve_snapshot: (metal) => {
          // Pick the freshest usable quote for the metal. `resolve_base_rate`
          // is per symbol; a rule is per metal, so the symbol is resolved here.
          for (const s of service.snapshots()) {
            if (s.quote.metal === metal && s.freshness !== "expired") return s;
          }
          return null;
        },
        logger,
        now: clock.date(),
      }),
  };
}
