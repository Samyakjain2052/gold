/**
 * Tenant-scoped realtime fan-out.
 *
 * ## Isolation model
 *
 * There is **no broadcast channel**. Every rate event is published to
 * `rates:tenant:{tenant_id}` and nothing else. A subscriber attached to one
 * tenant's channel cannot receive another tenant's events, because those events
 * are never written to a channel it is reading.
 *
 * That is the structural guarantee. On top of it, `authorize_subscription`
 * refuses to attach a subscriber to a channel its context does not own, so a
 * client that asks for another tenant's channel is denied before any Redis
 * subscription is created.
 *
 * ## Why the requested tenant is checked, not trusted
 *
 * A subscription request carries a tenant identifier (from a URL slug or a
 * dashboard session). That identifier is compared against the context derived
 * server-side; it is never used to *build* the context. A client that sends
 * tenant B's id while holding tenant A's session is denied — the id is an
 * assertion to verify, not an instruction to follow.
 */
import type { RedisClientType } from "redis";
import type { TenantContext } from "../tenancy/tenant_context.js";
import type { Freshness } from "../market_data/types.js";

export const CHANNEL_PREFIX = "rates:tenant:";

/** The Redis channel for a tenant. The only place a channel name is built. */
export function channel_for(tenant_id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(tenant_id)) {
    throw new RealtimeAuthorizationError("channel requires a UUID tenant id");
  }
  return `${CHANNEL_PREFIX}${tenant_id}`;
}

export class RealtimeAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealtimeAuthorizationError";
  }
}

/** A rate update delivered to one tenant's subscribers. */
export interface RateEvent {
  readonly type: "rate_update";
  /** Echoed so a subscriber can assert what it received. Never used to route. */
  readonly tenant_id: string;
  readonly product_key: string;
  readonly rate_display_paise: string;
  readonly display_unit: string;
  readonly source_timestamp: string;
  readonly freshness: Freshness;
  readonly emitted_at: string;
}

/**
 * Decide whether `context` may subscribe to `requested_tenant_id`.
 *
 * Platform admins are deliberately **not** granted tenant channels here: an
 * admin needing live rates gets them through admin endpoints, and allowing an
 * admin session onto a tenant channel would create a path that a role-confusion
 * bug could ride.
 */
export function authorize_subscription(
  context: TenantContext,
  requested_tenant_id: string,
): boolean {
  if (context.kind === "platform_admin") return false;
  if (requested_tenant_id === "") return false;

  // Compared case-insensitively because PostgreSQL treats UUIDs that way: the
  // same tenant can legitimately surface as `A1B2…` or `a1b2…` depending on the
  // path it took. A strict comparison would deny a valid subscriber, and grants
  // an attacker nothing — case variation only ever matches their own id.
  return context.tenant_id.toLowerCase() === requested_tenant_id.toLowerCase();
}

/** Throwing form, for call sites that should fail loudly. */
export function assert_can_subscribe(
  context: TenantContext,
  requested_tenant_id: string,
): void {
  if (!authorize_subscription(context, requested_tenant_id)) {
    throw new RealtimeAuthorizationError(
      "context is not authorised for the requested tenant channel",
    );
  }
}

export interface RateChannelSubscription {
  readonly tenant_id: string;
  unsubscribe(): Promise<void>;
}

/**
 * Publish a rate event to exactly one tenant's channel.
 *
 * `tenant_id` comes from the pricing pipeline, which derives it from the rule
 * being recomputed — never from client input.
 */
export async function publish_rate_event(
  redis: RedisClientType,
  event: RateEvent,
): Promise<void> {
  await redis.publish(channel_for(event.tenant_id), JSON.stringify(event));
}

/**
 * Subscribe to a tenant's channel, after authorisation.
 *
 * Redis pub/sub requires a dedicated connection, so callers pass a duplicated
 * client. The subscription is torn down explicitly to avoid leaking a
 * connection per customer page view.
 */
export async function subscribe_to_rates(
  subscriber: RedisClientType,
  context: TenantContext,
  requested_tenant_id: string,
  on_event: (event: RateEvent) => void,
): Promise<RateChannelSubscription> {
  assert_can_subscribe(context, requested_tenant_id);

  const channel = channel_for(requested_tenant_id);

  await subscriber.subscribe(channel, (message: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return; // A malformed message is dropped, never forwarded.
    }

    // `JSON.parse` succeeds for `null`, `[]`, `3` and `"text"`, none of which
    // have a `tenant_id`. Reading one off them throws *inside the Redis message
    // handler*, where there is no caller to catch it — so the shape is checked
    // before any field is touched, not after.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;

    const event = parsed as RateEvent;

    // Defence in depth: even on our own channel, refuse anything carrying
    // another tenant's id. Catches a mis-routed publish rather than relaying it.
    if (event.tenant_id !== requested_tenant_id) return;

    on_event(event);
  });

  return {
    tenant_id: requested_tenant_id,
    unsubscribe: async () => {
      await subscriber.unsubscribe(channel);
    },
  };
}
