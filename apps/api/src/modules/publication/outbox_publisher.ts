/**
 * Drains committed publication events to Redis.
 *
 * The transaction that wrote a rate also wrote an outbox row. This reads rows
 * that have committed, publishes them, and marks them delivered. Nothing here
 * can publish an event for a rate that rolled back, because a rolled-back
 * transaction leaves no row to read.
 *
 * ## Delivery is at-least-once, deliberately
 *
 * Between `PUBLISH` and `delivered_at` there is a window in which a crash
 * re-delivers. The alternative — marking delivered first — turns that window
 * into *lost* events, which is strictly worse: a customer's page would keep a
 * superseded rate until they reloaded.
 *
 * Duplicates are safe because an event carries state rather than a delta. It
 * says "this product is now X", the browser keys updates by `product_key`, and
 * applying the same value twice is indistinguishable from applying it once.
 *
 * ## Ordering
 *
 * Rows are drained in `id` order, and `id` comes from one sequence, so a
 * superseding rate is never published before the rate it supersedes. Within a
 * batch the publishes are sequential for the same reason.
 *
 * ## Why it runs on the leader
 *
 * Two publishers would both deliver every row — harmless, but it doubles Redis
 * traffic and makes the backlog metric meaningless. It is bound to the same
 * lease as the poller. Correctness does not depend on that; cost does.
 */
import type { PrismaClient } from "@prisma/client";
import type { RedisClientType } from "redis";
import type { Logger } from "../../platform/logger.js";
import { publish_rate_event, type RateEvent } from "../realtime/rate_channel.js";
import type { Freshness } from "../market_data/types.js";

export interface PendingPublication {
  readonly id: bigint;
  readonly tenant_id: string;
  readonly product_key: string;
  readonly rate_display_paise: bigint;
  readonly display_unit: string;
  readonly source_timestamp: Date;
  readonly freshness: string;
  readonly attempts: number;
}

export interface OutboxPublisherOptions {
  /** Rows per pass. */
  readonly batch_size: number;
  /** Delay between passes when the last pass found nothing. */
  readonly idle_interval_ms: number;
  /**
   * Attempts before a row is logged as poison. It is still retried — dropping
   * a committed rate silently is never right — but it stops being quiet.
   */
  readonly poison_after_attempts: number;
}

export const DEFAULT_OUTBOX_OPTIONS: OutboxPublisherOptions = {
  batch_size: 200,
  idle_interval_ms: 1_000,
  poison_after_attempts: 5,
};

export interface OutboxStats {
  readonly delivered: number;
  readonly failed: number;
  readonly backlog: number;
  readonly last_run_at: Date | null;
  readonly last_error: string | null;
}

export class OutboxPublisher {
  readonly #db: PrismaClient;
  readonly #redis: RedisClientType;
  readonly #logger: Logger;
  readonly #options: OutboxPublisherOptions;

  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #delivered = 0;
  #failed = 0;
  #backlog = 0;
  #last_run_at: Date | null = null;
  #last_error: string | null = null;

  constructor(
    db: PrismaClient,
    redis: RedisClientType,
    logger: Logger,
    options: Partial<OutboxPublisherOptions> = {},
  ) {
    this.#db = db;
    this.#redis = redis;
    this.#logger = logger;
    this.#options = { ...DEFAULT_OUTBOX_OPTIONS, ...options };
  }

  stats(): OutboxStats {
    return {
      delivered: this.#delivered,
      failed: this.#failed,
      backlog: this.#backlog,
      last_run_at: this.#last_run_at,
      last_error: this.#last_error,
    };
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#loop();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  async #loop(): Promise<void> {
    if (!this.#running) return;

    let delivered = 0;
    try {
      delivered = await this.drain();
    } catch (error) {
      this.#last_error = error instanceof Error ? error.message : String(error);
      this.#logger.error(
        { event: "outbox.drain_failed", err: this.#last_error },
        "outbox drain failed",
      );
    }

    if (!this.#running) return;

    // A full batch means there is more waiting; come straight back for it.
    const delay = delivered >= this.#options.batch_size ? 0 : this.#options.idle_interval_ms;
    this.#timer = setTimeout(() => void this.#loop(), delay);
  }

  /**
   * One pass. Returns the number of rows delivered.
   *
   * Public so tests can drive it deterministically rather than waiting on a
   * timer, and so a shutdown can flush what is pending.
   */
  async drain(): Promise<number> {
    this.#last_run_at = new Date();

    const pending = await this.#db.$queryRaw<PendingPublication[]>`
      SELECT id, tenant_id, product_key, rate_display_paise,
             display_unit, source_timestamp, freshness, attempts
        FROM pending_rate_publications(${this.#options.batch_size})
    `;

    this.#backlog = pending.length;
    if (pending.length === 0) return 0;

    const delivered: bigint[] = [];
    const failed: bigint[] = [];
    let failure_detail = "";

    for (const row of pending) {
      try {
        await publish_rate_event(this.#redis, to_event(row));
        delivered.push(row.id);
      } catch (error) {
        failed.push(row.id);
        failure_detail = error instanceof Error ? error.message : String(error);

        if (row.attempts + 1 >= this.#options.poison_after_attempts) {
          this.#logger.error(
            {
              event: "outbox.poison",
              outbox_id: row.id.toString(),
              tenant_id: row.tenant_id,
              attempts: row.attempts + 1,
            },
            "publication event has failed repeatedly and is still being retried",
          );
        }

        // Stop the batch: Redis is almost certainly down for the rest of it
        // too, and continuing would burn the attempt counter on every row.
        break;
      }
    }

    if (delivered.length > 0) {
      // Marked only after a successful PUBLISH. A crash before this re-delivers
      // rather than losing the event.
      await this.#db.$executeRaw`
        SELECT mark_rate_publications_delivered(${delivered}::BIGINT[])
      `;
      this.#delivered += delivered.length;

      this.#logger.info(
        { event: "outbox.delivered", count: delivered.length },
        `delivered ${delivered.length} rate event(s)`,
      );
    }

    if (failed.length > 0) {
      this.#failed += failed.length;
      this.#last_error = failure_detail;
      await this.#db.$executeRaw`
        SELECT record_rate_publication_failure(${failed}::BIGINT[], ${failure_detail})
      `;
    }

    return delivered.length;
  }
}

/**
 * Build the wire event from an outbox row.
 *
 * `tenant_id` is present here because it is the Redis routing key — the channel
 * is per tenant. The public SSE route strips it before anything reaches a
 * browser; see `routes/public.ts`.
 */
export function to_event(row: PendingPublication): RateEvent {
  return {
    type: "rate_update",
    tenant_id: row.tenant_id,
    product_key: row.product_key,
    rate_display_paise: row.rate_display_paise.toString(),
    display_unit: row.display_unit,
    source_timestamp: row.source_timestamp.toISOString(),
    freshness: row.freshness as Freshness,
    emitted_at: new Date().toISOString(),
  };
}
