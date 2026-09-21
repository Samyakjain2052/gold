import { describe, expect, test } from "vitest";
import {
  aggregate,
  market_data_health,
  timed_check,
} from "../../src/platform/health.js";
import { load_config } from "../../src/platform/config.js";

const config = load_config({
  NODE_ENV: "development",
  API_BASE_URL: "http://localhost:8080",
  PUBLIC_WEB_URL: "http://localhost:3000",
  ALLOWED_ORIGINS: "http://localhost:3000",
  DATABASE_URL: "postgresql://bullion_app:pw@localhost:5432/bullion",
  REDIS_URL: "redis://localhost:6380",
  MARKET_DATA_PROVIDER: "mock",
});

describe("timed_check", () => {
  test("TimedCheck_probeSucceeds_reportsHealthyWithLatency", async () => {
    const result = await timed_check(async () => {});
    expect(result.status).toBe("healthy");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("TimedCheck_probeThrows_reportsUnhealthyWithDetail", async () => {
    const result = await timed_check(async () => {
      throw new Error("connection refused");
    });
    expect(result.status).toBe("unhealthy");
    expect(result.detail).toBe("connection refused");
  });

  test("TimedCheck_probeHangs_timesOutRatherThanBlocking", async () => {
    const result = await timed_check(
      () => new Promise<void>(() => {}), // never resolves
      50,
    );
    expect(result.status).toBe("unhealthy");
    expect(result.detail).toContain("exceeded 50ms");
  });

  test("TimedCheck_nonErrorThrown_stillReportsUnhealthy", async () => {
    const result = await timed_check(async () => {
      throw "a bare string";
    });
    expect(result.status).toBe("unhealthy");
    expect(result.detail).toBe("unknown failure");
  });
});

describe("market_data_health", () => {
  /**
   * The provider abstraction lands in stage 4. Until then this must report
   * `not_configured` — a probe that claims health for a component that does
   * not exist is worse than no probe at all.
   */
  test("MarketDataHealth_beforeProviderWired_reportsNotConfigured", () => {
    const result = market_data_health(config);
    expect(result.status).toBe("not_configured");
    expect(result.status).not.toBe("healthy");
    expect(result.detail).toContain("mock");
  });
});

describe("aggregate", () => {
  const healthy = { status: "healthy" as const, checked_at: "2026-09-20T00:00:00Z" };
  const unhealthy = { status: "unhealthy" as const, checked_at: "2026-09-20T00:00:00Z" };
  const degraded = { status: "degraded" as const, checked_at: "2026-09-20T00:00:00Z" };
  const not_configured = {
    status: "not_configured" as const,
    checked_at: "2026-09-20T00:00:00Z",
  };

  test("Aggregate_allHealthy_reportsHealthy", () => {
    expect(aggregate({ database: healthy, redis: healthy }).status).toBe("healthy");
  });

  test("Aggregate_anyUnhealthy_reportsUnhealthy", () => {
    expect(aggregate({ database: unhealthy, redis: healthy }).status).toBe(
      "unhealthy",
    );
  });

  test("Aggregate_unhealthyOutranksDegraded", () => {
    expect(aggregate({ a: degraded, b: unhealthy }).status).toBe("unhealthy");
  });

  test("Aggregate_degradedWithoutUnhealthy_reportsDegraded", () => {
    expect(aggregate({ a: degraded, b: healthy }).status).toBe("degraded");
  });

  /** "Not yet built" is not a failure — it must not take the service offline. */
  test("Aggregate_notConfiguredComponent_doesNotFailOverall", () => {
    expect(aggregate({ database: healthy, market_data: not_configured }).status).toBe(
      "healthy",
    );
  });

  test("Aggregate_retainsEveryComponent", () => {
    const report = aggregate({ database: healthy, redis: unhealthy });
    expect(Object.keys(report.components)).toEqual(["database", "redis"]);
  });
});
