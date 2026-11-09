/**
 * Test-clock helpers and the one-shot settlement pass for `apps/api`'s suites (AAP 0.8.1 "test
 * clock", AAP 0.5.3, 0.11.1).
 *
 * `meetupPointMs` and `durationMs` name the boundaries AAP 0.5.3 judges a meetup at, computed from
 * the constants the API's own guards read, so a helper and the rule it aims at cannot drift. What a
 * jump moves is the server's clock alone, so `settleNow` runs one sweeper pass and one outbox pass
 * rather than waiting on a timer.
 */

import { isTestClock } from '@tablemate/server-core';
import {
  CHECK_IN_CLOSES_AFTER_MINUTES,
  CHECK_IN_OPENS_BEFORE_MINUTES,
  DAY_MS,
  DISPUTE_FILING_WINDOW_HOURS,
  HOUR_MS,
  LATE_CANCEL_WINDOW_HOURS,
  MINUTE_MS,
} from '@tablemate/shared';

import { runSweeper } from '../../src/modules/settlement/sweeper.ts';

import type { Clock, TestClock } from '@tablemate/server-core';
import type { AppServices } from '../../src/app.ts';
import type { SweepSummary } from '../../src/modules/settlement/sweeper.ts';

/** Milliseconds in one second. `@tablemate/shared` has no constant for it; the windows are in minutes. */
const SECOND_MS = 1_000 as const;

/**
 * A boundary of a meetup's life that a suite has to stand on (AAP 0.5.3): free cancellation until
 * `startsAt-2h`, the instant itself still free; check-in from `startsAt-15m` to `startsAt+45m`, where
 * settlement falls due; and dispute filing until `startsAt+24h`.
 */
export type MeetupPoint =
  'startsAt-2h' | 'startsAt-15m' | 'startsAt' | 'startsAt+45m' | 'startsAt+24h';

/** Each boundary's offset from the start, in the windows' own units (AAP 0.5.3, 0.11.1 density). */
const MEETUP_POINT_OFFSET_MS: Readonly<Record<MeetupPoint, number>> = {
  'startsAt-2h': -LATE_CANCEL_WINDOW_HOURS * HOUR_MS,
  'startsAt-15m': -CHECK_IN_OPENS_BEFORE_MINUTES * MINUTE_MS,
  startsAt: 0,
  'startsAt+45m': CHECK_IN_CLOSES_AFTER_MINUTES * MINUTE_MS,
  'startsAt+24h': DISPUTE_FILING_WINDOW_HOURS * HOUR_MS,
};

/**
 * Epoch milliseconds of `startsAt` shifted onto `point` (AAP 0.5.3). `startsAt` is the `Date` a row
 * carries or an ISO string; a value that is neither a valid `Date` nor parsable raises `RangeError`.
 */
export function meetupPointMs(startsAt: Date | string, point: MeetupPoint): number {
  return instantMs(startsAt, 'meetupPointMs') + MEETUP_POINT_OFFSET_MS[point];
}

/**
 * A span of time to move the test clock by (AAP 0.11.1): epoch milliseconds, or the named units a
 * suite reads better — `{ minutes: 46 }`, `{ days: 31 }`.
 */
export type Duration =
  number | { minutes?: number; hours?: number; days?: number; seconds?: number };

/**
 * `d` as milliseconds. Arithmetic only: the finiteness and sign checks live in `TestClock.advance`,
 * which refuses a negative or non-finite count (AAP 0.11.1).
 */
export function durationMs(d: Duration): number {
  if (typeof d === 'number') {
    return d;
  }
  return (
    (d.days ?? 0) * DAY_MS +
    (d.hours ?? 0) * HOUR_MS +
    (d.minutes ?? 0) * MINUTE_MS +
    (d.seconds ?? 0) * SECOND_MS
  );
}

/** What {@link clockHelpers} binds to one clock (AAP 0.11.1). */
export interface ClockHelpers {
  /** The clock's current instant, as a fresh `Date`. */
  now(): Date;
  /** Jump the clock to `instant`, and answer the instant it landed on. */
  at(instant: string | Date): Date;
  /** Move the clock forward by `d`, and answer the new instant. */
  advance(d: Duration): Date;
  /**
   * Jump the clock onto one of a meetup's boundaries, and answer the instant it landed on. `offsetMs`
   * shifts from that boundary, so one helper covers both sides of it: `1_000` past `startsAt-2h` is the
   * first late-cancel second and `60_000` past `startsAt+45m` is minute 46, outside the window.
   */
  toMeetupPoint(meetup: { startsAt: Date | string }, point: MeetupPoint, offsetMs?: number): Date;
}

/**
 * Bind the boundary helpers to the clock a suite built (AAP 0.11.1). The parameter is the `Clock` a
 * suite holds, not a `TestClock`, so the guard below is reachable at run time: a suite whose app was
 * built without a test clock fails on the line that moves it instead of running against the system
 * clock, which a later assertion about a window that never opened would blame instead.
 */
export function clockHelpers(clock: Clock): ClockHelpers {
  if (!isTestClock(clock)) {
    throw new TypeError(
      'clockHelpers requires the TestClock the suite built: the clock given implements no set and no advance',
    );
  }
  // The guard's narrowing does not reach a closure, and every helper below is one, so the narrowed
  // clock is bound once to a const that carries that narrowing into each of them.
  const controllable: TestClock = clock;
  /** Move the clock to `ms` and answer that instant, as the clock reads it (always a fresh `Date`). */
  function moveTo(ms: number): Date {
    controllable.set(new Date(ms));
    return controllable.now();
  }
  return {
    now: () => controllable.now(),
    at: (instant) => moveTo(instantMs(instant, 'at')),
    advance: (d) => {
      controllable.advance(durationMs(d));
      return controllable.now();
    },
    toMeetupPoint: (meetup, point, offsetMs = 0) =>
      moveTo(meetupPointMs(meetup.startsAt, point) + offsetMs),
  };
}

/**
 * What one {@link settleNow} call did (AAP 0.3.2): the sweeper's own summary, including `skipped`
 * when another pass held the advisory lock, and the outbox rows the pass that followed delivered.
 */
export interface SettlementPass {
  /** What the sweeper pass decided and executed. */
  readonly sweep: SweepSummary;
  /** Outbox rows the pass that followed delivered; `0` when none was waiting. */
  readonly dispatched: number;
}

/**
 * Run exactly one settlement pass and deliver what it committed (AAP 0.3.2, 0.5.4).
 *
 * The pass runs with `waitForLock`, so a pass that finds a background one in flight waits for it
 * rather than skipping and reporting nothing. The outbox pass follows because a settlement only plans
 * the provider calls it decides and the poller that would deliver its rows is not running in a suite,
 * so a suite that asserts on a notification reads a delivered state rather than a pending one. No
 * timer is started and no background loop is touched: this is one pass of each, awaited.
 */
export async function settleNow(services: AppServices): Promise<SettlementPass> {
  const sweep = await runSweeper(services, { waitForLock: true });
  const dispatched = await services.outbox.runOnce();
  return { sweep, dispatched };
}

/**
 * Epoch milliseconds of a `Date` or a date string. A suite that wrote a typo into an ISO literal has
 * to fail where it wrote it, not minutes later on an assertion about a window, so this reports which
 * call and which kind of value was wrong.
 */
function instantMs(value: Date | string, source: string): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) {
      throw new RangeError(`${source} requires a valid Date, received an invalid one`);
    }
    return ms;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new RangeError(
      `${source} requires a parsable date string, received ${JSON.stringify(value)}`,
    );
  }
  return ms;
}
