import { describe, expect, test } from "vitest";
import { ManualClock, system_clock } from "../../src/platform/clock.js";

describe("system_clock", () => {
  test("SystemClock_now_tracksWallClock", () => {
    const before = Date.now();
    const observed = system_clock.now();
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(Date.now());
  });

  test("SystemClock_date_matchesNow", () => {
    expect(Math.abs(system_clock.date().getTime() - system_clock.now())).toBeLessThan(50);
  });
});

describe("ManualClock", () => {
  test("ManualClock_startsAtTheGivenInstant", () => {
    const start = new Date("2026-09-20T12:00:00.000Z");
    const clock = new ManualClock(start);

    expect(clock.now()).toBe(start.getTime());
    expect(clock.date().toISOString()).toBe(start.toISOString());
  });

  test("ManualClock_defaultsToEpoch", () => {
    expect(new ManualClock().now()).toBe(0);
  });

  test("ManualClock_acceptsANumericInstant", () => {
    expect(new ManualClock(1_000).now()).toBe(1_000);
  });

  test("ManualClock_advance_movesTimeForward", () => {
    const clock = new ManualClock(0);
    clock.advance(500);
    clock.advance(500);
    expect(clock.now()).toBe(1_000);
  });

  test("ManualClock_advanceZero_isAllowed", () => {
    const clock = new ManualClock(10);
    clock.advance(0);
    expect(clock.now()).toBe(10);
  });

  /** Time does not run backwards; a negative step is a test bug, not a feature. */
  test("ManualClock_advanceNegative_throws", () => {
    expect(() => new ManualClock(0).advance(-1)).toThrow(/negative/);
  });

  test("ManualClock_set_jumpsToAnInstant", () => {
    const clock = new ManualClock(0);
    clock.set(new Date("2026-01-01T00:00:00.000Z"));
    expect(clock.date().toISOString()).toBe("2026-01-01T00:00:00.000Z");

    clock.set(42);
    expect(clock.now()).toBe(42);
  });
});
