/**
 * Recoverable settlement and hold-loss compensation: the module that turns a meetup's presence record into the money,
 * reputation and notification decision of AAP 0.5.7, and compensates a forfeit whose hold turned out to have been
 * lost before it ran.
 *
 * `settlement/queue.ts` (the `settle-<meetupId>` and `lapse-<meetupId>` jobs), `settlement/sweeper.ts`, the late
 * cancellation and `DELETE /me` disposition of `meetups/cancel.ts` and the operator's `settle_by_checkins` in
 * `admin/disputes.ts` call {@link settleMeetup}; `payments/operations.ts` and `payments/webhook.ts` call
 * {@link compensateLostHold}. None of them is imported here, because all four import this file and the edge back
 * would close a runtime ESM cycle. A caller that needs the planned Stripe calls executed runs
 * `runOperationsFor(services, …)` **after** these functions return.
 *
 * The split with `meetups/state-machine.ts`, which owns `Meetup.status`, the row lock, the deposit releases of a
 * final state, the `lock_lost` event's analytics and notifications, and the timers: its `settle` and `compensate`
 * cases are deliberately empty, and everything a settlement or a compensation decides is written here, in the
 * caller's transaction — the capture and release `PaymentOperation`s, the Table Credit entry, the witness events,
 * the pair history, the lodging activity facts, the analytics and the notifications.
 *
 * Reconciliation precedes the transaction: immediately before it, {@link settleMeetup} retrieves both current
 * PaymentIntents and reads the authoritative state — a hold Stripe cancelled or expired is a **hold loss**, and the
 * meetup takes the `lock_lost` row with no forfeit and no Table Credit. The retrieval happens outside the
 * transaction, because a provider call held inside one would keep the meetup row lock for as long as Stripe took.
 *
 * Idempotency: `MeetupSettlement.meetupId` is the anchor — inserting it with `ON CONFLICT DO NOTHING` and
 * abandoning the run when nothing was inserted makes a second settlement a no-op, which is what the sweeper
 * overlapping a delayed job depends on; the unique keys of `WitnessEvent (meetupId, userId)` and
 * `TableCreditEntry (meetupId, userId, kind)` cover the writes behind it, and the idempotency keys of the payment
 * operations cover the money: running {@link settleMeetup} twice yields one capture, one Table Credit entry and
 * one `PairHistory` increment.
 *
 * Time comes from `services.clock` and never from `Date.now()`; money is integer USD cents; log lines carry ids,
 * statuses and outcomes only — no coordinate, card field, email address or `PaymentIntent` id.
 */

import type { DbClient, DbTx, Deposit } from '@tablemate/db';
import { OUR_CANCELLATION_REASON } from '@tablemate/shared';
import type { ParticipantRole, SettlementOutcome } from '@tablemate/shared';

import { emit, emitMany } from '../analytics/emit.ts';
import type { EmitFields } from '../analytics/emit.ts';
import { notifyAll } from '../notifications/enqueue.ts';
import { transact } from '../outbox/write.ts';
import type { AfterCommit } from '../outbox/write.ts';
import type { IntentState } from '../payments/gateway.ts';
import {
  advanceDeposit,
  depositsForMeetup,
  fenceCaptures,
  findHoldOperation,
  planCapture,
  planRelease,
  planReversal,
} from '../payments/holds.ts';
import { invalidateLeaderboard, recordLodgingActivity } from '../lodgings/leaderboard.ts';
import { countsForReputation } from '../reputation/anti-farming.ts';
import { recordCompletion } from '../reputation/pair-history.ts';

import { isLateCancel, lockMeetup, transition } from '../meetups/state-machine.ts';
import { loadMeetup, participantRole } from '../meetups/queries.ts';
import type { MeetupRow } from '../meetups/queries.ts';

import { lateCancelPlan, otherRole, settlementPlan } from './outcomes.ts';
import type { Presence, SettlementPlan } from './outcomes.ts';
import { escalationDueAt, lapseDueAt, settleDueAt } from './timers.ts';

import type { AppServices } from '../../app.ts';

/**
 * What asked for a settlement. A log field only: the same decision is taken whichever caller reached it, and
 * nothing about the trigger is stored on the meetup, the settlement or an operation.
 */
export type SettleTrigger = 'timer' | 'sweeper' | 'operator' | 'cancel' | 'deletion';

/**
 * How {@link settleMeetup} was asked to settle.
 *
 * `outcome: 'late_cancel'` is the shared procedure with an outcome that is already known — the canceller's hold
 * captured, the counterpart's released and the counterpart credited, without waiting for the window — and with the
 * same reconciliation of both authorizations first, so a hold lost before it ran still yields `lock_lost` rather
 * than capturing a card with nothing on it. `fenceUserId` is the account-deletion write fence, passed by
 * `meetups/cancel.ts` for a participant's own cancellation; a deletion and every system trigger pass none, because
 * the deleting user's row already carries `deletionRequestedAt` and its own transaction holds that lock.
 */
export interface SettleOptions {
  readonly trigger: SettleTrigger;
  readonly outcome?: 'late_cancel';
  readonly cancellerId?: string;
  readonly fenceUserId?: string;
}

/**
 * Why {@link settleMeetup} did not settle a meetup: `not_found` covers an unknown meetup id and a meetup whose
 * venue row is gone, the one other row the settlement cannot proceed without; `deposit_not_held` is the racing
 * hold loss, whose own webhook will have moved the meetup by the time the next run reads it.
 */
export type SettleReason =
  | 'dispute_open'
  | 'not_due'
  | 'not_locked'
  | 'not_found'
  | 'already_settled'
  | 'not_late'
  | 'deposit_not_held';

/**
 * What {@link settleMeetup} decided. A flat object with optionals rather than a discriminated union, so a caller
 * reads `result` first and then whatever that case carries: `outcome` only on `settled`, `reason` only when nothing
 * settled, `lostDepositIds` only on `lock_lost`. No field is a provider identifier.
 */
export interface SettleResult {
  /** `settled` applied an outcome, `lock_lost` ended the meetup without one, `postponed` may still settle later, `noop` will never settle it in this state. */
  readonly result: 'settled' | 'postponed' | 'noop' | 'lock_lost';
  readonly outcome?: SettlementOutcome;
  readonly reason?: SettleReason;
  readonly lostDepositIds?: readonly string[];
}

export interface LostHold {
  readonly depositId: string;
  readonly canceledAt: Date;
}

/**
 * What {@link applyHoldLossInTx} did: `applied` is false when the meetup was no longer `locked` by the time the
 * transaction took its row — a racing settlement, cancellation or hold-loss webhook won — in which case the caller
 * records the result its own read implied and writes nothing.
 */
export interface HoldLossResult {
  readonly applied: boolean;
  readonly lostDepositIds: readonly string[];
}

/**
 * Why a forfeit is being compensated. `capture_failed_expired` is raised by the executor when the capture of the
 * absent party's hold fails terminally on an authorization that had expired — the one place the loss becomes
 * visible after the settlement committed. `hold_lost_before_apply` is raised by the webhook handler for a hold-loss
 * event on a meetup that is already `forfeited`, and carries Stripe's own cancellation instant so the decision can
 * be made against `MeetupSettlement.appliedAt`.
 */
export interface LostHoldEvidence {
  readonly depositId: string;
  readonly reason: 'capture_failed_expired' | 'hold_lost_before_apply';
  readonly canceledAt?: Date;
}

/**
 * What {@link compensateLostHold} decided. `compensated` reversed a forfeit: the capture was fenced, a reversing
 * refund planned, the Table Credit entry voided and the meetup moved to `lock_lost`. `deposit_expired_only` records
 * the lost hold on its deposit and moves no money, because the outcome stands — a `completed` or `unattended`
 * settlement releases both holds anyway, and a loss that happened after the settlement committed cannot change a
 * forfeit decided before it. `noop` is the idempotent replay of a decision already taken, or evidence that does not
 * belong to the meetup.
 */
export type CompensationResult = 'compensated' | 'deposit_expired_only' | 'noop';

/**
 * A PaymentIntent in a state this application cannot interpret. Raised rather than deciding money on a state it
 * could not read: the queue processor retries, the sweeper logs the failure and moves on, and no outcome is applied
 * until the state is one the rule covers. The fields are ids and the provider's status alone — never a
 * `PaymentIntent` id and never a client secret. The prototype is re-set so `instanceof` holds under the ES2023
 * class output.
 */
export class SettlementReconcileError extends Error {
  readonly meetupId: string;
  readonly depositId: string;
  readonly intentStatus: string;

  constructor(fields: {
    readonly meetupId: string;
    readonly depositId: string;
    readonly intentStatus: string;
  }) {
    super(
      `meetup ${fields.meetupId}: the authorization of deposit ${fields.depositId} is ${fields.intentStatus}`,
    );
    this.name = 'SettlementReconcileError';
    this.meetupId = fields.meetupId;
    this.depositId = fields.depositId;
    this.intentStatus = fields.intentStatus;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Settle one meetup, idempotently and recoverably.
 *
 * Runs in four steps, in this order for a reason:
 *
 * 1. **Read-only pre-checks, no lock.** An unknown meetup, one that is not `locked`, one whose settlement is not
 *    due and one with an open dispute are answered without taking a row lock or touching Stripe. An open dispute
 *    `postpones` the settlement while the meetup stays `locked`, so both attendees can still check in inside the
 *    window; the operator's `settle_by_checkins` resolution closes the dispute in its own transaction and calls
 *    back here **after** committing, which is why no special case for it exists below.
 * 2. **Reconciliation of both authorizations, outside any transaction** — see {@link reconcileAuthorizations}.
 * 3. **A lost hold instead of an outcome.** Any lost hold takes `lock_lost` — no forfeit, no Table Credit, the
 *    other hold released — through {@link applyHoldLossInTx}.
 * 4. **The settlement transaction.** Every database effect of the outcome is written in one transaction behind the
 *    meetup row lock, and the Stripe calls are only *planned* there: the executor runs them after the commit.
 *
 * The caller runs the planned operations after this returns; nothing here executes one.
 *
 * @throws SettlementReconcileError when a PaymentIntent is in a state the rule does not cover.
 * @throws PaymentUnavailableError when a retrieval could not reach the provider: the queue retries and the sweeper
 *   logs it, and no outcome is applied from a state that could not be observed.
 */
export async function settleMeetup(
  services: AppServices,
  meetupId: string,
  options: SettleOptions = { trigger: 'sweeper' },
): Promise<SettleResult> {
  const now = services.clock.now();
  const late = options.outcome === 'late_cancel';

  // Step A. The status, the due time and the dispute are checked twice on purpose: once here without a lock, so an
  // impossible call costs nothing, and once inside the transaction, under the row lock that every other meetup
  // mutation also takes, where the answer cannot go stale.
  const meetup = await loadMeetup(services.db, meetupId);
  if (meetup === null) {
    return { result: 'noop', reason: 'not_found' };
  }
  if (meetup.status !== 'locked') {
    return { result: 'noop', reason: 'not_locked' };
  }
  if (late) {
    if (
      options.cancellerId === undefined ||
      participantRole(meetup, options.cancellerId) === null
    ) {
      throw new Error('settleMeetup: a late cancellation needs its canceller as a participant');
    }
    if (!isLateCancel(now, meetup.startsAt)) {
      return { result: 'noop', reason: 'not_late' };
    }
  } else if (now.getTime() < settleDueAt(meetup.startsAt).getTime()) {
    return { result: 'postponed', reason: 'not_due' };
  }
  if (await hasOpenDispute(services.db, meetupId)) {
    return { result: 'postponed', reason: 'dispute_open' };
  }

  // Step B.
  const lost = await reconcileAuthorizations(services, meetup, now);

  // Step C.
  if (lost.length > 0) {
    const applied = await transact(
      services,
      (tx, after) => applyHoldLossInTx(tx, services, after, meetupId, lost),
      transactOptions(options),
    );

    if (!applied.applied) {
      // A racing settlement, cancellation or hold-loss webhook took the row first: its outcome stands and this run
      // writes nothing.
      return { result: 'noop', reason: 'not_locked' };
    }

    services.logger.info({
      event: 'settlement_lock_lost',
      meetupId,
      trigger: options.trigger,
      lostDeposits: applied.lostDepositIds.length,
    });

    return { result: 'lock_lost', lostDepositIds: applied.lostDepositIds };
  }

  // Step D.
  return transact(
    services,
    (tx, after) => settleInTx(tx, services, after, meetupId, options, now),
    transactOptions(options),
  );
}

/**
 * Retrieve both current PaymentIntents and report the holds that are gone.
 *
 * The retrieval is the authoritative check the settlement makes before it decides money: a hold Stripe cancelled
 * or expired is a **loss**, not a deposit to capture, and it must be seen here rather than discovered by a failing
 * capture after the outcome was applied. Both deposits are read in the role order `depositsForMeetup` fixes, so the
 * same meetup is examined in the same order on every pass.
 *
 * - `requires_capture` — intact; the outcome may be applied.
 * - `canceled` with a reason other than ours — a loss; `expired` is what an expired authorization reads as under
 *   the pinned API version.
 * - any other state, `canceled` under **our** own reason included — refused; see {@link classifyIntent}.
 * - a deposit whose status is already `expired` — a loss the webhook recorded first, with the `canceledAt` it
 *   stored.
 *
 * Deposits in any other status are not examined: the settlement transaction refuses a meetup whose deposits are
 * not both `held`, which is the racing hold loss the webhook settles.
 *
 * @throws SettlementReconcileError for a state this rule does not cover.
 * @throws PaymentUnavailableError when the provider cannot be reached.
 */
async function reconcileAuthorizations(
  services: AppServices,
  meetup: MeetupRow,
  now: Date,
): Promise<LostHold[]> {
  const deposits = await depositsForMeetup(services.db, meetup.id);
  const lost: LostHold[] = [];

  for (const deposit of deposits) {
    if (deposit.status === 'expired') {
      lost.push({ depositId: deposit.id, canceledAt: deposit.canceledAt ?? now });
      continue;
    }
    if (deposit.status !== 'held') {
      continue;
    }

    const intentId = deposit.currentPaymentIntentId;
    if (intentId === null) {
      // A `held` deposit always records the attempt's PaymentIntent, so this is a broken invariant rather than a provider
      // answer: the loss cannot be established and no outcome may be applied.
      services.logger.error({
        event: 'settlement_intent_missing',
        meetupId: meetup.id,
        depositId: deposit.id,
        status: deposit.status,
      });
      throw new SettlementReconcileError({
        meetupId: meetup.id,
        depositId: deposit.id,
        intentStatus: 'missing',
      });
    }

    const intent = await services.payments.retrievePaymentIntent(intentId);
    if (classifyIntent(services, meetup.id, deposit.id, intent) === 'lost') {
      lost.push({ depositId: deposit.id, canceledAt: intent.canceledAt ?? now });
    }
  }

  return lost;
}

/**
 * Whether the provider says the attempt's authorization is still there: `intact` for a `requires_capture` hold,
 * `lost` for a cancellation that was not ours.
 *
 * @throws SettlementReconcileError for every other state, including our own cancellation.
 */
function classifyIntent(
  services: AppServices,
  meetupId: string,
  depositId: string,
  intent: IntentState,
): 'intact' | 'lost' {
  if (intent.status === 'requires_capture') {
    return 'intact';
  }
  if (intent.status === 'canceled' && intent.cancellationReason !== OUR_CANCELLATION_REASON) {
    return 'lost';
  }

  services.logger.error({
    event: 'settlement_intent_unexpected',
    meetupId,
    depositId,
    status: intent.status,
    cancellationReason: intent.cancellationReason,
  });
  throw new SettlementReconcileError({ meetupId, depositId, intentStatus: intent.status });
}

/**
 * Whether the meetup has an open dispute, which postpones its settlement. An open dispute keeps the meetup
 * `locked` — it is not a status of its own — so check-in stays possible inside the window while the operator
 * decides, and the settlement waits; once resolved, the operator calls {@link settleMeetup} again, after its own
 * transaction committed.
 */
async function hasOpenDispute(db: DbClient | DbTx, meetupId: string): Promise<boolean> {
  const dispute = await db.dispute.findFirst({
    where: { meetupId, status: 'open' },
    select: { id: true },
  });

  return dispute !== null;
}

/** The write fence and transaction budget {@link settleMeetup} passes on, or nothing. */
function transactOptions(options: SettleOptions): { fenceUserId: string } | undefined {
  return options.fenceUserId === undefined ? undefined : { fenceUserId: options.fenceUserId };
}

/**
 * End a meeting whose authorizations are gone, without forfeiting anything. `payments/webhook.ts` reuses this
 * helper for a hold-loss event, which is why it is exported: the decision is identical whether the loss was found
 * by the settlement's own retrieval or reported by Stripe first.
 *
 * The ordering below is not interchangeable:
 *
 * 1. **The event must name a deposit that is still `held`.** `recordHoldLoss` in `meetups/state-machine.ts` marks
 *    the named deposit `expired` and only then moves the meetup, and it reports `movesMeetup: false` for a deposit
 *    that is not `held` — so the `lock_lost` row can only be taken through a live hold. When every lost deposit is
 *    already `expired`, this refuses with {@link SettlementReconcileError} rather than writing `Meetup.status`
 *    outside the state machine. That state cannot persist: the deposit still authorized at Stripe expires on its
 *    own and its webhook moves the meetup with a live hold.
 * 2. **Every further lost deposit is marked `expired` first**, so the transition's `releaseAllOpen` does not plan a
 *    release for an authorization Stripe has already cancelled. Marking the one the event names is the
 *    transition's own job.
 *
 * The transition then does the rest: it releases the surviving hold, notifies both parties with the `lock_lost`
 * copy, emits the event, resolves an open dispute with the note `hold_expired`, drops the timers and publishes the
 * status frame. No Table Credit is granted — a lost hold moves no money.
 *
 * @throws SettlementReconcileError when no lost deposit is still `held`.
 */
export async function applyHoldLossInTx(
  tx: DbTx,
  services: AppServices,
  after: AfterCommit,
  meetupId: string,
  lost: readonly LostHold[],
): Promise<HoldLossResult> {
  const lostDepositIds = lost.map((entry) => entry.depositId);
  const meetup = await lockMeetup(tx, meetupId);

  if (meetup === null || meetup.status !== 'locked') {
    return { applied: false, lostDepositIds };
  }

  const deposits = await depositsForMeetup(tx, meetupId);
  const primary = lost.find((entry) => depositStatus(deposits, entry.depositId) === 'held') ?? null;

  if (primary === null) {
    const first = lostDepositIds.at(0) ?? meetupId;
    services.logger.error({
      event: 'settlement_hold_loss_unrecordable',
      meetupId,
      depositId: first,
      lostDeposits: lostDepositIds.length,
    });
    throw new SettlementReconcileError({
      meetupId,
      depositId: first,
      intentStatus: 'expired',
    });
  }

  for (const entry of lost) {
    if (entry.depositId === primary.depositId) {
      continue;
    }

    const deposit = depositOfId(deposits, entry.depositId);
    if (deposit === null) {
      continue;
    }

    // Forward-only: a deposit that is already `expired` is left as it stands, which is what makes a repeated pass over
    // the same loss a no-op.
    await advanceDeposit(
      tx,
      { depositId: deposit.id, attempt: deposit.currentAttempt },
      'expired',
      { canceledAt: entry.canceledAt },
    );
  }

  await transition(tx, services, after, meetup, {
    type: 'hold_lost',
    depositId: primary.depositId,
    canceledAt: primary.canceledAt,
  });

  return { applied: true, lostDepositIds };
}

/**
 * Apply one settlement outcome inside the caller's transaction.
 *
 * Every guard the pre-check applied is re-applied here, because the pre-check ran before the row lock: the status,
 * the dispute, the due time and the late-cancellation window are judged again on the row this transaction holds,
 * and the deposits are read again, so a hold-loss webhook that committed in between is seen rather than
 * overwritten.
 *
 * The database effects, in the order their invariants require:
 *
 * 1. `MeetupSettlement` is inserted with `ON CONFLICT DO NOTHING`, and a run that inserted nothing stops: that
 *    primary-key row is the settlement's idempotency anchor, so the sweeper overlapping a delayed job — or a queue
 *    retry after a crash — yields one outcome, one capture, one Table Credit entry and one `PairHistory` increment.
 * 2. The transition writes the meetup's new status, `settledAt`, `forfeitReason` and `finalAt`.
 * 3. Witness events, the pair history and the lodging activity facts record what was witnessed.
 * 4. Table Credit and the payment operations decide the money.
 * 5. Analytics and notifications tell the funnel and the two attendees.
 * 6. The fault point is the **last** statement in the transaction, so a test that crashes here rolls every effect
 *    above back and the next run settles the meetup exactly once.
 */
async function settleInTx(
  tx: DbTx,
  services: AppServices,
  after: AfterCommit,
  meetupId: string,
  options: SettleOptions,
  now: Date,
): Promise<SettleResult> {
  const meetup = await lockMeetup(tx, meetupId);
  if (meetup === null) {
    return { result: 'noop', reason: 'not_found' };
  }
  if (meetup.status !== 'locked') {
    return { result: 'noop', reason: 'not_locked' };
  }

  const late = options.outcome === 'late_cancel';
  const cancellerRole =
    late && options.cancellerId !== undefined ? participantRole(meetup, options.cancellerId) : null;

  if (late && cancellerRole === null) {
    throw new Error('settleMeetup: a late cancellation needs its canceller as a participant');
  }
  if (late && !isLateCancel(now, meetup.startsAt)) {
    return { result: 'noop', reason: 'not_late' };
  }
  if (!late && now.getTime() < settleDueAt(meetup.startsAt).getTime()) {
    return { result: 'postponed', reason: 'not_due' };
  }
  if (await hasOpenDispute(tx, meetupId)) {
    return { result: 'postponed', reason: 'dispute_open' };
  }

  const cityId = await venueCityId(tx, meetup);
  if (cityId === null) {
    services.logger.error({ event: 'settlement_venue_missing', meetupId, venueId: meetup.venueId });
    return { result: 'noop', reason: 'not_found' };
  }

  const deposits = await depositsForMeetup(tx, meetupId);
  const pair = heldDeposits(deposits);
  if (pair === null) {
    // A hold moved between the reconciliation and this lock: its webhook owns the meetup now, and it will have taken
    // the row.
    services.logger.error({
      event: 'settlement_deposit_not_held',
      meetupId,
      depositStatuses: deposits.map((deposit) => deposit.status),
    });
    return { result: 'noop', reason: 'deposit_not_held' };
  }

  const plan =
    late && cancellerRole !== null
      ? lateCancelPlan(cancellerRole)
      : settlementPlan(await presentRoles(tx, meetup));

  const inserted = await tx.meetupSettlement.createMany({
    data: [
      {
        meetupId: meetup.id,
        outcome: plan.outcome,
        status: 'applying',
        initiatorPresent: plan.initiatorPresent,
        recipientPresent: plan.recipientPresent,
        appliedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count === 0) {
    return { result: 'noop', reason: 'already_settled' };
  }

  await transition(tx, services, after, meetup, {
    type: 'settle',
    outcome: plan.outcome,
    at: now,
    source: 'settlement',
  });

  if (plan.witness) {
    await recordWitnessEvents(tx, meetup, cityId, now);
  }
  if (plan.pairHistory) {
    await recordCompletion(
      tx,
      { initiatorId: meetup.initiatorId, recipientId: meetup.recipientId },
      now,
    );
  }
  if (plan.lodgingActivity) {
    await recordLodgingActivity(
      tx,
      services,
      {
        id: meetup.id,
        initiatorId: meetup.initiatorId,
        recipientId: meetup.recipientId,
        startsAt: meetup.startsAt,
        cityId,
      },
      now,
    );
    after(() => invalidateLeaderboard(services, cityId));
  }
  if (plan.creditRole !== null) {
    await tx.tableCreditEntry.createMany({
      data: [
        {
          userId: userIdOf(meetup, plan.creditRole),
          meetupId: meetup.id,
          kind: 'grant',
          amountCents: meetup.depositCents,
        },
      ],
      skipDuplicates: true,
    });
  }

  await planSettlementMoney(tx, meetup, plan, pair, now);
  await emitMany(
    tx,
    services,
    plan.analytics.map((entry) => ({
      name: entry.name,
      actorUserId: userIdForRole(meetup, entry.actor),
      fields: settlementFields(meetup, cityId),
    })),
  );
  await notifyAll(tx, [meetup.initiatorId, meetup.recipientId], 'meetup_settled', {
    meetupId: meetup.id,
  });

  // Last statement of the transaction on purpose: a fault here rolls the whole settlement back.
  await services.faults.hit('settlement.inside_transaction', { meetupId: meetup.id });

  after(() =>
    services.logger.info({
      event: 'settlement_applied',
      meetupId: meetup.id,
      outcome: plan.outcome,
      trigger: options.trigger,
    }),
  );

  return { result: 'settled', outcome: plan.outcome };
}

/**
 * The meetup's two `held` deposits, or null when either side has no live hold. A settlement only ever decides
 * money that is still authorized, so this is the gate the transaction applies after re-reading both deposits rather
 * than trusting the pre-check's read.
 */
interface HeldDeposits {
  readonly initiator: Deposit;
  readonly recipient: Deposit;
}

function heldDeposits(deposits: readonly Deposit[]): HeldDeposits | null {
  const initiator = deposits.find((d) => d.role === 'initiator' && d.status === 'held') ?? null;
  const recipient = deposits.find((d) => d.role === 'recipient' && d.status === 'held') ?? null;

  return initiator === null || recipient === null ? null : { initiator, recipient };
}

function heldDepositOf(pair: HeldDeposits, role: ParticipantRole): Deposit {
  return role === 'initiator' ? pair.initiator : pair.recipient;
}

function depositOfId(deposits: readonly Deposit[], depositId: string): Deposit | null {
  return deposits.find((deposit) => deposit.id === depositId) ?? null;
}

function depositStatus(deposits: readonly Deposit[], depositId: string): string | null {
  return depositOfId(deposits, depositId)?.status ?? null;
}

/**
 * Which participants check-in witnessed: only a `pass` check-in counts, so a wrong code or a point outside the
 * geofence leaves that side absent. Ids are compared lowercased, as the rest of the meetups module does.
 */
async function presentRoles(tx: DbTx, meetup: MeetupRow): Promise<Presence> {
  const passed = await tx.checkIn.findMany({
    where: { meetupId: meetup.id, result: 'pass' },
    select: { userId: true },
  });
  const present = new Set(passed.map((checkIn) => checkIn.userId.toLowerCase()));

  return {
    initiatorPresent: present.has(meetup.initiatorId.toLowerCase()),
    recipientPresent: present.has(meetup.recipientId.toLowerCase()),
  };
}

/** The venue's city, which the meetup's local date, the lodging facts and every event carry. */
async function venueCityId(tx: DbTx, meetup: MeetupRow): Promise<string | null> {
  const venue = await tx.venue.findUnique({
    where: { id: meetup.venueId },
    select: { cityId: true },
  });

  return venue?.cityId ?? null;
}

/**
 * Write one witness event per participant. Both rows carry the **same** anti-farming verdict, computed once for
 * the pair: the rule answers for the completion, not for a side. The verdict limits the reputation counters and the
 * leaderboard score only — never `PairHistory` and never the disclosure tiers.
 */
async function recordWitnessEvents(
  tx: DbTx,
  meetup: MeetupRow,
  cityId: string,
  now: Date,
): Promise<void> {
  const countsForPair = await countsForReputation(tx, {
    userA: meetup.initiatorId,
    userB: meetup.recipientId,
    completedAt: now,
    depositCents: meetup.depositCents,
    excludeMeetupId: meetup.id,
  });

  await tx.witnessEvent.createMany({
    data: [
      {
        meetupId: meetup.id,
        userId: meetup.initiatorId,
        counterpartId: meetup.recipientId,
        venueId: meetup.venueId,
        cityId,
        completedAt: now,
        countsForReputation: countsForPair,
      },
      {
        meetupId: meetup.id,
        userId: meetup.recipientId,
        counterpartId: meetup.initiatorId,
        venueId: meetup.venueId,
        cityId,
        completedAt: now,
        countsForReputation: countsForPair,
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * Plan the capture and the releases one outcome decides. Stripe is never called here: each operation is a durable
 * row the executor runs after the commit, under its own idempotency key, and it is that row the webhook and the
 * sweeper reconcile against the PaymentIntent's real state.
 *
 * A release carries its attempt's `hold` operation as `dependsOnId`, so it can never run before the create it
 * releases. `releaseAllOpen` is deliberately **not** used: it releases every non-final deposit of the meetup,
 * which would release the very hold this settlement decided to capture.
 *
 * @throws SettlementReconcileError when a deposit to capture records no PaymentIntent at all.
 */
async function planSettlementMoney(
  tx: DbTx,
  meetup: MeetupRow,
  plan: SettlementPlan,
  pair: HeldDeposits,
  now: Date,
): Promise<void> {
  if (plan.captureRole !== null) {
    const deposit = heldDepositOf(pair, plan.captureRole);
    const intentId = await holdIntentId(tx, deposit);

    if (intentId === null) {
      // A `held` deposit always records the attempt's PaymentIntent; without one there is nothing to capture and the
      // settle is refused rather than silently left half-decided.
      throw new SettlementReconcileError({
        meetupId: meetup.id,
        depositId: deposit.id,
        intentStatus: 'missing',
      });
    }

    await planCapture(
      tx,
      { deposit, attempt: deposit.currentAttempt, paymentIntentId: intentId },
      now,
    );
  }

  for (const role of plan.releaseRoles) {
    const deposit = heldDepositOf(pair, role);
    const hold = await findHoldOperation(tx, deposit.id, deposit.currentAttempt);

    await planRelease(
      tx,
      {
        deposit,
        attempt: deposit.currentAttempt,
        paymentIntentId: deposit.currentPaymentIntentId ?? hold?.paymentIntentId ?? null,
        ...(hold === null ? {} : { dependsOnId: hold.id }),
      },
      now,
    );
  }
}

async function holdIntentId(tx: DbTx, deposit: Deposit): Promise<string | null> {
  if (deposit.currentPaymentIntentId !== null) {
    return deposit.currentPaymentIntentId;
  }

  const hold = await findHoldOperation(tx, deposit.id, deposit.currentAttempt);
  return hold?.paymentIntentId ?? null;
}

function userIdOf(meetup: MeetupRow, role: ParticipantRole): string {
  return role === 'initiator' ? meetup.initiatorId : meetup.recipientId;
}

function userIdForRole(meetup: MeetupRow, role: ParticipantRole | null): string | null {
  return role === null ? null : userIdOf(meetup, role);
}

/**
 * Compensate a forfeit whose hold turned out to have been lost before it was applied.
 *
 * A forfeit captures the absent party's hold and releases the other. When either hold turns out to have been lost
 * **before** the settlement committed, the money the forfeit moved has to come back: the capture is fenced, a
 * reversing operation is planned, the Table Credit entry is voided, the no-show disappears and the meetup takes
 * `lock_lost`. The evidence is one of two things, and the rule reads the same either way:
 *
 * - the capture failed terminally because the authorization had expired — the one place a loss that happened
 *   before the commit becomes visible *after* it;
 * - a hold-loss event arrived for a meetup that is already `forfeited`, carrying Stripe's own cancellation
 *   instant, and that instant precedes `MeetupSettlement.appliedAt`.
 *
 * | meetup status | evidence | result |
 * |---|---|---|
 * | `forfeited` | capture failed on an expired hold, or a loss whose `canceledAt` precedes `appliedAt` | full compensation |
 * | `forfeited` | a loss whose `canceledAt` is at or after `appliedAt` | the deposit is marked `expired`; the outcome stands |
 * | `completed` / `unattended` | any | the deposit is marked `expired`; the outcome stands and no money moves, because such a settlement releases both holds anyway |
 * | anything else | any | nothing: an idempotent replay of a decision already taken |
 *
 * Callers run `runOperationsFor(services, { meetupId })` after it returns; the reversal and the fenced capture are
 * operations this function only plans. It opens its own transaction and takes the meetup row lock.
 *
 * @throws SettlementReconcileError when the forfeited side has no deposit row, which no settlement can have
 *   produced.
 */
export async function compensateLostHold(
  services: AppServices,
  meetupId: string,
  evidence: LostHoldEvidence,
): Promise<CompensationResult> {
  const now = services.clock.now();

  return transact(services, async (tx, after) => {
    const meetup = await lockMeetup(tx, meetupId);
    if (meetup === null) {
      return 'noop';
    }

    const settlement = await tx.meetupSettlement.findUnique({ where: { meetupId } });
    if (settlement === null) {
      // No settlement means no forfeit to compensate: the meetup never took an outcome this rule reverses.
      services.logger.warn({ event: 'settlement_compensation_without_settlement', meetupId });
      return 'noop';
    }

    const deposits = await depositsForMeetup(tx, meetupId);
    const lostDeposit = depositOfId(deposits, evidence.depositId);
    if (lostDeposit === null) {
      services.logger.warn({
        event: 'settlement_compensation_foreign_deposit',
        meetupId,
        depositId: evidence.depositId,
      });
      return 'noop';
    }

    if (
      meetup.status !== 'forfeited' &&
      meetup.status !== 'completed' &&
      meetup.status !== 'unattended'
    ) {
      services.logger.info({
        event: 'settlement_compensation_ignored',
        meetupId,
        status: meetup.status,
      });
      return 'noop';
    }

    // Whichever way the decision below goes, the lost hold stops being a live one: forward-only, so a deposit
    // already `expired` is left as it stands.
    await advanceDeposit(
      tx,
      { depositId: lostDeposit.id, attempt: lostDeposit.currentAttempt },
      'expired',
      compensationAdvance(evidence),
    );

    const forfeitReversed =
      meetup.status === 'forfeited' &&
      (evidence.reason === 'capture_failed_expired' ||
        lostBeforeApply(evidence, settlement.appliedAt));

    if (!forfeitReversed) {
      services.logger.info({
        event: 'settlement_deposit_expired',
        meetupId,
        depositId: lostDeposit.id,
        status: meetup.status,
        evidence: evidence.reason,
      });
      return 'deposit_expired_only';
    }

    await reverseForfeit(tx, services, after, meetup, settlement.initiatorPresent, now);

    services.logger.info({
      event: 'settlement_compensated',
      meetupId,
      evidence: evidence.reason,
    });

    return 'compensated';
  });
}

/**
 * Reverse a forfeit's money in the caller's transaction.
 *
 * The forfeited side is the one whose presence flag is `false` in `MeetupSettlement` — true for a no-show and for
 * a late cancellation alike, because `lateCancelPlan` records the canceller as absent. Its capture is fenced
 * first, so a capture that has not run cannot run afterwards; a capture already `executing` cannot be fenced and
 * the reversal is planned to depend on it.
 *
 * The reversal is planned in every case, a fenced capture included: the executor resolves it against the
 * PaymentIntent's actual state — captured is refunded, uncaptured is cancelled, cancelled needs nothing — so it is
 * the reversal that releases a hold whose capture never happened. The one case with nothing to depend on is a
 * forfeit whose capture operation does not exist at all; then the still-authorized hold is released directly.
 */
async function reverseForfeit(
  tx: DbTx,
  services: AppServices,
  after: AfterCommit,
  meetup: MeetupRow,
  initiatorPresent: boolean,
  now: Date,
): Promise<void> {
  const forfeitedRole: ParticipantRole = initiatorPresent ? 'recipient' : 'initiator';
  const creditedRole = otherRole(forfeitedRole);
  const deposits = await depositsForMeetup(tx, meetup.id);
  const deposit = deposits.find((candidate) => candidate.role === forfeitedRole) ?? null;

  if (deposit === null) {
    services.logger.error({
      event: 'settlement_compensation_without_deposit',
      meetupId: meetup.id,
      role: forfeitedRole,
    });
    throw new SettlementReconcileError({
      meetupId: meetup.id,
      depositId: meetup.id,
      intentStatus: 'missing',
    });
  }

  const fenced = await fenceCaptures(tx, deposit.id, now);

  if (fenced.capture === null) {
    const hold = await findHoldOperation(tx, deposit.id, deposit.currentAttempt);
    await planRelease(
      tx,
      {
        deposit,
        attempt: deposit.currentAttempt,
        paymentIntentId: deposit.currentPaymentIntentId ?? hold?.paymentIntentId ?? null,
        ...(hold === null ? {} : { dependsOnId: hold.id }),
      },
      now,
    );
  } else {
    await planReversal(tx, deposit, fenced.capture, now);
  }

  await tx.tableCreditEntry.createMany({
    data: [
      {
        userId: userIdOf(meetup, creditedRole),
        meetupId: meetup.id,
        kind: 'void',
        amountCents: meetup.depositCents,
      },
    ],
    skipDuplicates: true,
  });

  // The no-show disappears with the status: the reputation counters derive from it, so nothing else is written.
  await transition(tx, services, after, meetup, {
    type: 'compensate',
    at: now,
    source: 'settlement',
  });

  const cityId = await venueCityId(tx, meetup);
  await emit(
    tx,
    services,
    'lock_lost',
    null,
    cityId === null ? { meetupId: meetup.id } : { meetupId: meetup.id, cityId },
  );
  // Both parties get the same kind: which of the two `lock_lost` copies a recipient sees — the hold being
  // released, or the amount taken from their card being refunded — follows from that party's own deposit, which the
  // notification worker reads.
  await notifyAll(tx, [meetup.initiatorId, meetup.recipientId], 'lock_lost', {
    meetupId: meetup.id,
  });
}

function compensationAdvance(evidence: LostHoldEvidence): { canceledAt: Date } | undefined {
  return evidence.canceledAt === undefined ? undefined : { canceledAt: evidence.canceledAt };
}

/** Whether the hold was already lost when the settlement committed (AAP 0.3.2). */
function lostBeforeApply(evidence: LostHoldEvidence, appliedAt: Date): boolean {
  return evidence.canceledAt !== undefined && evidence.canceledAt.getTime() < appliedAt.getTime();
}

/**
 * Lapse a proposal whose deadline has passed. The `lapse-<meetupId>` job and the sweeper both call this, and both
 * are only latency: the deadline is re-read under the meetup row lock and compared against the injected clock, so
 * a job that arrives early does nothing, one that arrives after a lock has already happened finds the status
 * changed, and a Redis outage costs nothing but the wait until the sweeper's next pass. The transition writes the
 * release operations for every non-final deposit attempt; the caller runs them after this returns.
 *
 * @returns True when this call lapsed the proposal.
 */
export async function lapseIfDue(services: AppServices, meetupId: string): Promise<boolean> {
  const now = services.clock.now();

  return transact(services, async (tx, after) => {
    const meetup = await lockMeetup(tx, meetupId);
    if (meetup === null || meetup.status !== 'proposed') {
      return false;
    }
    if (now.getTime() < lapseDueAt(meetup).getTime()) {
      return false;
    }

    await transition(tx, services, after, meetup, { type: 'lapse', at: now, source: 'timer' });
    return true;
  });
}

/**
 * Flag a dispute as overdue a day before the operator's deadline. `dispute-escalate-<disputeId>` fires at
 * `deadlineAt - 24 h`; `/ops` shows the flagged dispute in the operator queue, and `escalatedAt` is the flag. The
 * deadline is compared through {@link escalationDueAt}, the same function the timer schedules with, so the
 * scheduled instant and the guard turn over together. No meetup row lock is taken: the dispute row alone changes,
 * and the update is guarded on the status and on the flag being unset, which makes the escalation idempotent
 * whether it is reached by the timer, by the sweeper or twice in a row.
 *
 * @returns True when this call flagged the dispute.
 */
export async function escalateDisputeIfDue(
  services: AppServices,
  disputeId: string,
): Promise<boolean> {
  const now = services.clock.now();
  const dispute = await services.db.dispute.findUnique({
    where: { id: disputeId },
    select: { status: true, deadlineAt: true, escalatedAt: true },
  });

  if (dispute === null || dispute.status !== 'open' || dispute.escalatedAt !== null) {
    return false;
  }
  if (now.getTime() < escalationDueAt(dispute.deadlineAt).getTime()) {
    return false;
  }

  const flagged = await services.db.dispute.updateMany({
    where: { id: disputeId, status: 'open', escalatedAt: null },
    data: { escalatedAt: now },
  });

  if (flagged.count === 0) {
    return false;
  }

  services.logger.info({ event: 'dispute_escalated', disputeId });
  return true;
}

/**
 * The columns a settlement's analytics events carry: the pair's variant pairing and the deposit the funnel
 * measures. The actor's own `variant` and `assignmentId` are supplied by `analytics/emit.ts` from its stored
 * assignment.
 */
function settlementFields(meetup: MeetupRow, cityId: string): EmitFields {
  return {
    cityId,
    meetupId: meetup.id,
    props: { variantPairing: meetup.variantPairing, depositCents: meetup.depositCents },
  };
}
