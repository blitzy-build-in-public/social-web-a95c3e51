/**
 * The acceptance half of the commitment lock: `POST /meetups/:id/accept`, `POST /meetups/:id/decline` and the
 * additive `POST /meetups/:id/hold`.
 * {@link acceptMeetup} is the recipient's side of the lock: it accepts only from a proposal the recipient can see and
 * only before `recipientDeadline`, marks the acceptance intent once, and places the recipient's own hold — attempt 1
 * on a proposal they have not answered, attempt `n + 1` after a refused card, or the secret of the attempt that
 * already carries an authorization. {@link declineMeetup} runs the state machine's own `decline` transition, and
 * {@link retryInitiatorHold} is the same hold path for the initiator.
 * **The proposal locks itself.** No branch here moves a meetup to `locked`: the recipient's hold reaching
 * `requires_capture` does, through `applyHoldOutcome`. This file decides who may act and which attempt to place; the
 * state machine decides whether the result locks the meetup.
 * **One fenced transaction, then Stripe.** Each handler opens exactly one transaction through `transact`, fenced on
 * the acting account, and takes `lockMeetup` before reading or writing anything about the meetup, so a racing accept,
 * cancel, block, lapse, check-in, dispute or hold-loss webhook serializes on the row. No provider call runs inside it:
 * the hold whose result is the response runs after the commit through `executeHoldInline`, after the release a retry
 * planned for the superseded attempt, and the meetup's remaining operations run after that.
 * **A lost answer is never a second authorization.** A deposit left `pending` answers `409 hold_pending` rather than
 * starting a new attempt, while the sweeper replays the identical create under its original key; a repeated accept
 * during 3-D Secure returns the same attempt's secret and writes no `PaymentOperation`; and the secret a route answers
 * with is always the caller's own. No client secret, PaymentIntent id or amount is ever logged.
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
import type { RunOperationsOptions } from '../payments/operations.ts';
import type { MeetupRow } from './queries.ts';

// Type-only, as everywhere in this module: `app.ts` is the one declaration of the app's type and nothing of that module is read here at runtime.
import type { AppServices } from '../../app.ts';

const ACCEPT_EVENT = 'meetup_accept';

const DECLINE_EVENT = 'meetup_decline';

const HOLD_RETRY_EVENT = 'meetup_hold_retry';

/** The log event name of the `refused` row of {@link HOLD_PLAN}: the client acted on a meetup whose money had
 * already been decided, so the answer is `409 not_proposed`. No secret, PaymentIntent id or amount is logged. */
const DEPOSIT_REFUSED_EVENT = 'meetup_deposit_refused';

/**
 * What a hold path does with one side's deposit, by the deposit's own status.
 * The table is total over `DepositStatus`, so a status added to the lifecycle is a compile error until the row it
 * needs is written. A side with no deposit row at all is decided by each route before it consults the table, because
 * the two routes answer it differently: an accept creates attempt 1, a hold retry has nothing to retry.
 * - `retry` — `failed`: no authorization is left, and `failed → pending` with attempt `n + 1` is the retry.
 * - `confirm` — `requires_action` and `held`: an authorization exists, so the route answers the caller's own current
 *   attempt's secret and creates no new one.
 * - `recovering` — `pending`: the attempt has not concluded, and replaying it is the only way to learn its
 *   PaymentIntent id, so every retry is answered `409 hold_pending`.
 * - `refused` — `released`, `captured`, `expired` and `refunded`: the money decision is durable, so the answer is
 *   `409 not_proposed`, and the state is logged because reaching it means the meetup moved unobserved.
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
 * How a repeated accept answers the provider's own view of the caller's current attempt: an attempt still missing
 * the customer's step and one whose authorization has landed and awaits the applying webhook both answer the caller's
 * own secret — never the counterpart's. A state this application does not model as an authorization —
 * `requires_payment_method`, `requires_confirmation`, `processing` — answers `503 payment_unavailable`. A `canceled`
 * or `succeeded` attempt has nothing left to confirm: the webhook or the executor moves the deposit, and the client's
 * next step appears when it refetches.
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

/**
 * `POST /meetups/:id/accept`: the recipient accepts a visible proposal and places their own hold.
 * The guards run in the order the contract lists them, all inside the transaction that takes the meetup row lock: the
 * caller must be the recipient of a proposal they can see, it must not have lapsed or passed `recipientDeadline`, and
 * it must still be `proposed`. The acceptance intent is then recorded once — `recipientAcceptedAt` with the funnel's
 * `proposal_accepted` — on the first accept past those guards, whatever the authorization outcome turns out to be, so
 * a declined card and its retry emit nothing further.
 * What happens to the money is the recipient's own deposit's state alone, from {@link HOLD_PLAN}: no deposit yet
 * creates attempt 1 in this transaction, `failed` starts attempt `n + 1` through `startNewAttempt`, `requires_action`
 * and `held` answer that attempt's own secret without writing an operation, `pending` answers `409 hold_pending`, and
 * a durable money decision answers `409 not_proposed`.
 * The response is read back after the hold: `locked` when the recipient's authorization landed with the initiator's
 * hold already `held`, `proposed` while it is still pending, and `410 proposal_lapsed` or `409 not_proposed` for a
 * proposal that moved under the acceptance.
 * @throws AppError `meetup_not_found` (404), `not_recipient` (403), `proposal_lapsed` (410), `not_proposed` (409),
 *   `hold_failed` (402), `hold_pending` (409) or `payment_unavailable` (503).
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
      // 1. The meetup row lock, then the caller's own side of the proposal. Only the recipient may accept: the initiator
      //    and a stranger are answered `403 not_recipient`, and a recipient whose proposal the initiator has not made
      //    visible is answered `404 meetup_not_found`, so a proposal the caller is not meant to see stays hidden.
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
      // 2. A proposal that has lapsed, or one still `proposed` past `recipientDeadline`, is refused and writes nothing:
      //    the lapse and the releases it carries are the sweeper's, and refusing here keeps a late accept from locking a
      //    meetup nobody can still attend. Only a `proposed` proposal reaches the deadline rule.
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
      // 4. The acceptance intent, recorded in the transaction that decides the attempt, so the funnel's count and the timestamp it counts are one fact.
      await recordAcceptedAt(tx, services, meetup, now);
      // 5. The recipient's own deposit decides the rest, by its status alone (AAP 0.5.3).
      const deposit = await depositOf(tx, meetup.id, userId);
      if (deposit === null) {
        // The recipient has not answered yet: attempt 1 is created and its hold planned in this transaction, so the authorization it carries is as durable as the deposit it belongs to.
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
            // `hold_pending` is the previous attempt's unresolved create; `not_failed` means another writer moved the deposit between the read and the guarded update.
            throw new AppError(started.reason === 'hold_pending' ? 'hold_pending' : 'not_proposed');
          }
          return { plan: 'run', holdOperationId: started.holdOp.id };
        }
        case 'confirm':
          // A repeated accept: the attempt carries an authorization — one still missing the customer's 3-D Secure step, or one
          // already held on this side of a proposal that has not locked — so its own secret is returned and no second
          // authorization is created.
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
 * `POST /meetups/:id/decline`: the recipient refuses a proposal that is still `proposed`.
 * The refusals are the contract's own, in its order: an unknown meetup, or a proposal the caller is not meant to see
 * yet, is `404 meetup_not_found`; a caller who is not the recipient is `403 not_recipient`; and any status other than
 * `proposed` is `409 not_proposed`.
 * A proposal past its `recipientDeadline` is deliberately still declinable: it stays `proposed` until the sweeper
 * lapses it, and the recipient refusing it releases the holds exactly as the lapse does. The `decline` row of the
 * transition table does the work in this same transaction, and the releases it planned run after the commit.
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
  // The releases the transition planned are provider calls, so they run here and never under the row lock; a failure leaves them to the sweeper rather than failing a decline already committed.
  await runMeetupOperations(services, meetupId);
  services.logger.info({ event: DECLINE_EVENT, meetupId }, DECLINE_EVENT);
  return { status: 'declined' };
}

/**
 * `POST /meetups/:id/hold`: the initiator retries their own failed hold.
 * The route is the initiator's alone: a caller who is not on the meetup is `403 not_participant` and the recipient,
 * whose own side is `accept`, is `403 not_initiator`. It applies while the proposal is still open, and moves the money
 * through the same {@link HOLD_PLAN} table and the same post-commit work as {@link acceptMeetup}, including the
 * release a retry plans for the attempt it superseded.
 * `initiatorHold` is read back after the hold, so the client sees the state this call left. The response reports
 * `proposed`, which is what the contract fixes for this route: a retry only ever adds the authorization the
 * initiator's own side was missing, and the lock needs the recipient's hold.
 * @throws AppError `meetup_not_found` (404), `not_participant` (403), `not_initiator` (403), `not_proposed` (409),
 *   `hold_pending` (409), `hold_failed` (402) or `payment_unavailable` (503).
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
      // A hold is retried while the proposal is still open: a locked proposal has both authorizations and a final one has already decided its money.
      if (meetup.status !== 'proposed') {
        throw new AppError('not_proposed');
      }
      const deposit = await depositOf(tx, meetup.id, userId);
      if (deposit === null) {
        // The initiator's deposit is created with the proposal, so a proposal without one has no attempt to retry; the client's next step comes from refetching the meetup.
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
          // An attempt that already carries an authorization, waiting on the customer's step or already held: the route is idempotent and answers the caller's own secret.
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

/**
 * Run one attempt's hold inline and return the caller's own secret to confirm it.
 * The hold's result *is* the response, so it runs in the request that asked for it rather than being left to the
 * sweeper. Its predecessors run first: a retry plans the new attempt's hold **after** the release of the attempt it
 * superseded, and the executor's claim gate refuses a hold while any lower `seq` of its deposit is still open, so the
 * scoped pass is what lets this call place the attempt it was asked to place. The meetup's remaining operations then
 * carry out the orphan release a hold outcome plans. A failure in either pass is logged rather than raised, because
 * those rows are durable and the sweeper resumes them.
 * The outcomes that are not an authorization are mapped by {@link inlineHoldOrThrow}, exactly as `POST /meetups` maps
 * them, except that a hold this call could not claim answers `409 hold_pending` here, because on these routes the
 * caller is the one who may retry.
 * @throws AppError `hold_failed` (402), `hold_pending` (409) or `payment_unavailable` (503).
 */
async function runHoldAttempt(
  services: AppServices,
  meetupId: string,
  holdOperationId: string,
): Promise<string> {
  // The rows the claim gate makes this hold wait on — the release of the attempt it superseded — run first, so the create this answer reports is its own.
  await runMeetupOperations(services, meetupId, { beforeOperationId: holdOperationId });
  const result = await executeHoldInline(services, holdOperationId);
  await runMeetupOperations(services, meetupId);
  return inlineHoldOrThrow(result, { pendingCode: 'hold_pending' }).clientSecret;
}

/**
 * Read the caller's own current attempt again and return the secret that finishes it.
 * This is the repeated accept — and the repeated hold — after an app restart during 3-D Secure: the attempt's
 * authorization is durable and only the customer's step is missing, so nothing is written and no second authorization
 * is created. The PaymentIntent is the provider's own view of the attempt, named by the caller's own deposit's
 * `currentPaymentIntentId`, never the counterpart's. A state the client cannot act on is answered rather than assumed,
 * from {@link ATTEMPT_ANSWERS}.
 * @throws AppError `payment_unavailable` (503) or `not_proposed` (409).
 */
async function confirmOwnAttempt(
  services: AppServices,
  meetupId: string,
  paymentIntentId: string | null,
): Promise<string> {
  if (paymentIntentId === null) {
    // An authenticated attempt always records its PaymentIntent, so a missing one cannot be confirmed by the client: the same answer `inlineHoldOrThrow` gives an authorized outcome with no secret.
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
 * Read one PaymentIntent from the provider, or answer the route's recoverable failure. A state that could not be
 * observed decides nothing, so it becomes `503 payment_unavailable` and the client recovers through `GET /meetups`.
 * The id reaches no log line and no response.
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
 * The accept route's `200` status, read back after the commit: `locked` once the recipient's authorization landed
 * with the initiator's hold already `held`, and `proposed` while one of the two is still pending. Any other status
 * means the proposal moved under the acceptance, and nothing is outstanding then, because a hold outcome arriving for
 * a finished meetup releases its authorization.
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

/** The caller's own hold state as {@link HoldRetryResponse} reports it, read after the commit: the deposit's
 * current status, or `none` for a side with no deposit. */
async function depositView(
  services: AppServices,
  meetupId: string,
  ownerId: string,
): Promise<HoldView> {
  return holdView(await depositOf(services.db, meetupId, ownerId));
}

/**
 * Carry out the operations a decision planned, once its transaction has committed. A failure to reach the provider
 * never fails the request: the operations are durable rows, and the 60-second sweeper resumes every one still open.
 */
async function runMeetupOperations(
  services: AppServices,
  meetupId: string,
  opts?: RunOperationsOptions,
): Promise<void> {
  try {
    await runOperationsFor(services, { meetupId }, opts);
  } catch (error) {
    services.logger.warn(
      { event: 'meetup_operations_deferred', meetupId, code: failureToken(error) },
      'meetup_operations_deferred',
    );
  }
}

/**
 * Record the recipient's acceptance intent and the funnel stage that counts it, once.
 * `recipientAcceptedAt` is set on the first accept that passes its route's guards, whatever the authorization outcome
 * turns out to be, and the conditional update is what makes two racing accepts write one instant and one
 * `proposal_accepted` event, in the transaction that decides the attempt.
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

/** One side's deposit of a meetup: a meetup holds at most one deposit per side. */
function depositOf(
  db: DbClient | DbTx,
  meetupId: string,
  ownerId: string,
): Promise<Deposit | null> {
  return db.deposit.findUnique({ where: { meetupId_ownerId: { meetupId, ownerId } } });
}

/** The safe shape a logged failure token may have: a short identifier and nothing else. */
const FAILURE_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * A failure's own short token for a log line: its driver code (`P2028`, `resource_missing`) or its class name
 * (`PaymentUnavailableError`), never its message or stack, which can quote the `PaymentIntent` id it concerns or the
 * credential it was presented with. A token that is not a plain short identifier becomes `Error`.
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
