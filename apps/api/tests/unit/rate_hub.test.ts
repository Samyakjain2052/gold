/**
 * Per-replica realtime fan-out.
 *
 * The hub exists so that N browsers watching one shop cost one Redis
 * subscription rather than N. These tests pin down the three things that go
 * wrong with that design if it is written carelessly: a shared subscription
 * torn down while someone is still using it, a listener leaked after its
 * connection closed, and one tenant's listeners being offered another tenant's
 * event.
 *
 * Redis is faked. What is under test is the multiplexing, not the driver.
 */
import { describe, expect, test, vi } from "vitest";
import type { RedisClientType } from "redis";
import {
  create_rate_hub,
  RateHubCapacityError,
  type RateHub,
} from "../../src/modules/realtime/rate_hub.js";
import { CHANNEL_PREFIX, type RateEvent } from "../../src/modules/realtime/rate_channel.js";
import { RealtimeAuthorizationError } from "../../src/modules/realtime/rate_channel.js";
import type { TenantContext } from "../../src/modules/tenancy/tenant_context.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

function public_context(tenant_id: string, slug = "a-shop"): TenantContext {
  return { kind: "public", tenant_id, slug };
}

/** Minimal stand-in for a node-redis client in subscriber mode. */
function fake_subscriber() {
  const handlers = new Map<string, (message: string) => void>();
  const subscribe = vi.fn(async (channel: string, handler: (message: string) => void) => {
    handlers.set(channel, handler);
  });
  const unsubscribe = vi.fn(async (channel: string) => {
    handlers.delete(channel);
  });

  return {
    client: { subscribe, unsubscribe } as unknown as RedisClientType,
    subscribe,
    unsubscribe,
    /** Simulate Redis delivering a raw message on a tenant's channel. */
    emit(tenant_id: string, raw: string) {
      handlers.get(`${CHANNEL_PREFIX}${tenant_id}`)?.(raw);
    },
    channels: () => [...handlers.keys()],
  };
}

function event(tenant_id: string, rate = "14081393"): RateEvent {
  return {
    type: "rate_update",
    tenant_id,
    product_key: "GOLD_916",
    rate_display_paise: rate,
    display_unit: "gram",
    source_timestamp: "2026-09-20T12:00:00.000Z",
    freshness: "fresh",
    emitted_at: "2026-09-20T12:00:01.000Z",
  };
}

function hub_for(subscriber: RedisClientType, max_listeners = 100): RateHub {
  return create_rate_hub(subscriber, { max_listeners });
}

describe("fan-out", () => {
  test("Hub_twoListenersSameTenant_shareOneRedisSubscription", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client);

    await hub.attach(public_context(TENANT_A), TENANT_A, () => {});
    await hub.attach(public_context(TENANT_A), TENANT_A, () => {});

    expect(redis.subscribe).toHaveBeenCalledTimes(1);
    expect(hub.listener_count()).toBe(2);
    expect(hub.channel_count()).toBe(1);
  });

  test("Hub_eventReachesEveryListenerForThatTenant", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client);

    const seen: string[] = [];
    await hub.attach(public_context(TENANT_A), TENANT_A, (e) => seen.push(`one:${e.rate_display_paise}`));
    await hub.attach(public_context(TENANT_A), TENANT_A, (e) => seen.push(`two:${e.rate_display_paise}`));

    redis.emit(TENANT_A, JSON.stringify(event(TENANT_A, "14090000")));

    expect(seen).toEqual(["one:14090000", "two:14090000"]);
  });

  /**
   * Concurrent first-subscribers must not each create a subscription; the
   * loser's would be leaked and never unsubscribed.
   */
  test("Hub_simultaneousFirstListeners_createOneSubscription", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client);

    await Promise.all([
      hub.attach(public_context(TENANT_A), TENANT_A, () => {}),
      hub.attach(public_context(TENANT_A), TENANT_A, () => {}),
      hub.attach(public_context(TENANT_A), TENANT_A, () => {}),
    ]);

    expect(redis.subscribe).toHaveBeenCalledTimes(1);
    expect(hub.listener_count()).toBe(3);
  });

  /** One broken response must not stop the others receiving the update. */
  test("Hub_throwingListener_doesNotStarveTheOthers", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client);

    const seen: string[] = [];
    await hub.attach(public_context(TENANT_A), TENANT_A, () => {
      throw new Error("client socket already closed");
    });
    await hub.attach(public_context(TENANT_A), TENANT_A, (e) => seen.push(e.rate_display_paise));

    expect(() => redis.emit(TENANT_A, JSON.stringify(event(TENANT_A)))).not.toThrow();
    expect(seen).toEqual(["14081393"]);
  });
});

describe("isolation", () => {
  test("Hub_tenantAListener_neverReceivesTenantBEvent", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client);

    const a_seen: RateEvent[] = [];
    const b_seen: RateEvent[] = [];
    await hub.attach(public_context(TENANT_A), TENANT_A, (e) => a_seen.push(e));
    await hub.attach(public_context(TENANT_B, "b-shop"), TENANT_B, (e) => b_seen.push(e));

    redis.emit(TENANT_B, JSON.stringify(event(TENANT_B)));

    expect(a_seen).toHaveLength(0);
    expect(b_seen).toHaveLength(1);
  });

  test("Hub_contextForAnotherTenant_isRefused", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client);

    await expect(
      hub.attach(public_context(TENANT_A), TENANT_B, () => {}),
    ).rejects.toBeInstanceOf(RealtimeAuthorizationError);

    expect(redis.subscribe).not.toHaveBeenCalled();
  });

  /**
   * Authorisation runs per listener, not once per channel. Otherwise the first
   * legitimate viewer of a shop would open a channel that any later caller
   * could join regardless of context.
   */
  test("Hub_secondListenerWithWrongContext_isRefusedOnAnOpenChannel", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client);

    await hub.attach(public_context(TENANT_A), TENANT_A, () => {});

    await expect(
      hub.attach(public_context(TENANT_B, "b-shop"), TENANT_A, () => {}),
    ).rejects.toBeInstanceOf(RealtimeAuthorizationError);

    expect(hub.listener_count()).toBe(1);
  });

  test("Hub_platformAdminContext_isRefused", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client);

    await expect(
      hub.attach({ kind: "platform_admin", user_id: "u" }, TENANT_A, () => {}),
    ).rejects.toBeInstanceOf(RealtimeAuthorizationError);
  });

  /** A mis-routed publish carrying another tenant's id is dropped, not relayed. */
  test("Hub_eventWithForeignTenantId_isDropped", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client);

    const seen: RateEvent[] = [];
    await hub.attach(public_context(TENANT_A), TENANT_A, (e) => seen.push(e));

    redis.emit(TENANT_A, JSON.stringify(event(TENANT_B)));

    expect(seen).toHaveLength(0);
  });
});

describe("malformed payloads", () => {
  test.each([
    ["not json", "{not json"],
    ["empty", ""],
    ["a bare array", "[]"],
    ["null", "null"],
  ])("Hub_%s_isDroppedWithoutThrowing", async (_label, raw) => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client);

    const seen: RateEvent[] = [];
    await hub.attach(public_context(TENANT_A), TENANT_A, (e) => seen.push(e));

    expect(() => redis.emit(TENANT_A, raw)).not.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe("teardown", () => {
  test("Hub_lastListenerDetaches_unsubscribesFromRedis", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client);

    const detach = await hub.attach(public_context(TENANT_A), TENANT_A, () => {});
    await detach();

    expect(redis.unsubscribe).toHaveBeenCalledTimes(1);
    expect(hub.listener_count()).toBe(0);
    expect(hub.channel_count()).toBe(0);
  });

  /** The shared subscription must survive one of several viewers leaving. */
  test("Hub_oneOfTwoDetaches_keepsTheSubscription", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client);

    const seen: RateEvent[] = [];
    const detach_first = await hub.attach(public_context(TENANT_A), TENANT_A, () => {});
    await hub.attach(public_context(TENANT_A), TENANT_A, (e) => seen.push(e));

    await detach_first();

    expect(redis.unsubscribe).not.toHaveBeenCalled();
    expect(hub.listener_count()).toBe(1);

    redis.emit(TENANT_A, JSON.stringify(event(TENANT_A)));
    expect(seen).toHaveLength(1);
  });

  /**
   * A closing browser can fire both `req.close` and `res.close`. Detaching
   * twice must not double-decrement the count or drop a channel others use.
   */
  test("Hub_detachCalledTwice_isIdempotent", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client);

    await hub.attach(public_context(TENANT_A), TENANT_A, () => {});
    const detach = await hub.attach(public_context(TENANT_A), TENANT_A, () => {});

    await detach();
    await detach();

    expect(hub.listener_count()).toBe(1);
    expect(redis.unsubscribe).not.toHaveBeenCalled();
  });

  test("Hub_close_dropsEveryListenerAndSubscription", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client);

    await hub.attach(public_context(TENANT_A), TENANT_A, () => {});
    await hub.attach(public_context(TENANT_B, "b-shop"), TENANT_B, () => {});

    await hub.close();

    expect(hub.listener_count()).toBe(0);
    expect(hub.channel_count()).toBe(0);
    expect(redis.unsubscribe).toHaveBeenCalledTimes(2);
  });

  /** A failed subscribe must not leave a channel that later viewers await forever. */
  test("Hub_failedSubscribe_doesNotPoisonTheChannel", async () => {
    const redis = fake_subscriber();
    redis.subscribe.mockRejectedValueOnce(new Error("redis unavailable"));
    const hub = hub_for(redis.client);

    await expect(
      hub.attach(public_context(TENANT_A), TENANT_A, () => {}),
    ).rejects.toThrow("redis unavailable");

    // The next viewer gets a fresh attempt rather than the rejected promise.
    await expect(
      hub.attach(public_context(TENANT_A), TENANT_A, () => {}),
    ).resolves.toBeTypeOf("function");
    expect(hub.listener_count()).toBe(1);
  });
});

describe("capacity", () => {
  test("Hub_atMaxListeners_refusesTheNewestConnection", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client, 2);

    await hub.attach(public_context(TENANT_A), TENANT_A, () => {});
    await hub.attach(public_context(TENANT_A), TENANT_A, () => {});

    await expect(
      hub.attach(public_context(TENANT_A), TENANT_A, () => {}),
    ).rejects.toBeInstanceOf(RateHubCapacityError);

    expect(hub.listener_count()).toBe(2);
  });

  test("Hub_capacityFreedByDetach_admitsTheNextConnection", async () => {
    const redis = fake_subscriber();
    const hub = hub_for(redis.client, 1);

    const detach = await hub.attach(public_context(TENANT_A), TENANT_A, () => {});
    await expect(
      hub.attach(public_context(TENANT_A), TENANT_A, () => {}),
    ).rejects.toBeInstanceOf(RateHubCapacityError);

    await detach();

    await expect(
      hub.attach(public_context(TENANT_A), TENANT_A, () => {}),
    ).resolves.toBeTypeOf("function");
  });
});
