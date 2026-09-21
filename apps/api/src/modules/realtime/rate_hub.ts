/**
 * Per-replica fan-out for tenant rate channels.
 *
 * `ARCHITECTURE.md` §6: "Every API replica subscribes to Redis and relays to
 * *its own* connected `EventSource` clients for that tenant." This is that
 * relay. One Redis subscription exists per *tenant* per replica, however many
 * browsers are watching that shop.
 *
 * The naive alternative — a duplicated Redis connection per open SSE response —
 * would make a popular shop's Redis connection count track its readership, and
 * a shop that gets shared in a WhatsApp group would exhaust the server's
 * connection limit rather than its bandwidth.
 *
 * ## What this does not do
 *
 * It adds no isolation model of its own. Authorisation is delegated to
 * `assert_can_subscribe` and runs for **every** listener, not once per channel,
 * so the second viewer of a shop is checked exactly as rigorously as the first.
 * The Redis subscription itself is created by `subscribe_to_rates`, which keeps
 * its own defence against a mis-routed event carrying another tenant's id.
 *
 * Listeners are held per tenant id, and an event is offered only to the set
 * registered under the id it was received for. There is no structure here that
 * can hold a listener for one tenant and an event for another at the same time.
 */
import type { RedisClientType } from "redis";
import type { TenantContext } from "../tenancy/tenant_context.js";
import {
  assert_can_subscribe,
  subscribe_to_rates,
  type RateChannelSubscription,
  type RateEvent,
} from "./rate_channel.js";

export type RateListener = (event: RateEvent) => void;

/** Removes one listener, tearing down the Redis subscription if it was the last. */
export type Detach = () => Promise<void>;

export class RateHubCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateHubCapacityError";
  }
}

export interface RateHubOptions {
  /**
   * Ceiling on simultaneously attached listeners for this replica. Reaching it
   * sheds the newest connection rather than letting memory and file descriptors
   * grow until the process is killed and *every* viewer is dropped.
   */
  readonly max_listeners: number;
}

export interface RateHub {
  attach(context: TenantContext, tenant_id: string, listener: RateListener): Promise<Detach>;
  /** Total attached listeners — for the health endpoint and metrics. */
  listener_count(): number;
  /** Distinct tenant channels currently subscribed on this replica. */
  channel_count(): number;
  /** Drops every listener and Redis subscription. Used on shutdown. */
  close(): Promise<void>;
}

interface Channel {
  readonly listeners: Set<RateListener>;
  /**
   * The in-flight or settled subscription. Held as a promise so two viewers
   * arriving in the same tick share one Redis subscription instead of racing to
   * create two, of which one would be leaked.
   */
  subscription: Promise<RateChannelSubscription>;
}

export function create_rate_hub(
  subscriber: RedisClientType,
  options: RateHubOptions,
): RateHub {
  const channels = new Map<string, Channel>();
  let total = 0;

  function count(): number {
    return total;
  }

  async function attach(
    context: TenantContext,
    tenant_id: string,
    listener: RateListener,
  ): Promise<Detach> {
    // Every listener is authorised, not just the one that opens the channel.
    assert_can_subscribe(context, tenant_id);

    if (total >= options.max_listeners) {
      throw new RateHubCapacityError(
        `replica is at its limit of ${options.max_listeners} realtime listeners`,
      );
    }

    let channel = channels.get(tenant_id);

    if (channel === undefined) {
      const listeners = new Set<RateListener>();

      // Deliver to a snapshot of the set: a listener that detaches while we are
      // iterating must not shift the iteration, and one that attaches mid-event
      // should wait for the next one rather than see a partially handled event.
      const deliver = (event: RateEvent): void => {
        for (const fn of [...listeners]) {
          try {
            fn(event);
          } catch {
            // One browser's broken response must not deprive the others of the
            // event, nor take down the shared Redis message handler.
          }
        }
      };

      channel = {
        listeners,
        subscription: subscribe_to_rates(subscriber, context, tenant_id, deliver),
      };
      channels.set(tenant_id, channel);

      // If the subscribe fails, drop the half-built channel so the next viewer
      // gets a fresh attempt rather than awaiting a permanently rejected promise.
      channel.subscription.catch(() => {
        channels.delete(tenant_id);
      });
    }

    await channel.subscription;

    channel.listeners.add(listener);
    total += 1;

    let detached = false;

    return async (): Promise<void> => {
      // A client can close and error at once; unsubscribing twice would
      // under-count listeners and drop a channel other viewers are using.
      if (detached) return;
      detached = true;

      const current = channels.get(tenant_id);
      if (current === undefined) return;

      if (current.listeners.delete(listener)) {
        total -= 1;
      }

      if (current.listeners.size === 0) {
        channels.delete(tenant_id);
        const subscription = await current.subscription.catch(() => null);
        await subscription?.unsubscribe().catch(() => {
          // Teardown is best-effort: a dropped Redis connection has already
          // removed the subscription, and throwing here would surface as an
          // error on a response that has ended.
        });
      }
    };
  }

  return {
    attach,
    listener_count: count,
    channel_count: () => channels.size,
    close: async () => {
      const open = [...channels.values()];
      channels.clear();
      total = 0;
      await Promise.allSettled(
        open.map(async (c) => {
          c.listeners.clear();
          const subscription = await c.subscription.catch(() => null);
          await subscription?.unsubscribe();
        }),
      );
    },
  };
}
