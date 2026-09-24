/**
 * The centralised market-data consumer.
 *
 * `ARCHITECTURE.md` §6: one leader-elected poller per environment, never one
 * per replica and certainly never one per browser. Provider consumption is
 * therefore a function of the poll interval alone — it does not grow with
 * replicas or with customers. (Redis fan-out and SSE connections *do* grow with
 * customers; only the provider call is decoupled.)
 *
 * ## What it does
 *
 * While this replica holds the leader lease:
 *   1. ask the provider for the configured symbols, through `MarketDataService`
 *      so validation, deduplication and freshness are applied uniformly;
 *   2. for each accepted quote, recompute and publish affected tenants' rates.
 *
 * It never calls a provider directly from a route, and never prices anything
 * itself — `MarketDataService` owns ingestion, the publication service owns
 * recomputation.
 *
 * ## Overlap and failure
 *
 * A poll that is still running when the next tick is due is skipped, not
 * queued: a slow provider must not build a backlog of concurrent requests
 * against itself. A failing poll is logged and counted, and the loop continues
 * — a provider outage must not take the API down, and the last good rates stay
 * in `published_rates` and age visibly.
 */
import type { Clock } from "../../platform/clock.js";
import type { Logger } from "../../platform/logger.js";
import type { LeaderLock } from "../../platform/leader_lock.js";
import type { MarketDataService } from "./market_data_service.js";
import type { QuoteSnapshot } from "./types.js";
import {
  publish_for_quote,
  type PublicationDependencies,
  type PublicationOutcome,
} from "../publication/publication_service.js";

export interface MarketPollerOptions {
  readonly symbols: readonly string[];
  readonly interval_ms: number;
}

export interface PollerStats {
  readonly polls: number;
  readonly failures: number;
  readonly consecutive_failures: number;
  readonly last_poll_at: Date | null;
  readonly last_success_at: Date | null;
  readonly last_duration_ms: number | null;
  readonly last_error: string | null;
  readonly published: number;
  readonly is_leader: boolean;
  readonly running: boolean;
}

export class MarketPoller {
  readonly #service: MarketDataService;
  readonly #lock: LeaderLock;
  readonly #publication: PublicationDependencies;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #options: MarketPollerOptions;

  /**
   * Quotes accepted since the last drain.
   *
   * Publication is driven by `MarketDataService.on_quote`, not by the return of
   * `ingest_many`, because a provider may deliver the same quote by both paths:
   * the mock emits to subscribers *and* answers a pull with the same payload,
   * and a streaming adapter pushes while the poller still pulls a snapshot on
   * start. Listening to acceptance means each quote publishes exactly once —
   * whichever path first delivered it — and the second arrival is rejected as a
   * duplicate, which is precisely what the quote stream is for.
   */
  readonly #accepted: QuoteSnapshot[] = [];
  #quote_subscription: { unsubscribe: () => void } | null = null;

  #timer: NodeJS.Timeout | null = null;
  #started = false;
  #polling = false;
  #service_started = false;

  #polls = 0;
  #failures = 0;
  #consecutive_failures = 0;
  #last_poll_at: Date | null = null;
  #last_success_at: Date | null = null;
  #last_duration_ms: number | null = null;
  #last_error: string | null = null;
  #published = 0;

  constructor(
    service: MarketDataService,
    lock: LeaderLock,
    publication: PublicationDependencies,
    logger: Logger,
    clock: Clock,
    options: MarketPollerOptions,
  ) {
    this.#service = service;
    this.#lock = lock;
    this.#publication = publication;
    this.#logger = logger;
    this.#clock = clock;
    this.#options = options;
  }

  stats(): PollerStats {
    return {
      polls: this.#polls,
      failures: this.#failures,
      consecutive_failures: this.#consecutive_failures,
      last_poll_at: this.#last_poll_at,
      last_success_at: this.#last_success_at,
      last_duration_ms: this.#last_duration_ms,
      last_error: this.#last_error,
      published: this.#published,
      is_leader: this.#lock.state().is_leader,
      running: this.#started,
    };
  }

  /**
   * Begin campaigning for leadership and polling once elected.
   *
   * Returns immediately. A replica that never wins the lease simply never
   * polls, which is the intended steady state for all but one of them.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    this.#lock.on_change((state) => {
      this.#logger.info(
        {
          event: state.is_leader ? "poller.leader_acquired" : "poller.leader_lost",
          fencing_token: state.fencing_token,
        },
        state.is_leader
          ? "this replica is now the market poller"
          : "this replica is no longer the market poller",
      );

      if (state.is_leader) {
        void this.#ensure_service_started();
      }
    });

    this.#lock.start();
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    // Release the lease before tearing the provider down, so a replacement can
    // take over immediately rather than waiting out the TTL.
    this.#quote_subscription?.unsubscribe();
    this.#quote_subscription = null;

    await this.#lock.stop();

    if (this.#service_started) {
      this.#service_started = false;
      await this.#service.stop().catch(() => {});
    }
  }

  /**
   * Run one poll regardless of leadership.
   *
   * Exists for tests and for a manual recompute; the scheduled loop always
   * checks the lease first.
   */
  async poll_once(): Promise<PublicationOutcome[]> {
    if (this.#polling) return [];
    this.#polling = true;

    const started = Date.now();
    this.#polls += 1;
    this.#last_poll_at = this.#clock.date();

    try {
      await this.#ensure_service_started();

      const payloads = await this.#service.provider_latest(this.#options.symbols);

      // Ingestion goes through the service so validation, duplicate and
      // out-of-order rejection and freshness all apply. The return is ignored:
      // acceptance is observed through the listener registered in `start`, so a
      // quote that arrived by the provider's push path is published too, and
      // exactly once.
      this.#service.ingest_many(payloads);

      // Drained rather than iterated in place: a quote accepted while we are
      // publishing belongs to the next pass, not this one.
      const accepted = this.#accepted.splice(0);

      const outcomes: PublicationOutcome[] = [];
      for (const snapshot of accepted) {
        outcomes.push(await publish_for_quote(this.#publication, snapshot));
      }

      this.#published += outcomes.reduce((sum, o) => sum + o.published, 0);
      this.#consecutive_failures = 0;
      this.#last_success_at = this.#clock.date();
      this.#last_error = null;

      return outcomes;
    } catch (error) {
      this.#failures += 1;
      this.#consecutive_failures += 1;
      this.#last_error = error instanceof Error ? error.message : String(error);

      this.#logger.error(
        {
          event: "poller.failed",
          consecutive_failures: this.#consecutive_failures,
          err: this.#last_error,
        },
        "market poll failed; previous rates stand and will age",
      );

      return [];
    } finally {
      this.#last_duration_ms = Date.now() - started;
      this.#polling = false;
    }
  }

  /**
   * Attach to the service and start the provider, once.
   *
   * The quote listener is registered here rather than in `start()` because
   * `poll_once` is reachable without `start()` — for a manual recompute and in
   * tests — and a poll that silently published nothing because no listener was
   * attached would be a very quiet bug.
   */
  async #ensure_service_started(): Promise<void> {
    if (this.#service_started) return;
    this.#service_started = true;

    this.#quote_subscription = this.#service.on_quote((snapshot) => {
      this.#accepted.push(snapshot);
    });

    await this.#service.start();
  }

  #schedule(delay_ms: number): void {
    if (!this.#started) return;
    this.#timer = setTimeout(() => void this.#tick(), delay_ms);
  }

  async #tick(): Promise<void> {
    if (!this.#started) return;

    if (this.#lock.state().is_leader) {
      await this.poll_once();
    }

    this.#schedule(this.#options.interval_ms);
  }
}
