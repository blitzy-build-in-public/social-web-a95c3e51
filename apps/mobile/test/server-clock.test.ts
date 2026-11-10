/**
 * The mobile client's server clock and the capture that feeds it (AAP 0.3.2, 0.5.1, 0.5.7): the check-in
 * window line is drawn from `serverNow()`, which the server decides on its own clock, so the offset is
 * re-estimated from each response's `Date` header -- the one header the API's CORS configuration exposes
 * to the web origin (AAP 0.3.2) -- and applied as `serverNow = deviceNow + offset`. Every instant here is
 * explicit: a sample is built around an instant this file chooses, so a device clock, a round trip and a
 * skew are parameters rather than the process's own time.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { request } from '../src/api/client.ts';
import { ApiError } from '../src/api/errors.ts';
import {
  HTTP_DATE_RESOLUTION_MS,
  estimateOffsetMs,
  parseHttpDate,
  recordServerDate,
  serverNow,
} from '../src/api/server-clock.ts';
/** The server instant the offset samples are built around, 700 ms into its second deliberately: a `Date`
 * header carries whole seconds, so the header names the start of that second and the estimate inherits
 * the header's own resolution rather than the instant itself. */
const HANDLED_AT_MS = Date.UTC(2026, 10, 4, 20, 17, 5, 700);
/** Two hours: the skew the reported reproductions carry, and the one the window line must survive. */
const SKEW_MS = 2 * 60 * 60 * 1000;
/** A round trip of 200 ms, split evenly around the instant the server handled the request. */
const ROUND_TRIP_MS = 200;
/** A parser case: the header value and the epoch milliseconds it must yield, or `null`. */
type HeaderCase = readonly [header: string | null | undefined, expected: number | null];
/** An estimator case: the sample's three instants and the offset they must yield. */
type OffsetCase = readonly [
  serverDateMs: number,
  sentAtMs: number,
  receivedAtMs: number,
  expected: number,
];
/** A skew case: how far the device is from the server clock and how long its round trip is. */
type SkewCase = readonly [skewMs: number, roundTripMs: number];
/** One round trip as the device lived it, and the `Date` header the server answered with. */
interface Trip {
  readonly header: string;
  readonly sentAtMs: number;
  readonly receivedAtMs: number;
}
/** Replays one round trip on a device running `skewMs` ahead of the server, which handled the request
 * at `handledAtMs` and stamped its answer from that instant truncated to the header's resolution. */
function roundTrip(handledAtMs: number, skewMs: number, roundTripMs: number): Trip {
  const resolved = Math.floor(handledAtMs / HTTP_DATE_RESOLUTION_MS) * HTTP_DATE_RESOLUTION_MS;
  return {
    header: new Date(resolved).toUTCString(),
    sentAtMs: handledAtMs - roundTripMs / 2 + skewMs,
    receivedAtMs: handledAtMs + roundTripMs / 2 + skewMs,
  };
}

describe('parseHttpDate', () => {
  const CASES: readonly HeaderCase[] = [
    ['Wed, 04 Nov 2026 20:17:05 GMT', Date.UTC(2026, 10, 4, 20, 17, 5)],
    // Whitespace around the value is the only liberty taken: a header may be padded.
    [' Wed, 04 Nov 2026 20:17:05 GMT ', Date.UTC(2026, 10, 4, 20, 17, 5)],
    [null, null],
    [undefined, null],
    ['', null],
    ['   ', null],
    ['not a date', null],
    // `Date.parse` alone reads this ISO form in the device's own zone, which would put the offset
    // hours out, so the shape above refuses it.
    ['2026-11-04T20:17:05.700Z', null],
    // The obsolete RFC 850 form is not what the API emits either.
    ['Wednesday, 04-Nov-26 20:17:05 GMT', null],
  ];
  it.each(CASES)('reads %j as %j', (header, expected) => {
    expect(parseHttpDate(header)).toBe(expected);
  });
});

describe('estimateOffsetMs', () => {
  const CASES: readonly OffsetCase[] = [
    // The mid-second of the header (1,500) against the mid-round-trip device instant (1,100): the
    // arrival alone would read 400 ms more and the send alone 200 ms less.
    [1_000, 900, 1_300, 400],
    // A device two hours behind a server that handled the request on an exact second: the offset is
    // the skew inverted, plus the half-second the header's own resolution can hide.
    [
      Date.UTC(2026, 10, 4, 20, 17, 5),
      Date.UTC(2026, 10, 4, 20, 17, 5) + SKEW_MS - ROUND_TRIP_MS / 2,
      Date.UTC(2026, 10, 4, 20, 17, 5) + SKEW_MS + ROUND_TRIP_MS / 2,
      HTTP_DATE_RESOLUTION_MS / 2 - SKEW_MS,
    ],
    // A device two hours ahead: the offset is positive and still cancels the skew.
    [
      Date.UTC(2026, 10, 4, 20, 17, 5),
      Date.UTC(2026, 10, 4, 20, 17, 5) - SKEW_MS - ROUND_TRIP_MS / 2,
      Date.UTC(2026, 10, 4, 20, 17, 5) - SKEW_MS + ROUND_TRIP_MS / 2,
      HTTP_DATE_RESOLUTION_MS / 2 + SKEW_MS,
    ],
    // No round trip at all: what is left is the half-second the header itself cannot resolve.
    [0, 0, 0, HTTP_DATE_RESOLUTION_MS / 2],
    // A device a second ahead of a slow answer that took no time to send.
    [1_000, 2_000, 2_000, -500],
  ];
  it.each(CASES)(
    'sample %i/%i/%i yields %i ms',
    (serverDateMs, sentAtMs, receivedAtMs, expected) => {
      expect(estimateOffsetMs({ serverDateMs, sentAtMs, receivedAtMs })).toBe(expected);
    },
  );
  const SKEWS: readonly SkewCase[] = [
    [-SKEW_MS, ROUND_TRIP_MS],
    [-60_000, 40],
    [-1, 0],
    [0, 0],
    [1, 900],
    [SKEW_MS, ROUND_TRIP_MS],
  ];
  it.each(SKEWS)(
    'a device %i ms off over a %i ms round trip is held within half a second',
    (skewMs, roundTripMs) => {
      const trip = roundTrip(HANDLED_AT_MS, skewMs, roundTripMs);
      const offsetMs = estimateOffsetMs({
        serverDateMs: parseHttpDate(trip.header) ?? Number.NaN,
        sentAtMs: trip.sentAtMs,
        receivedAtMs: trip.receivedAtMs,
      });
      // The offset inverts the skew, and half the header's resolution is all it may miss it by.
      expect(Math.abs(offsetMs + skewMs)).toBeLessThanOrEqual(HTTP_DATE_RESOLUTION_MS / 2);
      // Moving the arrival by it lands within half a second of the server instant that answered.
      const errorMs = trip.receivedAtMs + offsetMs - (HANDLED_AT_MS + roundTripMs / 2);
      expect(Math.abs(errorMs)).toBeLessThanOrEqual(HTTP_DATE_RESOLUTION_MS / 2);
    },
  );
});

describe('recordServerDate and serverNow', () => {
  it('answers with the device clock until a response has been read', async () => {
    // A module of its own, so the reading is the state a device has before its first answer rather
    // than whatever the cases below recorded.
    vi.resetModules();
    const fresh = await import('../src/api/server-clock.ts');
    expect(Math.abs(fresh.serverNow() - Date.now())).toBeLessThanOrEqual(1_000);
  });
  it('puts serverNow() on the server instant for a device two hours off', () => {
    const deviceNowMs = Date.now();
    const serverInstantMs = deviceNowMs + SKEW_MS;
    const trip = roundTrip(serverInstantMs, -SKEW_MS, ROUND_TRIP_MS);
    recordServerDate(trip.header, trip.sentAtMs, trip.receivedAtMs);
    expect(Math.abs(serverNow() - serverInstantMs)).toBeLessThanOrEqual(HTTP_DATE_RESOLUTION_MS);
  });
  const UNREADABLE: readonly (string | null | undefined)[] = [
    null,
    undefined,
    '',
    'not a date',
    '2026-11-04T20:17:05.700Z',
  ];
  it.each(UNREADABLE)('keeps the offset it has when the header is %j', (header) => {
    const deviceNowMs = Date.now();
    const trip = roundTrip(deviceNowMs + SKEW_MS, -SKEW_MS, ROUND_TRIP_MS);
    recordServerDate(trip.header, trip.sentAtMs, trip.receivedAtMs);
    const stampedOffsetMs = serverNow() - Date.now();
    expect(() => recordServerDate(header, deviceNowMs, deviceNowMs + ROUND_TRIP_MS)).not.toThrow();
    expect(Math.abs(serverNow() - Date.now() - stampedOffsetMs)).toBeLessThanOrEqual(1);
  });
});

describe('the API client records the server clock from every answer', () => {
  /** The origin the client is pointed at; `apiBaseUrl()` reads it per call. */
  const API_ORIGIN = 'http://api.test';
  /** The envelope an answer with a status other than 200 carries (AAP 0.5.4). */
  const ENVELOPE = '{"error":{"code":"already_checked_in","message":"Already checked in."}}';
  /** A skew no other case records, so a client that failed to record would miss it by minutes. */
  const CLIENT_SKEW_MS = 90 * 60 * 1000;
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.EXPO_PUBLIC_API_URL;
  });
  it.each([200, 409] as const)('records the Date header of a %i answer', async (status) => {
    process.env.EXPO_PUBLIC_API_URL = API_ORIGIN;
    const deviceNowMs = Date.now();
    const serverInstantMs = deviceNowMs + CLIENT_SKEW_MS;
    const trip = roundTrip(serverInstantMs, -CLIENT_SKEW_MS, ROUND_TRIP_MS);
    const answer = {
      ok: status === 200,
      status,
      headers: {
        get: (name: string): string | null => (name.toLowerCase() === 'date' ? trip.header : null),
      },
      text: () => Promise.resolve(status === 200 ? '{}' : ENVELOPE),
    };
    const fetchStub = vi.fn(() => Promise.resolve(answer));
    vi.stubGlobal('fetch', fetchStub);
    const answered = request('GET', '/health', { auth: false, response: null });
    if (status === 200) await expect(answered).resolves.toBeUndefined();
    else await expect(answered).rejects.toBeInstanceOf(ApiError);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(Math.abs(serverNow() - serverInstantMs)).toBeLessThanOrEqual(HTTP_DATE_RESOLUTION_MS);
  });
});
