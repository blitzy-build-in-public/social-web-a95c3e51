/**
 * The WCAG 2.1 AA audit of the four core flows — sign-in, proposal, commitment lock and check-in
 * (AAP 0.5.8, AAP 0.12.2). Each screen is read with `@axe-core/playwright` over the WCAG 2.0 and 2.1
 * level A and AA rulesets, and any `serious` or `critical` violation fails the suite; everything axe
 * found is written under `.local/e2e/a11y/` for `docs/accessibility.md`.
 *
 * The lock and check-in screens need a meetup whose deposit decision is durable, and no client
 * payment adapter is mocked (AAP 0.11.2), so both run only on a stack holding Stripe test-mode keys;
 * without them the test is skipped with `BLOCKED_REASON`, the sentence `scripts/e2e.ts` writes for
 * those flows into `docs/accessibility.md`.
 *
 * Every page is a hand-off context of `support/api-actor.ts` (one page per role, strictly serial),
 * selectors come only from the test-id contract of `apps/mobile/app`, and after the first load every
 * step taps what a traveler taps. No page text, handle or token reaches a recorded result, and no
 * Block between the two actors is ever confirmed.
 */
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DEFAULT_DEPOSIT_CENTS, ProposeResponse } from '@tablemate/shared';
import type { Locator, Page } from '@playwright/test';

import {
  BLOCKED_REASON,
  actorInfo,
  api,
  clearPairMeetups,
  contextFor,
  e2eEnv,
  ensureActors,
  ensureCard,
  nextMeetupDay,
  partnerVenue,
  releaseContext,
  throwawayEmail,
  writeResult,
} from './support/api-actor.ts';
import { waitForMagicLink } from './support/mailpit.ts';

/** The rulesets the audit runs: level A and AA of the WCAG 2.0 and the WCAG 2.1 recommendation. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

/** The impacts that fail the suite; a `minor` or `moderate` rule is recorded and left standing. */
const FAILING_IMPACTS: readonly string[] = ['serious', 'critical'];

/** How long a screen gets to render before it is read: react-native-web mounts asynchronously. */
const SCREEN_TIMEOUT_MS = 30_000;

/** The meetup's own status line once the recipient's hold has authorized (`STATUS_TEXT.locked`). */
const LOCKED_STATUS = /^Locked$/i;

/** The address a throwaway sign-in uses, and the name a refusal message reports it under. */
const SIGN_IN = 'a11y-sign-in';

/** The visible copy of one test id: React Navigation keeps a hidden twin of every screen mounted. */
const visible = (page: Page, testID: string): Locator =>
  page.locator(`[data-testid="${testID}"]:visible`);

/**
 * Audits one rendered screen and records what axe found.
 *
 * The record holds the screen, its path, the identities and counts of the rules violated and the
 * number of rules that passed — never the page's own text. Only a `serious` or `critical` violation
 * fails the test; the rest stay in the record for `docs/accessibility.md`.
 */
async function checkPage(page: Page, screen: string): Promise<void> {
  const report = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze();
  const failures = report.violations.filter((rule) => FAILING_IMPACTS.includes(rule.impact ?? ''));

  writeResult('a11y', `${screen}.json`, {
    screen,
    ranAt: new Date().toISOString(),
    url: new URL(page.url()).pathname,
    violations: report.violations.map((rule) => ({
      id: rule.id,
      impact: rule.impact ?? 'unknown',
      nodes: rule.nodes.length,
      help: rule.help,
    })),
    passes: report.passes.length,
  });

  expect(
    failures.map((rule) => rule.id),
    `${screen}: serious or critical axe violations`,
  ).toEqual([]);
}

/**
 * Confirms the age gate's adult switch: the screen re-renders while the app settles, so the press is
 * retried until the continue button accepts it.
 */
async function confirmAdult(page: Page): Promise<void> {
  const submit = visible(page, 'age-gate-submit');

  await expect(async () => {
    if (!(await submit.isEnabled())) await visible(page, 'age-gate-adult').click();
    await expect(submit).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: SCREEN_TIMEOUT_MS });

  await submit.click();
}

/** One open meetup is the most a pair may hold, so every suite clears it before and after its own. */
test.beforeAll(async () => {
  await ensureActors();
  await clearPairMeetups();
});

test.afterAll(async () => {
  await clearPairMeetups();
});

/* The core-flow audit is a Chromium check: `apps/mobile/playwright.config.ts` keeps it in that
 * engine's project. It is scoped there rather than here because a fixture-based `test.skip` still
 * runs this file's `afterAll`, which would clear the pair's meetups from a project that audits
 * nothing (observed: the hook runs while every test in the file is reported skipped). */

test('the sign-in flow meets WCAG 2.1 AA', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: e2eEnv().webUrl });
  const page = await context.newPage();
  const email = throwawayEmail('a11y');

  await page.goto('/');
  await visible(page, 'sign-in-email').waitFor({ timeout: SCREEN_TIMEOUT_MS });
  await checkPage(page, 'sign-in');

  // The link is driven here rather than through `signInViaUi`, which confirms the age gate itself and
  // would leave the screen this test audits unread (AAP 0.5.8).
  const since = Date.now();
  await visible(page, 'sign-in-email').fill(email);
  await visible(page, 'sign-in-submit').click();
  const magic = await waitForMagicLink(email, {
    since,
    mailpitUrl: e2eEnv().mailpitUrl,
    purpose: SIGN_IN,
  });

  await page.goto(magic.link);
  await visible(page, 'age-gate-adult').waitFor({ timeout: SCREEN_TIMEOUT_MS });
  await checkPage(page, 'age-gate');

  await confirmAdult(page);
  await visible(page, 'tab-discover').waitFor({ timeout: SCREEN_TIMEOUT_MS });
  await context.close();
});

test('the proposal screen meets WCAG 2.1 AA', async ({ browser }) => {
  const { context, page } = await contextFor(browser, 'a');

  try {
    // Discover lists the other travelers of the city actor a's own proof names (AAP 0.5.8).
    await visible(page, 'tab-discover').click();
    await visible(page, `traveler-${actorInfo('b').userId}`).click();
    await visible(page, 'user-propose').click();
    await visible(page, 'propose-submit').waitFor({ timeout: SCREEN_TIMEOUT_MS });

    // The deposit framing and the safety notice are what this screen must show before a proposal.
    await expect(visible(page, 'deposit-copy')).toBeVisible();
    await expect(visible(page, 'safety-notice')).toBeVisible();
    await checkPage(page, 'proposal');
  } finally {
    // The page is handed back on both paths: an audit that fails must still adopt the rotated refresh
    // token, or the next run in this stack meets a session the API has revoked for reuse (AAP 0.11.2).
    // A page that never loaded has no token to adopt, and the audit's own failure is the report.
    await releaseContext('a', context).catch(() => undefined);
  }
});

test('the commitment lock and check-in screens meet WCAG 2.1 AA', async ({ browser }) => {
  test.skip(e2eEnv().stripeMode !== 'test', BLOCKED_REASON);

  const cityId = actorInfo('a').cityId;
  if (cityId === null) throw new Error('actor a holds no proof city: call ensureActors() first');

  const venue = await partnerVenue(cityId);
  await ensureCard('a');
  await ensureCard('b');

  const day = await nextMeetupDay();
  const proposed = await api('a').post('/meetups', ProposeResponse, {
    recipientId: actorInfo('b').userId,
    venueId: venue.id,
    startsAt: day.startsAt,
    depositCents: DEFAULT_DEPOSIT_CENTS,
  });
  expect(proposed.status).toBe('proposed');

  // The check-in screen reads the device's coordinates, so the context is granted them at the venue
  // and no permission prompt can block the page (AAP 0.5.7, 0.12.2).
  const { context, page } = await contextFor(browser, 'b', {
    permissions: ['geolocation'],
    geolocation: { latitude: venue.lat, longitude: venue.lng },
  });

  try {
    await visible(page, 'tab-meetups').click();
    await visible(page, `meetup-${proposed.meetupId}`).click();
    await visible(page, 'meetup-accept').waitFor({ timeout: SCREEN_TIMEOUT_MS });
    await expect(visible(page, 'deposit-copy')).toBeVisible();
    await expect(visible(page, 'safety-notice')).toBeVisible();
    await checkPage(page, 'lock');

    await visible(page, 'meetup-accept').click();
    await expect(visible(page, 'meetup-status')).toHaveText(LOCKED_STATUS, {
      timeout: SCREEN_TIMEOUT_MS,
    });

    // At this hour the check-in window is not yet open, so the form renders with the time left to it.
    await visible(page, 'meetup-check-in').click();
    await visible(page, 'checkin-code').waitFor({ timeout: SCREEN_TIMEOUT_MS });
    await expect(visible(page, 'checkin-submit')).toBeVisible();
    await expect(visible(page, 'checkin-time-left')).toBeVisible();
    await checkPage(page, 'check-in');
  } finally {
    await releaseContext('b', context).catch(() => undefined);
  }
});
