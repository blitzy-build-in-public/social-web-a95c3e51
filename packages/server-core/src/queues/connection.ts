import { performance } from 'node:perf_hooks';

import { Redis } from 'ioredis';

import type { Logger } from '../logger.ts';

/**
 * What a connection is for, which fixes its options (AAP 0.3.2): `worker` for a BullMQ `Worker` or
 * `QueueEvents`, `producer` for BullMQ `Queue` instances, and `client` for the rate-limit store,
 * pub/sub, the caches and the language-model suspension flag.
 */
export type RedisRole = 'worker' | 'producer' | 'client';

interface RoleConnectionOptions {
  maxRetriesPerRequest: number | null;
  enableOfflineQueue: boolean;
  connectTimeout?: number;
  commandTimeout?: number;
  connectionName: string;
}

const FAIL_FAST_TIMEOUT_MS = 5000;

const FAIL_FAST_OPTIONS: Omit<RoleConnectionOptions, 'connectionName'> = Object.freeze({
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: FAIL_FAST_TIMEOUT_MS,
  commandTimeout: FAIL_FAST_TIMEOUT_MS,
});

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

/** The shortest gap between two Redis-failure lines for one {@link throttleRedisFailure} key. */
export const REDIS_UNAVAILABLE_LOG_INTERVAL_MS = 30_000;

const FAILURE_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function failureToken(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'Error';
  }
  const { code, name } = error as { code?: unknown; name?: unknown };
  const token = typeof code === 'string' && code.length > 0 ? code : name;
  return typeof token === 'string' && FAILURE_TOKEN_PATTERN.test(token) ? token : 'Error';
}

const lastReportedAtByKey = new Map<string, number>();

/** Run `report()` at most once per `key` per {@link REDIS_UNAVAILABLE_LOG_INTERVAL_MS} window. */
export function throttleRedisFailure(key: string, report: () => void): void {
  const now = performance.now();
  const reportedAt = lastReportedAtByKey.get(key);
  if (reportedAt !== undefined && now - reportedAt < REDIS_UNAVAILABLE_LOG_INTERVAL_MS) {
    return;
  }
  lastReportedAtByKey.set(key, now);
  report();
}

/** Report one Redis connection failure through the process logger, once per role per window. */
export function reportRedisUnavailable(logger: Logger, role: RedisRole, error: unknown): void {
  throttleRedisFailure(`connection:${role}`, () => {
    logger.warn(
      { event: 'redis_unavailable', role, code: failureToken(error) },
      'redis_unavailable',
    );
  });
}

/** Create the connection a consumer of `role` works on (AAP 0.3.2). */
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

/** Resolve once `connection` can serve commands, or reject with `redis_not_ready` (AAP 0.3.2). */
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
