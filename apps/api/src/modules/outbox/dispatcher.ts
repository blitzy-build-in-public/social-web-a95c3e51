/**
 * The transactional-outbox poller (AAP 0.3.2, 0.5.1, 0.5.6): the one place an `OutboxMessage` reaches BullMQ, and
 * what makes Redis availability "never a condition of outbox durability or of settlement" (AAP 0.3.2).
 *
 * `outbox/write.ts` commits a row inside the same transaction as the domain change it describes and then calls
 * {@link OutboxDispatcher.kick}. This poller takes every row that is still undispatched — including one whose kick
 * was lost to a crash, and one written while Redis was down — enqueues it into its target queue under
 * `jobId = outbox-<id>`, and only then marks it dispatched. A row that could not be enqueued is left exactly as it
 * was and delivered by a later pass, so no funnel event and no safety notification is lost to an outage.
 *
 * **No cross-instance lock is needed.** Two API instances may enqueue the same row: BullMQ suppresses a duplicate
 * custom `jobId` while the job is retained (`removeOnComplete` keeps 1,000), and every consumer is idempotent on
 * `outboxId`. **Ordering:** rows are enqueued in `created_at` order within one pass; order across queues or passes
 * is not guaranteed, so no consumer may depend on it. **Durability:** a row is durable from its domain commit, and
 * an outage only delays it.
 *
 * Log lines carry the row's id, its kind, a count and the failure's own code — never the payload, and never an
 * error object, whose message and stack pino writes as strings that key-based redaction cannot rewrite
 * (AAP 0.11.1).
 */

import {
  jobOptionsFor,
  toOutboxJob,
  type OutboxJob,
  type OutboxMessageRow,
} from '@tablemate/server-core';

// Type-only, so the runtime graph stays acyclic: `app.ts` imports this module as a value, because
// the dispatcher it builds *is* `services.outbox`.
import type { AppServices } from '../../app.ts';

/** How many undispatched rows one pass reads, oldest first (AAP 0.5.6). */
export const OUTBOX_BATCH_SIZE = 100;

/** How long one enqueue may take before the pass gives up on it and leaves the row for later. */
export const OUTBOX_ENQUEUE_TIMEOUT_MS = 5_000;

/** What the outbox needs from the app's services (AAP 0.3.2, 0.5.1). */
export type OutboxDispatcherServices = Pick<
  AppServices,
  'db' | 'clock' | 'logger' | 'queues' | 'redis'
>;

/**
 * The poller `app.ts` holds as `services.outbox` (AAP 0.5.1). `start` drives the two-second pass and hands back the
 * stop function `app.ts` registers on close; `kick` is what `outbox/write.ts` calls after a commit, and `runOnce`
 * is what the test-control routes and `settleNow` call when they have to observe a committed row immediately.
 */
export interface OutboxDispatcher {
  /**
   * Ask for a pass without waiting for it; called after a commit that wrote outbox rows.
   *
   * Never throws. Concurrent calls coalesce onto one pass, with at most one further pass queued behind the one in
   * flight, so ten rapid kicks cost two passes rather than ten. A no-op once the stop function has run, and it works
   * whether or not `start` was called.
   */
  kick(): void;
  /**
   * Run one pass and resolve with the number of rows it marked dispatched. The pass begins no earlier than this
   * call, so a caller that has just committed a row sees that row delivered. It never rejects.
   */
  runOnce(): Promise<number>;
  /**
   * Start the poller: one immediate pass, for the rows a restart left behind, then one every `intervalMs`.
   *
   * @returns the stop function: it stops the timer and resolves once the pass in flight and the one queued behind
   *   it have ended, so `app.ts` may await it before it closes Prisma and Redis.
   * @throws Error when the dispatcher has already been started. Restarting is refused rather than permitted, because
   *   `kick` no-ops after a stop.
   */
  start(intervalMs: number): () => Promise<void>;
}

/**
 * The failures that mean Redis, not the job, is the problem: the enqueue never reached a server, or the connection is
 * down. One of them ends a pass early, because walking the remaining rows would only repeat the same failure a
 * hundred times while the commit hook that wrote them waits for nothing (AAP 0.3.2). Everything else is that one
 * row's own failure, and the pass continues.
 */
const CONNECTION_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
]);

/**
 * The messages ioredis gives the failures that mean the connection, not the job, is the problem: a command it gave
 * up on after the fail-fast `producer` connection's own command timeout (the same condition as
 * {@link OUTBOX_ENQUEUE_TIMEOUT_MS} firing first), a command issued while the socket is not writable
 * (`enableOfflineQueue: false`), and a command issued on a closed connection.
 */
const CONNECTION_FAILURE_MESSAGES: readonly string[] = [
  'Command timed out',
  'enableOfflineQueue',
  'Connection is closed',
];

/** The ioredis error ioredis raises when a command exhausts `maxRetriesPerRequest`. */
const MAX_RETRIES_ERROR_NAME = 'MaxRetriesPerRequestError';

/**
 * An enqueue that outlived {@link OUTBOX_ENQUEUE_TIMEOUT_MS}. A class rather than a bare `Error`, because the pass
 * has to tell its own timeout from a timeout a provider raised.
 */
class OutboxEnqueueTimeoutError extends Error {
  constructor() {
    super('outbox enqueue timed out');
    this.name = 'OutboxEnqueueTimeoutError';
  }
}

/**
 * The failure's own short code, for the log line: a Node system code (`ECONNREFUSED`) or a driver code (`P1001`).
 * Never the error itself and never its message — pino writes both as strings that key-based redaction cannot
 * rewrite, and an ioredis failure's text carries the host it reached (AAP 0.11.1).
 */
function failureCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The one test for "this failure means Redis is unreachable", so a caller never has to decide twice and no future
 * caller can forget a case (AAP 0.3.2).
 *
 * @param producerStatus - `services.redis.producer.status` as it stands at that moment: anything other than `ready`
 *   means the next row would fail the same way.
 */
function isConnectionFailure(error: unknown, producerStatus: string): boolean {
  if (error instanceof OutboxEnqueueTimeoutError) {
    return true;
  }
  if (producerStatus !== 'ready') {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === MAX_RETRIES_ERROR_NAME) {
    return true;
  }
  if (CONNECTION_FAILURE_MESSAGES.some((message) => error.message.includes(message))) {
    return true;
  }
  const code = failureCode(error);
  return code !== undefined && CONNECTION_FAILURE_CODES.has(code);
}

/**
 * Build the outbox poller over the app's services (AAP 0.3.2, 0.5.1).
 *
 * Every service is read at pass time rather than captured here, because `app.ts` builds its container in steps and
 * `services.outbox` is this dispatcher. At most one pass runs at a time and at most one waits behind it, so two
 * passes can never interleave their batches.
 *
 * @returns the dispatcher `app.ts` stores as `services.outbox`.
 */
export function createOutboxDispatcher(services: OutboxDispatcherServices): OutboxDispatcher {
  /** The tail of every pass scheduled so far, and the promise `chain` is taken from. */
  let chain: Promise<unknown> = Promise.resolve();
  /** The one pass queued behind the one in flight; `null` once it has started. */
  let queued: Promise<number> | null = null;
  /** Whether the stop function has run. `kick` is a no-op from then on; `runOnce` still works. */
  let stopped = false;
  /** Whether `start` has been called, so a second call is refused rather than half-working. */
  let started = false;
  /**
   * Schedule a pass behind everything already scheduled, or join the one already waiting.
   *
   * A call made while a pass is queued joins that pass; a call made while one is *running* queues one behind it,
   * which reads every row committed before the call. `queued` is cleared as the pass begins, which is what gives
   * those two cases one rule.
   */
  function enqueuePass(): Promise<number> {
    if (queued !== null) {
      return queued;
    }
    const next = chain.then(async () => {
      queued = null;
      return pass();
    });
    // The tail the next pass chains onto settles either way: a pass reports its own failures, in
    // its own log lines, and one that ends badly must not stop the poller or the stop function.
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    queued = next;
    return next;
  }
  function kick(): void {
    if (stopped) {
      return;
    }
    void enqueuePass();
  }
  async function pass(): Promise<number> {
    try {
      return await dispatchBatch();
    } catch (error) {
      // The batch's own steps each handle what they can; this is the backstop that keeps the
      // interval alive and a caller's `runOnce` from rejecting on a failure nobody predicted.
      services.logger.warn(
        { event: 'outbox_pass_failed', code: failureCode(error) },
        'outbox_pass_failed',
      );
      return 0;
    }
  }
  /** One pass: read a batch, enqueue it in order, and mark what was delivered (AAP 0.5.6). */
  async function dispatchBatch(): Promise<number> {
    const { db, clock, logger } = services;
    let rows: readonly OutboxMessageRow[];
    try {
      rows = await db.outboxMessage.findMany({
        where: { dispatchedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: OUTBOX_BATCH_SIZE,
        select: { id: true, kind: true, payload: true },
      });
    } catch (error) {
      // PostgreSQL itself is unreachable: nothing to deliver this pass, and the next one retries.
      logger.warn({ event: 'outbox_pass_failed', code: failureCode(error) }, 'outbox_pass_failed');
      return 0;
    }
    let dispatched = 0;
    for (const row of rows) {
      let job: OutboxJob;
      try {
        job = toOutboxJob(row);
      } catch (error) {
        // Unreachable through `write.ts`, which parses before it inserts. A row that got here
        // anyway is recorded and skipped: it never blocks the rows behind it.
        await bumpTries(row.id);
        logger.error(
          {
            event: 'outbox_payload_invalid',
            outboxId: row.id,
            kind: row.kind,
            code: failureCode(error),
          },
          'outbox_payload_invalid',
        );
        continue;
      }
      try {
        await enqueue(job);
      } catch (error) {
        await bumpTries(row.id);
        logger.warn(
          {
            event: 'outbox_enqueue_failed',
            outboxId: row.id,
            kind: row.kind,
            code: failureCode(error),
          },
          'outbox_enqueue_failed',
        );
        if (isConnectionFailure(error, services.redis.producer.status)) {
          break;
        }
        continue;
      }
      try {
        const marked = await db.outboxMessage.updateMany({
          where: { id: row.id, dispatchedAt: null },
          data: { dispatchedAt: clock.now() },
        });
        // `0` means another instance marked the row first, which is harmless: the job is enqueued
        // exactly once either way, under the row's own `outbox-<id>`.
        if (marked.count === 1) {
          dispatched += 1;
        }
      } catch (error) {
        // A PostgreSQL blip after a successful enqueue: the row is enqueued again next pass, which
        // BullMQ suppresses while the job is retained, and consumers are idempotent on `outboxId`.
        logger.warn(
          { event: 'outbox_mark_failed', outboxId: row.id, code: failureCode(error) },
          'outbox_mark_failed',
        );
      }
    }
    if (dispatched > 0) {
      logger.debug({ event: 'outbox_dispatched', count: dispatched }, 'outbox_dispatched');
    }
    return dispatched;
  }
  /**
   * Add one row's job to its queue, giving up on the add after {@link OUTBOX_ENQUEUE_TIMEOUT_MS}.
   *
   * BullMQ can wait for a connection to become ready, and a pass must never hang on that wait. An add that times out
   * and finishes afterwards is harmless, because the `outbox-<id>` job id deduplicates it. Its rejection is handled
   * here so the abandoned add cannot surface as an unhandled rejection.
   */
  async function enqueue(job: OutboxJob): Promise<void> {
    const added = services.queues
      .get(job.queue)
      .add(job.name, job.data, jobOptionsFor(job.queue, { jobId: job.jobId }));
    void added.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        added,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new OutboxEnqueueTimeoutError()),
            OUTBOX_ENQUEUE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  /** Record one attempt on a row that could not be dispatched. Diagnostic only, never a limit. */
  async function bumpTries(outboxId: string): Promise<void> {
    try {
      await services.db.outboxMessage.update({
        where: { id: outboxId },
        data: { tries: { increment: 1 } },
      });
    } catch (error) {
      services.logger.warn(
        { event: 'outbox_tries_failed', outboxId, code: failureCode(error) },
        'outbox_tries_failed',
      );
    }
  }
  return {
    kick,
    runOnce(): Promise<number> {
      return enqueuePass();
    },
    start(intervalMs: number): () => Promise<void> {
      if (started) {
        throw new Error('outbox dispatcher already started');
      }
      started = true;
      // One pass at once, for the rows a restart left behind: they were committed before the crash
      // and no kick will arrive for them.
      kick();
      const timer = setInterval(() => {
        kick();
      }, intervalMs);
      timer.unref();
      return async () => {
        stopped = true;
        clearInterval(timer);
        // The pass in flight and the one queued behind it, so the caller closes Prisma and Redis
        // only once nothing is still writing.
        await chain;
      };
    },
  };
}
