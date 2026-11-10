/**
 * The integration harness of `apps/api` (AAP 0.8.1 "App factory", AAP 0.11.2): the globalSetup that starts the
 * containers every integration suite shares, and the factory that builds one app against them. Values are read
 * lazily, so importing this module has no side effect.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import {
  GenericContainer,
  Wait,
  getContainerRuntimeClient,
  type StartedTestContainer,
} from 'testcontainers';
import { inject } from 'vitest';

import { Prisma } from '@tablemate/db';
import type { DbClient } from '@tablemate/db';
import { runSeed, type SeedSummary } from '@tablemate/db/seed';
import {
  createFakeLlmAdapter,
  createLogger,
  createRedisConnection,
  createTestClock,
  loadApiEnv,
  waitForRedisReady,
} from '@tablemate/server-core';
import type { ApiEnv, FakeLlmAdapter, LlmAdapter, TestClock } from '@tablemate/server-core';
import type { UserRole } from '@tablemate/shared';

import { buildApp, startBackground, type App, type AppServices } from '../../src/app.ts';
import { signAccessToken } from '../../src/plugins/auth.ts';
import type { PaymentsGateway } from '../../src/modules/payments/gateway.ts';
import { clockHelpers, type ClockHelpers } from './clock.ts';
import { createFaultInjector, type TestFaults } from './faults.ts';
import { TEST_NULLIFIER_SALT, findRepoRoot } from './proofs.ts';
import { startStripeProxy, type StripeProxy } from './stripe-proxy/server.ts';
import { proxyControl, type ProxyControl } from './stripe-proxy/state.ts';
import { createVoiceSimulator, scenarioClassifier } from './voice-simulator/simulator.ts';
import type { VoiceSimulator } from './voice-simulator/simulator.ts';
import type { TestProject } from 'vitest/node';

/**
 * The five values {@link setup} hands to every worker through `project.provide`: declared here because the
 * module that provides a value is the module that says what its type is.
 */
declare module 'vitest' {
  export interface ProvidedContext {
    /** `DATABASE_URL` of the PostgreSQL container this run started, migrations applied. */
    databaseUrl: string;
    /** `REDIS_URL` of the Redis container this run started. */
    redisUrl: string;
    /** The Redis container's docker id, which `pauseRedis` and `unpauseRedis` address. */
    redisContainerId: string;
    /** Which Stripe topology this run uses, from the shell's `STRIPE_MODE` (AAP 0.11.2). */
    stripeMode: StripeMode;
    /** The `STRIPE_API_BASE` of the stateful proxy in {@link StripeMode} `mock`, else `null`. */
    stripeApiBase: string | null;
  }
}

/**
 * The two Stripe topologies an integration run may use (AAP 0.11.2): `mock` reaches `stripe-mock` through the
 * stateful proxy started here, so the run needs no credential and its results are mock evidence.
 */
export type StripeMode = 'mock' | 'test';

/**
 * The published nullifier salt the fixture proofs are taken with (AAP 0.5.5), re-exported so a suite that
 * builds an environment, a proof or a key needs one import for the harness.
 */
export { TEST_NULLIFIER_SALT };

/**
 * The image tags this harness starts (AAP 0.4.2), spelled out rather than read from configuration: a container
 * that quietly changed version would invalidate the results the same run recorded.
 */
const POSTGRES_IMAGE = 'postgis/postgis:16-3.4';
const REDIS_IMAGE = 'redis:7.4.12-alpine';
const STRIPE_MOCK_IMAGE = 'stripe/stripe-mock:v0.206.0';

/** The port `stripe-mock` serves HTTP on, and the HTTPS port it also exposes (AAP 0.3.3). */
const STRIPE_MOCK_PORT = 12111;
const STRIPE_MOCK_HTTPS_PORT = 12112;

/** The database the harness creates, and the role that owns it. */
const TEST_DATABASE = 'tablemate_test';
const TEST_DATABASE_USER = 'tablemate';

/**
 * How long a container has to answer a stop. A run that ends with a container still up would hold the port and
 * the disk the next run wants, so the teardown waits rather than detaching.
 */
const CONTAINER_STOP_TIMEOUT_S = 20;

/** The most of a migration run's output this file keeps, for the failure it reports. */
const MIGRATION_OUTPUT_LIMIT = 4_000;

/** How long Redis has to answer `PING` after {@link unpauseRedis} unpauses it. */
const REDIS_PING_TIMEOUT_MS = 10_000;

/** The schema of the database role's password: hex, so it needs no escaping in a connection URL. */
const PASSWORD_BYTES = 16;

/** A whole secret: 32 bytes, which an HMAC-SHA256 key and an AES-256-GCM key both take. */
const SECRET_BYTES = 32;

/**
 * The tables `resetState` leaves in place: Prisma's migration bookkeeping and PostGIS's SRID catalog, whose rows
 * the `geography(Point,4326)` casts the spatial queries and every fixture depend on.
 */
const TRUNCATION_EXCLUSIONS: ReadonlySet<string> = new Set([
  '_prisma_migrations',
  'spatial_ref_sys',
]);

/**
 * The shape a table name must have to be interpolated into `TRUNCATE`, so a name that reached the statement from
 * anywhere outside this harness's own database cannot.
 */
const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * How many times {@link truncatePublicTables} takes the tables again after losing a lock race, and how long each
 * retry waits, growing linearly (AAP 0.11.2).
 */
const TRUNCATE_ATTEMPTS = 5;
const TRUNCATE_RETRY_MS = 25;

/**
 * The SQLSTATEs of a lock conflict a retry clears: a deadlock, and a serialization failure. PostgreSQL ended one
 * of two transactions for taking each other's locks; the other finishes within milliseconds and the statement
 * succeeds on the next attempt.
 */
const TRANSIENT_SQL_STATES: ReadonlySet<string> = new Set(['40P01', '40001']);

/**
 * The instant a suite starts at (AAP 0.11.1): a Monday at midday UTC, so a suite that reasons about a weekday, a
 * city's local day or a date's month reads the same value wherever it runs.
 */
export const DEFAULT_TEST_NOW = '2026-11-16T12:00:00.000Z';

/**
 * The `API_PORT` a test process declares. The app never binds it — `listen` asks the kernel for a free port — but
 * the variable is required and must be a usable port number, so it holds one rather than 0.
 */
const TEST_API_PORT = '3000';

/**
 * The secrets one test process signs, hashes and encrypts with: generated with `node:crypto` at run time and
 * memoized, so no key appears in tracked source and two apps built in one file share the same values.
 */
interface TestSecrets {
  readonly JWT_SECRET: string;
  readonly EMAIL_LOOKUP_PEPPER: string;
  readonly EXPERIMENT_SALT: string;
  readonly ANALYTICS_SALT: string;
  readonly FIELD_ENCRYPTION_KEY: string;
  readonly FIELD_ENCRYPTION_KEY_ID: string;
  readonly TEST_CONTROL_TOKEN: string;
}

/**
 * The values the environment schema accepts: the four salts and secrets as at least 32 characters (base64url of
 * {@link SECRET_BYTES} is 43), and the field key as standard base64 of exactly 32 bytes, the one encoding
 * `keyringFromEnv` takes.
 */
const TEST_FIELD_KEY_ID = 'test1';

/** The terms version a test process runs with, so a suite compares against `env.TERMS_VERSION`. */
const TEST_TERMS_VERSION = '2026-11-test';

/** The three variables `STRIPE_MODE=test` needs, and the only ones it reads from the shell. */
const STRIPE_MODE_TEST_VARIABLES = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
] as const;

/**
 * The reserved fictional ranges AAP 0.5.2 writes the fixture phone numbers in: three hundred complete
 * E.164 numbers, in the `+1 <area> 555 01xx` block that no numbering authority assigns.
 */
const FIXTURE_NUMBER_PREFIXES = ['+120255501', '+131255501', '+141555501'] as const;

/** The per-process secrets, built on the first call and never rebuilt. */
let cachedSecrets: TestSecrets | undefined;

/** The secrets of this process, generated once and handed to every app it builds. */
function testSecrets(): TestSecrets {
  cachedSecrets ??= {
    JWT_SECRET: randomBytes(SECRET_BYTES).toString('base64url'),
    EMAIL_LOOKUP_PEPPER: randomBytes(SECRET_BYTES).toString('base64url'),
    EXPERIMENT_SALT: randomBytes(SECRET_BYTES).toString('base64url'),
    ANALYTICS_SALT: randomBytes(SECRET_BYTES).toString('base64url'),
    FIELD_ENCRYPTION_KEY: randomBytes(SECRET_BYTES).toString('base64'),
    FIELD_ENCRYPTION_KEY_ID: TEST_FIELD_KEY_ID,
    TEST_CONTROL_TOKEN: randomBytes(SECRET_BYTES).toString('base64url'),
  };
  return cachedSecrets;
}

/**
 * Every number a test's `CALL_ALLOWLIST` may reach (AAP 0.5.2, 0.6.2): the three hundred reserved fictional
 * numbers the fixtures carry, and nothing else. It is the *only* place these numbers appear as a set, so a number
 * outside the reserved ranges cannot reach a dialler unnoticed.
 */
export function testCallAllowlist(): string {
  const numbers: string[] = [];
  for (const prefix of FIXTURE_NUMBER_PREFIXES) {
    for (let suffix = 0; suffix < 100; suffix += 1) {
      numbers.push(`${prefix}${String(suffix).padStart(2, '0')}`);
    }
  }
  return numbers.join(',');
}

/**
 * The variables `api` and `workers` share in a test process (AAP 0.6.2): the endpoints `setup` started, the
 * secrets above, and the credential-free modes the automated suite runs in — `LLM_PROVIDER=fake`, and the
 * simulator posture.
 */
function commonTestEnv(): Record<string, string> {
  return {
    APP_ENV: 'test',
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL: inject('redisUrl'),
    FIELD_ENCRYPTION_KEY: testSecrets().FIELD_ENCRYPTION_KEY,
    FIELD_ENCRYPTION_KEY_ID: testSecrets().FIELD_ENCRYPTION_KEY_ID,
    ANALYTICS_SALT: testSecrets().ANALYTICS_SALT,
    LOG_LEVEL: 'warn',
    LLM_PROVIDER: 'fake',
    TELEPHONY_MODE: 'simulator',
  };
}

/**
 * The raw environment of an `api` process (AAP 0.6.2, 0.11.2): every variable its own schema declares, and no
 * variable belonging to another process. `API_PUBLIC_URL` is the base the Twilio signature is computed over — the
 * URL Twilio would have called, not the loopback address the app listens on; in `STRIPE_MODE=mock` it is the
 * proxy's address and no key is set at all.
 */
export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const mode = inject('stripeMode');
  const proxyUrl = inject('stripeApiBase');
  const secrets = testSecrets();
  const env: Record<string, string> = {
    ...commonTestEnv(),
    JWT_SECRET: secrets.JWT_SECRET,
    EMAIL_LOOKUP_PEPPER: secrets.EMAIL_LOOKUP_PEPPER,
    EXPERIMENT_SALT: secrets.EXPERIMENT_SALT,
    TEST_CONTROL_TOKEN: secrets.TEST_CONTROL_TOKEN,
    ZK_ALLOW_TEST_ISSUER: 'true',
    NULLIFIER_SALT: TEST_NULLIFIER_SALT,
    API_PORT: TEST_API_PORT,
    API_PUBLIC_URL: 'https://api.tablemate.test',
    WEB_ORIGIN: 'http://web.tablemate.test',
    VENUE_CONSOLE_ORIGIN: 'http://console.tablemate.test',
    ARTIFACTS_BASE_URL: 'http://artifacts.tablemate.test',
    TERMS_VERSION: TEST_TERMS_VERSION,
  };
  if (mode === 'mock') {
    if (proxyUrl === null) {
      throw new Error(
        'STRIPE_MODE=mock holds no proxy address: run the suite through its globalSetup',
      );
    }
    env['STRIPE_MODE'] = 'mock';
    env['STRIPE_API_BASE'] = proxyUrl;
  } else {
    env['STRIPE_MODE'] = 'test';
    for (const name of STRIPE_MODE_TEST_VARIABLES) {
      copyFromProcessEnv(env, name);
    }
  }
  return applyOverrides(env, overrides);
}

/**
 * The raw environment of a `workers` process (AAP 0.6.2, 0.11.2): the shared group, the delivery and crawl
 * settings, and no Stripe variable in any mode. `VOICE_SIM_URL` is a name that is never dialled: a `workers` suite
 * injects the simulator's own transport, so the variable satisfies the mode's startup rule.
 */
export function testWorkersEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return applyOverrides(
    {
      ...commonTestEnv(),
      API_PUBLIC_URL: 'https://api.tablemate.test',
      WEB_ORIGIN: 'http://web.tablemate.test',
      VOICE_SIM_URL: 'http://voice-sim.tablemate.test',
      SMTP_URL: 'smtp://127.0.0.1:1025',
      EMAIL_FROM: 'Tablemate <no-reply@tablemate.test>',
      CRAWLER_CONTACT_URL: 'https://tablemate.test/bot',
      CALL_ALLOWLIST: testCallAllowlist(),
    },
    overrides,
  );
}

/** Set `name` from the surrounding environment when it carries a value; an unset one stays absent. */
function copyFromProcessEnv(env: Record<string, string>, name: string): void {
  const value = process.env[name];
  if (value !== undefined && value !== '') {
    env[name] = value;
  }
}

/**
 * Apply a suite's overrides: each value it names wins, and an empty string removes the variable so the case that
 * needs one absent runs against the loader's own refusal.
 */
function applyOverrides(
  env: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string> {
  const merged = { ...env };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === '') {
      delete merged[name];
    } else {
      merged[name] = value;
    }
  }
  return merged;
}

/*
 * The handles `setup` keeps for `teardown`: what the one globalSetup call created, and nothing a worker imports
 * this module for ever reads.
 */
let startedPostgres: StartedPostgreSqlContainer | undefined;
let startedRedis: StartedRedisContainer | undefined;
let startedStripeMock: StartedTestContainer | undefined;
let runningProxy: StripeProxy | undefined;

/**
 * Start the containers, apply the migrations and publish the five values every worker reads. Vitest runs this once
 * per run, in its main process, so the containers and the proxy are created once and shared. The database role's
 * password is generated here and never logged — a connection string is a secret a log line must not carry
 * (AAP 0.11.1).
 */
export async function setup(project: TestProject): Promise<void> {
  const mode: StripeMode = process.env['STRIPE_MODE'] === 'test' ? 'test' : 'mock';
  if (mode === 'test') {
    assertStripeTestCredentials();
  }
  const postgres = new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(TEST_DATABASE)
    .withUsername(TEST_DATABASE_USER)
    .withPassword(randomBytes(PASSWORD_BYTES).toString('hex'));
  const redis = new RedisContainer(REDIS_IMAGE);
  const stripeMock =
    mode === 'mock'
      ? new GenericContainer(STRIPE_MOCK_IMAGE)
          .withExposedPorts(STRIPE_MOCK_PORT, STRIPE_MOCK_HTTPS_PORT)
          .withWaitStrategy(Wait.forListeningPorts())
      : null;
  const [database, cache, mock] = await Promise.all([
    postgres.start(),
    redis.start(),
    stripeMock === null ? Promise.resolve(null) : stripeMock.start(),
  ]);
  startedPostgres = database;
  startedRedis = cache;
  startedStripeMock = mock ?? undefined;
  // The proxy runs in this process, not in a container of its own: it owns one state per server, and
  // the API under test is its only client.
  runningProxy =
    mode === 'mock' && mock !== null
      ? await startStripeProxy({
          port: 0,
          upstream: `http://${mock.getHost()}:${mock.getMappedPort(STRIPE_MOCK_PORT)}`,
        })
      : undefined;
  const databaseUrl = database.getConnectionUri();
  await migrate(databaseUrl);
  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', cache.getConnectionUrl());
  project.provide('redisContainerId', cache.getId());
  project.provide('stripeMode', mode);
  project.provide('stripeApiBase', runningProxy?.url ?? null);
}

/**
 * Close the proxy and stop the containers, tolerating one that is already gone. Idempotent on purpose: Vitest calls
 * it after a run that may have failed at any point, and a teardown that threw would leave containers running.
 */
export async function teardown(): Promise<void> {
  const proxy = runningProxy;
  runningProxy = undefined;
  if (proxy !== undefined) {
    await proxy.close();
  }
  const containers = [startedStripeMock, startedRedis, startedPostgres];
  startedStripeMock = undefined;
  startedRedis = undefined;
  startedPostgres = undefined;
  for (const container of containers) {
    if (container !== undefined) {
      await stopContainer(container);
    }
  }
}

/**
 * Freeze the Redis container, so every command issued against it stops being answered (AAP 0.11.2). This is how
 * `rate-limits.test.ts` produces the outage AAP 0.3.2 requires the API to answer `503 service_unavailable` for: the
 * socket stays open and nothing answers, which a stopped container does not reproduce.
 *
 * **Callers must unpause in a `finally`.** The container is shared by the whole run.
 */
export async function pauseRedis(): Promise<void> {
  const container = await redisDockerContainer();
  await container.pause();
}

/**
 * Unfreeze the Redis container and wait until it answers `PING` (AAP 0.11.2). The wait is what makes the call safe
 * to sequence on: a paused container answers nothing, so a suite that resumed it and immediately issued a command
 * would race the runtime's own unpause.
 */
export async function unpauseRedis(): Promise<void> {
  const container = await redisDockerContainer();
  try {
    await container.unpause();
  } catch (error) {
    // A container that was never paused is already in the state this function establishes, and a
    // suite that calls this from a `finally` should not have to know whether its own `pauseRedis`
    // ran. Every other failure is rethrown: the postcondition — Redis answering — is verified below,
    // so a container that really could not be resumed fails here rather than silently.
    if (!/is not paused/.test(String(error))) {
      throw error;
    }
  }
  await awaitRedisPing();
}

/** The docker container `setup` started for Redis, addressed by the id it provided. */
async function redisDockerContainer() {
  const client = await getContainerRuntimeClient();
  return client.container.getById(inject('redisContainerId'));
}

/**
 * Wait until Redis answers `PING` on a connection of its own. A command issued before a fail-fast connection
 * reached `ready` is refused rather than queued, so the readiness wait comes first and the ping after it.
 */
async function awaitRedisPing(): Promise<void> {
  const connection = createRedisConnection(inject('redisUrl'), 'client', {
    logger: createLogger({ name: 'api', level: 'silent', appEnv: 'test' }),
  });
  try {
    await waitForRedisReady(connection, REDIS_PING_TIMEOUT_MS);
    await connection.ping();
  } finally {
    connection.disconnect();
  }
}

/**
 * Stop one container, ignoring a failure to stop what is already stopped: the failure cannot be told from a real
 * one by its message, and the runtime's own clean-up reports a container left behind.
 */
async function stopContainer(container: StartedTestContainer): Promise<void> {
  try {
    await container.stop({ timeout: CONTAINER_STOP_TIMEOUT_S });
  } catch {
    // Already stopped or removed: the teardown proceeds to the containers after it.
  }
}

/**
 * Apply the repository's migrations to the container database (AAP 0.6.2). The package script is what runs, rather
 * than a Prisma call issued from here: it is the one definition of "apply the migrations".
 */
async function migrate(databaseUrl: string): Promise<void> {
  try {
    await execFileAsync('pnpm', ['--filter', '@tablemate/db', 'migrate:deploy'], {
      cwd: findRepoRoot(),
      env: { ...process.env, DATABASE_URL: databaseUrl, CI: 'true' },
      maxBuffer: MIGRATION_OUTPUT_LIMIT,
    });
  } catch (error) {
    throw new Error(`prisma migrate deploy failed: ${migrationFailure(error)}`);
  }
}

/** `execFile` as a promise-returning function, so the migration run can be awaited and reported. */
const execFileAsync = promisify(execFile);

/**
 * What a failed migration run said, with the one hint worth adding: a missing generated client is the likeliest
 * failure that is not about the database itself, and its message does not name the command that fixes it.
 */
function migrationFailure(error: unknown): string {
  const output = errorOutput(error);
  return /@prisma\/client|did not initialize/i.test(output)
    ? `${output} (run pnpm db:generate)`
    : output;
}

/** The most useful text one failed child produced: its stderr, else its stdout, else its message. */
function errorOutput(error: unknown): string {
  const candidate: unknown = error;
  if (typeof candidate !== 'object' || candidate === null) {
    return String(candidate);
  }
  const { stderr, stdout, message } = candidate as {
    stderr?: unknown;
    stdout?: unknown;
    message?: unknown;
  };
  const text = [stderr, stdout, message].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  return text === undefined ? 'no output' : text.trim().slice(-MIGRATION_OUTPUT_LIMIT);
}

/**
 * Refuse to start a `STRIPE_MODE=test` run that could not reach Stripe, naming the variables only: without the keys
 * every payment assertion would pass vacuously. The values are read by the child that runs the API and are never
 * logged.
 */
function assertStripeTestCredentials(): void {
  const missing = STRIPE_MODE_TEST_VARIABLES.filter((name) => {
    const value = process.env[name];
    return value === undefined || value === '';
  });
  const secretKey = process.env['STRIPE_SECRET_KEY'];
  const wrongPrefix =
    secretKey !== undefined &&
    !missing.includes('STRIPE_SECRET_KEY') &&
    !secretKey.startsWith('sk_test_');
  const findings: string[] = [];
  if (missing.length > 0) {
    findings.push(`not set: ${missing.join(', ')}`);
  }
  if (wrongPrefix) {
    findings.push('STRIPE_SECRET_KEY does not start with sk_test_');
  }
  if (findings.length > 0) {
    throw new Error(
      `STRIPE_MODE=test needs the operator's test-mode keys (${findings.join('; ')})`,
    );
  }
}

/** The interface a test app listens on: loopback only, so no suite is reachable from outside the host. */
const LISTEN_HOST = '127.0.0.1';

/**
 * What a suite may replace when it builds an app (AAP 0.5.1, 0.11.2). Every member is optional: the default is the
 * real thing, which is what makes a suite that passes here exercise production's path.
 */
export interface CreateTestAppOptions {
  /**
   * Raw environment overrides, applied over {@link testEnv}: each value wins, and an empty string removes the
   * variable, so a case runs against the loader's own refusal.
   */
  readonly env?: Record<string, string>;
  /** The clock to inject; a frozen `TestClock` at {@link DEFAULT_TEST_NOW} unless given (AAP 0.11.1). */
  readonly clock?: TestClock;
  /** The language model to inject; the `fake` adapter with `scenarioClassifier` unless given. */
  readonly llm?: LlmAdapter;
  /** The payments gateway to inject; the Stripe one, pointed at the proxy, unless given. */
  readonly payments?: PaymentsGateway;
  /**
   * Whether to start the API's background work — the settlement worker, the sweeper, the outbox poller and the
   * pub/sub subscriptions (AAP 0.3.2). Off by default, because a suite that drives its own timers through
   * `./clock.ts` `settleNow` reads a deterministic result.
   */
  readonly background?: boolean;
}

/**
 * The Stripe topology a suite drives (AAP 0.3.3, 0.11.2). `proxy` is the control client for the stateful proxy —
 * present in `mock` mode only, which is why a suite that needs a card fixture, a 3-D Secure step or an expired
 * hold checks it first. `webhookSecret` is the secret that topology's signed webhooks are built with.
 */
export interface StripeContext {
  readonly mode: StripeMode;
  /** The stateful proxy's address in `mock` mode; `null` in `test` mode, which reaches Stripe's API. */
  readonly apiBase: string | null;
  readonly webhookSecret: string;
  /** The proxy's control client in `mock` mode; `null` otherwise. */
  readonly proxy: ProxyControl | null;
}

/**
 * Who an access token is signed for. `id` and `sessionId` are row ids, which is what the token's `sub` and `sid`
 * claims carry; `role` defaults to a traveler, the role of every fixture account.
 */
export interface TokenSubject {
  readonly id: string;
  readonly sessionId: string;
  readonly role?: UserRole;
}

/**
 * The app one suite drives (AAP 0.11.2): the app itself plus the handles around it — the container it reads state
 * through, the clock it moves, the boundary helpers, the fault injector, the simulator and the adapter it inspects.
 * The members are the real objects, not copies.
 */
export interface TestApp {
  /** The Fastify instance, ready but not listening until {@link TestApp.listen} is called. */
  readonly app: App;
  /** The container of `app.services` (AAP 0.5.1): the client, connections, queues and caches. */
  readonly services: AppServices;
  /** The injected clock, which {@link TestApp.time} moves (AAP 0.11.1). */
  readonly clock: TestClock;
  /** The helpers that name a meetup's boundaries and run one settlement pass (AAP 0.5.3). */
  readonly time: ClockHelpers;
  /** The injector the crash and interruption cases throw from (AAP 0.11.2). */
  readonly faults: TestFaults;
  /** The adapter the API was built with: the factory's own fake, or the one the suite injected. */
  readonly llm: LlmAdapter;
  /** The scripted telephony simulator whose transport the telephony client was built on. */
  readonly simulator: VoiceSimulator;
  /** The Stripe topology, and the proxy control client in mock mode. */
  readonly stripe: StripeContext;
  /** The validated configuration, read through the real loader (AAP 0.6.2). */
  readonly env: ApiEnv;
  /** The raw environment the loader was given, overrides applied — what a config assertion reads. */
  readonly rawEnv: Readonly<Record<string, string>>;
  /**
   * Listen on an ephemeral loopback port, point the simulator at the address, and answer it. Idempotent: a second
   * call answers the same address, which a suite that starts a WebSocket and then makes an HTTP request relies on.
   */
  listen(): Promise<string>;
  /**
   * Close the simulator and the app, once. The app's close hook stops the background work when it was started,
   * closes the queues and the pub/sub, and disconnects the Prisma client and the Redis connections.
   */
  close(): Promise<void>;
  /**
   * Return the run to the state a fresh database would have: every table empty, Redis flushed, the fake adapter's
   * records cleared, the simulator idle, no fault armed, the clock back at {@link DEFAULT_TEST_NOW}, and the
   * proxy's state cleared in mock mode.
   *
   * The tables come from the catalog, so a migration that adds one is covered without this file changing; it is a
   * reset between cases, not a repair.
   */
  resetState(): Promise<void>;
  /** Seed the five launch cities, and nothing of the fixtures (AAP 0.5.2, 0.12.1 criterion 9). */
  seedCities(): Promise<SeedSummary>;
  /**
   * Seed the launch cities and each city's fixtures: venues, lodgings, places and price records, all flagged
   * `is_fixture`, with one console secret per venue and lodging in the summary rather than in a file.
   */
  seedFixtures(): Promise<SeedSummary>;
  /**
   * Sign an access token for `user` as the current test clock reads it. The token lives 15 minutes of that clock, so
   * a suite that advances past the boundary signs a new one — a call before it answers `401 token_invalid`, which is
   * the API's own rule.
   */
  tokenFor(user: TokenSubject): Promise<string>;
}

/**
 * Build one app against the containers `setup` started (AAP 0.5.1, 0.11.2). The environment goes through
 * `loadApiEnv` and the app through `buildApp`, so a configuration mistake fails as it fails in production, and
 * everything but the clock, the language model, the payments gateway and the Twilio transport is the real
 * dependency. `app.ready()` resolves every route before the promise settles.
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  const rawEnv: Readonly<Record<string, string>> = testEnv(options.env ?? {});
  const env = loadApiEnv(rawEnv);
  const clock =
    options.clock ?? createTestClock({ start: new Date(DEFAULT_TEST_NOW), mode: 'frozen' });
  const faults = createFaultInjector();
  // The simulator stamps the resources it reports — a call's `date_created`, a callback's order — and
  // filters a listing by `StartTime>` with the clock it is given, so it is handed the app's own clock
  // rather than reading the wall clock: a suite that advances the clock past a dispatch then reads a
  // listing that agrees with it (AAP 0.11.1).
  const simulator = createVoiceSimulator({
    apiPublicUrl: env.API_PUBLIC_URL,
    now: () => clock.now(),
  });
  // The adapter the factory built is remembered so `resetState` can clear its records; an adapter a
  // suite injected is that suite's, and its records are its own to reset.
  let ownedLlm: FakeLlmAdapter | null = null;
  let llm: LlmAdapter;
  if (options.llm === undefined) {
    ownedLlm = createFakeLlmAdapter({ respond: scenarioClassifier });
    llm = ownedLlm;
  } else {
    llm = options.llm;
  }
  const app = buildApp({
    env,
    clock,
    llm,
    faults,
    twilioHttpClient: simulator.httpClient,
    ...(options.payments === undefined ? {} : { payments: options.payments }),
  });
  await app.ready();
  if (options.background === true) {
    await startBackground(app);
  }
  const services = app.services;
  const stripe = stripeContext(env);
  const time = clockHelpers(clock);
  let listeningUrl: string | null = null;
  let closed = false;
  async function listen(): Promise<string> {
    const url = listeningUrl ?? (await app.listen({ host: LISTEN_HOST, port: 0 }));
    listeningUrl = url;
    simulator.setTarget(url);
    return url;
  }
  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    simulator.close();
    await app.close();
  }
  async function resetState(): Promise<void> {
    await truncatePublicTables(services.db);
    // The `client` role's connection is fail-fast: a command issued before it reached `ready` is
    // rejected rather than queued, which is the contract `createRedisConnection` states and what a
    // suite that resets state as its first action would otherwise meet.
    await waitForRedisReady(services.redis.client);
    await services.redis.client.flushdb();
    if (ownedLlm !== null) {
      ownedLlm.calls.counted.length = 0;
      ownedLlm.calls.sent.length = 0;
    }
    simulator.reset();
    faults.disarm();
    clock.reset();
    if (stripe.proxy !== null) {
      await stripe.proxy.reset();
    }
  }
  async function seed(fixtures: boolean): Promise<SeedSummary> {
    return runSeed({
      db: services.db,
      appEnv: 'test',
      keyring: services.keyring,
      clock,
      fixtures,
      secretsOutPath: null,
    });
  }
  function tokenFor(user: TokenSubject): Promise<string> {
    return signAccessToken(services, {
      sub: user.id,
      role: user.role ?? 'traveler',
      sid: user.sessionId,
    });
  }
  return {
    app,
    services,
    clock,
    time,
    faults,
    llm,
    simulator,
    stripe,
    env,
    rawEnv,
    listen,
    close,
    resetState,
    seedCities: () => seed(false),
    seedFixtures: () => seed(true),
    tokenFor,
  };
}

/**
 * The Stripe topology the loaded environment names (AAP 0.3.3). The mode is the environment's, not the provided one:
 * the gateway is built from `env.stripe`, so a suite that overrode `STRIPE_MODE` would be told about a topology the
 * app is not using.
 */
function stripeContext(env: ApiEnv): StripeContext {
  const mode: StripeMode = env.stripe.mode === 'mock' ? 'mock' : 'test';
  const apiBase = mode === 'mock' ? inject('stripeApiBase') : null;
  return {
    mode,
    apiBase,
    webhookSecret: env.stripe.webhookSecret,
    proxy: apiBase === null ? null : proxyControl(apiBase),
  };
}

/**
 * Empty every table the migrations created, in one statement (AAP 0.11.2). The names come from the catalog, each
 * checked against {@link TABLE_NAME} and quoted before it is interpolated (`name` above all is a reserved word);
 * `CASCADE` covers the foreign keys and `RESTART IDENTITY` returns every sequence to its first value.
 *
 * It is retried while the conflict it lost is a transient one: a commit inside a case kicks the outbox dispatcher
 * without awaiting it (AAP 0.3.2), so a pass that writes `outbox_message` can be in flight when the next case
 * truncates.
 */
async function truncatePublicTables(db: DbClient): Promise<void> {
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;
  const tables = rows
    .map((row) => row.tablename)
    .filter((name) => TABLE_NAME.test(name) && !TRUNCATION_EXCLUSIONS.has(name));
  if (tables.length === 0) {
    return;
  }
  const identifiers = Prisma.join(tables.map((name) => Prisma.raw(`"${name}"`)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await db.$executeRaw(Prisma.sql`TRUNCATE ${identifiers} RESTART IDENTITY CASCADE`);
      return;
    } catch (error) {
      if (attempt >= TRUNCATE_ATTEMPTS || !isTransientLockFailure(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, TRUNCATE_RETRY_MS * attempt));
    }
  }
}

/**
 * Whether a failed statement lost a lock race rather than failing on its own (AAP 0.11.2). Prisma reports a raw
 * PostgreSQL failure as `P2010` with the database's own SQLSTATE in `meta.code`; the message is checked too, so a
 * failure that arrives without the meta object is not mistaken for a permanent one.
 */
function isTransientLockFailure(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  const code = (error.meta as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && TRANSIENT_SQL_STATES.has(code)) {
    return true;
  }
  return [...TRANSIENT_SQL_STATES].some((state) => error.message.includes(`Code: \`${state}\``));
}
