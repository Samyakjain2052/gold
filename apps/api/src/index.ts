/**
 * Service entry point.
 *
 * Configuration is validated before anything else starts, so a misconfigured
 * deploy fails at boot with a readable list of problems rather than at the
 * first customer request.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RedisClientType } from "redis";
import { create_app } from "./http/app.js";
import { load_config, ConfigError, type AppConfig } from "./platform/config.js";
import { create_database, ping_database } from "./platform/db.js";
import { create_logger, type Logger } from "./platform/logger.js";
import { create_redis, ping_redis } from "./platform/redis.js";
import { system_clock } from "./platform/clock.js";
import {
  create_http_jwks_fetcher,
  JwksCache,
  JwtVerifier,
  type SupportedAlgorithm,
} from "./modules/auth/index.js";
import { create_rate_hub } from "./modules/realtime/rate_hub.js";
import { create_rate_pipeline } from "./modules/publication/pipeline.js";

/**
 * Build the token verifier, or return undefined when identity is not configured.
 *
 * Returning undefined rather than a permissive verifier is the point: `app.ts`
 * mounts the authenticated routes only when one exists, so an unconfigured
 * deployment serves no authenticated surface at all instead of serving one that
 * accepts anything. Production cannot reach the undefined branch — `config.ts`
 * already refuses to start without the issuer, audience and directory id.
 */
function create_verifier(config: AppConfig): JwtVerifier | undefined {
  const jwks_url =
    config.AUTH_JWKS_URL ??
    (config.AUTH_ISSUER === undefined
      ? undefined
      : `${config.AUTH_ISSUER.replace(/\/+$/, "")}/discovery/v2.0/keys`);

  if (jwks_url === undefined || config.AUTH_ISSUER === undefined) return undefined;
  if (config.AUTH_AUDIENCE === undefined || config.AUTH_DIRECTORY_ID === undefined) {
    return undefined;
  }

  const cache = new JwksCache(
    jwks_url,
    system_clock,
    create_http_jwks_fetcher(config.AUTH_JWKS_FETCH_TIMEOUT_MS),
    {
      cache_max_age_ms: config.AUTH_JWKS_CACHE_MAX_AGE_MS,
      cooldown_ms: config.AUTH_JWKS_COOLDOWN_MS,
      stale_grace_ms: config.AUTH_JWKS_STALE_GRACE_MS,
      fetch_timeout_ms: config.AUTH_JWKS_FETCH_TIMEOUT_MS,
    },
  );

  return new JwtVerifier(
    cache.key_resolver(),
    {
      issuer: config.AUTH_ISSUER,
      audience: config.AUTH_AUDIENCE,
      algorithms: config.AUTH_JWT_ALGORITHMS as SupportedAlgorithm[],
      expected_directory_id: config.AUTH_DIRECTORY_ID,
      allowed_client_ids: config.AUTH_ALLOWED_CLIENT_IDS,
      clock_tolerance_s: config.AUTH_CLOCK_TOLERANCE_S,
      max_future_iat_s: config.AUTH_MAX_FUTURE_IAT_S,
      max_token_age_s: config.AUTH_MAX_TOKEN_AGE_S,
    },
    system_clock,
  );
}

/**
 * Redis pub/sub needs its own connection: a client in subscriber mode cannot
 * serve ordinary commands, so sharing the main client would break rate limiting
 * and idempotency the moment the first customer opened a shop page.
 */
async function create_subscriber(
  redis: RedisClientType,
  logger: Logger,
): Promise<RedisClientType> {
  const subscriber = redis.duplicate() as RedisClientType;
  subscriber.on("error", (error: Error) => {
    logger.error({ err: error }, "redis subscriber error");
  });
  await subscriber.connect();
  return subscriber;
}

/**
 * Load the repo-root `.env` for local development only.
 *
 * In production, Container Apps injects environment variables (and Key Vault
 * references) directly, so dotenv must not run — a stray `.env` in an image
 * should never be able to override platform-supplied configuration.
 */
async function load_local_env(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") return;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const { default: dotenv } = await import("dotenv");
  dotenv.config({ path: path.resolve(here, "../../../.env"), quiet: true });
}

async function main(): Promise<void> {
  await load_local_env();
  const config = load_config();
  const logger = create_logger(config);

  const database = create_database(config);
  const redis = create_redis(config, logger);

  await redis.connect();

  const subscriber = await create_subscriber(redis, logger);
  const hub = create_rate_hub(subscriber, {
    max_listeners: config.SSE_MAX_CONNECTIONS_PER_REPLICA,
  });

  const verifier = create_verifier(config);
  if (verifier === undefined) {
    // Unreachable in production, where config validation has already failed.
    // Said out loud in development so nobody spends an afternoon wondering why
    // the dashboard gets 404s from an API that started perfectly happily.
    logger.warn(
      "authentication is not configured; /api/v1/me, pricing and audit routes are NOT mounted",
    );
  }

  // The rate pipeline: provider → poller → pricing → published_rates → outbox
  // → Redis. Leader-elected, so only one replica consumes the provider.
  const pipeline = create_rate_pipeline({
    config,
    db: database,
    redis,
    logger,
    clock: system_clock,
  });
  await pipeline.start();

  const app = create_app({
    config,
    logger,
    db: database,
    hub,
    pipeline,
    ...(verifier === undefined ? {} : { verifier }),
    ping_database: () => ping_database(database),
    ping_redis: () => ping_redis(redis),
  });

  const server = app.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        market_data_provider: config.MARKET_DATA_PROVIDER,
      },
      "api listening",
    );
  });

  // Exceed Azure's 60s load-balancer idle timeout, per
  // deployment-best-practices.md §6.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    server.close();
    // Releases the leader lease and flushes pending events, so a replacement
    // replica takes over immediately rather than after a lease timeout.
    await pipeline.stop().catch(() => {});
    // Realtime listeners are released before the connections they sit on, so a
    // redeploy does not leave subscriptions attached to a closing socket.
    await hub.close().catch(() => {});
    await Promise.allSettled([
      database.$disconnect(),
      subscriber.quit(),
      redis.quit(),
    ]);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // Before the logger exists, so this goes straight to stderr.
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }

  process.stderr.write(
    `Fatal startup error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
