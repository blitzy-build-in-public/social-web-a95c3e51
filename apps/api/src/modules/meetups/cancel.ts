/**
 * Cancelling a meetup: the two-hour free-cancellation boundary, the late-cancellation forfeit and the
 * `POST /meetups/:id/cancel` handler (AAP 0.5.1, 0.5.3, 0.5.4).
 *
 * {@link applyCancellationRules} is the decision, and `me/deletion.ts` calls it too, because an account
 * deletion follows the cancellation rules rather than escaping them (AAP 0.5.3, 0.7.3).
 * {@link cancelMeetup} is the route's handler: the participant checks, the caller's own side as the
 * reason, and the mapping from the decision to `{ lateCancel }`, `409 already_settled` or
 * `409 dispute_open`.
 *
 * **The boundary.** At exactly `startsAt - 2 h` a cancellation is still free; one second later it
 * forfeits the canceller's hold (AAP 0.5.3). {@link isLateCancel} is re-exported from
 * `meetups/state-machine.ts` rather than restated here, so the instant a screen shows
 * (`MeetupDto.lateCancelFrom`) and the instant the transition guard applies turn over together.
 *
 * **The money.** This file touches no PaymentIntent. A free cancellation is the state machine's
 * `cancelled` transition, which plans the release of both holds and removes the timers; a late one runs
 * through the recoverable settlement of AAP 0.3.2 with the outcome already known (`late_cancel`), so both
 * authorizations are reconciled first and a hold lost before the cancellation yields `lock_lost` with no
 * forfeit, rather than capturing a card that has nothing left on it. The operations a decision planned
 * are run here once its transaction has committed, so no Stripe call runs under the meetup row lock.
 *
 * **The ownership.** Every branch is taken under the meetup row lock that cancel, decline, block,
 * deletion, check-in, dispute filing, settlement, an operator resolution and the hold-loss webhook all
 * take, so two racing actions are serialised and the second reads the first one's committed row
 * (AAP 0.5.3). An open dispute wins over both branches: the meetup stays `locked`, the holds and the
 * dispute stand, and the operator's resolution settles the money. A block is deliberately absent —
 * `users/safety.ts` applies the state machine's `block` event directly, which may cancel at any time
 * before settlement, because safety wins over the late-cancellation penalty (AAP 0.7.3).
 *
 * @see AAP 0.5.3 for the transition table, the boundary and the account-deletion disposition; 0.5.4 for
 *   the route, its answer and the order of its errors; 0.5.7 for the no-show a late cancellation counts
 *   as; 0.11.1 for the injected clock and the log fields; 0.8.1 for this file.
 */

import { isFinalMeetupStatus } from '@tablemate/shared';
import type { CancelReason, CancelResponse } from '@tablemate/shared';
import type { DbTx } from '@tablemate/db';

import { AppError } from '../../plugins/errors.ts';
import { transact } from '../outbox/write.ts';
import { runOperationsFor } from '../payments/operations.ts';
import { settleMeetup } from '../settlement/settle.ts';
import type { SettleOptions, SettleResult } from '../settlement/settle.ts';

import { loadForParticipant, loadMeetup } from './queries.ts';
import { isLateCancel, lockMeetup, transition } from './state-machine.ts';
import type { MeetupEvent } from './state-machine.ts';

// Type-only, as everywhere on this branch: `app.ts` is the one declaration of the app's type, it is
// erased at compile time, and nothing of that module is read here at runtime.
import type { AppServices } from '../../app.ts';

/**
 * The rule itself, re-exported for callers that judge the boundary without a meetup in hand — the unit
 * suite above all (AAP 0.5.3).
 *
 * It stays defined in `meetups/state-machine.ts` because the transition guard is its first reader and
 * the state machine cannot import this file: every handler of this folder imports the state machine, so
 * a state machine importing back would close a runtime ESM cycle (AAP 0.5.1).
 */
export { isLateCancel } from './state-machine.ts';

/** The cancellation reasons this file applies: `block` is the state machine's own event (AAP 0.5.3). */
export type CancellationReason = Extract<
  CancelReason,
  'initiator' | 'recipient' | 'account_deleted'
>;

/**
 * What a cancellation came to (AAP 0.5.3, 0.5.4): a free cancellation (`cancelled`), a forfeit inside
 * the last two hours (`late_cancel`), a meetup that ended without an outcome because a hold was already
 * gone (`lock_lost`), a `locked` meetup whose open dispute holds the money (`left_for_operator`), or one
 * of the two states in which there was nothing to cancel.
 */
export type CancellationResult =
  'not_found' | 'already_final' | 'cancelled' | 'late_cancel' | 'lock_lost' | 'left_for_operator';

/** What a cancellation decided: the case, and whether a late-cancellation forfeit was applied. */
export interface CancellationOutcome {
  readonly result: CancellationResult;
  /** Whether the caller's own hold was forfeited as a late cancellation (AAP 0.5.3). */
  readonly lateCancel: boolean;
}

/** The optional arguments of {@link applyCancellationRules}. */
export interface CancellationOptions {
  /** The instant the boundary is judged at; defaults to the injected clock (AAP 0.11.1). */
  readonly now?: Date;
  /** Set to `false` to skip the account-deletion write fence. Defaults to fencing. */
  readonly fence?: boolean;
}

/**
 * The decision the transactional half takes, before the late branch has been carried out: `late` says
 * the cancellation is a forfeit, which `settlement/settle.ts` applies outside that transaction because
 * it reconciles the provider's state first (AAP 0.3.2).
 */
type CancellationDecision =
  | { readonly result: 'not_found' }
  | { readonly result: 'already_final' }
  | { readonly result: 'cancelled' }
  | { readonly result: 'left_for_operator' }
  | { readonly result: 'late' };

/**
 * Apply the cancellation rules of AAP 0.5.3 to one meetup (AAP 0.5.3, 0.7.3).
 *
 * **The fence.** With `opts.fence` left at its default the acting account must still be writable, so the
 * account-deletion fence of AAP 0.5.3 runs before anything here reads a row and a request racing
 * `DELETE /me` is refused `401 token_invalid` instead of committing after the erasure. The
 * `account_deleted` reason never fences, and `opts.fence: false` skips it: `me/deletion.ts` has already
 * set `deletionRequestedAt` on the deleting user, whose own transaction holds that row, so a fence there
 * would refuse the deletion its own cancellation.
 *
 * **The branches.** One transaction takes the meetup row lock and decides, in this order: a missing
 * meetup → `not_found`; a final status → `already_final`; `proposed` → the `cancel` or `deletion`
 * transition, which releases every non-final attempt, removes the timers and notifies the pair (and
 * emits `cancelled_early` for a participant cancel alone) → `cancelled`; `locked` with an open dispute →
 * `left_for_operator`, writing nothing; `locked` at or before `startsAt - 2 h` → the same transition →
 * `cancelled`; `locked` after it → `late`, which nothing in that transaction commits.
 *
 * Only the last branch writes later than this function's own transaction: the late-cancellation forfeit
 * is the settlement's, because the money decision needs both PaymentIntents reconciled and no provider
 * call may run under a row lock (AAP 0.3.2). Every other outcome has committed by the time this returns,
 * and the operations any decision planned are run after that commit.
 *
 * @param services - The app's services: the guarded client, the injected clock, the logger and the
 *   outbox dispatcher `transact` needs.
 * @param meetupId - The meetup to cancel. It need not be locked, and the caller need not be a
 *   participant: the route checks that first, and `me/deletion.ts` reaches meetups by its own query.
 * @param actorId - The account the cancellation acts for, and the canceller of a late-cancellation
 *   forfeit.
 * @param reason - Which side is cancelling, or `account_deleted`.
 * @param opts - The instant the boundary is judged at, and whether to fence.
 * @returns What the cancellation came to, as {@link CancellationOutcome}.
 * @throws AppError `token_invalid` (401) when the acting account was deleted while this request was in
 *   flight, and `payment_unavailable` (503) when a late cancellation's settlement could not read both
 *   authorizations: nothing is decided, so the meetup stays `locked`, check-in stays open and the caller
 *   may retry (AAP 0.5.4).
 */
export async function applyCancellationRules(
  services: AppServices,
  meetupId: string,
  actorId: string,
  reason: CancellationReason,
  opts?: CancellationOptions,
): Promise<CancellationOutcome> {
  const now = opts?.now ?? services.clock.now();
  const fenceUserId = reason === 'account_deleted' || opts?.fence === false ? undefined : actorId;

  const decision = await transact(
    services,
    async (tx, after): Promise<CancellationDecision> => {
      const meetup = await lockMeetup(tx, meetupId);

      if (meetup === null) {
        return { result: 'not_found' };
      }
      if (isFinalMeetupStatus(meetup.status)) {
        return { result: 'already_final' };
      }

      if (meetup.status === 'proposed') {
        await transition(tx, services, after, meetup, cancellationEvent(reason, actorId, now));
        return { result: 'cancelled' };
      }

      // `locked`. An open dispute takes the decision away from this call: a cancellation or a forfeit
      // written here would decide money the operator is about to decide (AAP 0.5.3).
      if (await hasOpenDispute(tx, meetupId)) {
        return { result: 'left_for_operator' };
      }

      // Nothing is written for a late cancellation: the forfeit is the settlement's (AAP 0.3.2).
      if (isLateCancel(now, meetup.startsAt)) {
        return { result: 'late' };
      }

      await transition(tx, services, after, meetup, cancellationEvent(reason, actorId, now));
      return { result: 'cancelled' };
    },
    fenceUserId === undefined ? undefined : { fenceUserId },
  );

  const outcome: CancellationOutcome =
    decision.result === 'late'
      ? await applyLateCancellation(services, meetupId, actorId, reason, fenceUserId)
      : { result: decision.result, lateCancel: false };

  // Every outcome but the two that wrote nothing planned at least one operation — a hold release, a
  // capture — and the executor carries it out in this same request (AAP 0.3.2).
  if (outcome.result !== 'not_found' && outcome.result !== 'already_final') {
    await runCancellationOperations(services, meetupId);
  }

  services.logger.info(
    { event: 'meetup_cancel', meetupId, result: outcome.result },
    'meetup_cancel',
  );

  return outcome;
}

/**
 * `POST /meetups/:id/cancel`: cancel a meetup the caller is part of (AAP 0.5.4).
 *
 * The refusals are checked and reported in the order AAP 0.5.4 lists them: `loadForParticipant` answers
 * `404 meetup_not_found` for an unknown id or for a proposal whose initiator hold is not held yet and
 * which is therefore invisible to its recipient, and `403 not_participant` for anyone else (AAP 0.5.3);
 * the caller's own side becomes the reason; and the decision of {@link applyCancellationRules} maps to
 * `409 already_settled`, `409 dispute_open`, `404 meetup_not_found`, or `{ lateCancel }` — `true` for a
 * forfeit inside the last two hours, `false` for a free cancellation and for a meetup that ended without
 * an outcome because a hold was already gone.
 *
 * @param services - The app's services.
 * @param userId - The authenticated caller, who becomes the cancellation's actor.
 * @param meetupId - The meetup as the route's path parameter.
 * @param now - The instant the request is judged at, from the injected clock, so the boundary the screen
 *   showed and the boundary this route applies are the same instant (AAP 0.11.1).
 * @returns The route's `200` body: whether a late-cancellation forfeit was applied.
 * @throws AppError one of the codes above, and `payment_unavailable` from a late cancellation.
 */
export async function cancelMeetup(
  services: AppServices,
  userId: string,
  meetupId: string,
  now: Date,
): Promise<CancelResponse> {
  const { role } = await loadForParticipant(services.db, meetupId, userId);

  const outcome = await applyCancellationRules(services, meetupId, userId, role, {
    now,
    fence: true,
  });

  switch (outcome.result) {
    case 'not_found':
      throw new AppError('meetup_not_found');
    case 'already_final':
      throw new AppError('already_settled');
    case 'left_for_operator':
      throw new AppError('dispute_open');
    default:
      return { lateCancel: outcome.lateCancel };
  }
}

/**
 * Apply the late-cancellation forfeit through the shared, recoverable settlement (AAP 0.3.2, 0.5.3): the
 * canceller's hold captured, the counterpart's released and the counterpart granted Table Credit equal to
 * the deposit, with no `WitnessEvent` — and with both authorizations reconciled first, `MeetupSettlement.
 * appliedAt` as the anchor of the retention clock and of the compensation rule, and one transaction
 * behind the meetup row lock that makes a repeat a no-op.
 *
 * `settled` is reported as `late_cancel`, `lock_lost` as `lock_lost` with no forfeit of the caller's own
 * hold, `postponed` as `left_for_operator` because a dispute opened after the decision and now gates the
 * money, and `noop` through {@link outcomeAfterSettlementNoop}.
 *
 * @throws AppError `payment_unavailable` (503) when the settlement could not read both authorizations:
 *   nothing was decided and no transaction committed, so the meetup stays `locked` and retrying is safe.
 */
async function applyLateCancellation(
  services: AppServices,
  meetupId: string,
  actorId: string,
  reason: CancellationReason,
  fenceUserId: string | undefined,
): Promise<CancellationOutcome> {
  const options: SettleOptions = {
    trigger: reason === 'account_deleted' ? 'deletion' : 'cancel',
    outcome: 'late_cancel',
    cancellerId: actorId,
    ...(fenceUserId === undefined ? {} : { fenceUserId }),
  };

  let settled: SettleResult;

  try {
    settled = await settleMeetup(services, meetupId, options);
  } catch (error) {
    // The reconciliation could not read a PaymentIntent, or read one in a state the rule does not cover.
    // Answer the retryable `503 payment_unavailable` the contract gives that provider failure on propose
    // and accept, and let anything else — a programming error — surface unchanged.
    if (!isSettlementUnavailable(error)) {
      throw error;
    }
    services.logger.warn(
      { event: 'late_cancel_unavailable', meetupId, err: error },
      'late_cancel_unavailable',
    );
    throw new AppError('payment_unavailable');
  }

  switch (settled.result) {
    case 'settled':
      return { result: 'late_cancel', lateCancel: true };
    case 'lock_lost':
      return { result: 'lock_lost', lateCancel: false };
    case 'postponed':
      return { result: 'left_for_operator', lateCancel: false };
    case 'noop':
      return outcomeAfterSettlementNoop(services, meetupId);
  }
}

/**
 * Read what a settlement that decided nothing leaves behind (AAP 0.5.3).
 *
 * A `noop` means the settlement found nothing it could act on: the row was gone, the meetup was no longer
 * `locked` (a racing cancellation, settlement or hold-loss webhook took it first), or a deposit had
 * stopped being `held` between the reconciliation and the lock. The re-read separates `already_final`,
 * `not_found` and the one case left over — a meetup still `locked` here, which is a hold loss the webhook
 * is about to record, where no deposit applies and the screen shows the status the row then carries.
 */
async function outcomeAfterSettlementNoop(
  services: AppServices,
  meetupId: string,
): Promise<CancellationOutcome> {
  const meetup = await loadMeetup(services.db, meetupId);

  if (meetup === null) {
    return { result: 'not_found', lateCancel: false };
  }
  if (isFinalMeetupStatus(meetup.status)) {
    return { result: 'already_final', lateCancel: false };
  }

  services.logger.warn(
    { event: 'late_cancel_not_applied', meetupId, status: meetup.status },
    'late_cancel_not_applied',
  );

  return { result: 'lock_lost', lateCancel: false };
}

/**
 * Run the payment operations a cancellation planned, once its transaction has committed (AAP 0.3.2).
 *
 * A failure to reach the provider never fails a cancellation: the operations are durable rows and the
 * 60-second sweeper resumes every open one.
 */
async function runCancellationOperations(services: AppServices, meetupId: string): Promise<void> {
  try {
    await runOperationsFor(services, { meetupId });
  } catch (error) {
    services.logger.warn(
      { event: 'cancel_operations_deferred', meetupId, err: error },
      'cancel_operations_deferred',
    );
  }
}

/**
 * The event a cancellation applies (AAP 0.5.3): a participant's cancel and an account deletion are two
 * rows of the transition table, and the `source` beside them reaches the log line alone.
 */
function cancellationEvent(reason: CancellationReason, actorId: string, at: Date): MeetupEvent {
  return reason === 'account_deleted'
    ? { type: 'deletion', actorId, at, source: 'deletion' }
    : { type: 'cancel', actorId, reason, at, source: 'route' };
}

/**
 * Whether the meetup has an open dispute, read inside the decision's own transaction (AAP 0.5.2, 0.5.3):
 * the partial unique index leaves at most one such row, and the meetup row lock the caller holds stops a
 * filing between this read and the write it guards, because a filing takes the same lock.
 */
async function hasOpenDispute(tx: DbTx, meetupId: string): Promise<boolean> {
  const open = await tx.dispute.findFirst({
    where: { meetupId, status: 'open' },
    select: { id: true },
  });

  return open !== null;
}

/**
 * Whether a failure is the settlement's own "I could not decide the money" signal (AAP 0.3.2), matched by
 * name rather than by `instanceof`: those classes live in modules this file must not import, and a
 * duplicated copy of a class in one process fails `instanceof` anyway — the duck-typing `plugins/errors.ts`
 * uses for `AppError`.
 */
function isSettlementUnavailable(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';

  return name === 'PaymentUnavailableError' || name === 'SettlementReconcileError';
}
