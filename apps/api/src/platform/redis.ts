/**
 * Redis client.
 *
 * Used for rate limiting, idempotency keys, the market-poller leader lock, and
 * the tenant-scoped pub/sub fan-out that drives SSE.
 */
import { createClient, type RedisClientType } from "redis";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";

export type Cache = RedisClientType;

export function create_redis(config: AppConfig, logger: Logger): RedisClientType {
  const client: RedisClientType = createClient({
    url: config.REDIS_URL,
    socket: {
      // Capped exponential backoff with jitter, per api-standards.md §9.
      reconnectStrategy: (retries: number) => {
        const capped = Math.min(30_000, 2 ** retries * 100);
        return Math.floor(Math.random() * capped);
      },
    },
  });

  // Without a listener, a connection error is an unhandled rejection that
  // takes the process down.
  client.on("error", (error: Error) => {
    logger.error({ err: error }, "redis client error");
  });

  return client;
}

/** Trivial round-trip used by the readiness probe. */
export async function ping_redis(client: RedisClientType): Promise<void> {
  const reply = await client.ping();
  if (reply !== "PONG") {
    throw new Error(`unexpected PING reply: ${reply}`);
  }
}

/** Namespace a key so several environments can share one Redis instance. */
export function prefixed(config: AppConfig, key: string): string {
  return `${config.REDIS_KEY_PREFIX}${key}`;
}
