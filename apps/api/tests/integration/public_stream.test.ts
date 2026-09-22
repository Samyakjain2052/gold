/**
 * The public SSE stream, over real HTTP and real Redis.
 *
 * `supertest` cannot drive this: the response never ends, so an assertion that
 * waits for completion waits forever. The app is therefore bound to an
 * ephemeral port and driven with `fetch`, reading frames off the body stream as
 * they arrive — which is also what makes "tenant B's event never appears on
 * tenant A's stream" testable as an observable fact rather than an inference.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { pino } from "pino";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import type { RedisClientType } from "redis";
import { load_config } from "../../src/platform/config.js";
import { create_app } from "../../src/http/app.js";
import { create_rate_hub, type RateHub } from "../../src/modules/realtime/rate_hub.js";
import { publish_rate_event } from "../../src/modules/realtime/rate_channel.js";
import {
  app_client,
  owner_client,
  redis_client,
  seed_fixtures,
  type Fixtures,
} from "./fixtures.js";

let owner: PrismaClient;
let db: PrismaClient;
let publisher: RedisClientType;
let subscriber: RedisClientType;
let hub: RateHub;
let server: Server;
let base_url = "";
let fx: Fixtures;

function rate_event(tenant_id: string, rate: string) {
  return {
    type: "rate_update" as const,
    tenant_id,
    product_key: "GOLD_916",
    rate_display_paise: rate,
    display_unit: "per_10_gram",
    source_timestamp: new Date().toISOString(),
    freshness: "fresh" as const,
    emitted_at: new Date().toISOString(),
  };
}

/**
 * Open a stream and collect frames until `wanted` have arrived or time runs out.
 *
 * Returns whatever was received; an empty result is a legitimate outcome and is
 * how the isolation test proves nothing leaked.
 */
async function read_frames(
  path: string,
  wanted: number,
  timeout_ms: number,
  after_open?: () => Promise<void>,
): Promise<{ status: number; frames: string[] }> {
  const controller = new AbortController();
  const response = await fetch(`${base_url}${path}`, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });

  if (!response.ok || response.body === null) {
    controller.abort();
    return { status: response.status, frames: [] };
  }

  const frames: string[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let opened = false;

  const deadline = setTimeout(() => controller.abort(), timeout_ms);

  try {
    while (frames.length < wanted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line. Heartbeats are comment lines
      // and are deliberately not counted as frames.
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim().startsWith(":")) continue;
        if (part.trim() !== "") frames.push(part);
      }

      // Publish only once the stream is established, or the event races the
      // subscription and is published to nobody.
      if (!opened && frames.length > 0 && after_open !== undefined) {
        opened = true;
        await after_open();
      }
    }
  } catch {
    // Aborted by the deadline; return what arrived.
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }

  return { status: response.status, frames };
}

beforeAll(async () => {
  owner = owner_client();
  db = app_client();
  publisher = await redis_client();
  subscriber = await redis_client();

  hub = create_rate_hub(subscriber, { max_listeners: 50 });

  const config = load_config({
    NODE_ENV: "test",
    API_BASE_URL: "http://localhost:8080",
    PUBLIC_WEB_URL: "http://localhost:3000",
    ALLOWED_ORIGINS: "http://localhost:3000",
    DATABASE_URL: "postgresql://bullion_app:devpassword@localhost:5432/bullion_test",
    REDIS_URL: "redis://localhost:6380",
    MARKET_DATA_PROVIDER: "mock",
    SSE_HEARTBEAT_MS: "500",
  });

  const app = create_app({
    config,
    logger: pino({ level: "silent" }),
    db,
    hub,
    ping_database: async () => {},
    ping_redis: async () => {},
  });

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  base_url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  fx = await seed_fixtures(owner);
});

afterAll(async () => {
  await hub.close().catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled([
    owner.$disconnect(),
    db.$disconnect(),
    publisher.quit(),
    subscriber.quit(),
  ]);
});

describe("stream lifecycle", () => {
  test("PublicStream_opens_andAnnouncesReady", async () => {
    const { status, frames } = await read_frames(
      `/api/v1/public/shops/${fx.tenant_a.slug}/stream`,
      1,
      5_000,
    );

    expect(status).toBe(200);
    expect(frames[0]).toContain("event: ready");
    expect(frames[0]).toContain(fx.tenant_a.slug);
  });

  /** Development must be unmistakable even on the realtime channel. */
  test("PublicStream_readyFrame_declaresSimulatedRates", async () => {
    const { frames } = await read_frames(
      `/api/v1/public/shops/${fx.tenant_a.slug}/stream`,
      1,
      5_000,
    );

    expect(frames[0]).toContain('"simulated":true');
  });

  test("PublicStream_unknownSlug_is404NotAnOpenStream", async () => {
    const { status } = await read_frames("/api/v1/public/shops/no-such-shop/stream", 1, 3_000);
    expect(status).toBe(404);
  });

  test("PublicStream_malformedSlug_is404", async () => {
    const { status } = await read_frames("/api/v1/public/shops/NOT_A_SLUG/stream", 1, 3_000);
    expect(status).toBe(404);
  });

  test("PublicStream_disconnect_releasesTheListener", async () => {
    await read_frames(`/api/v1/public/shops/${fx.tenant_a.slug}/stream`, 1, 3_000);

    // The abort propagates asynchronously; give the server a moment to notice.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hub.listener_count()).toBe(0);
  });
});

describe("delivery", () => {
  test("PublicStream_publishedRate_reachesTheSubscriber", async () => {
    const { frames } = await read_frames(
      `/api/v1/public/shops/${fx.tenant_a.slug}/stream`,
      2,
      8_000,
      async () => {
        await publish_rate_event(publisher, rate_event(fx.tenant_a.tenant_id, "14131400"));
      },
    );

    const update = frames.find((f) => f.includes("event: rate_update"));
    expect(update).toBeDefined();
    expect(update).toContain("14131400");
  });

  /**
   * The tenant id is the routing key and has no place in a public payload; the
   * page already knows which shop it asked for.
   */
  test("PublicStream_payload_neverCarriesTheTenantId", async () => {
    const { frames } = await read_frames(
      `/api/v1/public/shops/${fx.tenant_a.slug}/stream`,
      2,
      8_000,
      async () => {
        await publish_rate_event(publisher, rate_event(fx.tenant_a.tenant_id, "14131401"));
      },
    );

    for (const frame of frames) {
      expect(frame).not.toContain(fx.tenant_a.tenant_id);
    }
  });
});

describe("tenant isolation over the wire", () => {
  /**
   * The property the whole public surface rests on. Tenant B publishes while a
   * customer is watching tenant A; nothing may cross.
   */
  test("PublicStream_tenantBEvent_neverReachesTenantAStream", async () => {
    const { frames } = await read_frames(
      `/api/v1/public/shops/${fx.tenant_a.slug}/stream`,
      2,
      4_000,
      async () => {
        await publish_rate_event(publisher, rate_event(fx.tenant_b.tenant_id, "99999999"));
      },
    );

    // Only the ready frame; the foreign rate is never delivered.
    expect(frames.filter((f) => f.includes("rate_update"))).toHaveLength(0);
    for (const frame of frames) {
      expect(frame).not.toContain("99999999");
      expect(frame).not.toContain(fx.tenant_b.tenant_id);
    }
  });

  test("PublicStream_eachShopReceivesOnlyItsOwnRate", async () => {
    const [a, b] = await Promise.all([
      read_frames(`/api/v1/public/shops/${fx.tenant_a.slug}/stream`, 2, 8_000, async () => {
        await publish_rate_event(publisher, rate_event(fx.tenant_a.tenant_id, "11110000"));
        await publish_rate_event(publisher, rate_event(fx.tenant_b.tenant_id, "22220000"));
      }),
      read_frames(`/api/v1/public/shops/${fx.tenant_b.slug}/stream`, 2, 8_000),
    ]);

    expect(a.frames.join()).toContain("11110000");
    expect(a.frames.join()).not.toContain("22220000");
    expect(b.frames.join()).not.toContain("11110000");
  });
});
