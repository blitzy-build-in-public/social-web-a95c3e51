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
 */

import { Redis } from 'ioredis';
import { pino } from 'pino';

import { LOGGER_REDACT_CENSOR, LOGGER_REDACT_PATHS } from '../logger.ts';

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
 * The logger {@link logConnectionError} writes through. A library module owns no process logger —
 * `api`, `workers` and the seed each build theirs with `createLogger` — so this one is built here
 * with the workspace's own redaction paths and censor: the line is JSON on stdout carrying the
 * error's name, message and stack, and every field a process log line censors is censored here too.
 * It writes only when a connection fails and the caller supplied no handler.
 */
const fallbackLogger = pino({
  level: 'error',
  redact: { paths: [...LOGGER_REDACT_PATHS], censor: LOGGER_REDACT_CENSOR },
});

/**
 * Where an `'error'` event goes when the caller names no handler, so a connection failure is never
 * dropped silently.
 *
 * The listener is attached on every connection because ioredis otherwise prints an "Unhandled error
 * event" line, connection details included, for an event nobody listens to. A handler that the
 * listener skipped whenever the option was omitted would leave that listener doing nothing but
 * silencing ioredis, and the failure would reach neither the caller nor a log; this sink is what
 * makes "no handler named" mean "recorded here" rather than "lost".
 *
 * It records the error object the caller would have received. A connection failure's own error
 * carries its name, message (host and port) and errno fields and never the URL's credentials, so no
 * password reaches the line.
 */
function logConnectionError(error: Error): void {
  fallbackLogger.error({ err: error }, 'redis_connection_error');
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
 * @param options - `onError` receives every `'error'` event, connection failures included. A
 * listener is always attached, because ioredis otherwise prints an "Unhandled error event" line
 * carrying connection details. A caller that names no handler does not lose the event: it is
 * recorded by this module's own `redis_connection_error` line instead, so a connection failure is
 * never dropped silently. The error object is passed through unchanged, so the URL never reaches a
 * caller through this argument.
 * @returns the connection, still connecting and ready to be awaited.
 */
export function createRedisConnection(
  url: string,
  role: RedisRole,
  options?: { onError?: (error: Error) => void },
): Redis {
  const connection = new Redis(url, ROLE_OPTIONS[role]);
  const onError = options?.onError ?? logConnectionError;
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
