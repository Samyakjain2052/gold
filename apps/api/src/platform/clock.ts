/**
 * Time as an injected dependency.
 *
 * Freshness, reconnect backoff and staleness transitions are all functions of
 * elapsed time. Tests must drive that time explicitly rather than sleeping —
 * `testing-best-practices.md` §5 forbids hard waits, and a suite that waits ten
 * minutes to observe an expiry threshold is untestable in practice.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** A `Date` for the same instant, for values that travel to the database. */
  date(): Date;
}

export const system_clock: Clock = {
  now: () => Date.now(),
  date: () => new Date(),
};

/**
 * A clock tests advance by hand.
 *
 * Nothing observes wall-clock time, so a test can step across an hour-long
 * expiry threshold instantly and deterministically.
 */
export class ManualClock implements Clock {
  #now: number;

  constructor(start: number | Date = 0) {
    this.#now = start instanceof Date ? start.getTime() : start;
  }

  now(): number {
    return this.#now;
  }

  date(): Date {
    return new Date(this.#now);
  }

  /** Move time forward. Negative values are rejected — time does not run back. */
  advance(ms: number): void {
    if (ms < 0) {
      throw new Error(`ManualClock cannot advance by a negative ${ms}ms`);
    }
    this.#now += ms;
  }

  set(instant: number | Date): void {
    this.#now = instant instanceof Date ? instant.getTime() : instant;
  }
}
