/**
 * Dependency health probes.
 *
 * `backend-standards.md` §7: liveness and readiness are separate endpoints with
 * separate logic and no side effects. Liveness must not touch a dependency —
 * a database blip should not cause the orchestrator to restart healthy
 * replicas.
 */
import type { AppConfig } from "./config.js";

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "not_configured";

export interface ComponentHealth {
  readonly status: HealthStatus;
  readonly latency_ms?: number;
  readonly detail?: string;
  readonly checked_at: string;
}

export interface HealthReport extends ComponentHealth {
  readonly components: Readonly<Record<string, ComponentHealth>>;
}

/** A dependency that can report on itself. */
export interface HealthCheckable {
  readonly name: string;
  check(): Promise<ComponentHealth>;
}

const now_iso = (): string => new Date().toISOString();

/** Time an async probe, converting a throw into an `unhealthy` result. */
export async function timed_check(
  probe: () => Promise<void>,
  timeout_ms = 3000,
): Promise<ComponentHealth> {
  const started = Date.now();

  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`health probe exceeded ${timeout_ms}ms`)),
          timeout_ms,
        ).unref?.(),
      ),
    ]);

    return {
      status: "healthy",
      latency_ms: Date.now() - started,
      checked_at: now_iso(),
    };
  } catch (error) {
    return {
      status: "unhealthy",
      latency_ms: Date.now() - started,
      // Probe failures are operator-facing and contain no user data.
      detail: error instanceof Error ? error.message : "unknown failure",
      checked_at: now_iso(),
    };
  }
}

/**
 * Market-data health.
 *
 * The provider abstraction, the quote stream and the pricing engine all exist
 * and are tested, but **nothing constructs them at runtime**: no component
 * consumes `MarketDataService.on_quote`, writes `published_rates` or calls
 * `publish_rate_event`. Until that publication pipeline exists, a replica has
 * no market data at all.
 *
 * In production that is reported as `unhealthy`, not `not_configured`.
 * `aggregate` deliberately treats `not_configured` as a non-failure — it means
 * "not part of this build" — so leaving this component in that state would let
 * `/health/ready` return 200 for a service that cannot price anything, and
 * `cd.yml` gates its deployment on exactly that endpoint. A deploy would go
 * green over a service with no rates.
 *
 * Outside production it stays `not_configured`, so local work and CI are not
 * blocked by a component that is knowingly absent.
 */
export function market_data_health(config: AppConfig): ComponentHealth {
  const detail =
    `provider "${config.MARKET_DATA_PROVIDER}" is selected, but no rate ` +
    `publication pipeline is running: quotes are never converted into ` +
    `published_rates and no rate events are emitted`;

  if (config.NODE_ENV === "production") {
    return { status: "unhealthy", detail, checked_at: now_iso() };
  }

  return { status: "not_configured", detail, checked_at: now_iso() };
}

/** Roll component results into one overall status. */
export function aggregate(
  components: Record<string, ComponentHealth>,
): HealthReport {
  const statuses = Object.values(components).map((c) => c.status);

  // `not_configured` is not a failure — it means "not part of this build yet".
  const status: HealthStatus = statuses.includes("unhealthy")
    ? "unhealthy"
    : statuses.includes("degraded")
      ? "degraded"
      : "healthy";

  return { status, components, checked_at: now_iso() };
}
