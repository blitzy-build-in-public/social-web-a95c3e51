/**
 * Server-clock arithmetic for the venue console (AAP 0.5.1, 0.5.7).
 *
 * Codes are accepted on the server clock alone, so a device clock that is minutes off changes neither the code shown nor
 * the countdown: the gap between the two clocks is re-estimated from the `Date` header of every response and applied as
 * `serverNow = deviceNow + offset`, which cancels the skew. Every function here is pure -- no DOM, no timers, no
 * `Date.now()` -- so each instant is a parameter the caller supplies and a test can pin both clocks. The header parsing
 * and the offset estimate the mobile app reads too are defined once in `@tablemate/shared` and re-exported below.
 */
import {
  CODE_STEP_SECONDS,
  CODE_TOLERANCE_STEPS,
  HTTP_DATE_RESOLUTION_MS,
  estimateOffsetMs,
  parseHttpDate,
} from '@tablemate/shared';

/* Re-exported so this module stays the console's one import for the clock arithmetic. */
export { HTTP_DATE_RESOLUTION_MS, estimateOffsetMs, parseHttpDate };
/**
 * Converts a device instant to the server clock (AAP 0.5.1): applying the offset is the only thing device skew
 * influences, and re-estimating it from each response keeps a skewed device on the same server instants as a
 * correct one.
 */
export function serverNowMs(deviceNowMs: number, offsetMs: number): number {
  return deviceNowMs + offsetMs;
}
/**
 * Whole seconds a code remains valid, on the server clock (AAP 0.5.4, 0.5.7): rounded up, so the countdown never
 * reads 0 while the displayed code is still accepted, and never negative.
 */
export function secondsLeft(expiresAtMs: number, serverNow: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - serverNow) / 1000));
}
/**
 * Milliseconds from the device's present instant until a server-clock instant (AAP 0.5.1), in the device's own
 * timer units; a target already passed yields 0, so the caller polls at once.
 */
export function msUntilServerTime(
  targetServerMs: number,
  deviceNowMs: number,
  offsetMs: number,
): number {
  return Math.max(0, targetServerMs - (deviceNowMs + offsetMs));
}
/**
 * Reports whether a displayed code is past the point the server would reject it (AAP 0.5.7). The server accepts the
 * counters T-1, T and T+1, so a code just replaced is still valid for one more step: this stays false until a full
 * step of tolerance has elapsed beyond `expiresAt`, the earliest instant the counter T-1 can be refused.
 */
export function isStale(expiresAtMs: number, serverNow: number): boolean {
  return serverNow >= expiresAtMs + CODE_STEP_SECONDS * CODE_TOLERANCE_STEPS * 1000;
}
