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
 * Reports `not_configured` until the provider abstraction lands in stage 4.
 * Deliberately not reported as `healthy` — a probe that claims health for a
 * component that does not yet exist is worse than no probe at all.
 */
export function market_data_health(config: AppConfig): ComponentHealth {
  return {
    status: "not_configured",
    detail: `provider "${config.MARKET_DATA_PROVIDER}" not yet wired (stage 4)`,
    checked_at: now_iso(),
  };
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
