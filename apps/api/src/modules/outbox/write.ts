/**
 * The transactional outbox's write half: `transact` and `writeOutbox` (AAP 0.3.2, 0.5.1, 0.5.3,
 * 0.6.2).
 *
 * Every state change in the API is one interactive transaction, and this module is the only place
 * that opens one. {@link transact} runs the account-deletion write fence first, hands the caller the
 * transaction client, and runs the callbacks registered through `after` only once the commit has
 * happened. {@link writeOutbox} writes an `OutboxMessage` row inside that same transaction, so the
 * work it announces becomes durable with the change it describes, and `dispatcher.ts` — the other
 * half of this component — delivers it afterwards.
 *
 * The rules that follow from that shape:
 *
 *  - **One transaction per change, at ReadCommitted.** A handler that needs several writes passes
 *    one `fn`; it never opens a transaction of its own. Prisma cannot nest interactive
 *    transactions, and the fence and the outbox binding belong to the outer one.
 *  - **The fence first.** `opts.fenceUserId` makes the transaction take `SELECT … FOR SHARE` on the
 *    acting user's row before `fn` runs, which is what serializes a mutation against `DELETE /me`
 *    (AAP 0.5.3): the deletion takes `FOR UPDATE` on the same row, so a mutation already in flight
 *    commits before it and every mutation starting later is refused with `401 token_invalid`. Every
 *    mutating handler, the two state-writing reads (`GET /meetups/:id`,
 *    `GET /meetups/:id/suggestions`) and every WebSocket write pass it.
 *  - **No external call inside `fn`.** Stripe, Twilio, the language model and Redis all stay
 *    outside: `after` is the place for timers, pub/sub and cache writes, and payment operations run
 *    after `transact` returns. A transaction that held a row lock across a provider call would block
 *    every other writer of that row for as long as the provider took.
 *  - **Meetup mutations lock first.** `lockMeetup` (`SELECT … FOR UPDATE` on the meetup row) is taken
 *    at the top of `fn`. That lock is the meetup state machine's, not this file's.
 *  - **Callbacks never fail the request.** They run after the commit, so one that throws is logged
 *    and the next still runs.
 *
 * Log lines carry the fact that an after-commit callback failed and the failure's own short token —
 * its `code`, else its name — and nothing else: never the error's message, its stack or any
 * enumerable key, and no payload, no token, no coordinate (AAP 0.11.1).
 *
 * @see AAP 0.3.2 for the outbox's routing and idempotency rules, 0.5.1 for the Outbox component,
 *   0.5.3 for the account-deletion write fence, 0.5.6 for the dispatcher's polling, and 0.8.1 for
 *   this file.
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

// ---------------------------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------------------------

/**
 * Registers a callback to run after the transaction commits (AAP 0.3.2).
 *
 * @param cb - the callback. It runs once the commit has happened, in registration order, and its
 *   failure is logged rather than propagated. Calling `after` after the transaction has settled
 *   throws, because a registration that arrives too late could never run.
 */
export type AfterCommit = (cb: () => Promise<void> | void) => void;

/** The optional arguments of {@link transact}. */
export interface TransactOptions {
  /**
   * The account the change acts for, whose write fence runs before `fn` (AAP 0.5.3). Required for
   * every mutating handler, the two state-writing reads and every WebSocket write; omit it only for
   * work with no acting account, such as a provider webhook's own bookkeeping.
   */
  fenceUserId?: string;
  /** How long the transaction may run before Prisma ends it. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** How long the transaction may wait for a connection. Defaults to 5 seconds. */
  maxWaitMs?: number;
}

/**
 * What {@link transact} needs from the app's services (AAP 0.5.1).
 *
 * A `Pick` of the app's own services type rather than a shape restated here, so a caller passes
 * `services` as it stands and test doubles stay small: the database client, the injected clock, the
 * logger and the outbox dispatcher.
 */
export type TransactServices = Pick<AppServices, 'db' | 'clock' | 'logger' | 'outbox'>;

// ---------------------------------------------------------------------------------------------
// Per-transaction state
// ---------------------------------------------------------------------------------------------

/** What {@link writeOutbox} reads off the transaction it was handed. */
interface TxState {
  /**
   * The clock the enclosing {@link transact} was given, so an outbox row's `createdAt` follows the
   * injected clock (AAP 0.11.1) without this helper taking a `services` or `now` argument of its
   * own.
   */
  readonly clock: Clock;
  /** Whether this transaction wrote an outbox row, which is what triggers the dispatcher kick. */
  wroteOutbox: boolean;
}

/**
 * The state of every transaction in flight, keyed by the client Prisma passes to the callback.
 *
 * A `WeakMap`, so a transaction that has ended — committed or rolled back — is collected with no
 * bookkeeping here, and so a client that no `transact` opened has no entry at all.
 */
const txState = new WeakMap<object, TxState>();

// ---------------------------------------------------------------------------------------------
// transact
// ---------------------------------------------------------------------------------------------

/**
 * Run one state change as a single interactive transaction (AAP 0.3.2, 0.5.3).
 *
 * The transaction is opened at ReadCommitted. When `opts.fenceUserId` is set, the write fence runs
 * before `fn`, so no caller has to remember it and no transaction can write for a deleted account.
 * Analytics rows, outbox rows and `PaymentOperation`s are written by `fn` inside this transaction,
 * which is what makes them atomic with the domain change they describe.
 *
 * `after` registers a callback for after the commit. The callbacks run in registration order, each
 * awaited, and one of them failing is logged and does not stop the next or fail the request.
 *
 * The dispatcher is kicked only when the committed transaction actually wrote an outbox row, which
 * spares every other write at 50 rps a poll query; the two-second poll of AAP 0.5.6 remains the
 * backstop.
 *
 * A failure rolls the whole transaction back and is rethrown unchanged, so an `AppError` reaches the
 * error plugin intact and a transaction deadline surfaces as Prisma's own `P2028` (a `500`).
 * Callbacks registered before the failure are discarded and never run, because the work they were
 * meant to announce was never committed.
 *
 * @param services - the app's database client, injected clock, logger and outbox dispatcher.
 * @param fn - the work of the state change. It receives the transaction client and `after`, opens no
 *   transaction of its own and makes no external call.
 * @param opts - the optional write fence and transaction budget.
 * @returns the value `fn` resolved with.
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

// ---------------------------------------------------------------------------------------------
// writeOutbox
// ---------------------------------------------------------------------------------------------

/**
 * Write one `OutboxMessage` inside the transaction {@link transact} opened (AAP 0.3.2, 0.5.2).
 *
 * The payload is parsed against its kind's schema before the insert, so a malformed row can never be
 * committed and no consumer has to decide what to do with one. A payload that does not match is a
 * programming error: it propagates, rolls the transaction back, and surfaces as `500 internal_error`
 * rather than as a client error code.
 *
 * `createdAt` comes from the clock the enclosing {@link transact} bound to `tx`, which is why this
 * signature is the plan's three-argument form rather than one taking `services` or a `now`: callers
 * such as `notifications/enqueue.ts` have only the transaction client in hand, and time still comes
 * from the injected clock, so a test that advances the clock moves these rows with it (AAP 0.11.1).
 *
 * The payload carries ids only — `{ kind, userId?, meetupId?, disputeId?, lodgingClaimId?,
 * magicLinkTokenId? }`, `{ callAttemptId }`, `{ lodgingClaimId }` or `{ userId }` — and never an
 * email address, a name, a booking field, a message body or a price. The worker decrypts what it
 * needs from the row an id points at.
 *
 * Delivery happens after the commit through the dispatcher, which enqueues the row with
 * `jobId = outbox-<id>`; every consumer is idempotent on that `outboxId`, and Redis availability is
 * never a condition of the row's durability (AAP 0.3.2).
 *
 * @param tx - the transaction client `transact`'s `fn` received.
 * @param kind - the outbox kind, which selects the payload schema.
 * @param payload - the kind's payload, ids only.
 * @returns the new row's id.
 * @throws Error when `tx` is not a transaction opened by {@link transact}, which keeps outbox rows
 *   from being written outside the transaction that would make them durable.
 * @throws QueuePayloadError when `payload` does not match `kind`'s schema.
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
 * A failure's own short token, for a log line: its `code` (`ECONNREFUSED`, `P2028`) or its class name
 * (`QueuePayloadError`), and never its message or stack (AAP 0.11.1).
 *
 * pino writes a message and a stack as strings that key-based redaction cannot rewrite, and an ioredis
 * failure's text names the host it dialled, so the thrown value itself must not reach an
 * `after_commit_failed` line. A token that is not a plain short identifier becomes `Error`, so nothing
 * a thrown value happens to say can reach a log through this path.
 *
 * The copy lives here rather than in `./dispatcher.ts` because this file imports only the modules its
 * own work names, the course `../settlement/queue.ts` documents: `./dispatcher.ts` enters the runtime
 * graph through `app.ts` alone, which builds `services.outbox` from it, so this module reaches it as a
 * type only.
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
