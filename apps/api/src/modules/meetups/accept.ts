/**
 * The acceptance half of the commitment lock: `POST /meetups/:id/accept`, `POST /meetups/:id/decline`
 * and the additive `POST /meetups/:id/hold` (AAP 0.5.1, 0.5.3, 0.5.4).
 *
 * {@link acceptMeetup} is the recipient's side of the lock. It accepts only from a proposal the
 * recipient can see and only before `recipientDeadline`, marks the acceptance intent once, and places
 * the recipient's own hold: attempt 1 on a proposal they have not answered yet, attempt `n + 1` after
 * a refused card, or the secret of the attempt that already carries an authorization — one still
 * waiting on their 3-D Secure step, or one already held.
 * {@link declineMeetup} is the refusal, which runs the state machine's own `decline` transition.
 * {@link retryInitiatorHold} is the same hold path for the initiator, whose attempt can fail before the
 * proposal is ever visible to the recipient.
 *
 * **The proposal locks itself (AAP 0.5.3).** No branch here moves a meetup to `locked`: the
 * recipient's hold reaching `requires_capture` does, and that transition belongs to
 * `applyHoldOutcome` in `meetups/state-machine.ts`, which the inline hold reaches through its own
 * transaction. This file decides who may act and which attempt to place; the state machine decides
 * whether the result locks the meetup, leaves the proposal standing or lapses it.
 *
 * **One fenced transaction, then Stripe (AAP 0.3.2, 0.5.3).** Each handler opens exactly one
 * transaction through `transact`, fenced on the acting account, and takes `lockMeetup` before it reads
 * or writes anything about the meetup, so a racing accept, cancel, block, lapse, check-in, dispute or
 * hold-loss webhook is serialized on the row and this request reads the result the other one
 * committed. No Stripe, Redis or provider call runs inside that transaction: the hold whose result is
 * the response runs after the commit through `executeHoldInline`, and the release a retry planned for
 * the attempt it superseded is carried out in the same request by `runOperationsFor` — after the hold,
 * and never before it, because the open operations of the meetup include the hold itself.
 *
 * **A lost answer is never a second authorization.** A deposit left `pending` answers
 * `409 hold_pending` rather than starting a new attempt, while the sweeper replays the identical
 * create under its original key; a repeated accept during 3-D Secure returns the same attempt's secret
 * and writes no new `PaymentOperation`; and the secret a route answers with is always the caller's
 * own, because every attempt this file runs belongs to the deposit the route authorized the caller
 * against — the recipient's for accept, the initiator's for the hold retry, and never the
 * counterpart's (AAP 0.5.4). No client secret, PaymentIntent id or amount is ever logged.
 *
 * Time comes only from the `now` argument, and money is integer USD cents (AAP 0.11.1).
 *
 * @see AAP 0.5.3 for the transition table, the deposit lifecycle and the lock's side effects; 0.5.4
 *   for the three routes, their bodies and the order of their errors; 0.5.7 for the acceptance funnel
 *   stage they record; 0.3.2 for hold recovery, the executor and the idempotency keys; 0.11.1 for the
 *   injected clock and the log fields; and 0.8.1 for this file.
 */

import type {
  AcceptResponse,
  DeclineResponse,
  DepositStatus,
  HoldRetryResponse,
  HoldView,
} from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { emit } from '../analytics/emit.ts';
import { transact } from '../outbox/write.ts';
import { PaymentUnavailableError } from '../payments/gateway.ts';
import { holdView, planHold, startNewAttempt } from '../payments/holds.ts';
import { executeHoldInline, runOperationsFor } from '../payments/operations.ts';
import { inlineHoldOrThrow } from './propose.ts';
import { isVisibleTo, participantRole } from './queries.ts';
import { lockMeetup, transition } from './state-machine.ts';

import type { DbClient, DbTx, Deposit } from '@tablemate/db';
import type { IntentState, IntentStatus } from '../payments/gateway.ts';
import type { MeetupRow } from './queries.ts';

// Type-only, as everywhere in this module: `app.ts` is the one declaration of the app's type, it is
// erased at compile time, and nothing of that module is read here at runtime.
import type { AppServices } from '../../app.ts';

/*
 * Constants and tables (AAP 0.5.3, 0.5.4, 0.11.1)
 */

/** The log event name of {@link acceptMeetup}. */
const ACCEPT_EVENT = 'meetup_accept';

/** The log event name of {@link declineMeetup}. */
const DECLINE_EVENT = 'meetup_decline';

/** The log event name of {@link retryInitiatorHold}. */
const HOLD_RETRY_EVENT = 'meetup_hold_retry';

/**
 * The log event name of a deposit this file found in a state with nothing left to place — the
 * `refused` row of {@link HOLD_PLAN} (AAP 0.5.4). It means the client acted on a meetup whose money
 * had already been decided, so the answer is `409 not_proposed` and the state is worth a log line:
 * no secret, no PaymentIntent id and no amount reaches it.
 */
const DEPOSIT_REFUSED_EVENT = 'meetup_deposit_refused';

/**
 * What a hold path does with one side's deposit, by the deposit's own status (AAP 0.5.3, 0.5.4).
 *
 * The table is total over `DepositStatus`, so a status added to the lifecycle cannot fall through this
 * file unnoticed: it is a compile error until the row it needs is written. The one state
 * `DepositStatus` cannot name — a side with no deposit row at all — is decided by each route before it
 * consults the table, because the two routes answer it differently: an accept creates attempt 1, and a
 * hold retry has nothing to retry.
 *
 * - `retry` — `failed`: a card that refused the hold, or an attempt Stripe ended on its own, left the
 *   deposit with no authorization, and `failed → pending` with attempt `n + 1` is the retry
 *   (AAP 0.5.3).
 * - `confirm` — `requires_action` and `held`: an authorization exists, so the route answers the
 *   caller's own current attempt's secret and creates no new authorization. `requires_action` is the
 *   attempt still waiting on the customer's 3-D Secure step; `held` is an attempt whose authorization
 *   has landed while the meetup has not locked on it — a repeated accept or hold made before the other
 *   side's hold, or the webhook that applies it, arrived (AAP 0.5.4).
 * - `recovering` — `pending`: the current attempt has not concluded. A create may be in flight, an
 *   ambiguous create may be waiting for its replay, or the executor may have handed it to the operator,
 *   which leaves the deposit `pending` on purpose so that every retry is answered `409 hold_pending`
 *   (AAP 0.3.2). Replaying that attempt is the only way to learn its PaymentIntent id and a second
 *   attempt would risk a second authorization, so there is nothing to place here.
 * - `refused` — `released`, `captured`, `expired` and `refunded`: the money decision is already
 *   durable, so there is nothing for the route to place. Its answer is `409 not_proposed`, the code
 *   this module's own planners use for a deposit that is not in the state the caller asked for
 *   (AAP 0.3.2, 0.5.4), and the state is logged because reaching it means the meetup moved in a way
 *   the client did not observe.
 */
type HoldPlan = 'retry' | 'confirm' | 'recovering' | 'refused';

/** {@link HoldPlan}, keyed by the deposit's own status. */
const HOLD_PLAN: Readonly<Record<DepositStatus, HoldPlan>> = {
  pending: 'recovering',
  requires_action: 'confirm',
  failed: 'retry',
  held: 'confirm',
  released: 'refused',
  captured: 'refused',
  expired: 'refused',
  refunded: 'refused',
};

/**
 * How a repeated accept answers the provider's own view of the caller's current attempt (AAP 0.5.4).
 *
 * The authorization the attempt carries is durable either way, so an attempt that is still missing the
 * customer's step, and one whose authorization has already landed and is waiting for the webhook that
 * applies it, both answer the caller's own secret: the client needs it to finish 3-D Secure in the
 * first case and ignores it in the second, and no route returns the counterpart's secret.
 *
 * A state this application does not model as an authorization — `requires_payment_method`,
 * `requires_confirmation`, `processing` — is an outcome that could not be observed, so it answers
 * `503 payment_unavailable` rather than assuming either way. A `canceled` or `succeeded` attempt has
 * nothing left to confirm: the webhook or the executor moves the deposit, and the client's next step
 * appears when it refetches the meetup.
 */
type AttemptAnswer = 'secret' | 'recovering' | 'refused';

/** {@link AttemptAnswer}, keyed by the provider's own PaymentIntent status. */
const ATTEMPT_ANSWERS: Readonly<Record<IntentStatus, AttemptAnswer>> = {
  requires_action: 'secret',
  requires_capture: 'secret',
  requires_payment_method: 'recovering',
  requires_confirmation: 'recovering',
  processing: 'recovering',
  canceled: 'refused',
  succeeded: 'refused',
};

/** What a hold path decided to do once its transaction committed (AAP 0.3.2, 0.5.4). */
type HoldDecision =
  | { readonly plan: 'run'; readonly holdOperationId: string }
  | { readonly plan: 'confirm'; readonly paymentIntentId: string | null };

/*
 * The routes (AAP 0.5.3, 0.5.4)
 */

/**
 * `POST /meetups/:id/accept`: the recipient accepts a visible proposal and places their own hold
 * (AAP 0.5.4).
 *
 * The guards run in the order the contract lists them, all inside the transaction that takes the
 * meetup row lock: the caller must be the recipient of a proposal they can see, the proposal must not
 * have lapsed and must not be past `recipientDeadline`, and it must still be `proposed`. The
 * acceptance intent is then recorded once — `recipientAcceptedAt` with the funnel's
 * `proposal_accepted` — on the first accept past those guards, whatever the authorization outcome
 * turns out to be, so a declined card and its retry emit nothing further (AAP 0.5.7).
 *
 * What happens to the money is the recipient's own deposit's state alone, from {@link HOLD_PLAN}: no
 * deposit yet creates attempt 1 in this transaction, `failed` starts attempt `n + 1` through
 * `startNewAttempt` — which refuses while the previous attempt's create is unresolved and releases the
 * authorization of the attempt it supersedes — `requires_action` and `held` answer that attempt's own
 * secret from the provider without writing an operation at all, `pending` answers `409 hold_pending`
 * for an attempt that has not concluded, and a deposit whose money decision is already durable answers
 * `409 not_proposed` (AAP 0.3.2, 0.5.3, 0.5.4).
 *
 * The response is read back after the hold: `locked` when the recipient's authorization landed with
 * the initiator's hold already `held`, and `proposed` while it is still pending. A proposal that moved
 * under the acceptance answers `410 proposal_lapsed` or `409 not_proposed` instead of claiming a lock,
 * and nothing is left outstanding then, because a hold outcome arriving for a finished meetup releases
 * its authorization (AAP 0.5.3).
 *
 * @param services - The app's services: the guarded client, the injected clock and logger, the outbox
 *   dispatcher the transaction commits through, and the payment gateway the hold and the provider read
 *   go through.
 * @param userId - The authenticated caller, who must be the meetup's recipient.
 * @param meetupId - The meetup as the route's path parameter.
 * @param now - The instant the request arrived, `request.receivedAt`, which decides the deadline and
 *   the funnel timestamp (AAP 0.11.1).
 * @returns The route's `200` body: `locked` once the hold is held against a held initiator deposit,
 *   `proposed` while 3-D Secure is pending, and the caller's own current attempt's client secret.
 * @throws AppError `meetup_not_found` (404), `not_recipient` (403), `proposal_lapsed` (410),
 *   `not_proposed` (409), `hold_failed` (402), `hold_pending` (409) or `payment_unavailable` (503).
 */
export async function acceptMeetup(
  services: AppServices,
  userId: string,
  meetupId: string,
  now: Date,
): Promise<AcceptResponse> {
  const decision = await transact(
    services,
    async (tx): Promise<HoldDecision> => {
      // 1. The meetup row lock, then the caller's own side of the proposal (AAP 0.5.3, 0.5.4). Only
      //    the recipient may accept: the initiator and a stranger are answered `403 not_recipient`,
      //    while a recipient whose proposal the initiator has not yet made visible is answered
      //    `404 meetup_not_found`, so a proposal the caller is not meant to see stays hidden.
      const meetup = await lockMeetup(tx, meetupId);
      if (meetup === null) {
        throw new AppError('meetup_not_found');
      }
      if (participantRole(meetup, userId) !== 'recipient') {
        throw new AppError('not_recipient');
      }
      if (!isVisibleTo(meetup, userId)) {
        throw new AppError('meetup_not_found');
      }

      // 2. A proposal that has lapsed, or one still `proposed` past `recipientDeadline`, is refused
      //    and writes nothing: the lapse and the releases it carries are the sweeper's, and refusing
      //    here keeps a late accept from locking a meetup nobody can still attend (AAP 0.5.3). Only a
      //    `proposed` proposal reaches the deadline rule; a meetup that already reached another status
      //    is answered `409 not_proposed` below, whatever its stored deadline says (AAP 0.5.4).
      const deadline = meetup.recipientDeadline;
      if (
        meetup.status === 'lapsed' ||
        (meetup.status === 'proposed' && deadline !== null && now.getTime() >= deadline.getTime())
      ) {
        throw new AppError('proposal_lapsed');
      }

      // 3. Only a proposal can be accepted (AAP 0.5.4).
      if (meetup.status !== 'proposed') {
        throw new AppError('not_proposed');
      }

      // 4. The acceptance intent, recorded in the transaction that decides the attempt, so the
      //    funnel's count and the timestamp it counts are one fact (AAP 0.5.7).
      await recordAcceptedAt(tx, services, meetup, now);

      // 5. The recipient's own deposit decides the rest, by its status alone (AAP 0.5.3).
      const deposit = await depositOf(tx, meetup.id, userId);

      if (deposit === null) {
        // The recipient has not answered yet: attempt 1 is created and its hold planned in this
        // transaction, so the authorization it carries is as durable as the deposit it belongs to.
        const created = await tx.deposit.create({
          data: {
            meetupId: meetup.id,
            ownerId: userId,
            role: 'recipient',
            status: 'pending',
            amountCents: meetup.depositCents,
            currentAttempt: 1,
          },
        });

        const hold = await planHold(tx, { deposit: created, attempt: 1 }, now);

        return { plan: 'run', holdOperationId: hold.id };
      }

      switch (HOLD_PLAN[deposit.status]) {
        case 'retry': {
          const started = await startNewAttempt(tx, deposit, now);
          if (!started.ok) {
            // `hold_pending` is the previous attempt's unresolved create; `not_failed` means another
            // writer moved the deposit between the read and the guarded update (AAP 0.3.2, 0.5.4).
            throw new AppError(started.reason === 'hold_pending' ? 'hold_pending' : 'not_proposed');
          }
          return { plan: 'run', holdOperationId: started.holdOp.id };
        }
        case 'confirm':
          // A repeated accept: the attempt carries an authorization — one still missing the
          // customer's 3-D Secure step, or one already held on this side of a proposal that has not
          // locked — so its own secret is returned and no second authorization is created
          // (AAP 0.5.4).
          return { plan: 'confirm', paymentIntentId: deposit.currentPaymentIntentId };
        case 'recovering':
          throw new AppError('hold_pending');
        case 'refused':
          services.logger.warn(
            { event: DEPOSIT_REFUSED_EVENT, meetupId, plan: 'refused' },
            DEPOSIT_REFUSED_EVENT,
          );
          throw new AppError('not_proposed');
      }
    },
    { fenceUserId: userId },
  );

  // The hold's result is the response, so it runs after the commit and never inside the transaction.
  const clientSecret =
    decision.plan === 'confirm'
      ? await confirmOwnAttempt(services, meetupId, decision.paymentIntentId)
      : await runHoldAttempt(services, meetupId, decision.holdOperationId);

  const status = await acceptStatus(services, meetupId);

  services.logger.info({ event: ACCEPT_EVENT, meetupId, status }, ACCEPT_EVENT);

  return { status, clientSecret };
}

/**
 * `POST /meetups/:id/decline`: the recipient refuses a proposal that is still `proposed` (AAP 0.5.4).
 *
 * The refusals are the contract's own, in its order: an unknown meetup, or a proposal the caller is
 * not meant to see yet, is `404 meetup_not_found`; a caller who is not the recipient is `403
 * not_recipient`; and any status other than `proposed` is `409 not_proposed` — a proposal the sweeper
 * has lapsed, one that locked while the screen was open, and every settled status alike.
 *
 * A proposal past its `recipientDeadline` is deliberately still declinable: it stays `proposed` until
 * the sweeper lapses it, and the recipient refusing it is the pair's own way to end it, releasing the
 * holds exactly as the lapse does. The `decline` row of the transition table does the work — every
 * non-final attempt released, `proposal_declined` emitted, the initiator notified, the meetup's timers
 * removed — in this same transaction, and the releases it planned are Stripe calls that run here,
 * after the commit (AAP 0.3.2, 0.5.3).
 *
 * @param services - The app's services: the guarded client, the injected clock and logger, and the
 *   outbox dispatcher the transaction commits through.
 * @param userId - The authenticated caller, who must be the meetup's recipient.
 * @param meetupId - The meetup as the route's path parameter.
 * @param now - The instant the request arrived, from the injected clock (AAP 0.11.1).
 * @returns The route's `200` body.
 * @throws AppError `meetup_not_found` (404), `not_recipient` (403) or `not_proposed` (409).
 */
export async function declineMeetup(
  services: AppServices,
  userId: string,
  meetupId: string,
  now: Date,
): Promise<DeclineResponse> {
  await transact(
    services,
    async (tx, after): Promise<void> => {
      const meetup = await lockMeetup(tx, meetupId);
      if (meetup === null || !isVisibleTo(meetup, userId)) {
        throw new AppError('meetup_not_found');
      }
      if (participantRole(meetup, userId) !== 'recipient') {
        throw new AppError('not_recipient');
      }
      if (meetup.status !== 'proposed') {
        throw new AppError('not_proposed');
      }

      await transition(tx, services, after, meetup, { type: 'decline', at: now, source: 'route' });
    },
    { fenceUserId: userId },
  );

  // The releases the transition planned are provider calls, so they run here and never under the row
  // lock; a failure leaves them to the sweeper rather than failing a decline already committed.
  await runMeetupOperations(services, meetupId);

  services.logger.info({ event: DECLINE_EVENT, meetupId }, DECLINE_EVENT);

  return { status: 'declined' };
}

/**
 * `POST /meetups/:id/hold`: the initiator retries their own failed hold (AAP 0.5.4).
 *
 * The route is the initiator's alone: a caller who is not on the meetup is `403 not_participant` and
 * the recipient, whose own side is `accept`, is `403 not_initiator`. It applies while the proposal is
 * still open, and it moves the money through the same {@link HOLD_PLAN} table and the same post-commit
 * work as {@link acceptMeetup} — a new attempt for a `failed` deposit, the caller's own secret for an
 * attempt that already carries an authorization (one awaiting 3-D Secure, or one already held),
 * `409 hold_pending` while a create is still being recovered, and `409 not_proposed` for a deposit
 * with nothing left to place. The release a retry plans for the attempt it superseded is carried out
 * in this same request (AAP 0.3.2).
 *
 * `initiatorHold` is read back after the hold, so the client sees the state this call left rather than
 * the state it started from. The response reports `proposed`, which is what the contract fixes for
 * this route: a retry only ever adds the authorization the initiator's own side was missing, and the
 * lock needs the recipient's hold, which cannot exist while the proposal is still invisible to them.
 *
 * @param services - The app's services: the guarded client, the injected clock and logger, the outbox
 *   dispatcher the transaction commits through, and the payment gateway.
 * @param userId - The authenticated caller, who must be the meetup's initiator.
 * @param meetupId - The meetup as the route's path parameter.
 * @param now - The instant the request arrived, `request.receivedAt` (AAP 0.11.1).
 * @returns The route's `200` body: the proposal's status, the caller's own hold state and their
 *   current attempt's client secret.
 * @throws AppError `meetup_not_found` (404), `not_participant` (403), `not_initiator` (403),
 *   `not_proposed` (409), `hold_pending` (409), `hold_failed` (402) or `payment_unavailable` (503).
 */
export async function retryInitiatorHold(
  services: AppServices,
  userId: string,
  meetupId: string,
  now: Date,
): Promise<HoldRetryResponse> {
  const decision = await transact(
    services,
    async (tx): Promise<HoldDecision> => {
      const meetup = await lockMeetup(tx, meetupId);
      if (meetup === null) {
        throw new AppError('meetup_not_found');
      }

      const role = participantRole(meetup, userId);
      if (role === null) {
        throw new AppError('not_participant');
      }
      if (role === 'recipient') {
        throw new AppError('not_initiator');
      }

      // A hold is retried while the proposal is still open: a locked proposal has both authorizations
      // and a final one has already decided its money (AAP 0.5.3).
      if (meetup.status !== 'proposed') {
        throw new AppError('not_proposed');
      }

      const deposit = await depositOf(tx, meetup.id, userId);
      if (deposit === null) {
        // The initiator's deposit is created with the proposal, so a proposal without one has no
        // attempt to retry; the client's next step comes from refetching the meetup.
        throw new AppError('not_proposed');
      }

      switch (HOLD_PLAN[deposit.status]) {
        case 'retry': {
          const started = await startNewAttempt(tx, deposit, now);
          if (!started.ok) {
            throw new AppError(started.reason === 'hold_pending' ? 'hold_pending' : 'not_proposed');
          }
          return { plan: 'run', holdOperationId: started.holdOp.id };
        }
        case 'confirm':
          // An attempt that already carries an authorization, waiting on the customer's step or
          // already held: the route is idempotent and answers the caller's own secret (AAP 0.5.4).
          return { plan: 'confirm', paymentIntentId: deposit.currentPaymentIntentId };
        case 'recovering':
          throw new AppError('hold_pending');
        case 'refused':
          services.logger.warn(
            { event: DEPOSIT_REFUSED_EVENT, meetupId, plan: 'refused' },
            DEPOSIT_REFUSED_EVENT,
          );
          throw new AppError('not_proposed');
      }
    },
    { fenceUserId: userId },
  );

  const clientSecret =
    decision.plan === 'confirm'
      ? await confirmOwnAttempt(services, meetupId, decision.paymentIntentId)
      : await runHoldAttempt(services, meetupId, decision.holdOperationId);

  const initiatorHold = await depositView(services, meetupId, userId);

  services.logger.info({ event: HOLD_RETRY_EVENT, meetupId, initiatorHold }, HOLD_RETRY_EVENT);

  return { status: 'proposed', initiatorHold, clientSecret };
}

/*
 * Post-commit work (AAP 0.3.2, 0.5.4)
 */

/**
 * Run one attempt's hold inline and return the caller's own secret to confirm it (AAP 0.3.2, 0.5.4).
 *
 * The hold's result *is* the response, so it runs in the request that asked for it rather than being
 * left to the sweeper. The four outcomes that are not an authorization are mapped by
 * {@link inlineHoldOrThrow}, exactly as `POST /meetups` maps them, except that a claim which is still
 * running answers `409 hold_pending` here: on these routes the caller is the one who may retry, and a
 * `503` would send the client to recover through `GET /meetups` when the same call can simply be
 * repeated (AAP 0.3.2, 0.5.4).
 *
 * The meetup's remaining operations run after the hold and never before it: the open operations of
 * this meetup include the hold itself, so running the scope first would send the create and leave this
 * call holding a row another pass claimed. Running them here is what carries out the release a retry
 * planned for the attempt it superseded, and a failure is logged rather than raised, because those
 * rows are durable and the sweeper resumes them.
 *
 * @param services - The app's services.
 * @param meetupId - The meetup whose attempt is being placed.
 * @param holdOperationId - The `hold` operation the transaction planned.
 * @returns The caller's own current attempt's client secret.
 * @throws AppError `hold_failed` (402), `hold_pending` (409) or `payment_unavailable` (503).
 */
async function runHoldAttempt(
  services: AppServices,
  meetupId: string,
  holdOperationId: string,
): Promise<string> {
  const result = await executeHoldInline(services, holdOperationId);

  await runMeetupOperations(services, meetupId);

  return inlineHoldOrThrow(result, { pendingCode: 'hold_pending' }).clientSecret;
}

/**
 * Read the caller's own current attempt again and return the secret that finishes it (AAP 0.3.2,
 * 0.5.4).
 *
 * This is the repeated accept — and the repeated hold — after an app restart during 3-D Secure: the
 * attempt's authorization is durable and only the customer's step is missing, so nothing is written
 * and no second authorization is created. The PaymentIntent is the provider's own view of the attempt,
 * named by the deposit's `currentPaymentIntentId` — the caller's own deposit, never the counterpart's.
 *
 * A state the client cannot act on is answered rather than assumed, from {@link ATTEMPT_ANSWERS}: an
 * outcome that could not be observed is `503 payment_unavailable`, and an attempt the provider already
 * ended is `409 not_proposed`, with the deposit moved by the webhook or the executor and the client's
 * next step appearing when it refetches the meetup.
 *
 * @param services - The app's services.
 * @param meetupId - The meetup whose attempt is being confirmed, for the log line alone.
 * @param paymentIntentId - The attempt's PaymentIntent, or null when the deposit recorded none.
 * @returns The caller's own attempt's client secret.
 * @throws AppError `payment_unavailable` (503) or `not_proposed` (409).
 */
async function confirmOwnAttempt(
  services: AppServices,
  meetupId: string,
  paymentIntentId: string | null,
): Promise<string> {
  if (paymentIntentId === null) {
    // An authenticated attempt always records its PaymentIntent, so a missing one cannot be confirmed
    // by the client: the same answer `inlineHoldOrThrow` gives an authorized outcome with no secret.
    throw new AppError('payment_unavailable');
  }

  const state = await retrieveAttempt(services, meetupId, paymentIntentId);

  if (state.clientSecret === null) {
    throw new AppError('payment_unavailable');
  }

  switch (ATTEMPT_ANSWERS[state.status]) {
    case 'secret':
      return state.clientSecret;
    case 'recovering':
      throw new AppError('payment_unavailable');
    case 'refused':
      throw new AppError('not_proposed');
  }
}

/**
 * Read one PaymentIntent from the provider, or answer the route's recoverable failure (AAP 0.3.2).
 *
 * A state that could not be observed decides nothing, so it becomes `503 payment_unavailable` and the
 * client recovers through `GET /meetups`. The id reaches no log line and no response.
 *
 * @param services - The app's services.
 * @param meetupId - The meetup the attempt belongs to, which is what the log line carries.
 * @param paymentIntentId - The PaymentIntent to read.
 * @returns The provider's normalized view of the attempt.
 * @throws AppError `payment_unavailable` (503) when the provider's answer is lost.
 */
async function retrieveAttempt(
  services: AppServices,
  meetupId: string,
  paymentIntentId: string,
): Promise<IntentState> {
  try {
    return await services.payments.retrievePaymentIntent(paymentIntentId);
  } catch (error) {
    if (!(error instanceof PaymentUnavailableError)) {
      throw error;
    }

    services.logger.warn({ event: 'attempt_unreadable', meetupId }, 'attempt_unreadable');

    throw new AppError('payment_unavailable');
  }
}

/**
 * The accept route's `200` status, read back after the commit (AAP 0.5.4).
 *
 * `locked` once the recipient's authorization landed with the initiator's hold already `held`, and
 * `proposed` while one of the two is still pending. Any other status means the proposal moved under
 * the acceptance — it lapsed at its deadline, or a racing cancel, block or hold loss ended it — and
 * nothing is outstanding then, because a hold outcome arriving for a finished meetup releases its
 * authorization (AAP 0.5.3).
 *
 * @param services - The app's services.
 * @param meetupId - The meetup the acceptance just acted on.
 * @returns The status the route answers with.
 * @throws AppError `proposal_lapsed` (410) or `not_proposed` (409) for a proposal that moved away.
 */
async function acceptStatus(
  services: AppServices,
  meetupId: string,
): Promise<'locked' | 'proposed'> {
  const meetup = await services.db.meetup.findUniqueOrThrow({
    where: { id: meetupId },
    select: { status: true },
  });

  if (meetup.status === 'locked' || meetup.status === 'proposed') {
    return meetup.status;
  }

  throw new AppError(meetup.status === 'lapsed' ? 'proposal_lapsed' : 'not_proposed');
}

/**
 * The caller's own hold state as {@link HoldRetryResponse} reports it, read after the commit
 * (AAP 0.5.4).
 *
 * @param services - The app's services.
 * @param meetupId - The meetup whose side is read.
 * @param ownerId - The caller, whose own deposit the view describes.
 * @returns The deposit's current status, or `none` for a side with no deposit.
 */
async function depositView(
  services: AppServices,
  meetupId: string,
  ownerId: string,
): Promise<HoldView> {
  return holdView(await depositOf(services.db, meetupId, ownerId));
}

/**
 * Carry out the releases a decision planned, once its transaction has committed (AAP 0.3.2).
 *
 * A failure to reach the provider never fails the request: the operations are durable rows, and the
 * 60-second sweeper resumes every one that is still open.
 *
 * @param services - The app's services.
 * @param meetupId - The meetup whose deposits' operations run.
 */
async function runMeetupOperations(services: AppServices, meetupId: string): Promise<void> {
  try {
    await runOperationsFor(services, { meetupId });
  } catch (error) {
    services.logger.warn(
      { event: 'meetup_operations_deferred', meetupId, err: error },
      'meetup_operations_deferred',
    );
  }
}

/**
 * Record the recipient's acceptance intent and the funnel stage that counts it, once (AAP 0.5.3,
 * 0.5.7).
 *
 * `recipientAcceptedAt` is set on the first accept that passes its route's guards, whatever the
 * authorization outcome turns out to be, and the conditional update is what makes two racing accepts
 * write one instant and one `proposal_accepted` event. The timestamp is the funnel's own count for
 * this stage, so the column and the event are written together, in the transaction that decides the
 * attempt, and the actor's variant and assignment come from their stored assignment through
 * `analytics/emit.ts`.
 *
 * @param tx - The accept's transaction, holding the meetup row lock.
 * @param services - The app's services, for the event's configuration, clock and logger.
 * @param meetup - The locked row the caller read.
 * @param at - The instant the request arrived, from the injected clock (AAP 0.11.1).
 */
async function recordAcceptedAt(
  tx: DbTx,
  services: AppServices,
  meetup: MeetupRow,
  at: Date,
): Promise<void> {
  const marked = await tx.meetup.updateMany({
    where: { id: meetup.id, recipientAcceptedAt: null },
    data: { recipientAcceptedAt: at },
  });

  if (marked.count !== 1) {
    return;
  }

  const venue = await tx.venue.findUnique({
    where: { id: meetup.venueId },
    select: { cityId: true },
  });

  await emit(tx, services, 'proposal_accepted', meetup.recipientId, {
    meetupId: meetup.id,
    ...(venue === null ? {} : { cityId: venue.cityId }),
    props: { variantPairing: meetup.variantPairing, depositCents: meetup.depositCents },
  });
}

/**
 * One side's deposit of a meetup, by the key the schema files it under: a meetup holds at most one
 * deposit per side (AAP 0.5.2).
 *
 * @param db - The client of the caller's transaction, or the guarded client for a read after it.
 * @param meetupId - The meetup the deposit belongs to.
 * @param ownerId - The account whose side is read.
 * @returns The deposit, or null when that side has not placed one.
 */
function depositOf(
  db: DbClient | DbTx,
  meetupId: string,
  ownerId: string,
): Promise<Deposit | null> {
  return db.deposit.findUnique({ where: { meetupId_ownerId: { meetupId, ownerId } } });
}
