/**
 * The calling-hours rule's unit suite (AAP 0.5.6): the 09:00-20:00 window in the business's own
 * city, the `now + CAP_CALL_SECONDS <= 20:00` bound, and the deferral to the next 09:00 local.
 *
 * Every instant is written as UTC and its city-local reading is stated beside it, so a failure names
 * the boundary it broke rather than an offset. The offsets come from the pinned luxon 3.7.2 through
 * `packages/server-core/src/time/city-time.ts`, the only place that speaks a zone (AAP 0.11.1): all
 * five launch cities appear here, and Lisbon carries the two readings a DST transition produces.
 *
 * The cases come in two forms, and they check the rule from both sides. The tables below write the
 * UTC instant out, which pins the arithmetic the rule performs on a caller's `Date`, while the
 * `describe.each(ZONES)` cases derive it from the city's own clock through `localTimeOn` plus an
 * explicit seconds offset and assert the deferral against `nextLocalDayAt`, so a wall-time
 * conversion that drifts from the zone fails here rather than in production.
 *
 * `CAP_CALL_SECONDS` is the environment variable that supplies the call's length (AAP 0.6.2); its
 * 300-second default, which is also Twilio's `timeLimit`, is what the boundary cases use.
 *
 * @see AAP 0.5.6 for the window and the deferral, 0.6.2 for the cap's default, 0.11.1 for the
 *   injected clock, and 0.12.2 for the "Calling hours 09:00-20:00 local, at most 2 attempts at least
 *   24 h apart, disclosure first, do-not-call honoured" constraint this suite serves.
 */

import { describe, expect, it } from 'vitest';

import { localTimeOn, nextLocalDayAt } from '@tablemate/server-core';

import {
  CALLING_HOURS_END,
  CALLING_HOURS_START,
  nextCallingWindow,
  withinCallingHours,
} from '../../src/calls/calling-hours.ts';

/** `CAP_CALL_SECONDS` (AAP 0.5.6). */
const CAP_CALL_SECONDS = 300;

/** A window case: the city's zone, the instant, how long the call may last, and the verdict. */
type WindowCase = readonly [zone: string, at: string, maxSeconds: number, within: boolean];

/** A deferral case: the city's zone, the instant, and the next 09:00 local as a UTC instant. */
type DeferralCase = readonly [zone: string, at: string, next: string];

/**
 * The 09:00 opening and the closing bound, in every launch city's zone (AAP 0.5.6): 09:00:00 local is
 * allowed and 08:59:59 is not; with a 300-second call, 19:55:00 local is allowed and 19:55:01 is not.
 */
const WINDOW_CASES: readonly WindowCase[] = [
  // Lisbon in summer, WEST = UTC+1.
  ['Europe/Lisbon', '2026-07-01T07:59:59Z', CAP_CALL_SECONDS, false], // 08:59:59 local
  ['Europe/Lisbon', '2026-07-01T08:00:00Z', CAP_CALL_SECONDS, true], // 09:00:00 local
  ['Europe/Lisbon', '2026-07-01T18:55:00Z', CAP_CALL_SECONDS, true], // 19:55:00 local
  ['Europe/Lisbon', '2026-07-01T18:55:01Z', CAP_CALL_SECONDS, false], // 19:55:01 local
  // Lisbon in winter, WET = UTC+0.
  ['Europe/Lisbon', '2026-01-15T08:59:59Z', CAP_CALL_SECONDS, false],
  ['Europe/Lisbon', '2026-01-15T09:00:00Z', CAP_CALL_SECONDS, true],
  ['Europe/Lisbon', '2026-01-15T19:55:00Z', CAP_CALL_SECONDS, true],
  ['Europe/Lisbon', '2026-01-15T19:55:01Z', CAP_CALL_SECONDS, false],
  // Mexico City, CST = UTC-6 all year.
  ['America/Mexico_City', '2026-07-01T14:59:59Z', CAP_CALL_SECONDS, false], // 08:59:59 local
  ['America/Mexico_City', '2026-07-01T15:00:00Z', CAP_CALL_SECONDS, true], // 09:00:00 local
  ['America/Mexico_City', '2026-07-02T01:55:00Z', CAP_CALL_SECONDS, true], // 19:55:00 local
  ['America/Mexico_City', '2026-07-02T01:55:01Z', CAP_CALL_SECONDS, false], // 19:55:01 local
  // Medellín, COT = UTC-5 all year.
  ['America/Bogota', '2026-07-01T13:59:59Z', CAP_CALL_SECONDS, false], // 08:59:59 local
  ['America/Bogota', '2026-07-01T14:00:00Z', CAP_CALL_SECONDS, true], // 09:00:00 local
  ['America/Bogota', '2026-07-02T00:55:00Z', CAP_CALL_SECONDS, true], // 19:55:00 local
  ['America/Bogota', '2026-07-02T00:55:01Z', CAP_CALL_SECONDS, false], // 19:55:01 local
  // Chiang Mai, ICT = UTC+7 all year.
  ['Asia/Bangkok', '2026-07-01T01:59:59Z', CAP_CALL_SECONDS, false], // 08:59:59 local
  ['Asia/Bangkok', '2026-07-01T02:00:00Z', CAP_CALL_SECONDS, true], // 09:00:00 local
  ['Asia/Bangkok', '2026-07-01T12:55:00Z', CAP_CALL_SECONDS, true], // 19:55:00 local
  ['Asia/Bangkok', '2026-07-01T12:55:01Z', CAP_CALL_SECONDS, false], // 19:55:01 local
  // Canggu, WITA = UTC+8 all year.
  ['Asia/Makassar', '2026-07-01T00:59:59Z', CAP_CALL_SECONDS, false], // 08:59:59 local
  ['Asia/Makassar', '2026-07-01T01:00:00Z', CAP_CALL_SECONDS, true], // 09:00:00 local
  ['Asia/Makassar', '2026-07-01T11:55:00Z', CAP_CALL_SECONDS, true], // 19:55:00 local
  ['Asia/Makassar', '2026-07-01T11:55:01Z', CAP_CALL_SECONDS, false], // 19:55:01 local
];

/**
 * The window's own edges and the cases where the city is closed or the span would cross local
 * midnight, none of which depends on the call's length.
 */
const EDGE_CASES: readonly WindowCase[] = [
  // A zero-length call closes at exactly 20:00:00 local, which is inside, one second later is not.
  ['Europe/Lisbon', '2026-07-01T19:00:00Z', 0, true], // 20:00:00 local
  ['Europe/Lisbon', '2026-07-01T19:00:01Z', 0, false], // 20:00:01 local
  // A five-hour call fits only while it ends by 20:00 local.
  ['Europe/Lisbon', '2026-07-01T14:00:00Z', 18_000, true], // 15:00:00 -> 20:00:00 local
  ['Europe/Lisbon', '2026-07-01T14:00:00Z', 18_001, false], // 15:00:00 -> 20:00:01 local
  // The city is open but the call would run past 20:00, and a late evening is outside entirely.
  ['Asia/Makassar', '2026-07-01T12:00:00Z', 3_600, false], // 20:00:00 -> 21:00:00 local
  ['Asia/Makassar', '2026-07-01T15:30:00Z', CAP_CALL_SECONDS, false], // 23:30:00 local
  // A span whose end falls on the next local date is outside: it is not on `now`'s local date.
  ['Asia/Makassar', '2026-07-01T14:00:00Z', 7_200, false], // 22:00:00 -> 00:00:00 next day
  ['Europe/Lisbon', '2026-07-01T08:00:00Z', 86_400, false], // 09:00:00 -> 09:00:00 next day
];

/**
 * The next 09:00 local for an instant outside the window, in every launch city's zone (AAP 0.5.6).
 *
 * An instant strictly before 09:00 gets today's; 09:00:00 itself, anything past 19:55 and any
 * evening already out of the window get the following local day's. The two Lisbon rows cover the
 * spring-forward day, where the 09:00 instant moves from 08:00Z to 09:00Z.
 */
const DEFERRAL_CASES: readonly DeferralCase[] = [
  ['Europe/Lisbon', '2026-07-01T08:00:00Z', '2026-07-02T08:00:00Z'], // exactly 09:00 local
  ['Europe/Lisbon', '2026-07-01T06:00:00Z', '2026-07-01T08:00:00Z'], // 07:00 local
  ['Europe/Lisbon', '2026-07-01T18:55:01Z', '2026-07-02T08:00:00Z'], // 19:55:01 local
  ['Europe/Lisbon', '2026-07-01T19:00:00Z', '2026-07-02T08:00:00Z'], // 20:00:00 local
  ['Europe/Lisbon', '2026-03-29T06:00:00Z', '2026-03-29T08:00:00Z'], // 07:00 WEST after the gap
  ['Europe/Lisbon', '2026-01-15T08:59:59Z', '2026-01-15T09:00:00Z'], // 08:59:59 WET
  ['Europe/Lisbon', '2026-01-15T09:30:00Z', '2026-01-16T09:00:00Z'], // 09:30 WET
  ['America/Mexico_City', '2026-07-01T01:00:00Z', '2026-07-01T15:00:00Z'], // 19:00 on June 30
  ['America/Mexico_City', '2026-07-01T18:55:01Z', '2026-07-02T15:00:00Z'], // 12:55:01 local
  ['America/Bogota', '2026-07-01T13:30:00Z', '2026-07-01T14:00:00Z'], // 08:30 local
  ['Asia/Bangkok', '2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z'], // 08:00 local
  ['Asia/Makassar', '2026-07-01T15:30:00Z', '2026-07-02T01:00:00Z'], // 23:30 local, next day
];

/**
 * The five launch cities' IANA zones (AAP 0.5.2): Lisbon, Mexico City, Medellín, Chiang Mai and
 * Canggu. It is what turns the boundaries below into the same six rows five times over, so a
 * zone-dependent mistake in the rule cannot hide behind a single timezone.
 */
const ZONES = [
  'Europe/Lisbon',
  'America/Mexico_City',
  'America/Bogota',
  'Asia/Bangkok',
  'Asia/Makassar',
] as const;

/**
 * The local day the derived cases are read on: a Tuesday in November, outside every launch zone's
 * DST transition, so the instant `localTimeOn` builds and the wall time the case names agree.
 */
const LOCAL_DAY = '2026-11-10';

/**
 * A case on {@link LOCAL_DAY}: the wall time read off the city's clock, the seconds past it, how
 * long the call may last, and the verdict. `localTimeOn` takes `HH:MM` alone, so a case one second
 * past a minute carries that second here rather than inside the time.
 */
type LocalWindowCase = readonly [
  at: string,
  plusSeconds: number,
  maxSeconds: number,
  within: boolean,
];

/**
 * The window's edges read off the city's own clock (AAP 0.5.6), one row per boundary: the opening
 * instant and the second before it; 19:55:00, the last start that finishes by 20:00:00 exactly under
 * a 300-second call, and the second after it; the two `maxSeconds` rows, which refuse a 120-second
 * call one minute before the close while allowing a zero-length one, so the closing bound is proved
 * to follow the call's own length rather than a fixed 300; and the two closed-city instants, late
 * evening and after midnight, which are outside at any length.
 */
const LOCAL_WINDOW_CASES: readonly LocalWindowCase[] = [
  ['08:59', 59, CAP_CALL_SECONDS, false], // 08:59:59 local, before the window opens
  ['09:00', 0, CAP_CALL_SECONDS, true], // 09:00:00 local, the opening instant itself
  ['19:55', 0, CAP_CALL_SECONDS, true], // 19:55:00 + 300 s = 20:00:00 exactly, inside
  ['19:55', 1, CAP_CALL_SECONDS, false], // 19:55:01 + 300 s = 20:00:01, one second past
  ['19:59', 0, 0, true], // a zero-length call at 19:59:00 still fits
  ['19:59', 0, 120, false], // the same instant with a 120-second call does not
  ['23:30', 0, CAP_CALL_SECONDS, false], // the city is closed for the evening
  ['00:30', 0, CAP_CALL_SECONDS, false], // the window has not opened yet today
];

/**
 * A deferral case: the wall time read off the city's clock, the seconds past it, and whether the
 * 09:00 it defers to belongs to the following local day.
 */
type LocalDeferralCase = readonly [at: string, plusSeconds: number, nextDay: boolean];

/**
 * Where each instant the window refuses is deferred to (AAP 0.5.6): today's 09:00 while it is still
 * strictly ahead of `now`, the following local day's otherwise. The instants themselves are built by
 * `city-time.ts` in the assertions rather than written out here, so a row states only which of the
 * two it expects — 00:30 and 08:59:59 have today's opening still to come, while 09:00 itself,
 * 19:55:01, 19:59 and 23:30 have used it up.
 */
const LOCAL_DEFERRAL_CASES: readonly LocalDeferralCase[] = [
  ['00:30', 0, false],
  ['08:59', 59, false],
  ['09:00', 0, true], // the opening instant is no longer strictly ahead of `now`
  ['19:55', 1, true],
  ['19:59', 0, true],
  ['23:30', 0, true],
];

/** A DST case: the Lisbon date, the UTC instant of its 06:00 local, and of its 09:00 local. */
type DstCase = readonly [day: string, sixLocalUtc: string, opensUtc: string];

/**
 * Lisbon's two 2026 transitions (AAP 0.5.6), the only DST the launch set has: the clocks spring
 * forward at 01:00Z on 2026-03-29, so 09:00 local is 08:00Z, and fall back at 01:00Z on 2026-10-25,
 * so it is 09:00Z again. Neither transition meets the window's bounds, so a window on either day is
 * the full nine-to-eight rather than a shortened one.
 */
const DST_CASES: readonly DstCase[] = [
  ['2026-03-29', '2026-03-29T05:00:00.000Z', '2026-03-29T08:00:00.000Z'], // WEST, UTC+1
  ['2026-10-25', '2026-10-25T06:00:00.000Z', '2026-10-25T09:00:00.000Z'], // WET, UTC+0
];

describe('calling-hour bounds', () => {
  it('publishes the shared window bounds', () => {
    expect(CALLING_HOURS_START).toBe('09:00');
    expect(CALLING_HOURS_END).toBe('20:00');
  });
});

describe('withinCallingHours', () => {
  it.each(WINDOW_CASES)('%s at %s for %i s -> %s', (zone, at, maxSeconds, within) => {
    expect(withinCallingHours(zone, new Date(at), maxSeconds)).toBe(within);
  });

  it.each(EDGE_CASES)('%s at %s for %i s -> %s', (zone, at, maxSeconds, within) => {
    expect(withinCallingHours(zone, new Date(at), maxSeconds)).toBe(within);
  });

  it('allows a call that starts at 09:00 local and ends at 20:00 local', () => {
    const at = new Date('2026-07-01T08:00:00Z');
    const elevenHours = 11 * 3_600;
    expect(withinCallingHours('Europe/Lisbon', at, elevenHours)).toBe(true);
    expect(withinCallingHours('Europe/Lisbon', at, elevenHours + 1)).toBe(false);
  });

  it.each([
    ['a negative duration', -1],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s with a RangeError', (_label, maxSeconds) => {
    expect(() =>
      withinCallingHours('Europe/Lisbon', new Date('2026-07-01T10:00:00Z'), maxSeconds),
    ).toThrow(RangeError);
  });

  it('rejects an unknown zone and an instant that denotes none', () => {
    const at = new Date('2026-07-01T10:00:00Z');
    expect(() => withinCallingHours('Europe/Lisbon ', at, CAP_CALL_SECONDS)).toThrow(RangeError);
    expect(() => withinCallingHours('Mars/Olympus', at, CAP_CALL_SECONDS)).toThrow(RangeError);
    expect(() =>
      withinCallingHours('Europe/Lisbon', new Date(Number.NaN), CAP_CALL_SECONDS),
    ).toThrow(RangeError);
  });
});

describe('nextCallingWindow', () => {
  it.each(DEFERRAL_CASES)('%s at %s -> %s', (zone, at, next) => {
    const now = new Date(at);
    const windowAt = nextCallingWindow(zone, now);
    expect(windowAt.toISOString()).toBe(new Date(next).toISOString());
    // The deferral always moves forward, and the instant it names opens the window.
    expect(windowAt.getTime()).toBeGreaterThan(now.getTime());
    expect(withinCallingHours(zone, windowAt, 0)).toBe(true);
  });

  it('is the fallback for every instant the window refuses', () => {
    for (const [zone, at, maxSeconds, within] of [...WINDOW_CASES, ...EDGE_CASES]) {
      if (within) {
        continue;
      }
      const now = new Date(at);
      expect(withinCallingHours(zone, now, maxSeconds)).toBe(false);
      expect(nextCallingWindow(zone, now).getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it('rejects an unknown zone and an instant that denotes none', () => {
    expect(() => nextCallingWindow('Mars/Olympus', new Date('2026-07-01T10:00:00Z'))).toThrow(
      RangeError,
    );
    expect(() => nextCallingWindow('Europe/Lisbon', new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe.each(ZONES)('%s calling hours, read off the city clock', (tz) => {
  /** The instant `plusSeconds` after wall-clock `time` on {@link LOCAL_DAY} in `tz`. */
  const at = (time: string, plusSeconds: number): Date =>
    new Date(localTimeOn(tz, LOCAL_DAY, time).getTime() + plusSeconds * 1_000);

  it.each(LOCAL_WINDOW_CASES)(
    '%s + %i s for %i s -> %s',
    (time, plusSeconds, maxSeconds, within) => {
      expect(withinCallingHours(tz, at(time, plusSeconds), maxSeconds)).toBe(within);
    },
  );

  it.each(LOCAL_DEFERRAL_CASES)(
    '%s + %i s -> 09:00, next day: %s',
    (time, plusSeconds, nextDay) => {
      const now = at(time, plusSeconds);
      const opens = nextDay
        ? nextLocalDayAt(tz, now, CALLING_HOURS_START)
        : localTimeOn(tz, LOCAL_DAY, CALLING_HOURS_START);
      const deferred = nextCallingWindow(tz, now);
      expect(deferred.getTime()).toBe(opens.getTime());
      // A deferral always names a later instant, and one the window is open at.
      expect(deferred.getTime()).toBeGreaterThan(now.getTime());
      expect(withinCallingHours(tz, deferred, 0)).toBe(true);
    },
  );
});

describe('Lisbon daylight saving', () => {
  it.each(DST_CASES)('%s: 06:00 local at %s opens at %s', (day, sixLocalUtc, opensUtc) => {
    const sixLocal = localTimeOn('Europe/Lisbon', day, '06:00');
    const opens = new Date(opensUtc);
    expect(sixLocal.toISOString()).toBe(sixLocalUtc);
    expect(localTimeOn('Europe/Lisbon', day, CALLING_HOURS_START).toISOString()).toBe(opensUtc);

    // The opening instant is inside the window; the second before it is outside and defers to it.
    expect(withinCallingHours('Europe/Lisbon', opens, CAP_CALL_SECONDS)).toBe(true);
    const justBefore = new Date(opens.getTime() - 1_000);
    expect(withinCallingHours('Europe/Lisbon', justBefore, CAP_CALL_SECONDS)).toBe(false);
    expect(nextCallingWindow('Europe/Lisbon', justBefore).getTime()).toBe(opens.getTime());
    expect(nextCallingWindow('Europe/Lisbon', sixLocal).getTime()).toBe(opens.getTime());
  });
});
