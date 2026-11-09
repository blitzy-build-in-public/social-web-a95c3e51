/**
 * Reads the rotating check-in code off the partner console's venue screen, which is how the web suites
 * check a meetup in with the code a guest at the door would read (AAP 0.11.2; criterion 1).
 *
 * The console derives no code of its own: it renders the server's `{ code, expiresAt }` and asks again at
 * each boundary (AAP 0.5.7), so this reader opens `/venue`, types the venue secret into the gate `App.tsx`
 * publishes, and takes the six digits `VenueCode.tsx` displays together with the whole seconds they stay
 * valid. It installs no clock: `console-clock.spec.ts` skews the page clock first, and the console measures
 * its countdown against the API's `Date` header. The secret is typed in and never logged.
 */

import { expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

import { e2eEnv } from './api-actor.ts';

/** The console's venue screen, which `nginx` serves the console's `index.html` for (AAP 0.6.2). */
const VENUE_PATH = '/venue';

/** The gate's secret field and its submit button (`App.tsx`, `SECRET_FORMS.venue`). */
const SECRET_INPUT = '[data-testid="venue-secret-input"]';
const SECRET_SUBMIT = '[data-testid="venue-secret-submit"]';

/** The code element, whose text is the server's code and nothing else (`VenueCode.tsx`). */
const CODE = '[data-testid="venue-code"]';

/** The countdown element, carrying the seconds left as an attribute rather than in its text. */
const COUNTDOWN = '[data-testid="venue-countdown"]';
const SECONDS_LEFT = 'data-seconds-left';

/** One code, as `CODE_DIGITS` fixes it: exactly six digits and nothing else (AAP 0.5.7). */
const CODE_PATTERN = /^\d{6}$/;

/**
 * The most a fresh code's countdown can read: whole seconds of one step, which is the 60 s of
 * `CODE_STEP_SECONDS`. Stated here rather than imported, because `packages/shared` is outside this file's
 * declared dependencies.
 */
const MAX_SECONDS_LEFT = 60;

/** The most the first code may take: the screen's first request starts as it mounts. */
const CODE_TIMEOUT_MS = 15_000;

/** The one failure this reader reports; it names no secret and no page text. */
const NO_CODE = 'venue console did not show a code';

/** What one read of the console yields. */
export interface VenueCodeReading {
  /** The server's current code, exactly six digits. */
  code: string;
  /** Whole seconds the code is still accepted for, on the server's clock. */
  secondsLeft: number;
}

/**
 * Opens the venue console's code screen and reads the code it is displaying (AAP 0.5.4).
 *
 * The URL is absolute, because the page's `baseURL` is the web app and the console is its own origin. A
 * page that shows no code -- a rejected secret returns the gate, and a code the console cannot refresh is
 * replaced by its stale notice -- fails with the one message above.
 *
 * @throws Error when the console shows no code.
 */
export async function openVenueConsole(page: Page, secret: string): Promise<VenueCodeReading> {
  await page.goto(`${e2eEnv().consoleUrl}${VENUE_PATH}`);
  await page.locator(SECRET_INPUT).fill(secret);
  await page.locator(SECRET_SUBMIT).click();
  const codeLocator = page.locator(CODE);
  try {
    await expect(codeLocator).toHaveText(CODE_PATTERN, { timeout: CODE_TIMEOUT_MS });
  } catch {
    // A failed wait reports the text it received, which is page text, so it is dropped rather than
    // carried: that the console showed no code is the whole of what the caller needs.
    throw new Error(NO_CODE);
  }
  const code = await codeLocator.textContent();
  if (code === null || !CODE_PATTERN.test(code)) {
    throw new Error(NO_CODE);
  }
  const rawSeconds = await page.locator(COUNTDOWN).getAttribute(SECONDS_LEFT);
  if (rawSeconds === null) {
    throw new Error(NO_CODE);
  }
  // Whole seconds of the current step, never the sentence beside the code: an integer in 0..60.
  expect(rawSeconds).toMatch(/^\d{1,2}$/);
  const secondsLeft = Number.parseInt(rawSeconds, 10);
  expect(secondsLeft).toBeLessThanOrEqual(MAX_SECONDS_LEFT);
  return { code, secondsLeft };
}

/**
 * Reads a venue's code in a browser context of its own.
 *
 * The console authenticates by secret alone, so the context carries no storage state and no traveler
 * session, and closing it in `finally` takes the tab's `sessionStorage` -- and the secret in it -- away
 * with it. The read is as fresh as the page: the console polls only at each `expiresAt`, so a caller that
 * has moved the API's test clock reads again rather than reusing an earlier reading.
 *
 * @throws Error when the console shows no code.
 */
export async function readVenueCode(browser: Browser, secret: string): Promise<VenueCodeReading> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    return await openVenueConsole(page, secret);
  } finally {
    await context.close();
  }
}
