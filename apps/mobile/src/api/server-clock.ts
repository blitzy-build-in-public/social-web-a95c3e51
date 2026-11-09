/**
 * The mobile client's server clock.
 *
 * A window or a code shown to the traveler is measured against the server clock, so the gap between the two clocks is
 * re-estimated from the `Date` header of every response and applied as `serverNow = deviceNow + offset`, which cancels
 * the skew; until one response has been read, `serverNow` answers with the device clock. The parsing and the estimate
 * are defined once in `@tablemate/shared`, so this app and the console cannot drift on the reading both trust.
 */
import { HTTP_DATE_RESOLUTION_MS, estimateOffsetMs, parseHttpDate } from '@tablemate/shared';

/* Re-exported so this module stays the app's one import for the server-clock arithmetic. */
export { HTTP_DATE_RESOLUTION_MS, estimateOffsetMs, parseHttpDate };
let offsetMs: number | null = null;
/** Records the server clock from one response's `Date` header, which every answer carries. Never throws: an unreadable
 * header leaves the offset it already had. */
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

/** The present instant on the server clock: the offset applied here cancels the device's skew, so the copy agrees with
 * the server's own decision whatever this device's clock says. */
export function serverNow(): number {
  return Date.now() + (offsetMs ?? 0);
}
