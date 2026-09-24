/**
 * Readiness semantics for the rate pipeline.
 *
 * Stage 9's finding was that readiness reported healthy for a replica that
 * could not price anything, and `cd.yml` gates deployment on exactly that
 * endpoint. These pin down which states pass, which degrade, and which fail —
 * because the failure mode is a deploy going green over a service that shows
 * customers nothing.
 */
import { describe, expect, test } from "vitest";
import {
  pipeline_health,
  pipeline_detail,
  OUTBOX_BACKLOG_LIMIT,
  type PipelineSnapshot,
} from "../../src/modules/publication/pipeline_health.js";
import type { Freshness, ProviderHealth, ProviderStatus } from "../../src/modules/market_data/types.js";

const NOW = new Date("2026-09-23T06:30:00.000Z");

function provider(status: ProviderStatus, last_error: string | null = null): ProviderHealth {
  return {
    provider: "mock",
    source: "mock",
    status,
    is_simulated: true,
    connected_since: NOW,
    last_quote_at: NOW,
    last_source_timestamp: NOW,
    consecutive_failures: 0,
    reconnect_attempts: 0,
    last_error,
    evaluated_at: NOW,
  };
}

function snapshot(overrides: Partial<PipelineSnapshot> = {}): PipelineSnapshot {
  return {
    provider: provider("healthy"),
    poller: {
      polls: 3,
      failures: 0,
      consecutive_failures: 0,
      last_poll_at: NOW,
      last_success_at: NOW,
      last_duration_ms: 12,
      last_error: null,
      published: 4,
      is_leader: true,
      running: true,
    },
    outbox: {
      delivered: 4,
      failed: 0,
      backlog: 0,
      last_run_at: NOW,
      last_error: null,
    },
    freshness: "fresh",
    last_quote_at: NOW,
    symbols: 2,
    ...overrides,
  };
}

describe("no pipeline in this composition", () => {
  /**
   * The Stage 9 defect. `aggregate()` treats `not_configured` as a non-failure,
   * so reporting it in production would let `/health/ready` return 200 for a
   * replica that cannot produce a rate.
   */
  test("Readiness_noPipelineInProduction_isUnhealthy", () => {
    expect(pipeline_health(null, true, NOW).status).toBe("unhealthy");
  });

  test("Readiness_noPipelineOutsideProduction_isNotConfigured", () => {
    expect(pipeline_health(null, false, NOW).status).toBe("not_configured");
  });

  test("Detail_noPipeline_saysSo", () => {
    expect(pipeline_detail(null)).toEqual({ pipeline: "absent" });
  });
});

describe("provider states", () => {
  test.each<[ProviderStatus, string]>([
    ["disconnected", "unhealthy"],
    ["error", "unhealthy"],
  ])("Readiness_provider_%s_isUnhealthy", (status, expected) => {
    const health = pipeline_health(snapshot({ provider: provider(status, "socket closed") }), true, NOW);
    expect(health.status).toBe(expected);
    expect(health.detail).toContain(status);
  });

  test("Readiness_providerNotConfiguredInProduction_isUnhealthy", () => {
    expect(
      pipeline_health(snapshot({ provider: provider("not_configured") }), true, NOW).status,
    ).toBe("unhealthy");
  });

  /** Connected but silent is still unable to price anything. */
  test("Readiness_connectedWithNoQuoteYet_isUnhealthy", () => {
    const health = pipeline_health(snapshot({ freshness: null, symbols: 0 }), true, NOW);

    expect(health.status).toBe("unhealthy");
    expect(health.detail).toMatch(/no valid quote/i);
  });
});

describe("freshness states", () => {
  test("Readiness_fresh_isHealthy", () => {
    expect(pipeline_health(snapshot({ freshness: "fresh" }), true, NOW).status).toBe("healthy");
  });

  /**
   * Stale is degraded, not failed. The rate is real and the page labels it as
   * delayed; pulling the replica would take a working site down over a slow
   * feed.
   */
  test("Readiness_stale_isDegradedNotUnhealthy", () => {
    const health = pipeline_health(snapshot({ freshness: "stale" }), true, NOW);

    expect(health.status).toBe("degraded");
    expect(health.status).not.toBe("unhealthy");
    expect(health.detail).toMatch(/delayed|stale/i);
  });

  test("Readiness_expired_isUnhealthy", () => {
    const health = pipeline_health(snapshot({ freshness: "expired" }), true, NOW);

    expect(health.status).toBe("unhealthy");
    expect(health.detail).toMatch(/expired/i);
  });

  test.each<[Freshness, string]>([
    ["fresh", "healthy"],
    ["stale", "degraded"],
    ["expired", "unhealthy"],
  ])("Readiness_%s_isConsistentOutsideProduction", (freshness, expected) => {
    expect(pipeline_health(snapshot({ freshness }), false, NOW).status).toBe(expected);
  });
});

describe("publication backlog", () => {
  /**
   * A backlog means committed rates are not reaching open pages, even though
   * the database is correct. The database being right is not the same as the
   * service being ready.
   */
  test("Readiness_largeOutboxBacklog_isUnhealthy", () => {
    const health = pipeline_health(
      snapshot({
        outbox: {
          delivered: 0,
          failed: 12,
          backlog: OUTBOX_BACKLOG_LIMIT + 1,
          last_run_at: NOW,
          last_error: "redis unavailable",
        },
      }),
      true,
      NOW,
    );

    expect(health.status).toBe("unhealthy");
    expect(health.detail).toContain("redis unavailable");
  });

  test("Readiness_smallBacklog_isNotAFailure", () => {
    const health = pipeline_health(
      snapshot({
        outbox: { delivered: 10, failed: 0, backlog: 5, last_run_at: NOW, last_error: null },
      }),
      true,
      NOW,
    );

    expect(health.status).toBe("healthy");
  });

  /** A broken publisher outranks a healthy provider: customers see nothing. */
  test("Readiness_backlogBeatsAHealthyProvider", () => {
    const health = pipeline_health(
      snapshot({
        provider: provider("healthy"),
        freshness: "fresh",
        outbox: {
          delivered: 0,
          failed: 3,
          backlog: OUTBOX_BACKLOG_LIMIT + 100,
          last_run_at: NOW,
          last_error: null,
        },
      }),
      true,
      NOW,
    );

    expect(health.status).toBe("unhealthy");
  });
});

describe("operator detail", () => {
  test("Detail_reportsLeaderPollerAndOutbox", () => {
    const detail = pipeline_detail(snapshot()) as Record<string, Record<string, unknown>>;

    expect(detail["provider"]?.["name"]).toBe("mock");
    expect(detail["provider"]?.["is_simulated"]).toBe(true);
    expect(detail["poller"]?.["is_leader"]).toBe(true);
    expect(detail["poller"]?.["published"]).toBe(4);
    expect(detail["outbox"]?.["backlog"]).toBe(0);
    expect(detail["freshness"]).toBe("fresh");
  });

  /** The simulated flag must be visible to an operator, not buried. */
  test("Detail_simulatedProvider_isDeclared", () => {
    const detail = pipeline_detail(snapshot()) as Record<string, Record<string, unknown>>;
    expect(detail["provider"]?.["is_simulated"]).toBe(true);
  });
});
