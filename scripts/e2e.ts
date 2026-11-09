/**
 * `pnpm test:e2e` — the end-to-end orchestration (AAP 0.8.1, 0.11.2).
 *
 * One run does four things: it selects the Stripe mode the environment affords, starts the compose
 * project the checkout itself owns ({@link composeProjectName}), so a sibling checkout's containers,
 * `pgdata` volume and image tags are never recreated or dropped, drives the Playwright web suite and
 * — where a device is attached — the Maestro native flows, records the outcome in the `e2e` block of
 * `docs/acceptance.md` and the `e2e:web-proving` block of `docs/zk-performance.md`, and tears the
 * stack down again.
 *
 * Criterion 1 needs real test-mode holds and no client payment adapter is mocked (AAP 0.11.2), so the
 * mode decides what runs. With `sk_test_`/`pk_test_` keys the criterion walks run and `stripe-cli`
 * forwards the webhook events; without them the stack runs `STRIPE_MODE=mock`, every spec and flow
 * that needs no confirmed hold still runs, and each criterion 1 and locked-step cell is recorded as
 * {@link BLOCKED_REASON}. Blocked and pending cells never fail a run — a stack that did not start and
 * a suite that failed do.
 *
 * Exit codes: 0 every executed suite passed (blocked and pending cells are recorded, not failures),
 * 1 the stack failed to start or an executed suite failed, 130/143 the run was interrupted.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import type { ChildProcess } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';

/*
 * Constants.
 */

/** The Stripe posture one run selected from the environment it found (AAP 0.11.2). */
export type StripeMode = 'test' | 'mock';

/** What every flow that needs a confirmed hold is recorded with: the harness's own sentence. */
export const BLOCKED_REASON = 'Blocked — Stripe test-mode keys not supplied';

/** A cell for a column the check does not apply to. */
const NA = 'n/a';

/* The reasons a native platform cannot run, in the wording the documents record (AAP 0.12.3). */
const PENDING_MAESTRO = 'Pending — Maestro CLI not installed';
const PENDING_MACOS = 'Pending — macOS host required';
const PENDING_IOS_SIMULATOR = 'Pending — iOS simulator not available';
const PENDING_ANDROID_EMULATOR = 'Pending — Android emulator not available';
const PENDING_DEV_BUILD = 'Pending — development build not installed';

/** The prefixes that make a Stripe key a test-mode one; a live key is refused outside production. */
const TEST_SECRET_PREFIX = 'sk_test_';
const TEST_PUBLISHABLE_PREFIX = 'pk_test_';

/** The app the native flows drive; `app.config.ts` declares it for both stores. */
const APP_ID = 'com.tablemate.app';

/**
 * The prefix of the compose project one run owns: {@link composeProjectName} appends the checkout's
 * own slug to it, so a run never touches a developer's own stack, another checkout's containers and
 * volumes, or another run's image tags.
 */
const COMPOSE_PROJECT_PREFIX = 'tablemate-e2e';

/** The block each document holds for this run, delimited by the marker convention (AAP 0.8.1). */
const ACCEPTANCE_DOC = 'docs/acceptance.md';
const ACCEPTANCE_BLOCK = 'e2e';
const PERFORMANCE_DOC = 'docs/zk-performance.md';
const PERFORMANCE_BLOCK = 'e2e:web-proving';

/** Everything a run writes outside `docs/`, under the git-ignored `.local/` (AAP 0.11.2). */
const LOCAL_E2E = path.join('.local', 'e2e');
const COMPOSE_LOG = path.join(LOCAL_E2E, 'compose.log');
const METRO_LOG = path.join(LOCAL_E2E, 'metro.log');
const WEB_PROVING_DIR = path.join(LOCAL_E2E, 'web-proving');

/** The circuit build files the stack mounts, the harness proves with and the workers never hold. */
const CIRCUIT_ARTEFACTS = [
  'tablemate_itinerary.wasm',
  'tablemate_itinerary.zkey',
  'verification_key.json',
  'artifacts.manifest.json',
] as const;

/** How long `docker compose up --wait` may take on a cold cache: images build from scratch here. */
const COMPOSE_WAIT_TIMEOUT_S = '600';

/** How long the two published endpoints get to answer 200 after compose reports the stack started. */
const ENDPOINT_TIMEOUT_MS = 60_000;

/** How long the Expo dev server gets to answer its status endpoint before the native suite fails. */
const METRO_READY_TIMEOUT_MS = 120_000;

/** The Metro port the device reaches over `adb reverse`, and the path its status endpoint answers. */
const METRO_PORT = 8081;

/** The ceiling on one captured command's output, generous enough for `compose config --format json`. */
const CAPTURE_LIMIT = 32 * 1024 * 1024;

/**
 * How long an exit's drain may wait for the reader of stdout and stderr before the process is ended
 * anyway (one second). The stack is down or kept by then, and a consumer that never reads — a stopped
 * `tee`, a detached log collector — must not hold the run open.
 */
const EXIT_DRAIN_TIMEOUT_MS = 1_000;

/** The published defaults of the compose stack's host ports, for a checkout with no `.env`. */
export const DEFAULT_PORTS = {
  api: 3000,
  web: 8080,
  console: 8090,
  artifacts: 8070,
  mailpit: 8025,
} as const;

/** One of the five host ports a run needs: the API, the web client and the console it drives. */
export type PortName = keyof typeof DEFAULT_PORTS;

/** The five host ports, resolved from the compose stack rather than assumed. */
export type Ports = Readonly<Record<PortName, number>>;

/** The origin each published port answers on, as the suite and the compose build args read it. */
export interface Origins {
  readonly api: string;
  readonly web: string;
  readonly console: string;
  readonly artifacts: string;
  readonly mailpit: string;
}

/** The compose service and container port behind each published host port. */
const COMPOSE_PORTS: readonly { name: PortName; service: string; target: number }[] = [
  { name: 'api', service: 'api', target: 3000 },
  { name: 'web', service: 'web', target: 80 },
  { name: 'console', service: 'venue-console', target: 80 },
  { name: 'artifacts', service: 'artifacts', target: 80 },
  { name: 'mailpit', service: 'mailpit', target: 8025 },
];

/*
 * Small readers and the pure helpers the run's decisions come from.
 */

/** One command's working directory and environment; the environment is never printed. */
interface Command {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/** One command's outcome, with whatever it printed. */
interface Captured {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Whether a parsed value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One environment variable, trimmed: compose passes `""` for a variable it leaves unset. */
function readValue(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `value` when it holds something, `fallback` otherwise. */
function valueOr(value: string | undefined, fallback: string): string {
  const trimmed = readValue(value);
  return trimmed === '' ? fallback : trimmed;
}

/** The first line of a message, so a reported failure stays one line and carries no stack trace. */
function firstLine(text: string): string {
  const [line = ''] = text.trim().split('\n');
  return line;
}

/**
 * The Stripe mode this run uses, from the keys the environment holds (AAP 0.11.2).
 *
 * Both keys absent is `mock`, the credential-free stack built on `stripe-mock` behind the stateful
 * proxy. A matching test-mode pair is `test`. Anything else — one key without the other, or a key
 * that is not a test-mode one — is refused here, before a container starts, because a live key must
 * never reach a non-production stack (AAP 0.3.3). The message names the variables and never a value.
 *
 * @param env The environment the run was started with.
 * @returns The selected mode.
 * @throws Error when the keys are neither both absent nor a matching test-mode pair.
 */
export function resolveStripeMode(env: NodeJS.ProcessEnv): StripeMode {
  const secret = readValue(env.STRIPE_SECRET_KEY);
  const publishable = readValue(env.STRIPE_PUBLISHABLE_KEY);
  if (secret === '' && publishable === '') {
    return 'mock';
  }
  if (secret.startsWith(TEST_SECRET_PREFIX) && publishable.startsWith(TEST_PUBLISHABLE_PREFIX)) {
    return 'test';
  }
  throw new Error(
    `STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY must both be a matching test-mode pair ` +
      `(${TEST_SECRET_PREFIX}…/${TEST_PUBLISHABLE_PREFIX}…) for STRIPE_MODE=test, or both be unset ` +
      `for STRIPE_MODE=mock; a key that is not a test-mode one is refused outside production`,
  );
}

/** The mode line the documents carry (AAP 0.11.2, 0.12.3). */
export function modeLine(mode: StripeMode): string {
  return mode === 'test'
    ? 'Stripe test mode'
    : 'Stripe mock (stripe-mock behind the stateful proxy) — mock evidence only';
}

/**
 * The numbers an automated call may reach, as the fixtures define them (AAP 0.5.2): every number in
 * the three E.164 ranges reserved for fiction, which are the only numbers the scripted simulator
 * answers. Only the test environment carries this list.
 *
 * @returns A comma-separated `CALL_ALLOWLIST` value of 300 numbers.
 */
export function fixtureCallAllowlist(): string {
  const numbers: string[] = [];
  for (const base of ['+120255501', '+131255501', '+141555501']) {
    for (let index = 0; index < 100; index += 1) {
      numbers.push(`${base}${String(index).padStart(2, '0')}`);
    }
  }
  return numbers.join(',');
}

/**
 * A published nullifier salt: the decimal value of 31 random bytes, which is below the BN254 scalar
 * field order the schema requires (AAP 0.5.5) and always a valid field element.
 *
 * @returns The salt as a decimal string.
 */
export function randomFieldElement(): string {
  return BigInt(`0x${randomBytes(31).toString('hex')}`).toString(10);
}

/** The published host port of one compose service's container port, or null when it has none. */
function publishedPortOf(ports: unknown, target: number): number | null {
  if (!Array.isArray(ports)) {
    return null;
  }
  for (const entry of ports) {
    if (!isRecord(entry) || entry.target !== target) {
      continue;
    }
    const published = Number(entry.published);
    if (Number.isInteger(published) && published > 0) {
      return published;
    }
  }
  return null;
}

/**
 * The five host ports of a resolved compose configuration, falling back to
 * {@link DEFAULT_PORTS} for any service that publishes nothing.
 *
 * `docker compose config` is the one authority on which port a stack publishes: compose interpolates
 * `API_PORT`, `WEB_PORT` and their siblings from the shell and from the checkout's own `.env`, and a
 * checkout that reserved a block of ports of its own — as the clone instructions require — must be
 * driven on the ports it actually took. A host with no `.env` resolves to the published defaults.
 *
 * @param config The parsed `docker compose config --format json` document.
 * @returns The published host port of each service.
 */
export function publishedPorts(config: unknown): Ports {
  const services = isRecord(config) && isRecord(config.services) ? config.services : {};
  const resolved: Record<PortName, number> = { ...DEFAULT_PORTS };
  for (const candidate of COMPOSE_PORTS) {
    const service = services[candidate.service];
    if (!isRecord(service)) {
      continue;
    }
    const published = publishedPortOf(service.ports, candidate.target);
    if (published !== null) {
      resolved[candidate.name] = published;
    }
  }
  return resolved;
}

/** The origin each published port answers on, on the loopback interface compose binds alone. */
export function originsFromPorts(ports: Ports): Origins {
  return {
    api: `http://localhost:${ports.api}`,
    web: `http://localhost:${ports.web}`,
    console: `http://localhost:${ports.console}`,
    artifacts: `http://localhost:${ports.artifacts}`,
    mailpit: `http://localhost:${ports.mailpit}`,
  };
}

/** A name slug in the shape compose accepts: lowercased, every run of foreign characters one `-`. */
function composeNameSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The compose project one run owns, named after the checkout it was started in.
 *
 * Compose derives its project name from the directory it is run in, and this harness has to name the
 * same project for the `docker compose config`, `up` and `down` calls it makes from the repository
 * root, for the volumes and image tags compose then creates, and for the `--keep` instruction it
 * prints. Deriving that name from the checkout keeps all of them on one project, so a run starts,
 * records and tears down its own stack: it never recreates another checkout's containers on the shared
 * daemon nor drops the `pgdata` volume a concurrent run is using, which is the separation
 * `docker-compose.yml` states for two checkouts on one host.
 *
 * The result is valid for compose — it opens with the `t` of {@link COMPOSE_PROJECT_PREFIX} and the
 * slug that follows is lowercased with every run of characters outside `[a-z0-9_-]` replaced by a
 * single `-`, leaving it within `[a-z0-9_-]`. The checkout's own directory name is what identifies the
 * run; `E2E_COMPOSE_PROJECT` pins the whole name instead, for a host that runs one stack at a time.
 *
 * @param source The environment the run was started with.
 * @param checkout The checkout directory the run works in.
 * @returns The compose project name this run owns.
 */
export function composeProjectName(source: NodeJS.ProcessEnv, checkout: string): string {
  const pinned = readValue(source.E2E_COMPOSE_PROJECT);
  if (pinned !== '') {
    return pinned;
  }
  const absolute = path.resolve(checkout);
  const slug = composeNameSlug(path.basename(absolute)) || composeNameSlug(absolute);
  return `${COMPOSE_PROJECT_PREFIX}-${slug}`;
}

/**
 * A markdown table in the shape prettier gives one, which `pnpm format:check` holds every document
 * under `docs/` to: each column as wide as its widest cell counted in code points, the rule row as
 * many dashes, and no trailing whitespace.
 *
 * @param header The column headings.
 * @param rows One array of cells per row, in the header's order.
 * @returns The table, without a trailing newline.
 */
export function markdownTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = header.map((_, column) =>
    Math.max(...[header, ...rows].map((row) => [...(row[column] ?? '')].length)),
  );
  const line = (row: readonly string[]): string => {
    const cells = widths.map((width, column) => {
      const cell = row[column] ?? '';
      return `${cell}${' '.repeat(width - [...cell].length)}`;
    });
    return `| ${cells.join(' | ')} |`;
  };
  const rule = `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`;

  return [line(header), rule, ...rows.map((row) => line(row))].join('\n');
}

/**
 * A document with the named block replaced, or the block appended when either marker is absent — the
 * convention `packages/circuits/scripts/*.sh` and `scripts/count-lines.ts` write their records with.
 * Everything outside the markers is left byte-identical.
 *
 * @param document The document as it stands, or an empty string when it does not exist yet.
 * @param id The block's id, as it appears in the markers.
 * @param content The block's content, its own leading and trailing blank line included.
 * @returns The document with the block in place.
 */
export function applyBlock(document: string, id: string, content: string): string {
  const begin = `<!-- BEGIN ${id} -->`;
  const end = `<!-- END ${id} -->`;
  const start = document.indexOf(begin);
  const stop = document.indexOf(end);

  if (start === -1 || stop < start) {
    const separator =
      document === '' || document.endsWith('\n\n') ? '' : document.endsWith('\n') ? '\n' : '\n\n';
    return `${document}${separator}${begin}${content}${end}\n`;
  }
  return `${document.slice(0, start)}${begin}${content}${document.slice(stop)}`;
}

/*
 * The environment one run starts the stack and the suites with.
 */

/**
 * The environment the stack, the web bundle, the console and the suites share.
 *
 * It is built in memory and never printed or written to disk, because it holds the run's own
 * secrets. Only the values a mode needs are generated, and only when the environment does not
 * already carry one, so a caller can pin any of them.
 *
 * One set of origins covers the whole run: the published host ports the URL variables in it name are
 * the ones the browser loads the bundle from, the CORS allowlist admits, the magic links point at
 * and the suite's own callers use, so no part of the run can disagree about where the stack is.
 *
 * @param source The environment this process was started with.
 * @param stripeMode The mode {@link resolveStripeMode} selected.
 * @param origins The origins of the published host ports.
 * @param project The compose project name {@link composeProjectName} derived for this run, which every
 *   compose call the run makes then acts on.
 * @returns The environment for the compose stack, the suites and the dev server.
 */
export function buildSuiteEnv(
  source: NodeJS.ProcessEnv,
  stripeMode: StripeMode,
  origins: Origins,
  project: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };

  /* The posture of an automated run (AAP 0.11.2): test throughout, the scripted telephony
   * simulator instead of Twilio, the credential-free language model, and the test issuer's root. */
  env.APP_ENV = 'test';
  env.STRIPE_MODE = stripeMode;
  env.TELEPHONY_MODE = 'simulator';
  env.LLM_PROVIDER = 'fake';
  env.ZK_ALLOW_TEST_ISSUER = 'true';
  env.COMPOSE_PROJECT_NAME = project;

  /* A fresh token every run: the harness derives its actor addresses from it, so a rerun signs in
   * with accounts that have spent none of the five magic links an address gets per hour (AAP 0.5.4). */
  env.TEST_CONTROL_TOKEN = randomBytes(32).toString('base64url');
  env.CRAWL_ALLOW_PRIVATE_HOSTS = valueOr(env.CRAWL_ALLOW_PRIVATE_HOSTS, 'localhost');
  env.CALL_ALLOWLIST = fixtureCallAllowlist();

  /* Ephemeral internal secrets, generated only when absent (AAP 0.6.2). */
  env.JWT_SECRET = valueOr(env.JWT_SECRET, randomBytes(32).toString('base64url'));
  env.EMAIL_LOOKUP_PEPPER = valueOr(env.EMAIL_LOOKUP_PEPPER, randomBytes(32).toString('base64url'));
  env.EXPERIMENT_SALT = valueOr(env.EXPERIMENT_SALT, randomBytes(32).toString('base64url'));
  env.ANALYTICS_SALT = valueOr(env.ANALYTICS_SALT, randomBytes(32).toString('base64url'));
  env.FIELD_ENCRYPTION_KEY = valueOr(env.FIELD_ENCRYPTION_KEY, randomBytes(32).toString('base64'));
  env.FIELD_ENCRYPTION_KEY_ID = valueOr(env.FIELD_ENCRYPTION_KEY_ID, 'e2e');
  env.NULLIFIER_SALT = valueOr(env.NULLIFIER_SALT, randomFieldElement());

  /* The compose file pins both of these itself, to the names only the compose network resolves: a
   * host-addressed value from `.env` — as a clone that reserved a port block writes — would leave a
   * container dialling itself, so the notifications job would never reach Mailpit and no magic link
   * would arrive. Set here to the same values as well, so a harness process that reads this
   * environment matches what the containers use (AAP 0.3.3). */
  env.SMTP_URL = 'smtp://mailpit:1025';
  env.VOICE_SIM_URL = 'http://voice-sim:4010';

  /* The origins the stack, the web bundle and the console are built and started against. */
  env.API_PUBLIC_URL = origins.api;
  env.WEB_ORIGIN = origins.web;
  env.VENUE_CONSOLE_ORIGIN = origins.console;
  env.ARTIFACTS_BASE_URL = origins.artifacts;
  env.EXPO_PUBLIC_API_URL = origins.api;
  env.EXPO_PUBLIC_WS_URL = origins.api.replace(/^http/, 'ws');
  env.VITE_API_URL = origins.api;

  /* The harness contract: the four origins and the token the specs read for themselves. */
  env.E2E_API_URL = valueOr(env.E2E_API_URL, origins.api);
  env.E2E_WEB_URL = valueOr(env.E2E_WEB_URL, origins.web);
  env.E2E_CONSOLE_URL = valueOr(env.E2E_CONSOLE_URL, origins.console);
  env.E2E_MAILPIT_URL = valueOr(env.E2E_MAILPIT_URL, origins.mailpit);
  env.API_URL = env.E2E_API_URL;
  env.MAILPIT_URL = env.E2E_MAILPIT_URL;

  /* Only a test-mode stack can confirm a card, so only then does the bundle carry a publishable key
   * (AAP 0.11.2); in mock mode the card screens report that payments are not configured. */
  if (stripeMode === 'test') {
    env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY = readValue(env.STRIPE_PUBLISHABLE_KEY);
  }
  return env;
}

/*
 * What the host offers the native suite (AAP 0.12.3).
 */

/** The two platforms the native flows run on. */
export type NativePlatformId = 'ios' | 'android';

/** The Maestro flows the end-to-end suite drives; the benchmark flow is not one of them. */
export type NativeFlowId = 'reachability' | 'criterion1-initiator' | 'criterion1-recipient';

/** Every native flow, in the order a run attempts them. */
export const NATIVE_FLOWS: readonly NativeFlowId[] = [
  'reachability',
  'criterion1-initiator',
  'criterion1-recipient',
];

/** The flows that need a confirmed hold, and so run in test mode alone (AAP 0.11.2). */
const CRITERION_FLOWS: readonly NativeFlowId[] = ['criterion1-initiator', 'criterion1-recipient'];

/** What one platform offers a run: the device to drive, or why its flows cannot run. */
export interface NativePlatform {
  readonly id: NativePlatformId;
  readonly pending: string | null;
  readonly device?: string;
}

/** Whether Maestro is installed, and what each platform offers. */
export interface NativeAvailability {
  readonly maestro: boolean;
  readonly ios: NativePlatform;
  readonly android: NativePlatform;
}

/** The first booted simulator in `simctl list devices booted -j`, or null. */
export function bootedSimulator(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.devices)) {
    return null;
  }
  for (const runtime of Object.values(parsed.devices)) {
    if (!Array.isArray(runtime)) {
      continue;
    }
    for (const device of runtime) {
      if (isRecord(device) && device.state === 'Booted' && typeof device.udid === 'string') {
        return device.udid;
      }
    }
  }
  return null;
}

/** The first attached emulator or device in `adb devices` output, or null. */
export function attachedDevice(stdout: string): string | null {
  const [, ...lines] = stdout.split('\n');
  for (const line of lines) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial !== undefined && serial !== '' && state === 'device') {
      return serial;
    }
  }
  return null;
}

/**
 * What the native suite can run, detected without side effects: no build, no install, no boot.
 *
 * The iOS row judges the host before the tooling, because a host that is not a Mac can never run an
 * iOS simulator however the tools are installed, and its pending reason says so rather than naming a
 * missing CLI (AAP 0.12.3). Everything else is best effort: a missing or failing command is that
 * platform's pending reason, never a failure of the run.
 *
 * @param where The repository root and the environment to run the probes with.
 * @returns Maestro's presence and one entry per platform.
 */
export async function detectNative(where: Command): Promise<NativeAvailability> {
  const maestro = (await runCapture('maestro', ['--version'], where)).ok;

  let ios: NativePlatform = { id: 'ios', pending: PENDING_MACOS };
  if (process.platform === 'darwin') {
    ios = !maestro ? { id: 'ios', pending: PENDING_MAESTRO } : await detectIosSimulator(where);
  }

  let android: NativePlatform = { id: 'android', pending: PENDING_MAESTRO };
  if (maestro) {
    const devices = await runCapture('adb', ['devices'], where);
    const serial = devices.ok ? attachedDevice(devices.stdout) : null;
    android =
      serial === null
        ? { id: 'android', pending: PENDING_ANDROID_EMULATOR }
        : (
              await runCapture(
                'adb',
                ['-s', serial, 'shell', 'pm', 'list', 'packages', APP_ID],
                where,
              )
            ).stdout.includes(`package:${APP_ID}`)
          ? { id: 'android', pending: null, device: serial }
          : { id: 'android', pending: PENDING_DEV_BUILD };
  }

  return { maestro, ios, android };
}

/** The booted iOS simulator holding the development build, or the reason there is none. */
async function detectIosSimulator(where: Command): Promise<NativePlatform> {
  const list = await runCapture('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], where);
  const udid = list.ok ? bootedSimulator(list.stdout) : null;
  if (udid === null) {
    return { id: 'ios', pending: PENDING_IOS_SIMULATOR };
  }
  const installed = await runCapture('xcrun', ['simctl', 'get_app_container', udid, APP_ID], where);
  return installed.ok
    ? { id: 'ios', pending: null, device: udid }
    : { id: 'ios', pending: PENDING_DEV_BUILD };
}

/*
 * What a run observed, and the two documents it is recorded in (AAP 0.12).
 */

/** One web spec: the id its cells carry and the file that walks it. */
export type WebSpecId = 'reachability' | 'a11y' | 'web-proving' | 'console-clock' | 'criterion1';

/** The web specs, in the order a run drives them; criterion 1 runs in test mode alone. */
const WEB_SPECS: readonly { id: WebSpecId; file: string }[] = [
  { id: 'reachability', file: 'reachability.spec.ts' },
  { id: 'a11y', file: 'a11y-core-flows.spec.ts' },
  { id: 'web-proving', file: 'web-proving.spec.ts' },
  { id: 'console-clock', file: 'console-clock.spec.ts' },
  { id: 'criterion1', file: 'criterion1.spec.ts' },
];

/** One platform's outcome: what it offered, and how each flow it ran ended. */
export interface NativeReport {
  readonly pending: string | null;
  readonly flows: Partial<Record<NativeFlowId, boolean>>;
}

/** Everything the `e2e` block records. */
export interface RunReport {
  readonly date: string;
  readonly commit: string;
  readonly stripeMode: StripeMode;
  readonly web: Partial<Record<WebSpecId, boolean>>;
  readonly native: Readonly<Record<NativePlatformId, NativeReport>>;
}

/** One platform's cell of one row; a check that does not apply to native carries none. */
interface PlatformCells {
  readonly web: string;
  readonly ios?: string;
  readonly android?: string;
}

/** One row of the `e2e` block. */
export interface AcceptanceCheck {
  readonly id: AcceptanceCheckId;
  readonly label: string;
  readonly native: boolean;
}

/** The id a row of the `e2e` block is keyed by. */
export type AcceptanceCheckId =
  'criterion1' | 'reachability' | 'locked-steps' | 'wcag' | 'web-proving' | 'console-clock';

/** The rows of the `e2e` block, in the order the documents list them (AAP 0.12.1, 0.12.2). */
export const ACCEPTANCE_CHECKS: readonly AcceptanceCheck[] = [
  { id: 'criterion1', label: 'Criterion 1 — end-to-end meetup completion', native: true },
  {
    id: 'reachability',
    label: 'Criterion 8 — reachability (no locked meetup needed)',
    native: true,
  },
  {
    id: 'locked-steps',
    label: 'Criterion 8 — reachability: accept, check-in, messaging, dispute, suggestions',
    native: true,
  },
  { id: 'wcag', label: 'WCAG 2.1 AA — axe on core flows', native: false },
  { id: 'web-proving', label: 'Web proving', native: false },
  { id: 'console-clock', label: 'Console clock skew', native: false },
];

/**
 * The `e2e` block's cells, from what the run observed.
 *
 * The two rows that need a locked meetup — criterion 1 and the locked steps of criterion 8 — are
 * blocked as a whole in mock mode, on every platform, because no walk of them can run at all; the
 * blocked sentence therefore outranks a platform's pending reason there (AAP 0.11.2). Everywhere else
 * a platform that could not run reports its own reason, and a suite that ran reports pass or fail.
 *
 * @param report The run's outcome.
 * @returns One row's cells per check.
 */
export function acceptanceCells(report: RunReport): Record<AcceptanceCheckId, PlatformCells> {
  const blocked: PlatformCells = {
    web: BLOCKED_REASON,
    ios: BLOCKED_REASON,
    android: BLOCKED_REASON,
  };
  const spec = (id: WebSpecId): string => (report.web[id] === true ? 'pass' : 'fail');
  const flows = (id: NativePlatformId, names: readonly NativeFlowId[]): string => {
    const platform = report.native[id];
    if (platform.pending !== null) {
      return platform.pending;
    }
    return names.every((name) => platform.flows[name] === true) ? 'pass' : 'fail';
  };
  const criterion = (id: NativePlatformId): string => flows(id, CRITERION_FLOWS);
  /* The locked-step walks are part of the criterion 1 spec and of the reachability spec's own
   * second group, so their web evidence is whether those two walks passed (AAP 0.12.1 criterion 8). */
  const lockedWeb =
    report.web.criterion1 === true && report.web.reachability === true ? 'pass' : 'fail';
  const tested = report.stripeMode === 'test';

  return {
    criterion1: tested
      ? { web: spec('criterion1'), ios: criterion('ios'), android: criterion('android') }
      : blocked,
    reachability: {
      web: spec('reachability'),
      ios: flows('ios', ['reachability']),
      android: flows('android', ['reachability']),
    },
    'locked-steps': tested
      ? { web: lockedWeb, ios: criterion('ios'), android: criterion('android') }
      : blocked,
    wcag: { web: spec('a11y') },
    'web-proving': { web: spec('web-proving') },
    'console-clock': { web: spec('console-clock') },
  };
}

/** The `e2e` block content: the run's identity and one row per check. */
export function renderAcceptanceBlock(report: RunReport): string {
  const cells = acceptanceCells(report);
  const rows = ACCEPTANCE_CHECKS.map((check) => {
    const platform = cells[check.id];
    return [
      check.label,
      platform.web,
      check.native ? (platform.ios ?? NA) : NA,
      check.native ? (platform.android ?? NA) : NA,
    ];
  });
  const heading =
    `Run ${report.date} · commit ${report.commit} · ${modeLine(report.stripeMode)} · ` +
    'telephony: simulator · LLM: fake';

  /* The content opens and closes with a blank line: the first ends the marker's own line and leaves
   * the blank one after it, and the last leaves the blank line before the closing marker, which is
   * the shape prettier gives a block in these documents. */
  return [
    '',
    '',
    heading,
    '',
    markdownTable(['Check', 'Web', 'iOS', 'Android'], rows),
    '',
    '',
  ].join('\n');
}

/** The engines `web-proving.spec.ts` proves in, one row each (AAP 0.3.4). */
export type WebProvingEngineId = 'chromium' | 'firefox' | 'webkit';

/** The engines the `e2e:web-proving` block lists, in order. */
export const WEB_PROVING_ENGINES: readonly WebProvingEngineId[] = ['chromium', 'firefox', 'webkit'];

/** One engine's row: the browser it proved in and what the run measured. */
export interface WebProvingRow {
  readonly version: string;
  readonly totalSeconds: string;
  readonly result: 'pass' | 'fail' | 'pending';
}

/** What the `e2e:web-proving` block records. */
export interface WebProvingReport {
  readonly date: string;
  readonly commit: string;
  readonly stripeMode: StripeMode;
  readonly engines: Partial<Record<WebProvingEngineId, WebProvingRow>>;
}

/**
 * One engine's row from the file `web-proving.spec.ts` wrote, or null when this run produced no
 * evidence: a missing file, a shape the spec does not write, or a file older than the run, which
 * would otherwise be reported as this run's own result.
 *
 * A walk that failed can leave a file with no duration, and it still carries the engine's own
 * verdict: the row then reads `fail` with `n/a` for the timing rather than `pending`, which is
 * reserved for an engine whose check has not run at all (AAP 0.3.4).
 *
 * @param raw The parsed file.
 * @param startedAtMs When this run began, in epoch milliseconds.
 * @returns The row, or null.
 */
export function webProvingRow(raw: unknown, startedAtMs: number): WebProvingRow | null {
  if (!isRecord(raw)) {
    return null;
  }
  const ranAt = typeof raw.ranAt === 'string' ? Date.parse(raw.ranAt) : Number.NaN;
  if (!Number.isFinite(ranAt) || ranAt < startedAtMs) {
    return null;
  }
  const totalMs = typeof raw.totalMs === 'number' ? raw.totalMs : Number.NaN;
  return {
    version: valueOr(typeof raw.version === 'string' ? raw.version : undefined, NA),
    totalSeconds: Number.isFinite(totalMs) ? (totalMs / 1000).toFixed(1) : NA,
    result: raw.result === 'pass' ? 'pass' : 'fail',
  };
}

/** The `e2e:web-proving` block content (AAP 0.3.4, 0.5.5). */
export function renderWebProvingBlock(report: WebProvingReport): string {
  const rows = WEB_PROVING_ENGINES.map((engine) => {
    const row = report.engines[engine];
    return row === undefined
      ? [engine, NA, NA, 'pending']
      : [engine, row.version, row.totalSeconds, row.result];
  });
  const heading =
    `Web proving in the end-to-end suite. Run ${report.date} · commit ${report.commit} · ` +
    modeLine(report.stripeMode);
  const note =
    'Timings are informational: the 90-second target names only the phone classes (AAP 0.5.5). Each ' +
    'row is one `.local/e2e/web-proving/<engine>.json` that this run wrote, and an engine whose file ' +
    'is missing is `pending`. Chrome, Firefox and Safari at their current and previous branded ' +
    'versions are recorded by hand (AAP 0.3.4).';

  return [
    '',
    '',
    heading,
    '',
    markdownTable(['Engine', 'Version', 'Total (s)', 'Result'], rows),
    '',
    note,
    '',
    '',
  ].join('\n');
}

/*
 * The run: preflight, the stack, the suites, the record, the teardown.
 */

/* The state every exit path reads, which is why it lives at the module's scope: the signal handlers
 * and the `finally` both tear the run down, and teardown has to know what is up. */
let root = '';
let composeProject = '';
let suiteEnv: NodeJS.ProcessEnv = process.env;
let profiles: readonly string[] = ['--profile', 'test'];
let keepStack = false;
let stackStarted = false;
let metro: ChildProcess | null = null;
let metroLog: FileHandle | null = null;
let adbDevices: readonly string[] = [];
let teardownRun: Promise<void> | null = null;

/** How long one captured command may take before it is killed; none of them is a suite. */
const CAPTURE_TIMEOUT_MS = 60_000;

/** The repository root, from git rather than from the working directory. */
async function repositoryRoot(): Promise<string> {
  const result = await runCapture('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    env: process.env,
  });
  const found = firstLine(result.stdout);
  if (!result.ok || found === '') {
    throw new Error('git rev-parse --show-toplevel found no repository root');
  }
  return found;
}

/** Whether a filesystem error is a missing file rather than a permission or I/O problem. */
function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

/**
 * Runs one command with its output captured and its environment inherited; it never throws, so a
 * caller decides what a failure means. The environment is passed through, never echoed.
 */
async function runCapture(
  command: string,
  args: readonly string[],
  where: Command,
  timeoutMs = CAPTURE_TIMEOUT_MS,
): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: where.cwd,
      env: where.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(0, CAPTURE_LIMIT);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(0, CAPTURE_LIMIT);
    });

    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

/** Runs one command with its output inherited, which is how a suite reports its own progress. */
async function runInherit(
  command: string,
  args: readonly string[],
  where: Command,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: where.cwd,
      env: where.env,
      stdio: 'inherit',
    });
    child.on('error', () => resolve(false));
    child.on('close', (code: number | null) => resolve(code === 0));
  });
}

/** Requires a tool, naming it and how to install it. */
async function requireTool(
  command: string,
  args: readonly string[],
  where: Command,
  hint: string,
): Promise<void> {
  if (!(await runCapture(command, args, where)).ok) {
    throw new Error(`${command} is required: ${hint}`);
  }
}

/** Requires the circuit build the stack mounts, the client downloads and the harness proves with. */
async function requireArtefacts(): Promise<void> {
  const missing: string[] = [];
  for (const name of CIRCUIT_ARTEFACTS) {
    try {
      await stat(path.join(root, 'packages', 'circuits', 'build', name));
    } catch {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `the circuit build is incomplete (missing ${missing.join(', ')}): run \`pnpm circuits:build\` first`,
    );
  }
}

/** The five host ports the compose project resolves to, from compose itself. */
async function resolvePorts(env: NodeJS.ProcessEnv): Promise<Ports> {
  const resolved = await runCapture('docker', ['compose', 'config', '--format', 'json'], {
    cwd: root,
    env,
  });
  if (!resolved.ok) {
    throw new Error(`docker compose config failed: ${firstLine(resolved.stderr)}`);
  }
  try {
    return publishedPorts(JSON.parse(resolved.stdout) as unknown);
  } catch {
    throw new Error('docker compose config printed no JSON: the compose file was not resolved');
  }
}

/** Whether a loopback port can still be bound, which is what a second stack needs. */
async function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

/** Refuses a run whose stack could not bind its two browser-facing ports. */
async function requireFreePorts(ports: Ports): Promise<void> {
  for (const name of ['api', 'web'] as const) {
    if (!(await isFree(ports[name]))) {
      throw new Error(
        `port ${ports[name]} (${name}) is already bound: stop the running compose stack first`,
      );
    }
  }
}

/**
 * The signing secret `stripe-cli` forwards with, read from the CLI and never printed: the forwarding
 * service signs with its own secret, so the API has to be given the same one (AAP 0.11.2).
 */
async function webhookSecret(): Promise<string> {
  const printed = await runCapture(
    'docker',
    ['compose', ...profiles, 'run', '--rm', '--no-deps', 'stripe-cli', 'listen', '--print-secret'],
    { cwd: root, env: suiteEnv },
  );
  const [secret] = /whsec_[A-Za-z0-9]+/.exec(`${printed.stdout}\n${printed.stderr}`) ?? [''];
  if (secret === undefined || secret === '') {
    throw new Error(
      'stripe-cli printed no webhook signing secret: check that the test-mode keys are valid and that this host can reach Stripe',
    );
  }
  return secret;
}

/** Whether one URL answers 2xx. */
async function isOk(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/** Waits for the API's health route and Mailpit's info route to answer, which compose alone cannot. */
async function waitForEndpoints(origins: Origins): Promise<boolean> {
  const urls = [`${origins.api}/v1/health`, `${origins.mailpit}/api/v1/info`];
  const deadline = Date.now() + ENDPOINT_TIMEOUT_MS;
  for (;;) {
    if ((await Promise.all(urls.map((url) => isOk(url)))).every(Boolean)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(1_000);
  }
}

/**
 * Starts the stack, or reports that it did not come up.
 *
 * The volumes are dropped first: a database from an earlier run holds the fixture bookings' spent
 * nullifiers, and a harness proof of one would be refused with `409 nullifier_used` (AAP 0.5.2).
 * `--build` matters because the web image inlines the client's origins and publishable key at build
 * time, so the bundle the browser loads has to be built by this run.
 */
async function startStack(origins: Origins, stripeMode: StripeMode): Promise<boolean> {
  const where: Command = { cwd: root, env: suiteEnv };
  stackStarted = true;
  await runCapture('docker', ['compose', ...profiles, 'down', '-v', '--remove-orphans'], where);
  if (stripeMode === 'test') {
    suiteEnv.STRIPE_WEBHOOK_SECRET = await webhookSecret();
  }
  const up = await runInherit(
    'docker',
    ['compose', ...profiles, 'up', '--build', '--wait', '--wait-timeout', COMPOSE_WAIT_TIMEOUT_S],
    where,
  );
  return up && (await waitForEndpoints(origins));
}

/** Keeps the stack's own last lines for the operator, under the git-ignored `.local/`. */
async function saveComposeLog(): Promise<void> {
  const logs = await runCapture(
    'docker',
    ['compose', ...profiles, 'logs', '--no-color', '--tail', '300'],
    { cwd: root, env: suiteEnv },
  );
  const file = path.join(root, COMPOSE_LOG);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${logs.stdout}${logs.stderr}`, 'utf8');
  process.stderr.write(`e2e: the stack did not start; its last logs are in ${COMPOSE_LOG}\n`);
}

/** One web spec, in its own process, so its result is its exit status. */
async function runWebSpec(file: string): Promise<boolean> {
  return runInherit(
    'pnpm',
    ['--filter', '@tablemate/mobile', 'e2e:web', `e2e/playwright/${file}`],
    {
      cwd: root,
      env: suiteEnv,
    },
  );
}

/** Starts the Expo dev server a development build loads its JavaScript from. */
async function startMetro(): Promise<boolean> {
  await mkdir(path.join(root, LOCAL_E2E), { recursive: true });
  metroLog = await open(path.join(root, METRO_LOG), 'a');
  metro = spawn(
    'pnpm',
    ['--filter', '@tablemate/mobile', 'start', '--dev-client', '--port', String(METRO_PORT)],
    { cwd: root, env: suiteEnv, stdio: ['ignore', metroLog.fd, metroLog.fd] },
  );
  const deadline = Date.now() + METRO_READY_TIMEOUT_MS;
  for (;;) {
    if (await isMetroReady()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(1_000);
  }
}

/** Whether the dev server is up: its status route answers with the packager's own phrase. */
async function isMetroReady(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${METRO_PORT}/status`);
    return response.ok && (await response.text()).includes('packager-status:running');
  } catch {
    return false;
  }
}

/** Stops the dev server; its log stays behind in `.local/e2e/metro.log`. */
function stopMetro(): void {
  metro?.kill('SIGTERM');
  metro = null;
  void metroLog?.close();
  metroLog = null;
}

/** The fixture proofs and venue data the native flows need before they start (AAP 0.11.2). */
async function prepareMaestro(): Promise<boolean> {
  return runInherit('pnpm', ['--filter', '@tablemate/mobile', 'e2e:prepare'], {
    cwd: root,
    env: suiteEnv,
  });
}

/**
 * One Maestro flow on one device.
 *
 * `--device` is a global option Maestro takes before `test`, so it cannot be appended to the
 * `e2e:native` script: this is that script's own command aimed at a single device, with the same
 * variables and with the flow file named rather than selected by tag.
 */
async function runNativeFlow(device: string, flow: NativeFlowId): Promise<boolean> {
  const args = [
    '--device',
    device,
    'test',
    '-e',
    `API_URL=${readValue(suiteEnv.E2E_API_URL)}`,
    '-e',
    `MAILPIT_URL=${readValue(suiteEnv.E2E_MAILPIT_URL)}`,
    '-e',
    `TEST_CONTROL_TOKEN=${readValue(suiteEnv.TEST_CONTROL_TOKEN)}`,
    '-e',
    `STRIPE_MODE=${readValue(suiteEnv.STRIPE_MODE)}`,
    path.join('apps', 'mobile', 'e2e', 'maestro', `${flow}.yaml`),
  ];
  return runInherit('maestro', args, { cwd: root, env: suiteEnv });
}

/**
 * The native suite, per platform that offers a device.
 *
 * Criterion 1 runs on every platform it can, whichever role the device plays, and the reachability
 * walk runs everywhere; in mock mode the criterion 1 flows are not invoked at all, because their
 * cells are recorded as blocked (AAP 0.11.2). A platform that offers nothing keeps its pending
 * reason, and a run whose dev server or preparation fails records the flows it could not attempt as
 * failures rather than leaving them blank.
 */
async function runNativeSuite(
  availability: NativeAvailability,
  stripeMode: StripeMode,
  ports: Ports,
): Promise<Record<NativePlatformId, NativeReport>> {
  const reports: Record<NativePlatformId, NativeReport> = {
    ios: { pending: availability.ios.pending, flows: {} },
    android: { pending: availability.android.pending, flows: {} },
  };
  const platforms = [availability.ios, availability.android].filter(
    (platform) => platform.pending === null && platform.device !== undefined,
  );
  if (platforms.length === 0) {
    return reports;
  }

  const flows: readonly NativeFlowId[] = stripeMode === 'test' ? NATIVE_FLOWS : ['reachability'];
  const ready = (await startMetro()) && (await prepareMaestro());

  for (const platform of platforms) {
    const device = platform.device ?? platform.id;
    if (platform.id === 'android') {
      adbDevices = [...adbDevices, device];
      /* The emulator reaches the host's services as `localhost`, which is what the flows' own
       * variables and the dev-client bundle name. */
      for (const port of [...Object.values(ports), METRO_PORT]) {
        await runCapture('adb', ['-s', device, 'reverse', `tcp:${port}`, `tcp:${port}`], {
          cwd: root,
          env: suiteEnv,
        });
      }
    }
    const ran: Partial<Record<NativeFlowId, boolean>> = {};
    for (const flow of flows) {
      ran[flow] = ready ? await runNativeFlow(device, flow) : false;
    }
    reports[platform.id] = { pending: null, flows: ran };
  }
  return reports;
}

/** Each engine's row from the file the web-proving spec wrote, when this run wrote it. */
async function readEngineRows(
  startedAtMs: number,
): Promise<Partial<Record<WebProvingEngineId, WebProvingRow>>> {
  const rows: Partial<Record<WebProvingEngineId, WebProvingRow>> = {};
  for (const engine of WEB_PROVING_ENGINES) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(
        await readFile(path.join(root, WEB_PROVING_DIR, `${engine}.json`), 'utf8'),
      );
    } catch {
      parsed = null;
    }
    const row = webProvingRow(parsed, startedAtMs);
    if (row !== null) {
      rows[engine] = row;
    }
  }
  return rows;
}

/**
 * Writes one block into its document, creating the document when it is absent and leaving everything
 * outside the markers byte-identical.
 *
 * The write goes through a randomly named temporary file in the document's own directory and a
 * rename, so a reader never sees a half-written document and no predictable name can be planted to
 * redirect the write (CWE-377).
 */
async function writeDocBlock(file: string, id: string, content: string): Promise<void> {
  const absolute = path.join(root, file);
  let existing = '';
  try {
    existing = await readFile(absolute, 'utf8');
  } catch (error) {
    /* Only a missing document is created: an unreadable one is a problem to report, never a file to
     * replace with this block alone. */
    if (!isMissing(error)) {
      throw error;
    }
    existing = '';
  }
  const next = applyBlock(existing, id, content);
  if (next === existing) {
    return;
  }
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp.${randomBytes(6).toString('hex')}`;
  await writeFile(temporary, next, { encoding: 'utf8', mode: 0o644 });
  await rename(temporary, absolute);
}

/** The commit the run is recorded at, `-dirty` when the working tree holds changes. */
async function headCommit(): Promise<string> {
  const where: Command = { cwd: root, env: process.env };
  const head = await runCapture('git', ['rev-parse', '--short', 'HEAD'], where);
  const status = await runCapture('git', ['status', '--porcelain'], where);
  const short = firstLine(head.stdout);
  const name = head.ok && short !== '' ? short : 'unknown';
  return status.ok && status.stdout.trim() !== '' ? `${name}-dirty` : name;
}

/** Every executed suite that failed, named for the summary and for the exit status. */
export function failuresOf(report: RunReport): readonly string[] {
  const failures: string[] = [];
  for (const spec of WEB_SPECS) {
    if (report.web[spec.id] === false) {
      failures.push(`web ${spec.id}`);
    }
  }
  for (const id of ['ios', 'android'] as const) {
    for (const flow of NATIVE_FLOWS) {
      if (report.native[id].flows[flow] === false) {
        failures.push(`${id} ${flow}`);
      }
    }
  }
  return failures;
}

/** The teardown every exit path runs, and that runs once however many of them call it. */
function tearDown(): Promise<void> {
  teardownRun ??= performTeardown();
  return teardownRun;
}

/**
 * Stops the dev server, drops the device port forwards and takes the stack down with its volumes.
 * `--keep` leaves the stack up for debugging and prints how to stop it.
 */
async function performTeardown(): Promise<void> {
  stopMetro();
  for (const device of adbDevices) {
    await runCapture('adb', ['-s', device, 'reverse', '--remove-all'], {
      cwd: root,
      env: suiteEnv,
    });
  }
  adbDevices = [];
  if (!stackStarted) {
    return;
  }
  if (keepStack) {
    process.stdout.write(
      `e2e: stack left running — stop it with \`docker compose -p ${composeProject} down -v --remove-orphans\`\n`,
    );
    return;
  }
  await runCapture('docker', ['compose', ...profiles, 'down', '-v', '--remove-orphans'], {
    cwd: root,
    env: suiteEnv,
  });
}

/**
 * End the process with `code` once every byte already written to stdout and stderr has reached its
 * consumer.
 *
 * A write to a pipe is completed by the event loop, so `process.exit()` discards whatever is still
 * queued — and under `| tee` or a CI log collector that is the last line this run exists to print,
 * the record of what the interrupt did. An empty write queued behind the real ones calls back once
 * they have been flushed, and {@link EXIT_DRAIN_TIMEOUT_MS} bounds a consumer that never drains. A
 * consumer that has stopped reading closes the pipe instead (`| head`), which ends the drain the same
 * way: the conventional status of an interrupt is what stands in either case.
 *
 * @param code - the status the explicit exit this replaces carried.
 */
function exitAfterFlush(code: number): void {
  process.exitCode = code;

  const draining = new Set<NodeJS.WriteStream>();
  if (process.stdout.writableLength > 0) draining.add(process.stdout);
  if (process.stderr.writableLength > 0) draining.add(process.stderr);

  if (draining.size === 0) {
    // Nothing is queued: every byte reached its consumer as it was written (a terminal, a file).
    process.exit(code);
    return;
  }

  const bound = setTimeout(() => process.exit(code), EXIT_DRAIN_TIMEOUT_MS);
  bound.unref();

  const finish = (stream: NodeJS.WriteStream): void => {
    draining.delete(stream);
    if (draining.size === 0) {
      clearTimeout(bound);
      process.exit(code);
    }
  };

  for (const stream of [...draining]) {
    stream.once('error', () => {
      finish(stream);
    });
    stream.write('', () => {
      finish(stream);
    });
  }
}

/** Tears the run down on Ctrl-C or a termination request, then exits with the conventional status. */
function installSignalHandlers(): void {
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    process.once(signal, () => {
      process.stderr.write(`e2e: ${signal} received — tearing the stack down\n`);
      void tearDown().finally(() => exitAfterFlush(code));
    });
  }
}

/**
 * The run: preflight, the stack, the suites, the record, the teardown.
 *
 * The preflight refuses everything it can before a container exists — a missing tool, an incomplete
 * circuit build, a key that is not a test-mode one, a port another stack holds — and the teardown
 * runs on every exit path, including an interrupt.
 *
 * @param argv This process's arguments; `--keep` leaves the stack running for debugging.
 * @returns The process exit status: 1 when the stack did not start or an executed suite failed.
 * @throws Error when the preflight refuses the environment, naming what is missing.
 */
export async function runE2E(argv: readonly string[] = []): Promise<number> {
  const startedAtMs = Date.now();
  keepStack = argv.includes('--keep');
  root = await repositoryRoot();
  composeProject = composeProjectName(process.env, root);
  const where: Command = { cwd: root, env: process.env };

  await requireTool(
    'docker',
    ['compose', 'version'],
    where,
    'install Docker Engine with the compose plugin',
  );
  await requireTool('pnpm', ['--version'], where, 'enable Corepack and activate pnpm 12.16.1');
  await requireArtefacts();

  const stripeMode = resolveStripeMode(process.env);
  process.stdout.write(`e2e: Stripe mode ${stripeMode} (no key is ever printed)\n`);
  const ports = await resolvePorts({ ...process.env, COMPOSE_PROJECT_NAME: composeProject });
  const origins = originsFromPorts(ports);
  suiteEnv = buildSuiteEnv(process.env, stripeMode, origins, composeProject);
  profiles =
    stripeMode === 'test'
      ? ['--profile', 'test', '--profile', 'stripe-test']
      : ['--profile', 'test'];
  await requireFreePorts(ports);
  process.stdout.write(
    `e2e: API ${origins.api} · web ${origins.web} · console ${origins.console}\n`,
  );

  const availability = await detectNative(where);
  installSignalHandlers();

  const web: Partial<Record<WebSpecId, boolean>> = {};
  let native: Record<NativePlatformId, NativeReport> = {
    ios: { pending: availability.ios.pending, flows: {} },
    android: { pending: availability.android.pending, flows: {} },
  };

  try {
    if (!(await startStack(origins, stripeMode))) {
      await saveComposeLog();
      return 1;
    }
    for (const spec of WEB_SPECS) {
      /* The criterion 1 walk confirms real holds and no adapter mocks one, so in mock mode the spec
       * is not invoked at all; its own `test.skip` is the backstop (AAP 0.11.2). */
      if (spec.id === 'criterion1' && stripeMode !== 'test') {
        continue;
      }
      process.stdout.write(`e2e: web ${spec.id}\n`);
      web[spec.id] = await runWebSpec(spec.file);
    }
    native = await runNativeSuite(availability, stripeMode, ports);
  } finally {
    await tearDown();
  }

  const report: RunReport = {
    date: new Date(startedAtMs).toISOString(),
    commit: await headCommit(),
    stripeMode,
    web,
    native,
  };
  const engines = await readEngineRows(startedAtMs);
  await writeDocBlock(ACCEPTANCE_DOC, ACCEPTANCE_BLOCK, renderAcceptanceBlock(report));
  await writeDocBlock(
    PERFORMANCE_DOC,
    PERFORMANCE_BLOCK,
    renderWebProvingBlock({ date: report.date, commit: report.commit, stripeMode, engines }),
  );

  const failures = failuresOf(report);
  process.stdout.write(`e2e: recorded in ${ACCEPTANCE_DOC} and ${PERFORMANCE_DOC}\n`);
  process.stdout.write(`${renderAcceptanceBlock(report)}\n`);
  process.stdout.write(
    failures.length === 0
      ? 'e2e: every executed suite passed (blocked and pending cells are recorded, not failures)\n'
      : `e2e: failed — ${failures.join(', ')}\n`,
  );
  return failures.length === 0 ? 0 : 1;
}

/*
 * Entry point: a direct execution runs the suite, an import only gets the helpers above.
 */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    process.exitCode = await runE2E(process.argv.slice(2));
  } catch (error) {
    /* A preflight refusal is one line for the operator, never a stack trace. */
    process.stderr.write(`e2e: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
