import { DateTime, Settings } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';

import {
  addLocalDays,
  assertValidZone,
  endOfLocalDay,
  formatCityWallTime,
  fromCityWallClock,
  isWithinLocalWindow,
  localDateKey,
  localTimeOn,
  nextLocalDayAt,
  nextOccurrenceOf,
  startOfLocalDay,
  toCityWallClock,
} from '../../src/time/city-time.ts';
const LIS = 'Europe/Lisbon';
const MEX = 'America/Mexico_City';
const BOG = 'America/Bogota';
const BKK = 'Asia/Bangkok';
const MAK = 'Asia/Makassar';
const LAUNCH_ZONES = [LIS, MEX, BOG, BKK, MAK];
const CALL_MS = 300_000;
const LAST_START_MS = 39_300_000;
const CLOCK_SEEDS = ['2026-07-01T12:00:00Z', '2026-01-15T12:00:00Z'];
const at = (instant: string): Date => new Date(instant);
const iso = (instant: Date): string => instant.toISOString();

describe('localDateKey', () => {
  it.each([
    [LIS, '2026-11-05T00:00:00.000Z'],
    [MEX, '2026-11-05T06:00:00.000Z'],
    [BOG, '2026-11-05T05:00:00.000Z'],
    [BKK, '2026-11-04T17:00:00.000Z'],
    [MAK, '2026-11-04T16:00:00.000Z'],
  ])('%s turns the day over at its own midnight, %s', (tz, midnight) => {
    // CallBudgetDay keys one row per city and local date (AAP 0.5.6), so a millisecond either side of local midnight must fall in different days.
    const edge = at(midnight).getTime();
    expect(localDateKey(tz, new Date(edge - 1))).toBe('2026-11-04');
    expect(localDateKey(tz, new Date(edge))).toBe('2026-11-05');
    expect(localDateKey(tz, new Date(edge + 1))).toBe('2026-11-05');
  });
  it.each([
    ['2026-03-28T23:59:59.999Z', '2026-03-28'],
    ['2026-03-29T00:00:00.000Z', '2026-03-29'],
    ['2026-03-29T22:59:59.999Z', '2026-03-29'],
    ['2026-03-29T23:00:00.000Z', '2026-03-30'],
    ['2026-10-24T22:59:59.999Z', '2026-10-24'],
    ['2026-10-24T23:00:00.000Z', '2026-10-25'],
  ])('Lisbon: %s is %s', (instant, key) => {
    // The 23-hour day of 2026-03-29 and the 25-hour day of 2026-10-25.
    expect(localDateKey(LIS, at(instant))).toBe(key);
  });
});

describe('localTimeOn', () => {
  it.each([
    [LIS, '09:00', '2026-11-04T09:00:00.000Z'],
    [LIS, '20:00', '2026-11-04T20:00:00.000Z'],
    [LIS, '23:00', '2026-11-04T23:00:00.000Z'],
    [MEX, '09:00', '2026-11-04T15:00:00.000Z'],
    [MEX, '20:00', '2026-11-05T02:00:00.000Z'],
    [MEX, '23:00', '2026-11-05T05:00:00.000Z'],
    [BOG, '09:00', '2026-11-04T14:00:00.000Z'],
    [BOG, '20:00', '2026-11-05T01:00:00.000Z'],
    [BOG, '23:00', '2026-11-05T04:00:00.000Z'],
    [BKK, '09:00', '2026-11-04T02:00:00.000Z'],
    [BKK, '20:00', '2026-11-04T13:00:00.000Z'],
    [BKK, '23:00', '2026-11-04T16:00:00.000Z'],
    [MAK, '09:00', '2026-11-04T01:00:00.000Z'],
    [MAK, '20:00', '2026-11-04T12:00:00.000Z'],
    [MAK, '23:00', '2026-11-04T15:00:00.000Z'],
  ])('%s %s on 2026-11-04', (tz, hhmm, expected) => {
    // 09:00 opens calling hours and 20:00 closes them (AAP 0.5.6); 23:00 is the suggestion cut-off (AAP 0.5.7). Mexico City and Bogotá reach both on the next UTC date.
    expect(iso(localTimeOn(tz, '2026-11-04', hhmm))).toBe(expected);
  });
  const FIXED_OFFSETS = [
    [MEX, '15:00:00.000'],
    [BOG, '14:00:00.000'],
    [BKK, '02:00:00.000'],
    [MAK, '01:00:00.000'],
  ] as const;
  const SEASONS = ['2026-01-15', '2026-04-05', '2026-07-01', '2026-10-25'] as const;
  it.each(
    FIXED_OFFSETS.flatMap(([tz, utc]) =>
      SEASONS.map((date): [string, string, string] => [tz, date, `${date}T${utc}Z`]),
    ),
  )('%s holds 09:00 at %s on every date: %s', (tz, date, expected) => {
    // No DST since 2022 in Mexico and never in the other three, so a 09:00 deferral lands at the same UTC time all year (AAP 0.5.6).
    expect(iso(localTimeOn(tz, date, '09:00'))).toBe(expected);
  });
});

describe('wall times inside a DST transition', () => {
  const realNow = Settings.now;
  afterEach(() => {
    Settings.now = realNow;
  });
  it.each(CLOCK_SEEDS)('moves the 01:30 gap forward by the hour it lost, clock at %s', (seed) => {
    // Each wall time is asserted under a summer and a winter clock, because luxon's factory resolves both from the offset it guesses at the process clock: the reading must not move with it.
    Settings.now = () => at(seed).getTime();
    expect(iso(localTimeOn(LIS, '2026-03-29', '01:30'))).toBe('2026-03-29T01:30:00.000Z');
  });
  it.each(CLOCK_SEEDS)('takes the earlier reading of the 01:30 overlap, clock at %s', (seed) => {
    Settings.now = () => at(seed).getTime();
    // A task deferred to a wall time that resolved differently depending on when the process started would be a scheduling defect, so the earlier of the two readings is the one pinned.
    expect(iso(localTimeOn(LIS, '2026-10-25', '01:30'))).toBe('2026-10-25T00:30:00.000Z');
    expect(iso(localTimeOn(LIS, '2026-10-25', '02:30'))).toBe('2026-10-25T02:30:00.000Z');
  });
});

describe('deferring to a later local time', () => {
  it.each([
    [MEX, '2026-11-05T05:30:00.000Z', '2026-11-05T15:00:00.000Z'],
    [MAK, '2026-11-04T00:30:00.000Z', '2026-11-05T01:00:00.000Z'],
    [LIS, '2026-03-28T12:00:00.000Z', '2026-03-29T08:00:00.000Z'],
    [LIS, '2026-10-24T12:00:00.000Z', '2026-10-25T09:00:00.000Z'],
  ])('%s from %s waits for the next local 09:00', (tz, from, expected) => {
    // A task over a cap moves nextAttemptAt to 09:00 local the next day (AAP 0.5.6). Makassar is the case that proves it is the next day and not the next 09:00: 08:30 local is still before today's, and the answer is tomorrow's.
    expect(iso(nextLocalDayAt(tz, at(from), '09:00'))).toBe(expected);
  });
  it('defers a refused menu job to 00:05 local the next day', () => {
    // menu-ingest defers to 00:05 local when a language-model reservation is refused (AAP 0.5.6).
    expect(iso(nextLocalDayAt(BKK, at('2026-11-04T18:00:00.000Z'), '00:05'))).toBe(
      '2026-11-05T17:05:00.000Z',
    );
  });
  it.each([
    [BOG, '2026-11-04T13:59:59.999Z', '2026-11-04T14:00:00.000Z'],
    [BOG, '2026-11-04T14:00:00.000Z', '2026-11-05T14:00:00.000Z'],
    [BOG, '2026-11-04T20:00:00.000Z', '2026-11-05T14:00:00.000Z'],
    [MAK, '2026-11-04T00:30:00.000Z', '2026-11-04T01:00:00.000Z'],
  ])('%s from %s waits for 09:00', (tz, from, expected) => {
    // nextOccurrenceOf takes today's 09:00 only while it is strictly ahead, otherwise tomorrow's.
    expect(iso(nextOccurrenceOf(tz, at(from), '09:00'))).toBe(expected);
  });
});

describe('day bounds', () => {
  it.each([
    [MAK, '2026-11-20', '2026-11-19T16:00:00.000Z', '2026-11-20T15:59:59.999Z'],
    [MEX, '2026-11-20', '2026-11-20T06:00:00.000Z', '2026-11-21T05:59:59.999Z'],
    [LIS, '2026-07-15', '2026-07-14T23:00:00.000Z', '2026-07-15T22:59:59.999Z'],
    [LIS, '2026-03-29', '2026-03-29T00:00:00.000Z', '2026-03-29T22:59:59.999Z'],
    [LIS, '2026-10-25', '2026-10-24T23:00:00.000Z', '2026-10-25T23:59:59.999Z'],
  ])('%s %s spans %s to %s', (tz, date, start, end) => {
    // endOfLocalDay is a proof's validTo and the instant stay-expiry turns showStaying off (AAP 0.5.2, 0.5.3); the two Lisbon rows are the 23- and 25-hour days.
    expect(iso(startOfLocalDay(tz, date))).toBe(start);
    expect(iso(endOfLocalDay(tz, date))).toBe(end);
  });
  it.each([
    ['2026-11-04', -2, '2026-11-02'],
    ['2026-11-02', 1, '2026-11-03'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-03-29', -1, '2026-03-28'],
  ])('%s moved by %s day(s) is %s', (date, days, expected) => {
    // validFrom is arrival − 2 local days (AAP 0.5.2): pure calendar arithmetic, so a month, a year and the DST date itself all step by whole days.
    expect(addLocalDays(date, days)).toBe(expected);
  });
});

describe('the 09:00–20:00 calling window', () => {
  it.each([
    [LIS, '2026-11-04T09:00:00.000Z'],
    [MEX, '2026-11-04T15:00:00.000Z'],
    [BOG, '2026-11-04T14:00:00.000Z'],
    [BKK, '2026-11-04T02:00:00.000Z'],
    [MAK, '2026-11-04T01:00:00.000Z'],
  ])('%s: 09:00 in, 08:59:59.999 out, 19:55 in, 19:55:00.001 out', (tz, opening) => {
    // AAP 0.5.6: now ≥ 09:00 and now + CAP_CALL_SECONDS ≤ 20:00, both bounds inclusive.
    const within = (from: number) =>
      isWithinLocalWindow(tz, new Date(from), new Date(from + CALL_MS), '09:00', '20:00');
    const nine = at(opening).getTime();
    expect(within(nine)).toBe(true);
    expect(within(nine - 1)).toBe(false);
    const last = nine + LAST_START_MS;
    expect(iso(new Date(last))).toBe(iso(localTimeOn(tz, '2026-11-04', '19:55')));
    expect(within(last)).toBe(true);
    expect(within(last + 1)).toBe(false);
  });
  it.each([
    [MEX, '2026-11-05T01:55:00.000Z'],
    [BOG, '2026-11-05T00:55:00.000Z'],
  ])('%s: the last start falls on the next UTC date, %s', (tz, last) => {
    // The window follows the city's local date, already rolled over in UTC here.
    expect(iso(localTimeOn(tz, '2026-11-04', '19:55'))).toBe(last);
  });
});

describe('the city wall clock', () => {
  // The instants the shift pair is asserted over: one midday instant per launch zone, plus a Lisbon instant either side of each DST transition. The shifted wall times are unambiguous ones on purpose, because the repeated autumn hour reads twice and the spring gap not at all.
  const SHIFT_CASES: ReadonlyArray<[string, string]> = [
    [LIS, '2026-11-04T12:00:00.000Z'],
    [MEX, '2026-11-04T12:00:00.000Z'],
    [BOG, '2026-11-04T12:00:00.000Z'],
    [BKK, '2026-11-04T12:00:00.000Z'],
    [MAK, '2026-11-04T12:00:00.000Z'],
    [LIS, '2026-03-29T01:00:00.000Z'],
    [LIS, '2026-10-25T02:30:00.000Z'],
  ];
  const READING_FORMAT = 'yyyy-LL-dd HH:mm';
  it.each(SHIFT_CASES)('%s: the shift pair gives %s back unchanged', (tz, instant) => {
    // `opening_hours` is handed a shifted instant and hands its intervals back, so the inverse must land on the instant it came from (AAP 0.11.1).
    expect(iso(fromCityWallClock(tz, toCityWallClock(tz, at(instant))))).toBe(instant);
  });
  it.each(SHIFT_CASES)('%s: the shifted %s reads as the city wall clock', (tz, instant) => {
    // The shift exists for the library, which reads a `Date`'s process-local getters, so those fields must carry the city's reading whatever `TZ` the host runs in: the expectation is luxon's own local reading, never a hard-coded offset.
    const shifted = toCityWallClock(tz, at(instant));
    expect(DateTime.fromJSDate(shifted).toFormat(READING_FORMAT)).toBe(
      DateTime.fromJSDate(at(instant), { zone: tz }).toFormat(READING_FORMAT),
    );
  });
  it.each([
    [LIS, '2026-03-29T01:00:00.000Z', 'HH:mm', '02:00'],
    [LIS, '2026-10-25T02:30:00.000Z', 'HH:mm', '02:30'],
    [BKK, '2026-11-04T02:00:00.000Z', 'HH:mm', '09:00'],
    [MAK, '2026-11-04T01:00:00.000Z', 'ccc d LLL, HH:mm', 'Wed 4 Nov, 09:00'],
    [MEX, '2026-11-04T15:00:00.000Z', 'ccc d LLL, HH:mm', 'Wed 4 Nov, 09:00'],
  ])('%s: %s as %s is %s', (tz, instant, format, expected) => {
    // The `HH:mm` a suggestion shows for its opening intervals and the labelled meetup start a notification shows (AAP 0.5.7); both Lisbon rows sit on a transition, and every zone here differs from UTC.
    expect(formatCityWallTime(tz, at(instant), format)).toBe(expected);
  });
});

describe('invalid input', () => {
  const FAILING_CALLS: ReadonlyArray<[string, () => unknown]> = [
    ['a zone luxon does not know', () => assertValidZone('Mars/Olympus')],
    ['an empty zone', () => assertValidZone('')],
    [
      'a zone the runtime cannot resolve',
      () => localDateKey('Not/AZone', at('2026-11-04T00:00:00.000Z')),
    ],
    ['hour 24 on a 24-hour clock', () => localTimeOn(LIS, '2026-11-04', '24:00')],
    ['a one-digit hour', () => localTimeOn(LIS, '2026-11-04', '9:00')],
    ['a date the month does not have', () => localTimeOn(LIS, '2026-02-30', '09:00')],
    [
      'a zone the runtime cannot resolve, shifting an instant',
      () => toCityWallClock('Not/AZone', at('2026-11-04T12:00:00.000Z')),
    ],
    ['an invalid Date shifted into a city zone', () => toCityWallClock(LIS, new Date('nope'))],
    [
      'a zone the runtime cannot resolve, reading a wall clock back',
      () => fromCityWallClock('Not/AZone', at('2026-11-04T12:00:00.000Z')),
    ],
    ['an invalid Date read back from a wall clock', () => fromCityWallClock(LIS, new Date('nope'))],
    [
      'a zone the runtime cannot resolve, formatting an instant',
      () => formatCityWallTime('Not/AZone', at('2026-11-04T12:00:00.000Z'), 'HH:mm'),
    ],
    [
      'an invalid Date formatted as a wall time',
      () => formatCityWallTime(LIS, new Date('nope'), 'HH:mm'),
    ],
  ];
  it.each(FAILING_CALLS)('throws RangeError for %s', (_case, call) => {
    expect(call).toThrow(RangeError);
  });
  it('accepts every launch zone', () => {
    for (const tz of LAUNCH_ZONES) expect(() => assertValidZone(tz)).not.toThrow();
  });
});
