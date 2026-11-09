import { DateTime, IANAZone } from 'luxon';

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

type MaybeValid = DateTime<true> | DateTime<false>;

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

function parseHHmm(hhmm: string): { hour: number; minute: number } {
  if (!HHMM_RE.test(hhmm)) {
    throw new RangeError(`Expected a 24-hour wall time as HH:MM, received "${hhmm}"`);
  }
  // Sliced rather than read off a capture group, so the pattern stays the documented whole-value form.
  return { hour: Number(hhmm.slice(0, 2)), minute: Number(hhmm.slice(3, 5)) };
}

function assertValidDate(at: Date): void {
  if (Number.isNaN(at.getTime())) {
    throw new RangeError('Expected a valid Date, received an invalid Date');
  }
}

function assertValidDateTime(dt: MaybeValid): asserts dt is DateTime<true> {
  if (!dt.isValid) {
    throw new RangeError(
      `Expected a valid DateTime, received: ${dt.invalidExplanation ?? dt.invalidReason}`,
    );
  }
}

function toDate(dt: MaybeValid): Date {
  assertValidDateTime(dt);
  return dt.toJSDate();
}

function isoDateOf(dt: MaybeValid): string {
  assertValidDateTime(dt);
  return dt.toISODate();
}

const DAY_MS = 86_400_000;

function candidateOffsets(zone: IANAZone, wallMs: number): number[] {
  const offsets = new Set<number>();
  for (const step of [-DAY_MS, 0, DAY_MS]) {
    offsets.add(zone.offset(wallMs + step));
  }
  return [...offsets];
}

function resolveWallTime(zone: IANAZone, wallMs: number): Date {
  const offsets = candidateOffsets(zone, wallMs);
  const readings = offsets
    .map((offset) => wallMs - offset * 60_000)
    .filter((instant) => zone.offset(instant) * 60_000 === wallMs - instant);
  if (readings.length > 0) {
    return new Date(Math.min(...readings));
  }
  return new Date(wallMs - Math.min(...offsets) * 60_000);
}

/**
 * Assert that `tz` is an IANA zone the runtime knows (AAP 0.6.2: zones come from
 * `config/cities.json`).
 */
export function assertValidZone(tz: string): void {
  if (!IANAZone.isValidZone(tz)) {
    throw new RangeError(`Invalid IANA time zone: "${tz}"`);
  }
}

/**
 * The city's local calendar date at `at`, which keys the per-city call and language-model budgets
 * (AAP 0.5.6) and dates a meetup for suggestions and lodging-activity facts (AAP 0.5.7).
 */
export function localDateKey(tz: string, at: Date): string {
  assertValidZone(tz);
  assertValidDate(at);
  return isoDateOf(DateTime.fromJSDate(at, { zone: tz }));
}

/**
 * The UTC instant of wall-clock `hhmm` on `localDate` in `tz` (AAP 0.5.6), resolved by {@link
 * resolveWallTime} under the DST rule in the file header: a gap wall time moves forward by the gap,
 * an overlap takes the earlier reading.
 */
export function localTimeOn(tz: string, localDate: string, hhmm: string): Date {
  assertValidZone(tz);
  const { year, month, day } = parseLocalDate(localDate);
  const { hour, minute } = parseHHmm(hhmm);
  return resolveWallTime(IANAZone.create(tz), Date.UTC(year, month - 1, day, hour, minute));
}

/**
 * 00:00:00.000 local on `localDate`, the start of a city-local day (AAP 0.5.2: a proof's
 * `validFrom` is two local days before its arrival).
 */
export function startOfLocalDay(tz: string, localDate: string): Date {
  assertValidZone(tz);
  const { year, month, day } = parseLocalDate(localDate);
  return toDate(DateTime.fromObject({ year, month, day }, { zone: tz }).startOf('day'));
}

/**
 * 23:59:59.999 local on `localDate`, the last instant of a city-local day: a proof's `validTo` is
 * the end of its departure day in city time, and `stay-expiry` turns `showStaying` off at the end
 * of `stayTo` (AAP 0.5.2, 0.5.3, 0.5.5).
 */
export function endOfLocalDay(tz: string, localDate: string): Date {
  assertValidZone(tz);
  const { year, month, day } = parseLocalDate(localDate);
  return toDate(DateTime.fromObject({ year, month, day }, { zone: tz }).endOf('day'));
}

/**
 * `localDate` moved by `days` calendar days, which derives a proof's `validFrom` as arrival − 2
 * days (AAP 0.5.2) and steps {@link nextLocalDayAt} to the following day.
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
 * `nextAttemptAt`, and where `menu-ingest` defers to when a language-model reservation is refused
 * (AAP 0.5.6).
 */
export function nextLocalDayAt(tz: string, at: Date, hhmm: string): Date {
  assertValidZone(tz);
  assertValidDate(at);
  return localTimeOn(tz, addLocalDays(localDateKey(tz, at), 1), hhmm);
}

/**
 * The next occurrence of wall-clock `hhmm` in `tz`: today's when it is strictly later than `at`,
 * otherwise the following local day's.
 */
export function nextOccurrenceOf(tz: string, at: Date, hhmm: string): Date {
  assertValidZone(tz);
  assertValidDate(at);
  const today = localTimeOn(tz, localDateKey(tz, at), hhmm);
  return today.getTime() > at.getTime() ? today : nextLocalDayAt(tz, at, hhmm);
}

/**
 * Whether the span `from`–`to` sits inside the window `startHHmm`–`endHHmm` on `from`'s local date,
 * both bounds inclusive.
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
