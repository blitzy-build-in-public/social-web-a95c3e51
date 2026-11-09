/**
 * The transactional outbox's write half: `transact` and `writeOutbox`.
 *
 * Every state change in the API is one interactive transaction, and this module is the only place that opens one.
 * {@link transact} runs the account-deletion write fence first, hands the caller the transaction client, and runs the
 * callbacks registered through `after` only once the commit has happened. {@link writeOutbox} writes an
 * `OutboxMessage` row inside that same transaction, so the work it announces becomes durable with the change it
 * describes, and `dispatcher.ts` delivers it afterwards.
 *
 * The rules that follow from that shape:
 *
 * - **One transaction per change, at ReadCommitted.** A handler that needs several writes passes one `fn`: Prisma
 *   cannot nest interactive transactions, and the fence and the outbox binding belong to the outer one.
 * - **The fence first.** `opts.fenceUserId` takes `SELECT … FOR SHARE` on the acting user's row before `fn` runs,
 *   which is what serializes a mutation against `DELETE /me`: the deletion takes `FOR UPDATE` on the same row, so a
 *   mutation in flight commits before it and a later one is refused `401 token_invalid`.
 * - **No external call inside `fn`.** Stripe, Twilio, the language model and Redis stay outside, in `after` or after
 *   `transact` returns: a transaction holding a row lock across a provider call blocks every other writer.
 * - **Meetup mutations lock first.** `lockMeetup` is taken at the top of `fn`; that lock is the state machine's.
 * - **Callbacks never fail the request.** They run after the commit, so one that throws is logged and the next still
 *   runs.
 *
 * An `after_commit_failed` line carries the failure's own short token — its `code`, else its name — and nothing else.
 */

import { Prisma, type DbTx } from '@tablemate/db';
import { parseOutboxPayload, type Clock, type OutboxPayloadByKind } from '@tablemate/server-core';
import type { OutboxKind } from '@tablemate/shared';

// Type-only, so the runtime graph stays acyclic: `app.ts` imports `./dispatcher.ts` as a value,
// because the dispatcher it builds *is* `services.outbox`.
import type { AppServices } from '../../app.ts';
import { assertWritable } from '../../plugins/auth.ts';

/** How long a transaction waits for a connection before giving up and failing the request. */
const DEFAULT_MAX_WAIT_MS = 5_000;

/** How long one transaction may run before Prisma's own deadline ends it as a `P2028`. */
const DEFAULT_TX_TIMEOUT_MS = 15_000;

/**
 * Registers a callback to run after the transaction commits (AAP 0.3.2): in registration order, each awaited, its
 * failure logged rather than propagated. Calling it once the transaction has settled throws, since a registration
 * that arrives too late could never run.
 */
export type AfterCommit = (cb: () => Promise<void> | void) => void;

/** The optional arguments of {@link transact}. */
export interface TransactOptions {
  /**
   * The account the change acts for, whose write fence runs before `fn` (AAP 0.5.3). Required for every mutating
   * handler, the state-writing reads and every WebSocket write; omit it only for work with no acting account.
   */
  fenceUserId?: string;
  /** How long the transaction may run before Prisma ends it. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** How long the transaction may wait for a connection. Defaults to 5 seconds. */
  maxWaitMs?: number;
}

/**
 * What {@link transact} needs from the app's services (AAP 0.5.1): a `Pick` of the app's own services type rather
 * than a shape restated here, so a caller passes `services` as it stands and test doubles stay small.
 */
export type TransactServices = Pick<AppServices, 'db' | 'clock' | 'logger' | 'outbox'>;

/** What {@link writeOutbox} reads off the transaction it was handed. */
interface TxState {
  /**
   * The clock the enclosing {@link transact} was given, so an outbox row's `createdAt` follows the injected clock
   * (AAP 0.11.1) without this helper taking a `services` or `now` argument of its own.
   */
  readonly clock: Clock;
  /** Whether this transaction wrote an outbox row, which is what triggers the dispatcher kick. */
  wroteOutbox: boolean;
}

/**
 * The state of every transaction in flight, keyed by the client Prisma passes to the callback: a `WeakMap`, so an
 * ended transaction is collected with no bookkeeping here.
 */
const txState = new WeakMap<object, TxState>();

/**
 * Run one state change as a single interactive transaction (AAP 0.3.2, 0.5.3).
 *
 * The transaction is opened at ReadCommitted. When `opts.fenceUserId` is set the write fence runs before `fn`, so
 * no transaction can write for a deleted account. Analytics rows, outbox rows and `PaymentOperation`s are written
 * by `fn` inside it, which is what makes them atomic with the domain change they describe. The dispatcher is kicked
 * only when the committed transaction actually wrote an outbox row, which spares every other write at 50 rps a poll
 * query; the two-second poll of AAP 0.5.6 remains the backstop.
 *
 * A failure rolls the whole transaction back and is rethrown unchanged, so an `AppError` reaches the error plugin
 * intact; callbacks registered before it are discarded and never run.
 */
export async function transact<T>(
  services: TransactServices,
  fn: (tx: DbTx, after: AfterCommit) => Promise<T>,
  opts?: TransactOptions,
): Promise<T> {
  const callbacks: Array<() => Promise<void> | void> = [];
  let closed = false;
  let state: TxState | undefined;
  let result: T;
  const after: AfterCommit = (cb) => {
    if (closed) {
      throw new Error('after() called outside its transaction');
    }
    callbacks.push(cb);
  };
  try {
    result = await services.db.$transaction(
      async (tx) => {
        const bound: TxState = { clock: services.clock, wroteOutbox: false };
        state = bound;
        txState.set(tx, bound);
        // The fence runs before `fn` so a refused write never touches a row (AAP 0.5.3).
        if (opts?.fenceUserId !== undefined) {
          await assertWritable(tx, opts.fenceUserId);
        }
        return await fn(tx, after);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: opts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
        timeout: opts?.timeoutMs ?? DEFAULT_TX_TIMEOUT_MS,
      },
    );
  } catch (error) {
    closed = true;
    callbacks.length = 0;
    throw error;
  }
  closed = true;
  for (const cb of callbacks) {
    try {
      await cb();
    } catch (err) {
      // The commit already happened, so a callback's failure is recorded and never rethrown: the
      // outbox poller and the settlement sweeper are the backstops (AAP 0.3.2).
      services.logger.warn(
        { event: 'after_commit_failed', code: failureToken(err) },
        'after_commit_failed',
      );
    }
  }
  if (state?.wroteOutbox === true) {
    // Never throws; a dispatcher that cannot reach Redis leaves the rows for its next pass.
    services.outbox.kick();
  }
  return result;
}

/**
 * Write one `OutboxMessage` inside the transaction {@link transact} opened (AAP 0.3.2, 0.5.2).
 *
 * The payload is parsed against its kind's schema before the insert, so a malformed row can never be committed: one
 * that does not match is a programming error and surfaces as `500 internal_error` rather than as a client code.
 * `createdAt` comes from the clock the enclosing {@link transact} bound to `tx`, so a caller holding only the
 * transaction client still writes time from the injected clock (AAP 0.11.1). The payload carries ids only and never
 * an email address, a name, a booking field, a message body or a price; the worker decrypts what it needs from the
 * row an id points at. Delivery happens after the commit through the dispatcher, which enqueues the row with
 * `jobId = outbox-<id>`; every consumer is idempotent on that `outboxId`, and Redis availability is never a
 * condition of the row's durability (AAP 0.3.2).
 *
 * Throws when `tx` is not a transaction {@link transact} opened, and {@link QueuePayloadError} when `payload` does
 * not match `kind`'s schema.
 */
export async function writeOutbox<K extends OutboxKind>(
  tx: DbTx,
  kind: K,
  payload: OutboxPayloadByKind[K],
): Promise<string> {
  const state = txState.get(tx);
  if (state === undefined) {
    throw new Error('writeOutbox() requires a transaction opened by transact()');
  }
  const parsed = parseOutboxPayload(kind, payload);
  const row = await tx.outboxMessage.create({
    data: {
      kind,
      payload: parsed as Prisma.InputJsonValue,
      createdAt: state.clock.now(),
    },
    select: { id: true },
  });
  state.wroteOutbox = true;
  return row.id;
}

/** The safe shape a logged failure token may have: a short identifier and nothing else. */
const FAILURE_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * A failure's own short token, for a log line: its `code` (`ECONNREFUSED`, `P2028`) or its class name, and never
 * its message or stack (AAP 0.11.1). pino writes a message and a stack as strings that key-based redaction cannot
 * rewrite, and an ioredis failure's text names the host it dialled, so a token that is not a plain short
 * identifier becomes `Error`. The copy lives here rather than in `./dispatcher.ts` because this file reaches that
 * module as a type only.
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
