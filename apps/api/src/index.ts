/**
 * Service entry point.
 *
 * Configuration is validated before anything else starts, so a misconfigured
 * deploy fails at boot with a readable list of problems rather than at the
 * first customer request.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create_app } from "./http/app.js";
import { load_config, ConfigError } from "./platform/config.js";
import { create_database, ping_database } from "./platform/db.js";
import { create_logger } from "./platform/logger.js";
import { create_redis, ping_redis } from "./platform/redis.js";

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

  const app = create_app({
    config,
    logger,
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
    await Promise.allSettled([database.$disconnect(), redis.quit()]);
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
