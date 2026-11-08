/**
 * Local proving in each browser engine (AAP 0.3.4, AAP 0.5.5; criterion 4's web rows).
 *
 * One walk, run once per project of `playwright.config.ts` — Chromium, Firefox and WebKit — in which a
 * throwaway account imports the committed fixture booking through the app's own screens and the page's
 * Web Worker proves it on the device. Nothing is mocked and snarkjs is never called from here: this
 * spec reads what the API answers when the proof that browser produced arrives.
 *
 * The API's checks run in order with the nullifier last (AAP 0.5.5, "Server checks"), and actor A has
 * normally spent `valid.eml`'s nullifier by the time this walk runs, so a `409 nullifier_used` proves
 * the Groth16 proof this browser generated verified. A `201` is the same evidence on a stack whose
 * actors have not proved yet. Every other answer — `422 proof_invalid` above all — fails the web
 * capability, which is reported as a defect and never skipped (AAP 0.3.4).
 *
 * The measured span runs from the proving step's first paint to the instant the submission request is
 * issued: the AAP 0.5.5 span of input construction, witness generation and proving, with the artefact
 * download and its hash verification outside it exactly as the client's own measurement has them. One
 * pass suffices because `proving` is a step of its own in `src/state/proof-store.ts`, distinct from
 * `downloading`. Each engine's figure becomes one row of `docs/zk-performance.md`, pass or fail.
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { ErrorEnvelope } from '@tablemate/shared';

import { EMAIL_STAYS_ON_DEVICE } from '../../src/copy/strings.ts';
import {
  ensureActors,
  e2eEnv,
  repoRoot,
  signInViaUi,
  throwawayEmail,
  writeResult,
} from './support/api-actor.ts';

/** The fixture booking this walk proves, relative to the repository root (AAP 0.8.1). */
const FIXTURE = 'packages/circuits/fixtures/test-issuer/valid.eml';

/** The app's test-id contract for the two screens and the three outcomes of the walk (AAP 0.5.8). */
const PROFILE_TAB = 'tab-profile';
const IMPORT_SCREEN = 'proof-import';
const IMPORT_PRIVACY = 'proof-privacy';
const IMPORT_PICK = 'proof-import-pick';
const STATUS = 'proof-generate-status';
const START = 'proof-generate-start';
const ACCEPTED = 'proof-accepted';
const ERROR = 'proof-generate-error';

/**
 * The proving step's own sentence, matched inside the status line, which carries no state attribute.
 * It is the `proving` case of `statusText` in `apps/mobile/app/proof/generate.tsx`; that screen owns
 * the string, so a reworded step breaks this walk loudly rather than measuring the wrong span.
 */
const PROVING_PREFIX = 'Creating your proof on this device';

/** A screen or a banner appearing: navigation and the app's first read of `GET /me`. */
const UI_STEP_TIMEOUT_MS = 60_000;

/**
 * The whole walk, which is unbounded work rather than slow work: the proving key is hundreds of
 * megabytes to gigabytes and the Worker holds all of it while proving (AAP 0.3.4, AAP 0.5.5).
 */
const WALK_TIMEOUT_MS = 30 * 60_000;

/** `ensureActors()` signs two accounts in and may prove actor A's booking in a browser of its own. */
const PREPARE_TIMEOUT_MS = 20 * 60_000;

/** What `POST /v1/itinerary-proofs` may answer and still leave the browser's proof verified. */
const ACCEPTED_STATUS = 201;
const NULLIFIER_USED_STATUS = 409;

/** The statuses a walk records, and the engine's own version, as `docs/zk-performance.md` reads them. */
interface EngineResult {
  engine: string;
  version: string;
  totalMs: number | null;
  apiStatus: number | null;
  result: 'pass' | 'fail';
  method: 'single-pass' | 'two-pass';
  ranAt: string;
}

/**
 * Prepares the stack's shared state first, before any throwaway of this walk can prove anything:
 * `ensureActors()` is what proves `valid.eml` for actor A, so a fresh stack's fixture is never spent
 * by a browser walk that runs ahead of it (AAP 0.11.2).
 */
test.beforeAll(async () => {
  test.setTimeout(PREPARE_TIMEOUT_MS);
  await ensureActors();
});

test('a browser generates the fixture proof and the API verifies it', async ({
  browser,
  browserName,
  context,
}) => {
  test.setTimeout(WALK_TIMEOUT_MS);

  const env = e2eEnv();
  const proofUrl = `${env.apiUrl}/v1/itinerary-proofs`;
  const purpose = `web-proving-${browserName}`;
  const result: EngineResult = {
    engine: browserName,
    version: browser.version(),
    totalMs: null,
    apiStatus: null,
    result: 'fail',
    method: 'single-pass',
    ranAt: new Date().toISOString(),
  };

  try {
    const page = await signInViaUi(context, throwawayEmail(purpose), purpose);

    // Profile → Verify my stay, reached from the app's own tabs: no deep navigation, no route the UI
    // does not offer (AAP 0.5.8).
    await visible(page, PROFILE_TAB).click();
    const verifyStay = visible(page, 'profile-verify-stay');
    await verifyStay.waitFor({ timeout: UI_STEP_TIMEOUT_MS });
    await verifyStay.click();
    await visible(page, IMPORT_SCREEN).waitFor({ timeout: UI_STEP_TIMEOUT_MS });
    await expect(visible(page, IMPORT_PRIVACY).getByText(EMAIL_STAYS_ON_DEVICE)).toBeVisible({
      timeout: UI_STEP_TIMEOUT_MS,
    });

    // The picker on the web is `expo-document-picker`'s own file input, which Playwright reports as a
    // chooser; a build that opens it without a chooser is still driven by the input itself.
    const chooser = page.waitForEvent('filechooser', { timeout: UI_STEP_TIMEOUT_MS });
    await visible(page, IMPORT_PICK).click();
    const picked = await chooser.catch(() => null);
    const fixture = `${repoRoot()}/${FIXTURE}`;
    if (picked === null) {
      await page
        .locator('input[type="file"]')
        .first()
        .setInputFiles(fixture, { timeout: UI_STEP_TIMEOUT_MS });
    } else {
      await picked.setFiles(fixture);
    }

    // The start control exists, and the attempt can begin, only once the published configuration and
    // the artefact plan are both known: a refusal of either surfaces as the error banner instead.
    await expect(visible(page, START)).toBeEnabled({ timeout: UI_STEP_TIMEOUT_MS });

    // Both waiters are registered before the press: proving ends with the submission itself, so a
    // waiter installed afterwards can miss the request entirely.
    const posted = page.waitForRequest(
      (request) => request.url() === proofUrl && request.method() === 'POST',
      { timeout: WALK_TIMEOUT_MS },
    );
    const answer = page.waitForResponse(
      (response) => response.url() === proofUrl && response.request().method() === 'POST',
      { timeout: WALK_TIMEOUT_MS },
    );

    await observeProving(page);
    await visible(page, START).click();

    const request = await posted;
    const response = await answer;
    const startedAt = await provingStartedAt(page);
    const startedAtRequest = request.timing().startTime;
    if (startedAt !== null && Number.isFinite(startedAtRequest) && startedAtRequest > 0) {
      result.totalMs = Math.round(startedAtRequest - startedAt);
    }

    // The email, its field values and every other private input stay on the device: the body carries
    // the proof and the public signals and nothing else (AAP 0.12.2, criterion 3).
    const body: unknown = JSON.parse(request.postData() ?? 'null');
    const keys = typeof body === 'object' && body !== null ? Object.keys(body).sort() : [];
    expect(keys).toEqual(['proof', 'publicSignals']);

    result.apiStatus = response.status();
    const payload: unknown = await response.json().catch(() => null);

    // `nullifier_used` is the pass actor A's spent booking produces: the proof verified before the
    // nullifier was looked up, so the refusal is evidence that this browser proved the statement
    // (AAP 0.5.4, "Server checks").
    const refusal = ErrorEnvelope.safeParse(payload);
    const spentNullifier = refusal.success && refusal.data.error.code === 'nullifier_used';
    const verified =
      result.apiStatus === ACCEPTED_STATUS ||
      (result.apiStatus === NULLIFIER_USED_STATUS && spentNullifier);

    // The screen's own outcome, which must agree with what the API answered either way: a `201`
    // leaves the traveller on the verified stay, and the one refusal that still proves the browser's
    // proof is shown as the refusal it is (AAP 0.5.8).
    const accepted = result.apiStatus === ACCEPTED_STATUS;
    await expect(visible(page, accepted ? ACCEPTED : ERROR).first()).toBeVisible({
      timeout: UI_STEP_TIMEOUT_MS,
    });

    if (!verified) {
      throw new Error(
        `${browserName} proved the fixture booking but the API refused it: HTTP ${String(result.apiStatus)}`,
      );
    }

    result.result = 'pass';
  } finally {
    // Written before a failure propagates, because it is the evidence: one row per engine, holding no
    // email text, field value, private input or proof (AAP 0.3.4).
    result.ranAt = new Date().toISOString();
    writeResult('web-proving', `${browserName}.json`, result);
    await context.close();
  }
});

/** The live copy of one test id; React Navigation keeps a hidden twin of every screen it has mounted. */
function visible(page: Page, testID: string): Locator {
  return page.locator(`[data-testid="${testID}"]:visible`);
}

/**
 * Installs the listener that timestamps the proving step's first paint, inside the page.
 *
 * The mark is taken there rather than by polling from the test process: input construction runs on the
 * page's main thread and blocks it for the length of the witness, so a poll can only observe the step
 * after that block, and a span measured from then would under-report what proving cost. A
 * MutationObserver callback is a microtask, which the flow's own state change runs ahead of the
 * blocking callback it schedules next.
 */
async function observeProving(page: Page): Promise<void> {
  await page.evaluate(
    ({ testID, prefix }: { testID: string; prefix: string }) => {
      const holder = globalThis as unknown as { __provingStartedAt?: number | undefined };
      // Every matching element, because a screen the navigator has hidden is still mounted, and the
      // one showing the proving step is not necessarily the first of them.
      const showing = (): boolean =>
        Array.from(document.querySelectorAll(`[data-testid="${testID}"]`)).some((element) =>
          (element.textContent ?? '').includes(prefix),
        );

      if (showing()) {
        holder.__provingStartedAt = Date.now();
        return;
      }

      const observer = new MutationObserver(() => {
        if (!showing()) return;
        holder.__provingStartedAt = Date.now();
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    },
    { testID: STATUS, prefix: PROVING_PREFIX },
  );
}

/** The instant the proving step painted, on the page's clock, or null when it was never observed. */
async function provingStartedAt(page: Page): Promise<number | null> {
  const mark = await page.evaluate(
    () => (globalThis as unknown as { __provingStartedAt?: number }).__provingStartedAt ?? null,
  );
  return typeof mark === 'number' && Number.isFinite(mark) ? mark : null;
}
