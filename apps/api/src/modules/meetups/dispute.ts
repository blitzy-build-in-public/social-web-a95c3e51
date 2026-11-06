/**
 * Filing a dispute on a meetup: the `POST /meetups/:id/dispute` handler (AAP 0.5.1, 0.5.3, 0.5.4).
 *
 * A dispute is the pair's way to say that a locked meetup did not happen as proposed — most often
 * that the venue could not witness a check-in. Filing changes **no** meetup status: the meetup stays
 * `locked`, so both attendees can still check in inside the window, while the open `Dispute` row
 * gates the settlement that would otherwise run at `startsAt + 45 min` (AAP 0.5.3). It is the
 * operator's resolution that ends the meetup — `settle_by_checkins` or, for a venue that could not
 * witness, the penalty-free `no_fault` — and that resolution lives in `admin/disputes.ts`, never
 * here. The same applies to the two automatic resolutions: a block closes an open dispute with the
 * note `cancelled_by_block` and a lost hold with `hold_expired`, both in the transaction that ends
 * the meetup (`meetups/state-machine.ts`).
 *
 * What this file owns is the filing itself: the guards in the order AAP 0.5.4 lists them, the
 * `Dispute` row with its `deadlineAt`, the counterpart's notification, the `dispute_opened` event
 * and the escalation timer that flags the dispute in `/ops` a day before the operator's deadline
 * (AAP 0.12.2 "Operator MUST resolve a dispute within 5 days"). The 60-second sweeper in
 * `settlement/sweeper.ts` is the backstop should that timer never arrive.
 *
 * Everything but the timer is written in one transaction: the row, the notification outbox row and
 * the analytics row commit together or not at all, and the timer — the one Redis call — is
 * registered through `after`, so no transaction holds a lock across a queue write (AAP 0.3.2).
 *
 * The reason text is never logged, rendered into an event or echoed anywhere but the row it belongs
 * to: the log line carries the meetup, the dispute and its kind alone (AAP 0.11.1, 0.12.2).
 *
 * @see AAP 0.5.3 for the dispute lifecycle, the filing window and the settlement it gates; 0.5.4 for
 *   the route, its error order and the optional `kind` that marks `venue_unavailable`; 0.5.2 for the
 *   row and the partial unique index that keeps one dispute open per meetup; 0.5.6 for the
 *   escalation job; 0.8.1 for this file.
 */

import {
  DAY_MS,
  DISPUTE_FILING_WINDOW_HOURS,
  DISPUTE_RESOLUTION_DAYS,
  HOUR_MS,
} from '@tablemate/shared';
import type {
  DisputeRequest,
  DisputeResponse,
  MeetupStatus,
  ParticipantRole,
} from '@tablemate/shared';
import { isUniqueViolation } from '@tablemate/db';
import type { DbTx } from '@tablemate/db';

import { AppError } from '../../plugins/errors.ts';
import { emit } from '../analytics/emit.ts';
import { notify } from '../notifications/enqueue.ts';
import { transact } from '../outbox/write.ts';
import { scheduleDisputeEscalation } from '../settlement/timers.ts';

import { isVisibleTo, participantRole } from './queries.ts';
import type { MeetupRow } from './queries.ts';
import { lockMeetup } from './state-machine.ts';

import type { AppServices } from '../../app.ts';

/**
 * The statuses a dispute may be filed on (AAP 0.5.3).
 *
 * A `proposed` meetup is not one of them: nothing has been committed yet, so there is nothing to
 * dispute and the route answers `409 not_locked`. The settled outcomes are, because the filing
 * window runs to `startsAt + 24 h` and settlement happens at `startsAt + 45 min`: a dispute filed
 * after settlement reviews what was already applied — `no_fault` on a `forfeited` meetup reverses
 * the forfeit, while a `completed` or `unattended` one can only be resolved
 * `settle_by_checkins`, which changes nothing.
 */
const FILABLE_STATUSES: ReadonlySet<MeetupStatus> = new Set<MeetupStatus>([
  'locked',
  'completed',
  'forfeited',
  'unattended',
]);

/**
 * File a dispute on a meetup the caller is part of (AAP 0.5.4 `POST /meetups/:id/dispute`).
 *
 * One transaction, with the account-deletion write fence, the meetup row lock, and the checks in
 * the order the route's contract lists them, so a caller who is refused for two reasons always
 * receives the first of them:
 *
 *  1. `404 meetup_not_found` — no meetup has that id.
 *  2. `403 not_participant` — the caller is not in the meetup, or is its recipient while the
 *     proposal is still invisible to them, which is what keeps the route from confirming a proposal
 *     the recipient has not been shown (AAP 0.5.3).
 *  3. `409 dispute_window_closed` — `now` is later than `startsAt + 24 h`. Filing is allowed **up
 *     to and including** that instant.
 *  4. `409 not_locked` — the status is not one of {@link FILABLE_STATUSES}, which is what answers
 *     `409 not_locked` for a meetup that is still `proposed`.
 *  5. `409 dispute_open` — a dispute is already open on the meetup. The pre-check covers every case
 *     but a race; the partial unique index `("meetup_id") WHERE status = 'open'` (`dispute_open_key`)
 *     is the authority, and a violation of it is answered with the same code.
 *
 * On success it writes the dispute, requests the counterpart's notification and records the
 * `dispute_opened` event in the same transaction, then — after the commit — schedules the
 * `dispute-escalate-<disputeId>` job at the dispute's own deadline, which is where
 * `settlement/timers.ts` subtracts the day that flags it in `/ops`.
 *
 * @param services - The app's services: the guarded client, the injected clock, the logger, the
 *   outbox dispatcher and the `settlement` queue the escalation timer is scheduled on.
 * @param userId - The authenticated caller, who becomes the dispute's `filedById`.
 * @param meetupId - The meetup as the route's path parameter.
 * @param body - The validated {@link DisputeRequest}: the reason, and the `kind` that marks a
 *   `venue_unavailable` case (defaulting to `other`).
 * @param now - The instant the filing is judged at, from the injected clock, so the window and the
 *   deadline are decided by the same reading and a test that advances the clock moves both.
 * @returns The new dispute's id, which the route answers `201` with.
 * @throws AppError one of the five codes above.
 * @see AAP 0.5.3 for the transitions a resolution then takes, 0.5.4 for the route and its errors,
 *   0.5.7 for the metrics these rows feed.
 */
export async function fileDispute(
  services: AppServices,
  userId: string,
  meetupId: string,
  body: DisputeRequest,
  now: Date,
): Promise<DisputeResponse> {
  const filed = await transact(
    services,
    async (tx, after) => {
      const meetup = await lockMeetup(tx, meetupId);
      if (meetup === null) {
        throw new AppError('meetup_not_found');
      }

      const role = participantRole(meetup, userId);
      if (role === null || !isVisibleTo(meetup, userId)) {
        throw new AppError('not_participant');
      }

      if (now.getTime() > filingClosesAt(meetup).getTime()) {
        throw new AppError('dispute_window_closed');
      }

      if (!FILABLE_STATUSES.has(meetup.status)) {
        throw new AppError('not_locked');
      }

      if ((await openDisputeId(tx, meetup.id)) !== null) {
        throw new AppError('dispute_open');
      }

      const deadlineAt = new Date(now.getTime() + DISPUTE_RESOLUTION_DAYS * DAY_MS);
      const disputeId = await insertDispute(tx, meetup.id, userId, body, now, deadlineAt);

      await notify(tx, counterpartOf(meetup, role), 'dispute_opened', {
        meetupId: meetup.id,
        disputeId,
      });

      // The city is the venue's, read once for the event's column; a venue that is somehow absent
      // leaves the column null rather than failing a filing the operator needs (AAP 0.5.7).
      const cityId = await venueCityId(tx, meetup.venueId);
      await emit(tx, services, 'dispute_opened', userId, {
        meetupId: meetup.id,
        ...(cityId === undefined ? {} : { cityId }),
      });

      // Post-commit, and after the commit that makes the dispute durable: the escalation job names a
      // row that exists, and no Redis call runs while the meetup row is locked (AAP 0.3.2).
      after(async () => {
        await scheduleDisputeEscalation(services, disputeId, deadlineAt);
      });

      return { disputeId, kind: body.kind };
    },
    { fenceUserId: userId },
  );

  // Logged after the commit, and with the kind alone: the reason text, the booking-like details a
  // person may have written into it and the counterpart's identity never reach a log line.
  services.logger.info(
    {
      event: 'dispute_opened',
      meetupId,
      disputeId: filed.disputeId,
      kind: filed.kind,
    },
    'dispute_opened',
  );

  return { disputeId: filed.disputeId };
}

// ---------------------------------------------------------------------------------------------
// The filing's helpers (AAP 0.5.2, 0.5.3)
// ---------------------------------------------------------------------------------------------

/**
 * The instant a dispute stops being filable: `startsAt + DISPUTE_FILING_WINDOW_HOURS` (AAP 0.5.3).
 *
 * Named so the boundary is stated once: at that instant a filing is still accepted, one millisecond
 * later the route answers `409 dispute_window_closed`.
 */
function filingClosesAt(meetup: MeetupRow): Date {
  return new Date(meetup.startsAt.getTime() + DISPUTE_FILING_WINDOW_HOURS * HOUR_MS);
}

/**
 * Insert the dispute and answer its id, mapping the one collision that can happen under a race
 * (AAP 0.5.2).
 *
 * Two filings arriving together both pass {@link openDisputeId}; the partial unique index
 * `("meetup_id") WHERE status = 'open'` then refuses the second insert, and that refusal is answered
 * as the same `409 dispute_open` the pre-check answers. Any other failure propagates unchanged and
 * rolls the transaction back.
 *
 * @param tx - The filing transaction, holding the meetup row lock.
 * @param meetupId - The meetup the dispute belongs to.
 * @param userId - The filing participant.
 * @param body - The validated reason and kind.
 * @param openedAt - The instant of filing, from the injected clock.
 * @param deadlineAt - The operator's deadline, `openedAt + 5 days`.
 * @returns The new dispute's id.
 * @throws AppError `dispute_open` when the index refuses the insert.
 */
async function insertDispute(
  tx: DbTx,
  meetupId: string,
  userId: string,
  body: DisputeRequest,
  openedAt: Date,
  deadlineAt: Date,
): Promise<string> {
  try {
    const dispute = await tx.dispute.create({
      data: {
        meetupId,
        filedById: userId,
        kind: body.kind,
        reason: body.reason,
        status: 'open',
        openedAt,
        deadlineAt,
      },
      select: { id: true },
    });

    return dispute.id;
  } catch (error) {
    if (isUniqueViolation(error, 'dispute_open_key')) {
      throw new AppError('dispute_open');
    }
    throw error;
  }
}

/** The id of the meetup's open dispute, or null when it holds none (AAP 0.5.2). */
async function openDisputeId(tx: DbTx, meetupId: string): Promise<string | null> {
  const open = await tx.dispute.findFirst({
    where: { meetupId, status: 'open' },
    select: { id: true },
  });

  return open?.id ?? null;
}

/**
 * The participant who is not the caller: the counterpart the notification is addressed to (AAP 0.5.3).
 *
 * Read off the role {@link participantRole} answered rather than by comparing ids, so the two agree
 * on the case-insensitive comparison that function makes and a caller is never notified about their
 * own filing.
 */
function counterpartOf(meetup: MeetupRow, role: ParticipantRole): string {
  return role === 'initiator' ? meetup.recipientId : meetup.initiatorId;
}

/**
 * The venue's city slug, for the analytics row's column (AAP 0.5.7).
 *
 * @param tx - The filing transaction.
 * @param venueId - The meetup's venue.
 * @returns The city slug, or `undefined` for a venue that is not there.
 */
async function venueCityId(tx: DbTx, venueId: string): Promise<string | undefined> {
  const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { cityId: true } });

  return venue?.cityId;
}
