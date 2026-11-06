/**
 * The calling-hours rule (AAP 0.5.6): a call starts only if `now >= 09:00` and
 * `now + CAP_CALL_SECONDS <= 20:00` in the business's city time, and a task that does not fit is
 * deferred to the next 09:00 local. `eligibility.ts` reads this rule before a task is dispatched and
 * `call-dispatch` moves `nextAttemptAt` to the instant {@link nextCallingWindow} returns.
 *
 * The city is the business's own -- the venue's or the lodging's, from `config/cities.json` -- never
 * the host's. Both functions are pure and read no clock (AAP 0.11.1): the instant arrives as a
 * `Date` from the injected clock, so the test clock can move it, and every conversion between the
 * city's wall clock and the UTC instant the database stores goes through `time/city-time.ts` in
 * `@tablemate/server-core`, the one place that speaks an IANA zone.
 *
 * Daylight saving is that module's rule: Lisbon is the only launch city with DST, and neither of its
 * transitions touches 09:00 or 20:00, so a calling window is never shortened by one.
 *
 * @see AAP 0.5.6 for the eligibility clause and the call caps, 0.5.3 for the deferral of a call-task
 *   attempt, 0.12.2 for the "Calling hours 09:00-20:00 local" constraint, and 0.8.1 for this file.
 */

import { isWithinLocalWindow, nextOccurrenceOf } from '@tablemate/server-core';
import { CALLING_HOURS_END, CALLING_HOURS_START } from '@tablemate/shared';

/**
 * The calling window's bounds, `HH:mm` in the business's city (AAP 0.5.6): a call starts no earlier
 * than {@link CALLING_HOURS_START} and finishes no later than {@link CALLING_HOURS_END}.
 * `@tablemate/shared` owns the values, because they are a fixed business constant; they are
 * re-exported here so a consumer of the rule reads it and its bounds from one module.
 */
export { CALLING_HOURS_END, CALLING_HOURS_START };

/**
 * Whether a call lasting at most `maxSeconds` may start in `tz` at `now` (AAP 0.5.6): the span
 * `now` to `now + maxSeconds` must lie inside {@link CALLING_HOURS_START}-{@link CALLING_HOURS_END}
 * local, both bounds inclusive.
 *
 * The boundaries: a 09:00:00 local start is allowed and 08:59:59 is not; with the 300-second
 * `CAP_CALL_SECONDS`, a start at exactly 19:55:00 is allowed and one at 19:55:01 is not, so the whole
 * call fits before the window closes, which is what Twilio's `timeLimit` of the same length
 * enforces. An end that would fall on the next local date is outside the window, because both bounds
 * are read on `now`'s own local date.
 *
 * @param tz - The business's city IANA zone, from `config/cities.json`.
 * @param now - The instant to test, taken from the injected clock (AAP 0.11.1).
 * @param maxSeconds - How long the call may last: `CAP_CALL_SECONDS` (300) in production (AAP 0.5.6).
 * @returns True when the call may start now and still finish inside the window.
 * @throws RangeError when `maxSeconds` is negative or not finite, when `tz` is not an IANA zone, or
 *   when `now` denotes no instant.
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
 * The next instant at which a call may start in `tz` (AAP 0.5.6): today's {@link CALLING_HOURS_START}
 * local while `now` is strictly before it, otherwise the following local day's.
 *
 * A caller uses it only after {@link withinCallingHours} answered false, and both reasons land here:
 * a `now` before 09:00 has today's start still ahead of it, while a `now` at or after 19:55 has used
 * the window up, so the next attempt belongs to tomorrow. At exactly 09:00:00 the answer is
 * tomorrow's, since that start is no longer ahead of `now`.
 *
 * @param tz - The business's city IANA zone, from `config/cities.json`.
 * @param now - The instant to defer from, taken from the injected clock (AAP 0.11.1).
 * @returns The UTC instant of the next 09:00 local.
 * @throws RangeError when `tz` is not an IANA zone or `now` denotes no instant.
 */
export function nextCallingWindow(tz: string, now: Date): Date {
  return nextOccurrenceOf(tz, now, CALLING_HOURS_START);
}
