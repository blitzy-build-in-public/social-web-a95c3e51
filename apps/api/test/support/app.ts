/**
 * The integration harness of `apps/api` (AAP 0.8.1 "App factory", AAP 0.11.2): the globalSetup that
 * starts the containers every integration suite shares, and the factory that builds one app against
 * them.
 *
 * Two halves, and the split between them is the whole design:
 *
 *  - `setup` runs once per run in Vitest's main process, so the expensive, process-wide resources are
 *    created once and `provide`d to every worker: PostgreSQL 16 with PostGIS 3.4 (the geography
 *    columns and the GiST indexes of AAP 0.5.2 need the real extension), Redis 7 for the rate-limit
 *    store, the session cache and the queues, and — in `STRIPE_MODE=mock` — `stripe-mock` behind the
 *    stateful proxy of `./stripe-proxy`, so no suite needs a credential. The migrations run once
 *    here too, against the fresh database.
 *  - `createTestApp` runs in a worker and builds what a suite drives: the real environment loader,
 *    the real composition root, the real app. Nothing is stubbed but the three dependencies AAP 0.11.2
 *    names as injectable — the clock, the language model and the Twilio transport — so a suite that
 *    passes here exercises the code path production runs.
 *
 * The values are read lazily, inside the functions that need them, and only `setup` touches
 * infrastructure: importing this module has no side effect, which is what lets a test worker import
 * the factory without starting a container, and what lets `apps/api/scripts/*` reuse the environment
 * builders without a Vitest context at all.
 *
 * Three properties the suites rely on, each stated where it is implemented: the secrets are generated
 * once per process at run time, so two apps in one file share one signing key and one field keyring
 * and a token or a ciphertext crosses between them (so no key ever appears in tracked source, which
 * `scripts/check-secrets.ts` enforces); the clock is a frozen `TestClock` at {@link DEFAULT_TEST_NOW},
 * moved only through `./clock.ts`, so the windows of AAP 0.5.3 are crossable in a tick (AAP 0.11.1);
 * and `resetState` returns the database, Redis, the proxy and the simulator to a state a fresh run
 * would see, so suites are order-independent.
 *
 * @see AAP 0.11.2 for the integration topology (containers, Stripe topology per suite, the voice
 *   simulator, `LLM_PROVIDER=fake`) and the crash cases, 0.6.2 for the environment scopes and the
 *   mode credentials, 0.3.2 for the recovery the harness has to make observable, 0.5.6 for the call
 *   pipeline, 0.5.2 for the fixture guard and the 2,557-day retention default, 0.12.1 for the
 *   criteria these suites measure, and 0.8.1 for this file's place in the inventory.
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

/* The provided context (AAP 0.11.2) */

/**
 * The five values {@link setup} hands to every worker through `project.provide`, and that a suite
 * reads with `inject`. Declared here rather than in a `.d.ts` of its own because the module that
 * provides a value is the module that should say what its type is.
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
 * The two Stripe topologies an integration run may use (AAP 0.11.2).
 *
 * `mock` reaches `stripe-mock` through the stateful proxy started here, so the run needs no
 * credential and its payment results are mock evidence; `test` reaches Stripe's own test API with the
 * operator's `sk_test_` keys, which is what `pnpm test:stripe` is for and the only topology a
 * criterion that asserts a real PaymentIntent may run in.
 */
export type StripeMode = 'mock' | 'test';

/**
 * The published nullifier salt the fixture proofs are taken with (AAP 0.5.5), re-exported so a suite
 * that builds an environment, a proof or a verification key needs one import for the harness.
 */
export { TEST_NULLIFIER_SALT };

/* Constants */

/**
 * The image tags this harness starts (AAP 0.4.2). Spelled out rather than read from configuration: a
 * container that quietly changed version would invalidate the results the same run recorded.
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
 * How long a container has to answer a stop. A run that ends with a container still up would hold the
 * port and the disk the next run wants, so the teardown waits rather than detaching.
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
 * The tables `resetState` leaves in place: Prisma's own migration bookkeeping, and PostGIS's SRID
 * catalog. Truncating the catalog would break the `geography(Point,4326)` casts the spatial queries
 * and every fixture depend on, and the extension's other tables live in schemas of their own, which
 * the truncation does not read.
 */
const TRUNCATION_EXCLUSIONS: ReadonlySet<string> = new Set([
  '_prisma_migrations',
  'spatial_ref_sys',
]);

/**
 * The shape a table name must have to be interpolated into `TRUNCATE`. The catalog of a database only
 * this harness created holds nothing else; the check is here so that a name that reached the statement
 * from anywhere else cannot.
 */
const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * How many times {@link truncatePublicTables} takes the tables again after losing a lock race, and
 * how long each retry waits, growing linearly (AAP 0.11.2).
 */
const TRUNCATE_ATTEMPTS = 5;
const TRUNCATE_RETRY_MS = 25;

/**
 * The SQLSTATEs of a lock conflict a retry clears: a deadlock, and a serialization failure. Both mean
 * two transactions took each other's locks and PostgreSQL ended one of them; the other one finishes
 * within milliseconds and the statement succeeds on the next attempt.
 */
const TRANSIENT_SQL_STATES: ReadonlySet<string> = new Set(['40P01', '40001']);

/**
 * The instant a suite starts at (AAP 0.11.1): a Monday at midday UTC, so a suite that reasons about a
 * weekday, about a city's local day or about a date's month reads the same value wherever it runs. A
 * suite that needs another instant moves the clock — `./proofs.ts` `instantDuringStay`, or
 * `app.time.toMeetupPoint` — rather than rebuilding the app.
 */
export const DEFAULT_TEST_NOW = '2026-11-16T12:00:00.000Z';

/**
 * The `API_PORT` a test process declares. The app never binds it — `listen` asks the kernel for a free
 * port, so two apps in one file cannot collide — but the variable is required and must be a usable
 * port number, so it holds one instead of the 0 a caller might expect to be accepted.
 */
const TEST_API_PORT = '3000';

/* The environment a test process runs in (AAP 0.6.2, 0.11.2) */

/**
 * The secrets one test process signs, hashes and encrypts with. Generated with `node:crypto` at run
 * time and memoized here, so no key ever appears in tracked source — which
 * `scripts/check-secrets.ts` fails the lint on — and so two apps built in one file share the same
 * values: a token one signs verifies on the other, and ciphertext one writes the other decrypts.
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
 * The values the environment schema accepts: the four salts and secrets as at least 32 characters
 * (base64url of {@link SECRET_BYTES} is 43), and the field key as standard base64 of exactly 32 bytes,
 * which is the one encoding `keyringFromEnv` takes.
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
 * Every number a test's `CALL_ALLOWLIST` may reach (AAP 0.5.2, 0.6.2): the three hundred reserved
 * fictional numbers the fixture venues, lodgings and places carry, and nothing else.
 *
 * The allowlist is what keeps an automated call on a host an operator owns when the environment is
 * not production, and it is the *only* place these numbers appear as a set: a fixture file holds the
 * one its row uses, so a number outside the reserved ranges cannot reach a dialler unnoticed.
 *
 * @returns The numbers as the comma-separated value `CALL_ALLOWLIST` carries.
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
 * The variables `api` and `workers` share in a test process (AAP 0.6.2, first scope row): the
 * endpoints `setup` started, the secrets above, and the three credential-free modes the automated
 * suite runs in — `LLM_PROVIDER=fake`, which reads no key, and the simulator posture, whose
 * credentials come from `TWILIO_SIMULATOR` rather than from the environment.
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
 * The raw environment of an `api` process (AAP 0.6.2, 0.11.2): every variable its own schema
 * declares, and no variable belonging to another process.
 *
 * The two origins and the public URL are the harness's own names. `API_PUBLIC_URL` is the base the
 * Twilio signature is computed over — the URL Twilio would have called, which is why it is an
 * `https` name and not the ephemeral loopback address the app really listens on — and a suite that
 * drives Twilio's HTTP callbacks rebuilds the signed URL from it through the simulator.
 *
 * In `STRIPE_MODE=mock` the variable is the stateful proxy's address and no key is set at all, so the
 * gateway is configured with `STRIPE_MOCK_PLACEHOLDERS`; in `STRIPE_MODE=test` the three keys come
 * from the shell, which `setup` has already checked before a worker could be started.
 *
 * @param overrides - Variables to set or, with an empty string, to remove: a suite that needs one
 *   case to run without a variable passes `{ NAME: '' }` rather than rebuilding the builder.
 * @returns The raw environment to hand to `loadApiEnv`.
 * @throws {Error} When the mode is `mock` and this process holds no proxy address, which happens only
 *   when a suite bypassed the project's `globalSetup`.
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
 * The raw environment of a `workers` process (AAP 0.6.2, 0.11.2): the shared group, the delivery and
 * crawl settings, and no Stripe variable in any mode — the schema of that process does not declare
 * one, because `workers` holds no Stripe secret.
 *
 * `VOICE_SIM_URL` is a name that is never dialled: a `workers` integration suite injects the
 * simulator's own transport (`VoiceSimulator.httpClient`) into the client it builds, so what the
 * variable satisfies is the mode's startup rule, not a network destination.
 *
 * @param overrides - Variables to set or, with an empty string, to remove.
 * @returns The raw environment to hand to `loadWorkersEnv`.
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
 * Apply a suite's overrides: each value it names wins, and an empty string removes the variable so
 * the case that needs one absent runs against the loader's own refusal rather than a stand-in.
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

/* The global setup (AAP 0.11.2) */

/*
 * The handles `setup` keeps for `teardown`. Module-level state is limited to exactly this: what the
 * one globalSetup call created, and nothing a worker imports this module for ever reads.
 */
let startedPostgres: StartedPostgreSqlContainer | undefined;
let startedRedis: StartedRedisContainer | undefined;
let startedStripeMock: StartedTestContainer | undefined;
let runningProxy: StripeProxy | undefined;

/**
 * Start the containers, apply the migrations and publish the five values every worker reads.
 *
 * Vitest runs this once per run, in its main process, before any worker starts, so the containers and
 * the proxy are created once and shared: `stripe-proxy` deliberately holds one state per server, which
 * is what a stateful mock has to be.
 *
 * The password of the database role is generated here, hex so it needs no escaping in a connection
 * URL, and never logged — a connection string is a secret a log line must not carry (AAP 0.11.1).
 *
 * @param project - Vitest's project API; only `provide` is called on it.
 * @throws {Error} When `STRIPE_MODE=test` names variables the shell does not set, when a container
 *   cannot start, or when the migrations fail. Each message names the variables or the command and
 *   carries no value.
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
 * Close the proxy and stop the containers, tolerating one that is already gone.
 *
 * Idempotent on purpose: Vitest calls it after a run that may have failed at any point, including
 * before a container had started, and a teardown that threw would leave the containers it did not
 * reach running.
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
 * Freeze the Redis container, so every command issued against it stops being answered (AAP 0.11.2).
 *
 * This is how `rate-limits.test.ts` produces the outage AAP 0.3.2 requires the API to answer
 * `503 service_unavailable` for rather than degrade silently: `@fastify/rate-limit` runs with
 * `skipOnError: false`, so an unreachable store refuses the request. A paused container is the honest
 * form of that outage — the socket stays open and nothing answers, which is what a Redis that stopped
 * responding looks like to a client, and what a stopped container does not reproduce because the
 * connection would be refused outright.
 *
 * **Callers must unpause in a `finally`.** The container is shared by the whole run, so the file that
 * pauses it is the only one that may run while it is paused: its tests run serially and everything
 * after them needs it resumed.
 *
 * @throws {Error} When the runtime client cannot be reached or refuses the command.
 */
export async function pauseRedis(): Promise<void> {
  const container = await redisDockerContainer();
  await container.pause();
}

/**
 * Unfreeze the Redis container and wait until it answers `PING` (AAP 0.11.2).
 *
 * The wait is what makes the call safe to sequence on: a paused container answers nothing, so a suite
 * that resumed it and immediately issued a command would race the runtime's own unpause. The
 * connection used for the probe is one of its own, closed again afterwards, so a connection a suite
 * holds across the pause is left alone.
 *
 * @throws {Error} `redis_not_ready` when Redis has not answered within the wait's bound.
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
 * Wait until Redis answers `PING` on a connection of its own.
 *
 * A command issued before a fail-fast connection reached `ready` is refused rather than queued, which
 * is that connection's documented contract, so the readiness wait comes first and the ping after it.
 * The connection is built with a silent process logger, because a readiness probe records nothing
 * (AAP 0.11.1) — the caller learns of a real failure from the rejection below, not from a line.
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
 * Stop one container, ignoring a failure to stop what is already stopped.
 *
 * The failure cannot be told from a real one by its message, and a teardown is the wrong place to
 * decide it: the runtime's own clean-up and the run's output are what report a container left behind.
 */
async function stopContainer(container: StartedTestContainer): Promise<void> {
  try {
    await container.stop({ timeout: CONTAINER_STOP_TIMEOUT_S });
  } catch {
    // Already stopped or removed: the teardown proceeds to the containers after it.
  }
}

/**
 * Apply the repository's migrations to the container database (AAP 0.6.2).
 *
 * The package script is what runs, rather than a Prisma call issued from here: it is the one
 * definition of "apply the migrations", so a run applies exactly what a deployment does. The
 * container's URL travels in the child's environment, which is how `schema.prisma`'s
 * `env("DATABASE_URL")` reads it, and the rest of the child's environment is inherited so it resolves
 * the same pnpm and the same store as the process that started it.
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
 * What a failed migration run said, with the one hint worth adding.
 *
 * A missing generated client is by far the likeliest failure that is not about the database itself,
 * and the message it produces does not name the command that fixes it: in this workspace
 * `prisma migrate deploy` needs `@prisma/client` generated by a separate step.
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
 * Refuse to start a `STRIPE_MODE=test` run that could not reach Stripe, naming the variables only.
 *
 * Failing here rather than at the first payment is what keeps a test-mode run honest: without the keys
 * the suite would reach nothing, and every payment assertion would pass vacuously. The values are read
 * by the child that runs the API and are never logged, and only their names appear in the message.
 *
 * @throws {Error} Listing the absent variables, and a secret key whose prefix is not the test one.
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

/* The app a suite drives (AAP 0.5.1, 0.11.2) */

/** The interface a test app listens on: loopback only, so no suite is reachable from outside the host. */
const LISTEN_HOST = '127.0.0.1';

/**
 * What a suite may replace when it builds an app (AAP 0.5.1, 0.11.2). Every member is optional: the
 * default is the real thing, which is what makes a suite that passes here exercise production's path.
 */
export interface CreateTestAppOptions {
  /**
   * Raw environment overrides, applied over {@link testEnv}: each value wins, and an empty string
   * removes the variable, so an `env-guard`-style case runs against the loader's own refusal.
   */
  readonly env?: Record<string, string>;
  /** The clock to inject; a frozen `TestClock` at {@link DEFAULT_TEST_NOW} unless given (AAP 0.11.1). */
  readonly clock?: TestClock;
  /** The language model to inject; the `fake` adapter with `scenarioClassifier` unless given. */
  readonly llm?: LlmAdapter;
  /** The payments gateway to inject; the Stripe one, pointed at the proxy, unless given. */
  readonly payments?: PaymentsGateway;
  /**
   * Whether to start the API's background work — the settlement worker, the sweeper, the outbox poller
   * and the pub/sub subscriptions (AAP 0.3.2). Off by default, because a suite that drives its own
   * timers through `./clock.ts` `settleNow` reads a deterministic result, and a background pass that
   * settled a meetup first would make it ambiguous which run did.
   */
  readonly background?: boolean;
}

/**
 * The Stripe topology a suite drives (AAP 0.3.3, 0.11.2).
 *
 * `mode` and `apiBase` mirror the two values `setup` provided, and `proxy` is the control client for
 * the stateful proxy — present in `mock` mode only, which is why a suite that needs a card fixture, a
 * 3-D Secure step or an expired hold checks it before using it. `webhookSecret` is the secret the
 * signed webhook requests of that topology are built with: the mock's own placeholder in `mock` mode,
 * and the operator's `whsec_` value in `test` mode.
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
 * Who an access token is signed for. `id` and `sessionId` are row ids, which is what the token's `sub`
 * and `sid` claims carry; `role` defaults to a traveler, the role of every fixture account.
 */
export interface TokenSubject {
  readonly id: string;
  readonly sessionId: string;
  readonly role?: UserRole;
}

/**
 * The app one suite drives (AAP 0.11.2).
 *
 * It is the app itself plus the handles a suite needs around it: the container it reads state through,
 * the clock it moves, the helpers that name a meetup's boundaries, the fault injector it arms, the
 * simulator it plays calls with, the injected adapter it inspects, and the lifecycle methods below. The
 * members are the real objects — `services` is the container the app decorated, not a copy — so a suite
 * asserts against exactly what a handler wrote.
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
   * Listen on an ephemeral loopback port, point the simulator at the address, and answer it.
   *
   * Idempotent: a second call answers the same address, which is what a suite that starts a WebSocket
   * and then makes an HTTP request relies on. The simulator is re-pointed on every call, so an app
   * rebuilt against the same simulator cannot be left aimed at an address that stopped listening.
   */
  listen(): Promise<string>;
  /**
   * Close the simulator and the app, once. The app's own close hook stops the background work when it
   * was started, closes the queues and the pub/sub, and disconnects the Prisma client and the Redis
   * connections this app built.
   */
  close(): Promise<void>;
  /**
   * Return the run to the state a fresh database would have: every table empty, Redis flushed, the fake
   * adapter's records cleared, the simulator idle and disarmed of scenarios, no fault armed, the clock
   * back at {@link DEFAULT_TEST_NOW}, and the proxy's state cleared in mock mode.
   *
   * The tables are read from the catalog rather than listed here, so a migration that adds one is
   * covered without this file changing, and two of them are deliberately left in place: Prisma's
   * migration bookkeeping, and PostGIS's SRID catalog, whose rows the `geography` casts need.
   *
   * It is a reset between cases, not a repair: call it before the app has done the work a case reads,
   * and never while its background work is running — an app built with `background: true` has a
   * sweeper and an outbox poller of its own, and truncating under them would decide a race the suite
   * meant to observe.
   */
  resetState(): Promise<void>;
  /** Seed the five launch cities, and nothing of the fixtures (AAP 0.5.2, 0.12.1 criterion 9). */
  seedCities(): Promise<SeedSummary>;
  /**
   * Seed the launch cities and each city's fixtures: venues, lodgings, places and price records, all
   * flagged `is_fixture`, with one console secret per venue and lodging in the summary.
   *
   * No secret file is written: the summary carries the secrets, which is what a test needs, and the
   * `.local/fixture-secrets.json` a demo uses belongs to the seed CLI.
   */
  seedFixtures(): Promise<SeedSummary>;
  /**
   * Sign an access token for `user` as the current test clock reads it.
   *
   * The token lives 15 minutes of that clock, so a suite that advances past the boundary signs a new
   * one — a call before it answers `401 token_invalid`, which is the API's own rule and not a harness
   * failure. The token's role claim is a hint: the API reads the account's role from its row (AAP 0.3.3).
   */
  tokenFor(user: TokenSubject): Promise<string>;
}

/**
 * Build one app against the containers `setup` started (AAP 0.5.1, 0.11.2).
 *
 * The environment goes through `loadApiEnv` and the app through `buildApp`, so a configuration mistake
 * fails exactly as it fails in production, and everything but the clock, the language model, the
 * payments gateway and the Twilio transport is the real dependency: the Prisma client built from the
 * container's URL, the app's own Redis connections, and the queues the API enqueues to.
 *
 * `app.ready()` resolves every route and loads every plugin before the promise settles, so a suite
 * never races the app's own start-up, and the app is left not listening: a suite that needs an address
 * calls {@link TestApp.listen}, and one that only injects requests never binds a port at all.
 *
 * @param options - What to replace; every member defaults to the real thing.
 * @returns The app and the handles described on {@link TestApp}.
 * @throws EnvValidationError when the environment is unusable, and whatever `buildApp` or a plugin
 *   throws while the routes are resolved.
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
 * The Stripe topology the loaded environment names (AAP 0.3.3).
 *
 * The mode is the environment's, not the provided one: the gateway is built from `env.stripe`, so a
 * suite that overrode `STRIPE_MODE` would otherwise be told about a topology the app is not using. A
 * `mock` run reads the proxy address of this run's globalSetup, which is what makes the control client
 * available to the suite.
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
 * Empty every table the migrations created, in one statement (AAP 0.11.2).
 *
 * The names come from the catalog, and each one is checked against {@link TABLE_NAME} and quoted before
 * it is interpolated: `name` above all is a reserved word, so an unquoted identifier would be a syntax
 * error, and a name that failed the shape check could only have come from outside this database.
 * `CASCADE` covers the foreign keys between the tables, `RESTART IDENTITY` returns every sequence to
 * its first value, and both belong here rather than a delete per table — a suite that resets state
 * should not have to know the schema's order or its keys.
 *
 * It is retried while the conflict it lost is a transient one. A commit inside a case kicks the outbox
 * dispatcher without awaiting it (AAP 0.3.2), so a pass that writes `outbox_message` can still be in
 * flight when the next case truncates: PostgreSQL ends one of the two, and a reset that gave up there
 * would fail a case for a race it is not about (AAP 0.11.2).
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
 * Whether a failed statement lost a lock race rather than failing on its own (AAP 0.11.2).
 *
 * Prisma reports a raw PostgreSQL failure as `P2010` with the database's own SQLSTATE in `meta.code`,
 * which is where {@link TRANSIENT_SQL_STATES} appear. The message is checked too, so a failure that
 * arrives without the meta object is not mistaken for a permanent one.
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
