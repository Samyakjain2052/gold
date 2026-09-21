/**
 * JWKS retrieval, caching and rotation.
 *
 * ## Why not a network call per request
 *
 * Verification happens on every authenticated request. Fetching the key set
 * each time would put the identity provider on the critical path of every call,
 * multiply latency, and take the whole API down whenever they have a bad
 * minute. The key set is cached and refreshed on a schedule instead.
 *
 * ## Cache behaviour
 *
 * | Situation | Behaviour |
 * |---|---|
 * | Cached set is fresh and contains the `kid` | Serve from cache, no network |
 * | Cached set is fresh, `kid` unknown | Refresh **if** past the cooldown, else reject |
 * | Cached set is stale (> `cache_max_age_ms`) | Refresh before use |
 * | Refresh fails, cached set within `stale_grace_ms` | **Serve the stale set** and log |
 * | Refresh fails, no usable cache | Fail closed as `key_source_unavailable` (503) |
 * | Refresh succeeds | Replace the cache wholesale |
 *
 * Defaults: `cache_max_age_ms` 10 min, `cooldown_ms` 30 s, `stale_grace_ms`
 * 24 h.
 *
 * **10 minutes** bounds how long a revoked key stays usable while keeping
 * refreshes rare. **24 hours** of stale grace is deliberately generous: during a
 * provider outage, continuing to verify tokens against the last known-good keys
 * is far safer than rejecting every authenticated request. Keys are not secrets
 * and rotation is infrequent, so the exposure is small; a total auth outage is
 * not.
 *
 * ## Why the cooldown exists (and is load-bearing)
 *
 * An unknown `kid` is the signal that rotation has happened, so it triggers a
 * refresh. But `kid` is **attacker-controlled**: anyone can send tokens bearing
 * random `kid`s. Without a cooldown, each forged token would trigger an
 * outbound fetch, turning a trivial request flood into a denial-of-service
 * against the identity provider — and, via that, against ourselves. The
 * cooldown caps refreshes to one per window regardless of how many unknown kids
 * arrive.
 *
 * ## A failed fetch is never cached
 *
 * A failure leaves the previous key set in place. An empty or error result is
 * never stored, so a single bad response cannot poison verification until the
 * next TTL.
 */
import { createLocalJWKSet, type JWK, type JWTHeaderParameters } from "jose";
import type { Clock } from "../../platform/clock.js";
import { AuthenticationError } from "./principal.js";

export interface JwksSet {
  readonly keys: readonly JWK[];
}

export type JwksFetcher = (url: string) => Promise<JwksSet>;

export interface JwksCacheOptions {
  /** Beyond this age the set is refreshed before use. */
  readonly cache_max_age_ms: number;
  /** Minimum gap between refreshes triggered by an unknown `kid`. */
  readonly cooldown_ms: number;
  /** How long a stale set may still be served when refreshes are failing. */
  readonly stale_grace_ms: number;
  readonly fetch_timeout_ms: number;
}

export const DEFAULT_JWKS_CACHE_OPTIONS: JwksCacheOptions = {
  cache_max_age_ms: 600_000, // 10 minutes
  cooldown_ms: 30_000, // 30 seconds
  stale_grace_ms: 86_400_000, // 24 hours
  fetch_timeout_ms: 5_000,
};

export interface JwksCacheStats {
  readonly fetches: number;
  readonly failures: number;
  readonly cache_hits: number;
  readonly rotations_detected: number;
  readonly stale_serves: number;
  readonly cooldown_rejections: number;
  readonly cached_kids: readonly string[];
  readonly fetched_at: Date | null;
}

/** The default fetcher. Times out rather than hanging the auth path. */
export function create_http_jwks_fetcher(timeout_ms: number): JwksFetcher {
  return async (url: string): Promise<JwksSet> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout_ms);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`JWKS endpoint returned ${response.status}`);
      }

      const body: unknown = await response.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !Array.isArray((body as { keys?: unknown }).keys)
      ) {
        throw new Error("JWKS response has no `keys` array");
      }

      return { keys: (body as { keys: JWK[] }).keys };
    } finally {
      clearTimeout(timer);
    }
  };
}

export class JwksCache {
  readonly #url: string;
  readonly #options: JwksCacheOptions;
  readonly #fetcher: JwksFetcher;
  readonly #clock: Clock;

  #keys: readonly JWK[] = [];
  #fetched_at: number | null = null;
  #last_attempt_at: number | null = null;
  #in_flight: Promise<void> | null = null;

  #fetches = 0;
  #failures = 0;
  #cache_hits = 0;
  #rotations = 0;
  #stale_serves = 0;
  #cooldown_rejections = 0;

  constructor(
    url: string,
    clock: Clock,
    fetcher?: JwksFetcher,
    options: Partial<JwksCacheOptions> = {},
  ) {
    this.#url = url;
    this.#clock = clock;
    this.#options = { ...DEFAULT_JWKS_CACHE_OPTIONS, ...options };
    this.#fetcher =
      fetcher ?? create_http_jwks_fetcher(this.#options.fetch_timeout_ms);
  }

  /**
   * A `jose`-compatible key resolver.
   *
   * Passed to `jwtVerify`, which calls it with the token's protected header.
   * Signature verification is `jose`'s job; key *selection* is ours.
   */
  key_resolver() {
    return async (header: JWTHeaderParameters, ...rest: unknown[]) => {
      const keys = await this.#keys_for(header.kid);
      const local = createLocalJWKSet({ keys: [...keys] as JWK[] });
      return local(header, ...(rest as Parameters<typeof local>[1][]));
    };
  }

  /** Force a refresh. Used at startup to warm the cache. */
  async warm(): Promise<void> {
    await this.#refresh();
  }

  stats(): JwksCacheStats {
    return {
      fetches: this.#fetches,
      failures: this.#failures,
      cache_hits: this.#cache_hits,
      rotations_detected: this.#rotations,
      stale_serves: this.#stale_serves,
      cooldown_rejections: this.#cooldown_rejections,
      cached_kids: this.#keys.map((k) => k.kid ?? "(no kid)"),
      fetched_at: this.#fetched_at === null ? null : new Date(this.#fetched_at),
    };
  }

  async #keys_for(kid: string | undefined): Promise<readonly JWK[]> {
    const now = this.#clock.now();
    const age = this.#fetched_at === null ? Infinity : now - this.#fetched_at;

    // Never fetched, or the set has aged out.
    if (this.#fetched_at === null || age > this.#options.cache_max_age_ms) {
      await this.#refresh_or_serve_stale();
      return this.#keys;
    }

    if (kid !== undefined && !this.#has_kid(kid)) {
      // Rotation, or an attacker probing with a fabricated kid. The cooldown
      // makes those indistinguishable in cost.
      if (this.#within_cooldown(now)) {
        this.#cooldown_rejections += 1;
        throw new AuthenticationError(
          "unknown_key",
          "token key id is not in the cached key set and a refresh is on cooldown",
        );
      }

      const before = this.#keys.length;
      await this.#refresh_or_serve_stale();
      if (this.#keys.length !== before || !this.#has_kid(kid)) {
        this.#rotations += 1;
      }
      return this.#keys;
    }

    this.#cache_hits += 1;
    return this.#keys;
  }

  #has_kid(kid: string): boolean {
    return this.#keys.some((key) => key.kid === kid);
  }

  #within_cooldown(now: number): boolean {
    return (
      this.#last_attempt_at !== null &&
      now - this.#last_attempt_at < this.#options.cooldown_ms
    );
  }

  async #refresh_or_serve_stale(): Promise<void> {
    try {
      await this.#refresh();
    } catch (error) {
      const now = this.#clock.now();
      const usable =
        this.#fetched_at !== null &&
        this.#keys.length > 0 &&
        now - this.#fetched_at <= this.#options.stale_grace_ms;

      if (usable) {
        // Serving known-good keys through a provider outage beats rejecting
        // every authenticated request. Counted so it is visible in metrics.
        this.#stale_serves += 1;
        return;
      }

      throw new AuthenticationError(
        "key_source_unavailable",
        `unable to load signing keys: ${
          error instanceof Error ? error.message : "unknown failure"
        }`,
      );
    }
  }

  /** Single-flight: concurrent requests share one outbound fetch. */
  async #refresh(): Promise<void> {
    if (this.#in_flight !== null) return this.#in_flight;

    this.#last_attempt_at = this.#clock.now();

    this.#in_flight = (async () => {
      try {
        this.#fetches += 1;
        const set = await this.#fetcher(this.#url);

        if (!Array.isArray(set.keys) || set.keys.length === 0) {
          throw new Error("JWKS response contained no keys");
        }

        // Replaced wholesale only on success — a failure leaves the previous
        // set intact, so a bad response cannot poison verification.
        this.#keys = set.keys;
        this.#fetched_at = this.#clock.now();
      } catch (error) {
        this.#failures += 1;
        throw error;
      } finally {
        this.#in_flight = null;
      }
    })();

    return this.#in_flight;
  }
}
