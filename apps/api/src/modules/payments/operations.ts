/**
 * The `PaymentOperation` executor: the one place a durable Stripe plan becomes a provider call
 * (AAP 0.3.2, AAP 0.5.1, AAP 0.6.2).
 *
 * Every Stripe mutation Tablemate makes is a `payment_operation` row written inside the domain
 * transaction that decided it (AAP 0.3.2 "Stripe mutations"). This file claims such a row, calls the
 * gateway under the row's own idempotency key, and records what happened. Four rules shape it:
 *
 * - **Claim, call, record.** {@link claimOperation} takes the row with one atomic `UPDATE` that also
 *   enforces the plan's ordering — no lower `seq` of the same deposit may still be open, and a
 *   `dependsOnId` operation must already be terminal — and returns a claim token (`claimedAt`). The
 *   provider call then runs outside any transaction, because a transaction holding the meetup row
 *   lock across a provider call would block every other writer for as long as Stripe took. The result
 *   is written in its own transaction whose first statement is `lockMeetup`, the order every other
 *   meetup mutation takes (AAP 0.5.3), so the meetup row, then the operation row, then the deposit
 *   row is the one lock order in the API and two writers cannot deadlock.
 * - **Every recording write is conditional on the claim token** (`status = 'executing' AND
 *   claimed_at = <ours>`). Zero rows means another path — a webhook adopting the same PaymentIntent,
 *   or a reclaim after an interruption — already recorded the result, and this pass then applies no
 *   effect of its own.
 * - **A failure before the request is sent returns the claim**, leaving the row plainly retryable for
 *   the next pass; a failure after a successful call leaves the row `executing`, which is exactly the
 *   crash the two-minute reclaim and the sweeper exist for (AAP 0.11.2).
 * - **Reconciliation decides on what the provider reports.** A retry after an interrupted call, and
 *   every refusal, retrieves the PaymentIntent and records the state it finds: an effect that already
 *   happened is recorded as success, a hold Stripe cancelled is a hold loss rather than a release,
 *   and an effect that never ran is retried under the same key (AAP 0.3.2 "Reconciling release,
 *   capture and refund").
 *
 * Two effects beyond an operation's own status live here for the same reason: the deposit's one
 * forward-only move, made through `applyHoldOutcome` for a hold and directly by `advanceDeposit` for
 * everything else, and the settlement's completion — `MeetupSettlement.status = 'complete'` once
 * every operation of the meetup has finished. A hold that turns out to have been lost before the
 * settlement committed is compensated after the recording transaction commits, through
 * `compensateLostHold` (AAP 0.3.2 "No-forfeit compensation").
 *
 * Time comes only from `services.clock`, so a test-clock jump drives the two-minute reclaim and the
 * twelve-hour unresolved-hold rule (AAP 0.11.1). Log lines carry operation ids, kinds, statuses and
 * the provider's own state words, never a client secret, a customer id or a card field.
 *
 * @see AAP 0.3.2 for claim, ordering, fencing and reconciliation, 0.5.2 for the `PaymentOperation`
 *   and `Deposit` models, 0.5.3 for the deposit and meetup lifecycles and the row lock, 0.5.4 for the
 *   routes that map an inline hold's outcome, 0.11.2 for the crash cases this file has to survive,
 *   and 0.8.1 for its inventory row.
 */

import { Prisma } from '@tablemate/db';
import type { DbClient, DbTx, Deposit, PaymentOperation } from '@tablemate/db';
import {
  FINAL_DEPOSIT_STATUSES,
  FINAL_MEETUP_STATUSES,
  OUR_CANCELLATION_REASON,
} from '@tablemate/shared';
import type { DepositStatus, PaymentOperationStatus } from '@tablemate/shared';

import { applyHoldOutcome, lockMeetup } from '../meetups/state-machine.ts';
import { transact } from '../outbox/write.ts';
import { compensateLostHold } from '../settlement/settle.ts';

import { advanceDeposit, findHoldOperation, isTerminalOperation } from './holds.ts';
import { TERMINAL_OPERATION_STATUSES } from './holds.ts';
import {
  isPaymentError,
  PaymentDeclinedError,
  PaymentIdempotencyError,
  PaymentRejectedError,
  PaymentUnavailableError,
} from './gateway.ts';
import type { HoldRequest, HoldResult, IntentState } from './gateway.ts';

// Type-only, so this module opens no runtime edge back to the composition root: `app.ts` imports the
// modules that call this file, and the cycle would only close at runtime if this were a value import.
import type { AppServices } from '../../app.ts';

// ---------------------------------------------------------------------------------------------
// Constants (AAP 0.3.2)
// ---------------------------------------------------------------------------------------------

/**
 * An `executing` row older than this is a call whose answer was lost, not a call that is running.
 *
 * Two minutes is longer than any provider call this API makes, so a row still `executing` at that
 * age is not a call in flight, and longer than one 60-second sweeper period (AAP 0.5.6), so the
 * pass immediately after the one that died still counts it as live: the reclaim is taken by the
 * first pass that finds the row older than this.
 */
export const INTERRUPTED_AFTER_MS = 2 * 60_000;

/**
 * A hold still unresolved this long after its decision is handed to the operator (AAP 0.3.2).
 *
 * Stripe keeps an idempotency result for at least 24 hours, so a replay is still safe at 12; the
 * margin exists so that the hand-off happens while the key is unquestionably still live rather than
 * at the edge of the provider's window. A second authorization is never attempted after it.
 */
export const HOLD_UNRESOLVED_AFTER_MS = 12 * 3_600_000;

/**
 * How many operations one read takes: {@link runPendingOperations}'s pass, unless its caller names
 * its own limit, and one scope read of {@link runOperationsFor}'s loop.
 *
 * 100 is far more than one 60-second window accumulates at pilot scale, and it bounds a scope
 * whose deposits have collected retryable operations, so such a scope is worked through in batches
 * instead of loading every one of them on each pass.
 */
const DEFAULT_PENDING_LIMIT = 100;

/**
 * How many times {@link runOperationsFor} re-reads its scope.
 *
 * One pass executes every operation it listed; a plan written during that pass — the orphan release a
 * hold outcome plans, or the refund a compensation does — is only visible to the next pass, so the
 * bound is what keeps a dependent operation running in the caller's own call.
 */
const MAX_SCOPE_PASSES = 5;

/**
 * The two fault points this executor raises (AAP 0.11.2).
 *
 * `buildApp` accepts fault points in `APP_ENV=test` only, and the difference between them is the
 * difference between the two crash cases this file has to survive: one before the request is sent
 * leaves the operation retryable, one after a successful call leaves it `executing`.
 */
const FAULT_BEFORE_SEND = 'payment_op.before_stripe_call';
const FAULT_AFTER_SEND = 'payment_op.after_stripe_call';

/**
 * The meetup statuses a lost hold can still be compensated from (AAP 0.3.2).
 *
 * They are the three settlements that decide money — `forfeited` by a capture, `completed` and
 * `unattended` by releasing both holds. Any other status means either that the settlement never ran
 * (nothing to reverse) or that it already became `lock_lost`, so there is nothing to undo.
 */
const COMPENSABLE_MEETUP_STATUSES = ['forfeited', 'completed', 'unattended'] as const;

// ---------------------------------------------------------------------------------------------
// The exported shapes (AAP 0.5.4)
// ---------------------------------------------------------------------------------------------

/** One operation's outcome, as {@link executeOperation} reports it. */
export type ExecutionStatus = 'succeeded' | 'failed_retryable' | 'failed_terminal' | 'skipped';

/**
 * A hold attempt's outcome in the form the routes answer with (AAP 0.5.4).
 *
 * `held` and `requires_action` carry the **caller's own** client secret: the attempt belongs to the
 * deposit's owner, and the route that asks is authenticated as that owner, so the counterpart's
 * secret can never be returned (`POST /meetups/:id/hold` and a repeated accept are the only routes
 * that retry an attempt, and both are authorized for one side alone).
 *
 * `failed` becomes `402 hold_failed` (the meetup is unchanged and a retry is allowed), `unavailable`
 * becomes `503 payment_unavailable` (the client recovers through `GET /meetups`, where the side shows
 * `pending` until the recovery resolves), and `pending` is the same `503`: the row is held by another
 * executor or is still being recovered.
 */
export interface HoldExecution {
  readonly outcome: 'held' | 'requires_action' | 'failed' | 'unavailable' | 'pending';
  /** The caller's own client secret, present on `held` and `requires_action`. */
  readonly clientSecret?: string;
  /** The provider's decline code, present on `failed` when a card refused the hold. */
  readonly declineCode?: string;
}

/** {@link executeOperation}'s result: what the operation reached and the row as it now stands. */
export interface ExecutionResult {
  /** `succeeded` recorded the effect, `failed_retryable` and `failed_terminal` recorded a failure
   * that may or may not be retried, and `skipped` means this pass applied nothing. */
  readonly status: ExecutionStatus;
  /** The operation row as this call left it, or `null` when the row no longer exists. */
  readonly operation: PaymentOperation | null;
  /** Present for a hold: the outcome the holding route answers with. */
  readonly hold?: HoldExecution;
}

/** Which operations {@link runOperationsFor} executes (AAP 0.3.2). */
export type OperationScope = { readonly meetupId: string } | { readonly userId: string };

/**
 * What one {@link runPendingOperations} pass did (AAP 0.3.2).
 *
 * The four buckets sum to `attempted`: every operation the pass examined is counted once, and one
 * whose execution threw — leaving the row for the two-minute reclaim — is counted `skipped` rather
 * than reported as a status it never reached.
 */
export interface PendingOperationsSummary {
  readonly attempted: number;
  readonly succeeded: number;
  readonly retryable: number;
  readonly terminal: number;
  readonly skipped: number;
}

// ---------------------------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------------------------

/** Where a claim was taken from, which decides whether the call is a first send or a retry. */
type ClaimSource = 'pending' | 'failed_retryable' | 'interrupted';

/**
 * A claimed operation and the token that makes this pass' recording writes exclusive.
 *
 * `claimedAt` is the instant this pass wrote, and every later `UPDATE` of the row is conditional on
 * it: a webhook or a reclaim that recorded the result first leaves this pass with zero rows written
 * and no effect applied.
 */
interface ClaimedOperation {
  readonly operation: PaymentOperation;
  readonly claimedAt: Date;
  readonly from: ClaimSource;
  /** The row's `tries` before this claim, which tells a first send from a replay. */
  readonly priorTries: number;
}

/** The fields a recorded result sets; an absent key leaves its column untouched. */
interface OperationRecord {
  /**
   * The result: `succeeded`, `failed_retryable` or `failed_terminal`. Never `pending` or
   * `executing`, because recording one would be taking the claim back, and never `fenced`, which is
   * a planner's supersession (`holds.ts`) and not something a provider call can report.
   */
  readonly status: 'succeeded' | 'failed_retryable' | 'failed_terminal';
  readonly lastError?: string | null;
  readonly paymentIntentId?: string | null;
  readonly stripeCustomerId?: string | null;
}

/** The single deposit move a successful operation makes, if any. */
type DepositEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'captured' }
  | { readonly kind: 'refunded' }
  | { readonly kind: 'canceled'; readonly intent: IntentState };

/** A loss the settlement's own commit could not see, for {@link compensate}. */
interface Compensation {
  readonly meetupId: string;
  readonly depositId: string;
  readonly canceledAt: Date;
  readonly reason: 'capture_failed_expired' | 'hold_lost_before_apply';
}

/** What an executor decided before this file's post-commit work runs. */
interface PendingOutcome {
  readonly status: ExecutionStatus;
  readonly operation: PaymentOperation | null;
  readonly hold?: HoldExecution;
  readonly compensate?: Compensation;
}

/** The four failures the gateway contract distinguishes (AAP 0.3.2). */
type PaymentFailure = 'unavailable' | 'rejected' | 'idempotency' | 'declined';

/**
 * The class name of each failure, for a value thrown by a second copy of `gateway.ts` in one process
 * — the case {@link isPaymentError} exists for. `PaymentError`'s constructor sets `name` to the
 * subclass's own name, so the name is as good as the class when `instanceof` cannot be trusted.
 */
const FAILURE_BY_NAME: Readonly<Record<string, PaymentFailure>> = {
  PaymentUnavailableError: 'unavailable',
  PaymentRejectedError: 'rejected',
  PaymentIdempotencyError: 'idempotency',
  PaymentDeclinedError: 'declined',
};

/**
 * The word a definite refusal contributes to a recorded `lastError` when the provider names no code
 * of its own (AAP 0.3.2).
 *
 * It is suffixed to the operation's kind, so the row says both what was refused and where:
 * `release_refused`, `refund_declined`, `delete_customer_idempotency_error`. A provider that does
 * name a code — `card_declined`, `resource_missing` — has that code recorded instead.
 */
const FAILURE_TOKEN: Readonly<Record<PaymentFailure, string>> = {
  unavailable: 'unavailable',
  rejected: 'refused',
  declined: 'declined',
  idempotency: 'idempotency_error',
};

/** Builds a {@link PendingOutcome}, leaving the optional keys out when they carry nothing. */
function pendingOutcome(
  status: ExecutionStatus,
  operation: PaymentOperation | null,
  extras: { readonly hold?: HoldExecution; readonly compensate?: Compensation } = {},
): PendingOutcome {
  return {
    status,
    operation,
    ...(extras.hold === undefined ? {} : { hold: extras.hold }),
    ...(extras.compensate === undefined ? {} : { compensate: extras.compensate }),
  };
}

/** Classifies a thrown payment failure, or `null` for a value that is not one of them. */
function classifyPaymentFailure(error: unknown): PaymentFailure | null {
  if (error instanceof PaymentUnavailableError) return 'unavailable';
  if (error instanceof PaymentRejectedError) return 'rejected';
  if (error instanceof PaymentIdempotencyError) return 'idempotency';
  if (error instanceof PaymentDeclinedError) return 'declined';
  if (!isPaymentError(error)) return null;
  return FAILURE_BY_NAME[error.name] ?? null;
}

/**
 * Reads a string field off a thrown value.
 *
 * A payment failure from a second copy of `gateway.ts` fails `instanceof`, so its `reason` and
 * `code` are read by name. Both are provider state words — `timeout`, `card_declined` — and neither
 * is a credential.
 */
function errorField(error: unknown, field: string): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

/** One operation row, or `null` when it no longer exists. */
function readOperation(
  services: AppServices,
  operationId: string,
): Promise<PaymentOperation | null> {
  return services.db.paymentOperation.findUnique({ where: { id: operationId } });
}

// ---------------------------------------------------------------------------------------------
// Claiming (AAP 0.3.2 "Claiming and ordering")
// ---------------------------------------------------------------------------------------------

/**
 * Claims one operation with a single statement, or answers `false` when it was not claimable.
 *
 * The statement is the whole claim, so two executors running at once — two API replicas, a sweeper
 * overlapping the dispatcher — cannot both win it: PostgreSQL re-evaluates the `WHERE` after the
 * row lock is taken, so exactly one `UPDATE` returns the row and the other returns nothing.
 *
 * The ordering predicate is the second half of the claim: an operation runs only when every lower
 * `seq` of its own deposit is terminal and its `dependsOnId` operation is terminal, which is what
 * keeps a release behind the hold that created the PaymentIntent and a refund behind the capture it
 * reverses. A `delete_customer` row has no deposit and no predecessor, so both clauses are
 * vacuously satisfied for it.
 *
 * @param db - The guarded client; the claim is one autocommit statement, never part of a caller's
 *   transaction, because the provider call it authorizes happens outside one.
 * @param operationId - The operation to claim.
 * @param now - The claim instant, from the injected clock.
 * @returns True when this call took the claim.
 */
async function claimRow(db: DbClient, operationId: string, now: Date): Promise<boolean> {
  const rows = await db.$queryRaw<readonly { id: string }[]>(Prisma.sql`
    UPDATE "payment_operation" o
       SET "status" = 'executing', "claimed_at" = ${now}, "tries" = o."tries" + 1
     WHERE o."id" = ${operationId}::uuid
       AND o."status" IN ('pending', 'failed_retryable')
       AND NOT EXISTS (
         SELECT 1 FROM "payment_operation" p
          WHERE p."deposit_id" = o."deposit_id"
            AND p."seq" < o."seq"
            AND p."status" NOT IN ('succeeded', 'failed_terminal', 'fenced'))
       AND (o."depends_on_id" IS NULL OR EXISTS (
         SELECT 1 FROM "payment_operation" d
          WHERE d."id" = o."depends_on_id"
            AND d."status" IN ('succeeded', 'failed_terminal', 'fenced')))
    RETURNING o."id"
  `);

  return rows.length > 0;
}

/**
 * Reclaims an interrupted operation: one left `executing` past {@link INTERRUPTED_AFTER_MS}.
 *
 * An `executing` row with no claim instant is reclaimed too. Only this file writes `claimed_at`, and
 * it writes the instant in the same statement that sets the status, so such a row can only come from
 * a hand-written row or a partially applied migration — neither of which should be trusted to be
 * running.
 *
 * @param db - The guarded client.
 * @param operationId - The operation to reclaim.
 * @param now - The claim instant, from the injected clock.
 * @returns True when this call took the claim.
 */
async function reclaimRow(db: DbClient, operationId: string, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - INTERRUPTED_AFTER_MS);
  const rows = await db.$queryRaw<readonly { id: string }[]>(Prisma.sql`
    UPDATE "payment_operation"
       SET "status" = 'executing', "claimed_at" = ${now}, "tries" = "tries" + 1
     WHERE "id" = ${operationId}::uuid
       AND "status" = 'executing'
       AND ("claimed_at" IS NULL OR "claimed_at" < ${cutoff})
    RETURNING "id"
  `);

  return rows.length > 0;
}

/**
 * Claims one operation for this pass, or answers `null` when another path has it (AAP 0.3.2).
 *
 * A claim taken from `pending` or `failed_retryable` is a send. A claim taken from an interrupted
 * `executing` row is a **reconcile-first** run: the call may already have reached Stripe, so its
 * first question is what the PaymentIntent reports, not what the last attempt assumed.
 *
 * @param services - The app's services, for the client and the clock.
 * @param operationId - The operation to claim.
 * @returns The claim and its token, or `null` when the row is missing, terminal, executing and
 *   still live, ordered behind an unfinished predecessor, or lost to a concurrent claimant.
 */
async function claimOperation(
  services: AppServices,
  operationId: string,
): Promise<ClaimedOperation | null> {
  const now = services.clock.now();
  const before = await services.db.paymentOperation.findUnique({ where: { id: operationId } });

  if (before === null) {
    return null;
  }

  if (before.status === 'pending' || before.status === 'failed_retryable') {
    if (!(await claimRow(services.db, operationId, now))) {
      return null;
    }

    const operation = await readOperation(services, operationId);
    return operation === null
      ? null
      : { operation, claimedAt: now, from: before.status, priorTries: before.tries };
  }

  const interrupted =
    before.claimedAt === null || before.claimedAt.getTime() < now.getTime() - INTERRUPTED_AFTER_MS;

  if (
    before.status === 'executing' &&
    interrupted &&
    (await reclaimRow(services.db, operationId, now))
  ) {
    const operation = await readOperation(services, operationId);
    return operation === null
      ? null
      : { operation, claimedAt: now, from: 'interrupted', priorTries: before.tries };
  }

  return null;
}

/**
 * Gives a claim back because nothing reached Stripe (AAP 0.11.2).
 *
 * The row returns to the status it was claimed from, `claimed_at` is cleared and `tries` is
 * decremented, so the operation is exactly what it was before the pass started and the next one
 * executes it. An interrupted row has no claimable status to return to — `executing` with a cleared
 * `claimed_at` would be stranded, because neither the claim nor the reclaim would ever take it again
 * — so its retry status is restored instead: the call whose answer was lost is a retryable one by
 * definition.
 *
 * @param services - The app's services.
 * @param claim - The claim to return.
 * @param evidence - Why it was returned, for the log line of a claim another path already changed.
 */
async function unclaim(
  services: AppServices,
  claim: ClaimedOperation,
  evidence: string,
): Promise<void> {
  const restored: PaymentOperationStatus =
    claim.from === 'interrupted' ? 'failed_retryable' : claim.from;

  const updated = await services.db.paymentOperation.updateMany({
    where: { id: claim.operation.id, status: 'executing', claimedAt: claim.claimedAt },
    data: { status: restored, claimedAt: null, tries: { decrement: 1 } },
  });

  if (updated.count !== 1) {
    services.logger.warn({
      event: 'payment_operation_unclaim_skipped',
      operationId: claim.operation.id,
      evidence,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Recording (AAP 0.3.2)
// ---------------------------------------------------------------------------------------------

/**
 * Writes an operation's result inside the caller's transaction, under the claim token.
 *
 * The `WHERE` is the token: `id`, `status = 'executing'` and `claimed_at = <ours>`. A webhook that
 * recorded the same PaymentIntent first, or a reclaim that took the row after an interruption, makes
 * this match nothing — which is the answer that stops this pass from applying a second effect.
 *
 * `completedAt` is stamped for a status that ends the operation's life and left null for one that
 * waits on the next pass, so "finished" stays readable from the row alone.
 *
 * @param tx - The caller's transaction; the meetup row lock is taken before this is called.
 * @param claim - The claim whose token the write is conditional on.
 * @param record - The status and the fields to write.
 * @param now - The instant, from the injected clock.
 * @returns Whether the write happened, and the row as the transaction leaves it.
 */
async function recordOperation(
  tx: DbTx,
  claim: ClaimedOperation,
  record: OperationRecord,
  now: Date,
): Promise<{ readonly recorded: boolean; readonly operation: PaymentOperation | null }> {
  const updated = await tx.paymentOperation.updateMany({
    where: { id: claim.operation.id, status: 'executing', claimedAt: claim.claimedAt },
    data: {
      status: record.status,
      completedAt: isTerminalOperation(record.status) ? now : null,
      ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
      ...(record.paymentIntentId === undefined ? {} : { paymentIntentId: record.paymentIntentId }),
      ...(record.stripeCustomerId === undefined
        ? {}
        : { stripeCustomerId: record.stripeCustomerId }),
    },
  });

  if (updated.count === 1) {
    return {
      recorded: true,
      operation: await tx.paymentOperation.findUniqueOrThrow({ where: { id: claim.operation.id } }),
    };
  }

  return {
    recorded: false,
    operation: await tx.paymentOperation.findUnique({ where: { id: claim.operation.id } }),
  };
}

/**
 * Records a result that changes nothing but the operation row itself.
 *
 * It opens no meetup lock because it touches no meetup row: the write is a single `payment_operation`
 * update, which cannot deadlock against the meetup writers (they take the meetup lock first and this
 * holds no other lock while it waits).
 *
 * @param services - The app's services.
 * @param claim - The claim to record against.
 * @param record - The status and fields to write.
 * @param hold - The hold outcome to report, when the operation is a hold.
 * @returns The outcome, with `skipped` when the token no longer matched.
 */
async function recordAlone(
  services: AppServices,
  claim: ClaimedOperation,
  record: OperationRecord,
  hold?: HoldExecution,
): Promise<PendingOutcome> {
  const now = services.clock.now();

  return transact(services, async (tx): Promise<PendingOutcome> => {
    const written = await recordOperation(tx, claim, record, now);
    const status: ExecutionStatus = written.recorded ? record.status : 'skipped';
    return pendingOutcome(status, written.operation, hold === undefined ? {} : { hold });
  });
}

/**
 * Applies a successful deposit operation's effect and closes the settlement when it is done.
 *
 * The deposit moves first and the settlement completion runs last, inside one transaction: a
 * settlement becomes `complete` only once every operation of its meetup is `succeeded` or `fenced`,
 * which is the same rule the executor has just satisfied. A settlement holding a `failed_terminal`
 * operation deliberately stays `applying` as the audit trail of a forfeit that could not run.
 *
 * A null PaymentIntent is recorded as `no_payment_intent`, so the row explains for itself why an
 * operation that was planned against an authorization closed without touching the provider: the
 * attempt's hold was fenced before it was sent, its create was refused without an intent, or the
 * reversal found nothing left to reverse.
 *
 * The deposit's move is judged rather than assumed: a deposit that refuses it — a superseded
 * attempt's status, or one that contradicts what the provider reported — closes the row
 * `failed_terminal` through {@link judgeDepositMove} instead of leaving a success that never
 * happened on the record (AAP 0.3.2, AAP 0.5.3).
 *
 * @param services - The app's services.
 * @param claim - The claim to record against.
 * @param deposit - The deposit the operation belongs to.
 * @param attempt - The hold attempt the operation concerns.
 * @param paymentIntentId - The PaymentIntent it resolved, or null when it resolved none.
 * @param effect - The deposit move the effect requires.
 * @returns The outcome, carrying compensation evidence when the hold turned out to be lost, and
 *   `failed_terminal` when the deposit refused the move the provider confirmed.
 */
async function recordDepositSuccess(
  services: AppServices,
  claim: ClaimedOperation,
  deposit: Deposit,
  attempt: number,
  paymentIntentId: string | null,
  effect: DepositEffect,
): Promise<PendingOutcome> {
  const now = services.clock.now();

  return transact(services, async (tx): Promise<PendingOutcome> => {
    await lockMeetup(tx, deposit.meetupId);

    const written = await recordOperation(
      tx,
      claim,
      {
        status: 'succeeded',
        paymentIntentId,
        ...(paymentIntentId === null ? { lastError: 'no_payment_intent' } : {}),
      },
      now,
    );

    if (!written.recorded) {
      return pendingOutcome('skipped', written.operation);
    }

    let compensate: Compensation | null = null;
    let target: DepositStatus | null = null;

    if (effect.kind === 'captured') {
      target = 'captured';
      await advanceDeposit(tx, { depositId: deposit.id, attempt }, 'captured');
    } else if (effect.kind === 'refunded') {
      target = 'refunded';
      await advanceDeposit(tx, { depositId: deposit.id, attempt }, 'refunded');
    } else if (effect.kind === 'canceled') {
      target =
        effect.intent.cancellationReason === OUR_CANCELLATION_REASON ? 'released' : 'expired';
      compensate = await applyCancellation(tx, deposit, attempt, effect.intent, now);
    }

    if (target !== null) {
      const contradicted = await judgeDepositMove(
        tx,
        services,
        claim,
        deposit,
        attempt,
        target,
        now,
      );

      if (contradicted !== null) {
        return contradicted;
      }
    }

    await completeSettlement(tx, deposit.meetupId, now);

    return pendingOutcome(
      'succeeded',
      written.operation,
      compensate === null ? {} : { compensate },
    );
  });
}

/**
 * Judges a guarded deposit move that did not happen, and closes the operation when the deposit's
 * refusal contradicts what the provider reported (AAP 0.3.2, AAP 0.5.3).
 *
 * `advanceDeposit` refuses a move the deposit's status does not allow, and `applyCancellation` makes
 * the same guarded move for a cancel, so a false result is ordinary — but recording it as a success
 * would claim an effect that never happened and let {@link completeSettlement} close a settlement
 * whose money never moved. The refusal is therefore read, and it is benign when:
 *
 * - the deposit's `currentAttempt` is no longer this operation's attempt, so a later attempt owns
 *   this status and it is history (the rule `applyCancellation` applies before it moves anything);
 * - the deposit already holds the status the move asked for, which is a replay of an effect a
 *   webhook or an earlier pass applied;
 * - a refused **cancel** leaves a deposit that is not the held authorization the cancel speaks to:
 *   either no authorization exists at all (`pending`, `requires_action` and `failed`, which AAP
 *   0.5.3's deposit table sends to `failed` when Stripe cancels on its own), or the deposit's money
 *   question is already closed (`released`, `captured`, `refunded`, `expired`). Nothing is left
 *   outstanding at the provider either way;
 * - a **capture** the provider confirmed is refused by a deposit that is already `refunded`: the
 *   charge was taken and given back.
 *
 * Everything else is the contradiction: a capture the provider confirmed (`succeeded`) that the
 * deposit says was never taken (`released`, `expired`, `failed`, `pending`, `requires_action`), or a
 * refund the provider holds that this deposit never recorded as captured. The row is closed exactly
 * as {@link recordCancellation} closes a captured intent under a release plan — one error line, and
 * the operation written `failed_terminal` in the same transaction, conditional on the row this pass
 * just wrote (`succeeded` under this claim's token) so a concurrent path's result is never rewritten.
 * The settlement then stays `applying`, because {@link completeSettlement} accepts only `succeeded`
 * and `fenced`, which is what puts the contradiction in front of an operator.
 *
 * @param tx - The caller's transaction, holding the meetup row lock.
 * @param services - The app's services.
 * @param claim - The claim the successful record was written under.
 * @param deposit - The deposit whose move was refused.
 * @param attempt - The hold attempt the move concerned.
 * @param target - The status the move asked the deposit to take.
 * @param now - The instant, from the injected clock.
 * @returns The outcome when the refusal contradicts the provider, or `null` for a benign one.
 */
async function judgeDepositMove(
  tx: DbTx,
  services: AppServices,
  claim: ClaimedOperation,
  deposit: Deposit,
  attempt: number,
  target: DepositStatus,
  now: Date,
): Promise<PendingOutcome | null> {
  const current = await tx.deposit.findUnique({
    where: { id: deposit.id },
    select: { status: true, currentAttempt: true },
  });

  if (current === null) {
    return null;
  }

  const benign =
    current.currentAttempt !== attempt ||
    current.status === target ||
    (target === 'captured'
      ? current.status === 'refunded'
      : (target === 'released' || target === 'expired') && current.status !== 'held');

  if (benign) {
    return null;
  }

  services.logger.error({
    event: 'payment_deposit_move_rejected',
    operationId: claim.operation.id,
    depositId: deposit.id,
    target,
    status: current.status,
  });

  const closed = await tx.paymentOperation.updateMany({
    where: { id: claim.operation.id, status: 'succeeded', claimedAt: claim.claimedAt },
    data: { status: 'failed_terminal', lastError: 'deposit_move_rejected', completedAt: now },
  });

  return pendingOutcome(
    closed.count === 1 ? 'failed_terminal' : 'skipped',
    await tx.paymentOperation.findUnique({ where: { id: claim.operation.id } }),
  );
}

/**
 * Records the state a cancel left behind, or the contradiction where the intent was captured
 * (AAP 0.3.2).
 *
 * A cancel can only ever report a cancelled intent, so `succeeded` or `processing` means the money
 * was taken on a plan that asked for a release. Nothing here may undo that, so the operation is
 * closed as the terminal failure it is — the same answer {@link reconcileRelease} gives a retrieval
 * that finds a captured intent — and the log line is what puts it in front of an operator.
 *
 * @param services - The app's services.
 * @param claim - The claim to record against.
 * @param deposit - The deposit the attempt belongs to.
 * @param attempt - The attempt number.
 * @param intent - The intent the cancel reported.
 * @param paymentIntentId - The intent's id, recorded on the operation.
 * @returns The outcome.
 */
async function recordCancellation(
  services: AppServices,
  claim: ClaimedOperation,
  deposit: Deposit,
  attempt: number,
  intent: IntentState,
  paymentIntentId: string,
): Promise<PendingOutcome> {
  if (intent.status === 'succeeded' || intent.status === 'processing') {
    services.logger.error({
      event: 'payment_release_intent_captured',
      operationId: claim.operation.id,
      depositId: deposit.id,
      status: intent.status,
    });
    return recordAlone(services, claim, {
      status: 'failed_terminal',
      lastError: 'intent_captured',
    });
  }

  return recordDepositSuccess(services, claim, deposit, attempt, paymentIntentId, {
    kind: 'canceled',
    intent,
  });
}

/**
 * Moves a deposit after a cancellation, and reports a hold that was lost rather than released.
 *
 * The distinction is the whole point of the deposit lifecycle's last row: a cancellation carrying
 * **our** reason is the release we asked for, and the deposit is `released`. A cancellation carrying
 * any other reason — `expired`, the value an expired authorization reads as under the pinned API
 * version — is Stripe's, so the hold was lost: the deposit is `expired`, the loss's instant is
 * recorded, and there is no forfeit (AAP 0.3.2, AAP 0.5.3).
 *
 * Only the deposit's current attempt decides its status; a superseded attempt's cancellation is
 * history, and rewriting the current attempt from it would undo the attempt that replaced it.
 *
 * @param tx - The caller's transaction, holding the meetup row lock.
 * @param deposit - The deposit to move.
 * @param attempt - The attempt the cancellation concerns.
 * @param intent - The PaymentIntent as the provider reported it after the cancel.
 * @param now - The instant a missing `canceledAt` falls back to.
 * @returns The compensation evidence when a settlement may still have to be reversed, else `null`.
 */
async function applyCancellation(
  tx: DbTx,
  deposit: Deposit,
  attempt: number,
  intent: IntentState,
  now: Date,
): Promise<Compensation | null> {
  if (attempt !== deposit.currentAttempt) {
    return null;
  }

  if (intent.cancellationReason === OUR_CANCELLATION_REASON) {
    await advanceDeposit(tx, { depositId: deposit.id, attempt }, 'released');
    return null;
  }

  const canceledAt = intent.canceledAt ?? now;
  await advanceDeposit(tx, { depositId: deposit.id, attempt }, 'expired', { canceledAt });

  const meetup = await tx.meetup.findUnique({
    where: { id: deposit.meetupId },
    select: { status: true },
  });

  if (meetup === null || !COMPENSABLE_MEETUP_STATUSES.some((status) => status === meetup.status)) {
    return null;
  }

  // The compensation decides for itself whether the loss precedes `appliedAt`; this pass only has to
  // know that there is a settlement it might have to reverse.
  return {
    meetupId: deposit.meetupId,
    depositId: deposit.id,
    canceledAt,
    reason: 'hold_lost_before_apply',
  };
}

/**
 * Marks a settlement `complete` once every operation of its meetup has finished (AAP 0.3.2).
 *
 * `succeeded` and `fenced` are the two statuses that mean "this operation will never call Stripe
 * again": the first did what it planned, the second was superseded before it could. Anything else —
 * `pending`, `executing`, `failed_retryable`, and `failed_terminal` above all — keeps the settlement
 * `applying`, so an operator can see a settlement whose money could not be moved.
 *
 * @param tx - The caller's transaction, holding the meetup row lock.
 * @param meetupId - The meetup whose settlement is checked.
 * @param now - The instant the completion is stamped with, from the injected clock.
 */
async function completeSettlement(tx: DbTx, meetupId: string, now: Date): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE "meetup_settlement" s
       SET "status" = 'complete', "completed_at" = ${now}
     WHERE s."meetup_id" = ${meetupId}::uuid
       AND s."status" = 'applying'
       AND NOT EXISTS (
         SELECT 1 FROM "payment_operation" o
           JOIN "deposit" d ON d."id" = o."deposit_id"
          WHERE d."meetup_id" = s."meetup_id"
            AND o."status" NOT IN ('succeeded', 'fenced'))
  `);
}

// ---------------------------------------------------------------------------------------------
// Execution per kind (AAP 0.3.2 "Execution")
// ---------------------------------------------------------------------------------------------

/**
 * Runs one claimed operation's provider call and decides its outcome.
 *
 * @param services - The app's services.
 * @param claim - The claim the operation was taken under.
 * @returns What the operation reached, before this file's post-commit work runs.
 */
function runClaimed(services: AppServices, claim: ClaimedOperation): Promise<PendingOutcome> {
  switch (claim.operation.kind) {
    case 'hold':
      return executeHold(services, claim);
    case 'release':
      return executeRelease(services, claim);
    case 'capture':
      return executeCapture(services, claim);
    case 'refund':
      return executeRefund(services, claim);
    case 'delete_customer':
      return executeDeleteCustomer(services, claim);
  }
}

/**
 * Places and confirms one hold attempt (AAP 0.2.4, AAP 0.5.3).
 *
 * The request is built from the deposit row and the operation row alone, so a replay after a crash
 * sends byte-identical parameters under the attempt's own key: that is what makes the provider
 * answer a replayed create with the stored result of the first one instead of authorizing twice
 * (AAP 0.3.2 "Reconciling an ambiguous hold create").
 *
 * @param services - The app's services.
 * @param claim - The claimed `hold` operation.
 * @returns The outcome, whose hold arm carries the caller's own client secret.
 */
async function executeHold(
  services: AppServices,
  claim: ClaimedOperation,
): Promise<PendingOutcome> {
  const operation = claim.operation;
  const deposit =
    operation.depositId === null
      ? null
      : await services.db.deposit.findUnique({ where: { id: operation.depositId } });
  const attempt = operation.attempt;

  if (deposit === null || attempt === null) {
    await unclaim(services, claim, 'hold_context_missing');
    services.logger.error({ event: 'payment_hold_context_missing', operationId: operation.id });
    return pendingOutcome('skipped', await readOperation(services, operation.id));
  }

  // A replay of an unresolved attempt is handed to the operator rather than sent again: the
  // provider's idempotency result may be at the edge of its window, and an authorization nobody can
  // still settle is worse than a meetup the initiator is told to retry (AAP 0.3.2).
  if (isReplay(claim) && elapsedSince(services, operation.createdAt) >= HOLD_UNRESOLVED_AFTER_MS) {
    services.logger.error({
      event: 'payment_operation_unresolved',
      operationId: operation.id,
      depositId: deposit.id,
    });
    return recordHoldFailure(services, claim, deposit, attempt, {
      lastError: 'unresolved_12h',
      paymentIntentId: null,
    });
  }

  const customer = await services.db.user.findUnique({
    where: { id: operation.userId },
    select: { stripeCustomerId: true },
  });

  if (customer === null || customer.stripeCustomerId === null) {
    // No saved card is an ordinary decline, not a failure: the route answers `402 hold_failed` and
    // the attempt may be retried once the customer has set a card up (AAP 0.5.4).
    return recordHoldFailure(services, claim, deposit, attempt, {
      lastError: 'no_saved_card',
      declineCode: 'no_saved_card',
      paymentIntentId: null,
    });
  }

  const request: HoldRequest = {
    customerId: customer.stripeCustomerId,
    amountCents: deposit.amountCents,
    meetupId: deposit.meetupId,
    depositId: deposit.id,
    attempt,
    idempotencyKey: operation.idempotencyKey,
  };

  let sent = false;

  try {
    await services.faults.hit(FAULT_BEFORE_SEND, {
      operationId: operation.id,
      kind: operation.kind,
    });
    sent = true;
    const result = await services.payments.createAndConfirmHold(request);
    await services.faults.hit(FAULT_AFTER_SEND, {
      operationId: operation.id,
      kind: operation.kind,
    });

    return await recordHoldResult(services, claim, deposit, attempt, result);
  } catch (error) {
    return await holdFailure(services, claim, deposit, attempt, error, sent);
  }
}

/**
 * Decides what a thrown failure of a hold create means (AAP 0.3.2).
 *
 * `unavailable` is the ambiguous create: the answer was lost, so the deposit stays `pending` and the
 * sweeper replays the identical request under the same key, which either returns the stored result of
 * the first request or performs it once. `idempotency` means the replay's parameters changed, so
 * replaying cannot recover the attempt and it is left to the twelve-hour rule. `rejected` is a
 * definite refusal, so nothing was authorized. `declined` is the card itself refusing the request:
 * nothing was authorized either, so the attempt ends the way a returned decline ends it — the
 * operation `failed_terminal` and the deposit `failed` (AAP 0.5.3). Every failure this rule knows
 * therefore leaves a terminal or retryable row, never one for the reclaim to send again.
 *
 * @param services - The app's services.
 * @param claim - The claim to record against.
 * @param deposit - The deposit the attempt belongs to.
 * @param attempt - The attempt number.
 * @param error - The thrown value.
 * @param sent - Whether the create request was sent.
 * @returns The outcome; a failure this rule does not cover is rethrown.
 */
async function holdFailure(
  services: AppServices,
  claim: ClaimedOperation,
  deposit: Deposit,
  attempt: number,
  error: unknown,
  sent: boolean,
): Promise<PendingOutcome> {
  const failure = classifyPaymentFailure(error);

  if (failure === 'unavailable') {
    return recordAlone(
      services,
      claim,
      { status: 'failed_retryable', lastError: errorField(error, 'reason') ?? 'unavailable' },
      { outcome: 'unavailable' },
    );
  }

  if (failure === 'idempotency') {
    services.logger.error({
      event: 'hold_replay_params_changed',
      operationId: claim.operation.id,
      depositId: deposit.id,
    });
    return recordAlone(
      services,
      claim,
      { status: 'failed_retryable', lastError: 'idempotency_error' },
      { outcome: 'unavailable' },
    );
  }

  if (failure === 'rejected') {
    return recordHoldFailure(services, claim, deposit, attempt, {
      lastError: errorField(error, 'code') ?? 'payment_rejected',
      paymentIntentId: null,
    });
  }

  if (failure === 'declined') {
    // A card that refused the hold means nothing was authorized, so the deposit takes AAP 0.5.3's
    // `pending → failed` row and the retry route stays open for the initiator exactly as a returned
    // decline leaves it (`recordHoldResult`); leaving the row `executing` would instead let the
    // two-minute reclaim retry a card the provider has already refused.
    const declineCode = errorField(error, 'code') ?? 'card_declined';
    return recordHoldFailure(services, claim, deposit, attempt, {
      lastError: declineCode,
      declineCode,
      paymentIntentId: null,
    });
  }

  if (!sent) {
    await unclaim(services, claim, 'hold_not_sent');
  }

  services.logger.error({
    event: 'payment_op_failed',
    operationId: claim.operation.id,
    kind: 'hold',
    err: error,
  });
  throw error;
}

/**
 * Records a hold attempt that placed no authorization, and moves the deposit to `failed`.
 *
 * A decline is not a crash: the deposit's `pending → failed` row is what lets the initiator retry the
 * attempt, and `failed → pending` on the retry is the other half of that path (AAP 0.5.3). The hold
 * is unresolved after twelve hours for the same reason — the deposit has no authorization and the
 * attempt is over, so `failed` leaves the retry route open for the initiator.
 *
 * @param services - The app's services.
 * @param claim - The claim to record against.
 * @param deposit - The deposit the attempt belongs to.
 * @param attempt - The attempt number.
 * @param failure - The terminal code, and the provider's decline code when a card refused the hold.
 * @returns The outcome, whose hold arm carries the decline code when there was one.
 */
async function recordHoldFailure(
  services: AppServices,
  claim: ClaimedOperation,
  deposit: Deposit,
  attempt: number,
  failure: {
    readonly lastError: string;
    readonly declineCode?: string;
    readonly paymentIntentId: string | null;
  },
): Promise<PendingOutcome> {
  const now = services.clock.now();

  return transact(services, async (tx, after): Promise<PendingOutcome> => {
    await lockMeetup(tx, deposit.meetupId);

    const written = await recordOperation(
      tx,
      claim,
      {
        status: 'failed_terminal',
        lastError: failure.lastError,
        paymentIntentId: failure.paymentIntentId,
      },
      now,
    );

    if (!written.recorded) {
      return pendingOutcome('skipped', written.operation);
    }

    await applyHoldOutcome(tx, services, after, {
      depositId: deposit.id,
      attempt,
      paymentIntentId: failure.paymentIntentId,
      outcome: 'failed',
      source: 'operations',
    });

    return pendingOutcome('failed_terminal', written.operation, {
      hold:
        failure.declineCode === undefined
          ? { outcome: 'failed' }
          : { outcome: 'failed', declineCode: failure.declineCode },
    });
  });
}

/**
 * Records a hold that reached the provider (AAP 0.3.2, AAP 0.5.3).
 *
 * The results are recorded against the attempt, never the deposit: both go through
 * `applyHoldOutcome`, which makes the deposit move forward only, releases an authorization that
 * arrived for a superseded attempt or a meetup that already ended, and decides whether the outcome
 * makes the proposal visible or locks the meetup.
 *
 * @param services - The app's services.
 * @param claim - The claim to record against.
 * @param deposit - The deposit the attempt belongs to.
 * @param attempt - The attempt number.
 * @param result - What confirming the hold reported.
 * @returns The outcome, whose hold arm carries the caller's own client secret.
 */
async function recordHoldResult(
  services: AppServices,
  claim: ClaimedOperation,
  deposit: Deposit,
  attempt: number,
  result: HoldResult,
): Promise<PendingOutcome> {
  if (result.kind === 'declined') {
    return recordHoldFailure(services, claim, deposit, attempt, {
      lastError: result.code,
      declineCode: result.code,
      paymentIntentId: result.paymentIntentId,
    });
  }

  const now = services.clock.now();
  const held = result.kind === 'requires_capture';

  return transact(services, async (tx, after): Promise<PendingOutcome> => {
    await lockMeetup(tx, deposit.meetupId);

    const written = await recordOperation(
      tx,
      claim,
      { status: 'succeeded', paymentIntentId: result.paymentIntentId },
      now,
    );

    if (!written.recorded) {
      return pendingOutcome('skipped', written.operation);
    }

    await applyHoldOutcome(tx, services, after, {
      depositId: deposit.id,
      attempt,
      paymentIntentId: result.paymentIntentId,
      outcome: held ? 'held' : 'requires_action',
      captureBefore: held ? result.captureBefore : null,
      source: 'operations',
    });

    return pendingOutcome('succeeded', written.operation, {
      hold: { outcome: held ? 'held' : 'requires_action', clientSecret: result.clientSecret },
    });
  });
}

/**
 * Releases one attempt's authorization (AAP 0.3.2, AAP 0.5.3).
 *
 * With no PaymentIntent to cancel — the attempt's hold was fenced before it was sent, was refused
 * without an intent, or is a declined attempt whose create never reached the provider — the release
 * is satisfied without a provider call: nothing is outstanding under that key, and the deposit's own
 * status was already decided by the planner that wrote this row.
 *
 * Every failure the gateway classifies ends the row terminal or retryable: `unavailable` is the
 * ambiguous call the same key replays, and any definite refusal — `rejected`, `declined`,
 * `idempotency` — is read against the intent's real state ({@link reconcileRelease}) rather than
 * against the refusal itself. Only an unclassifiable error leaves the row `executing` for the
 * two-minute reclaim.
 *
 * @param services - The app's services.
 * @param claim - The claimed `release` operation.
 * @returns The outcome.
 */
async function executeRelease(
  services: AppServices,
  claim: ClaimedOperation,
): Promise<PendingOutcome> {
  const operation = claim.operation;
  const deposit =
    operation.depositId === null
      ? null
      : await services.db.deposit.findUnique({ where: { id: operation.depositId } });

  if (deposit === null) {
    await unclaim(services, claim, 'release_context_missing');
    services.logger.error({ event: 'payment_release_context_missing', operationId: operation.id });
    return pendingOutcome('skipped', await readOperation(services, operation.id));
  }

  const attempt = operation.attempt ?? deposit.currentAttempt;
  const paymentIntentId = await resolveIntentId(services, operation, deposit, attempt);

  if (paymentIntentId === null) {
    return recordDepositSuccess(services, claim, deposit, attempt, null, { kind: 'none' });
  }

  let sent = false;

  try {
    if (claim.from === 'interrupted') {
      // A reconcile-first run asks the provider what happened before it cancels anything.
      const decided = await reconcileRelease(services, claim, deposit, attempt, paymentIntentId);
      if (decided !== null) {
        return decided;
      }
    }

    await services.faults.hit(FAULT_BEFORE_SEND, {
      operationId: operation.id,
      kind: operation.kind,
    });
    sent = true;
    const intent = await services.payments.releaseHold(paymentIntentId, operation.idempotencyKey);
    await services.faults.hit(FAULT_AFTER_SEND, {
      operationId: operation.id,
      kind: operation.kind,
    });

    return await recordCancellation(services, claim, deposit, attempt, intent, paymentIntentId);
  } catch (error) {
    const failure = classifyPaymentFailure(error);

    if (failure === 'unavailable') {
      return recordAlone(services, claim, {
        status: 'failed_retryable',
        lastError: errorField(error, 'reason') ?? 'unavailable',
      });
    }

    if (failure === 'rejected' || failure === 'declined' || failure === 'idempotency') {
      // A definite refusal — a rejected request, a card that refused the cancel, a reused key whose
      // parameters changed — proves the request had no effect but does not say what the intent's
      // state is, so the state decides: a cancellation that already happened is recorded, a captured
      // intent is the contradiction `reconcileRelease` closes, and an intent still authorized is the
      // retryable failure named here (AAP 0.3.2). The row therefore ends terminal or retryable,
      // never `executing`, which the two-minute reclaim would otherwise retry forever.
      const lastError = errorField(error, 'code') ?? `${operation.kind}_${FAILURE_TOKEN[failure]}`;
      const refused = await reconcileRelease(
        services,
        claim,
        deposit,
        attempt,
        paymentIntentId,
        lastError,
      );
      return (
        refused ?? (await recordAlone(services, claim, { status: 'failed_retryable', lastError }))
      );
    }

    if (!sent) {
      await unclaim(services, claim, 'release_not_sent');
    }

    services.logger.error({
      event: 'payment_op_failed',
      operationId: operation.id,
      kind: 'release',
      err: error,
    });
    throw error;
  }
}

/**
 * Reads the PaymentIntent of an interrupted or refused release (AAP 0.3.2).
 *
 * The states are the whole rule: `canceled` means the effect already happened (ours or Stripe's,
 * which `applyCancellation` tells apart), a captured intent contradicts a release and is recorded as
 * the terminal failure it is, and an intent that is still authorizing means the call may go ahead.
 *
 * @param services - The app's services.
 * @param claim - The claim to record against.
 * @param deposit - The deposit the attempt belongs to.
 * @param attempt - The attempt number.
 * @param paymentIntentId - The PaymentIntent to read.
 * @param refused - Set when the caller already knows a cancel was refused, so an intent that is still
 *   authorized becomes that retryable failure rather than a fresh cancel attempt.
 * @returns The outcome, or `null` when the intent is still authorized and the caller should cancel.
 */
async function reconcileRelease(
  services: AppServices,
  claim: ClaimedOperation,
  deposit: Deposit,
  attempt: number,
  paymentIntentId: string,
  refused?: string,
): Promise<PendingOutcome | null> {
  const intent = await retrieveOrNull(services, paymentIntentId);

  if (intent === null || intent.status === 'canceled') {
    // A missing intent is the absence of an effect: there is nothing at the provider to cancel.
    return intent === null
      ? recordDepositSuccess(services, claim, deposit, attempt, null, { kind: 'none' })
      : recordCancellation(services, claim, deposit, attempt, intent, paymentIntentId);
  }

  if (intent.status === 'succeeded' || intent.status === 'processing') {
    // Money was captured on a release plan. Nothing here may undo it; the row is closed as the
    // terminal failure it is, and the log is what puts the contradiction in front of an operator.
    services.logger.error({
      event: 'payment_release_intent_captured',
      operationId: claim.operation.id,
      depositId: deposit.id,
      status: intent.status,
    });
    return recordAlone(services, claim, {
      status: 'failed_terminal',
      lastError: 'intent_captured',
    });
  }

  return refused === undefined
    ? null
    : recordAlone(services, claim, { status: 'failed_retryable', lastError: refused });
}

/**
 * Captures the absent party's hold at a settlement, or the canceller's on a late cancellation.
 *
 * The one failure that changes the meetup is an authorization that expired: the capture fails
 * terminally, the deposit is `expired`, and the settlement's forfeit is compensated after this
 * records it, because the hold was lost before the settlement's own transaction could see it
 * (AAP 0.3.2 "No-forfeit compensation").
 *
 * Every failure the gateway classifies ends the row terminal or retryable: `unavailable` is the
 * ambiguous call the same key replays, a card refusal is the terminal failure a capture cannot
 * recover from, and a definite refusal is read against the intent's real state.
 *
 * @param services - The app's services.
 * @param claim - The claimed `capture` operation.
 * @returns The outcome.
 */
async function executeCapture(
  services: AppServices,
  claim: ClaimedOperation,
): Promise<PendingOutcome> {
  const operation = claim.operation;
  const deposit =
    operation.depositId === null
      ? null
      : await services.db.deposit.findUnique({ where: { id: operation.depositId } });

  if (deposit === null) {
    await unclaim(services, claim, 'capture_context_missing');
    services.logger.error({ event: 'payment_capture_context_missing', operationId: operation.id });
    return pendingOutcome('skipped', await readOperation(services, operation.id));
  }

  const attempt = operation.attempt ?? deposit.currentAttempt;
  const paymentIntentId = await resolveIntentId(services, operation, deposit, attempt);

  if (paymentIntentId === null) {
    // A capture names the attempt's PaymentIntent by construction (`planCapture` requires one), so
    // retrying cannot help and the settlement keeps the failure as its audit trail.
    services.logger.error({ event: 'payment_capture_intent_missing', operationId: operation.id });
    return recordAlone(services, claim, {
      status: 'failed_terminal',
      lastError: 'no_payment_intent',
    });
  }

  let sent = false;

  try {
    if (claim.from === 'interrupted') {
      // A reconcile-first run reads the intent before it captures: a capture that already happened
      // is recorded rather than sent a second time, and an expired hold is recognised as lost.
      const intent = await retrieveOrNull(services, paymentIntentId);

      if (intent === null || intent.status === 'canceled') {
        return captureExpired(services, claim, deposit, attempt, intent?.canceledAt ?? null);
      }
      if (intent.status === 'succeeded') {
        return recordDepositSuccess(services, claim, deposit, attempt, paymentIntentId, {
          kind: 'captured',
        });
      }
    }

    await services.faults.hit(FAULT_BEFORE_SEND, {
      operationId: operation.id,
      kind: operation.kind,
    });
    sent = true;
    await services.payments.captureHold(paymentIntentId, operation.idempotencyKey);
    await services.faults.hit(FAULT_AFTER_SEND, {
      operationId: operation.id,
      kind: operation.kind,
    });

    return await recordDepositSuccess(services, claim, deposit, attempt, paymentIntentId, {
      kind: 'captured',
    });
  } catch (error) {
    const failure = classifyPaymentFailure(error);

    if (failure === 'unavailable') {
      return recordAlone(services, claim, {
        status: 'failed_retryable',
        lastError: errorField(error, 'reason') ?? 'unavailable',
      });
    }

    if (failure === 'rejected' || failure === 'idempotency') {
      // A definite refusal — a rejected request, or a reused key whose parameters changed — proves
      // the capture did not run but does not say what the intent's state is, so the state decides:
      // a gone authorization is the lost hold, a captured one is recorded, and one still authorized
      // is the retryable failure named here (AAP 0.3.2). The row is never left `executing`.
      const intent = await retrieveOrNull(services, paymentIntentId);

      if (intent === null || intent.status === 'canceled') {
        return captureExpired(services, claim, deposit, attempt, intent?.canceledAt ?? null);
      }
      if (intent.status === 'succeeded') {
        return recordDepositSuccess(services, claim, deposit, attempt, paymentIntentId, {
          kind: 'captured',
        });
      }

      return recordAlone(services, claim, {
        status: 'failed_retryable',
        lastError: errorField(error, 'code') ?? `${operation.kind}_${FAILURE_TOKEN[failure]}`,
      });
    }

    if (failure === 'declined') {
      // A card refusal on an already-authorized hold: nothing may be captured, so the row ends
      // terminal. The deposit keeps its `held` status and the settlement stays `applying`, which is
      // what puts a forfeit that could not run in front of an operator.
      services.logger.error({
        event: 'payment_capture_declined',
        operationId: operation.id,
        depositId: deposit.id,
      });
      return recordAlone(services, claim, {
        status: 'failed_terminal',
        lastError: errorField(error, 'code') ?? 'card_declined',
      });
    }

    if (!sent) {
      await unclaim(services, claim, 'capture_not_sent');
    }

    services.logger.error({
      event: 'payment_op_failed',
      operationId: operation.id,
      kind: 'capture',
      err: error,
    });
    throw error;
  }
}

/**
 * Records a capture that found the authorization gone (AAP 0.3.2).
 *
 * @param services - The app's services.
 * @param claim - The claim to record against.
 * @param deposit - The deposit whose hold was lost.
 * @param attempt - The attempt number.
 * @param canceledAt - When Stripe cancelled the authorization, when it reported one.
 * @returns The outcome, carrying the compensation the settlement needs.
 */
async function captureExpired(
  services: AppServices,
  claim: ClaimedOperation,
  deposit: Deposit,
  attempt: number,
  canceledAt: Date | null,
): Promise<PendingOutcome> {
  const now = services.clock.now();
  const lost = canceledAt ?? now;

  return transact(services, async (tx): Promise<PendingOutcome> => {
    await lockMeetup(tx, deposit.meetupId);

    const written = await recordOperation(
      tx,
      claim,
      { status: 'failed_terminal', lastError: 'hold_expired' },
      now,
    );

    if (!written.recorded) {
      return pendingOutcome('skipped', written.operation);
    }

    await advanceDeposit(tx, { depositId: deposit.id, attempt }, 'expired', { canceledAt: lost });

    const meetup = await tx.meetup.findUnique({
      where: { id: deposit.meetupId },
      select: { status: true },
    });

    if (
      meetup === null ||
      !COMPENSABLE_MEETUP_STATUSES.some((status) => status === meetup.status)
    ) {
      return pendingOutcome('failed_terminal', written.operation);
    }

    return pendingOutcome('failed_terminal', written.operation, {
      compensate: {
        meetupId: deposit.meetupId,
        depositId: deposit.id,
        canceledAt: lost,
        reason: 'capture_failed_expired',
      },
    });
  });
}

/**
 * Reverses a capture, or releases the hold it never captured (AAP 0.3.2 "Fencing").
 *
 * A reversal always retrieves the PaymentIntent first, because it resolves against the **actual**
 * state rather than against the plan's assumption: a captured intent is refunded, an uncaptured one
 * is cancelled, and an already-cancelled one needs nothing. That is what lets a reversing refund
 * release a hold whose capture never ran, and what makes the operation safe to replay — an effect
 * that already happened is recorded, never repeated.
 *
 * A charge the provider reports as already refunded is that same rule on the deposit: the money is
 * back, so the deposit takes AAP 0.5.3's `captured → refunded` row whether the refund was sent by
 * this pass or delivered by a webhook this pass never saw.
 *
 * @param services - The app's services.
 * @param claim - The claimed `refund` operation.
 * @returns The outcome.
 */
async function executeRefund(
  services: AppServices,
  claim: ClaimedOperation,
): Promise<PendingOutcome> {
  const operation = claim.operation;
  const deposit =
    operation.depositId === null
      ? null
      : await services.db.deposit.findUnique({ where: { id: operation.depositId } });

  if (deposit === null) {
    await unclaim(services, claim, 'refund_context_missing');
    services.logger.error({ event: 'payment_refund_context_missing', operationId: operation.id });
    return pendingOutcome('skipped', await readOperation(services, operation.id));
  }

  const attempt = operation.attempt ?? deposit.currentAttempt;
  const paymentIntentId = await resolveIntentId(services, operation, deposit, attempt);

  if (paymentIntentId === null) {
    return recordDepositSuccess(services, claim, deposit, attempt, null, { kind: 'none' });
  }

  let sent = false;

  try {
    const intent = await retrieveOrNull(services, paymentIntentId);

    if (intent === null || intent.status === 'canceled') {
      // Nothing was captured and nothing is outstanding, so there is nothing to reverse.
      return await recordDepositSuccess(services, claim, deposit, attempt, null, { kind: 'none' });
    }

    if (intent.status === 'succeeded') {
      if (intent.refunded) {
        // The provider already holds the refund this operation planned, so the money is back and the
        // deposit takes `refunded` exactly as it would have had this pass sent the call (AAP 0.5.3's
        // `captured → refunded` row); `advanceDeposit` ignores it when the deposit never captured.
        return await recordDepositSuccess(services, claim, deposit, attempt, paymentIntentId, {
          kind: 'refunded',
        });
      }

      await services.faults.hit(FAULT_BEFORE_SEND, {
        operationId: operation.id,
        kind: operation.kind,
      });
      sent = true;
      await services.payments.refund(paymentIntentId, operation.idempotencyKey);
      await services.faults.hit(FAULT_AFTER_SEND, {
        operationId: operation.id,
        kind: operation.kind,
      });

      return await recordDepositSuccess(services, claim, deposit, attempt, paymentIntentId, {
        kind: 'refunded',
      });
    }

    // The capture never happened, so the reversal cancels the authorization instead. The intent the
    // cancel reports decides whether that was our release or a hold that had already expired.
    await services.faults.hit(FAULT_BEFORE_SEND, {
      operationId: operation.id,
      kind: operation.kind,
    });
    sent = true;
    const released = await services.payments.releaseHold(paymentIntentId, operation.idempotencyKey);
    await services.faults.hit(FAULT_AFTER_SEND, {
      operationId: operation.id,
      kind: operation.kind,
    });

    return await recordCancellation(services, claim, deposit, attempt, released, paymentIntentId);
  } catch (error) {
    const failure = classifyPaymentFailure(error);

    if (failure === 'unavailable') {
      return recordAlone(services, claim, {
        status: 'failed_retryable',
        lastError: errorField(error, 'reason') ?? 'unavailable',
      });
    }

    if (failure === 'rejected' || failure === 'declined' || failure === 'idempotency') {
      // The refusal could be about a charge that was never captured, about a refund that already
      // exists, or about a request the provider will refuse again, so the charge's state is read
      // again rather than assumed (AAP 0.3.2): both of the first two are satisfied reversals — the
      // money is back, so the deposit takes `refunded` — and the third is the retryable failure
      // named here. A definite failure therefore ends terminal or retryable, never `executing`.
      const intent = await retrieveOrNull(services, paymentIntentId);

      if (intent === null || intent.status === 'canceled') {
        return recordDepositSuccess(services, claim, deposit, attempt, paymentIntentId, {
          kind: 'none',
        });
      }

      if (intent.refunded) {
        return recordDepositSuccess(services, claim, deposit, attempt, paymentIntentId, {
          kind: 'refunded',
        });
      }

      return recordAlone(services, claim, {
        status: 'failed_retryable',
        lastError: errorField(error, 'code') ?? `${operation.kind}_${FAILURE_TOKEN[failure]}`,
      });
    }

    if (!sent) {
      await unclaim(services, claim, 'refund_not_sent');
    }

    services.logger.error({
      event: 'payment_op_failed',
      operationId: operation.id,
      kind: 'refund',
      err: error,
    });
    throw error;
  }
}

/**
 * Deletes the Stripe customer of an erased account (AAP 0.5.3 payment reconciliation).
 *
 * The customer outlives every attempt of every deposit of its owner, so this is the one operation
 * that must wait for the rest: `me/deletion.ts` plans it with its own copy of the customer id, and
 * the account's data is erased while it waits. A null copy is a satisfied no-op, which keeps "one
 * deletion operation per account" true for an account that never saved a card.
 *
 * A definite refusal is terminal rather than retryable: no retry can delete a customer the provider
 * refused to delete, so the row records the provider's own code and stops looping, and the error
 * line is what tells an operator the erasure still owes a customer deletion. `unavailable` stays
 * retryable — the answer was lost, so the request may or may not have landed — and an unclassifiable
 * error keeps the crash path.
 *
 * @param services - The app's services.
 * @param claim - The claimed `delete_customer` operation.
 * @returns The outcome.
 */
async function executeDeleteCustomer(
  services: AppServices,
  claim: ClaimedOperation,
): Promise<PendingOutcome> {
  const operation = claim.operation;
  const customerId = operation.stripeCustomerId;

  if (customerId === null) {
    return recordAlone(services, claim, { status: 'succeeded', lastError: 'no_customer' });
  }

  let sent = false;

  try {
    await services.faults.hit(FAULT_BEFORE_SEND, {
      operationId: operation.id,
      kind: operation.kind,
    });
    sent = true;
    await services.payments.deleteCustomer(customerId, operation.idempotencyKey);
    await services.faults.hit(FAULT_AFTER_SEND, {
      operationId: operation.id,
      kind: operation.kind,
    });

    const now = services.clock.now();

    return transact(services, async (tx): Promise<PendingOutcome> => {
      // The copied id is cleared in the transaction that records the success and not before, so an
      // interrupted deletion keeps the id it still needs (AAP 0.5.2).
      const written = await recordOperation(
        tx,
        claim,
        { status: 'succeeded', stripeCustomerId: null },
        now,
      );

      return pendingOutcome(written.recorded ? 'succeeded' : 'skipped', written.operation);
    });
  } catch (error) {
    const failure = classifyPaymentFailure(error);

    if (failure === 'unavailable') {
      return recordAlone(services, claim, {
        status: 'failed_retryable',
        lastError: errorField(error, 'reason') ?? 'unavailable',
      });
    }

    if (failure === 'rejected' || failure === 'declined' || failure === 'idempotency') {
      // A customer delete cannot be recovered by retrying: the request the provider refused will be
      // refused again, and a reused key whose parameters changed will never be honored. The row
      // therefore stops looping and records the provider's own code, which is what the operator
      // needs to finish the erasure by hand (AAP 0.5.3 "Payment reconciliation").
      const code = errorField(error, 'code') ?? `${operation.kind}_${FAILURE_TOKEN[failure]}`;
      services.logger.error({
        event: 'payment_customer_delete_failed',
        operationId: operation.id,
        kind: operation.kind,
        code,
      });
      return recordAlone(services, claim, { status: 'failed_terminal', lastError: code });
    }

    if (!sent) {
      await unclaim(services, claim, 'delete_customer_not_sent');
    }

    services.logger.error({
      event: 'payment_op_failed',
      operationId: operation.id,
      kind: 'delete_customer',
      err: error,
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Shared lookups and post-commit work (AAP 0.3.2)
// ---------------------------------------------------------------------------------------------

/**
 * The PaymentIntent an operation concerns.
 *
 * The row's own id is authoritative; a `release` planned while its attempt's create was still
 * ambiguous carries none, and the only way to learn it is that attempt's `hold` row, whose replay
 * (`executeHold`) persists it there (`planRelease` documents the same resolution).
 *
 * @param services - The app's services.
 * @param operation - The operation.
 * @param deposit - The deposit it belongs to.
 * @param attempt - The attempt it concerns.
 * @returns The PaymentIntent id, or null when nothing was ever authorized under that key.
 */
async function resolveIntentId(
  services: AppServices,
  operation: PaymentOperation,
  deposit: Deposit,
  attempt: number,
): Promise<string | null> {
  if (operation.paymentIntentId !== null) {
    return operation.paymentIntentId;
  }

  const hold = await findHoldOperation(services.db, deposit.id, attempt);
  return hold?.paymentIntentId ?? null;
}

/**
 * Reads a PaymentIntent, treating "no such id" as the absence of an effect (AAP 0.3.2).
 *
 * The gateway reports a missing intent as a definite refusal, which is the right answer for a
 * reconciliation: a key under which no request was ever performed has no intent, so there is nothing
 * to reconcile. An unreadable intent still throws, because nothing is decided from a state that
 * could not be observed.
 *
 * @param services - The app's services.
 * @param paymentIntentId - The intent to read.
 * @returns The intent state, or null when the provider has no such intent.
 */
async function retrieveOrNull(
  services: AppServices,
  paymentIntentId: string,
): Promise<IntentState | null> {
  try {
    return await services.payments.retrievePaymentIntent(paymentIntentId);
  } catch (error) {
    if (classifyPaymentFailure(error) === 'rejected') {
      return null;
    }
    throw error;
  }
}

/** Whether this pass is a replay rather than the operation's first send. */
function isReplay(claim: ClaimedOperation): boolean {
  return claim.from !== 'pending' || claim.priorTries > 0;
}

/** How long ago an instant was, by the injected clock. */
function elapsedSince(services: AppServices, at: Date): number {
  return services.clock.now().getTime() - at.getTime();
}

/**
 * Deletes the customer of an account whose money has all finished (AAP 0.5.3).
 *
 * The gate is the whole point of a durable deletion operation: the customer is deleted only once no
 * deposit of the account can still move money and no dispute still has to decide any, so an erasure
 * can never take away the provider object a pending settlement or a dispute resolution needs.
 *
 * **Interpretation of a plan gap.** AAP 0.5.3 names every final deposit status as the gate, which a
 * never-retried decline would block forever: a `failed` deposit whose meetup is over cannot move
 * again on its own, and no retry will come for it, so such a deposit counts as settled here once its
 * meetup has reached a final status and it has no operation still open. Without that reading the
 * customer of an account whose only attempt was declined would never be erased.
 *
 * @param db - The guarded client.
 * @param operation - The `delete_customer` operation being considered.
 * @returns True when the deletion may run.
 */
async function deletionReady(db: DbClient, operation: PaymentOperation): Promise<boolean> {
  const openElsewhere = await db.paymentOperation.findFirst({
    where: {
      userId: operation.userId,
      id: { not: operation.id },
      status: { notIn: [...TERMINAL_OPERATION_STATUSES] },
    },
    select: { id: true },
  });

  if (openElsewhere !== null) {
    return false;
  }

  const openDispute = await db.dispute.findFirst({
    where: {
      status: 'open',
      meetup: { OR: [{ initiatorId: operation.userId }, { recipientId: operation.userId }] },
    },
    select: { id: true },
  });

  if (openDispute !== null) {
    return false;
  }

  const unsettled = await db.deposit.count({
    where: {
      ownerId: operation.userId,
      status: { notIn: [...FINAL_DEPOSIT_STATUSES] },
      OR: [
        { status: { not: 'failed' } },
        { meetup: { status: { notIn: [...FINAL_MEETUP_STATUSES] } } },
        { operations: { some: { status: { notIn: [...TERMINAL_OPERATION_STATUSES] } } } },
      ],
    },
  });

  return unsettled === 0;
}

/**
 * The extra `WHERE` an operation must satisfy for this pass to consider it open.
 *
 * A `pending` or `failed_retryable` row may run; an `executing` row may run only when its claim is
 * older than {@link INTERRUPTED_AFTER_MS} or missing, which is the row whose answer was lost. Every
 * other status is terminal or in flight and is left alone.
 *
 * @param now - The instant the interrupt window is measured back from.
 * @returns A Prisma filter for the open statuses.
 */
function openOperations(now: Date): Prisma.PaymentOperationWhereInput {
  return {
    OR: [
      { status: { in: ['pending', 'failed_retryable'] } },
      {
        status: 'executing',
        OR: [
          { claimedAt: null },
          { claimedAt: { lt: new Date(now.getTime() - INTERRUPTED_AFTER_MS) } },
        ],
      },
    ],
  };
}

/** The `WHERE` clause {@link runOperationsFor} scopes its loop with. */
function scopeOperations(scope: OperationScope): Prisma.PaymentOperationWhereInput {
  return 'meetupId' in scope
    ? { deposit: { is: { meetupId: scope.meetupId } } }
    : { userId: scope.userId };
}

/**
 * Compensates a forfeit whose hold turned out to have been lost before it committed (AAP 0.3.2).
 *
 * It runs after the recording transaction has committed, because it opens a transaction of its own
 * and takes the meetup row lock; its planned reversal is then executed in the same call, which is the
 * order `compensateLostHold` documents for its callers. A failure here is logged rather than thrown:
 * the operation it follows is already recorded, and reporting it as failed would invite a retry of a
 * call that has nothing left to do.
 *
 * @param services - The app's services.
 * @param evidence - The lost hold and how the loss became known.
 */
async function compensate(services: AppServices, evidence: Compensation): Promise<void> {
  try {
    const result = await compensateLostHold(services, evidence.meetupId, {
      depositId: evidence.depositId,
      reason: evidence.reason,
      canceledAt: evidence.canceledAt,
    });

    if (result === 'compensated') {
      await runOperationsFor(services, { meetupId: evidence.meetupId });
    }
  } catch (error) {
    services.logger.error({
      event: 'payment_operation_compensation_failed',
      meetupId: evidence.meetupId,
      err: error,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// The entry points (AAP 0.3.2, AAP 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * Runs one payment operation to its end: claims it, calls the provider and records the result.
 *
 * The `delete_customer` gate is checked **before** the claim, so an operation that is not ready is
 * left `pending` and untouched rather than claimed and handed back; every other kind is claimed
 * first, which is what makes two executors racing on one row harmless.
 *
 * @param services - The app's services.
 * @param operationId - The operation to run.
 * @returns What the operation reached, and the row it left behind.
 * @throws PaymentError when the provider call fails in a way this file records, and any other error
 *   when something outside the provider fails: a crashed recording transaction is deliberately
 *   surfaced, because the row's `executing` state and the reclaim are the recovery for it.
 */
export async function executeOperation(
  services: AppServices,
  operationId: string,
): Promise<ExecutionResult> {
  const peeked = await readOperation(services, operationId);

  if (peeked === null) {
    return { status: 'skipped', operation: null };
  }

  if (peeked.kind === 'delete_customer' && !(await deletionReady(services.db, peeked))) {
    services.logger.debug({ event: 'delete_customer_not_ready', operationId });
    return { status: 'skipped', operation: peeked };
  }

  const claim = await claimOperation(services, operationId);

  if (claim === null) {
    return { status: 'skipped', operation: peeked };
  }

  const outcome = await runClaimed(services, claim);

  if (outcome.compensate !== undefined) {
    await compensate(services, outcome.compensate);
  }

  services.logger.info({
    event: 'payment_op',
    operationId,
    kind: claim.operation.kind,
    status: outcome.status,
  });

  return outcome.hold === undefined
    ? { status: outcome.status, operation: outcome.operation }
    : { status: outcome.status, operation: outcome.operation, hold: outcome.hold };
}

/**
 * Runs one hold attempt and reports the outcome the holding route answers with (AAP 0.3.2, 0.5.4).
 *
 * The callers are `meetups/propose.ts`, `meetups/accept.ts` and the hold-retry handler, all of which
 * run this **after** their own transaction has committed: a hold's result is the response, so it
 * cannot be deferred to the sweeper the way a release or a capture can.
 *
 * It never throws for a payment outcome. A failure this file does not record leaves the row for the
 * reclaim, and the answer is `unavailable` — the client recovers through `GET /meetups`, where the
 * side shows `pending` until the recovery resolves. A client secret is returned only for the
 * caller's own attempt, which is the deposit the route authorized the caller against.
 *
 * @param services - The app's services.
 * @param operationId - The `hold` operation to run.
 * @returns The outcome, with the caller's own client secret on `held` and `requires_action`.
 */
export async function executeHoldInline(
  services: AppServices,
  operationId: string,
): Promise<HoldExecution> {
  try {
    const result = await executeOperation(services, operationId);

    if (result.hold !== undefined) {
      return result.hold;
    }

    return result.status === 'skipped' ? { outcome: 'pending' } : { outcome: 'unavailable' };
  } catch (error) {
    services.logger.error({
      event: 'payment_hold_inline_failed',
      operationId,
      err: error,
    });
    return { outcome: 'unavailable' };
  }
}

/**
 * Executes every open operation of one meetup or one account, in plan order (AAP 0.3.2).
 *
 * Every module that planned operations calls this after its transaction commits — the state machine's
 * callers, the settlement, the operator resolutions and the deletion disposition — so a plan written
 * by a decision is carried out in the same request that took it. A plan written **during** a pass
 * (the orphan release a hold outcome adds, the refund a compensation adds) is only visible to the
 * next pass, which is why the loop re-reads its scope until a pass makes no progress.
 *
 * It exists in after-commit paths, so it never throws: a failure is logged and the pass continues,
 * and the sweeper is the backstop for anything left open.
 *
 * @param services - The app's services.
 * @param scope - The meetup whose deposits' operations run, or the account whose operations run.
 */
export async function runOperationsFor(
  services: AppServices,
  scope: OperationScope,
): Promise<void> {
  for (let pass = 0; pass < MAX_SCOPE_PASSES; pass += 1) {
    let open: readonly PaymentOperation[];

    try {
      open = await services.db.paymentOperation.findMany({
        where: { AND: [scopeOperations(scope), openOperations(services.clock.now())] },
        orderBy: [{ depositId: 'asc' }, { seq: 'asc' }, { createdAt: 'asc' }],
        take: DEFAULT_PENDING_LIMIT,
      });
    } catch (error) {
      services.logger.error({ event: 'payment_operations_unreadable', err: error });
      return;
    }

    if (open.length === 0) {
      return;
    }

    let progressed = false;

    for (const operation of open) {
      try {
        const result = await executeOperation(services, operation.id);
        if (result.status !== 'skipped') {
          progressed = true;
        }
      } catch (error) {
        services.logger.error({
          event: 'payment_op_failed',
          operationId: operation.id,
          kind: operation.kind,
          err: error,
        });
      }
    }

    if (!progressed) {
      return;
    }
  }
}

/**
 * Executes the operations the sweeper's pass resumes: everything open, oldest decision first
 * (AAP 0.3.2 "Settlement").
 *
 * This is the recovery path for every interrupted call: an `executing` row whose claim died with its
 * process, an ambiguous hold create whose answer was lost, and a retryable failure. It depends on
 * PostgreSQL and the payment gateway alone, so it keeps working while Redis is down, which is what
 * the whole settlement design rests on.
 *
 * @param services - The app's services.
 * @param opts - The batch size; `limit` defaults to 100, which is far more than one 60-second window
 *   can accumulate at pilot scale.
 * @returns How many operations the pass examined, and how they ended.
 */
export async function runPendingOperations(
  services: AppServices,
  opts?: { readonly limit?: number },
): Promise<PendingOperationsSummary> {
  const rows = await services.db.paymentOperation.findMany({
    where: openOperations(services.clock.now()),
    orderBy: [{ createdAt: 'asc' }],
    take: opts?.limit ?? DEFAULT_PENDING_LIMIT,
  });

  const summary = { attempted: rows.length, succeeded: 0, retryable: 0, terminal: 0, skipped: 0 };

  for (const row of rows) {
    try {
      const result = await executeOperation(services, row.id);

      if (result.status === 'succeeded') {
        summary.succeeded += 1;
      } else if (result.status === 'failed_retryable') {
        summary.retryable += 1;
      } else if (result.status === 'failed_terminal') {
        summary.terminal += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      summary.skipped += 1;
      services.logger.error({
        event: 'payment_op_failed',
        operationId: row.id,
        kind: row.kind,
        err: error,
      });
    }
  }

  return summary;
}
