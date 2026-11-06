/**
 * The API's composition root (AAP 0.5.1, 0.6.2, 0.8.1): `buildApp` assembles the container every
 * module receives, registers the cross-cutting plugins and the module routes, and owns the shutdown
 * order; `startBackground` starts the settlement worker, the sweeper, the outbox poller and the
 * pub/sub fan-out once the process is listening.
 *
 * **One container, declared once.** `AppServices` is the object every module of
 * `apps/api/src/modules` and every plugin takes — most of them type the members they read with
 * `Pick<AppServices, …>` — so the type below is what makes the whole package compile and what the
 * `services` decorator hands out at runtime. It is declared here rather than in a module of its own
 * because the composition root is the only place that knows how every member is built.
 *
 * **No network at build time (AAP 0.6.2).** `buildApp` is synchronous and opens nothing: Prisma
 * connects on its first query, every Redis connection and every BullMQ `Queue` is created on first
 * use, and the Stripe, language-model and Twilio clients open no socket when they are constructed. A
 * caller may therefore build an app, `await app.ready()`, read `app.swagger()` and close it again
 * with no database and no Redis running — which is what the contract test, the OpenAPI export script
 * and `get /v1/health` itself depend on.
 *
 * **Registration order is load-bearing (AAP 0.5.1).** The plugins are plain functions called on the
 * root instance, not Fastify plugins registered in child contexts: `decorate` and `decorateRequest`
 * throw once an instance has started, and a hook or decorator added to the root runs for every route
 * its children declare. `registerClock` is first — its `receivedAt` decoration must exist before any
 * route can read it — then errors, security, auth, rate-limit, WebSocket and OpenAPI, the last
 * before any route so the emitted document contains every operation. The routes follow, the
 * test-control routes only in `APP_ENV=test`, and the health probe last.
 *
 * **One write path for the background work (AAP 0.3.2).** Only `startBackground` starts the
 * settlement worker, the sweeper, the outbox poller and the subscribers, and it records the stop
 * function on the app so the one `onClose` hook can await it before it closes the queues, the
 * connections and Prisma.
 *
 * @see AAP 0.5.1 for the bootstrap and the plugin list, 0.5.3 and 0.5.6 for the timers and the
 *   background startup, 0.5.4 for the health route and the route-schema rule, 0.6.2 for the process
 *   boundaries, 0.11.1 for the injected clock and TSDoc, 0.11.2 for the fault points and the lint
 *   gate, 0.12.2 for the `Server-Timing` header the load test subtracts, and 0.8.1 for this file.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';

import { Queue } from 'bullmq';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { createPrismaClient } from '@tablemate/db';
import {
  QUEUE_JOB_OPTIONS,
  createLlmAdapter,
  createLlmSpend,
  createLogger,
  createRedisConnection,
  createRedisSuspensionStore,
  createSqlSpendStore,
  createTelephonyClient,
  keyringFromEnv,
  systemClock,
  waitForRedisReady,
} from '@tablemate/server-core';
import { HealthResponse } from '@tablemate/shared';

import { registerAuth } from './plugins/auth.ts';
import { registerClock } from './plugins/clock.ts';
import { registerErrorHandling } from './plugins/errors.ts';
import { registerOpenApi, type OpenApiTag } from './plugins/openapi.ts';
import { registerRateLimit } from './plugins/rate-limit.ts';
import { registerSecurity } from './plugins/security.ts';
import { registerWebsocket } from './plugins/websocket.ts';
import adminRoutes from './modules/admin/routes.ts';
import analyticsRoutes from './modules/analytics/routes.ts';
import authRoutes from './modules/auth/routes.ts';
import citiesRoutes from './modules/cities/routes.ts';
import consolesRoutes from './modules/consoles/routes.ts';
import lodgingsRoutes from './modules/lodgings/routes.ts';
import meRoutes from './modules/me/routes.ts';
import meetupsRoutes from './modules/meetups/routes.ts';
import messagingRoutes from './modules/messaging/routes.ts';
import { createPubSub } from './modules/messaging/pubsub.ts';
import { createOutboxDispatcher } from './modules/outbox/dispatcher.ts';
import { currentStripeMs, withStripeTimingStore } from './modules/payments/gateway.ts';
import { createStripeGateway } from './modules/payments/stripe-gateway.ts';
import { stripeWebhookRoutes } from './modules/payments/webhook.ts';
import { cityBySlug } from './modules/proofs/registry.ts';
import proofsRoutes from './modules/proofs/routes.ts';
import { startSettlementWorker } from './modules/settlement/queue.ts';
import { startSweeper } from './modules/settlement/sweeper.ts';
import suggestionsRoutes from './modules/suggestions/routes.ts';
import testControlRoutes from './modules/test-control/routes.ts';
import usersRoutes from './modules/users/routes.ts';
import { voiceAgentRoutes } from './modules/voice-agent/twiml.ts';

import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
  RawServerDefault,
  RouteOptions,
} from 'fastify';
import type { Redis } from 'ioredis';
import type { DbClient } from '@tablemate/db';
import type {
  ApiEnv,
  Clock,
  FieldKeyring,
  LlmAdapter,
  LlmAdapterConfig,
  LlmSpend,
  Logger,
  QueueName,
  RedisRole,
  SuspensionStore,
  TelephonyClient,
  TwilioHttpClient,
} from '@tablemate/server-core';
import type { OutboxDispatcher } from './modules/outbox/dispatcher.ts';
import type { PaymentsGateway } from './modules/payments/gateway.ts';
import type { PubSub } from './modules/messaging/pubsub.ts';

/*
 * Constants (AAP 0.3.2, 0.5.4, 0.5.6)
 */

/**
 * The largest JSON body the API accepts, in bytes: 1 MiB, far above any request the contract
 * defines. `PUT /me/profile` overrides it with `PROFILE_BODY_LIMIT_BYTES` for the one route that
 * carries a base64 photo (AAP 0.5.4), and the Stripe webhook parses its body under the same limit.
 */
const BODY_LIMIT_BYTES = 1_048_576;

/** The prefix every module's routes and the test-control routes are mounted under (AAP 0.5.4). */
const API_PREFIX = '/v1';

/** The health probe's route, mounted on its own context under {@link API_PREFIX} (AAP 0.5.4). */
const HEALTH_ROUTE = '/health';

/** The tag the health probe groups under, from the document's own vocabulary (AAP 0.11.2). */
const HEALTH_TAG = 'health' satisfies OpenApiTag;

/** How long the health probe waits for the database and for Redis before calling the check failed. */
const HEALTH_DATABASE_TIMEOUT_MS = 2_000;
const HEALTH_REDIS_TIMEOUT_MS = 1_000;

/** The period the settlement sweeper passes run at (AAP 0.5.3, 0.5.6). */
const SWEEPER_INTERVAL_MS = 60_000;

/** The period the outbox poller runs at (AAP 0.3.2, 0.5.6). */
const OUTBOX_POLL_INTERVAL_MS = 2_000;

/** The shortest gap between two `redis_unavailable` warnings for one role. */
const REDIS_UNAVAILABLE_LOG_INTERVAL_MS = 30_000;

/**
 * The header and metric of the Stripe timing report AAP 0.12.2 measures writes with: the load test
 * subtracts `stripe;dur=` from each write it times, and a write that called Stripe not at all
 * carries `dur=0`.
 */
const SERVER_TIMING_HEADER = 'server-timing';
const STRIPE_TIMING_METRIC = 'stripe';

/**
 * The methods whose responses carry the timing header whatever the route says: every one of them
 * mutates. The two reads that write (AAP 0.5.4) are not in this set; they mark themselves with
 * `stateWritingRead` instead, because the method alone cannot tell them from the reads.
 */
const STATE_WRITING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The methods whose routes answer no body at all, so no response schema can describe them: `HEAD`,
 * which Fastify derives from every `GET` route, and `OPTIONS`, which `@fastify/cors` registers as the
 * wildcard preflight route for the origin allowlist and answers with headers only.
 */
const BODY_LESS_METHODS: ReadonlySet<string> = new Set(['HEAD', 'OPTIONS']);

/** The status the health probe answers when both checks pass, and when either one fails. */
const HEALTHY_STATUS = 200;
const DEGRADED_STATUS = 503;

/** The log event names this file writes (AAP 0.11.1); none of them carries a value from the environment. */
const SHUTDOWN_STEP_FAILED = 'shutdown_step_failed';

/*
 * The instance type and the container (AAP 0.5.1)
 */

/**
 * The app's instance type: one Fastify 5 instance whose schemas are Zod schemas
 * (`fastify-type-provider-zod` 7.0.0) and whose logger is the process logger.
 *
 * It is the one declaration of the app's type in the plan, imported type-only by every plugin and
 * every module of `apps/api/src` — the imports are erased under `verbatimModuleSyntax`, so nothing
 * below is read at runtime by them. The generic order is Fastify 5's own:
 * `<RawServer, RawRequest, RawReply, Logger, TypeProvider>`, with `RawServerDefault` the Node
 * `http.Server` and the two `node:http` message types the defaults for it.
 */
export type App = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * The container every module reads. Decorated on the root instance by {@link buildApp}, so a
     * child context inherits it and a route reads `app.services` or `request.server.services`.
     */
    services: AppServices;
  }

  interface FastifyContextConfig {
    /**
     * Marks a route that answers bytes rather than JSON — the two exceptions to the response-schema
     * rule of AAP 0.5.4: `GET /v1/users/:userId/photo` (WebP) and the Twilio TwiML route (XML).
     * `plugins/errors.ts` already augments this interface with the two validation codes, and the two
     * routes above set the flag through it.
     */
    rawResponse?: boolean;
  }
}

/*
 * Fault injection (AAP 0.11.2)
 */

/**
 * The five places a test may make a request or a pass fail (AAP 0.11.2): one inside the webhook
 * transaction and one after its commit, one before and one after each Stripe call the payment
 * executor makes, and one inside the settlement transaction. The names are the literals
 * `payments/webhook.ts`, `payments/operations.ts` and `settlement/settle.ts` already pass to
 * {@link FaultInjector.hit}, so the injected double and the call sites cannot drift apart.
 */
export type FaultPoint =
  | 'stripe_webhook.after_event_insert'
  | 'stripe_webhook.after_commit'
  | 'payment_op.before_stripe_call'
  | 'payment_op.after_stripe_call'
  | 'settlement.inside_transaction';

/**
 * Where a test throws from (AAP 0.11.2). Supplied through `AppDeps.faults` and accepted only in
 * `APP_ENV=test`; the production container holds {@link noFaults}, so the call sites cost one
 * resolved promise.
 */
export interface FaultInjector {
  /**
   * Report that `point` was reached.
   *
   * @param point - which of the five points the caller is at.
   * @param context - ids the test wants to see: the Stripe event id, the payment operation id, the
   *   meetup id. Ids only — never a payload, an address or a token.
   */
  hit(point: FaultPoint, context?: Record<string, string>): Promise<void>;
}

/**
 * The injector every non-test process is built with: it resolves immediately, so no call site
 * branches on whether fault injection is configured.
 */
export const noFaults: FaultInjector = Object.freeze({
  hit: (): Promise<void> => Promise.resolve(),
});

/*
 * Redis (AAP 0.3.2)
 */

/**
 * The API's Redis connections, one per role, created on first use (AAP 0.3.2).
 *
 * Three roles, matching `createRedisConnection`'s own: a `client` connection for the rate-limit
 * store, the session cache, the leaderboard cache and the language-model suspension flag; a second
 * `client` connection for the pub/sub subscriber, because a subscribed ioredis connection can issue
 * no other command and `psubscribe` would otherwise break the cache; and a `producer` connection for
 * the BullMQ `Queue` instances, which must fail a command during an outage rather than queue it. A
 * `worker` connection carries no command timeout, because BullMQ's blocking fetch is meant to block,
 * so each consumer gets its own from {@link ApiRedis.createWorkerConnection} and owns it.
 */
export interface ApiRedis {
  /** The `client`-role connection: fail-fast, never lent to a subscriber. */
  readonly client: Redis;
  /** The `client`-role connection the pub/sub patterns are registered on, and nothing else uses. */
  readonly subscriber: Redis;
  /** The `producer`-role connection every BullMQ `Queue` is built on. */
  readonly producer: Redis;
  /**
   * A fresh `worker`-role connection for one BullMQ `Worker`, which closes it itself.
   *
   * Never memoized: a `Worker` duplicates the instance for its own use and a second consumer must
   * not share the blocking connection the first one commands on.
   */
  createWorkerConnection(): Redis;
  /**
   * Quit every connection this holder created, each one falling back to `disconnect()` when `quit`
   * fails — a socket that is already gone, or a Redis that went away during the shutdown. Idempotent
   * in effect: a second call finds the same connections already closed.
   */
  close(): Promise<void>;
}

/**
 * Build the API's Redis connections lazily (AAP 0.3.2): nothing connects until the first command is
 * issued, which is what lets `buildApp` open no socket at all.
 *
 * Every connection carries an `'error'` listener, because ioredis otherwise prints an "Unhandled
 * error event" line and, with no listener at all, throws the event into the process. The listener
 * writes one `redis_unavailable` line per role per {@link REDIS_UNAVAILABLE_LOG_INTERVAL_MS} and
 * nothing else: an offline `ready()` cannot crash the process and a flapping connection cannot flood
 * the log. The URL is never logged — the line carries the role, which is what an operator needs to
 * tell a rate-limit store failure from a queue failure.
 *
 * @param url - `REDIS_URL` from the validated environment.
 * @param logger - the process logger the warnings are written through.
 * @returns the holder {@link AppServices} exposes as `services.redis`.
 */
export function createApiRedis(url: string, logger: Logger): ApiRedis {
  /** When each role's failure was last reported, by `performance.now()` — a monotonic reading, never the wall clock. */
  const lastReportedAt = new Map<RedisRole, number>();

  /** Report one connection failure, at most once per role per interval, and never with its error. */
  function reportUnavailable(role: RedisRole): void {
    const now = performance.now();
    const previous = lastReportedAt.get(role);
    if (previous !== undefined && now - previous < REDIS_UNAVAILABLE_LOG_INTERVAL_MS) {
      return;
    }
    lastReportedAt.set(role, now);
    logger.warn({ event: 'redis_unavailable', role }, 'redis_unavailable');
  }

  /** Create one connection of `role`, with the throttled reporter as its error listener. */
  function connect(role: RedisRole): Redis {
    return createRedisConnection(url, role, { onError: () => reportUnavailable(role) });
  }

  let client: Redis | undefined;
  let subscriber: Redis | undefined;
  let producer: Redis | undefined;
  const workers = new Set<Redis>();

  /** Close one connection, falling back to `disconnect()` when `quit` cannot complete. */
  async function closeConnection(connection: Redis): Promise<void> {
    try {
      await connection.quit();
    } catch {
      connection.disconnect();
    }
  }

  return {
    get client(): Redis {
      client ??= connect('client');
      return client;
    },

    get subscriber(): Redis {
      subscriber ??= connect('client');
      return subscriber;
    },

    get producer(): Redis {
      producer ??= connect('producer');
      return producer;
    },

    createWorkerConnection(): Redis {
      const connection = connect('worker');
      workers.add(connection);
      return connection;
    },

    async close(): Promise<void> {
      const connections = [client, subscriber, producer, ...workers];
      client = undefined;
      subscriber = undefined;
      producer = undefined;
      workers.clear();

      await Promise.all(
        connections
          .filter((connection): connection is Redis => connection !== undefined)
          .map((connection) => closeConnection(connection)),
      );
    },
  };
}

/*
 * Queues (AAP 0.3.2, 0.5.1)
 */

/**
 * The BullMQ producers the API holds (AAP 0.5.1): one `Queue` per queue name, created on first use
 * so that building the app opens no BullMQ connection at all.
 *
 * A producer is only ever created for a queue this process enqueues to — `settlement` for the timers
 * the API schedules, and the `workers` queues for the rows the outbox dispatcher delivers — and it
 * is created on `redis.producer`, the fail-fast connection a `Queue` belongs on.
 */
export interface ApiQueues {
  /**
   * The producer for `name`, created on the first call.
   *
   * Every producer carries that queue's own default job options from
   * `QUEUE_JOB_OPTIONS` (AAP 0.5.6), so retry and backoff travel with each job and a caller that
   * overrides nothing still gets the queue's policy.
   */
  get(name: QueueName): Queue;
  /** Close every producer created so far. */
  close(): Promise<void>;
}

/**
 * Build the queue registry over an already-built Redis holder (AAP 0.3.2, 0.5.1).
 *
 * @param redis - the app's connections; only the `producer` is read, and only when a queue is first
 *   asked for.
 * @returns the registry {@link AppServices} exposes as `services.queues`.
 */
function createApiQueues(redis: ApiRedis): ApiQueues {
  const created = new Map<QueueName, Queue>();

  return {
    get(name: QueueName): Queue {
      let queue = created.get(name);
      if (queue === undefined) {
        queue = new Queue(name, {
          connection: redis.producer,
          defaultJobOptions: QUEUE_JOB_OPTIONS[name],
        });
        created.set(name, queue);
      }
      return queue;
    },

    async close(): Promise<void> {
      const queues = [...created.values()];
      created.clear();
      await Promise.all(queues.map((queue) => queue.close()));
    },
  };
}

/*
 * The container (AAP 0.5.1)
 */

/**
 * What every module and every plugin of the API is handed (AAP 0.5.1).
 *
 * The members are the plan's one statement of what the app provides: a `Pick<AppServices, …>` in a
 * module names a subset of this object and is satisfied by it structurally, so a test can stand a
 * smaller double in for one capability. Nothing here is a global: the container is built once per
 * process, decorated on the instance, and passed explicitly to the functions that need it.
 *
 * Four members are built on first read rather than eagerly, and each for the same reason — the app
 * must build with no database and no Redis (AAP 0.6.2): `spend` and `suspension` because they take a
 * Redis connection, `pubsub` because it takes two, and `outbox` because the dispatcher it builds is
 * handed the container itself.
 */
export interface AppServices {
  /** The validated `api` configuration (AAP 0.6.2). */
  readonly env: ApiEnv;
  /** The injected clock every handler and background pass reads (AAP 0.11.1). */
  readonly clock: Clock;
  /** The guarded Prisma client: the only way any module reaches the database. */
  readonly db: DbClient;
  /** The Redis connections, one per role (AAP 0.3.2). */
  readonly redis: ApiRedis;
  /** The redacting process logger; a request's own lines go through `request.log` (AAP 0.11.1). */
  readonly logger: Logger;
  /** The Stripe gateway: the one seam every hold, capture, release and refund goes through. */
  readonly payments: PaymentsGateway;
  /** The language-model provider behind its neutral adapter, or the `fake` one (AAP 0.5.6). */
  readonly llm: LlmAdapter;
  /** The per-city-per-day language-model spend meter (AAP 0.5.6). */
  readonly spend: LlmSpend;
  /**
   * The global language-model suspension flag (AAP 0.5.6), the store the relay writes through and
   * the operator dashboard reads. Shared with `apps/workers` through one Redis key.
   */
  readonly suspension: SuspensionStore;
  /** The telephony client, or `null` in `TELEPHONY_MODE=off`, where the API serves no voice traffic. */
  readonly telephony: TelephonyClient | null;
  /** The field keyring the encrypted columns are read and written with (AAP 0.5.2). */
  readonly keyring: FieldKeyring;
  /** The BullMQ producers (AAP 0.3.2). */
  readonly queues: ApiQueues;
  /** The transactional outbox poller (AAP 0.3.2, 0.5.6). */
  readonly outbox: OutboxDispatcher;
  /** The pub/sub fan-out and this instance's socket registry (AAP 0.3.2). */
  readonly pubsub: PubSub;
  /** Where a test throws from; {@link noFaults} in every other environment (AAP 0.11.2). */
  readonly faults: FaultInjector;
  /**
   * The IANA zone of a configured city (AAP 0.5.6), read from `config/cities.json` once per process.
   *
   * @param cityId - a city slug, as every route's `:cityId` parameter carries it.
   * @throws {Error} `unknown city` for a slug this deployment does not have: a city with no
   *   configuration has no local day to book spend against and no timezone to judge a window in.
   */
  timezoneFor(cityId: string): string;
}

/**
 * What `buildApp` may be handed instead of building it (AAP 0.5.1): the validated environment, and a
 * test's replacements for any dependency a suite has to control.
 *
 * `env` is the only required member — it decides the modes, the keys and the origins — and every
 * other member defaults to the real one. `faults` is accepted only in `APP_ENV=test`.
 */
export interface AppDeps {
  /** The loaded `api` configuration (AAP 0.6.2). */
  readonly env: ApiEnv;
  /** A clock in place of `systemClock`: the test clock a suite advances (AAP 0.11.1). */
  readonly clock?: Clock;
  /** A database in place of the one built from `DATABASE_URL`. Its owner closes it. */
  readonly db?: DbClient;
  /** A Redis holder in place of the one built from `REDIS_URL`. Its owner closes it. */
  readonly redis?: ApiRedis;
  /** A payments gateway in place of the Stripe one, so a suite reaches no provider. */
  readonly payments?: PaymentsGateway;
  /** An adapter in place of the configured provider, so a suite sends nothing (AAP 0.5.6). */
  readonly llm?: LlmAdapter;
  /** A transport in place of the Twilio SDK's own, for the voice simulator (AAP 0.11.2). */
  readonly twilioHttpClient?: TwilioHttpClient;
  /** The fault points a crash test throws from; refused outside `APP_ENV=test` (AAP 0.11.2). */
  readonly faults?: FaultInjector;
  /** A logger in place of the process one, for a suite that captures log lines. */
  readonly logger?: Logger;
}

/**
 * The stop functions {@link startBackground} recorded, one per app, so the `onClose` hook can await
 * the work it started before the connections below it are closed.
 */
const backgroundStops = new WeakMap<App, () => Promise<void>>();

/*
 * buildApp (AAP 0.5.1, 0.6.2)
 */

/**
 * Build the API (AAP 0.5.1, 0.6.2): one synchronous call that assembles the container, decorates it
 * on the instance, registers every plugin and route, and returns the app ready to be awaited.
 *
 * Synchronous because a caller may compose an app, read `app.swagger()` from it and close it again
 * without a database or a Redis server: nothing here connects, and `app.register` queues a plugin
 * rather than loading it. `await app.ready()` is what loads the plugins, resolves every route and
 * runs the route-schema guard below.
 *
 * @param deps - the validated environment and whatever a suite replaces.
 * @returns the app, decorated with {@link AppServices} and carrying the one `onClose` hook.
 * @throws {Error} `fault injection is only available when APP_ENV=test` when a fault injector is
 *   supplied anywhere else (AAP 0.11.2): the points it throws from interrupt committed work, so no
 *   environment but a test may hold one.
 */
export function buildApp(deps: AppDeps): App {
  const { env } = deps;

  if (deps.faults !== undefined && env.APP_ENV !== 'test') {
    throw new Error('fault injection is only available when APP_ENV=test');
  }

  const logger =
    deps.logger ?? createLogger({ name: 'api', level: env.LOG_LEVEL, appEnv: env.APP_ENV });
  const clock = deps.clock ?? systemClock;

  // Ownership, not configuration: a dependency the caller injected is closed by the caller, so the
  // close hook below only disconnects what this call created.
  const ownsDb = deps.db === undefined;
  const ownsRedis = deps.redis === undefined;

  const db = deps.db ?? createPrismaClient({ databaseUrl: env.DATABASE_URL, appEnv: env.APP_ENV });
  const redis = deps.redis ?? createApiRedis(env.REDIS_URL, logger);
  const payments = deps.payments ?? createStripeGateway(env.stripe, { logger });
  const llm = deps.llm ?? createLlmAdapter(llmAdapterConfig(env));
  const telephony = telephonyFor(env, deps.twilioHttpClient);
  const keyring = keyringFromEnv(env);
  const queues = createApiQueues(redis);
  const faults = deps.faults ?? noFaults;

  // The four members built on first read: each is memoized here so every reader sees one instance,
  // and none of them is created while the app is being composed.
  let spend: LlmSpend | undefined;
  let suspension: SuspensionStore | undefined;
  let pubsub: PubSub | undefined;
  let outbox: OutboxDispatcher | undefined;

  const services: AppServices = {
    env,
    clock,
    db,
    redis,
    logger,
    payments,
    llm,
    telephony,
    keyring,
    queues,
    faults,
    timezoneFor: timezoneOfCity,

    get spend(): LlmSpend {
      spend ??= createLlmSpend({
        store: createSqlSpendStore(databaseSql(db)),
        suspension: services.suspension,
        clock,
        capMicros: env.capLlmMicrosPerCityDay,
        prices: env.llm.prices,
        timezoneFor: timezoneOfCity,
        logger,
      });
      return spend;
    },

    get suspension(): SuspensionStore {
      suspension ??= createRedisSuspensionStore(redis.client);
      return suspension;
    },

    get pubsub(): PubSub {
      // Built here rather than eagerly on purpose: `createPubSub` reads its two Redis connections as
      // it is constructed, so building it while the app is composed would open both sockets before
      // `await app.ready()` — which is the one thing a caller with no Redis must be able to do.
      pubsub ??= createPubSub(services);
      return pubsub;
    },

    get outbox(): OutboxDispatcher {
      // After the rest of the container exists: the dispatcher is handed the container itself, and
      // reads `db`, `clock`, `logger`, `queues` and `redis` off it when it runs a pass.
      outbox ??= createOutboxDispatcher(services);
      return outbox;
    },
  };

  // The logger generic is pinned to `FastifyBaseLogger` so the instance this call returns is the
  // `App` type above, which every plugin and module of the API is written against; inferring it from
  // the pino instance handed in would make the instance's own logger type a *narrower* one, and a
  // narrower instance type is not assignable to `App`.
  const app = Fastify<RawServerDefault, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: logger,
    // A fresh UUID per request, so a log line identifies one request in every replica and cannot be
    // guessed ahead of it. A caller that supplies `x-request-id` keeps it: the header is read first.
    genReqId: () => randomUUID(),
    requestIdHeader: 'x-request-id',
    // The API is reached directly in this deployment (compose publishes its port), so no proxy is
    // trusted to describe the client: `X-Forwarded-For` would otherwise decide an IP rate limit.
    trustProxy: false,
    bodyLimit: BODY_LIMIT_BYTES,
    // During `close()` a request in flight is refused with 503 rather than hanging on a closing
    // server, which is what makes the shutdown below bounded.
    return503OnClosing: true,
  })
    .setValidatorCompiler(validatorCompiler)
    .setSerializerCompiler(serializerCompiler)
    .withTypeProvider<ZodTypeProvider>();

  app.decorate('services', services);

  // 1-7. The cross-cutting plugins, on the root instance in this order (AAP 0.5.1).
  registerClock(app, clock);
  registerErrorHandling(app);
  registerSecurity(app, env);
  registerAuth(app, services);
  registerRateLimit(app, services);
  registerWebsocket(app);
  // Before any route: the document is generated from the routes registered after it.
  registerOpenApi(app, env);

  // 8. The Stripe timing (AAP 0.12.2). The store is opened around `done`, so the rest of the
  // lifecycle — the handler, the executor it awaits, the serializer — runs inside it and every
  // Stripe call the request makes is added to one figure.
  app.addHook('onRequest', (_request, _reply, done) => withStripeTimingStore(done));

  app.addHook('onSend', (request, reply, payload, done) => {
    if (writesState(request)) {
      reply.header(SERVER_TIMING_HEADER, stripeTimingValue());
    }
    done(null, payload);
  });

  // 9. Every route answers with a declared schema or says why it does not (AAP 0.5.4). The guard
  // runs while the routes are being resolved, so a missing schema fails the start rather than
  // answering an empty body in production.
  app.addHook('onRoute', (route) => assertResponseSchema(route));

  // 10. The module routes, each mounted under `/v1` in the order the AAP's component list names
  // them. Two of them register more than their own routes: `messaging/routes.ts` registers the chat
  // socket beside its history route, and `voice-agent/twiml.ts` registers `@fastify/formbody`, the
  // TwiML route, the status webhook and the relay socket inside its own context.
  app.register(authRoutes, { prefix: API_PREFIX });
  app.register(meRoutes, { prefix: API_PREFIX });
  app.register(usersRoutes, { prefix: API_PREFIX });
  app.register(proofsRoutes, { prefix: API_PREFIX });
  app.register(citiesRoutes, { prefix: API_PREFIX });
  app.register(meetupsRoutes, { prefix: API_PREFIX });
  app.register(consolesRoutes, { prefix: API_PREFIX });
  app.register(messagingRoutes, { prefix: API_PREFIX });
  app.register(analyticsRoutes, { prefix: API_PREFIX });
  app.register(suggestionsRoutes, { prefix: API_PREFIX });
  app.register(lodgingsRoutes, { prefix: API_PREFIX });
  app.register(adminRoutes, { prefix: API_PREFIX });
  // The webhook registers the raw-JSON body parser inside its own context, so no other route sees an
  // unparsed body; the voice plugin registers its own form parser for the same reason.
  app.register(stripeWebhookRoutes, { prefix: API_PREFIX });
  app.register(voiceAgentRoutes, { prefix: API_PREFIX });

  // 11. Test control: mounted only in a test process that set its token (AAP 0.5.1, 0.5.4). The
  // plugin refuses to register anywhere else, so this condition and its own guard are two locks.
  if (env.APP_ENV === 'test' && env.testOnly.testControlToken !== null) {
    app.register(testControlRoutes, { prefix: API_PREFIX });
  }

  // 12. The health probe: public, unlimited, and answered from the two dependencies compose gates the
  // API's readiness on (AAP 0.5.4). It is mounted as a child context, like every other route, so it is
  // registered while the plugins load — a route added to the root instance synchronously would be
  // resolved before the OpenAPI plugin had loaded and would never reach the emitted document, which
  // AAP 0.11.2 requires every route to appear in. Its checks are bounded by their own timers rather
  // than by the clock, so a database that accepts a connection and never answers still answers this
  // route; the Redis check waits for the client connection's first `ready` inside that same bound,
  // because a fail-fast connection rejects a command issued before it.
  app.register(
    (instance) => {
      const scope = instance.withTypeProvider<ZodTypeProvider>();

      scope.get(
        HEALTH_ROUTE,
        {
          schema: {
            tags: [HEALTH_TAG],
            summary: 'Liveness and readiness for compose',
            response: { 200: HealthResponse, 503: HealthResponse },
          },
        },
        async (_request, reply) => {
          const database = await probe(() => db.$queryRaw`SELECT 1`, HEALTH_DATABASE_TIMEOUT_MS);
          // The readiness wait is what makes the Redis answer mean "this process cannot reach
          // Redis" rather than "the connection has not finished connecting": the `client`-role
          // connection rejects a command issued before its first `ready` (server-core's own
          // contract for it), so a straight `PING` would report `fail` on the very first probe
          // after every start — the probe compose gates the whole stack's readiness on. Once a
          // probe has answered, that connection is ready for every later command.
          const redisCheck = await probe(
            () =>
              waitForRedisReady(redis.client, HEALTH_REDIS_TIMEOUT_MS).then(() =>
                redis.client.ping(),
              ),
            HEALTH_REDIS_TIMEOUT_MS,
          );

          if (database === 'ok' && redisCheck === 'ok') {
            reply
              .code(HEALTHY_STATUS)
              .send({ status: 'ok', checks: { database, redis: redisCheck } });
            return;
          }

          // A degraded answer names which dependency failed and nothing else: never the driver's
          // message, a host name or a connection string (AAP 0.11.1).
          reply
            .code(DEGRADED_STATUS)
            .send({ status: 'degraded', checks: { database, redis: redisCheck } });
        },
      );
    },
    { prefix: API_PREFIX },
  );

  /**
   * The one close hook (AAP 0.3.2): stop the background work, then give back what this app built, in
   * that order — a pass still in flight would otherwise use a connection that is already closed.
   *
   * Each step is attempted and its failure logged, and no failure stops the steps after it: a Redis
   * that refuses `QUIT` during a shutdown must not leave Prisma connected. The injected dependencies
   * are not touched — their owner closes them.
   */
  app.addHook('onClose', async () => {
    await shutdownStep(logger, 'background', async () => {
      const stop = backgroundStops.get(app);
      if (stop !== undefined) {
        backgroundStops.delete(app);
        await stop();
      }
    });

    const runningPubSub = pubsub;
    if (runningPubSub !== undefined) {
      await shutdownStep(logger, 'pubsub', () => runningPubSub.close());
    }

    await shutdownStep(logger, 'queues', () => queues.close());

    if (ownsRedis) {
      await shutdownStep(logger, 'redis', () => redis.close());
    }

    if (ownsDb) {
      await shutdownStep(logger, 'database', () => db.$disconnect());
    }
  });

  return app;
}

/*
 * Background work (AAP 0.3.2, 0.5.3, 0.5.6)
 */

/**
 * Start the API's background work and hand back the function that stops it (AAP 0.3.2, 0.5.6).
 *
 * Four things start, in this order: the in-process `settlement` worker, which runs the delayed
 * `settle`, `lapse`, `remind` and `dispute-escalate` jobs; the 60-second sweeper under
 * `pg_try_advisory_lock`, which settles overdue meetups and resumes unfinished payment operations
 * even when Redis or BullMQ is down; the outbox poller, which delivers the rows every domain
 * transaction wrote; and the pub/sub subscriptions, which carry chat and meetup state between
 * instances.
 *
 * Idempotent: the stop function is recorded in the same synchronous stretch that starts the work, so
 * a second call — even one made in the same tick — returns the first one's function rather than
 * starting a second worker.
 *
 * @param app - the app {@link buildApp} returned; nothing is started for an app that was never built.
 * @returns the stop function, which also closes whatever is still in flight. It is the function the
 *   `onClose` hook awaits.
 */
export function startBackground(app: App): Promise<() => Promise<void>> {
  const alreadyStarted = backgroundStops.get(app);
  if (alreadyStarted !== undefined) {
    return Promise.resolve(alreadyStarted);
  }

  const services = app.services;
  const stopWorker = startSettlementWorker(services);
  const stopSweeper = startSweeper(services, SWEEPER_INTERVAL_MS);
  const stopOutbox = services.outbox.start(OUTBOX_POLL_INTERVAL_MS);

  /**
   * Stop the three loops and wait for their work: the sweeper's pass and the outbox's pass in flight,
   * then the settlement worker's active job. The worker is last because it is the one that spends
   * money, and a pass that is already running must be allowed to finish its bookkeeping first.
   */
  const stop = async (): Promise<void> => {
    await stopSweeper();
    await stopOutbox();
    await stopWorker();
  };

  backgroundStops.set(app, stop);

  // `start` subscribes and never rejects: an unreachable Redis delays this instance's fan-out and is
  // retried by the module itself, so it must not fail the caller's startup.
  return services.pubsub.start().then(() => stop);
}

/*
 * Helpers (AAP 0.5.4, 0.5.6, 0.11.1, 0.12.2)
 */

/**
 * The provider configuration the language-model adapter is built from (AAP 0.6.2): the parsed `llm`
 * group as the adapter's own config type, so the mode and its credentials stay one value.
 */
function llmAdapterConfig(env: ApiEnv): LlmAdapterConfig {
  return env.llm.provider === 'openai'
    ? { provider: 'openai', apiKey: env.llm.apiKey, model: env.llm.model }
    : { provider: 'fake' };
}

/**
 * The telephony client the environment's mode names (AAP 0.6.2).
 *
 * `off` is `null` and not a client that refuses everything: the voice routes answer on the strength
 * of it (`assertTwilioSignature` refuses a callback when it is `null`), and `TELEPHONY_MODE=off` is
 * the credential-free default of the compose stack. Absent optionals are omitted rather than
 * assigned as `undefined`, which `exactOptionalPropertyTypes` requires and the client's own contract
 * states.
 *
 * @param env - the loaded environment.
 * @param httpClient - a transport to build the client on, from `AppDeps`.
 * @returns the client, or `null` in `off` mode.
 */
function telephonyFor(
  env: ApiEnv,
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
    ...(telephony.mode === 'simulator' && telephony.simulatorUrl !== undefined
      ? { simulatorUrl: telephony.simulatorUrl }
      : {}),
    ...(httpClient === undefined ? {} : { httpClient }),
  });
}

/**
 * The tagged-template SQL executor the spend store is built on (AAP 0.5.6, 0.11.2): every statement
 * the meter issues is parameterized and goes through the guarded client, so no query string is ever
 * assembled by hand.
 */
function databaseSql(db: DbClient) {
  return <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> =>
    db.$queryRaw<T>(strings, ...values);
}

/**
 * The IANA zone of a configured city (AAP 0.5.6), read through the registry's cached parse of
 * `config/cities.json` so the file is read once per process.
 *
 * @param cityId - a city slug.
 * @returns the city's zone, for the local-day arithmetic the spend meter and the timers use.
 * @throws {Error} `unknown city` when no configured city carries that slug.
 */
function timezoneOfCity(cityId: string): string {
  const city = cityBySlug(cityId);
  if (city === undefined) {
    throw new Error('unknown city');
  }
  return city.timezone;
}

/**
 * Whether a response carries the Stripe timing (AAP 0.12.2): every mutating method, and the two
 * reads that write (AAP 0.5.4), which mark themselves in their route config because their method
 * cannot say so.
 */
function writesState(request: FastifyRequest): boolean {
  return (
    STATE_WRITING_METHODS.has(request.method.toUpperCase()) ||
    request.routeOptions.config.stateWritingRead === true
  );
}

/**
 * The `Server-Timing` value for the current request: the milliseconds spent in Stripe calls, rounded
 * to a whole millisecond, or `0` when the request called Stripe not at all.
 */
function stripeTimingValue(): string {
  return `${STRIPE_TIMING_METRIC};dur=${Math.round(currentStripeMs())}`;
}

/**
 * Refuse a route that would answer with no declared schema (AAP 0.5.4): a client reads the contract
 * from `docs/api/openapi.json`, and a response no schema describes is a route Fastify serializes
 * whatever it is given for.
 *
 * Four exemptions, each because such a route answers no JSON body to describe: a WebSocket route
 * carries frames rather than a response body; `HEAD` is derived by Fastify from its `GET` route and
 * answers no body at all; `OPTIONS` is the CORS preflight `@fastify/cors` registers for the allowlist
 * and answers with headers only; and a route that answers other bytes — the WebP photo and the TwiML
 * document — says so with `config.rawResponse`, because a schema there would put a JSON serializer in
 * front of them.
 *
 * @param route - the route Fastify is about to resolve.
 * @throws {Error} naming the method and path of a route that declares no schema.
 */
function assertResponseSchema(route: RouteOptions): void {
  if (route.websocket === true || route.wsHandler !== undefined) {
    return;
  }

  const methods = Array.isArray(route.method) ? route.method : [route.method];
  if (methods.some((method) => BODY_LESS_METHODS.has(method.toUpperCase()))) {
    return;
  }

  if (route.config?.rawResponse === true) {
    return;
  }

  if (route.schema !== undefined && route.schema.response !== undefined) {
    return;
  }

  throw new Error(
    `route_without_response_schema: ${methods.join(', ')} ${route.url} declares no schema.response and no config.rawResponse`,
  );
}

/**
 * Run one dependency's check for the health probe (AAP 0.5.4).
 *
 * The bound is a timer of its own rather than the injected clock: this is a liveness probe for a
 * process whose database may be gone, so it waits a fixed interval of real time and reads the result
 * as `ok` or `fail`. Nothing about the failure is returned or logged — the answer says which
 * dependency did not respond, and the log line an operator needs is the one the driver writes.
 *
 * @param operation - the check to run: `SELECT 1`, or a `PING` on the client connection.
 * @param timeoutMs - how long to wait for it.
 * @returns `ok` when it completed in time, `fail` when it rejected or ran out of time.
 */
async function probe(operation: () => Promise<unknown>, timeoutMs: number): Promise<'ok' | 'fail'> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('health_check_timeout'));
        }, timeoutMs);
      }),
    ]);
    return 'ok';
  } catch {
    return 'fail';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one shutdown step, recording its failure and carrying on (AAP 0.3.2).
 *
 * A line carries the step and the error's own short code, never the error object: pino writes an
 * error's message and stack as strings that key-based redaction cannot rewrite, and a connection
 * failure's message carries the host it reached (AAP 0.11.1).
 *
 * @param logger - the process logger.
 * @param step - the step's name, so an operator can tell which one failed.
 * @param run - the step itself.
 */
async function shutdownStep(
  logger: Logger,
  step: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    logger.error(
      { event: SHUTDOWN_STEP_FAILED, step, code: errorCode(error) },
      SHUTDOWN_STEP_FAILED,
    );
  }
}

/**
 * An error's own short `code`, for a log line: a Node system code (`ECONNREFUSED`), a driver code
 * (`P1001`) or an `AppError` code. Anything else reads as undefined, so a message can never ride out
 * under the key.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) ? code : undefined;
}
