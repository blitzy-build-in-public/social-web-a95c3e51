/**
 * Criterion 1 on the web client — two travelers propose, lock, meet and settle — with criterion 3's request-body check
 * (AAP 0.8.1, 0.12.1).
 *
 * Two browser contexts drive both halves of a pair through the real UI: actor A finds the other traveler on Discover and
 * proposes at a seeded partner venue for the harness's fresh city day, actor B reads the proposal on its own screen and locks
 * it, both check in with the code the venue's console is showing at that moment, and the settlement the harness triggers
 * releases both holds.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContextOptions, Locator, Page } from '@playwright/test';
import {
  DEFAULT_DEPOSIT_CENTS,
  ErrorEnvelope,
  MeetupDto,
  MeetupListResponse,
  MeDto,
  MetricsDto,
  ProposeResponse,
  TIER_FIELDS,
  depositCopy,
} from '@tablemate/shared';
import type { Variant } from '@tablemate/shared';

import {
  BLOCKED_REASON,
  actorInfo,
  api,
  clearPairMeetups,
  contextFor,
  e2eEnv,
  ensureActors,
  ensureCard,
  ensureOperator,
  nextMeetupDay,
  operatorApi,
  partnerVenue,
  recordedProofBody,
  releaseContext,
  repoRoot,
  runSettlement,
  setClock,
  venueSecret,
} from './support/api-actor.ts';
import type { MeetupDay } from './support/api-actor.ts';
import { readVenueCode } from './support/venue-code.ts';

/*
 * Bounds. One screen, one navigation or one provider round trip gets the harness's own page bound; the group
 * gets minutes, because `ensureActors()` imports a booking through the proof screen once per stack and one
 * browser proof of this circuit takes minutes even with the artefacts cached.
 */
const SCREEN_TIMEOUT_MS = 30_000;
const WALK_TIMEOUT_MS = 30 * 60_000;
const UI_STEP_TIMEOUT_MS = 15 * 60_000;

/** Settlement runs at `startsAt + 45 min`, so a minute past it is the first overdue reading. */
const SETTLE_AFTER_MS = 46 * 60_000;

/** How long the settlement and the payment operations it plans are given to land (AAP 0.3.2). */
const SETTLE_TIMEOUT_MS = 90_000;

/** The check-in window opens fifteen minutes before the start; five is inside it (AAP 0.5.3). */
const CHECK_IN_LEAD_MS = 5 * 60_000;

/* The criterion 3 fixtures: the committed booking email and the issuer record beside it. */
const FIXTURE_EML = 'packages/circuits/fixtures/test-issuer/valid.eml';
const ISSUER_CONFIG = 'config/issuers/tablemate-test.json';

/** Where `make-test-fixtures.ts` renders the guest's name; it exports no constant to read instead. */
const GUEST_ANCHOR = 'Guest: ';

/** The carriage return each line of the fixture body ends with, the body being CRLF-terminated. */
const CR = 13;

/** The shortest run of the email's own text criterion 3 searches a submitted body for (AAP 0.12.1). */
const WINDOW_CHARS = 12;

/** The whole of what may leave the device: a proof and its public signals (AAP 0.5.5). */
const PROOF_BODY_KEYS = ['proof', 'publicSignals'];

/** One test id's visible copy: React Navigation keeps a hidden twin of every mounted screen. */
function visible(page: Page, testID: string): Locator {
  return page.locator(`[data-testid="${testID}"]:visible`);
}

/** The experiment variant a deposit screen renders its framing copy from (AAP 0.5.7). */
async function variantOf(role: 'a' | 'b'): Promise<Variant> {
  const me = await api(role).get('/me', MeDto);
  if (me.variant === null) throw new Error(`actor ${role} holds no experiment assignment`);
  return me.variant;
}

/** One instant as the proposal form spells it, in the meetup city's own zone: `YYYY-MM-DD HH:mm`. */
function startTextFor(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  }).formatToParts(new Date(instant));
  const field = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')} ${field('hour')}:${field('minute')}`;
}

/**
 * A profile read handed back unparsed: the tier assertion is about which keys the API serialized, and every
 * shared schema is a strip-mode object that would drop a field above the viewer's tier before the assertion
 * could see it — `AnyTierProfile` included.
 */
const RAW_PROFILE = {
  parse: (value: unknown): Record<string, unknown> => value as Record<string, unknown>,
};

/* The fixture booking's own secrets, which is what criterion 3's assertion turns on. */

/** What criterion 3 searches a submitted body for, read once from the committed fixture. */
interface FixtureSecrets {
  readonly guest: string;
  readonly reference: string;
  /** Every {@link WINDOW_CHARS}-character run of the email's decoded text, whitespace runs aside. */
  readonly windows: readonly string[];
}

let secretsCache: FixtureSecrets | undefined;

/** The value an anchor introduces, up to its terminator byte, or null when the anchor is absent. */
function valueAfterAnchor(text: string, anchor: string, terminator: number): string | null {
  const at = text.indexOf(anchor);
  if (at < 0) return null;
  const start = at + anchor.length;
  const end = text.indexOf(String.fromCharCode(terminator), start);
  return end < 0 ? null : text.slice(start, end);
}

/** The reference anchor and terminator the test issuer's template declares (AAP 0.5.5). */
function referenceField(): { anchor: string; terminator: number } {
  const raw: unknown = JSON.parse(readFileSync(join(repoRoot(), ISSUER_CONFIG), 'utf8'));
  const fields = (raw as { template?: { fields?: Record<string, unknown> } }).template?.fields;
  const { anchor, terminator } = (fields?.['reference'] ?? {}) as {
    anchor?: unknown;
    terminator?: unknown;
  };
  if (typeof anchor !== 'string' || anchor === '' || typeof terminator !== 'number') {
    throw new Error(`${ISSUER_CONFIG} declares no reference anchor and terminator to locate`);
  }
  return { anchor, terminator };
}

/**
 * The fixture's own secrets: its guest name and booking reference, located in the quoted-printable decoded
 * email by the anchors its template renders, and every window of the email's text. A fixture whose guest line
 * or reference cannot be located fails here, so the assertion never passes vacuously.
 *
 * @throws Error naming the file, never the value it holds.
 */
function fixtureSecrets(): FixtureSecrets {
  const known = secretsCache;
  if (known !== undefined) return known;
  // Quoted-printable → text: the soft line breaks go, then the `=XX` escapes become their bytes.
  const decoded = readFileSync(join(repoRoot(), FIXTURE_EML), 'latin1')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_whole, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  const { anchor, terminator } = referenceField();
  const reference = valueAfterAnchor(decoded, anchor, terminator);
  const guest = valueAfterAnchor(decoded, GUEST_ANCHOR, CR);
  if (reference === null || guest === null) {
    throw new Error(
      `could not locate the fixture booking's guest line and reference in ${FIXTURE_EML}`,
    );
  }
  const windows: string[] = [];
  for (let at = 0; at + WINDOW_CHARS <= decoded.length; at += 1) {
    const run = decoded.slice(at, at + WINDOW_CHARS);
    if (run.trim() !== '') windows.push(run);
  }
  secretsCache = { guest, reference, windows };
  return secretsCache;
}

/**
 * Asserts that one captured `POST /v1/itinerary-proofs` body carries the proof and nothing else: its keys are
 * exactly `proof` and `publicSignals`, and it holds neither the fixture's guest name, nor its booking
 * reference, nor any window of the email's text.
 *
 * @throws Error when the body is not the JSON object a proof submission must be.
 */
function assertProofBodyPrivate(bodyText: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error('the captured proof request body is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the captured proof request body is not an object');
  }
  expect(Object.keys(parsed).sort()).toEqual([...PROOF_BODY_KEYS].sort());
  const { guest, reference, windows } = fixtureSecrets();
  expect(bodyText).not.toContain(guest);
  expect(bodyText).not.toContain(reference);
  expect(windows.filter((window) => bodyText.includes(window))).toEqual([]);
}

/* The walk's steps: one per group of screens, each reached from the screen before it. */

/** One page of `GET /meetups`, as the contract's paginated schema answers it (AAP 0.5.4). */
type MeetupPage = ReturnType<typeof MeetupListResponse.parse>;

/** How many meetups the pair had already completed: the tier this walk's outcome moves past. */
async function completedWithCounterpart(userId: string): Promise<number> {
  let cursor: string | null = null;
  let completed = 0;
  for (;;) {
    const suffix = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const page: MeetupPage = await api('a').get(
      `/meetups?status=completed${suffix}`,
      MeetupListResponse,
    );
    completed += page.items.filter((meetup) => meetup.counterpart.id === userId).length;
    if (page.nextCursor === null) return completed;
    cursor = page.nextCursor;
  }
}

/**
 * Actor A proposes the harness's fresh city day through the proposal screen, and answers the meetup id.
 *
 * The framing copy and the safety notice are asserted before the control that commits money, and the answer is
 * waited for by status: a clock move expires the access token the page already holds, so the client refreshes
 * and repeats the request and the 401 it replaced decides nothing.
 */
async function proposeThroughTheUi(
  page: Page,
  day: MeetupDay,
  venueId: string,
  variant: Variant,
): Promise<string> {
  await visible(page, 'tab-discover').click();
  await visible(page, `traveler-${actorInfo('b').userId}`).click();
  await expect(visible(page, 'user-profile')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
  await visible(page, 'user-propose').click();
  await expect(visible(page, 'propose-submit')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
  await visible(page, `propose-venue-${venueId}`).click();
  await visible(page, 'propose-start').fill(startTextFor(day.startsAt, day.timezone));
  await visible(page, `propose-deposit-${DEFAULT_DEPOSIT_CENTS}`).click();
  await expect(visible(page, 'deposit-copy')).toHaveText(
    depositCopy(variant, DEFAULT_DEPOSIT_CENTS),
  );
  await expect(visible(page, 'safety-notice')).toBeVisible();
  // The start the field took is inside the horizon the form accepts, which the enabled control and the
  // answer below both rest on.
  await expect(visible(page, 'propose-submit')).toBeEnabled();
  const answered = page.waitForResponse(
    (response) =>
      response.url() === `${e2eEnv().apiUrl}/v1/meetups` &&
      response.request().method() === 'POST' &&
      response.status() !== 401,
    { timeout: SCREEN_TIMEOUT_MS },
  );
  await visible(page, 'propose-submit').click();
  const response = await answered;
  const body: unknown = await response.json();
  expect(response.status()).toBe(201);
  const created = ProposeResponse.parse(body);
  await expect(visible(page, 'meetup-detail')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
  return created.meetupId;
}

/**
 * Actor B opens the proposal on its own screen, reads the framing there, and locks both holds. The card
 * `ensureCard` saved needs no 3-D Secure, so the accept authorizes in the same request, and the status line
 * reading `Locked` is the screen's own evidence that the recipient's hold was held (AAP 0.5.3).
 */
async function acceptThroughTheUi(page: Page, meetupId: string, variant: Variant): Promise<void> {
  await visible(page, 'tab-meetups').click();
  const row = visible(page, `meetup-${meetupId}`);
  await expect(row).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
  await row.click();
  await expect(visible(page, 'meetup-accept')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
  await expect(visible(page, 'deposit-copy')).toHaveText(
    depositCopy(variant, DEFAULT_DEPOSIT_CENTS),
  );
  await expect(visible(page, 'safety-notice')).toBeVisible();
  await visible(page, 'meetup-accept').click();
  await expect(visible(page, 'meetup-status')).toHaveText(/^Locked$/i, {
    timeout: SCREEN_TIMEOUT_MS,
  });
}

/**
 * One attendee checks in, inside the window, with the code the venue's console is showing at that moment. The
 * code is read again per attendee rather than reused, a step being 60 seconds, and the coordinates are the
 * context's own, granted at the venue: the 0 m test inside the 150 m geofence.
 */
async function checkInAtTheVenue(
  browser: Browser,
  page: Page,
  meetupId: string,
  secret: string,
): Promise<void> {
  const { code } = await readVenueCode(browser, secret);
  await visible(page, 'tab-meetups').click();
  const row = visible(page, `meetup-${meetupId}`);
  await expect(row).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
  await row.click();
  // A locked meetup always offers check-in — the primary control inside the window, a link row outside
  // it — so the control appearing is the screen's own evidence that the lock held.
  await expect(visible(page, 'meetup-check-in')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
  await visible(page, 'meetup-check-in').click();
  await visible(page, 'checkin-code').fill(code);
  await visible(page, 'checkin-submit').click();
  await expect(visible(page, 'checkin-result')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
}

/**
 * The dashboard's headline for one day, which this walk is the only meetup on: `lockedMeetups` counts the
 * meetups that reached two locked holds, `bothCheckedIn` those a pass check-in from each attendee reached, and
 * their ratio is the completion rate the pilot is judged by — 1, for 100% of the one meetup the harness's
 * fresh day holds. The range is the UTC day of `localDate`, which covers the start because 12:00 city-local
 * falls on the same UTC date in every launch city.
 */
async function expectCompletion(cityId: string, localDate: string): Promise<void> {
  const metrics = await operatorApi().get(
    `/admin/metrics?from=${localDate}&to=${localDate}&cityId=${cityId}`,
    MetricsDto,
  );
  expect(metrics.completion.lockedMeetups).toBe(1);
  expect(metrics.completion.bothCheckedIn).toBe(1);
  expect(metrics.completion.rate).toBe(1);
}

/** The pair's tier, asserted by its keys: one completed meetup is tier 2, and a pair that already had
 * one reaches tier 3 (AAP 0.5.4, 0.5.7). */
async function expectTier(userId: string, priorCompleted: number): Promise<void> {
  const profile = await api('a').get(`/users/${userId}`, RAW_PROFILE);
  const expected = priorCompleted === 0 ? TIER_FIELDS[2] : TIER_FIELDS[3];
  expect(Object.keys(profile).sort()).toEqual([...expected].sort());
}

/** One open page per role is all the harness allows, so the whole file is one serial group. */
test.describe.configure({ mode: 'serial' });

test.describe('criterion 1 — two travelers complete a meetup', () => {
  test.skip(e2eEnv().stripeMode !== 'test', BLOCKED_REASON);
  /** The city both fixture proofs name, the venue the pair meets at, and its console secret. */
  let cityId = '';
  let venueId = '';
  let venueLat = 0;
  let venueLng = 0;
  let secret = '';
  /** The meetups the pair had completed before this walk, which decides the tier it ends at. */
  let priorCompleted = 0;
  test.beforeAll(async () => {
    test.setTimeout(WALK_TIMEOUT_MS);
    await ensureActors();
    await ensureOperator();
    await clearPairMeetups();
    const city = actorInfo('a').cityId;
    if (city === null) throw new Error('actor a holds no proof city: call ensureActors() first');
    cityId = city;
    const venue = await partnerVenue(cityId);
    venueId = venue.id;
    venueLat = venue.lat;
    venueLng = venue.lng;
    secret = await venueSecret(venue.id);
    // Read before the walk: after it the pair holds one more completed meetup than this number.
    priorCompleted = await completedWithCounterpart(actorInfo('b').userId);
  });
  test.afterAll(async () => {
    // What this file leaves behind is settled, so the next walk starts with no open meetup between the
    // pair, the way every suite of the harness leaves them (AAP 0.5.3, 0.11.2).
    await clearPairMeetups();
  });
  test('the pair proposes, locks, checks in and settles', async ({ browser }) => {
    test.setTimeout(WALK_TIMEOUT_MS);
    // A fresh city day, with the API's clock at 09:00 of it, so the walk crosses the check-in window and
    // the 45-minute settlement instead of waiting for them (AAP 0.11.2).
    const day = await nextMeetupDay();
    // Both sides of a proposal need a card saved against the traveler's Customer, which the harness
    // enters inside Stripe's Payment Element in a context of its own (AAP 0.3.4).
    await ensureCard('a');
    await ensureCard('b');
    // Device coordinates at the venue — inside the 150 m geofence — granted to each context, so no
    // permission prompt can stand between the walk and the check-in (AAP 0.5.7, 0.12.2).
    const geolocation: BrowserContextOptions = {
      geolocation: { latitude: venueLat, longitude: venueLng },
      permissions: ['geolocation'],
    };
    const { context: contextA, page: pageA } = await contextFor(browser, 'a', geolocation);
    const { context: contextB, page: pageB } = await contextFor(browser, 'b', geolocation);
    try {
      const meetupId = await proposeThroughTheUi(pageA, day, venueId, await variantOf('a'));
      await acceptThroughTheUi(pageB, meetupId, await variantOf('b'));
      await setClock({ now: new Date(Date.parse(day.startsAt) - CHECK_IN_LEAD_MS).toISOString() });
      await checkInAtTheVenue(browser, pageA, meetupId, secret);
      await checkInAtTheVenue(browser, pageB, meetupId, secret);
      await setClock({ now: new Date(Date.parse(day.startsAt) + SETTLE_AFTER_MS).toISOString() });
      // Polled rather than read once: a settlement only plans the provider calls that release the holds,
      // and the executor carries them out after it, so the reading repeats until the money has moved.
      await expect
        .poll(
          async () => {
            await runSettlement(meetupId);
            const meetup = await api('a').get(`/meetups/${meetupId}`, MeetupDto);
            return {
              status: meetup.status,
              initiatorHold: meetup.initiatorHold,
              recipientHold: meetup.recipientHold,
            };
          },
          { timeout: SETTLE_TIMEOUT_MS },
        )
        .toEqual({ status: 'completed', initiatorHold: 'released', recipientHold: 'released' });
      await expectCompletion(cityId, day.localDate);
      await expectTier(actorInfo('b').userId, priorCompleted);
    } finally {
      // The pages are handed back on both paths: a walk that fails must still adopt the rotated refresh
      // tokens, or the next run meets a session the API revoked for reuse (AAP 0.11.2).
      await releaseContext('a', contextA).catch(() => undefined);
      await releaseContext('b', contextB).catch(() => undefined);
    }
  });
  test('the proof request body carries nothing but the proof', async ({ browser }) => {
    test.setTimeout(WALK_TIMEOUT_MS);
    // (1) The body actor A's browser sent when its booking was imported and proved through the proof
    // screen, recorded once per stack by the harness as it created the account.
    assertProofBodyPrivate(recordedProofBody());
    // (2) A fresh capture of the same booking, proved again in the browser on the proof screen. The API
    // refuses it as an already spent nullifier, and the refusal is the receipt: the only thing the
    // request carried was a proof of a booking the server has already seen (AAP 0.5.5).
    const eml = join(repoRoot(), FIXTURE_EML);
    const { context, page } = await contextFor(browser, 'a');
    try {
      await visible(page, 'tab-profile').click();
      await expect(visible(page, 'profile')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      await visible(page, 'profile-verify-stay').click();
      await expect(visible(page, 'proof-import-pick')).toBeVisible({ timeout: SCREEN_TIMEOUT_MS });
      // The picker is the operating system's own, which no browser walk can answer: the chooser is taken
      // when the page raises one, and the file input is set directly when it does not.
      const chooser = page.waitForEvent('filechooser', { timeout: SCREEN_TIMEOUT_MS });
      await visible(page, 'proof-import-pick').click();
      const picked = await chooser.catch(() => null);
      if (picked === null) await page.locator('input[type="file"]').setInputFiles(eml);
      else await picked.setFiles(eml);
      // The attempt is offered once the configuration is read and the artefacts are planned, and the
      // plan may be a download, so the bound is the harness's own for one proving step.
      await expect(visible(page, 'proof-generate-start')).toBeEnabled({
        timeout: UI_STEP_TIMEOUT_MS,
      });
      const answered = page.waitForResponse(
        (response) =>
          response.url() === `${e2eEnv().apiUrl}/v1/itinerary-proofs` &&
          response.request().method() === 'POST',
        { timeout: UI_STEP_TIMEOUT_MS },
      );
      await visible(page, 'proof-generate-start').click();
      const response = await answered;
      const body = response.request().postData() ?? '';
      const envelope: unknown = await response.json();
      assertProofBodyPrivate(body);
      expect(response.status()).toBe(409);
      expect(ErrorEnvelope.parse(envelope).error.code).toBe('nullifier_used');
    } finally {
      await releaseContext('a', context).catch(() => undefined);
    }
  });
});
