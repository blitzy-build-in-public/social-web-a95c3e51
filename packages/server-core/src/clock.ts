/**
 * The injectable clock (AAP 0.11.1).
 *
 * AAP 0.11.1 makes this a domain invariant: "Time comes from the injected clock, never `Date.now()`
 * directly, so tests can advance it." The criterion tests have to cross the 45-minute check-in
 * window, the 24-hour booking-detail erasure limit and the 30-day anti-farming rule, and
 * `POST /v1/test/clock` (AAP 0.5.4) exists to move the clock forward for them.
 *
 * This is the only server file that reads the system clock, and it reads it in exactly one place,
 * `systemClock.nowMs`. Every other module takes a `Clock` and asks it for the time, which is what
 * lets the root eslint configuration ban `Date.now()` and argument-less `new Date()` everywhere
 * else.
 */

/** A source of the current time (AAP 0.11.1). */
export interface Clock {
  /**
   * The current instant as a **new** `Date` on every call. `Date` is mutable, so handing the same
   * instance to two callers would let one of them move the clock the other reads.
   */
  now(): Date;
  /** The current instant as epoch milliseconds, the form timestamps are compared in. */
  nowMs(): number;
}

/**
 * The process clock: real time, every module's default, and frozen so no caller can replace its
 * methods. The single call site of `Date.now()` in the server (AAP 0.11.1).
 */
export const systemClock: Clock = Object.freeze({
  now(): Date {
    return new Date(systemClock.nowMs());
  },
  nowMs(): number {
    return Date.now();
  },
});

/**
 * How a `TestClock` tracks time.
 *
 * `frozen` stands still until `set` or `advance` moves it, which is what unit tests want.
 * `flowing` keeps moving with real time at a fixed offset, which is what a running `APP_ENV=test`
 * API and the venue-console countdown need, and what `POST /v1/test/clock` (AAP 0.5.4) relies on.
 */
export type TestClockMode = 'frozen' | 'flowing';

/** A controllable clock: `set`, `advance` and `reset` move this instance alone (AAP 0.11.1). */
export interface TestClock extends Clock {
  /** The mode given at creation; it never changes afterwards. */
  readonly mode: TestClockMode;
  /**
   * Jump to `at`.
   *
   * @throws RangeError when `at` is an invalid `Date`.
   */
  set(at: Date): void;
  /**
   * Move forward by `ms`.
   *
   * @throws RangeError when `ms` is not finite or is negative.
   */
  advance(ms: number): void;
  /** Restore the state this clock was created with. */
  reset(): void;
}

/**
 * Where a frozen clock without an explicit `start` begins: 2026-11-04T12:00:00Z.
 *
 * An ISO string rather than a `Date`, so no mutable instance is shared between callers and every
 * test that omits `start` reads the same deterministic instant.
 */
export const DEFAULT_TEST_CLOCK_START = '2026-11-04T12:00:00.000Z';

const DEFAULT_TEST_CLOCK_START_MS = Date.parse(DEFAULT_TEST_CLOCK_START);

/**
 * Create a controllable clock (AAP 0.11.1).
 *
 * @param options - the creation state; omit it for a frozen clock at {@link DEFAULT_TEST_CLOCK_START}.
 * @param options.start - the instant to begin at. A frozen clock defaults to
 * {@link DEFAULT_TEST_CLOCK_START}; a flowing clock without it keeps the real time it already has.
 * @param options.mode - `'frozen'` (the default) or `'flowing'`.
 * @param options.base - the clock a flowing clock measures real time by, default {@link systemClock}.
 * Injectable so the flowing mode is itself testable without waiting on the real clock.
 * @returns a `TestClock` whose `set`, `advance` and `reset` affect this instance only.
 * @throws RangeError when `start` is an invalid `Date`.
 */
export function createTestClock(options?: {
  start?: Date;
  mode?: TestClockMode;
  base?: Clock;
}): TestClock {
  const start = options?.start;
  const mode = options?.mode ?? 'frozen';
  const base = options?.base ?? systemClock;
  const startMs = start === undefined ? undefined : instantMs(start, 'start');
  const initialMs = startMs ?? DEFAULT_TEST_CLOCK_START_MS;
  const initialOffsetMs = startMs === undefined ? 0 : startMs - base.nowMs();
  let frozenMs = initialMs;
  let offsetMs = initialOffsetMs;

  const nowMs = (): number => (mode === 'frozen' ? frozenMs : base.nowMs() + offsetMs);
  const set = (at: Date): void => {
    const ms = instantMs(at, 'set()');
    if (mode === 'frozen') {
      frozenMs = ms;
    } else {
      offsetMs = ms - base.nowMs();
    }
  };
  const advance = (ms: number): void => {
    const delta = advanceMs(ms);
    if (mode === 'frozen') {
      frozenMs += delta;
    } else {
      offsetMs += delta;
    }
  };
  const reset = (): void => {
    frozenMs = initialMs;
    offsetMs = initialOffsetMs;
  };

  return Object.freeze({ mode, nowMs, now: () => new Date(nowMs()), set, advance, reset });
}

/**
 * Whether `clock` is controllable. The test-control routes (AAP 0.5.4) confirm the injected clock
 * implements `set` and `advance` before they mutate it, because `buildApp` may have been handed the
 * {@link systemClock} instead of a `TestClock`.
 */
export function isTestClock(clock: Clock): clock is TestClock {
  const candidate: Partial<TestClock> = clock;
  return typeof candidate.set === 'function' && typeof candidate.advance === 'function';
}

/** Epoch milliseconds of `at`, or a `RangeError` when it is an invalid `Date`. */
function instantMs(at: Date, source: string): number {
  const ms = at.getTime();
  if (Number.isNaN(ms)) {
    throw new RangeError(`${source} requires a valid Date, received an invalid Date`);
  }
  return ms;
}

/** `ms` when it is a finite, non-negative millisecond count, or a `RangeError` otherwise. */
function advanceMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(
      `advance() requires a finite, non-negative millisecond count, received ${ms}`,
    );
  }
  return ms;
}
