/**
 * The meetup state machine: the transition table, the row lock every meetup mutation takes first, and the side
 * effects one transition writes.
 *
 * This file is the **only** writer of `Meetup.status`. Every handler that changes a meetup re-reads its row under
 * {@link lockMeetup} and then calls {@link transition}, so two racing actions are serialized on that row and the
 * second one sees the first one's result. Its entry points are {@link transition} — one event of the table, with its
 * status, deposits, analytics, notifications, dispute resolution and timers — {@link markProposalVisible},
 * {@link applyHoldOutcome} and {@link markRecipientViewed}.
 *
 * Everything a transition decides is written in the caller's transaction: the new status, the `AnalyticsEvent` rows,
 * the notification outbox rows, the deposit move, `PaymentOperation`s and the deposit-level `resolved` of an open
 * dispute. Timers and WebSocket frames are the only work registered through `after`, so no Redis, Stripe or BullMQ
 * call ever runs inside a transaction.
 *
 * The imports are deliberately narrow, because the modules that consume this file import it: it may import no
 * `payments/operations.ts`, `payments/webhook.ts`, `settlement/settle.ts`, `users/safety.ts` or handler of this
 * folder without closing a runtime ESM cycle.
 */

import { Prisma } from '@tablemate/db';
import type { DbTx, Deposit } from '@tablemate/db';
import { HOUR_MS, RECIPIENT_DEADLINE_HOURS, isFinalMeetupStatus } from '@tablemate/shared';
import type {
  AnalyticsProps,
  CancelReason,
  DepositStatus,
  DisputeResolutionNote,
  ForfeitReason,
  MeetupStatus,
  MeetupStatusFrame,
  SettlementOutcome,
} from '@tablemate/shared';

import { emit, emitMany } from '../analytics/emit.ts';
import type { EmitFields } from '../analytics/emit.ts';
import { notify, notifyAll } from '../notifications/enqueue.ts';
import type { AfterCommit } from '../outbox/write.ts';
import {
  advanceDeposit,
  depositsForMeetup,
  hasCaptureOrRelease,
  holdView,
  planRelease,
  releaseAllOpen,
} from '../payments/holds.ts';
import { removeMeetupTimers, scheduleLapse, scheduleLockedTimers } from '../settlement/timers.ts';

import { isVisibleTo, lateCancelFrom, participantRole } from './queries.ts';
import type { MeetupRow } from './queries.ts';

import type { AppServices } from '../../app.ts';

// The events and the transition table (AAP 0.5.3)

/** What produced an event; logged as the transition's `trigger` and never stored (AAP 0.11.1). */
export type MeetupEventSource =
  'route' | 'webhook' | 'operations' | 'timer' | 'sweeper' | 'operator' | 'settlement' | 'deletion';

/**
 * The fields every {@link MeetupEvent} carries: `at` is the instant the decision is judged at — a route passes the
 * request's own received-at instant, so the guard that route applied and this transition agree to the millisecond —
 * and `source` names the producer and reaches the log line alone, so a replay from the sweeper and a route call write
 * identical rows.
 */
export interface MeetupEventFields {
  readonly at?: Date;
  readonly source?: MeetupEventSource;
}

/**
 * One event the table accepts, discriminated on `type`. The set is closed on purpose: an event that is not one of
 * these has no row in {@link MEETUP_TRANSITIONS} and {@link nextStatus} answers `null` for it. `cancel.reason` is the
 * canceller's own side rather than the stored `CancelReason`: `block` and `account_deleted` are the `block` and
 * `deletion` events, which the table treats differently.
 */
export type MeetupEvent =
  | (MeetupEventFields & { readonly type: 'recipient_hold_held' })
  | (MeetupEventFields & { readonly type: 'decline' })
  | (MeetupEventFields & { readonly type: 'lapse' })
  | (MeetupEventFields & {
      readonly type: 'cancel';
      readonly actorId: string;
      readonly reason: 'initiator' | 'recipient';
    })
  | (MeetupEventFields & { readonly type: 'block'; readonly actorId: string })
  | (MeetupEventFields & { readonly type: 'deletion'; readonly actorId: string })
  | (MeetupEventFields & {
      readonly type: 'hold_lost';
      readonly depositId: string;
      readonly canceledAt: Date;
    })
  | (MeetupEventFields & { readonly type: 'settle'; readonly outcome: SettlementOutcome })
  | (MeetupEventFields & { readonly type: 'operator_no_fault'; readonly operatorId: string })
  | (MeetupEventFields & { readonly type: 'compensate' });

/** The `type` of a {@link MeetupEvent}, the key a row of {@link MEETUP_TRANSITIONS} is found by. */
export type MeetupEventType = MeetupEvent['type'];

/** What a row of {@link MEETUP_TRANSITIONS} names: the status an event leads to, or `by_outcome` for the one event whose target depends on what it carries (`settle`). */
export type MeetupTransitionTarget = MeetupStatus | 'by_outcome';

/**
 * The meetup transition table, one row per status and one column per event. A pair absent from this table is refused:
 * every event on a final status (`declined`, `lapsed`, `cancelled`, `completed`, `forfeited`, `unattended`,
 * `lock_lost`, `no_fault`) is invalid, which is what makes a final meetup a final one.
 *
 * The two rows the table does not carry, because {@link transition} guards them rather than rejecting the pair: a
 * `cancel` or `deletion` on a `locked` meetup is only `cancelled` at or before `startsAt - 2 h`, and a `hold_lost`
 * moves the meetup only when the deposit it names is actually `held`.
 */
export const MEETUP_TRANSITIONS: Readonly<
  Record<MeetupStatus, Partial<Record<MeetupEventType, MeetupTransitionTarget>>>
> = {
  proposed: {
    recipient_hold_held: 'locked',
    decline: 'declined',
    lapse: 'lapsed',
    cancel: 'cancelled',
    block: 'cancelled',
    deletion: 'cancelled',
    hold_lost: 'lock_lost',
  },
  locked: {
    cancel: 'cancelled',
    deletion: 'cancelled',
    block: 'cancelled',
    settle: 'by_outcome',
    operator_no_fault: 'no_fault',
    hold_lost: 'lock_lost',
  },
  forfeited: {
    operator_no_fault: 'no_fault',
    compensate: 'lock_lost',
  },
  declined: {},
  lapsed: {},
  cancelled: {},
  completed: {},
  unattended: {},
  lock_lost: {},
  no_fault: {},
};

/** The status a `settle` event leads to, per outcome: a no-show and a late cancellation are both `forfeited`, and the `forfeitReason` written beside the status is what tells the two apart. */
export const SETTLE_OUTCOME_STATUSES: Readonly<Record<SettlementOutcome, MeetupStatus>> = {
  completed: 'completed',
  no_show: 'forfeited',
  late_cancel: 'forfeited',
  unattended: 'unattended',
};

/**
 * The status `event` moves `from` to, or `null` when the pair is not in {@link MEETUP_TRANSITIONS}. Pure and free of
 * I/O, so the whole table is exercised by the state-machine unit suite without a database; it is the only place the
 * table is read, and {@link transition} refuses the event when it answers `null`.
 */
export function nextStatus(from: MeetupStatus, event: MeetupEvent): MeetupStatus | null {
  const target = MEETUP_TRANSITIONS[from][event.type];
  if (target === undefined) {
    return null;
  }
  if (target === 'by_outcome') {
    return event.type === 'settle' ? SETTLE_OUTCOME_STATUSES[event.outcome] : null;
  }
  return target;
}

/**
 * Whether `now` is inside the two hours before the start at which a cancellation stops being free: the boundary is
 * `startsAt - 2 h`, exactly where a cancellation is still free, and one second later it forfeits the canceller's hold
 * through the recoverable settlement. `cancel.ts` re-exports this as its own `isLateCancel`, so the instant a screen
 * shows and the instant this guard applies turn over together.
 */
export function isLateCancel(now: Date, startsAt: Date): boolean {
  return now.getTime() > lateCancelFrom(startsAt).getTime();
}

/** The fields an {@link InvalidTransitionError} carries (AAP 0.5.3). */
export interface InvalidTransition {
  /** The meetup the refused event was applied to. */
  readonly meetupId: string;
  /** The status the meetup held when it was refused. */
  readonly from: MeetupStatus;
  /** The refused event itself. */
  readonly event: MeetupEvent;
}

/**
 * A transition the table does not allow, or one its guard refused. Every caller pre-checks the status it read under
 * the meetup row lock, so this error is a programming error or an unhandled race rather than a client error: it
 * carries the row, the status and the event for the log, and the error plugin maps it to `500 internal_error`.
 */
export class InvalidTransitionError extends Error {
  /** The meetup the refused event was applied to. */
  readonly meetupId: string;
  /** The status the meetup held when it was refused. */
  readonly from: MeetupStatus;
  /** The refused event. */
  readonly event: MeetupEvent;
  constructor(transition: InvalidTransition) {
    super(`meetup ${transition.meetupId}: ${transition.from} cannot take ${transition.event.type}`);
    this.name = 'InvalidTransitionError';
    this.meetupId = transition.meetupId;
    this.from = transition.from;
    this.event = transition.event;
    // Kept `instanceof`-correct when this module and a copy of it are both loaded in one process.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// The row lock (AAP 0.3.2, 0.5.3)

/**
 * Lock the meetup row and read it back, or answer `null` when there is no such meetup.
 *
 * **Serialization contract.** Every meetup mutation takes this lock before it reads or writes anything about the
 * meetup: cancel, decline, block, account deletion, check-in, dispute filing, settlement, an operator resolution and
 * the hold-loss webhook. Two racing actions are therefore serialized on the row, and the second one re-reads the
 * result the first one committed rather than acting on a status it read before. Calling it again in the same
 * transaction is a no-op: PostgreSQL grants a lock the transaction already holds.
 *
 * **Lock order.** `transact` takes the account-deletion write fence (`FOR SHARE` on the acting user) first, then this
 * lock, then any deposit or `PaymentOperation` row of that meetup. Two meetups are never locked in one transaction,
 * which is what keeps that order acyclic.
 */
export async function lockMeetup(tx: DbTx, id: string): Promise<MeetupRow | null> {
  const rows = await tx.$queryRaw<readonly { id: string }[]>(Prisma.sql`
    SELECT "id" FROM "meetup" WHERE "id" = ${id}::uuid FOR UPDATE
  `);
  if (rows.length === 0) {
    return null;
  }
  return tx.meetup.findUnique({ where: { id } });
}

// The transition (AAP 0.5.3)

/**
 * Apply one event of {@link MEETUP_TRANSITIONS} to a meetup its caller has locked.
 *
 * The caller holds {@link lockMeetup} on `meetup.id` and passes the row it read under that lock; every effect below
 * is written in the caller's transaction, so the new status, the deposit move, the `AnalyticsEvent` rows, the
 * notification outbox rows and an automatic dispute resolution commit together or not at all.
 *
 * The status write is one `update` (the new status, `finalAt` on the first final status, `lockedAt` on the lock,
 * `cancelReason` for a cancellation, `forfeitReason` and `settledAt` for a settlement); every other effect is decided
 * by the event: `recipient_hold_held` locks, with `deposit_locked` for the recipient, `meetup_locked` per participant,
 * a notification each and the two locked timers; `decline`, `lapse`, `cancel`, `block`, `deletion` and `hold_lost`
 * release every non-final attempt — the lost one is `expired` first — and notify the parties their row names, with a
 * block and a lost hold also resolving an open dispute `no_fault`, with the note `cancelled_by_block` or
 * `hold_expired`.
 *
 * `settle` and `compensate` are deliberately empty: `settlement/settle.ts` writes the capture and release operations,
 * the Table Credit entry, the witness events, the pair history, the analytics and the notifications of its outcome in
 * this same transaction, and `admin/disputes.ts` writes the fencing and the reversing refund of a post-settlement
 * `no_fault`. The post-commit work is the shared `MeetupStatusFrame` push, the locked meetup's two timers or the
 * removal of a final meetup's three, and one `meetup_transition` log line. No Redis, Stripe or BullMQ call runs
 * before the commit.
 *
 * @throws InvalidTransitionError when the table does not allow the pair, when a cancellation of a `locked` meetup is
 *   late, or when a `hold_lost` names a deposit this meetup does not own.
 */
export async function transition(
  tx: DbTx,
  services: AppServices,
  after: AfterCommit,
  meetup: MeetupRow,
  event: MeetupEvent,
): Promise<MeetupRow> {
  const at = event.at ?? services.clock.now();
  const from = meetup.status;
  const to = nextStatus(from, event);
  if (to === null) {
    throw new InvalidTransitionError({ meetupId: meetup.id, from, event });
  }
  // A cancellation inside the last two hours is not a free one: it runs through
  // `settlement/settle.ts` as a `late_cancel` forfeit, which reconciles both authorizations first
  // and anchors `MeetupSettlement.appliedAt` (AAP 0.5.3).
  if (
    (event.type === 'cancel' || event.type === 'deletion') &&
    from === 'locked' &&
    isLateCancel(at, meetup.startsAt)
  ) {
    throw new InvalidTransitionError({ meetupId: meetup.id, from, event });
  }
  // A hold loss is decided by the deposit's own state first: only a `held` hold's loss is a
  // `lock_lost`, and a lost recipient hold on a proposed meetup leaves the proposal standing.
  const loss = event.type === 'hold_lost' ? await recordHoldLoss(tx, meetup, event) : null;
  if (loss !== null && !loss.movesMeetup) {
    services.logger.info({
      event: loss.log,
      meetupId: meetup.id,
      trigger: event.source ?? event.type,
    });
    publishStatusFrame(after, services, meetup, await depositsForMeetup(tx, meetup.id));
    return meetup;
  }
  const cityId = await venueCityId(tx, meetup.venueId);
  const updated = await tx.meetup.update({
    where: { id: meetup.id },
    data: meetupStatusData(meetup, event, to, at),
  });
  const fields = meetupFields(updated, cityId);
  const funnel = funnelFields(updated, cityId);
  /** What happens to the meetup's timers once the transaction has committed. */
  let timers: 'schedule' | 'remove' | 'none' = 'remove';
  switch (event.type) {
    case 'recipient_hold_held':
      // The recipient's hold is held and the initiator's was: the lock is the funnel's
      // `deposit_locked` for the recipient and one `meetup_locked` per participant (AAP 0.5.7).
      await emitMany(tx, services, [
        { name: 'meetup_locked', actorUserId: updated.initiatorId, fields: funnel },
        { name: 'meetup_locked', actorUserId: updated.recipientId, fields: funnel },
        { name: 'deposit_locked', actorUserId: updated.recipientId, fields: funnel },
      ]);
      await notifyAll(tx, participantIds(updated), 'meetup_locked', { meetupId: updated.id });
      timers = 'schedule';
      break;
    case 'decline':
      await releaseAllOpen(tx, updated.id, at);
      await emit(tx, services, 'proposal_declined', updated.recipientId, fields);
      await notify(tx, updated.initiatorId, 'proposal_declined', { meetupId: updated.id });
      break;
    case 'lapse':
      await releaseAllOpen(tx, updated.id, at);
      await emit(tx, services, 'proposal_lapsed', null, fields);
      await notify(tx, updated.initiatorId, 'proposal_lapsed', { meetupId: updated.id });
      if (isVisibleTo(updated, updated.recipientId)) {
        // The recipient too, but only when the proposal was visible: a proposal that lapsed before
        // either hold was seen is nothing to announce to them (AAP 0.5.3).
        await notify(tx, updated.recipientId, 'proposal_lapsed', { meetupId: updated.id });
      }
      break;
    case 'cancel':
      await releaseAllOpen(tx, updated.id, at);
      if (from === 'locked') {
        await emit(tx, services, 'cancelled_early', event.actorId, fields);
        await notifyAll(tx, participantIds(updated), 'meetup_cancelled', { meetupId: updated.id });
      } else if (isVisibleTo(updated, counterpartOf(updated, event.actorId))) {
        await notify(tx, counterpartOf(updated, event.actorId), 'meetup_cancelled', {
          meetupId: updated.id,
        });
      }
      break;
    case 'block':
      await releaseAllOpen(tx, updated.id, at);
      if (from === 'locked') {
        // Safety outranks the money rules: the block releases both holds and closes an open dispute
        // without fault, so no settlement ever applies it (AAP 0.5.3).
        await resolveOpenDispute(tx, services, updated, 'cancelled_by_block', at, cityId);
      }
      await notifyAll(tx, participantIds(updated), 'meetup_cancelled', { meetupId: updated.id });
      break;
    case 'deletion':
      await releaseAllOpen(tx, updated.id, at);
      // The deleted account is not notified: its sessions are revoked and its addresses erased.
      await notify(tx, counterpartOf(updated, event.actorId), 'meetup_cancelled', {
        meetupId: updated.id,
      });
      break;
    case 'hold_lost':
      // The lost attempt was marked `expired` already, so `releaseAllOpen` skips it and releases
      // every other open attempt, the counterpart's included (AAP 0.5.3).
      await releaseAllOpen(tx, updated.id, at);
      await emit(tx, services, 'lock_lost', null, fields);
      await notifyAll(tx, participantIds(updated), 'lock_lost', { meetupId: updated.id });
      await resolveOpenDispute(tx, services, updated, 'hold_expired', at, cityId);
      break;
    case 'settle':
      // `settlement/settle.ts` owns every effect of a settlement; see this function's TSDoc.
      break;
    case 'operator_no_fault':
      if (from === 'locked') {
        await releaseAllOpen(tx, updated.id, at);
      } else {
        // A post-settlement `no_fault` reverses the money in the operator's own transaction, and
        // the meetup was final already: its timers are gone (AAP 0.5.3).
        timers = 'none';
      }
      await emit(tx, services, 'meetup_no_fault', null, fields);
      break;
    case 'compensate':
      timers = 'none';
      break;
    default:
      assertNever(event);
  }
  if (timers === 'schedule') {
    after(() => scheduleLockedTimers(services, updated));
  } else if (timers === 'remove') {
    after(() => removeMeetupTimers(services, updated.id));
  }
  publishStatusFrame(after, services, updated, await depositsForMeetup(tx, updated.id));
  services.logger.info({
    event: 'meetup_transition',
    meetupId: updated.id,
    from,
    to,
    trigger: event.source ?? event.type,
  });
  return updated;
}

// The transition's helpers (AAP 0.5.3)

/** What recording a hold loss decided: whether the meetup itself takes the `lock_lost` row. */
interface HoldLossResult {
  /** True only when the lost deposit was a `held` hold, the one `lock_lost` is defined for. */
  readonly movesMeetup: boolean;
  /** The log event name of the path taken, so an operator can tell the four apart. */
  readonly log: string;
}

/**
 * Mark the deposit a `hold_lost` names `expired` and say whether the meetup moves with it. Three of the four paths
 * leave the meetup alone, each for a reason the plan states: the lost hold is the recipient's while the meetup is
 * still `proposed`, which cannot lock and is unreachable in practice; the attempt was never held (`pending` or
 * `requires_action`), so Stripe cancelled an authorization that never became a hold, which the deposit lifecycle
 * turns into `failed` so the user can retry while the meetup is `proposed`; or the attempt already ended, so the
 * event describes an authorization that is no longer the deposit's current one.
 *
 * @throws InvalidTransitionError when the deposit does not exist or belongs to another meetup.
 */
async function recordHoldLoss(
  tx: DbTx,
  meetup: MeetupRow,
  event: Extract<MeetupEvent, { type: 'hold_lost' }>,
): Promise<HoldLossResult> {
  const deposit = await tx.deposit.findUnique({ where: { id: event.depositId } });
  if (deposit === null || deposit.meetupId !== meetup.id) {
    throw new InvalidTransitionError({ meetupId: meetup.id, from: meetup.status, event });
  }
  const ref = { depositId: deposit.id, attempt: deposit.currentAttempt };
  if (deposit.status === 'held') {
    await advanceDeposit(tx, ref, 'expired', { canceledAt: event.canceledAt });
    if (meetup.status === 'proposed' && deposit.role === 'recipient') {
      return { movesMeetup: false, log: 'recipient_hold_lost_while_proposed' };
    }
    return { movesMeetup: true, log: 'hold_lost' };
  }
  if (deposit.status === 'pending' || deposit.status === 'requires_action') {
    await advanceDeposit(tx, ref, 'failed');
    return { movesMeetup: false, log: 'hold_lost_without_hold' };
  }
  return { movesMeetup: false, log: 'hold_lost_ignored' };
}

/**
 * The columns one transition writes on the meetup row. `finalAt` is the retention clock: it is written by the
 * transition that first reaches a final status and never moved afterwards, so a meetup that later takes one more
 * final row (a `forfeited` to `no_fault` or `lock_lost`) keeps the instant its retention was measured from.
 */
function meetupStatusData(
  meetup: MeetupRow,
  event: MeetupEvent,
  status: MeetupStatus,
  at: Date,
): Prisma.MeetupUpdateInput {
  const cancelReason = cancelReasonFor(event);
  const forfeitReason = event.type === 'settle' ? forfeitReasonFor(event.outcome) : null;
  return {
    status,
    ...(isFinalMeetupStatus(status) && meetup.finalAt === null ? { finalAt: at } : {}),
    ...(status === 'locked' ? { lockedAt: at } : {}),
    ...(cancelReason === null ? {} : { cancelReason }),
    ...(forfeitReason === null ? {} : { forfeitReason }),
    ...(event.type === 'settle' ? { settledAt: at } : {}),
  };
}

/** The `cancelReason` an event records, or null when the event does not cancel (AAP 0.5.2). */
function cancelReasonFor(event: MeetupEvent): CancelReason | null {
  switch (event.type) {
    case 'cancel':
      return event.reason;
    case 'block':
      return 'block';
    case 'deletion':
      return 'account_deleted';
    default:
      return null;
  }
}

/** The `forfeitReason` a settlement outcome records, or null when nothing is forfeited (AAP 0.5.3). */
function forfeitReasonFor(outcome: SettlementOutcome): ForfeitReason | null {
  if (outcome === 'no_show') {
    return 'no_show';
  }
  if (outcome === 'late_cancel') {
    return 'late_cancel';
  }
  return null;
}

/** The venue's city, read once per transition so every analytics row carries it; a venue that is not there leaves the column null rather than failing the transition. */
async function venueCityId(tx: DbTx, venueId: string): Promise<string | undefined> {
  const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { cityId: true } });
  return venue?.cityId;
}

/** Both participants' ids, initiator first: `notifyAll` writes one row per distinct recipient. */
function participantIds(meetup: MeetupRow): readonly string[] {
  return [meetup.initiatorId, meetup.recipientId];
}

/** The participant who is not `userId`: the counterpart a cancellation notifies (AAP 0.5.3). */
function counterpartOf(meetup: MeetupRow, userId: string): string {
  return participantRole(meetup, userId) === 'initiator' ? meetup.recipientId : meetup.initiatorId;
}

/** The columns of a meetup's non-funnel analytics event (AAP 0.5.2, 0.5.7). */
function meetupFields(meetup: MeetupRow, cityId: string | undefined): EmitFields {
  return {
    meetupId: meetup.id,
    ...(cityId === undefined ? {} : { cityId }),
  };
}

/**
 * The props every funnel event of a meetup carries: the pairing the variant filter selects on, and the deposit the
 * funnel measures. The actor's own `variant` and `assignmentId` are supplied by `analytics/emit.ts` from the actor's
 * stored assignment.
 */
function funnelProps(meetup: MeetupRow): AnalyticsProps {
  return { variantPairing: meetup.variantPairing, depositCents: meetup.depositCents };
}

/** {@link meetupFields} plus {@link funnelProps}: the columns of a funnel event (AAP 0.5.7). */
function funnelFields(meetup: MeetupRow, cityId: string | undefined): EmitFields {
  return { ...meetupFields(meetup, cityId), props: funnelProps(meetup) };
}

/**
 * Resolve a meetup's open dispute without fault, in the transaction that decided it: a block and a lost hold both
 * end the meetup with no fault on either side, and both close an open dispute with the note that says which
 * happened. The operator resolution notifies the parties itself, so this writes the row and the event and nothing
 * else.
 */
async function resolveOpenDispute(
  tx: DbTx,
  services: AppServices,
  meetup: MeetupRow,
  note: DisputeResolutionNote,
  at: Date,
  cityId: string | undefined,
): Promise<void> {
  const dispute = await tx.dispute.findFirst({
    where: { meetupId: meetup.id, status: 'open' },
    select: { id: true },
  });
  if (dispute === null) {
    return;
  }
  await tx.dispute.update({
    where: { id: dispute.id },
    data: { status: 'resolved', outcome: 'no_fault', resolutionNote: note, resolvedAt: at },
  });
  await emit(tx, services, 'dispute_resolved', null, meetupFields(meetup, cityId));
}

// Visibility and hold outcomes (AAP 0.5.3, 0.5.4)

/**
 * Make a proposal visible to its recipient and start the acceptance deadline. Called when the initiator's hold
 * becomes `held` on a `proposed` meetup whose `proposalVisibleAt` is still null, and idempotent: a meetup that is
 * already visible, or that is no longer `proposed`, is returned unchanged, which is what makes a webhook replay and a
 * sweeper replay harmless.
 *
 * It sets `proposalVisibleAt` and `recipientDeadline = min(at + 48 h, startsAt)`, so a proposal can never outlive its
 * own start; it notifies the recipient, emits `proposal_sent` for the initiator, and replaces the invisible-phase
 * lapse timer at `createdAt + 48 h` that `propose.ts` scheduled with one at the deadline. When the deadline has
 * already arrived, the proposal lapses at once instead of being shown, through the same {@link transition} every
 * other lapse takes.
 */
export async function markProposalVisible(
  tx: DbTx,
  services: AppServices,
  after: AfterCommit,
  meetup: MeetupRow,
  at?: Date,
): Promise<MeetupRow> {
  const now = at ?? services.clock.now();
  if (meetup.status !== 'proposed' || meetup.proposalVisibleAt !== null) {
    return meetup;
  }
  const recipientDeadline = new Date(
    Math.min(now.getTime() + RECIPIENT_DEADLINE_HOURS * HOUR_MS, meetup.startsAt.getTime()),
  );
  if (recipientDeadline.getTime() <= now.getTime()) {
    return transition(tx, services, after, meetup, { type: 'lapse', at: now });
  }
  const updated = await tx.meetup.update({
    where: { id: meetup.id },
    data: { proposalVisibleAt: now, recipientDeadline },
  });
  await notify(tx, updated.recipientId, 'proposal_received', { meetupId: updated.id });
  await emit(
    tx,
    services,
    'proposal_sent',
    updated.initiatorId,
    funnelFields(updated, await venueCityId(tx, updated.venueId)),
  );
  after(() => scheduleLapse(services, updated.id, recipientDeadline));
  return updated;
}

/** The three outcomes one hold attempt can reach, taken from the deposit's own lifecycle. */
export type HoldOutcomeKind = Extract<DepositStatus, 'held' | 'requires_action' | 'failed'>;

/**
 * One hold attempt's outcome, as `payments/operations.ts` (the inline holds and the sweeper's replays) and
 * `payments/webhook.ts` report it. The attempt and the PaymentIntent it concerns travel with the outcome, because a
 * deposit can have had several attempts and the money decision is made per attempt, never per deposit.
 */
export interface HoldOutcomeInput {
  /** The deposit the attempt belongs to. */
  readonly depositId: string;
  /** The hold attempt the outcome concerns, from 1. */
  readonly attempt: number;
  /** The attempt's PaymentIntent, or null while its create is still ambiguous. */
  readonly paymentIntentId: string | null;
  /** What the attempt reached. */
  readonly outcome: HoldOutcomeKind;
  /** The authorization's capture deadline, recorded when the hold becomes `held`. */
  readonly captureBefore?: Date | null;
  /** Who reported the outcome, logged as the trigger of any transition it causes. */
  readonly source: MeetupEventSource;
}

/** What {@link applyHoldOutcome} did, so its callers can log and respond without a second read. */
export type HoldOutcomeEffect =
  'locked' | 'visible' | 'lapsed' | 'updated' | 'released_orphan' | 'ignored';

/** {@link applyHoldOutcome}'s result: the meetup and deposit as this transaction leaves them. */
export interface HoldOutcomeResult {
  /** The meetup, after any transition the outcome caused. */
  readonly meetup: MeetupRow;
  /** The deposit, after its one forward-only move. */
  readonly deposit: Deposit;
  /** What the outcome did, one of {@link HoldOutcomeEffect}. */
  readonly effect: HoldOutcomeEffect;
}

/**
 * Apply one hold attempt's outcome, with the late and orphan authorization rules.
 *
 * The deposit moves forward only: a repeated or historical outcome leaves it where it is and is answered `ignored`,
 * so Stripe's at-least-once delivery changes nothing twice. The four decisions, in the order they are taken:
 *
 * 1. **A superseded attempt** decides no meetup. If it still holds an authorization that no release or capture
 *    covers, that authorization is released on the spot (`released_orphan`); anything else about it is history and is
 *    ignored.
 * 2. **A meetup that already reached a final status** is never moved back to `locked`: an authorization that arrives
 *    after the money decision — a 3-D Secure step completed after a decline, a lapse or a cancellation — is released
 *    and its deposit marked `released` (`released_orphan`), so nothing is left outstanding at the processor.
 * 3. **A `held` outcome** moves the deposit and then decides the meetup: the initiator's hold on an invisible
 *    proposal makes it visible (or lapses it when the start has passed), and the recipient's hold on a visible
 *    proposal locks the meetup when the initiator's hold is `held` and the deadline has not passed — otherwise the
 *    proposal lapses and this hold is released.
 * 4. **A `requires_action` or `failed` outcome** moves the deposit alone.
 *
 * The status frame is published after the commit for every outcome except an ignored one; when the meetup itself
 * transitioned, {@link transition} publishes it.
 *
 * @throws Error when the named deposit or its meetup does not exist, which is a caller bug: both are resolved from
 *   the PaymentIntent through a durable `PaymentOperation` first.
 */
export async function applyHoldOutcome(
  tx: DbTx,
  services: AppServices,
  after: AfterCommit,
  input: HoldOutcomeInput,
): Promise<HoldOutcomeResult> {
  const located = await tx.deposit.findUnique({ where: { id: input.depositId } });
  if (located === null) {
    throw new Error(`applyHoldOutcome: no deposit ${input.depositId}`);
  }
  const meetup = await lockMeetup(tx, located.meetupId);
  if (meetup === null) {
    throw new Error(`applyHoldOutcome: no meetup ${located.meetupId}`);
  }
  const deposit = await tx.deposit.findUniqueOrThrow({ where: { id: located.id } });
  const now = services.clock.now();
  if (input.attempt !== deposit.currentAttempt) {
    if (input.outcome !== 'held' || (await hasCaptureOrRelease(tx, deposit.id, input.attempt))) {
      return { meetup, deposit, effect: 'ignored' };
    }
    await planRelease(
      tx,
      { deposit, attempt: input.attempt, paymentIntentId: input.paymentIntentId },
      now,
    );
    return { meetup, deposit, effect: 'released_orphan' };
  }
  if (isFinalMeetupStatus(meetup.status) && input.outcome === 'held') {
    if (await hasCaptureOrRelease(tx, deposit.id, input.attempt)) {
      return { meetup, deposit, effect: 'ignored' };
    }
    await planRelease(
      tx,
      { deposit, attempt: input.attempt, paymentIntentId: input.paymentIntentId },
      now,
    );
    await advanceDeposit(tx, { depositId: deposit.id, attempt: input.attempt }, 'released');
    const released = await tx.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
    publishStatusFrame(after, services, meetup, await depositsForMeetup(tx, meetup.id));
    return { meetup, deposit: released, effect: 'released_orphan' };
  }
  const moved = await advanceDeposit(
    tx,
    { depositId: deposit.id, attempt: input.attempt },
    input.outcome,
    advanceData(input),
  );
  if (!moved) {
    return { meetup, deposit, effect: 'ignored' };
  }
  const advanced = await tx.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
  if (input.outcome === 'held') {
    if (
      advanced.role === 'initiator' &&
      meetup.status === 'proposed' &&
      meetup.proposalVisibleAt === null
    ) {
      const visible = await markProposalVisible(tx, services, after, meetup);
      if (visible.status === 'lapsed') {
        // The immediate lapse ran `transition`, which published the frame itself.
        return { meetup: visible, deposit: advanced, effect: 'lapsed' };
      }
      publishStatusFrame(after, services, visible, await depositsForMeetup(tx, visible.id));
      return { meetup: visible, deposit: advanced, effect: 'visible' };
    }
    if (advanced.role === 'recipient' && meetup.status === 'proposed') {
      const deadline = meetup.recipientDeadline;
      if (deadline !== null && now.getTime() >= deadline.getTime()) {
        // The card was authenticated after the deadline: the proposal lapses, and this hold is
        // released with it rather than locking a meetup nobody can still accept (AAP 0.5.3).
        const lapsed = await transition(tx, services, after, meetup, {
          type: 'lapse',
          at: now,
          source: input.source,
        });
        return { meetup: lapsed, deposit: advanced, effect: 'lapsed' };
      }
      if (await initiatorHoldIsHeld(tx, meetup.id)) {
        const locked = await transition(tx, services, after, meetup, {
          type: 'recipient_hold_held',
          at: now,
          source: input.source,
        });
        return { meetup: locked, deposit: advanced, effect: 'locked' };
      }
      // The initiator's own attempt failed or is being recovered, so there is nothing to lock
      // against; the recipient's authorization stands and the proposal stays visible.
      services.logger.info({ event: 'recipient_hold_without_initiator_hold', meetupId: meetup.id });
    } else {
      // A hold that can change nothing: the proposal is already visible, or the meetup is already
      // locked. The deposit moved and the frame below tells the clients to refetch.
      services.logger.info({
        event: 'hold_outcome_without_transition',
        meetupId: meetup.id,
        status: meetup.status,
        role: advanced.role,
      });
    }
  }
  publishStatusFrame(after, services, meetup, await depositsForMeetup(tx, meetup.id));
  return { meetup, deposit: advanced, effect: 'updated' };
}

/**
 * The fields a hold outcome records on the way: the attempt's PaymentIntent, and on a hold the authorization's
 * capture deadline. A null intent and a null deadline are left out rather than written, so an update never clears a
 * value the outcome did not name.
 */
function advanceData(input: HoldOutcomeInput): {
  readonly currentPaymentIntentId?: string;
  readonly captureBefore?: Date;
} {
  const { captureBefore } = input;
  return {
    ...(input.paymentIntentId === null ? {} : { currentPaymentIntentId: input.paymentIntentId }),
    ...(captureBefore === null || captureBefore === undefined ? {} : { captureBefore }),
  };
}

/** Whether the meetup's initiator currently holds a `held` deposit (AAP 0.5.3). */
async function initiatorHoldIsHeld(tx: DbTx, meetupId: string): Promise<boolean> {
  const deposits = await depositsForMeetup(tx, meetupId);
  return deposits.some((deposit) => deposit.role === 'initiator' && deposit.status === 'held');
}

/**
 * Record the recipient's first read of a proposal: the state-writing half of `GET /meetups/:id`, called with the row
 * read under {@link lockMeetup}. The mark is one conditional update — `WHERE recipient_viewed_at IS NULL` — so two
 * racing first reads emit `proposal_viewed` once, and the second one reports `false` rather than writing a second
 * instant.
 */
export async function markRecipientViewed(
  tx: DbTx,
  services: AppServices,
  meetup: MeetupRow,
  viewerId: string,
  at: Date,
): Promise<boolean> {
  if (participantRole(meetup, viewerId) !== 'recipient') {
    return false;
  }
  if (meetup.proposalVisibleAt === null || meetup.recipientViewedAt !== null) {
    return false;
  }
  const viewed = await tx.meetup.updateMany({
    where: { id: meetup.id, recipientViewedAt: null },
    data: { recipientViewedAt: at },
  });
  if (viewed.count !== 1) {
    return false;
  }
  await emit(
    tx,
    services,
    'proposal_viewed',
    viewerId,
    funnelFields(meetup, await venueCityId(tx, meetup.venueId)),
  );
  return true;
}

/**
 * Publish the shared `MeetupStatusFrame` after the commit, to each participant who can see the meetup
 * (AAP 0.5.3, 0.5.4). The frame carries exactly what `MeetupDto.initiatorHold` and `.recipientHold` carry, so a
 * client treats it as a signal to refetch `GET /meetups/:id` rather than as the authority on the meetup, and a
 * recipient who cannot see the proposal yet is not sent one at all.
 *
 * The delivery is registered through `after`, never performed here: `publishUser` reaches Redis, and no Redis
 * call belongs inside a domain transaction. It never throws, and a failure inside the callback is logged by
 * `transact` (AAP 0.3.2).
 */
function publishStatusFrame(
  after: AfterCommit,
  services: AppServices,
  meetup: MeetupRow,
  deposits: readonly Deposit[],
): void {
  const initiator = deposits.find((deposit) => deposit.role === 'initiator') ?? null;
  const recipient = deposits.find((deposit) => deposit.role === 'recipient') ?? null;
  const frame: MeetupStatusFrame = {
    type: 'meetup_status',
    meetupId: meetup.id,
    status: meetup.status,
    initiatorHold: holdView(initiator),
    recipientHold: holdView(recipient),
  };
  after(async () => {
    for (const userId of participantIds(meetup)) {
      if (!isVisibleTo(meetup, userId)) {
        continue;
      }
      await services.pubsub.publishUser(userId, frame);
    }
  });
}

/** Compile-time exhaustiveness: a new {@link MeetupEvent} variant fails the build here. */
function assertNever(event: never): never {
  throw new Error(`unhandled meetup event ${JSON.stringify(event)}`);
}
