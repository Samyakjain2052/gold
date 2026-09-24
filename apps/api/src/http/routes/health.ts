/**
 * Health endpoints.
 *
 * Liveness is dependency-free; readiness gates traffic on dependencies.
 * Per-dependency endpoints exist for operators and the platform-admin view.
 */
import { Router, type Request, type Response } from "express";
import type { AppConfig } from "../../platform/config.js";
import {
  aggregate,
  market_data_health,
  timed_check,
  type ComponentHealth,
} from "../../platform/health.js";

export interface HealthDependencies {
  readonly config: AppConfig;
  /**
   * The market pipeline's health, when one is running. Absent compositions
   * report `not_configured`, or `unhealthy` in production.
   */
  readonly market_data_probe?: () => ComponentHealth;
  /** Operator detail behind `/health/market-data`. */
  readonly market_data_detail?: () => object;
  /** Live SSE counts, for the realtime section of `/health`. */
  readonly realtime?: () => { connections: number; tenant_channels: number };
  /** Resolves when the database answers a trivial query. */
  readonly ping_database: () => Promise<void>;
  /** Resolves when Redis answers PING. */
  readonly ping_redis: () => Promise<void>;
}

/** 200 when healthy or not_configured; 503 when unhealthy. */
function status_code(status: string): number {
  return status === "unhealthy" ? 503 : 200;
}

function send(res: Response, body: ComponentHealth | object & { status: string }): void {
  res.status(status_code((body as { status: string }).status)).json(body);
}

export function create_health_router(deps: HealthDependencies): Router {
  const router = Router();
  const { config, ping_database, ping_redis } = deps;

  const started_at = Date.now();

  /**
   * Liveness — no dependencies, no side effects.
   * A failure here means the process is wedged and should be restarted.
   */
  router.get("/live", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "healthy",
      service: config.SERVICE_NAME,
      uptime_seconds: Math.floor((Date.now() - started_at) / 1000),
      checked_at: new Date().toISOString(),
    });
  });

  /**
   * Readiness — checks dependencies.
   * A failure removes the replica from traffic without restarting it.
   */
  router.get("/ready", async (_req: Request, res: Response) => {
    const [database, redis] = await Promise.all([
      timed_check(ping_database),
      timed_check(ping_redis),
    ]);

    send(
      res,
      aggregate({
        database,
        redis,
        market_data: market_data_health(config, deps.market_data_probe),
      }),
    );
  });

  router.get("/database", async (_req: Request, res: Response) => {
    send(res, await timed_check(ping_database));
  });

  router.get("/redis", async (_req: Request, res: Response) => {
    send(res, await timed_check(ping_redis));
  });

  router.get("/market-data", (_req: Request, res: Response) => {
    const health = market_data_health(config, deps.market_data_probe);
    res
      .status(status_code(health.status))
      .json({ ...health, ...(deps.market_data_detail?.() ?? {}) });
  });

  /**
   * Realtime fan-out counts.
   *
   * Stage 9 noted these existed on the hub but were exposed nowhere, so
   * "how many customers are connected?" was unanswerable in production.
   */
  router.get("/realtime", (_req: Request, res: Response) => {
    const counts = deps.realtime?.() ?? null;
    if (counts === null) {
      res.status(200).json({ status: "not_configured", checked_at: new Date().toISOString() });
      return;
    }
    res.status(200).json({
      status: "healthy",
      sse_connections: counts.connections,
      tenant_channels: counts.tenant_channels,
      checked_at: new Date().toISOString(),
    });
  });

  // Bare /health is an alias for readiness — what Container Apps probes.
  router.get("/", async (_req: Request, res: Response) => {
    const [database, redis] = await Promise.all([
      timed_check(ping_database),
      timed_check(ping_redis),
    ]);

    send(
      res,
      aggregate({
        database,
        redis,
        market_data: market_data_health(config, deps.market_data_probe),
      }),
    );
  });

  return router;
}
