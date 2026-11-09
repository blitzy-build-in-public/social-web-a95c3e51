/**
 * The mobile client's server clock (AAP 0.3.2, 0.5.1, 0.5.7).
 *
 * A check-in is accepted inside the server's own window and the code it carries is derived on the
 * server clock (AAP 0.5.7), so what this app says about either has to come from that clock: a device
 * whose clock differs would otherwise read "Check-in has closed." on a meetup the API accepts. The
 * gap between the two clocks is re-estimated from the `Date` header of every response -- which
 * AAP 0.3.2's CORS configuration exposes to the web origin for exactly this, and which the venue
 * console reads for its countdown too (`apps/venue-console/src/server-time.ts`, AAP 0.5.1) -- and
 * applied as `serverNow = deviceNow + offset`, which cancels the skew. Until one response has been
 * read no offset is known, and {@link serverNow} answers with the device clock, the behaviour this
 * app had before.
 *
 * The header parsing and the offset estimate are defined once in `@tablemate/shared` (AAP 0.5.1),
 * beside the code constants, and re-exported below, so this app and the console cannot drift on the
 * reading both trust.
 *
 * Client-safe and free of side effects, like the rest of `src/api`: `@tablemate/shared` is its only
 * import, it touches no platform API but `Date`, and holds one module-level value, the estimated
 * offset.
 */

import { HTTP_DATE_RESOLUTION_MS, estimateOffsetMs, parseHttpDate } from '@tablemate/shared';

/* Re-exported so this module stays the app's one import for the server-clock arithmetic. */
export { HTTP_DATE_RESOLUTION_MS, estimateOffsetMs, parseHttpDate };

/**
 * The offset last estimated from a response, or `null` before the first one was read: the device
 * clock plus this figure is the server clock.
 */
let offsetMs: number | null = null;

/**
 * Records the server clock from one response's `Date` header, which every answer carries, a refusal
 * included (AAP 0.3.2, 0.5.1). Nothing but this offset makes the app's own clock-derived copy agree
 * with the server, so it is re-estimated on every answer rather than measured once.
 *
 * Never throws: a response without a readable header leaves the offset it already had in place, and
 * a device that has not yet read one keeps the device clock.
 *
 * @param header - The response's `Date` header, or nothing when it carried none.
 * @param sentAtMs - The device instant immediately before the request was sent.
 * @param receivedAtMs - The device instant its answer arrived at.
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
 * The present instant on the server clock (AAP 0.5.1, 0.5.7), which is what a window or a code shown
 * to the traveler has to be measured against. The offset applied here is what cancels the device's
 * skew: it is the same instant a correct device would read, so the copy agrees with the server's own
 * decision whatever this device's clock says.
 */
export function serverNow(): number {
  return Date.now() + (offsetMs ?? 0);
}
