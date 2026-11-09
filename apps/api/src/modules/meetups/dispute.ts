/**
 * Filing a dispute on a meetup: the `POST /meetups/:id/dispute` handler.
 *
 * A dispute is the pair's way to say that a locked meetup did not happen as proposed — most often that the venue could not
 * witness a check-in. Filing changes **no** meetup status: the meetup stays `locked`, so both attendees can still check in
 * inside the window, while the open `Dispute` row gates the settlement that would otherwise run at `startsAt + 45 min`. It is
 * the operator's resolution that ends the meetup — `settle_by_checkins` or, for a venue that could not witness, the
 * penalty-free `no_fault` — and that resolution lives in `admin/disputes.ts`, never here. The two automatic resolutions are the
 * same: a block closes an open dispute with the note `cancelled_by_block` and a lost hold with `hold_expired`.
 *
 * What this file owns is the filing itself: the guards in the order the contract lists them, the `Dispute` row with its
 * `deadlineAt`, the counterpart's notification, the `dispute_opened` event and the escalation timer that flags the dispute in
 * `/ops` a day before the operator's deadline. The 60-second sweeper is the backstop should that timer never arrive.
 *
 * Everything but the timer is written in one transaction; the timer — the one Redis call — is registered through `after`, so no
 * transaction holds a lock across a queue write. The reason text is never logged, rendered into an event or echoed anywhere but
 * the row it belongs to: the log line carries the meetup, the dispute and its kind alone.
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
 * The statuses a dispute may be filed on.
 *
 * A `proposed` meetup is not one of them: nothing has been committed yet, so the route answers `409 not_locked`. The settled
 * outcomes are, because the filing window runs to `startsAt + 24 h` and settlement happens at `startsAt + 45 min`: a dispute
 * filed after settlement reviews what was already applied.
 */
const FILABLE_STATUSES: ReadonlySet<MeetupStatus> = new Set<MeetupStatus>([
  'locked',
  'completed',
  'forfeited',
  'unattended',
]);

/**
 * File a dispute on a meetup the caller is part of.
 *
 * One transaction, with the account-deletion write fence, the meetup row lock, and the checks in the order the route's contract
 * lists them, so a caller who is refused for two reasons always receives the first of them:
 *
 *  1. `404 meetup_not_found` — no meetup has that id.
 *  2. `403 not_participant` — the caller is not in the meetup, or is its recipient while the proposal is still invisible to
 *     them, which keeps the route from confirming a proposal the recipient has not been shown.
 *  3. `409 dispute_window_closed` — `now` is later than `startsAt + 24 h`. Filing is allowed **up to and including** that
 *     instant.
 *  4. `409 not_locked` — the status is not one of {@link FILABLE_STATUSES}.
 *  5. `409 dispute_open` — a dispute is already open on the meetup. The pre-check covers every case but a race; the partial
 *     unique index `("meetup_id") WHERE status = 'open'` (`dispute_open_key`) is the authority, and a violation of it is
 *     answered with the same code.
 *
 * On success it writes the dispute, requests the counterpart's notification and records the `dispute_opened` event in the same
 * transaction, then — after the commit — schedules the `dispute-escalate-<disputeId>` job at the dispute's own deadline.
 *
 * `@throws AppError one of the five codes above.
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

/** The instant a dispute stops being filable: `startsAt + DISPUTE_FILING_WINDOW_HOURS`, stated once, because at that instant a
 * filing is still accepted and one millisecond later the route answers `409 dispute_window_closed`. */
function filingClosesAt(meetup: MeetupRow): Date {
  return new Date(meetup.startsAt.getTime() + DISPUTE_FILING_WINDOW_HOURS * HOUR_MS);
}

/**
 * Insert the dispute and answer its id, mapping the one collision that can happen under a race.
 *
 * Two filings arriving together both pass {@link openDisputeId}; the partial unique index then refuses the second insert, and
 * that refusal is answered as the same `409 dispute_open` the pre-check answers. Any other failure propagates unchanged.
 *
 * `@throws AppError dispute_open` when the index refuses the insert.
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

async function openDisputeId(tx: DbTx, meetupId: string): Promise<string | null> {
  const open = await tx.dispute.findFirst({
    where: { meetupId, status: 'open' },
    select: { id: true },
  });
  return open?.id ?? null;
}

/** The participant who is not the caller: the counterpart the notification is addressed to, read off the role
 * {@link participantRole} answered rather than by comparing ids, so a caller is never notified about their own filing. */
function counterpartOf(meetup: MeetupRow, role: ParticipantRole): string {
  return role === 'initiator' ? meetup.recipientId : meetup.initiatorId;
}

async function venueCityId(tx: DbTx, venueId: string): Promise<string | undefined> {
  const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { cityId: true } });
  return venue?.cityId;
}
