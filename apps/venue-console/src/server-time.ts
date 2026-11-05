/**
 * Server-clock arithmetic for the venue console (AAP 0.5.1, 0.5.7).
 *
 * The console never derives a check-in code: `GET /venue/check-in-code` returns the server's
 * `{ code, expiresAt }`, and this module decides only when to show that code and when to ask
 * for the next one. Because codes are accepted on the server clock alone, a device clock that
 * is minutes off changes neither the code shown nor the countdown: the gap between the two
 * clocks is re-estimated from the `Date` header of every response and applied as
 * `serverNow = deviceNow + offset`, which cancels the skew.
 *
 * Every function here is pure -- no DOM, no timers, no `Date.now()` -- so each instant is a
 * parameter the caller supplies and a test can pin both clocks.
 */

import { CODE_STEP_SECONDS, CODE_TOLERANCE_STEPS } from '@tablemate/shared';

/** Resolution of an HTTP `Date` header in milliseconds. */
export const HTTP_DATE_RESOLUTION_MS = 1000;

/**
 * The only header shape this module trusts: the IMF-fixdate form of an HTTP date, which is what
 * the API and its proxy emit. `Date.parse` accepts far more than that -- ISO 8601, the obsolete
 * RFC 850 and asctime forms, and a date-time with no zone at all -- and it reads an unzoned
 * date-time in the browser's own zone, so an offset taken from one would be hours out.
 */
const HTTP_DATE_PATTERN =
  /^[A-Za-z]{3}, [0-9]{2} [A-Za-z]{3} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;

/**
 * Parses an HTTP `Date` header into epoch milliseconds (AAP 0.3.2, 0.5.1).
 *
 * The API exposes this header to the console's origin, which is what lets the offset be
 * re-estimated on every response instead of trusting the device clock. Only the IMF-fixdate form
 * of RFC 9110 is trusted (`Wed, 05 Nov 2026 12:00:00 GMT`): it is the one form whose zone is
 * explicit, while every other shape `Date.parse` accepts would put the offset the countdown rests
 * on hours out (AAP 0.5.1, 0.5.7).
 *
 * @param header - The header value, or nothing when the response carried none.
 * @returns Epoch milliseconds; `null` when the header is missing, blank or not in that form, so
 * the caller keeps the offset it already has.
 */
export function parseHttpDate(header: string | null | undefined): number | null {
  if (header === null || header === undefined) {
    return null;
  }
  const trimmed = header.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!HTTP_DATE_PATTERN.test(trimmed)) {
    return null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Estimates the offset to add to the device clock to obtain the server clock (AAP 0.5.1).
 *
 * An HTTP date carries whole seconds, so the server instant is taken as the middle of that
 * second and the device instant that pairs with it as the midpoint of the round trip.
 *
 * @param sample - The response's parsed header and the device instants around its request.
 * @returns Offset in milliseconds, rounded to the nearest millisecond.
 */
export function estimateOffsetMs(sample: {
  serverDateMs: number;
  sentAtMs: number;
  receivedAtMs: number;
}): number {
  return Math.round(
    sample.serverDateMs + HTTP_DATE_RESOLUTION_MS / 2 - (sample.sentAtMs + sample.receivedAtMs) / 2,
  );
}

/**
 * Converts a device instant to the server clock (AAP 0.5.1).
 *
 * Applying the offset is the only thing device skew influences, and re-estimating it from each
 * response keeps a skewed device on the same server instants as a correct one.
 *
 * @param deviceNowMs - The device clock, in epoch milliseconds.
 * @param offsetMs - Offset from {@link estimateOffsetMs}.
 * @returns The same instant on the server clock, in epoch milliseconds.
 */
export function serverNowMs(deviceNowMs: number, offsetMs: number): number {
  return deviceNowMs + offsetMs;
}

/**
 * Whole seconds a code remains valid, rounded up and never negative (AAP 0.5.4, 0.5.7).
 *
 * Rounding up keeps the countdown from reading 0 while the displayed code is still accepted;
 * a code past its `expiresAt` reads 0 rather than a negative figure.
 *
 * @param expiresAtMs - The code's `expiresAt`, on the server clock.
 * @param serverNow - The current server instant, from {@link serverNowMs}.
 */
export function secondsLeft(expiresAtMs: number, serverNow: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - serverNow) / 1000));
}

/**
 * Milliseconds from the device's present instant until a server-clock instant (AAP 0.5.1).
 *
 * The console waits this long before asking for the next code, expressed in the device's own
 * timer units; a target already passed yields 0, so the caller polls at once.
 *
 * @param targetServerMs - The server-clock instant to reach.
 * @param deviceNowMs - The device clock, in epoch milliseconds.
 * @param offsetMs - Offset from {@link estimateOffsetMs}.
 */
export function msUntilServerTime(
  targetServerMs: number,
  deviceNowMs: number,
  offsetMs: number,
): number {
  return Math.max(0, targetServerMs - (deviceNowMs + offsetMs));
}

/**
 * Reports whether a displayed code is past the point the server would reject it (AAP 0.5.7).
 *
 * The server accepts the counters T-1, T and T+1, so a code just replaced is still valid for
 * one more step: this stays false until a full step of tolerance has elapsed beyond
 * `expiresAt`, the earliest instant the counter T-1 can be refused.
 *
 * @param expiresAtMs - The displayed code's `expiresAt`, on the server clock.
 * @param serverNow - The current server instant, from {@link serverNowMs}.
 */
export function isStale(expiresAtMs: number, serverNow: number): boolean {
  return serverNow >= expiresAtMs + CODE_STEP_SECONDS * CODE_TOLERANCE_STEPS * 1000;
}
