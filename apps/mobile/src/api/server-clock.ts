/**
 * The mobile client's server clock (AAP 0.3.2, 0.5.1, 0.5.7).
 *
 * A window or a code shown to the traveler is measured against the server clock, so the gap between
 * the two clocks is re-estimated from the `Date` header of every response -- which AAP 0.3.2's CORS
 * configuration exposes to the web origin for exactly this -- and applied as
 * `serverNow = deviceNow + offset`, which cancels the skew. Until one response has been read no
 * offset is known, and {@link serverNow} answers with the device clock.
 *
 * The header parsing and the offset estimate are defined once in `@tablemate/shared` (AAP 0.5.1), so
 * this app and the console cannot drift on the reading both trust.
 *
 * Client-safe: `@tablemate/shared` is its only import and it touches no platform API but `Date`.
 */

import { HTTP_DATE_RESOLUTION_MS, estimateOffsetMs, parseHttpDate } from '@tablemate/shared';

/* Re-exported so this module stays the app's one import for the server-clock arithmetic. */
export { HTTP_DATE_RESOLUTION_MS, estimateOffsetMs, parseHttpDate };

/** The offset last estimated from a response, or `null` before the first one was read. */
let offsetMs: number | null = null;

/**
 * Records the server clock from one response's `Date` header, which every answer carries, a refusal
 * included (AAP 0.3.2, 0.5.1). Never throws: an unreadable header leaves the offset it already had in
 * place, and a device that has not yet read one keeps the device clock.
 */
export function recordServerDate(
  header: string | null | undefined,
  sentAtMs: number,
  receivedAtMs: number,
): void {
  const serverDateMs = parseHttpDate(header);
  if (serverDateMs === null) {
    return;
  }
  offsetMs = estimateOffsetMs({ serverDateMs, sentAtMs, receivedAtMs });
}

/**
 * The present instant on the server clock (AAP 0.5.1, 0.5.7). The offset applied here cancels the
 * device's skew, so the copy agrees with the server's own decision whatever this device's clock says.
 */
export function serverNow(): number {
  return Date.now() + (offsetMs ?? 0);
}
