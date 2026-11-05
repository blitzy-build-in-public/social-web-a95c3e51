/**
 * City-local time (AAP 0.5.6, 0.5.7, 0.11.1).
 *
 * What the pilot schedules per city is wall-clock time in the city's IANA zone — the 09:00–20:00
 * calling window, the 23:00 suggestion cut-off, a task's next 09:00 or 00:05 local attempt, the
 * local date that keys a city's call and language-model budgets, the end of a proof's departure day
 * and of a stay — while the database keeps the UTC instant these functions return, so this file is
 * the only conversion between the two.
 *
 * No clock is read (AAP 0.11.1): the instant reasoned about arrives as a `Date` the caller took from
 * the injected `Clock`, so tests can advance it, and every returned `Date` is built by `toJSDate()`.
 * No luxon global state is touched: every construction passes `{ zone }` explicitly, so no result
 * depends on the zone the process happens to run in.
 *
 * Daylight saving, as the pinned luxon 3.7.2 resolves it: a wall time in the spring-forward gap
 * moves forward by the size of the gap (Lisbon 2026-03-29 01:30 is 02:30 WEST, 2026-03-29T01:30Z),
 * and a wall time in the fall-back overlap takes the later instant, the post-transition
 * standard-time reading (Lisbon 2026-10-25 01:30 is 01:30 WET, 2026-10-25T01:30Z). Lisbon is the
 * only launch city with DST, and neither window meets the calling hours or the 23:00 cut-off.
 */
import { DateTime, IANAZone } from 'luxon';

/** The one accepted spelling of a city-local calendar date. */
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `HH:MM` on a 24-hour clock, so `24:00`, `9:00` and `09:60` are all rejected. */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Luxon's `DateTimeMaybeValid`, the union whose `isValid` flag narrows its validity. The union and
 * not plain `DateTime` is load-bearing: `toISODate()` stays `string | null` on `DateTime<boolean>`.
 */
type MaybeValid = DateTime<true> | DateTime<false>;

/** The parts of a `YYYY-MM-DD` date; a malformed or unreal date (`2026-02-30`, month 13) throws. */
function parseLocalDate(localDate: string): { year: number; month: number; day: number } {
  if (!LOCAL_DATE_RE.test(localDate)) {
    throw new RangeError(`Expected a calendar date as YYYY-MM-DD, received "${localDate}"`);
  }
  const [yearText = '', monthText = '', dayText = ''] = localDate.split('-');
  const parts = { year: Number(yearText), month: Number(monthText), day: Number(dayText) };
  if (!DateTime.fromObject(parts, { zone: 'utc' }).isValid) {
    throw new RangeError(`Expected a real calendar date, received "${localDate}"`);
  }
  return parts;
}

/** The hour and minute of an `HH:MM` wall time, or a `RangeError` naming the value. */
function parseHHmm(hhmm: string): { hour: number; minute: number } {
  if (!HHMM_RE.test(hhmm)) {
    throw new RangeError(`Expected a 24-hour wall time as HH:MM, received "${hhmm}"`);
  }
  // Sliced rather than read off a capture group, so the pattern stays the documented whole-value form.
  return { hour: Number(hhmm.slice(0, 2)), minute: Number(hhmm.slice(3, 5)) };
}

/** Reject a `Date` that denotes no instant, such as one built from an invalid ISO string. */
function assertValidDate(at: Date): void {
  if (Number.isNaN(at.getTime())) {
    throw new RangeError('Expected a valid Date, received an invalid Date');
  }
}

/** Narrow luxon's valid/invalid union, which the caller's own input checks already satisfy. */
function assertValidDateTime(dt: MaybeValid): asserts dt is DateTime<true> {
  if (!dt.isValid) {
    throw new RangeError(
      `Expected a valid DateTime, received: ${dt.invalidExplanation ?? dt.invalidReason}`,
    );
  }
}

/** The instant a luxon value denotes, as a new `Date`. */
function toDate(dt: MaybeValid): Date {
  assertValidDateTime(dt);
  return dt.toJSDate();
}

/** A luxon value's `YYYY-MM-DD` local date, narrowed because `toISODate()` is `string | null`. */
function isoDateOf(dt: MaybeValid): string {
  assertValidDateTime(dt);
  return dt.toISODate();
}

/**
 * Assert that `tz` is an IANA zone the runtime knows (AAP 0.6.2: zones come from
 * `config/cities.json`). Every other export takes a zone and calls this first.
 * Throws `RangeError` when `tz` is not a real IANA zone name.
 */
export function assertValidZone(tz: string): void {
  if (!IANAZone.isValidZone(tz)) {
    throw new RangeError(`Invalid IANA time zone: "${tz}"`);
  }
}

/**
 * The city's local calendar date at `at`, which keys the per-city call and language-model budgets
 * (AAP 0.5.6) and dates a meetup for suggestions and lodging-activity facts (AAP 0.5.7).
 * Throws `RangeError` for a non-IANA zone or an invalid `Date`.
 */
export function localDateKey(tz: string, at: Date): string {
  assertValidZone(tz);
  assertValidDate(at);
  return isoDateOf(DateTime.fromJSDate(at, { zone: tz }));
}

/**
 * The UTC instant of wall-clock `hhmm` on `localDate` in `tz` (AAP 0.5.6), under the DST rule in
 * the file header: a gap wall time moves forward by the gap, an overlap takes the later reading.
 * Throws `RangeError` for a non-IANA zone or a malformed string.
 */
export function localTimeOn(tz: string, localDate: string, hhmm: string): Date {
  assertValidZone(tz);
  const { year, month, day } = parseLocalDate(localDate);
  const { hour, minute } = parseHHmm(hhmm);
  return toDate(
    DateTime.fromObject(
      { year, month, day, hour, minute, second: 0, millisecond: 0 },
      { zone: tz },
    ),
  );
}

/**
 * 00:00:00.000 local on `localDate`, the start of a city-local day (AAP 0.5.2: a proof's
 * `validFrom` is two local days before its arrival). Throws `RangeError` for a non-IANA zone or a
 * malformed date.
 */
export function startOfLocalDay(tz: string, localDate: string): Date {
  assertValidZone(tz);
  const { year, month, day } = parseLocalDate(localDate);
  return toDate(DateTime.fromObject({ year, month, day }, { zone: tz }).startOf('day'));
}

/**
 * 23:59:59.999 local on `localDate`, the last instant of a city-local day: a proof's `validTo` is
 * the end of its departure day in city time (AAP 0.5.2, 0.5.5, 0.5.7), and `stay-expiry` turns
 * `showStaying` off at the end of `stayTo` (AAP 0.5.3). Throws `RangeError` for a non-IANA zone or
 * a malformed date.
 */
export function endOfLocalDay(tz: string, localDate: string): Date {
  assertValidZone(tz);
  const { year, month, day } = parseLocalDate(localDate);
  return toDate(DateTime.fromObject({ year, month, day }, { zone: tz }).endOf('day'));
}

/**
 * `localDate` moved by `days` calendar days, which derives a proof's `validFrom` as arrival − 2 days
 * (AAP 0.5.2) and steps {@link nextLocalDayAt} to the following day. Pure calendar arithmetic in
 * UTC, so no zone and no DST transition can shift the result. Throws `RangeError` for a malformed
 * date or a non-integer `days`.
 */
export function addLocalDays(localDate: string, days: number): string {
  const { year, month, day } = parseLocalDate(localDate);
  if (!Number.isInteger(days)) {
    throw new RangeError(`Expected an integer day count, received ${days}`);
  }
  return isoDateOf(DateTime.fromObject({ year, month, day }, { zone: 'utc' }).plus({ days }));
}

/**
 * Wall-clock `hhmm` on the city-local day after `at`: where a task over the call or spend cap moves
 * `nextAttemptAt` (09:00 local) and where `menu-ingest` defers to when a language-model reservation
 * is refused (00:05 local) (AAP 0.5.6). Throws `RangeError` for a non-IANA zone, an invalid `Date`
 * or a malformed time.
 */
export function nextLocalDayAt(tz: string, at: Date, hhmm: string): Date {
  assertValidZone(tz);
  assertValidDate(at);
  return localTimeOn(tz, addLocalDays(localDateKey(tz, at), 1), hhmm);
}

/**
 * The next occurrence of wall-clock `hhmm` in `tz`: today's when it is strictly later than `at`,
 * otherwise the following local day's. It is the "next 09:00 local" a call deferred outside calling
 * hours waits for (AAP 0.5.6). Throws `RangeError` for a non-IANA zone, an invalid `Date` or a
 * malformed time.
 */
export function nextOccurrenceOf(tz: string, at: Date, hhmm: string): Date {
  assertValidZone(tz);
  assertValidDate(at);
  const today = localTimeOn(tz, localDateKey(tz, at), hhmm);
  return today.getTime() > at.getTime() ? today : nextLocalDayAt(tz, at, hhmm);
}

/**
 * Whether the span `from`–`to` sits inside the window `startHHmm`–`endHHmm` on `from`'s local date,
 * both bounds inclusive. It is the calling-hours test of AAP 0.5.6 — `now ≥ 09:00` and
 * `now + CAP_CALL_SECONDS ≤ 20:00` — and a `to` on a later local date is outside by construction,
 * since both bounds belong to `from`'s day. Throws `RangeError` for a non-IANA zone, an invalid
 * `Date`, a `to` before the `from`, a malformed time, or an end not after the start; overnight
 * windows are unsupported because no caller needs one.
 */
export function isWithinLocalWindow(
  tz: string,
  from: Date,
  to: Date,
  startHHmm: string,
  endHHmm: string,
): boolean {
  assertValidZone(tz);
  assertValidDate(from);
  assertValidDate(to);
  const start = parseHHmm(startHHmm);
  const end = parseHHmm(endHHmm);
  if (end.hour * 60 + end.minute <= start.hour * 60 + start.minute) {
    throw new RangeError(
      `Expected the end of the window after its start, received "${startHHmm}" to "${endHHmm}"`,
    );
  }
  if (to.getTime() < from.getTime()) {
    throw new RangeError('Expected "to" at or after "from", received an earlier "to"');
  }
  const day = localDateKey(tz, from);
  return (
    from.getTime() >= localTimeOn(tz, day, startHHmm).getTime() &&
    to.getTime() <= localTimeOn(tz, day, endHHmm).getTime()
  );
}
