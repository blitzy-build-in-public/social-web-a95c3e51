/**
 * The calling-hours rule (AAP 0.5.6): a call starts only if `now >= 09:00` and
 * `now + CAP_CALL_SECONDS <= 20:00` in the business's city time, and a task that does not fit is
 * deferred to the next 09:00 local.
 *
 * The city is the venue's or the lodging's own, from `config/cities.json`, never the host's. Both
 * functions are pure: the instant arrives from the injected clock, and every conversion between the
 * city's wall clock and the UTC instant the database stores goes through `time/city-time.ts` in
 * `@tablemate/server-core`, the one place that speaks an IANA zone. Lisbon is the only launch city
 * with DST, and neither of its transitions touches 09:00 or 20:00, so a window is never shortened.
 */

import { isWithinLocalWindow, nextOccurrenceOf } from '@tablemate/server-core';
import { CALLING_HOURS_END, CALLING_HOURS_START } from '@tablemate/shared';

export { CALLING_HOURS_END, CALLING_HOURS_START };

/**
 * Whether a call lasting at most `maxSeconds` may start in `tz` at `now` (AAP 0.5.6): the span `now`
 * to `now + maxSeconds` must lie inside the window local, both bounds inclusive. A 09:00:00 local
 * start is allowed and 08:59:59 is not; with the 300-second `CAP_CALL_SECONDS`, a start at exactly
 * 19:55:00 is allowed and one at 19:55:01 is not, so the whole call fits before the window closes,
 * which is what Twilio's `timeLimit` of the same length enforces. An end that would fall on the next
 * local date is outside the window, because both bounds are read on `now`'s own local date.
 */
export function withinCallingHours(tz: string, now: Date, maxSeconds: number): boolean {
  if (!Number.isFinite(maxSeconds) || maxSeconds < 0) {
    throw new RangeError(`Expected a non-negative number of seconds, received ${maxSeconds}`);
  }
  return isWithinLocalWindow(
    tz,
    now,
    new Date(now.getTime() + maxSeconds * 1000),
    CALLING_HOURS_START,
    CALLING_HOURS_END,
  );
}

/**
 * The next instant at which a call may start in `tz` (AAP 0.5.6): today's 09:00 local while `now` is
 * strictly before it, otherwise the following local day's, so both reasons a call was refused land on
 * the next window. At exactly 09:00:00 the answer is tomorrow's, since that start is no longer ahead
 * of `now`.
 */
export function nextCallingWindow(tz: string, now: Date): Date {
  return nextOccurrenceOf(tz, now, CALLING_HOURS_START);
}
