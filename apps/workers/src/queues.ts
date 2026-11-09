/**
 * The worker process's queue module (AAP 0.5.1, 0.5.6): the `WorkerContext` every job reads its collaborators from,
 * the table that maps a queue and a job name to its processor, and the BullMQ `Worker` instances
 * `apps/workers/src/main.ts` starts.
 *
 * Every queue but settlement: `WORKER_QUEUES` is server-core's list of the queues this process consumes, and
 * `settlement` is absent because the API settles meetups in the one process holding the payment secret (AAP 0.3.2).
 * One connection per role: each `Worker` gets its own `worker`-role connection, the producers share one `producer`
 * connection opened on the first `add`, and the `client` connection serves the caches, the per-domain throttle, the
 * robots cache and the spend meter's suspension flag. Every job is validated at the boundary: a job name this queue
 * does not accept, or data that does not satisfy that name's schema, fails once as an `UnrecoverableError` instead of
 * being retried against a fault no retry can fix, while every other failure propagates — which is what asks BullMQ
 * for the retry the queue's job options promise — and every handler is idempotent so a retry repeats no effect.
 * Ownership is explicit: `createWorkerContext` builds the collaborators a job needs and records which it built, and
 * `closeWorkerContext` closes those and only those.
 *
 * Time comes only from `ctx.clock`, and no error is logged by its own message: these listeners span the menu,
 * telephony, mail and database clients alike, so a failure is recorded as a bounded token. Every `jobs/*.ts` imports
 * `WorkerContext` from this file type-only, while this file value-imports each job's `process`; never add a value
 * import of this file to a job.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { createPrismaClient, type DbClient } from '@tablemate/db';
import {
  JOB,
  QUEUE,
  QUEUE_JOB_OPTIONS,
  QueuePayloadError,
  WORKER_QUEUES as CONSUMED_QUEUE_NAMES,
  createCallGuard,
  createLlmAdapter,
  createLlmSpend,
  createLogger,
  createRedisConnection,
  createRedisSuspensionStore,
  createSqlSpendStore,
  createTelephonyClient,
  keyringFromEnv,
  reportRedisUnavailable,
  systemClock,
  throttleRedisFailure,
  withJobId,
} from '@tablemate/server-core';
import type {
  CallGuard,
  Clock,
  FieldKeyring,
  LlmAdapter,
  LlmAdapterConfig,
  LlmSpend,
  Logger,
  QueueName,
  TelephonyClient,
  TwilioHttpClient,
  WorkersEnv,
} from '@tablemate/server-core';
import { CitiesFile } from '@tablemate/shared';

import { findRepoRoot, loadBlocklist, type Blocklist } from './menus/blocklist.ts';
import { createDomainPolicy, createPrismaCrawlPolicyStore } from './menus/crawl-policy.ts';
import { createDomainThrottle } from './menus/domain-throttle.ts';
import { createBrowserProvider, type BrowserProvider } from './menus/fetch-page.ts';
import { createRedisRobotsCache } from './menus/robots.ts';
import { createSafeFetch, type LookupFn, type SafeFetch } from './menus/safe-fetch.ts';
import { createMailer, type Mailer } from './notify/email.ts';
import { createPushSender, type PushSender } from './notify/push.ts';

import { process as accountErasure } from './jobs/account-erasure.ts';
import { process as callDispatch } from './jobs/call-dispatch.ts';
import { process as callResults } from './jobs/call-results.ts';
import { process as dataExpiry } from './jobs/data-expiry.ts';
import { process as fxRefresh } from './jobs/fx-refresh.ts';
import { process as lodgingClaims } from './jobs/lodging-claims.ts';
import { process as menuIngest } from './jobs/menu-ingest.ts';
import { process as notifications } from './jobs/notifications.ts';
import { process as placeRefresh } from './jobs/place-refresh.ts';
import { process as priceFreshness } from './jobs/price-freshness.ts';

// A job as a processor receives it: the three fields a handler reads, as a structural subset of BullMQ's `Job`, so a test calls a processor with a plain object literal.
export type ProcessorJob = {
  /** The BullMQ job id, when the job came from a queue; a hand-built test job may omit it. */
  id?: string;
  /** The job name, which decides the payload schema and the handler. */
  name: string;
  /** The job's data, unparsed (`unknown`) until the processor's own boundary validates it. */
  data: unknown;
};
export type Processor = (job: ProcessorJob, ctx: WorkerContext) => Promise<unknown>;
export type WorkerQueueName = Exclude<QueueName, typeof QUEUE.settlement>;
// The queues `apps/workers` consumes, and the set `startWorkers` starts by default: server-core's own list, which is every queue but `settlement`, because the API settles meetups in the process holding the payment secret. Narrowing the element type is what makes a lookup in {@link PROCESSORS} or {@link WORKER_CONCURRENCY} exhaustive.
export const WORKER_QUEUES: readonly WorkerQueueName[] = Object.freeze(
  CONSUMED_QUEUE_NAMES.filter((queue): queue is WorkerQueueName => queue !== QUEUE.settlement),
);
// Everything one job of this process is handed (AAP 0.5.1, 0.5.6): the configuration, clock, logger, database and `client` Redis connection, the producer registry, the field keyring, the language-model adapter with its spend meter, the telephony client and call guard, the mail and push senders, and the menu pipeline's browser, safe fetch and blocklist. The two collaborators a mode may switch off are `null` (`telephony` when `TELEPHONY_MODE=off`, `push` when `EXPO_ACCESS_TOKEN` is unset), and every job that reads one checks it first.
export interface WorkerContext {
  readonly env: WorkersEnv;
  readonly clock: Clock;
  /** The process logger, with the workspace's redaction paths applied. */
  readonly logger: Logger;
  /** The guarded Prisma client: every query passes the fixture guard (AAP 0.5.2). */
  readonly db: DbClient;
  /** The `client`-role Redis connection: caches, the domain throttle, the suspension flag. */
  readonly redis: Redis;
  /** The producer registry, one lazily created `Queue` per name over the shared `producer` connection. */
  readonly queues: { get(name: QueueName): Queue };
  /** The AES-256-GCM keyring every ciphertext column is written and read through. */
  readonly keyring: FieldKeyring;
  /** The provider-neutral language-model adapter `LLM_PROVIDER` selected (AAP 0.5.6). */
  readonly llm: LlmAdapter;
  /** The per-city-local-day spend meter the adapter's requests are reserved and charged against. */
  readonly spend: LlmSpend;
  /** The Twilio client, or `null` when `TELEPHONY_MODE=off` and nothing is dialed. */
  readonly telephony: TelephonyClient | null;
  /** The guard every outbound call passes: outside production, allowlisted numbers only (AAP 0.3.3). */
  readonly callGuard: CallGuard;
  /** The SMTP mailer magic links and web notifications are delivered through. */
  readonly mailer: Mailer;
  /** The Expo push sender, or `null` when push is unconfigured and email carries the message. */
  readonly push: PushSender | null;
  /** The one Chromium the menu pipeline renders places in, launched on first use. */
  readonly browser: BrowserProvider;
  /** The policy-checked fetch every menu request goes through (AAP 0.5.6). */
  readonly safeFetch: SafeFetch;
  /** The crawl blocklist, loaded once from `config/crawl-blocklist.json`. */
  readonly blocklist: Blocklist;
}

// What a caller may replace when it builds a context: any field of {@link WorkerContext}, plus the three seams a suite needs and a job never sees (AAP 0.11.2) — `twilioHttpClient` behind the telephony client, `lookup` inside safe-fetch, `timezoneFor` in the spend meter. A supplied field is used as given and is never closed by `closeWorkerContext`, because this factory did not build it.
export type WorkerContextOverrides = Partial<WorkerContext> & {
  twilioHttpClient?: TwilioHttpClient;
  lookup?: LookupFn;
  timezoneFor?: (cityId: string) => string;
};
/** The city configuration the zone fallback and the seed both read (AAP 0.5.2). */
const CITIES_FILE = 'config/cities.json';
// The shape a logged failure token may have: a short identifier, an error's own `code` or class name.
const FAILURE_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// What each queue runs at once (AAP 0.5.6). `notifications` and `call-results` are cheap and awaited by a person; `menu-ingest` is 2 because each job drives Chromium, and the claim and erasure jobs are 2 for the same bounded-resource reason. Everything else stays at 1: a second concurrent `call-dispatch` would race its own claim.
export const WORKER_CONCURRENCY: Readonly<Record<WorkerQueueName, number>> = Object.freeze({
  [QUEUE.notifications]: 5,
  [QUEUE.callResults]: 4,
  [QUEUE.menuIngest]: 2,
  [QUEUE.lodgingClaims]: 2,
  [QUEUE.accountErasure]: 2,
  [QUEUE.placeRefresh]: 1,
  [QUEUE.priceFreshness]: 1,
  [QUEUE.fxRefresh]: 1,
  [QUEUE.callDispatch]: 1,
  [QUEUE.dataExpiry]: 1,
});
// The processor of every queue and job name `apps/workers` runs (AAP 0.5.6), keyed by the `JOB` constants rather than their string values, so a renamed job fails this file's typecheck. Where job names share one module they share its `process`.
export const PROCESSORS: Readonly<Record<WorkerQueueName, Readonly<Record<string, Processor>>>> = {
  [QUEUE.notifications]: { [JOB[QUEUE.notifications].deliver]: notifications },
  [QUEUE.placeRefresh]: { [JOB[QUEUE.placeRefresh].refresh]: placeRefresh },
  [QUEUE.menuIngest]: {
    [JOB[QUEUE.menuIngest].ingest]: menuIngest,
    [JOB[QUEUE.menuIngest].ingestCity]: menuIngest,
  },
  [QUEUE.priceFreshness]: { [JOB[QUEUE.priceFreshness].check]: priceFreshness },
  [QUEUE.fxRefresh]: { [JOB[QUEUE.fxRefresh].refresh]: fxRefresh },
  [QUEUE.callDispatch]: {
    [JOB[QUEUE.callDispatch].dispatchCity]: callDispatch,
    [JOB[QUEUE.callDispatch].createTask]: callDispatch,
  },
  [QUEUE.callResults]: { [JOB[QUEUE.callResults].apply]: callResults },
  [QUEUE.lodgingClaims]: {
    [JOB[QUEUE.lodgingClaims].claimExpire]: lodgingClaims,
    [JOB[QUEUE.lodgingClaims].stayExpiry]: lodgingClaims,
  },
  [QUEUE.dataExpiry]: {
    [JOB[QUEUE.dataExpiry].hourly]: dataExpiry,
    [JOB[QUEUE.dataExpiry].daily]: dataExpiry,
  },
  [QUEUE.accountErasure]: {
    [JOB[QUEUE.accountErasure].erase]: accountErasure,
    [JOB[QUEUE.accountErasure].sweep]: accountErasure,
  },
};
// The producer side of one context: the connection its `Queue` instances share, made on first use, and the producers created so far, one per queue name.
interface ProducerState {
  /** The shared `producer` connection, or `null` while no job has been enqueued yet. */
  connection: Redis | null;
  readonly queues: Map<QueueName, Queue>;
}

// The collaborators one context owns. A field the caller supplied is `null`: it belongs to the caller, and closing it here would pull a resource out from under the code that built it.
interface OwnedResources {
  readonly db: DbClient | null;
  readonly redis: Redis | null;
  readonly mailer: Mailer | null;
  readonly browser: BrowserProvider | null;
  readonly producer: ProducerState;
}

const OWNED = new WeakMap<WorkerContext, OwnedResources>();
// Builds the context every job of this process runs against (AAP 0.5.1, 0.6.2).
//
// Asynchronous because the spend meter needs the configured cities' zones before it can book a reservation against a
// city's local day: the `City` rows are read once, here, with `config/cities.json` as the fallback for a city the
// seed has not written yet. A field a caller overrides is used as given and its default is not built, so a suite that
// injects a clock, an adapter, a mailer or a transport opens no second connection and reaches no provider: the `off`,
// `fake` and absent-token modes build no client at all, which is what lets the `demo` stack start with no credential.
export async function createWorkerContext(
  env: WorkersEnv,
  overrides: WorkerContextOverrides = {},
): Promise<WorkerContext> {
  const clock = override(overrides.clock, () => systemClock);
  const logger = override(overrides.logger, () =>
    createLogger({ name: 'workers', level: env.LOG_LEVEL, appEnv: env.APP_ENV }),
  );
  const db = override(overrides.db, () =>
    createPrismaClient({ databaseUrl: env.DATABASE_URL, appEnv: env.APP_ENV }),
  );
  const redis = override(overrides.redis, () =>
    createRedisConnection(env.REDIS_URL, 'client', { logger }),
  );
  const keyring = override(overrides.keyring, () => keyringFromEnv(env));
  const llm = override(overrides.llm, () => createLlmAdapter(llmAdapterConfig(env)));
  // One producer connection for the whole process, opened when the first job is enqueued, never here.
  const producer: ProducerState = { connection: null, queues: new Map() };
  const queues: WorkerContext['queues'] = overrides.queues ?? {
    get(name: QueueName): Queue {
      let queue = producer.queues.get(name);
      if (queue === undefined) {
        producer.connection ??= createRedisConnection(env.REDIS_URL, 'producer', { logger });
        queue = new Queue(name, {
          connection: producer.connection,
          defaultJobOptions: QUEUE_JOB_OPTIONS[name],
        });
        // Not optional: a `Queue` re-emits the failures of its connection, and BullMQ answers an `'error'` event with no listener by dumping the raw error and stack to stderr, outside this process's logger.
        queue.on('error', (error: Error) => reportRedisUnavailable(logger, 'producer', error));
        producer.queues.set(name, queue);
      }
      return queue;
    },
  };
  // Awaited rather than built lazily: the meter books a request against a city's local day, so every zone has to be known before the first reservation. `override` is synchronous, hence the branch.
  const timezoneFor = overrides.timezoneFor ?? (await createConfiguredTimezoneLookup(db));
  const spend = override(overrides.spend, () =>
    createLlmSpend({
      store: createSqlSpendStore(databaseSql(db)),
      suspension: createRedisSuspensionStore(redis),
      clock,
      capMicros: env.capLlmMicrosPerCityDay,
      prices: env.llm.prices,
      timezoneFor,
      logger,
    }),
  );
  const telephony = override(overrides.telephony, () =>
    telephonyFor(env, overrides.twilioHttpClient),
  );
  const callGuard = override(overrides.callGuard, () =>
    createCallGuard({
      appEnv: env.APP_ENV,
      allowlist: env.CALL_ALLOWLIST,
      productionApproved: env.CALLS_PRODUCTION_APPROVED,
    }),
  );
  const mailer = override(overrides.mailer, () =>
    createMailer({ smtpUrl: env.SMTP_URL, from: env.EMAIL_FROM }),
  );
  // Absent or blank `EXPO_ACCESS_TOKEN` leaves push switched off, and the `notifications` job mails instead — the web client's only channel (AAP 0.3.4).
  const push = override(overrides.push, () => createPushSender(env.EXPO_ACCESS_TOKEN ?? undefined));
  const blocklist = override(overrides.blocklist, () => loadBlocklist(findRepoRoot()));
  const browser = override(overrides.browser, () => createBrowserProvider());
  const safeFetch = override(overrides.safeFetch, () =>
    createSafeFetch({
      // Omitted rather than passed as `undefined`, so the resolver stays safe-fetch's own default.
      ...(overrides.lookup === undefined ? {} : { lookup: overrides.lookup }),
      allowPrivateHosts: env.testOnly.crawlAllowPrivateHosts,
      appEnv: env.APP_ENV,
      blocklist,
      policy: createDomainPolicy({
        store: createPrismaCrawlPolicyStore(db),
        clock,
        blocklist,
      }),
      robotsCache: createRedisRobotsCache(redis),
      throttle: createDomainThrottle(redis),
      // The same string `crawlerUserAgent` composes from `CRAWLER_CONTACT_URL`, derived once by the environment builder so `robots.txt` matching and the header cannot drift apart.
      userAgent: env.crawlerUserAgent,
      logger,
      clock,
    }),
  );
  const context: WorkerContext = {
    env,
    clock,
    logger,
    db,
    redis,
    queues,
    keyring,
    llm,
    spend,
    telephony,
    callGuard,
    mailer,
    push,
    browser,
    safeFetch,
    blocklist,
  };
  OWNED.set(context, {
    db: overrides.db === undefined ? db : null,
    redis: overrides.redis === undefined ? redis : null,
    mailer: overrides.mailer === undefined ? mailer : null,
    browser: overrides.browser === undefined ? browser : null,
    producer,
  });
  return context;
}

// Closes in order, each step on its own so one refusal does not strand the rest. A context this factory did not build owns nothing here and is left untouched.
export async function closeWorkerContext(ctx: WorkerContext): Promise<void> {
  const owned = OWNED.get(ctx);
  if (owned === undefined) {
    return;
  }
  const browser = owned.browser;
  if (browser !== null) {
    await closeStep(ctx.logger, 'browser', () => browser.close());
  }
  await Promise.all(
    [...owned.producer.queues].map(([queue, producer]) =>
      closeStep(ctx.logger, `queue:${queue}`, () => producer.close()),
    ),
  );
  const connection = owned.producer.connection;
  if (connection !== null) {
    await closeStep(ctx.logger, 'producer', () => connection.quit());
  }
  const mailer = owned.mailer;
  if (mailer !== null) {
    await closeStep(ctx.logger, 'mailer', () => mailer.close?.());
  }
  const redis = owned.redis;
  if (redis !== null) {
    await closeStep(ctx.logger, 'redis', () => redis.quit());
  }
  const db = owned.db;
  if (db !== null) {
    await closeStep(ctx.logger, 'db', () => db.$disconnect());
  }
}

interface StartedWorker {
  readonly queue: WorkerQueueName;
  readonly worker: Worker<unknown, unknown, string>;
  readonly connection: Redis;
}

// Starts one BullMQ `Worker` per queue (AAP 0.5.6), each on its own `worker`-role connection: BullMQ rejects any other `maxRetriesPerRequest` on a connection it blocks on, and a queue sharing a connection with a sibling stops draining while that sibling's fetch is in flight. Nothing awaits Redis: a queue that is down costs a delay in its work rather than a failed start, and the connection's own `error` listener keeps a failure off the process.
export function startWorkers(
  ctx: WorkerContext,
  opts: { queues?: readonly WorkerQueueName[] } = {},
): () => Promise<void> {
  const started = (opts.queues ?? WORKER_QUEUES).map((queue) => startWorker(queue, ctx));
  let stopping: Promise<void> | null = null;
  return function stop(): Promise<void> {
    stopping ??= stopWorkers(started, ctx.logger);
    return stopping;
  };
}

// Starts one worker and attaches its two listeners. The `failed` listener records the queue, the job's name and id,
// the attempts made and a bounded failure token; the `error` listener records the queue and that token, because no
// job is in hand. Neither logs the job's data nor an error's own message, because the message of a failure raised by
// a browser, a database or a mail transport can quote the value it objected to. The `error` listener is throttled per
// queue, because a Redis that is down fires it on every reconnect attempt and ten workers on one outage would bury
// the first failure, which is the one an operator reads.
function startWorker(queue: WorkerQueueName, ctx: WorkerContext): StartedWorker {
  const connection = createRedisConnection(ctx.env.REDIS_URL, 'worker', { logger: ctx.logger });
  const worker = new Worker<unknown, unknown, string>(
    queue,
    (job: Job<unknown, unknown, string>) => runJob(queue, job, ctx),
    // Retry and backoff are absent on purpose: they travel with each job, from `jobOptionsFor(queue)` on the producer side, so a policy is stated once and belongs to the job it was added with.
    { connection, concurrency: WORKER_CONCURRENCY[queue] },
  );
  worker.on('failed', (job: Job<unknown, unknown, string> | undefined, error: Error) => {
    ctx.logger.warn({
      event: 'job_failed',
      queue,
      job: job?.name,
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      code: failureToken(error),
    });
  });
  worker.on('error', (error: Error) => {
    throttleRedisFailure(`worker:${queue}`, () => {
      ctx.logger.warn({ event: 'worker_error', queue, code: failureToken(error) });
    });
  });
  return { queue, worker, connection };
}

// Runs one job: looks its processor up by queue and name, and hands it the three fields it reads plus a context whose
// logger names the job.
//
// A name this queue does not accept has no processor and fails once, as an `UnrecoverableError`, instead of being
// retried against a wiring fault no retry can fix; a payload that does not satisfy the schema of the name it arrived
// under is the same kind of fault, and every processor validates its own data before it does anything else, so that
// refusal becomes the same single failure rather than five attempts. Everything else a processor throws propagates
// unchanged, which is how it asks for the retry its job options promise (AAP 0.5.6, 0.11.1).
async function runJob(
  queue: WorkerQueueName,
  job: Job<unknown, unknown, string>,
  ctx: WorkerContext,
): Promise<unknown> {
  const processor = PROCESSORS[queue][job.name];
  if (processor === undefined) {
    throw new UnrecoverableError(`no processor is registered for the job "${queue}/${job.name}"`);
  }
  // The job id is bound here, at the hand-off, so every line the processor writes names its job (AAP 0.5.6). The copy owns nothing — `ctx` keeps every collaborator, so `closeWorkerContext` still closes exactly what `createWorkerContext` built — and a hand-built test job carries no id.
  const jobCtx = job.id === undefined ? ctx : { ...ctx, logger: withJobId(ctx.logger, job.id) };
  try {
    return await processor(
      job.id === undefined
        ? { name: job.name, data: job.data }
        : { id: job.id, name: job.name, data: job.data },
      jobCtx,
    );
  } catch (error) {
    if (error instanceof QueuePayloadError) {
      throw new UnrecoverableError(error.message);
    }
    throw error;
  }
}

// Closes every started worker, then the connection it consumed on: BullMQ's `close` waits for the job a worker is running, so a shutdown drains rather than abandons it.
async function stopWorkers(started: readonly StartedWorker[], logger: Logger): Promise<void> {
  await Promise.all(
    started.map(async ({ queue, worker, connection }) => {
      await closeStep(logger, `worker:${queue}`, () => worker.close());
      await closeStep(logger, `connection:${queue}`, () => connection.quit());
    }),
  );
}

// `given` when a caller supplied it, otherwise what `make` builds. `??` is wrong for the two fields a caller may legitimately pass as `null` — a context whose telephony is off, or whose push is disabled — so presence, not truthiness, decides.
function override<T>(given: T | undefined, make: () => T): T {
  return given === undefined ? make() : given;
}

/** The adapter `env.llm` names (AAP 0.5.6): `fake` needs no credential and reaches no provider. */
function llmAdapterConfig(env: WorkersEnv): LlmAdapterConfig {
  return env.llm.provider === 'openai'
    ? { provider: 'openai', apiKey: env.llm.apiKey, model: env.llm.model }
    : { provider: 'fake' };
}

/** The telephony client `env.telephony` names, or `null` for `off`, which dials nothing (AAP 0.6.2). */
function telephonyFor(
  env: WorkersEnv,
  httpClient: TwilioHttpClient | undefined,
): TelephonyClient | null {
  const telephony = env.telephony;
  if (telephony.mode === 'off') {
    return null;
  }
  return createTelephonyClient({
    mode: telephony.mode,
    accountSid: telephony.accountSid,
    authToken: telephony.authToken,
    // Each optional is spread in or left out, never passed as `undefined`.
    ...(telephony.mode === 'simulator' && telephony.simulatorUrl !== undefined
      ? { simulatorUrl: telephony.simulatorUrl }
      : {}),
    ...(httpClient === undefined ? {} : { httpClient }),
  });
}

// The tagged-template executor the spend meter is built on (AAP 0.11.2): every statement is parameterized.
function databaseSql(db: DbClient) {
  return <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> =>
    db.$queryRaw<T>(strings, ...values);
}

// The city-zone lookup the spend meter books a reservation against (AAP 0.5.6): the `City` rows this database holds, with `config/cities.json` as the fallback for a city the seed has not written yet.
async function createConfiguredTimezoneLookup(db: DbClient): Promise<(cityId: string) => string> {
  const zones = new Map<string, string>();
  for (const city of await db.city.findMany({ select: { id: true, timezone: true } })) {
    zones.set(city.id, city.timezone);
  }
  return (cityId: string): string => {
    const zone = zones.get(cityId) ?? configuredTimezone(cityId);
    if (zone === undefined) {
      throw new Error(`unknown city "${cityId}"`);
    }
    return zone;
  };
}

/** The launch cities once read, so `config/cities.json` is parsed once per process. */
let configuredZones: ReadonlyMap<string, string> | undefined;
/** The zone `config/cities.json` gives `cityId`, or `undefined` when it configures no such city. */
function configuredTimezone(cityId: string): string | undefined {
  configuredZones ??= readConfiguredZones();
  return configuredZones.get(cityId);
}

// Reads `config/cities.json` from the repository root and keeps each city's zone, for the life of the process: the file the seed loads its `City` rows from is the same file, so a city the database holds only after a seed has been run is still schedulable before it.
function readConfiguredZones(): ReadonlyMap<string, string> {
  const file = path.join(findRepoRoot(), CITIES_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`city configuration ${CITIES_FILE} could not be read: ${messageOf(error)}`);
  }
  const parsed = CitiesFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`city configuration ${CITIES_FILE} is invalid`);
  }
  return new Map(parsed.data.cities.map((city): [string, string] => [city.id, city.timezone]));
}

/** The message of an unknown thrown value, for an error that names a file but never its content. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A short, safe label for a failed job or a dropped connection: the error's own `code` when it carries one (`ECONNREFUSED`, `ETIMEDOUT`, a Prisma `P2002`), its class name otherwise, `Error` for anything that is neither. The message is deliberately not logged, because it can quote the value the failure objected to.
function failureToken(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'Error';
  }
  const { code, name } = error as { code?: unknown; name?: unknown };
  const token = typeof code === 'string' && code.length > 0 ? code : name;
  return typeof token === 'string' && FAILURE_TOKEN_PATTERN.test(token) ? token : 'Error';
}

// One step of a shutdown, recorded by name and never by what it held: a close that fails is reported and the next step still runs, because a resource that will not close must not strand the others.
async function closeStep(
  logger: Logger,
  step: string,
  close: () => Promise<unknown> | void,
): Promise<void> {
  try {
    await close();
  } catch {
    logger.warn({ event: 'close_failed', step });
  }
}
