/**
 * Test-clock helpers and the one-shot settlement pass for `apps/api`'s suites (AAP 0.8.1 "test
 * clock", AAP 0.5.3, 0.11.1, 0.11.2).
 *
 * The criterion and integration suites have to cross the boundaries AAP 0.5.3 judges a meetup at —
 * free cancellation until `startsAt − 2 h`, the check-in window from `startsAt − 15 min` to
 * `startsAt + 45 min`, settlement at `startsAt + 45 min`, dispute filing until `startsAt + 24 h` —
 * without waiting for them in real time, and they have to read the result in the same tick. Two
 * things make that possible, and both live here:
 *
 *  - {@link meetupPointMs} and {@link durationMs} name those boundaries, and {@link clockHelpers}
 *    moves the injected `TestClock` onto one, so no suite writes a millisecond literal of its own.
 *    The offsets are computed from `@tablemate/shared`, the constants the API's own guards read, so
 *    a helper and the rule it aims at cannot drift apart.
 *  - {@link settleNow} runs one sweeper pass and one outbox pass. A settlement only *plans* the
 *    provider calls it decides and `settlement/sweeper.ts` is the executor that carries them out
 *    (AAP 0.3.2), so a suite that skipped the pass would read a meetup settled while its hold was
 *    still pending; the outbox pass then delivers the rows the settlement committed — its
 *    notifications and the jobs they carry — before the suite asserts. This mirrors
 *    `POST /v1/test/run-settlement` (AAP 0.5.4) without HTTP, which is what lets these suites keep
 *    background work off and drive their timers deterministically.
 *
 * What a jump moves is the server's clock alone. A delayed BullMQ job fires on Redis' own wall-clock
 * time, so timers are driven through {@link settleNow} rather than waited for. The 15-minute access
 * token is judged by that same clock, so a suite that advances past it signs a new one —
 * `TestApp.tokenFor` in `apps/api/test/support/app.ts` — before its next authenticated call.
 *
 * Nothing here reads the system clock, starts a timer or runs a loop: `Date.now()` and argument-less
 * `new Date()` are as absent as they are from `apps/api/src` (AAP 0.11.1), and every instant comes
 * from the clock the suite built.
 *
 * @see AAP 0.5.3 for the transitions and windows the boundaries come from, 0.5.4 for the test-control
 *   route this mirrors, 0.11.1 for the injected clock, 0.11.2 for the harness, 0.12.1 for the
 *   criterion suites that drive it, and 0.8.1 for this file's inventory row.
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

/* Pure helpers (AAP 0.5.3, 0.11.1) */

/** Milliseconds in one second. `@tablemate/shared` has no constant for it; the windows are in minutes. */
const SECOND_MS = 1_000 as const;

/**
 * A boundary of a meetup's life that a suite has to stand on (AAP 0.5.3, 0.5.4).
 *
 *  - `startsAt-2h` — cancellation stops being free (`LATE_CANCEL_WINDOW_HOURS`). Exactly this
 *    instant is still free and the second after it is not, which is the boundary both
 *    `cancellation-rules.test.ts` and `meetups.test.ts` are required to cover (AAP 0.5.3).
 *  - `startsAt-15m` — check-in opens; earlier is `410 outside_window` (`CHECK_IN_OPENS_BEFORE_MINUTES`).
 *  - `startsAt` — the start itself, inside the check-in window.
 *  - `startsAt+45m` — check-in closes and settlement falls due, the same instant by design
 *    (`CHECK_IN_CLOSES_AFTER_MINUTES`).
 *  - `startsAt+24h` — dispute filing closes; `409 dispute_window_closed` (`DISPUTE_FILING_WINDOW_HOURS`).
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
 * Epoch milliseconds of `startsAt` shifted onto `point` (AAP 0.5.3).
 *
 * @param startsAt - the meetup's start, as the row carries it (`Date`) or as an ISO string.
 * @param point - which boundary.
 * @returns Epoch milliseconds, the form `Clock.set` takes through a `Date`.
 * @throws {RangeError} when `startsAt` is neither a valid `Date` nor a parsable date string.
 */
export function meetupPointMs(startsAt: Date | string, point: MeetupPoint): number {
  return instantMs(startsAt, 'meetupPointMs') + MEETUP_POINT_OFFSET_MS[point];
}

/**
 * A span of time to move the test clock by (AAP 0.11.1).
 *
 * Epoch milliseconds, or the named units a suite reads better: `{ minutes: 46 }` for one minute past
 * the check-in window, `{ days: 31 }` for one past the 30-day anti-farming window.
 */
export type Duration =
  number | { minutes?: number; hours?: number; days?: number; seconds?: number };

/**
 * `d` as milliseconds.
 *
 * Arithmetic only: the finiteness and sign checks a clock needs live in `TestClock.advance`, which
 * refuses a negative or non-finite count (AAP 0.11.1).
 *
 * @param d - a millisecond count or whole units of seconds, minutes, hours and days.
 * @returns The sum of the units given, in milliseconds; `0` for an empty object.
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

/* clockHelpers (AAP 0.11.1) */

/** What {@link clockHelpers} binds to one clock (AAP 0.11.1). */
export interface ClockHelpers {
  /** The clock's current instant, as a fresh `Date`. */
  now(): Date;
  /** Jump the clock to `instant`, and answer the instant it landed on. */
  at(instant: string | Date): Date;
  /** Move the clock forward by `d`, and answer the new instant. */
  advance(d: Duration): Date;
  /**
   * Jump the clock onto one of a meetup's boundaries, and answer the instant it landed on.
   *
   * @param meetup - anything carrying the meetup's `startsAt`, a row or a DTO.
   * @param point - which boundary.
   * @param offsetMs - a shift from that boundary, so one helper covers both sides of it: `1_000`
   *   past `startsAt-2h` is the first late-cancel second, and `60_000` past `startsAt+45m` is
   *   minute 46, where check-in answers `410 outside_window` (AAP 0.5.4). Defaults to `0`.
   */
  toMeetupPoint(meetup: { startsAt: Date | string }, point: MeetupPoint, offsetMs?: number): Date;
}

/**
 * Bind the boundary helpers to the clock a suite built (AAP 0.11.1).
 *
 * The parameter is the `Clock` a suite holds — normally `app.services.clock`, which is typed `Clock`
 * because `buildApp` may have been handed the process clock — rather than a `TestClock`, so the
 * guard below is reachable at run time: a suite whose app was built without a test clock fails on
 * the line that moves it, instead of silently running against `systemClock` and failing much later
 * on a window that never opened.
 *
 * @param clock - the injected clock; a `TestClock` from `createTestClock`, or the clock
 *   `buildApp(deps)` was given through `deps.clock`.
 * @returns The four helpers over that clock.
 * @throws {TypeError} when `clock` implements no `set` and no `advance` (`isTestClock`,
 *   `packages/server-core/src/clock.ts`): a composition fault in the suite, with no contract code
 *   behind it, so it is thrown rather than returned as a domain error.
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

/* settleNow (AAP 0.3.2, 0.5.4) */

/**
 * What one {@link settleNow} call did (AAP 0.3.2, 0.5.4).
 *
 * `sweep` is what `runSweeper` resolved with —
 * `Awaited<ReturnType<typeof runSweeper>>`, the summary it exports as `SweepSummary`, including
 * `skipped` when another pass held the advisory lock.
 */
export interface SettlementPass {
  /** What the sweeper pass decided and executed. */
  readonly sweep: SweepSummary;
  /** Outbox rows the pass that followed delivered; `0` when none was waiting. */
  readonly dispatched: number;
}

/**
 * Run exactly one settlement pass and deliver what it committed (AAP 0.3.2, 0.5.3, 0.5.4).
 *
 * The pass runs with `waitForLock`, which `settlement/sweeper.ts` names this helper as a caller of:
 * a pass that finds a background one in flight then waits for it instead of skipping and reporting
 * nothing, so the suite observes the effect of its own clock jump and a meetup is settled once.
 *
 * The outbox pass follows, in the order a settlement needs: the pass commits one outcome, its
 * captures and releases, and its notification rows, and the poller that would otherwise deliver
 * those rows is not running in a suite. A suite that asserts on a notification, or on a job a
 * `workers` outbox row carries, therefore reads a delivered state rather than a pending one.
 *
 * No timer is started and no background loop is touched: this is one pass of each, awaited.
 *
 * @param services - the app's services; only `services.db`, `services.clock`, `services.logger` and
 *   `services.outbox` are read, by the pass and by the poller.
 * @returns The pass's summary and the number of rows the outbox delivered.
 * @see AAP 0.5.4 for `POST /v1/test/run-settlement`, the HTTP form of this call.
 */
export async function settleNow(services: AppServices): Promise<SettlementPass> {
  const sweep = await runSweeper(services, { waitForLock: true });
  const dispatched = await services.outbox.runOnce();

  return { sweep, dispatched };
}

/* Shared parsing */

/**
 * Epoch milliseconds of a `Date` or a date string.
 *
 * A suite that wrote a typo into an ISO literal has to fail where it wrote it, not minutes later on
 * an assertion about a window, so this reports which call and which kind of value was wrong.
 *
 * @param value - the `Date` or date string to read.
 * @param source - the caller's name, for the message.
 * @throws {RangeError} when the value is an invalid `Date` or an unparsable string.
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
