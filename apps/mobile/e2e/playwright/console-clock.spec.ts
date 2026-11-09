/**
 * The venue console's rotating code and its countdown under a skewed device clock (AAP 0.5.1, 0.5.7). A
 * check-in code is accepted on the server clock alone and the console derives none of its own: it renders the
 * server's `{ code, expiresAt }` and measures its countdown from the offset between the API's `Date` response
 * header -- exposed cross-origin for exactly this -- and the device clock. This walk skews the page's clock by
 * the whole tolerance either side and holds what the console shows against the API's own answer, read here in a
 * process whose clock is never skewed; the console is opened at its own origin and calls the API origin, so a
 * pass is also evidence that `Date` reaches that origin. The API's test clock is never moved, the code route
 * stamping `Date` from the very instant its code comes from.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { VENUE_SECRET_HEADER, VenueCodeResponse } from '@tablemate/shared';

import { actorInfo, e2eEnv, ensureActors, partnerVenue, venueSecret } from './support/api-actor.ts';
import { openVenueConsole } from './support/venue-code.ts';
/* The console's contract as `support/venue-code.ts` reads it too: the two elements, the countdown's
 * attribute, and the six digits a code is (AAP 0.5.7). */
const CODE = '[data-testid="venue-code"]';
const COUNTDOWN = '[data-testid="venue-countdown"]';
const SECONDS_LEFT = 'data-seconds-left';
const CODE_PATTERN = /^\d{6}$/;
/** The most a countdown reads -- the whole step it belongs to -- and the skews a device may carry. */
const STEP_SECONDS = 60;
const SKEWS_MS: readonly number[] = [-120_000, 120_000];
/* The `Date` header: the IMF-fixdate shape the console's `parseHttpDate` trusts, and the half second
 * an HTTP date leaves out, because it carries whole seconds. */
const HTTP_DATE_PATTERN =
  /^[A-Za-z]{3}, [0-9]{2} [A-Za-z]{3} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;
const HTTP_DATE_HALF_SECOND_MS = 500;
/** How far the two readings of one step may differ: the console's tick, and a boundary between them. */
const COUNTDOWN_TOLERANCE_SECONDS = 2;
/** How long the skewed clock is watched, and the whole seconds a flowing one moves the countdown by. */
const WATCH_MS = 2_000;
const MIN_DROP_SECONDS = 1;
const MAX_DROP_SECONDS = 3;
/** One skew's whole walk, and `ensureActors()`, which may prove a booking in a browser of its own. */
const WALK_TIMEOUT_MS = 120_000;
const PREPARE_TIMEOUT_MS = 20 * 60_000;
/** The venue whose code both skews read, resolved once; the secret never leaves this process. */
let secret = '';
/**
 * Prepares the stack's shared state first, before anything of this walk touches a booking: `ensureActors()`
 * is what proves the two criterion-1 fixtures once per stack, so no spec reaches the API ahead of it.
 */
test.beforeAll(async () => {
  test.setTimeout(PREPARE_TIMEOUT_MS);
  await ensureActors();
  const cityId = actorInfo('a').cityId;
  if (cityId === null) throw new Error('actor a holds no proof city: call ensureActors() first');
  const venue = await partnerVenue(cityId);
  secret = await venueSecret(venue.id);
});

for (const skewMs of SKEWS_MS) {
  const minutes = Math.abs(skewMs) / 60_000;
  const direction = skewMs < 0 ? 'behind the server' : 'ahead of the server';
  test(`a device ${String(minutes)} minutes ${direction} still shows the server's code`, async ({
    browser,
  }) => {
    test.setTimeout(WALK_TIMEOUT_MS);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      // Installed before navigation, so the console's first request and every timer of its poll run on
      // the skewed clock. `install` leaves time flowing -- `pauseAt` is what stops it -- and
      // `setFixedTime` is deliberately not used: a frozen `Date.now()` freezes the countdown with it.
      await page.clock.install({ time: Date.now() + skewMs });
      // The console is opened at its own origin against the API origin, which is also what makes this
      // walk evidence that `Date` reaches the console's origin (AAP 0.3.2).
      await openVenueConsole(page, secret);
      // A 60-second step can turn over between the readings below, so a second pair decides when the
      // first disagrees: one refetch, never a retry loop (AAP 0.12.2).
      let sample = await sampleOnce(page);
      if (sample.server.code !== sample.shown.code) sample = await sampleOnce(page);
      expect(sample.shown.code, 'the console shows the code the API serves for this step').toBe(
        sample.server.code,
      );
      const expected = expectedSeconds(sample);
      expect(
        Math.abs(sample.shown.secondsLeft - expected),
        `the skewed device counts the server's seconds (shown ${String(sample.shown.secondsLeft)}, expected about ${String(expected)})`,
      ).toBeLessThanOrEqual(COUNTDOWN_TOLERANCE_SECONDS);
      // The skew moves nothing but the countdown the console derives, and only while the page's clock
      // runs: a paused clock would leave this attribute exactly where it was. The move is read only
      // while the step has room to move in and the code has not been replaced, because within a few
      // seconds of a boundary the console either holds the old code at zero or shows the next one.
      await page.waitForTimeout(WATCH_MS);
      const later = await readConsole(page);
      if (later.code === sample.shown.code && sample.shown.secondsLeft > MAX_DROP_SECONDS) {
        const dropped = sample.shown.secondsLeft - later.secondsLeft;
        expect(dropped, 'the countdown keeps moving under the skewed clock').toBeGreaterThanOrEqual(
          MIN_DROP_SECONDS,
        );
        expect(dropped).toBeLessThanOrEqual(MAX_DROP_SECONDS);
      }
    } finally {
      // The tab's `sessionStorage`, and the secret typed into it, goes with the context.
      await context.close();
    }
  });
}
/* The two readings every assertion above compares: the API's own answer, and the console's screen. */
/** What the API answers one console read, taken in this process, whose clock is never skewed. */
interface ServerRead {
  code: string;
  /** `expiresAt` as an instant: the end of the step the code belongs to. */
  expiresAtMs: number;
  /** The `Date` header as an instant: the server time the code was derived from. */
  dateMs: number;
  /** When this process received the answer. */
  receivedAtMs: number;
}
/** The code the console shows and the whole seconds it stays accepted for. */
interface ConsoleReading {
  code: string;
  secondsLeft: number;
}
/** One attempt at both readings, in the order the countdown arithmetic needs them. */
interface Sample {
  server: ServerRead;
  shown: ConsoleReading;
  /** When the countdown was read, which {@link expectedSeconds} measures the answer forward to. */
  readAtMs: number;
}
/** The API's answer, then the console's screen: the second is what the first is held against. */
async function sampleOnce(page: Page): Promise<Sample> {
  const server = await readServer();
  const shown = await readConsole(page);
  return { server, shown, readAtMs: Date.now() };
}
/** The code route's answer and its `Date` header, read with the header the console authenticates by. */
async function readServer(): Promise<ServerRead> {
  const response = await fetch(`${e2eEnv().apiUrl}/v1/venue/check-in-code`, {
    headers: { [VENUE_SECRET_HEADER]: secret },
  });
  const receivedAtMs = Date.now();
  expect(response.status, 'GET /v1/venue/check-in-code answers the console secret').toBe(200);
  const dateMs = dateInstant(response.headers.get('date'));
  const body = VenueCodeResponse.parse((await response.json()) as unknown);
  return { code: body.code, expiresAtMs: Date.parse(body.expiresAt), dateMs, receivedAtMs };
}
/** The instant a `Date` response header names, in the one shape the console trusts. */
function dateInstant(header: string | null): number {
  const value = (header ?? '').trim();
  const parsed = HTTP_DATE_PATTERN.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(parsed)) {
    throw new Error(
      'the venue code route exposed no Date a console can read: the countdown cannot be measured',
    );
  }
  return parsed;
}
/** The code and the countdown the console is showing, both read off the screen that renders them. */
async function readConsole(page: Page): Promise<ConsoleReading> {
  const code = ((await page.locator(CODE).textContent()) ?? '').trim();
  expect(code, 'the console shows six digits').toMatch(CODE_PATTERN);
  const raw = (await page.locator(COUNTDOWN).getAttribute(SECONDS_LEFT)) ?? '';
  expect(raw, 'the countdown carries whole seconds').toMatch(/^\d{1,2}$/);
  const secondsLeft = Number.parseInt(raw, 10);
  expect(secondsLeft, 'no countdown exceeds one step').toBeLessThanOrEqual(STEP_SECONDS);
  return { code, secondsLeft };
}
/**
 * The whole seconds the console should be counting down, from the API's own answer.
 *
 * The console measures the same quantity from the offset between the `Date` header and the device clock; for
 * an answer received here that reading of "now" is the header's instant, the middle of the second it
 * carries, plus the span from receiving the answer to reading the screen. The half second mirrors
 * `estimateOffsetMs` in `apps/venue-console/src/server-time.ts`, which the console applies itself.
 */
function expectedSeconds(sample: Sample): number {
  const { server, readAtMs } = sample;
  const serverNow = server.dateMs + HTTP_DATE_HALF_SECOND_MS + (readAtMs - server.receivedAtMs);
  return Math.max(0, Math.ceil((server.expiresAtMs - serverNow) / 1000));
}
