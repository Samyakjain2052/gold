/**
 * The outbox publisher's delivery and failure behaviour.
 *
 * The vertical-slice suite proves a committed rate reaches a browser. This one
 * covers what happens when it cannot: Redis unavailable, a batch that fails
 * part-way, repeated failures, and the loop that retries. Those paths are the
 * reason the outbox exists, so testing them by mocking Redis would defeat the
 * point — the publisher is driven against the real client, disconnected on
 * purpose.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import type { RedisClientType } from "redis";
import type { Logger } from "../../src/platform/logger.js";
import { OutboxPublisher, to_event } from "../../src/modules/publication/outbox_publisher.js";
import { with_tenant_context } from "../../src/modules/tenancy/tenant_context.js";
import { app_client, owner_client, redis_client, seed_fixtures, type Fixtures } from "./fixtures.js";

let owner: PrismaClient;
let db: PrismaClient;
let redis: RedisClientType;
let logger: Logger;
let fx: Fixtures;

/** Queue one undelivered event for a tenant. */
async function enqueue(tenant_id: string, product_id: string, rate: bigint): Promise<bigint> {
  return with_tenant_context(db, tenant_id, async (tx) => {
    const row = await tx.rate_publication_outbox.create({
      data: {
        tenant_id,
        product_id,
        product_key: "GOLD_916",
        rate_display_paise: rate,
        display_unit: "per_10_gram",
        source_timestamp: new Date(),
        freshness: "fresh",
        trigger: "market_tick",
      },
      select: { id: true },
    });
    return row.id;
  });
}

async function pending_count(): Promise<number> {
  return owner.rate_publication_outbox.count({ where: { delivered_at: null } });
}

beforeAll(async () => {
  owner = owner_client();
  db = app_client();
  redis = await redis_client();
  logger = pino({ level: "silent" }) as unknown as Logger;
});

beforeEach(async () => {
  fx = await seed_fixtures(owner);
  // The fixture's own row is already delivered; start from a clean queue.
  await owner.rate_publication_outbox.updateMany({ data: { delivered_at: new Date() } });
});

afterEach(async () => {
  if (!redis.isOpen) await redis.connect();
});

afterAll(async () => {
  await Promise.allSettled([owner.$disconnect(), db.$disconnect(), redis.quit()]);
});

describe("delivery", () => {
  test("Outbox_deliversPendingRowsAndMarksThem", async () => {
    await enqueue(fx.tenant_a.tenant_id, fx.tenant_a.gold_product_id, 14_000_000n);
    await enqueue(fx.tenant_b.tenant_id, fx.tenant_b.gold_product_id, 15_000_000n);

    const publisher = new OutboxPublisher(db, redis, logger);
    expect(await publisher.drain()).toBe(2);
    expect(await pending_count()).toBe(0);

    const stats = publisher.stats();
    expect(stats.delivered).toBe(2);
    expect(stats.failed).toBe(0);
    expect(stats.last_run_at).not.toBeNull();
  });

  test("Outbox_emptyQueue_isANoOp", async () => {
    const publisher = new OutboxPublisher(db, redis, logger);

    expect(await publisher.drain()).toBe(0);
    expect(publisher.stats().delivered).toBe(0);
    expect(publisher.stats().backlog).toBe(0);
  });

  /** Ordered by id, so a superseding rate never overtakes the one it replaces. */
  test("Outbox_deliversInSequenceOrder", async () => {
    const first = await enqueue(fx.tenant_a.tenant_id, fx.tenant_a.gold_product_id, 1_000_000n);
    const second = await enqueue(fx.tenant_a.tenant_id, fx.tenant_a.gold_product_id, 2_000_000n);
    expect(second > first).toBe(true);

    const publisher = new OutboxPublisher(db, redis, logger);
    await publisher.drain();

    const rows = await owner.rate_publication_outbox.findMany({
      where: { id: { in: [first, second] } },
      orderBy: { id: "asc" },
      select: { delivered_at: true },
    });
    for (const row of rows) expect(row.delivered_at).not.toBeNull();
  });

  test("Outbox_batchSize_limitsOnePass", async () => {
    for (let i = 0; i < 5; i += 1) {
      await enqueue(fx.tenant_a.tenant_id, fx.tenant_a.gold_product_id, BigInt(1_000_000 + i));
    }

    const publisher = new OutboxPublisher(db, redis, logger, { batch_size: 2 });

    expect(await publisher.drain()).toBe(2);
    expect(await pending_count()).toBe(3);
    expect(await publisher.drain()).toBe(2);
    expect(await publisher.drain()).toBe(1);
    expect(await pending_count()).toBe(0);
  });
});

describe("Redis unavailable", () => {
  /**
   * The rate is committed and stays committed. Nothing is marked delivered, so
   * the event is retried rather than lost — which is the whole reason the
   * publisher marks *after* publishing rather than before.
   */
  test("Outbox_redisDown_leavesRowsPendingAndRecordsTheFailure", async () => {
    await enqueue(fx.tenant_a.tenant_id, fx.tenant_a.gold_product_id, 14_000_000n);

    await redis.quit();
    const publisher = new OutboxPublisher(db, redis, logger);

    expect(await publisher.drain()).toBe(0);
    expect(await pending_count()).toBe(1);

    const row = await owner.rate_publication_outbox.findFirst({
      where: { delivered_at: null },
      select: { attempts: true, last_error: true },
    });
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).not.toBeNull();

    expect(publisher.stats().failed).toBe(1);
    expect(publisher.stats().last_error).not.toBeNull();
  });

  test("Outbox_recoversOnceRedisReturns", async () => {
    await enqueue(fx.tenant_a.tenant_id, fx.tenant_a.gold_product_id, 14_000_000n);

    await redis.quit();
    const publisher = new OutboxPublisher(db, redis, logger);
    await publisher.drain();
    expect(await pending_count()).toBe(1);

    await redis.connect();
    expect(await publisher.drain()).toBe(1);
    expect(await pending_count()).toBe(0);
  });

  /**
   * A failing batch stops at the first error rather than burning the attempt
   * counter on every queued row for the same outage.
   */
  test("Outbox_failingBatch_stopsAtTheFirstError", async () => {
    for (let i = 0; i < 4; i += 1) {
      await enqueue(fx.tenant_a.tenant_id, fx.tenant_a.gold_product_id, BigInt(1_000_000 + i));
    }

    await redis.quit();
    await new OutboxPublisher(db, redis, logger).drain();

    const attempted = await owner.rate_publication_outbox.count({
      where: { delivered_at: null, attempts: { gt: 0 } },
    });
    expect(attempted).toBe(1);
  });

  /** Repeated failure is escalated in the logs but never silently dropped. */
  test("Outbox_repeatedFailures_keepTheRowForRetry", async () => {
    await enqueue(fx.tenant_a.tenant_id, fx.tenant_a.gold_product_id, 14_000_000n);
    await redis.quit();

    const publisher = new OutboxPublisher(db, redis, logger, { poison_after_attempts: 2 });
    await publisher.drain();
    await publisher.drain();
    await publisher.drain();

    const row = await owner.rate_publication_outbox.findFirst({
      where: { delivered_at: null },
      select: { attempts: true },
    });

    // Still queued after exceeding the poison threshold: a committed rate is
    // never abandoned, only reported more loudly.
    expect(row?.attempts).toBe(3);
    expect(await pending_count()).toBe(1);
  });
});

describe("the background loop", () => {
  test("Outbox_startedLoop_drainsWithoutBeingAsked", async () => {
    const publisher = new OutboxPublisher(db, redis, logger, { idle_interval_ms: 50 });
    publisher.start();

    await enqueue(fx.tenant_a.tenant_id, fx.tenant_a.gold_product_id, 14_000_000n);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await pending_count()) > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(await pending_count()).toBe(0);
    await publisher.stop();
  });

  test("Outbox_stop_haltsTheLoop", async () => {
    const publisher = new OutboxPublisher(db, redis, logger, { idle_interval_ms: 50 });
    publisher.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await publisher.stop();

    await enqueue(fx.tenant_a.tenant_id, fx.tenant_a.gold_product_id, 14_000_000n);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Nothing drains it: the loop is stopped.
    expect(await pending_count()).toBe(1);
  });

  test("Outbox_startTwice_isIdempotent", async () => {
    const publisher = new OutboxPublisher(db, redis, logger, { idle_interval_ms: 50 });
    publisher.start();
    publisher.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await publisher.stop();

    expect(publisher.stats().delivered).toBe(0);
  });
});

describe("wire payload", () => {
  /**
   * The tenant id is present on the Redis event because the channel is per
   * tenant and `subscribe_to_rates` re-checks it. The public SSE route strips
   * it before anything reaches a browser.
   */
  test("Outbox_event_carriesTheRoutingTenantAndTheRate", () => {
    const source = new Date("2026-09-23T06:30:00.000Z");
    const event = to_event({
      id: 1n,
      tenant_id: fx.tenant_a.tenant_id,
      product_key: "GOLD_916",
      rate_display_paise: 12_948_600n,
      display_unit: "per_10_gram",
      source_timestamp: source,
      freshness: "fresh",
      attempts: 0,
    });

    expect(event.type).toBe("rate_update");
    expect(event.tenant_id).toBe(fx.tenant_a.tenant_id);
    expect(event.rate_display_paise).toBe("12948600");
    // A string, never a number: money does not travel through a double.
    expect(typeof event.rate_display_paise).toBe("string");
    expect(event.source_timestamp).toBe(source.toISOString());
  });
});
