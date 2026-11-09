/**
 * Playwright configuration for the Tablemate web end-to-end suite (AAP 0.8.1, 0.11.2).
 *
 * `pnpm --filter @tablemate/mobile e2e:web` runs this file against the stack `scripts/e2e.ts` has already started, which
 * is why no `webServer` is configured here: the suite starts nothing and only reads the origins below.
 * The suite is serial by construction. One stack, one seeded city day and one test clock are shared by every spec, and
 * the harness keeps at most one browser context per actor at a time, so `workers: 1` with `fullyParallel: false` is what
 * the specs assume; a retry would replay a walk whose holds and nullifiers are already spent, so `retries` stays 0.
 * Chromium runs every spec; Firefox and WebKit run `web-proving.spec.ts` alone, because AAP 0.3.4 requires that proof to
 * be generated in each engine's own build, so every project takes a desktop device descriptor. The accessibility audit
 * stays in the Chromium project for the reason that spec's own header gives, and the criterion walks are Chrome walks
 * because they drive the app's file picker, clock and geolocation.
 * Environment — the four origins and the two modes the harness uses, with the names and defaults of
 * `e2e/playwright/support/api-actor.ts`, which reads them itself: `E2E_WEB_URL` (the web app's origin, and
 * `use.baseURL`), `E2E_CONSOLE_URL`, `E2E_API_URL` (every caller appends `/v1`), `E2E_MAILPIT_URL` (where the magic
 * links are read from), `STRIPE_MODE` (`test` only on a stack holding Stripe test-mode keys, which is what lets the
 * criterion walks confirm a card (AAP 0.11.2); `mock` skips them with `BLOCKED_REASON`), and `TEST_CONTROL_TOKEN`,
 * which has no default and is deliberately absent from `metadata`, because that is written to disk and read by
 * `docs/acceptance.md`; a spec that needs the test clock reads it itself and fails with its name (AAP 0.11.2), so a
 * listing of the suite works with no stack and no token.
 * Reports: `.local/e2e/playwright/` (git-ignored) holds `results.json` for the run and, under `artifacts/`, the trace
 * and screenshot of a failure; `web-proving.spec.ts` also writes one row per engine to `.local/e2e/web-proving/`, which
 * is what `docs/zk-performance.md` records pass, fail or pending from, and the metadata below is what
 * `docs/acceptance.md` takes the mode of a run from (AAP 0.12). Browsers are installed by
 * `playwright install --with-deps chromium firefox webkit`, which `scripts/e2e.ts` runs before the suite.
 */
import { defineConfig, devices } from '@playwright/test';
/** The stack and the two modes this run reads: the harness's contract, resolved once (AAP 0.11.2). */
interface SuiteEnv {
  readonly webUrl: string;
  readonly consoleUrl: string;
  readonly apiUrl: string;
  readonly mailpitUrl: string;
  /**
   * Read so that this file reads the harness's whole environment in one place, and never reported:
   * the token authenticates `/test/*` and must not reach a report or a log (AAP 0.12.2). Empty when
   * unset, which is not an error here — the specs that need test control name it when they fail.
   */
  readonly testControlToken: string;
  /** `test` on a stack holding Stripe test-mode keys; `mock` for every other value and when unset. */
  readonly stripeMode: 'test' | 'mock';
}

/** The published defaults, which `scripts/e2e.ts` overrides with the compose stack's own ports. */
const DEFAULT_WEB_URL = 'http://localhost:8080';
const DEFAULT_CONSOLE_URL = 'http://localhost:8090';
const DEFAULT_API_URL = 'http://localhost:3000';
const DEFAULT_MAILPIT_URL = 'http://localhost:8025';
/**
 * One test's ceiling, which is also the ceiling of a `beforeAll` hook, because a hook shares the
 * bound of the test it belongs to.
 *
 * The first spec file to run on a fresh stack pays the suite's shared preparation inside that hook:
 * both actors signed in and one booking proved in the browser Worker, which the harness bounds at
 * twenty minutes itself (`PREPARE_TIMEOUT_MS` in `e2e/playwright/support/api-actor.ts`) because a
 * proof of this circuit takes minutes. This file's own specification names a three-minute bound, but
 * the hook cannot be shorter than the preparation: a three-minute bound aborts it midway and leaves
 * the actor registry holding one actor, which is the state every later file's `ensureActors()` refuses
 * to continue from, so the whole suite fails on a fresh stack — the accessibility audit first of all,
 * and with no result behind the failure. Measured here on a fresh stack, that hook takes about five
 * minutes (the browser walk alone reports 252 s). Only the files whose walk needs longer than this
 * raise their own bound (`criterion1.spec.ts` and `web-proving.spec.ts` take thirty minutes), and
 * every other test's own assertions bound it far below.
 */
const TEST_TIMEOUT_MS = 20 * 60_000;
/** One assertion's ceiling: a screen, a navigation or a provider round trip, never a proof. */
const EXPECT_TIMEOUT_MS = 15_000;
/** Where the run's reports go, relative to this file: git-ignored, and outside the app's own tree. */
const REPORT_DIR = '../../.local/e2e/playwright';
/**
 * One environment variable, trimmed: compose passes `""` for a variable it leaves unset, and an
 * empty string must not reach a caller as a value.
 */
function envVar(name: string): string {
  const raw: unknown = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * One origin from the environment without a trailing slash, or its published default. Every caller
 * appends a path to it (`/v1/...` for the API, `/venue` for the console), so a value carrying a path
 * would silently move every route of the suite.
 *
 * @param name The variable being read, named in the error and never its value.
 * @param fallback The published default, used when the variable is unset or empty.
 * @returns The origin, without a trailing slash.
 * @throws Error when the value is not an HTTP or HTTPS origin.
 */
function originVar(name: string, fallback: string): string {
  const configured = envVar(name).replace(/\/+$/, '');
  const value = configured === '' ? fallback : configured;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an origin such as ${fallback}`);
  }
  const isOrigin = parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
  if (!isOrigin || !(parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    throw new Error(`${name} must be an origin such as ${fallback}`);
  }
  return value;
}

/** The stack and modes this run uses, read once when the config is loaded. */
function suiteEnv(): SuiteEnv {
  return {
    webUrl: originVar('E2E_WEB_URL', DEFAULT_WEB_URL),
    consoleUrl: originVar('E2E_CONSOLE_URL', DEFAULT_CONSOLE_URL),
    apiUrl: originVar('E2E_API_URL', DEFAULT_API_URL),
    mailpitUrl: originVar('E2E_MAILPIT_URL', DEFAULT_MAILPIT_URL),
    testControlToken: envVar('TEST_CONTROL_TOKEN'),
    stripeMode: envVar('STRIPE_MODE') === 'test' ? 'test' : 'mock',
  };
}

const env = suiteEnv();

export default defineConfig({
  testDir: './e2e/playwright',
  testMatch: '**/*.spec.ts',
  /* One shared stack, one seeded city day and one test clock: the specs run in file order, serially. */
  fullyParallel: false,
  workers: 1,
  retries: 0,
  /* A committed `test.only` must fail the run wherever the suite is not being driven by hand: the
   * delivered suite's only driver, `pnpm test:e2e` through `scripts/e2e.ts`, sets no `CI`, and no
   * pipeline file is delivered (AAP 0.7.2), so the guard is unconditional rather than gated on `CI`. */
  forbidOnly: true,
  timeout: TEST_TIMEOUT_MS,
  expect: { timeout: EXPECT_TIMEOUT_MS },
  outputDir: `${REPORT_DIR}/artifacts`,
  reporter: [['list'], ['json', { outputFile: `${REPORT_DIR}/results.json` }]],
  /* The mode the run used belongs to every result it produces (AAP 0.12); the test-control token is
   * part of the same contract and never of the report (AAP 0.12.2). */
  metadata: {
    webUrl: env.webUrl,
    consoleUrl: env.consoleUrl,
    apiUrl: env.apiUrl,
    mailpitUrl: env.mailpitUrl,
    stripeMode: env.stripeMode,
  },
  use: {
    baseURL: env.webUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  /* Geolocation and permissions are granted per context inside the specs: each context plays a
   * different traveler, standing at the venue that meetup is at (AAP 0.5.7, criterion 6). */
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'firefox',
      testMatch: '**/web-proving.spec.ts',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      testMatch: '**/web-proving.spec.ts',
      use: {
        ...devices['Desktop Safari'],
        /*
         * One proof of this circuit needs the whole 1.59 GB proving key, the witness and the WebAssembly
         * prover's own allocations inside one web process. Measured on the host this ran on: Playwright's
         * WebKit build peaks near 30 GB there, while Chromium and Firefox stay under 8 GB, and the
         * engine's memory-pressure handler ends a process it cannot bring back under its 16 GB kill
         * threshold ("Unable to shrink memory footprint of process (19615 MB) below the kill thresold
         * (16384 MB). Killed"), which is what ended the WebKit walk before this was set. The handler is an
         * embedder heuristic rather than part of the walk, so it is turned off for this project alone.
         * Two host preconditions go with it, recorded in docs/zk-performance.md: vm.max_map_count at
         * 100000 or more, because that engine's allocations need about 79,000 memory maps where Chromium
         * needs a few thousand, and a host with memory to spare for the peak above.
         */
        launchOptions: {
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            WEBKIT_DISABLE_MEMORY_PRESSURE_MONITOR: '1',
          },
        },
      },
    },
  ],
});
