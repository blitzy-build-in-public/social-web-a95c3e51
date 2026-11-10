/**
 * The venue console's clock arithmetic (AAP 0.5.1, 0.5.7, 0.12.2). A code is accepted on the server clock alone, so the
 * console derives nothing: it renders the server's `{ code, expiresAt }` and reads the gap between the two clocks from
 * each response's `Date` header as `serverNow = deviceNow + offset`, which cancels a device skew. Every instant here is
 * explicit -- no timers, no `Date.now()`, no DOM -- so both clocks are pinned and the skew is a parameter; the sibling
 * browser-level case is `apps/mobile/e2e/playwright/console-clock.spec.ts`.
 */
import { CODE_STEP_SECONDS, CODE_TOLERANCE_STEPS } from '@tablemate/shared';
import { describe, expect, it } from 'vitest';

import {
  HTTP_DATE_RESOLUTION_MS,
  estimateOffsetMs,
  isStale,
  msUntilServerTime,
  parseHttpDate,
  secondsLeft,
  serverNowMs,
} from '../src/server-time.ts';

/**
 * One step of tolerance: the server accepts T-1, T and T+1, so a code just replaced is still valid for 60 s of
 * server clock beyond the step it was derived from (AAP 0.5.7). Written out rather than computed from
 * `CODE_STEP_SECONDS * CODE_TOLERANCE_STEPS`, so the `isStale` rows below fail when either constant changes
 * instead of moving with it. The pin inside that describe holds the two constants to this figure.
 */
const TOLERANCE_MS = 60_000;
/** The server instant the sampled response was handled, 700 ms into its second deliberately: a `Date` header
 * carries whole seconds, so on an exact second the estimate would inherit the header's own resolution. */
const SERVER_HANDLED_MS = Date.UTC(2026, 10, 4, 20, 17, 5, 700);
/** The instant that response's code expires: 42.3 s after it was handled. */
const EXPIRES_AT_MS = SERVER_HANDLED_MS + 42_300;
/** Round trip of the sampled request, split evenly around the instant the server handled it. */
const ROUND_TRIP_MS = 200;
/** The countdown that sample leaves: 42.4 s on the server clock, rounded up. */
const COUNTDOWN_SECONDS = 43;
/** The estimator's whole error: half the `Date` resolution plus half the round trip. */
const ESTIMATE_ERROR_MS = HTTP_DATE_RESOLUTION_MS / 2 + ROUND_TRIP_MS / 2;
/** A parser case: the header value and the epoch milliseconds it must yield, or `null`. */
type HeaderCase = readonly [header: string | null | undefined, expected: number | null];
/** A countdown case: the distance to the expiry and the whole seconds reported for it. */
type CountdownCase = readonly [expiresAtMs: number, expected: number];
/** A poll-delay case: the target server instant, the device reading and the estimated offset. */
type DelayCase = readonly [
  targetServerMs: number,
  deviceNowMs: number,
  offsetMs: number,
  expected: number,
];
/** A staleness case: the server-clock reading and whether the displayed code is refused then. */
type StaleCase = readonly [serverNowMs: number, expected: boolean];
/** A device's view of the sampled round trip, and the offset it estimated from the response. */
type SkewedClock = {
  deviceNowMs: number;
  offsetMs: number;
  serverNowMs: number;
};
/** Replays the sampled round trip on a device running `skewMs` ahead of the server's, which stamps the request
 * and the response and treats the arrival as its present instant. */
function skewedClock(skewMs: number): SkewedClock {
  const sentAtMs = SERVER_HANDLED_MS - ROUND_TRIP_MS / 2 + skewMs;
  const receivedAtMs = SERVER_HANDLED_MS + ROUND_TRIP_MS / 2 + skewMs;
  const offsetMs = estimateOffsetMs({
    // Whole seconds only: the header reports the handled instant truncated to its resolution.
    serverDateMs: Math.floor(SERVER_HANDLED_MS / HTTP_DATE_RESOLUTION_MS) * HTTP_DATE_RESOLUTION_MS,
    sentAtMs,
    receivedAtMs,
  });
  return { deviceNowMs: receivedAtMs, offsetMs, serverNowMs: serverNowMs(receivedAtMs, offsetMs) };
}

describe('parseHttpDate', () => {
  const CASES: readonly HeaderCase[] = [
    ['Wed, 04 Nov 2026 20:17:05 GMT', Date.UTC(2026, 10, 4, 20, 17, 5)],
    [null, null],
    [undefined, null],
    ['', null],
    ['not a date', null],
    // `Date.parse` alone would read this ISO form in the device's own zone.
    ['2026-11-04T20:17:05.700Z', null],
  ];
  it.each(CASES)('reads %j as %j', (header, expected) => {
    expect(parseHttpDate(header)).toBe(expected);
  });
});

describe('the offset under device skew', () => {
  const SKEWS_MS = [-120_000, -1, 0, 1, 120_000] as const;
  const reference = skewedClock(0);
  const referenceDelayMs = msUntilServerTime(
    EXPIRES_AT_MS + 250,
    reference.deviceNowMs,
    reference.offsetMs,
  );
  const trueDelayMs = EXPIRES_AT_MS + 250 - (SERVER_HANDLED_MS + ROUND_TRIP_MS / 2);
  it.each(SKEWS_MS)('skew %i ms leaves the countdown and the poll delay unchanged', (skewMs) => {
    const clock = skewedClock(skewMs);
    const delayMs = msUntilServerTime(EXPIRES_AT_MS + 250, clock.deviceNowMs, clock.offsetMs);
    // The estimate is the round-trip midpoint of the header's second, so it is the skew inverted.
    expect(clock.offsetMs).toBe(-skewMs - ROUND_TRIP_MS);
    expect(Math.abs(clock.offsetMs + skewMs)).toBeLessThanOrEqual(ESTIMATE_ERROR_MS);
    expect(secondsLeft(EXPIRES_AT_MS, clock.serverNowMs)).toBe(COUNTDOWN_SECONDS);
    // The same poll delay whatever the device clock reads, within the estimator's own error.
    expect(Math.abs(delayMs - referenceDelayMs)).toBeLessThanOrEqual(1_000);
    expect(Math.abs(delayMs - trueDelayMs)).toBeLessThanOrEqual(ESTIMATE_ERROR_MS);
  });
});

describe('secondsLeft', () => {
  const CASES: readonly CountdownCase[] = [
    [60_000, 60],
    // Rounded up, so the countdown never reads 0 while the displayed code is still accepted.
    [41_200, 42],
    [1, 1],
    [0, 0],
    [-5_000, 0],
  ];
  it.each(CASES)('%i ms left on the server clock reads %i s', (expiresAtMs, expected) => {
    expect(secondsLeft(expiresAtMs, 0)).toBe(expected);
  });
});

describe('msUntilServerTime', () => {
  const CASES: readonly DelayCase[] = [
    // Already passed: poll at once, never a negative delay.
    [1_000, 5_000, 0, 0],
    [10_000, 2_000, 3_000, 5_000],
    // A device running behind the server: the offset carries the target back into device units.
    [10_000, 12_000, -3_000, 1_000],
  ];
  it.each(CASES)('target %i, device %i, offset %i -> %i ms', (target, device, offset, expected) => {
    expect(msUntilServerTime(target, device, offset)).toBe(expected);
  });
});

describe('isStale', () => {
  const CASES: readonly StaleCase[] = [
    // The code on screen is still the counter T-1, which the server accepts (AAP 0.5.7).
    [EXPIRES_AT_MS, false],
    [EXPIRES_AT_MS + TOLERANCE_MS - 1, false],
    // A full step of tolerance has passed: T-1 can now be refused.
    [EXPIRES_AT_MS + TOLERANCE_MS, true],
    [EXPIRES_AT_MS + 2 * TOLERANCE_MS, true],
  ];
  it.each(CASES)('server clock at %i -> %s', (serverNow, expected) => {
    expect(isStale(EXPIRES_AT_MS, serverNow)).toBe(expected);
  });

  // The rows above are written against the literal step of tolerance, so the constants the boundary
  // belongs to are held to it here: a code is accepted for T-1, T and T+1 (AAP 0.5.7), one step of
  // 60 s each. A change to either constant must fail this case rather than silently move the rows.
  it('pins one step of tolerance of 60 s per counter', () => {
    expect(CODE_STEP_SECONDS * CODE_TOLERANCE_STEPS).toBe(TOLERANCE_MS / 1000);
  });
});
