/** The calling-hours rule (AAP 0.5.6): a call starts only if `now >= 09:00` and `now + CAP_CALL_SECONDS <= 20:00` in the business's own city zone (from `config/cities.json`, never the host's), and one that does not fit is deferred to the next 09:00 local; every zone conversion here goes through `time/city-time.ts`, the one place that speaks an IANA zone. */

import { isWithinLocalWindow, nextOccurrenceOf } from '@tablemate/server-core';
import { CALLING_HOURS_END, CALLING_HOURS_START } from '@tablemate/shared';

export { CALLING_HOURS_END, CALLING_HOURS_START };
/** Whether a call lasting at most `maxSeconds` may start in `tz` at `now`: the whole span must lie inside the window on `now`'s own local date, both bounds inclusive — a 300-second call starts at 19:55:00 and not at 19:55:01, the same bound Twilio's `timeLimit` enforces. */
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

/** The next instant a call may start in `tz`: today's 09:00 local while `now` is strictly before it, otherwise the following local day's, so both refusal reasons land on the next window (at exactly 09:00:00 the answer is tomorrow's, since that start is no longer ahead of `now`). */
export function nextCallingWindow(tz: string, now: Date): Date {
  return nextOccurrenceOf(tz, now, CALLING_HOURS_START);
}
