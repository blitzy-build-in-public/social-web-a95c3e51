/**
 * Role-specific Redis connections, the only place a connection is built (AAP 0.3.2).
 *
 * The split exists for failure isolation. A `producer` connection fails a command as soon as Redis
 * cannot serve it, so `dispatchPending()` leaves an `OutboxMessage` for the next two-second pass
 * instead of hanging the commit hook that wrote it, and a rate-limited route answers
 * `503 service_unavailable` rather than running unthrottled while Redis is down. A `worker`
 * connection instead waits, because BullMQ's blocking commands are meant to block and a worker has
 * to resume after a reconnect.
 *
 * The URL comes from the host process's validated environment (`REDIS_URL`) and may carry a
 * password: it is never logged, echoed in an error or folded into a connection name.
 *
 * A connection reports a failure through the process logger its caller hands in, and that argument
 * is required: this module owns no logger, because `api`, `workers` and the seed each build theirs
 * with `createLogger`, which is what binds `service`, writes an ISO `time` and applies the
 * workspace's redaction paths. The line is {@link reportRedisUnavailable}, throttled per role to
 * {@link REDIS_UNAVAILABLE_LOG_INTERVAL_MS} by {@link throttleRedisFailure}, carrying the role and a
 * bounded failure token rather than the error itself. That one throttle is what bounds every listener
 * reporting the same outage — a `Queue`'s, a `Worker`'s, the in-process settlement worker's and the
 * pub/sub subscriber's — so a Redis that is down writes a few lines a minute rather than hundreds.
 */

import { performance } from 'node:perf_hooks';

import { Redis } from 'ioredis';

import type { Logger } from '../logger.ts';

/**
 * What a connection is for, which fixes its options (AAP 0.3.2): `worker` for a BullMQ `Worker` or
 * `QueueEvents`, `producer` for BullMQ `Queue` instances, and `client` for the rate-limit store,
 * pub/sub, the caches and the language-model suspension flag.
 */
export type RedisRole = 'worker' | 'producer' | 'client';

/**
 * The ioredis options this file sets, and only those — deliberately narrower than ioredis' own
 * `RedisOptions`. That type marks `replyMapping` as `ReplyMappingMode | undefined`, which the
 * constructor's parameter type (the same options without the `undefined`) refuses to accept under
 * `exactOptionalPropertyTypes`, so the role table below cannot be annotated with it.
 */
interface RoleConnectionOptions {
  maxRetriesPerRequest: number | null;
  enableOfflineQueue: boolean;
  connectTimeout?: number;
  commandTimeout?: number;
  connectionName: string;
}

/**
 * How long a fail-fast connection waits, both for the socket and for a reply on an open one. A
 * paused or unreachable server otherwise leaves a command in flight indefinitely — the hang the
 * outbox dispatcher and the rate limiter must not inherit.
 */
const FAIL_FAST_TIMEOUT_MS = 5000;

/**
 * Options for a connection that never queues behind an outage: a command issued while Redis is
 * unreachable, or left unanswered for {@link FAIL_FAST_TIMEOUT_MS}, rejects. One retry covers a
 * reconnect already under way; the offline queue is off so nothing waits for the next `ready`.
 *
 * `commandTimeout` is what covers a socket left open while nothing answers it — a paused server or
 * a stalled host, neither of which resets the connection. The connect timeout bounds the first
 * connection only, so without it a command waits forever and the write that issued it hangs too.
 */
const FAIL_FAST_OPTIONS: Omit<RoleConnectionOptions, 'connectionName'> = Object.freeze({
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: FAIL_FAST_TIMEOUT_MS,
  commandTimeout: FAIL_FAST_TIMEOUT_MS,
});

/**
 * One frozen option set per role. `connectionName` shows in `CLIENT LIST`, which is how a
 * connection is told apart from its siblings, and ioredis' own reconnect strategy is left in place
 * for all three roles. A `worker` connection carries no command timeout on purpose: the blocking
 * commands BullMQ runs on it are meant to wait.
 */
const ROLE_OPTIONS: Readonly<Record<RedisRole, RoleConnectionOptions>> = Object.freeze({
  worker: Object.freeze<RoleConnectionOptions>({
    // BullMQ rejects any other value on a blocking connection: it must be able to block on a job.
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    connectionName: 'tablemate-worker',
  }),
  producer: Object.freeze<RoleConnectionOptions>({
    ...FAIL_FAST_OPTIONS,
    connectionName: 'tablemate-producer',
  }),
  client: Object.freeze<RoleConnectionOptions>({
    ...FAIL_FAST_OPTIONS,
    connectionName: 'tablemate-client',
  }),
});

/**
 * The shortest gap between two Redis-failure lines for one {@link throttleRedisFailure} key.
 *
 * ioredis reconnects on its own strategy — an attempt every `times × 50 ms`, capped at 2 s — and
 * emits one `'error'` per failed attempt, so an unreachable Redis would otherwise write a line every
 * couple of seconds for as long as the outage lasts and bury the first failure, which is the one an
 * operator reads. The first failure is written immediately; 30 000 ms then holds a key to at most two
 * lines a minute, which still reports the latest failure but never floods the log.
 *
 * The window belongs to a key, and a connection reports under one key per role, so every connection
 * of a role shares one window while the producer side, each BullMQ `Worker` and the in-process
 * settlement worker keep their own. The interval is exported so the number and its reason live in one
 * place, beside the throttle everything uses.
 */
export const REDIS_UNAVAILABLE_LOG_INTERVAL_MS = 30_000;

/** The safe shape a logged failure token may have: a short identifier and nothing else. */
const FAILURE_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * A failed connection's own short token, for the `redis_unavailable` line (AAP 0.11.1).
 *
 * It is the error's own `code` when that is a plain short identifier (`ECONNREFUSED`, `ETIMEDOUT`,
 * `ENOTFOUND`), its class name otherwise, and `Error` for anything that is neither. The error's
 * message and stack are deliberately not logged: pino writes both as strings, which key-based
 * redaction cannot rewrite, and a connection failure's message names the host and port it could not
 * reach while a driver's can quote the value it objected to. A code or a class name tells an operator
 * which failure to look for without carrying one, the same rule every other failure listener in this
 * workspace follows.
 */
function failureToken(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'Error';
  }

  const { code, name } = error as { code?: unknown; name?: unknown };
  const token = typeof code === 'string' && code.length > 0 ? code : name;

  return typeof token === 'string' && FAILURE_TOKEN_PATTERN.test(token) ? token : 'Error';
}

/**
 * When each key last wrote a Redis-failure line, as a `performance.now()` reading.
 *
 * One map for the whole process rather than one reading per connection, because the connections of a
 * role observe the same outage and the listeners beside them report the same failures: this is what
 * holds them to one line per window between them. The readings are monotonic, never the wall clock, so
 * a system time change cannot silence the next failure or repeat a line, and the keys are the fixed
 * role names, the queue names and the two named consumers, so the map is bounded by what the process
 * watches rather than by how long the outage lasts.
 */
const lastReportedAtByKey = new Map<string, number>();

/**
 * Run `report()` at most once per `key` per {@link REDIS_UNAVAILABLE_LOG_INTERVAL_MS} window.
 *
 * A Redis that is down makes every consumer of it fail at once and keep failing: ioredis emits one
 * `'error'` per reconnect attempt on every connection it owns, and the one outage reaches a `Queue`,
 * a `Worker`, the in-process settlement worker and the pub/sub subscriber together. An unthrottled
 * listener therefore writes hundreds of lines a minute and buries the first one, which is the one an
 * operator reads. The first call for a key runs `report()` at once, and a later one inside the window
 * is dropped, so a long outage still reports itself on that cadence rather than not at all.
 *
 * The window is per key for the whole process, so callers watching the same failure share it:
 * {@link reportRedisUnavailable} keys a connection failure by role, and the queue, worker and
 * subscriber listeners key their own by what they watch.
 *
 * @param key - what failed, as `<scope>:<name>` — a connection's role, a queue, or a named consumer.
 * @param report - the line to write; it runs only when the window allows one.
 */
export function throttleRedisFailure(key: string, report: () => void): void {
  const now = performance.now();
  const reportedAt = lastReportedAtByKey.get(key);

  if (reportedAt !== undefined && now - reportedAt < REDIS_UNAVAILABLE_LOG_INTERVAL_MS) {
    return;
  }

  lastReportedAtByKey.set(key, now);
  report();
}

/**
 * Report one Redis connection failure through the process logger, once per role per window.
 *
 * The line is the shape every other failure listener in this workspace writes — an `event`, the scope
 * it happened in and a bounded token — so it is a structured line inside the process logger's JSON,
 * with the `service` binding, the ISO `time` and the workspace's redaction paths applied (AAP 0.3.2,
 * 0.11.1). It carries the connection's `role` and the failure's own short `code`, and never the error:
 * no message and no stack, because pino writes both as strings that key-based redaction cannot rewrite
 * and a connection failure's message names the host and port it could not reach.
 *
 * The throttle key is the role, not the connection: a `Queue` re-reports its connection's failures
 * under the same role, and the connections of one role observe one outage, so all of them together
 * write one line per {@link REDIS_UNAVAILABLE_LOG_INTERVAL_MS}. That is what makes the first line an
 * operator reads the whole report of that outage, whether it was noticed by a connection, a producer
 * or a consumer.
 *
 * @param logger - the process logger the warning is written through.
 * @param role - the failing connection's role, written on the line.
 * @param error - the failure; only its bounded {@link failureToken} reaches the line.
 */
export function reportRedisUnavailable(logger: Logger, role: RedisRole, error: unknown): void {
  throttleRedisFailure(`connection:${role}`, () => {
    logger.warn(
      { event: 'redis_unavailable', role, code: failureToken(error) },
      'redis_unavailable',
    );
  });
}

/**
 * Create the connection a consumer of `role` works on (AAP 0.3.2).
 *
 * The connection is not ready to command yet: await {@link waitForRedisReady} before the first
 * command, because a fail-fast connection rejects anything issued before its first `ready`. One
 * connection serves one consumer, and the roles are not interchangeable — a `worker` connection
 * belongs to a BullMQ `Worker` or `QueueEvents` alone, since a `Queue` on it would inherit the
 * blocking options, and a `producer` connection drives `Queue` instances. A pub/sub subscriber
 * needs its own `client` connection, because a subscribed connection can issue no other command;
 * ioredis' `autoResubscribe` restores its subscriptions after a reconnect.
 *
 * @param url - the Redis URL from the host process's validated environment (`REDIS_URL`).
 * @param role - the connection's role, which selects its options.
 * @param options - `logger` is the process logger this connection reports failures through and is
 *   required, because this module owns no logger of its own and a connection whose failures would go
 *   nowhere must not be buildable. `onError` receives every `'error'` event instead, for a caller
 *   that has to react to one. A listener is attached either way, because ioredis otherwise prints an
 *   "Unhandled error event" line carrying connection details, and a caller that names no handler does
 *   not lose the event: it is recorded as the throttled {@link reportRedisUnavailable} warning, under
 *   this connection's role. The error object is passed through unchanged, so the URL never reaches a
 *   caller through this argument.
 * @returns the connection, still connecting and ready to be awaited.
 */
export function createRedisConnection(
  url: string,
  role: RedisRole,
  options: { logger: Logger; onError?: (error: Error) => void },
): Redis {
  const connection = new Redis(url, ROLE_OPTIONS[role]);
  const onError =
    options.onError ?? ((error: Error) => reportRedisUnavailable(options.logger, role, error));
  connection.on('error', (error: Error) => {
    onError(error);
  });
  return connection;
}

/**
 * Resolve once `connection` can serve commands, or reject with `redis_not_ready` (AAP 0.3.2).
 *
 * `apps/api/src/main.ts` and `apps/workers/src/main.ts` await this at startup, and `GET /v1/health`
 * reports `redis: 'fail'` when it rejects. A fail-fast connection rejects a command issued before
 * its first `ready` instead of queueing it, so this is what turns "not up yet" into one clear
 * startup failure rather than a request-time error.
 *
 * @param connection - the connection to wait for.
 * @param timeoutMs - how long to wait; the default covers a Redis that is still starting.
 * @returns a promise resolving on the `'ready'` event, immediately if it is already ready.
 * @throws Error `redis_not_ready` after `timeoutMs`. The listeners are removed either way.
 */
export function waitForRedisReady(connection: Redis, timeoutMs = 5000): Promise<void> {
  if (connection.status === 'ready') {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      connection.off('ready', onReady);
      reject(new Error('redis_not_ready'));
    }, timeoutMs);
    connection.once('ready', onReady);
  });
}
