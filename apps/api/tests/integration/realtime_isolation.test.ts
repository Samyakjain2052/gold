/**
 * Tenant isolation at the REALTIME DELIVERY layer.
 *
 * Runs against a real Redis. The scenario from the brief:
 *
 *   Customer A → Tenant A channel
 *   Customer B → Tenant B channel
 *   publish for A  ⇒ A receives, B receives NOTHING
 *   publish for B  ⇒ B receives, A receives NOTHING
 *
 * Asserting "received nothing" needs care: a naive test passes simply because
 * it checked too early. Every negative assertion here waits for the *positive*
 * delivery to land first, then asserts the other subscriber's inbox is still
 * empty — so the wait is bounded by a real event, never by a fixed sleep.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { RedisClientType } from "redis";
import {
  authorize_subscription,
  assert_can_subscribe,
  channel_for,
  publish_rate_event,
  subscribe_to_rates,
  CHANNEL_PREFIX,
  RealtimeAuthorizationError,
  type RateEvent,
  type RateChannelSubscription,
} from "../../src/modules/realtime/rate_channel.js";
import type { PublicTenantContext } from "../../src/modules/tenancy/tenant_context.js";
import {
  owner_client,
  redis_client,
  seed_fixtures,
  type Fixtures,
} from "./fixtures.js";

let owner: PrismaClient;
let publisher: RedisClientType;
let subscriber_a: RedisClientType;
let subscriber_b: RedisClientType;
let fx: Fixtures;

const open_subscriptions: RateChannelSubscription[] = [];

beforeAll(async () => {
  owner = owner_client();
  fx = await seed_fixtures(owner);
  publisher = await redis_client();
  subscriber_a = await redis_client();
  subscriber_b = await redis_client();
});

afterEach(async () => {
  await Promise.allSettled(open_subscriptions.map((s) => s.unsubscribe()));
  open_subscriptions.length = 0;
});

afterAll(async () => {
  await Promise.allSettled([
    owner.$disconnect(),
    publisher.quit(),
    subscriber_a.quit(),
    subscriber_b.quit(),
  ]);
});

function rate_event(tenant_id: string, rate = "14131400"): RateEvent {
  return {
    type: "rate_update",
    tenant_id,
    product_key: "GOLD_916",
    rate_display_paise: rate,
    display_unit: "per_10_gram",
    source_timestamp: new Date().toISOString(),
    freshness: "fresh",
    emitted_at: new Date().toISOString(),
  };
}

/** An inbox that resolves when the next event lands, without polling. */
function inbox() {
  const events: RateEvent[] = [];
  let resolve_next: ((event: RateEvent) => void) | null = null;

  return {
    events,
    handler: (event: RateEvent) => {
      events.push(event);
      resolve_next?.(event);
      resolve_next = null;
    },
    /**
     * Resolves on the next event, or rejects after `timeout_ms`.
     * Call it *before* publishing so the listener is armed and no event can be
     * missed between publish and await.
     */
    next(timeout_ms = 2000): Promise<RateEvent> {
      return new Promise<RateEvent>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no event within ${timeout_ms}ms`)),
          timeout_ms,
        );
        resolve_next = (event) => {
          clearTimeout(timer);
          resolve(event);
        };
      });
    },
  };
}

describe("channel naming", () => {
  test("ChannelFor_tenantId_isNamespacedPerTenant", () => {
    const a = channel_for(fx.tenant_a.tenant_id);
    const b = channel_for(fx.tenant_b.tenant_id);

    expect(a).toBe(`${CHANNEL_PREFIX}${fx.tenant_a.tenant_id}`);
    expect(a).not.toBe(b);
  });

  /** There is deliberately no wildcard or broadcast channel to subscribe to. */
  test("ChannelFor_nonUuid_isRejected", () => {
    for (const bad of ["*", "all", "rates:tenant:*", "", "../admin"]) {
      expect(() => channel_for(bad)).toThrow(RealtimeAuthorizationError);
    }
  });
});

describe("subscription authorization", () => {
  test("Authorize_ownTenant_isPermitted", () => {
    expect(authorize_subscription(fx.tenant_a.context, fx.tenant_a.tenant_id)).toBe(
      true,
    );
  });

  test("Authorize_otherTenant_isDenied", () => {
    expect(authorize_subscription(fx.tenant_a.context, fx.tenant_b.tenant_id)).toBe(
      false,
    );
  });

  test("Authorize_publicContext_isPermittedForItsOwnTenantOnly", () => {
    const public_a: PublicTenantContext = {
      kind: "public",
      tenant_id: fx.tenant_a.tenant_id,
      slug: fx.tenant_a.slug,
    };

    expect(authorize_subscription(public_a, fx.tenant_a.tenant_id)).toBe(true);
    expect(authorize_subscription(public_a, fx.tenant_b.tenant_id)).toBe(false);
  });

  /** An admin session must not be a back door onto a tenant channel. */
  test("Authorize_platformAdmin_isDeniedTenantChannels", () => {
    const admin = { kind: "platform_admin" as const, user_id: randomUUID() };
    expect(authorize_subscription(admin, fx.tenant_a.tenant_id)).toBe(false);
  });

  test("AssertCanSubscribe_crossTenant_throws", () => {
    expect(() =>
      assert_can_subscribe(fx.tenant_a.context, fx.tenant_b.tenant_id),
    ).toThrow(RealtimeAuthorizationError);
  });
});

describe("realtime delivery isolation", () => {
  /** The mandatory scenario from the brief. */
  test("Realtime_publishForTenantA_reachesCustomerAOnly", async () => {
    const box_a = inbox();
    const box_b = inbox();

    open_subscriptions.push(
      await subscribe_to_rates(
        subscriber_a,
        fx.tenant_a.context,
        fx.tenant_a.tenant_id,
        box_a.handler,
      ),
      await subscribe_to_rates(
        subscriber_b,
        fx.tenant_b.context,
        fx.tenant_b.tenant_id,
        box_b.handler,
      ),
    );

    const arrival = box_a.next();
    await publish_rate_event(publisher, rate_event(fx.tenant_a.tenant_id, "14131400"));
    const received = await arrival;

    expect(received.tenant_id).toBe(fx.tenant_a.tenant_id);
    expect(received.rate_display_paise).toBe("14131400");

    // B's inbox is checked only after A's event has demonstrably landed, so
    // "nothing" is a real observation rather than a race.
    expect(box_b.events).toHaveLength(0);
  });

  test("Realtime_publishForTenantB_reachesCustomerBOnly", async () => {
    const box_a = inbox();
    const box_b = inbox();

    open_subscriptions.push(
      await subscribe_to_rates(
        subscriber_a,
        fx.tenant_a.context,
        fx.tenant_a.tenant_id,
        box_a.handler,
      ),
      await subscribe_to_rates(
        subscriber_b,
        fx.tenant_b.context,
        fx.tenant_b.tenant_id,
        box_b.handler,
      ),
    );

    const arrival = box_b.next();
    await publish_rate_event(publisher, rate_event(fx.tenant_b.tenant_id, "14181400"));
    const received = await arrival;

    expect(received.tenant_id).toBe(fx.tenant_b.tenant_id);
    expect(received.rate_display_paise).toBe("14181400");
    expect(box_a.events).toHaveLength(0);
  });

  test("Realtime_interleavedPublishes_eachTenantSeesOnlyItsOwn", async () => {
    const box_a = inbox();
    const box_b = inbox();

    open_subscriptions.push(
      await subscribe_to_rates(
        subscriber_a,
        fx.tenant_a.context,
        fx.tenant_a.tenant_id,
        box_a.handler,
      ),
      await subscribe_to_rates(
        subscriber_b,
        fx.tenant_b.context,
        fx.tenant_b.tenant_id,
        box_b.handler,
      ),
    );

    for (let i = 0; i < 3; i += 1) {
      const a_arrival = box_a.next();
      await publish_rate_event(publisher, rate_event(fx.tenant_a.tenant_id, `1000${i}`));
      await a_arrival;

      const b_arrival = box_b.next();
      await publish_rate_event(publisher, rate_event(fx.tenant_b.tenant_id, `2000${i}`));
      await b_arrival;
    }

    expect(box_a.events).toHaveLength(3);
    expect(box_b.events).toHaveLength(3);
    expect(box_a.events.every((e) => e.tenant_id === fx.tenant_a.tenant_id)).toBe(true);
    expect(box_b.events.every((e) => e.tenant_id === fx.tenant_b.tenant_id)).toBe(true);
    expect(box_a.events.every((e) => e.rate_display_paise.startsWith("1000"))).toBe(true);
    expect(box_b.events.every((e) => e.rate_display_paise.startsWith("2000"))).toBe(true);
  });

  test("Realtime_tenantAEvents_neverContainTenantBIdentifiers", async () => {
    const box_a = inbox();
    open_subscriptions.push(
      await subscribe_to_rates(
        subscriber_a,
        fx.tenant_a.context,
        fx.tenant_a.tenant_id,
        box_a.handler,
      ),
    );

    const arrival = box_a.next();
    await publish_rate_event(publisher, rate_event(fx.tenant_a.tenant_id));
    await arrival;

    const serialised = JSON.stringify(box_a.events);
    expect(serialised).not.toContain(fx.tenant_b.tenant_id);
    expect(serialised).not.toContain(fx.tenant_b.slug);
    expect(serialised).not.toContain("Gupta");
  });
});

describe("adversarial realtime subscription", () => {
  /** A client holding tenant A's context asking for tenant B's channel. */
  test("Adversarial_tenantAContextSubscribingToTenantBChannel_isDenied", async () => {
    await expect(
      subscribe_to_rates(
        subscriber_a,
        fx.tenant_a.context,
        fx.tenant_b.tenant_id,
        () => {},
      ),
    ).rejects.toThrow(RealtimeAuthorizationError);
  });

  test("Adversarial_publicContextForASubscribingToB_isDenied", async () => {
    const public_a: PublicTenantContext = {
      kind: "public",
      tenant_id: fx.tenant_a.tenant_id,
      slug: fx.tenant_a.slug,
    };

    await expect(
      subscribe_to_rates(subscriber_a, public_a, fx.tenant_b.tenant_id, () => {}),
    ).rejects.toThrow(RealtimeAuthorizationError);
  });

  test("Adversarial_wildcardChannelRequest_isDenied", async () => {
    await expect(
      subscribe_to_rates(subscriber_a, fx.tenant_a.context, "*", () => {}),
    ).rejects.toThrow(RealtimeAuthorizationError);
  });

  /**
   * Defence in depth: even when a subscriber is legitimately on its own
   * channel, an event carrying another tenant's id is dropped rather than
   * relayed. This catches a mis-routed publish instead of forwarding it.
   */
  test("Adversarial_misroutedEventOnOwnChannel_isDroppedNotDelivered", async () => {
    const box_a = inbox();
    open_subscriptions.push(
      await subscribe_to_rates(
        subscriber_a,
        fx.tenant_a.context,
        fx.tenant_a.tenant_id,
        box_a.handler,
      ),
    );

    // Written directly to A's channel but stamped with B's tenant id.
    const forged = { ...rate_event(fx.tenant_b.tenant_id), product_key: "FORGED" };
    await publisher.publish(
      channel_for(fx.tenant_a.tenant_id),
      JSON.stringify(forged),
    );

    // A legitimate event afterwards proves the channel is live and the forged
    // one was dropped rather than merely delayed.
    const arrival = box_a.next();
    await publish_rate_event(publisher, rate_event(fx.tenant_a.tenant_id, "999"));
    await arrival;

    expect(box_a.events).toHaveLength(1);
    expect(box_a.events[0]?.product_key).toBe("GOLD_916");
    expect(box_a.events.some((e) => e.product_key === "FORGED")).toBe(false);
  });

  test("Adversarial_malformedMessage_isDroppedNotDelivered", async () => {
    const box_a = inbox();
    open_subscriptions.push(
      await subscribe_to_rates(
        subscriber_a,
        fx.tenant_a.context,
        fx.tenant_a.tenant_id,
        box_a.handler,
      ),
    );

    await publisher.publish(channel_for(fx.tenant_a.tenant_id), "{ not json");

    const arrival = box_a.next();
    await publish_rate_event(publisher, rate_event(fx.tenant_a.tenant_id));
    await arrival;

    expect(box_a.events).toHaveLength(1);
  });

  test("Adversarial_unsubscribedClient_receivesNothingFurther", async () => {
    const box_a = inbox();
    const subscription = await subscribe_to_rates(
      subscriber_a,
      fx.tenant_a.context,
      fx.tenant_a.tenant_id,
      box_a.handler,
    );

    const arrival = box_a.next();
    await publish_rate_event(publisher, rate_event(fx.tenant_a.tenant_id));
    await arrival;
    expect(box_a.events).toHaveLength(1);

    await subscription.unsubscribe();

    // Publish again on a second subscriber to prove delivery still works,
    // while the unsubscribed inbox stays put.
    const box_b = inbox();
    open_subscriptions.push(
      await subscribe_to_rates(
        subscriber_b,
        fx.tenant_a.context,
        fx.tenant_a.tenant_id,
        box_b.handler,
      ),
    );

    const second = box_b.next();
    await publish_rate_event(publisher, rate_event(fx.tenant_a.tenant_id));
    await second;

    expect(box_a.events).toHaveLength(1); // unchanged
    expect(box_b.events).toHaveLength(1);
  });
});
