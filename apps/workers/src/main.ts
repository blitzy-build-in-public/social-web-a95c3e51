/**
 * The workers process (AAP 0.5.1, 0.6.2, 0.8.1): every queue processor and recurring scheduler of `@tablemate/workers`. It
 * loads the `workers` environment, builds the context the jobs share, starts one BullMQ worker per consumed queue, registers
 * the schedulers, primes the FX table while no run has written it yet, and stops what it started on the first `SIGTERM` or
 * `SIGINT`.
 *
 * Process separation is what this entry point delivers (AAP 0.3.2): telephony, crawling, menu extraction and their
 * language-model calls run here and never in a request path. `settlement` is absent from the queues started here because the
 * API settles meetups in the one process holding the payment secret, and this process reads no payment variable in any mode:
 * `TELEPHONY_MODE=off` builds no telephony client and `LLM_PROVIDER=fake` reaches no provider, which is what
 * `docker compose up` relies on. The tests never import this file — they call `createWorkerContext` with a test clock and
 * drive the processors directly (AAP 0.11.2).
 *
 * Failures end the process with one JSON line carrying the event and, at most, an error's message after the shared
 * `sanitizeLogMessage` has removed the credentials, keys and addresses that text can quote: never a variable's value, a
 * connection string or a job payload. A refused environment is written to stderr before any logger exists.
 */

import process from 'node:process';

import {
  EnvValidationError,
  createLogger,
  loadWorkersEnv,
  sanitizeLogMessage,
  waitForRedisReady,
} from '@tablemate/server-core';

import { WORKER_QUEUES, closeWorkerContext, createWorkerContext, startWorkers } from './queues.ts';
import { primeFxTable, registerSchedulers } from './schedulers.ts';

import type { Logger, WorkersEnv } from '@tablemate/server-core';
import type { WorkerContext } from './queues.ts';

const ENV_INVALID = 'env_invalid';
const WORKERS_START_FAILED = 'workers_start_failed';
const WORKERS_STARTED = 'workers_started';
const WORKERS_STOPPING = 'workers_stopping';
const WORKERS_STOPPED = 'workers_stopped';
const UNHANDLED_REJECTION = 'unhandled_rejection';
const UNCAUGHT_EXCEPTION = 'uncaught_exception';
/** The signals a container sends, and the pair a shutdown re-arms as an escalation (AAP 0.11.2). */
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const STARTUP_FAILURE = 'startup_failure';
/** How long a shutdown may take before the process exits 1 regardless (ten seconds). */
const SHUTDOWN_TIMEOUT_MS = 10_000;
let logger: Logger | null = null;
// What a shutdown closes: the context every job shares, and the stop function once the queues are started. `stop` is absent while the start is still building the context, so a start that fails part way still closes what it opened.
let running: { readonly ctx: WorkerContext; readonly stop?: () => Promise<void> } | null = null;
let stopping = false;
// Brings the process up (AAP 0.5.6): loads and validates the configuration, builds the context, starts every consumed queue, registers the recurring schedulers and primes the FX table when it is still empty. A failure of any of those steps is a start failure, not a job failure — nothing here would be retried into working — so it is recorded once, what was opened is closed, and the process exits 1 for an orchestrator's restart policy to answer. `main` therefore never throws to its caller.
async function main(): Promise<void> {
  const env = loadEnvironment();
  const activeLogger = createLogger({ name: 'workers', level: env.LOG_LEVEL, appEnv: env.APP_ENV });
  logger = activeLogger;
  try {
    const ctx = await createWorkerContext(env, { logger: activeLogger });
    running = { ctx };
    // The `client` connection is fail-fast: a command issued before its first `ready` rejects rather than waiting, so a Redis that is still starting would fail the first job to reach for a cache. Waiting here turns that into a moment of startup delay.
    await waitForRedisReady(ctx.redis);
    running = { ctx, stop: startWorkers(ctx) };
    await registerSchedulers(ctx);
    // A stack younger than its first 00:30 UTC holds no `FxRate` row, so every non-USD price entry would be refused until that run: the delivered job is enqueued once here (AAP 0.5.6).
    await primeFxTable(ctx);
    // Mode names, queue names and a boolean: no URL, key or job payload is ever logged (AAP 0.11.1).
    activeLogger.info(
      {
        event: WORKERS_STARTED,
        queues: WORKER_QUEUES,
        appEnv: env.APP_ENV,
        telephonyMode: env.telephony.mode,
        llmProvider: env.llm.provider,
        push: ctx.push !== null,
      },
      WORKERS_STARTED,
    );
  } catch (error) {
    activeLogger.fatal(
      { event: WORKERS_START_FAILED, error: sanitizeLogMessage(errorMessage(error)) },
      WORKERS_START_FAILED,
    );
    await shutdown(STARTUP_FAILURE, 1);
  }
}

// Handles the two signals a container sends (AAP 0.11.2): `SIGTERM` from an orchestrator draining the process and `SIGINT` from a terminal. Registered with `process.once`, so the stop is asked for once and {@link shutdown} itself re-arms both signals as the escalation a repeat means.
function installSignalHandlers(): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      void shutdown(signal, 0);
    });
  }
}

// Stops the process on a failure nothing caught (AAP 0.11.2): an unhandled rejection and an uncaught exception, the
// pair the API process installs too. Node's default would end it with a bare stack and hand the queues, the browser,
// Redis and PostgreSQL back to the kernel; recording the event and closing them first is what leaves a container in a
// known state.
//
// A reason and a thrown value carry text this file did not write, and a credential quoted in it — a connection
// string's userinfo, a key, a bearer token, an address — would otherwise reach the line verbatim, so the message
// travels through the shared `sanitizeLogMessage` (AAP 0.11.1).
function installFailureHandlers(): void {
  process.on('unhandledRejection', (reason: unknown) => {
    logger?.error(
      { event: UNHANDLED_REJECTION, error: sanitizeLogMessage(errorMessage(reason)) },
      UNHANDLED_REJECTION,
    );
    void shutdown(UNHANDLED_REJECTION, 1);
  });
  process.on('uncaughtException', (error: unknown) => {
    logger?.error(
      { event: UNCAUGHT_EXCEPTION, error: sanitizeLogMessage(errorMessage(error)) },
      UNCAUGHT_EXCEPTION,
    );
    void shutdown(UNCAUGHT_EXCEPTION, 1);
  });
}

// Stops everything this process started, once, and ends the process with `exitCode` (AAP 0.11.2). Idempotent by the `stopping` flag: a second signal, or a failure arriving while the first shutdown is still draining, ends the process at once with status 1 rather than starting a second close. `process.exit` is the last statement of every path, so this promise never settles.
async function shutdown(cause: string, exitCode: number): Promise<void> {
  if (stopping) {
    process.exit(1);
  }
  stopping = true;
  // The first shutdown is draining and the `once` listener that started it is spent, so a further signal only escalates. Re-arming both is what answers it; the container's own stop timeout is the backstop behind this.
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      process.exit(1);
    });
  }
  const active = running;
  running = null;
  logger?.info({ event: WORKERS_STOPPING, signal: cause }, WORKERS_STOPPING);
  // A close that refuses to finish must not hold a container open: the same backstop the API process uses, and `unref`ed so an orderly close leaves no timer behind.
  const timer = setTimeout(() => {
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  if (active !== null) {
    // The workers drain first, because BullMQ's `close` waits for the job each one is running; the context then closes the browser, the producers, the mailer, Redis and PostgreSQL. Each step contains its own failure and records it (`queues.ts`), so one resource that will not close strands no other.
    await active.stop?.();
    await closeWorkerContext(active.ctx);
  }
  logger?.info({ event: WORKERS_STOPPED, signal: cause }, WORKERS_STOPPED);
  process.exit(exitCode);
}

// Loads the `workers` environment, or ends the process with the loader's own findings (AAP 0.6.2). They are written to stderr as one JSON line rather than through the logger, whose level is one of the values that may have been refused. Each finding is a variable's name and a fixed reason: the loader never quotes a value (AAP 0.12.2).
function loadEnvironment(): WorkersEnv {
  try {
    return loadWorkersEnv();
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

/** An error's own `message`, or its type for a rejection reason that is not an error: a value with no message has nothing to report, and its own text is not a thing to write into a log line. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error;
}

// Handlers first, so a stop signal that arrives during the start is answered rather than killing a process part way through opening its connections.
installSignalHandlers();
installFailureHandlers();
await main().catch((error: unknown) => {
  // Reachable only for a failure `main` does not classify itself — a defect in the environment loader rather than a configuration it refused — and then no logger exists to report it through.
  process.stderr.write(
    `${JSON.stringify({
      level: 'fatal',
      event: WORKERS_START_FAILED,
      error: sanitizeLogMessage(errorMessage(error)),
    })}\n`,
  );
  process.exit(1);
});
