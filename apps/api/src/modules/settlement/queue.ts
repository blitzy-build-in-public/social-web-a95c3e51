/**
 * The in-process `settlement` worker: the delayed `settle`, `lapse`, `remind` and `dispute-escalate` jobs that
 * `./timers.ts` schedules, consumed by `apps/api` itself, because the API is the one process holding the Stripe
 * secret.
 *
 * - **A timer is latency, never a guarantee.** BullMQ fires by wall-clock time while the application's time comes
 *   from `services.clock`, which a test run holds still, so each handler re-reads the row it names, re-checks the
 *   instant its action is due and does nothing when it is early; the 60-second sweeper settles, lapses and
 *   escalates by the app clock whether or not a single job ever arrives.
 * - **A Redis outage never stops the API.** The connection is opened here, for this consumer alone, in the `worker`
 *   role — the only one that waits out a reconnect instead of failing a command — and the `error` listener keeps a
 *   connection failure from reaching the process as an unhandled event.
 * - **Every handler is idempotent, and throws only to ask for a retry.** A throw is what the producer's job options
 *   retry, so each handler either no-ops on a row another path already moved or delegates to a function that is
 *   itself idempotent: `MeetupSettlement.meetupId`, the unique `WitnessEvent` and `TableCreditEntry` keys and the
 *   payment operations' idempotency keys make a second run a no-op.
 *
 * No Stripe call is made here: `settleMeetup` plans the provider calls and `runOperationsFor` executes them once its
 * transaction has committed. The queue's names, payload schemas and the guard that narrows a name come from
 * `@tablemate/server-core`, so a renamed job fails this file's typecheck instead of leaving a handler unreachable.
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';

import {
  JOB,
  QUEUE,
  QueuePayloadError,
  createRedisConnection,
  isJobName,
  parseJobData,
  throttleRedisFailure,
  withJobId,
} from '@tablemate/server-core';
import type { JobDataByQueueAndName, JobName } from '@tablemate/server-core';
import { NotificationKind } from '@tablemate/shared';

import { loadMeetup } from '../meetups/queries.ts';
import { notifyAll } from '../notifications/enqueue.ts';
import type { UserNotificationKind } from '../notifications/enqueue.ts';
import { transact } from '../outbox/write.ts';
import { runOperationsFor } from '../payments/operations.ts';

import { escalateDisputeIfDue, lapseIfDue, settleMeetup } from './settle.ts';
import { settleDueAt } from './timers.ts';

import type { AppServices } from '../../app.ts';

/** The four job names the `settlement` queue accepts, as `names.ts` writes them. */
type SettlementJobName = JobName<typeof QUEUE.settlement>;

/** The parsed data of every one of those jobs, keyed by the name it arrived under. */
type SettlementJobData = JobDataByQueueAndName[typeof QUEUE.settlement];

/**
 * What one job did, for the `settlement_job_done` line alone (AAP 0.11.1): one token, and never a
 * payload, a row, a client secret or a provider identifier.
 *
 * The first four words are `SettleResult`'s own, so a settlement reports what it decided; the rest say
 * what this file's own guards found — a proposal that has not reached its deadline, a meetup that has
 * left `locked`, or a dispute that is not yet due.
 */
export type SettlementJobResult =
  | 'settled'
  | 'postponed'
  | 'lock_lost'
  | 'noop'
  | 'lapsed'
  | 'not_due'
  | 'reminded'
  | 'not_locked'
  | 'escalated';

/** One handler, handed the parsed data of the very job name it was looked up by. */
type SettlementJobHandler<J extends SettlementJobName> = (
  services: AppServices,
  data: SettlementJobData[J],
) => Promise<SettlementJobResult>;

/**
 * One `settlement` job as the worker hands it to the processor: `data` is unparsed (`unknown`) until
 * {@link processSettlementJob} parses it, the result is the token its handler resolved with, and the
 * name stays a plain string, because a name this queue does not accept has to become a
 * {@link QueuePayloadError} at the boundary rather than a compile-time impossibility.
 */
type SettlementJob = Job<unknown, SettlementJobResult, string>;

/** The worker this file starts, named for the two signatures it appears in. */
type SettlementWorker = Worker<unknown, SettlementJobResult, string>;

/**
 * How many jobs this worker runs at once: four.
 *
 * More would not settle more meetups. Each settlement retrieves two authorizations and then writes
 * under the meetup row lock, so a fifth concurrent job would wait on a lock a sibling holds, and four
 * keeps a burst of timers from taking the whole connection pool away from the API's own requests.
 */
const SETTLEMENT_CONCURRENCY = 4;

/**
 * The reminder both attendees are sent at `startsAt - 15 min`, the instant check-in opens (AAP 0.5.3).
 *
 * The value comes from the shared enum rather than being spelled out, so a rename there fails this
 * file's typecheck instead of routing the reminder as an unknown kind. `UserNotificationKind` is the
 * notification module's own exclusion of `magic_link`, the one kind addressed to a token rather than
 * to a recipient.
 */
const REMINDER_KIND: UserNotificationKind = NotificationKind.enum.meetup_reminder;

/** The safe shape a logged failure token may have: a short identifier and nothing else. */
const FAILURE_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Start the in-process `settlement` worker and return the function that stops it (AAP 0.3.2, 0.5.6).
 *
 * `startBackground` in `app.ts` calls this once, after the app is listening, and registers the returned
 * stop function on the app's close hook. Nothing here awaits Redis, so a queue that is down when the
 * API starts costs a delay in settlement rather than a failed start.
 *
 * The connection belongs to this consumer alone. A `worker` connection carries no command timeout,
 * because BullMQ's blocking fetch is meant to block; the fail-fast `client` connection (the rate-limit
 * store, the caches, pub/sub) and a `producer` connection (a `Queue`, which must fail a command during
 * an outage rather than queue it) are the wrong shape for a consumer and are never lent to one. BullMQ
 * duplicates the instance for its own use and leaves it open when the worker closes, which is why
 * {@link stopWorker} quits it afterwards.
 *
 * Retry and backoff are deliberately absent: they travel with each job, from
 * `jobOptionsFor(QUEUE.settlement)` on the producer side, which is what gives this queue its five
 * attempts from 10 s.
 *
 * @param services - The app's services: the database, the injected clock, the logger, the payment
 *   gateway and the outbox dispatcher every handler below needs.
 * @returns A function that closes the worker and its connection, resolving on every later call too.
 */
export function startSettlementWorker(services: AppServices): () => Promise<void> {
  const connection = createRedisConnection(services.env.REDIS_URL, 'worker', {
    logger: services.logger,
  });
  const worker: SettlementWorker = new Worker<unknown, SettlementJobResult, string>(
    QUEUE.settlement,
    // The job id is bound here, at the hand-off, so the `settlement_job_done` line and every line a
    // handler writes name the job they belong to (AAP 0.11.1). The copy owns nothing — `services`
    // keeps the connections, the gateway and the dispatcher — so nothing here is closed or registered
    // anywhere, and the exported `processSettlementJob(services, name, data)` signature its own tests
    // drive is unchanged. A job carrying no id leaves the context as it is.
    (job: SettlementJob) =>
      processSettlementJob(
        job.id === undefined
          ? services
          : { ...services, logger: withJobId(services.logger, job.id) },
        job.name,
        job.data,
      ),
    { connection, concurrency: SETTLEMENT_CONCURRENCY },
  );

  // The `failed` listener logs the job's name and id, the attempts made and the failure's own short
  // token; the `error` listener logs that token alone, because no job is in hand. Neither logs an
  // error message or a stack. The `error` listener is not optional: an 'error' event with no listener
  // is thrown, and a Redis outage must never take the API process down (AAP 0.3.2). It is throttled
  // because that outage fires it on every reconnect attempt: the first failure is written at once and
  // a later one waits out the throttle's window, so the API reports the outage without writing a line
  // per attempt into the same log every request line goes to.
  worker.on('failed', (job: SettlementJob | undefined, error: Error) => {
    services.logger.warn({
      event: 'settlement_job_failed',
      job: job?.name,
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      code: failureToken(error),
    });
  });
  worker.on('error', (error: Error) => {
    throttleRedisFailure('settlement-worker', () => {
      services.logger.error({ event: 'settlement_worker_error', code: failureToken(error) });
    });
  });

  let stopping: Promise<void> | null = null;

  return function stop(): Promise<void> {
    stopping ??= stopWorker(services, worker, connection);
    return stopping;
  };
}

/**
 * Process one `settlement` queue job (AAP 0.5.3, 0.5.6).
 *
 * Exported so a test can drive a handler without a running queue. The name is narrowed to the four
 * this queue accepts before its payload is parsed — the order `payloads.ts` documents — so an unknown
 * name is refused as a payload failure rather than being matched against no schema at all.
 *
 * A handler that throws is a handler asking for the retry its job was enqueued with; a handler that
 * returns has finished, whatever token it returned, and the debug line records which one it was.
 *
 * @param services - The app's services.
 * @param name - The job name, as BullMQ recorded it (`job.name`).
 * @param data - The job's data, unparsed (`job.data`); parsed here against the schema of `name`.
 * @returns The token saying what the job did, which BullMQ keeps as the job's result.
 * @throws QueuePayloadError when `name` is not one this queue accepts, or when `data` does not match
 *   the schema of that name. A handler's own failure propagates unchanged, so the queue retries it.
 */
export async function processSettlementJob(
  services: AppServices,
  name: string,
  data: unknown,
): Promise<SettlementJobResult> {
  if (!isJobName(QUEUE.settlement, name)) {
    throw new QueuePayloadError(`${QUEUE.settlement}/${name}`);
  }

  const jobData = parseJobData(QUEUE.settlement, name, data);
  const result = await runHandler(services, name, jobData);
  const scope =
    'disputeId' in jobData ? { disputeId: jobData.disputeId } : { meetupId: jobData.meetupId };

  services.logger.debug({ event: 'settlement_job_done', job: name, ...scope, result });

  return result;
}

/**
 * Run the settlement timer: settle a locked meetup whose window has closed (AAP 0.5.3, 0.5.7).
 *
 * The guard is this file's, and it exists because BullMQ counts wall-clock milliseconds while the due
 * instant is judged by the injected clock: a job that arrives while the app clock is still before
 * `startsAt + 45 min` does nothing at all, and the sweeper — which compares the same instants —
 * settles the meetup once the clock has moved. `settleMeetup` repeats both checks under the meetup row
 * lock, so nothing here decides an outcome.
 *
 * A `postponed` result is an open dispute and a normal completion: the dispute leaves the meetup
 * `locked` with check-in still open, and the settlement runs later, from the sweeper or from the
 * operator's resolution (AAP 0.5.3). The planned operations are then executed, whatever the settlement
 * decided — a run that postponed or found a lost hold may still have written releases.
 */
async function settleJob(
  services: AppServices,
  data: SettlementJobData['settle'],
): Promise<SettlementJobResult> {
  const meetup = await loadMeetup(services.db, data.meetupId);

  if (meetup === null || meetup.status !== 'locked') {
    return 'noop';
  }
  if (services.clock.nowMs() < settleDueAt(meetup.startsAt).getTime()) {
    return 'not_due';
  }

  const settled = await settleMeetup(services, data.meetupId, { trigger: 'timer' });
  await runOperationsFor(services, { meetupId: data.meetupId });

  return settled.result;
}

/**
 * Run the lapse timer: lapse a proposal whose recipient deadline has passed (AAP 0.5.3).
 *
 * `lapseIfDue` re-reads the deadline under the meetup row lock and compares it against the injected
 * clock, so an early job and a job for a proposal that was locked meanwhile both do nothing. The
 * transition it applies releases every non-final deposit attempt, and those releases are executed
 * here, after the commit that wrote them.
 */
async function lapseJob(
  services: AppServices,
  data: SettlementJobData['lapse'],
): Promise<SettlementJobResult> {
  const lapsed = await lapseIfDue(services, data.meetupId);

  if (!lapsed) {
    return 'not_due';
  }

  await runOperationsFor(services, { meetupId: data.meetupId });
  return 'lapsed';
}

/**
 * Run the reminder timer: tell both attendees their meetup starts in 15 minutes (AAP 0.5.3).
 *
 * The status is re-read inside the transaction that writes the rows, so a meetup cancelled, settled or
 * blocked in the meantime is not reminded. Writing the notification requests is the handler's last
 * fallible step — the commit is what makes them durable — so a retry can follow only a rollback, and
 * neither attendee is ever reminded twice.
 */
async function remindJob(
  services: AppServices,
  data: SettlementJobData['remind'],
): Promise<SettlementJobResult> {
  const reminded = await transact(services, async (tx) => {
    const meetup = await loadMeetup(tx, data.meetupId);

    if (meetup === null || meetup.status !== 'locked') {
      return false;
    }

    await notifyAll(tx, [meetup.initiatorId, meetup.recipientId], REMINDER_KIND, {
      meetupId: meetup.id,
    });

    return true;
  });

  return reminded ? 'reminded' : 'not_locked';
}

/**
 * Run the dispute-escalation timer: flag a dispute a day before the operator's deadline (AAP 0.5.3).
 *
 * `escalateDisputeIfDue` compares the deadline through the same function the timer scheduled with and
 * guards its own update on the flag being unset, so neither an early job, nor a dispute already
 * resolved, nor a second delivery of the same job changes anything.
 */
async function escalateJob(
  services: AppServices,
  data: SettlementJobData['dispute-escalate'],
): Promise<SettlementJobResult> {
  const escalated = await escalateDisputeIfDue(services, data.disputeId);

  return escalated ? 'escalated' : 'not_due';
}

/**
 * The four handlers, keyed by the name each job arrives under.
 *
 * A table rather than a switch, so the lookup *is* the dispatch and a name added to `JOB` fails to
 * compile until its handler is written here — the same exhaustiveness `JOB_DATA_SCHEMAS` uses for the
 * payloads, so a name and a handler cannot drift apart.
 */
const HANDLERS: { [J in SettlementJobName]: SettlementJobHandler<J> } = {
  [JOB.settlement.settle]: settleJob,
  [JOB.settlement.lapse]: lapseJob,
  [JOB.settlement.remind]: remindJob,
  [JOB.settlement.disputeEscalate]: escalateJob,
};

/**
 * Call the handler `name` selects.
 *
 * The one cast in this file, for the reason `payloads.ts` documents for its own: TypeScript cannot
 * resolve an indexed access through a union key, so `HANDLERS[name]` types as the union of all four
 * handlers rather than as the single one `name` selects. The cast is sound by construction —
 * `parseJobData` returned the data of exactly this `name`, from the same table the handler was
 * declared against — and it is confined to this one line, so no handler is ever handed a value its own
 * schema did not produce.
 */
function runHandler(
  services: AppServices,
  name: SettlementJobName,
  data: SettlementJobData[SettlementJobName],
): Promise<SettlementJobResult> {
  const handler = HANDLERS[name] as SettlementJobHandler<SettlementJobName>;

  return handler(services, data);
}

/**
 * Close the worker and then its connection, once (AAP 0.3.2).
 *
 * The order matters. The worker stops first, waiting for the job in flight, so a settlement that is
 * already writing commits instead of being abandoned mid-transaction; BullMQ duplicates the connection
 * it was given and owns only its duplicates, so closing the worker leaves ours connected and quitting
 * it afterwards is what lets the process exit. Neither step is rethrown — a shutdown must not be
 * blocked by a Redis that is already gone — so each failure is logged and the other step still runs.
 */
async function stopWorker(
  services: AppServices,
  worker: SettlementWorker,
  connection: Redis,
): Promise<void> {
  try {
    await worker.close();
  } catch (error) {
    services.logger.warn({ event: 'settlement_worker_close_failed', code: failureToken(error) });
  }

  try {
    await connection.quit();
  } catch (error) {
    services.logger.warn({
      event: 'settlement_connection_close_failed',
      code: failureToken(error),
    });
  }
}

/**
 * A failure's own short token, for a log line: its driver code (`P2028`) or its class name
 * (`QueuePayloadError`), and never its message or stack (AAP 0.11.1).
 *
 * A message and a stack are written by pino as strings, which key-based redaction cannot rewrite, and
 * the error a settlement job or a Redis outage throws may quote what it concerns: a provider failure
 * carries its own text as the cause, so its message can name the `PaymentIntent` id, and a driver
 * error's message quotes the statement that failed. Both are values these lines are forbidden to
 * carry. A token that is not a plain short identifier becomes `Error`, so nothing a thrown value
 * happens to say can reach a log through this path.
 *
 * The copy lives here rather than in `./sweeper.ts` because this file imports only the modules its
 * settlement work names (`./settle.ts`, `./timers.ts`, `../payments/operations.ts`,
 * `../meetups/queries.ts`, `../outbox/write.ts`, `../notifications/enqueue.ts`) — the same course
 * `./timers.ts` took with its own `errorTokenOf`.
 */
function failureToken(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'Error';
  }

  const { code, name } = error as { code?: unknown; name?: unknown };
  const token = typeof code === 'string' && code.length > 0 ? code : name;

  if (typeof token !== 'string' || !FAILURE_TOKEN_PATTERN.test(token)) {
    return 'Error';
  }
  return token;
}
