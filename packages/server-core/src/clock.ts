/** The injectable clock (AAP 0.11.1). */

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
 * methods.
 */
export const systemClock: Clock = Object.freeze({
  now(): Date {
    return new Date(systemClock.nowMs());
  },
  nowMs(): number {
    return Date.now();
  },
});

/** How a `TestClock` tracks time. */
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

/** Where a frozen clock without an explicit `start` begins: 2026-11-04T12:00:00Z. */
export const DEFAULT_TEST_CLOCK_START = '2026-11-04T12:00:00.000Z';

const DEFAULT_TEST_CLOCK_START_MS = Date.parse(DEFAULT_TEST_CLOCK_START);

/** Create a controllable clock (AAP 0.11.1). */
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

/** Whether `clock` is controllable. */
export function isTestClock(clock: Clock): clock is TestClock {
  const candidate: Partial<TestClock> = clock;
  return typeof candidate.set === 'function' && typeof candidate.advance === 'function';
}

function instantMs(at: Date, source: string): number {
  const ms = at.getTime();
  if (Number.isNaN(ms)) {
    throw new RangeError(`${source} requires a valid Date, received an invalid Date`);
  }
  return ms;
}

function advanceMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(
      `advance() requires a finite, non-negative millisecond count, received ${ms}`,
    );
  }
  return ms;
}
