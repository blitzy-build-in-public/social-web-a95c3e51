/**
 * The mobile client's server clock (AAP 0.3.2, 0.5.1, 0.5.7).
 *
 * A check-in is accepted inside the server's own window and the code it carries is derived on the
 * server clock (AAP 0.5.7), so what this app says about either has to come from that clock: a device
 * whose clock differs would otherwise read "Check-in has closed." on a meetup the API accepts. The
 * gap between the two clocks is re-estimated from the `Date` header of every response -- which
 * AAP 0.3.2's CORS configuration exposes to the web origin for exactly this, and which the venue
 * console already reads for its countdown (`apps/venue-console/src/server-time.ts`, AAP 0.5.1) --
 * and applied as `serverNow = deviceNow + offset`, which cancels the skew. Until one response has
 * been read no offset is known, and {@link serverNow} answers with the device clock, the behaviour
 * this app had before.
 *
 * Client-safe and free of side effects, like the rest of `src/api`: it imports nothing, touches no
 * platform API but `Date`, and holds one module-level value, the estimated offset.
 */

/** Resolution of an HTTP `Date` header in milliseconds. */
export const HTTP_DATE_RESOLUTION_MS = 1000;

/**
 * The only header shape this module trusts: the IMF-fixdate form of an HTTP date, which is what the
 * API emits. `Date.parse` accepts far more than that -- ISO 8601, the obsolete RFC 850 and asctime
 * forms, and a date-time with no zone at all -- and it reads an unzoned date-time in the device's
 * own zone, so an offset taken from one would be hours out.
 */
const HTTP_DATE_PATTERN =
  /^[A-Za-z]{3}, [0-9]{2} [A-Za-z]{3} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;

/**
 * Parses an HTTP `Date` header into epoch milliseconds (AAP 0.3.2, 0.5.1). The API exposes this
 * header to the web origin, which is what lets the offset be re-estimated on every response instead
 * of trusting the device clock; the shape above is the only one trusted.
 *
 * @param header - The header value, or nothing when the response carried none.
 * @returns Epoch milliseconds, or `null` when the header is missing, blank or not in that form, so
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
 * Estimates the offset to add to the device clock to obtain the server clock (AAP 0.5.1). An HTTP
 * date carries whole seconds, so the server instant is taken as the middle of that second and the
 * device instant that pairs with it as the midpoint of the round trip.
 *
 * @param sample - The `Date` header as an instant, and the device instants that bracketed the
 * round trip it answered.
 * @returns The device-clock error in milliseconds: how far ahead of the server this device reads.
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
