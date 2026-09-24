/**
 * Leader election, against real Redis.
 *
 * The property that matters is not "a leader exists" but "only one does",
 * because the whole reason the poller is elected is that N replicas would
 * otherwise make N times the provider calls. Faked Redis cannot demonstrate
 * that; the real `SET NX PX` is what provides it.
 *
 * The lease's failure assumptions are documented on `LeaderLock` itself. These
 * tests cover the behaviour it does guarantee: mutual exclusion while the lease
 * is held, takeover after it lapses, and no takeover while it is renewed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { RedisClientType } from "redis";
import { system_clock } from "../../src/platform/clock.js";
import { LeaderLock, LeaderLockError } from "../../src/platform/leader_lock.js";
import { redis_client } from "./fixtures.js";

const KEY = "test:leader:market-poller";
const clock = system_clock;

let redis: RedisClientType;
const locks: LeaderLock[] = [];

function make_lock(ttl_ms: number, token: string): LeaderLock {
  const lock = new LeaderLock(
    redis,
    clock,
    {
      key: KEY,
      ttl_ms,
      renew_interval_ms: Math.max(50, Math.floor(ttl_ms / 3)),
      retry_interval_ms: 100,
    },
    token,
  );
  locks.push(lock);
  return lock;
}

/** Poll until `predicate` holds or the budget runs out. */
async function until(predicate: () => boolean, budget_ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + budget_ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

beforeAll(async () => {
  redis = await redis_client();
});

beforeEach(async () => {
  await redis.del(KEY);
  await redis.del(`${KEY}:fence`);
});

afterEach(async () => {
  await Promise.allSettled(locks.splice(0).map((lock) => lock.stop()));
  await redis.del(KEY);
});

afterAll(async () => {
  await redis.quit();
});

describe("mutual exclusion", () => {
  test("Leader_singleReplica_becomesLeader", async () => {
    const lock = make_lock(2_000, "replica-a");
    lock.start();

    expect(await until(() => lock.state().is_leader)).toBe(true);
    expect(lock.state().fencing_token).toBeGreaterThan(0);
    expect(lock.state().since).not.toBeNull();
  });

  /** The property the provider's bill depends on. */
  test("Leader_threeReplicas_exactlyOneIsLeader", async () => {
    const replicas = ["a", "b", "c"].map((id) => make_lock(3_000, `replica-${id}`));
    for (const replica of replicas) replica.start();

    expect(await until(() => replicas.some((r) => r.state().is_leader))).toBe(true);

    // Hold for a few renewal cycles; no second replica may join.
    for (let i = 0; i < 20; i += 1) {
      const leaders = replicas.filter((r) => r.state().is_leader);
      expect(leaders.length).toBeLessThanOrEqual(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(replicas.filter((r) => r.state().is_leader)).toHaveLength(1);
  });

  test("Leader_followers_doNotHoldTheLease", async () => {
    const a = make_lock(3_000, "replica-a");
    const b = make_lock(3_000, "replica-b");

    a.start();
    expect(await until(() => a.state().is_leader)).toBe(true);

    b.start();
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(b.state().is_leader).toBe(false);
    expect(b.state().fencing_token).toBeNull();
    expect(await redis.get(KEY)).toBe("replica-a");
  });
});

describe("renewal and takeover", () => {
  /** A working leader must not lose the lease simply because it expires. */
  test("Leader_renews_andKeepsTheLeaseBeyondItsTtl", async () => {
    const lock = make_lock(600, "replica-a");
    lock.start();

    expect(await until(() => lock.state().is_leader)).toBe(true);
    const token = lock.state().fencing_token;

    // Several TTLs' worth of wall time.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(lock.state().is_leader).toBe(true);
    // Still the same leadership, not a re-acquisition after a lapse.
    expect(lock.state().fencing_token).toBe(token);
  });

  test("Leader_graceful_stopReleasesTheLeaseImmediately", async () => {
    const a = make_lock(10_000, "replica-a");
    a.start();
    expect(await until(() => a.state().is_leader)).toBe(true);

    const b = make_lock(10_000, "replica-b");
    b.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(b.state().is_leader).toBe(false);

    // Without an explicit release, b would wait out a 10s lease.
    await a.stop();

    expect(await until(() => b.state().is_leader, 3_000)).toBe(true);
    expect(a.state().is_leader).toBe(false);
  });

  /**
   * A leader that dies without releasing — a crashed replica — must be taken
   * over once its lease lapses.
   */
  test("Leader_deadLeader_isTakenOverAfterTheLeaseLapses", async () => {
    // Simulate a crashed holder: the key exists but nobody is renewing it.
    await redis.set(KEY, "crashed-replica", { PX: 500 });

    const b = make_lock(2_000, "replica-b");
    b.start();

    expect(b.state().is_leader).toBe(false);
    expect(await until(() => b.state().is_leader, 5_000)).toBe(true);
    expect(await redis.get(KEY)).toBe("replica-b");
  });

  /** Each acquisition gets a strictly higher token, so a stale one is detectable. */
  test("Leader_fencingToken_increasesAcrossHandovers", async () => {
    const a = make_lock(1_000, "replica-a");
    a.start();
    expect(await until(() => a.state().is_leader)).toBe(true);
    const first = a.state().fencing_token ?? 0;

    await a.stop();

    const b = make_lock(1_000, "replica-b");
    b.start();
    expect(await until(() => b.state().is_leader)).toBe(true);

    expect(b.state().fencing_token ?? 0).toBeGreaterThan(first);
  });
});

describe("safety", () => {
  /**
   * Release is a compare-and-delete. A replica that has already lost the lease
   * must not be able to delete its successor's.
   */
  test("Leader_stoppingAFormerLeader_doesNotDeleteTheNewLease", async () => {
    const a = make_lock(400, "replica-a");
    a.start();
    expect(await until(() => a.state().is_leader)).toBe(true);

    // Take the lease away underneath it, as an expiry-plus-takeover would.
    await redis.set(KEY, "replica-b");
    expect(await until(() => !a.state().is_leader, 3_000)).toBe(true);

    await a.stop();

    // b's lease survives a's shutdown.
    expect(await redis.get(KEY)).toBe("replica-b");
  });

  test("Leader_renewIntervalAboveTtl_isRejectedAtConstruction", () => {
    expect(
      () =>
        new LeaderLock(redis, clock, {
          key: KEY,
          ttl_ms: 1_000,
          renew_interval_ms: 1_000,
          retry_interval_ms: 100,
        }),
    ).toThrow(LeaderLockError);
  });

  test("Leader_stopBeforeStart_isHarmless", async () => {
    const lock = make_lock(1_000, "replica-never-started");
    await expect(lock.stop()).resolves.toBeUndefined();
    expect(lock.state().is_leader).toBe(false);
  });
});
