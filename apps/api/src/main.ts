/**
 * The API process (AAP 0.5.1, 0.6.2, 0.8.1): the HTTP and WebSocket server and the in-process settlement
 * worker. It loads the `api` environment, refuses to start on a configuration the circuit's registries disagree
 * with, builds the app, listens, reports the database versions it is running against and starts the background
 * work.
 *
 * Failures end the process with one JSON line naming the event and, at most, an error's name and message — never
 * a variable's value, a URL or a key (AAP 0.11.1). `SIGTERM` and `SIGINT` log the signal, close the app and exit
 * 0; a second signal, or a `close()` that has not finished within ten seconds, exits 1, so a wedged dependency
 * cannot hold a container open. The app's own `onClose` hook stops the background work and closes the queues,
 * the connections and Prisma, which is why this file only has to call `app.close()`.
 */
import process from 'node:process';

import { Prisma } from '@tablemate/db';
import {
  EnvValidationError,
  createLogger,
  createTestClock,
  loadApiEnv,
  sanitizeLogMessage,
  systemClock,
} from '@tablemate/server-core';

import { buildApp, startBackground, type App } from './app.ts';
import { checkZkConfiguration } from './modules/proofs/registry.ts';

import type { ApiEnv, Clock, Logger } from '@tablemate/server-core';

/** The address the process listens on: every interface, because a container's proxy calls in. */
const LISTEN_HOST = '0.0.0.0';

/** How long a shutdown may take before the process exits 1 regardless (ten seconds). */
const CLOSE_TIMEOUT_MS = 10_000;

/** The one log event name per start, stop or failure path below (AAP 0.11.1). */
const ENV_INVALID = 'env_invalid';
const ZK_CONFIG_INVALID = 'zk_config_invalid';
const LISTEN_FAILED = 'listen_failed';
const DB_VERSIONS = 'db_versions';
const DB_VERSIONS_UNAVAILABLE = 'db_versions_unavailable';
const API_STARTED = 'api_started';
const API_STOPPING = 'api_stopping';
const UNHANDLED_REJECTION = 'unhandled_rejection';
const UNCAUGHT_EXCEPTION = 'uncaught_exception';

/** One row of the version query the startup line reports (AAP 0.4.2). */
interface DatabaseVersions {
  readonly postgres: string;
  readonly postgis: string;
}

const env = loadEnvironment();

/**
 * The `api` logger, built once and handed to `buildApp`: the same instance logs the startup lines
 * here and every request line, with the request id, in the app.
 */
const logger = createLogger({ name: 'api', level: env.LOG_LEVEL, appEnv: env.APP_ENV });

// A test process gets the movable clock the criterion tests drive through `POST /v1/test/clock`
// (AAP 0.11.2); every other environment gets the system one, which nothing can move.
const clock: Clock = env.APP_ENV === 'test' ? createTestClock({ mode: 'flowing' }) : systemClock;

assertZkConfiguration(env, logger);

const app = buildApp({ env, clock, logger });

installFailureHandlers(app);

await app.ready();

try {
  await app.listen({ host: LISTEN_HOST, port: env.API_PORT });
} catch (error) {
  // Nothing is listening, so nothing can be served or closed: the process ends here.
  app.log.fatal({ event: LISTEN_FAILED, code: errorCode(error) }, LISTEN_FAILED);
  process.exit(1);
}

installSignalHandlers(app);

// The versions are reported once, after the app is serving, so a database that is still starting
// delays neither the listen nor the health probe (AAP 0.4.2).
await logDatabaseVersions(app);

await startBackground(app);

app.log.info(
  {
    // Mode names and the port only: no URL, key or connection string is ever logged (AAP 0.11.1).
    event: API_STARTED,
    port: env.API_PORT,
    appEnv: env.APP_ENV,
    stripeMode: env.stripe.mode,
    telephonyMode: env.telephony.mode,
    llmProvider: env.llm.provider,
  },
  API_STARTED,
);

/**
 * Load the `api` environment, or end the process with the loader's own findings (AAP 0.6.2).
 *
 * They are written to stderr as one JSON line rather than through the logger, whose level is one of
 * the values that may have been refused. Each finding is a variable's name and a fixed reason; the
 * loader never quotes a value (AAP 0.12.2).
 */
function loadEnvironment(): ApiEnv {
  try {
    return loadApiEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(
        `${JSON.stringify({ level: 'fatal', event: ENV_INVALID, issues: error.issues })}\n`,
      );
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Refuse to serve when the circuit configuration on disk no longer matches the committed registries
 * (AAP 0.5.5). The check runs before the app is built and before anything listens, so a deployment
 * whose registries and issuer records disagree never begins accepting proofs it would verify against
 * the wrong root.
 *
 * The refusal is logged under `detail`, never under `reason`: the logger's redaction list censors
 * `reason` because a dispute or a report carries free text there, and the reason a process refused to
 * start is the one thing an operator has to read back, so it travels under a name the list does not
 * cover — the rule `guardReason` and `dropReason` follow (AAP 0.11.1). The text is an error's, and a
 * check that compares files on disk quotes the file it read, so it passes through the shared
 * sanitizer first: pino rewrites object fields and never a message.
 */
function assertZkConfiguration(env: ApiEnv, logger: Logger): void {
  try {
    checkZkConfiguration(env);
  } catch (error) {
    logger.fatal(
      { event: ZK_CONFIG_INVALID, detail: sanitizeLogMessage(errorMessage(error)) },
      ZK_CONFIG_INVALID,
    );
    process.exit(1);
  }
}

/**
 * End the process on an unhandled rejection or an uncaught exception: one fatal line carrying the
 * error's name and message — no stack, no request body and no header — an attempt to close the app
 * bounded by the same ten seconds, then exit 1.
 */
function installFailureHandlers(app: App): void {
  /**
   * Report `error` and end the process with status 1.
   */
  async function fail(error: unknown, event: string): Promise<void> {
    app.log.fatal(
      { event, name: errorName(error), message: sanitizeLogMessage(errorMessage(error)) },
      event,
    );
    const timer = setTimeout(() => {
      process.exit(1);
    }, CLOSE_TIMEOUT_MS);
    timer.unref();
    try {
      await app.close();
    } catch {
      // The process is ending and the close hook has already logged whichever step failed inside it;
      // there is nothing left to report and nothing left to retry.
    }
    process.exit(1);
  }
  process.on('unhandledRejection', (reason) => {
    void fail(reason, UNHANDLED_REJECTION);
  });
  process.on('uncaughtException', (error) => {
    void fail(error, UNCAUGHT_EXCEPTION);
  });
}

/**
 * Handle the two signals a container sends (AAP 0.11.2): log the signal, close the app, exit 0.
 *
 * A second signal, or a `close()` that has not finished within {@link CLOSE_TIMEOUT_MS}, exits 1, and
 * the timer is `unref`ed so it never holds an otherwise finished process open.
 */
function installSignalHandlers(app: App): void {
  /** Whether a shutdown is already running, which makes the next signal an escalation. */
  let shuttingDown = false;
  /**
   * Close the app and end the process.
   */
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    app.log.info({ event: API_STOPPING, signal }, API_STOPPING);
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    const timer = setTimeout(() => {
      process.exit(1);
    }, CLOSE_TIMEOUT_MS);
    timer.unref();
    await app.close();
    process.exit(0);
  }
  process.on('SIGTERM', (signal) => {
    void shutdown(signal);
  });
  process.on('SIGINT', (signal) => {
    void shutdown(signal);
  });
}

/**
 * Log the PostgreSQL and PostGIS versions the process is running against (AAP 0.4.2), or say that
 * they could not be read: the query runs once, after the app is serving, so a database that is still
 * starting costs a warning rather than a delayed listen.
 */
async function logDatabaseVersions(app: App): Promise<void> {
  try {
    const rows = await app.services.db.$queryRaw<DatabaseVersions[]>(
      Prisma.sql`SELECT version() AS postgres, postgis_full_version() AS postgis`,
    );
    const row = rows[0];
    if (row === undefined) {
      app.log.warn({ event: DB_VERSIONS_UNAVAILABLE }, DB_VERSIONS_UNAVAILABLE);
      return;
    }
    app.log.info({ event: DB_VERSIONS, postgres: row.postgres, postgis: row.postgis }, DB_VERSIONS);
  } catch {
    app.log.warn({ event: DB_VERSIONS_UNAVAILABLE }, DB_VERSIONS_UNAVAILABLE);
  }
}

/** An error's own `name`, or `unknown` for a rejection reason that is not an error. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * An error's own `message`, or its type for a rejection reason that is not an error: a value with no
 * message has nothing to report, and its own text is not a thing to write into a log line.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error;
}

/** An error's own short `code` (`EADDRINUSE`, `EACCES`), or undefined when it carries none. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
