/**
 * HTTP surface tests.
 *
 * Dependencies are stubbed, so these need no containers and run in the unit
 * suite. Real database and Redis probes are covered by the integration suite.
 */
import { describe, expect, test } from "vitest";
import request from "supertest";
import { pino } from "pino";
import { create_app } from "../../src/http/app.js";
import { load_config } from "../../src/platform/config.js";

const config = load_config({
  NODE_ENV: "development",
  API_BASE_URL: "http://localhost:8080",
  PUBLIC_WEB_URL: "http://localhost:3000",
  ALLOWED_ORIGINS: "http://localhost:3000,https://app.example.com",
  DATABASE_URL: "postgresql://bullion_app:pw@localhost:5432/bullion",
  REDIS_URL: "redis://localhost:6380",
  MARKET_DATA_PROVIDER: "mock",
});

const silent_logger = pino({ level: "silent" });

function build_app(options: { database_up?: boolean; redis_up?: boolean } = {}) {
  const { database_up = true, redis_up = true } = options;

  return create_app({
    config,
    logger: silent_logger,
    ping_database: async () => {
      if (!database_up) throw new Error("database unavailable");
    },
    ping_redis: async () => {
      if (!redis_up) throw new Error("redis unavailable");
    },
  });
}

describe("liveness", () => {
  /**
   * Liveness must not touch dependencies. A database outage should remove
   * replicas from traffic, not restart healthy ones.
   */
  test("HealthLive_databaseDown_stillReports200", async () => {
    const response = await request(build_app({ database_up: false })).get(
      "/health/live",
    );
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("healthy");
  });

  test("HealthLive_reportsServiceAndUptime", async () => {
    const response = await request(build_app()).get("/health/live");
    expect(response.body.service).toBe("bullion-api");
    expect(response.body.uptime_seconds).toBeGreaterThanOrEqual(0);
  });
});

describe("readiness", () => {
  test("HealthReady_allDependenciesUp_reports200", async () => {
    const response = await request(build_app()).get("/health/ready");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("healthy");
    expect(response.body.components.database.status).toBe("healthy");
    expect(response.body.components.redis.status).toBe("healthy");
  });

  test("HealthReady_databaseDown_reports503", async () => {
    const response = await request(build_app({ database_up: false })).get(
      "/health/ready",
    );
    expect(response.status).toBe(503);
    expect(response.body.components.database.status).toBe("unhealthy");
  });

  test("HealthReady_redisDown_reports503", async () => {
    const response = await request(build_app({ redis_up: false })).get(
      "/health/ready",
    );
    expect(response.status).toBe(503);
  });

  /** Market data is not wired until stage 4; that must not fail readiness. */
  test("HealthReady_marketDataNotConfigured_doesNotFailReadiness", async () => {
    const response = await request(build_app()).get("/health/ready");
    expect(response.body.components.market_data.status).toBe("not_configured");
    expect(response.status).toBe(200);
  });
});

describe("per-dependency health endpoints", () => {
  test("HealthDatabase_up_reports200", async () => {
    expect((await request(build_app()).get("/health/database")).status).toBe(200);
  });

  test("HealthDatabase_down_reports503", async () => {
    const response = await request(build_app({ database_up: false })).get(
      "/health/database",
    );
    expect(response.status).toBe(503);
  });

  test("HealthRedis_down_reports503", async () => {
    const response = await request(build_app({ redis_up: false })).get(
      "/health/redis",
    );
    expect(response.status).toBe(503);
  });

  test("HealthMarketData_beforeStage4_reportsNotConfigured", async () => {
    const response = await request(build_app()).get("/health/market-data");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("not_configured");
  });

  test("HealthRoot_aliasesReadiness", async () => {
    const response = await request(build_app()).get("/health");
    expect(response.body.components).toBeDefined();
  });
});

describe("request id", () => {
  test("RequestId_absent_isGeneratedAndEchoed", async () => {
    const response = await request(build_app()).get("/health/live");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("RequestId_supplied_isEchoedBack", async () => {
    const response = await request(build_app())
      .get("/health/live")
      .set("x-request-id", "trace-abc-123");
    expect(response.headers["x-request-id"]).toBe("trace-abc-123");
  });

  /** A header is untrusted input; a malformed one must not reach logs verbatim. */
  test("RequestId_malformedSupplied_isReplacedWithGeneratedUuid", async () => {
    const response = await request(build_app())
      .get("/health/live")
      .set("x-request-id", "bad id with spaces <script>");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("error handling", () => {
  test("UnknownRoute_returns404AsProblemJson", async () => {
    const response = await request(build_app()).get("/no-such-route");
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.body.code).toBe("NOT_FOUND");
    expect(response.body.request_id).toBeDefined();
  });

  test("ErrorResponse_carriesRequestIdForCorrelation", async () => {
    const response = await request(build_app())
      .get("/no-such-route")
      .set("x-request-id", "trace-xyz");
    expect(response.body.request_id).toBe("trace-xyz");
  });
});

describe("security headers", () => {
  test("SecurityHeaders_helmetDefaults_areApplied", async () => {
    const response = await request(build_app()).get("/health/live");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBeDefined();
  });

  test("SecurityHeaders_xPoweredBy_isNotDisclosed", async () => {
    const response = await request(build_app()).get("/health/live");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  test("Cors_allowedOrigin_isEchoed", async () => {
    const response = await request(build_app())
      .get("/health/live")
      .set("Origin", "https://app.example.com");
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com",
    );
  });

  test("Cors_disallowedOrigin_isNotEchoed", async () => {
    const response = await request(build_app())
      .get("/health/live")
      .set("Origin", "https://evil.example.com");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  /** Bearer-token API: no cookie auth, so no CSRF surface to defend. */
  test("Cors_credentials_areNotAllowed", async () => {
    const response = await request(build_app())
      .get("/health/live")
      .set("Origin", "https://app.example.com");
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("request limits", () => {
  /**
   * An oversized body is a caller mistake, so it must render as 413 — not as a
   * 500 that would be logged as an internal fault against our error budget.
   */
  test("BodyLimit_oversizedJson_returns413NotInternalError", async () => {
    const oversized = { blob: "x".repeat(2 * 1024 * 1024) };
    const response = await request(build_app())
      .post("/health/live")
      .set("Content-Type", "application/json")
      .send(oversized);

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("BodyParse_malformedJson_returns400", async () => {
    const response = await request(build_app())
      .post("/health/live")
      .set("Content-Type", "application/json")
      .send("{ not valid json");

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("BAD_REQUEST");
  });
});
