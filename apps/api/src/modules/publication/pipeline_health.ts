/**
 * What the rate pipeline is actually doing, for `/health` and for operators.
 *
 * Stage 9 found `market_data_health()` returning a hardcoded `not_configured`,
 * which `aggregate()` treats as a non-failure — so readiness returned 200 for a
 * replica that could not price anything, and `cd.yml` gates deploys on exactly
 * that. This replaces the stub with the pipeline's real state.
 *
 * ## Which states fail which probe
 *
 * | State | Liveness | Readiness |
 * |---|---|---|
 * | not configured (no pipeline in this composition) | pass | pass outside production, **fail in production** |
 * | provider configured, never connected | pass | fail |
 * | connected, no quote yet | pass | fail |
 * | fresh | pass | pass |
 * | stale | pass | pass, **degraded** |
 * | expired | pass | fail |
 * | publication pipeline broken (outbox not draining) | pass | fail |
 *
 * **Liveness never depends on the provider.** A provider outage is not a reason
 * to restart the process: restarting loses every SSE connection and fixes
 * nothing. Liveness stays dependency-free, exactly as `health.ts` documents.
 *
 * **Readiness fails when rates cannot be served.** A replica with no usable
 * quote can still answer `/health/live` and serve the last published rates from
 * PostgreSQL, but it is not *ready* in the sense the deployment gate means: it
 * cannot produce a current price. Reporting it ready is how a deploy goes green
 * over a service that shows customers nothing.
 *
 * `stale` is deliberately **degraded, not failed**. The rate is real and the
 * page says so; pulling the replica out of rotation would take a working site
 * down over a slow feed.
 */
import type { ComponentHealth } from "../../platform/health.js";
import type { OutboxStats } from "./outbox_publisher.js";
import type { PollerStats } from "../market_data/market_poller.js";
import type { Freshness, ProviderHealth } from "../market_data/types.js";

export interface PipelineSnapshot {
  readonly provider: ProviderHealth;
  readonly poller: PollerStats;
  readonly outbox: OutboxStats;
  /** Best freshness across all symbols, or null when nothing has been accepted. */
  readonly freshness: Freshness | null;
  readonly last_quote_at: Date | null;
  readonly symbols: number;
}

/** The live pipeline, or null in a composition that has none. */
export type PipelineProbe = () => PipelineSnapshot | null;

/**
 * How long the outbox may be backed up before readiness fails.
 *
 * A backlog is normal for a moment after a tick; a backlog that persists means
 * Redis is unreachable or the publisher is wedged, and customers' open pages
 * are no longer being updated even though the database is correct.
 */
export const OUTBOX_BACKLOG_LIMIT = 500;

export function pipeline_health(
  snapshot: PipelineSnapshot | null,
  is_production: boolean,
  now: Date = new Date(),
): ComponentHealth {
  const checked_at = now.toISOString();

  if (snapshot === null) {
    const detail = "no market-data pipeline is running in this composition";
    // In production a service without a pipeline cannot price anything, and
    // must not report itself deployable.
    return is_production
      ? { status: "unhealthy", detail, checked_at }
      : { status: "not_configured", detail, checked_at };
  }

  const { provider, poller, outbox, freshness } = snapshot;

  if (outbox.backlog > OUTBOX_BACKLOG_LIMIT) {
    return {
      status: "unhealthy",
      detail:
        `publication backlog is ${outbox.backlog} events` +
        (outbox.last_error === null ? "" : `; last error: ${outbox.last_error}`),
      checked_at,
    };
  }

  if (provider.status === "not_configured") {
    return {
      status: is_production ? "unhealthy" : "not_configured",
      detail: "no market-data provider is configured",
      checked_at,
    };
  }

  if (provider.status === "error" || provider.status === "disconnected") {
    return {
      status: "unhealthy",
      detail:
        `provider "${provider.provider}" is ${provider.status}` +
        (provider.last_error === null ? "" : `: ${provider.last_error}`),
      checked_at,
    };
  }

  if (freshness === null) {
    return {
      status: "unhealthy",
      detail: `provider "${provider.provider}" is connected but has produced no valid quote yet`,
      checked_at,
    };
  }

  if (freshness === "expired") {
    return {
      status: "unhealthy",
      detail: "every market quote has expired; no current rate can be served",
      checked_at,
    };
  }

  if (freshness === "stale") {
    return {
      status: "degraded",
      detail:
        "market data is stale; the last known rates are still served and are " +
        "labelled as delayed",
      checked_at,
    };
  }

  return {
    status: "healthy",
    detail:
      `provider "${provider.provider}" fresh across ${snapshot.symbols} symbol(s); ` +
      `${poller.published} rate(s) published`,
    checked_at,
  };
}

/** The operator-facing view behind `/health/market-data`. */
export function pipeline_detail(snapshot: PipelineSnapshot | null): object {
  if (snapshot === null) return { pipeline: "absent" };

  return {
    provider: {
      name: snapshot.provider.provider,
      status: snapshot.provider.status,
      is_simulated: snapshot.provider.is_simulated,
      last_quote_at: snapshot.provider.last_quote_at?.toISOString() ?? null,
      last_source_timestamp: snapshot.provider.last_source_timestamp?.toISOString() ?? null,
      consecutive_failures: snapshot.provider.consecutive_failures,
    },
    freshness: snapshot.freshness,
    symbols: snapshot.symbols,
    poller: {
      is_leader: snapshot.poller.is_leader,
      polls: snapshot.poller.polls,
      failures: snapshot.poller.failures,
      consecutive_failures: snapshot.poller.consecutive_failures,
      last_poll_at: snapshot.poller.last_poll_at?.toISOString() ?? null,
      last_success_at: snapshot.poller.last_success_at?.toISOString() ?? null,
      last_duration_ms: snapshot.poller.last_duration_ms,
      published: snapshot.poller.published,
    },
    outbox: {
      delivered: snapshot.outbox.delivered,
      failed: snapshot.outbox.failed,
      backlog: snapshot.outbox.backlog,
      last_run_at: snapshot.outbox.last_run_at?.toISOString() ?? null,
    },
  };
}
