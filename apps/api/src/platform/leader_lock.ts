/**
 * Redis lease used to elect a single market poller across replicas.
 *
 * `ARCHITECTURE.md` §6: "The poller runs as a **single leader-elected worker**
 * holding a Redis lock, never once per replica." Without it, every replica
 * polls the provider, so provider cost and rate-limit consumption scale with
 * replica count — which is exactly the coupling the poller exists to remove.
 *
 * ## What this is, and is not
 *
 * This is a **lease**, not consensus. Redis is a single node here (Azure
 * Managed Redis B0), so this provides no better guarantee than that node's
 * availability, and it is deliberately not presented as a distributed
 * algorithm.
 *
 * The failure mode is documented rather than wished away: if a leader stalls
 * long enough for its lease to expire — a long GC pause, a suspended VM, a
 * network partition — a second replica can acquire the lease while the first
 * still believes it holds it. For a short window, two pollers may run.
 *
 * **Why that is tolerable here.** The critical section is idempotent. Two
 * pollers produce two quotes; the quote stream rejects the duplicate, and if
 * both are accepted they simply recompute the same rates to the same values.
 * `published_rates` is an upsert keyed on `(tenant_id, product_id)`, so a
 * concurrent recompute converges rather than corrupting. The observable cost of
 * a split lease is a doubled provider poll for a few seconds, not a wrong price.
 *
 * A fencing token is issued anyway (a monotonic counter) so that a stalled
 * leader can be *detected*: its token is stale relative to the current holder.
 * It is surfaced for logging and health rather than used to reject writes,
 * because the writes it would guard are already idempotent.
 *
 * ## Correctness of the primitives
 *
 * - Acquire is `SET key token NX PX ttl` — atomic, so two replicas cannot both
 *   take an unheld lease.
 * - Renew and release are Lua compare-and-delete/expire against the token, so a
 *   replica can never renew or release a lease that has already been taken from
 *   it. A bare `DEL` would let a stalled leader delete its successor's lease.
 */
import type { RedisClientType } from "redis";
import type { Clock } from "./clock.js";

/** Extends the lease only if we still hold it. */
const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

/** Releases the lease only if we still hold it. */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export interface LeaderLockOptions {
  readonly key: string;
  /** How long a lease survives without renewal. */
  readonly ttl_ms: number;
  /**
   * Renewal interval. Must be comfortably below `ttl_ms`, or a single slow
   * renewal drops the lease while the leader is still working.
   */
  readonly renew_interval_ms: number;
  /** How often a follower retries acquisition. */
  readonly retry_interval_ms: number;
}

export function default_lock_options(ttl_ms: number): LeaderLockOptions {
  return {
    key: "leader:market-poller",
    ttl_ms,
    // A third of the lease: two consecutive renewals may fail before it lapses.
    renew_interval_ms: Math.max(1_000, Math.floor(ttl_ms / 3)),
    retry_interval_ms: Math.max(1_000, Math.floor(ttl_ms / 2)),
  };
}

export interface LeaderState {
  readonly is_leader: boolean;
  /** Monotonic token for the current holder, or null when not held by us. */
  readonly fencing_token: number | null;
  readonly since: Date | null;
}

export type LeadershipListener = (state: LeaderState) => void;

export class LeaderLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaderLockError";
  }
}

/**
 * A single replica's attempt to hold the lease.
 *
 * `start()` begins campaigning and returns immediately; leadership is observed
 * through `on_change` and `state()`. Callers must not block on becoming leader,
 * because a follower is a perfectly valid steady state.
 */
export class LeaderLock {
  readonly #redis: RedisClientType;
  readonly #clock: Clock;
  readonly #options: LeaderLockOptions;
  /** Identifies this holder. Compared before every renew and release. */
  readonly #token: string;
  readonly #listeners = new Set<LeadershipListener>();

  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #is_leader = false;
  #fencing_token: number | null = null;
  #since: Date | null = null;

  constructor(
    redis: RedisClientType,
    clock: Clock,
    options: LeaderLockOptions,
    token: string = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  ) {
    if (options.renew_interval_ms >= options.ttl_ms) {
      throw new LeaderLockError(
        "renew_interval_ms must be below ttl_ms, or the lease lapses while held",
      );
    }
    this.#redis = redis;
    this.#clock = clock;
    this.#options = options;
    this.#token = token;
  }

  get token(): string {
    return this.#token;
  }

  state(): LeaderState {
    return {
      is_leader: this.#is_leader,
      fencing_token: this.#fencing_token,
      since: this.#since,
    };
  }

  on_change(listener: LeadershipListener): { unsubscribe: () => void } {
    this.#listeners.add(listener);
    return { unsubscribe: () => this.#listeners.delete(listener) };
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#tick();
  }

  /**
   * Stop campaigning and release the lease.
   *
   * Releasing explicitly rather than waiting for the TTL matters on a rolling
   * deploy: otherwise the feed pauses for up to a full lease while the
   * replacement waits for a lock nobody holds.
   */
  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!this.#is_leader) return;

    try {
      await this.#redis.eval(RELEASE_SCRIPT, {
        keys: [this.#options.key],
        arguments: [this.#token],
      });
    } catch {
      // Best effort. If Redis is unreachable the lease simply expires, and the
      // next replica takes over a lease-length later.
    }
    this.#set_leadership(false);
  }

  /** One campaign step. Reschedules itself; never throws. */
  async #tick(): Promise<void> {
    if (!this.#running) return;

    let next_delay = this.#options.retry_interval_ms;

    try {
      if (this.#is_leader) {
        const renewed = await this.#redis.eval(RENEW_SCRIPT, {
          keys: [this.#options.key],
          arguments: [this.#token, String(this.#options.ttl_ms)],
        });

        if (renewed === 1 || renewed === 1n) {
          next_delay = this.#options.renew_interval_ms;
        } else {
          // Lost it — expired while we stalled, or someone else took over.
          this.#set_leadership(false);
        }
      } else {
        const acquired = await this.#redis.set(
          this.#options.key,
          this.#token,
          { NX: true, PX: this.#options.ttl_ms },
        );

        if (acquired === "OK") {
          // Issued after the lease is held, so tokens strictly increase with
          // each successful acquisition across the cluster.
          const token = await this.#redis.incr(`${this.#options.key}:fence`);
          this.#fencing_token = Number(token);
          this.#set_leadership(true);
          next_delay = this.#options.renew_interval_ms;
        }
      }
    } catch {
      // Redis unavailable. A leader must assume it has lost the lease, because
      // it cannot renew and the lease will expire on the server regardless.
      if (this.#is_leader) this.#set_leadership(false);
    }

    if (!this.#running) return;
    this.#timer = setTimeout(() => void this.#tick(), next_delay);
  }

  #set_leadership(is_leader: boolean): void {
    if (this.#is_leader === is_leader) return;

    this.#is_leader = is_leader;
    this.#since = is_leader ? this.#clock.date() : null;
    if (!is_leader) this.#fencing_token = null;

    const state = this.state();
    for (const listener of this.#listeners) {
      try {
        listener(state);
      } catch {
        // A listener must not be able to break the election loop.
      }
    }
  }
}
