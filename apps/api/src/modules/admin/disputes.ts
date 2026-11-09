/**
 * The operator dispute queue and one operator's resolution of a dispute in it (AAP 0.5.1
 * `admin/disputes.ts`, 0.5.4 `GET /admin/disputes` and `POST /admin/disputes/:id/resolve`, 0.5.3
 * "Dispute lifecycle").
 *
 * {@link listDisputes} answers what an operator has to act on — every open dispute, nearest deadline
 * first, and behind them the resolved ones newest first — and {@link resolveDispute} is the only
 * place a dispute becomes `resolved` with an outcome, through the table of {@link resolutionPlan}.
 *
 * Three properties the money decision rests on: the meetup row lock comes first, so two operators
 * resolving one dispute, and an operator racing a settlement or a hold loss, are serialized and the
 * second sees the first one's result; no provider call runs inside the transaction, so a failure to
 * reach the provider after the commit is not the operator's error and the 60-second sweeper resumes
 * it (AAP 0.3.2); and an account deletion waiting on this dispute is unblocked here, because a
 * resolution is the instant such an account can finally be erased (AAP 0.5.3).
 *
 * No log line carries the filer's free text, and none carries a handle (AAP 0.11.1). Time arrives as
 * the `now` argument and never from a clock of this file's own.
 */

import { Prisma, type DbTx } from '@tablemate/db';
import type { Dispute } from '@tablemate/db';
import { DisputeOutcome } from '@tablemate/shared';
import type {
  AdminDisputeDto,
  AdminDisputesResponse,
  CheckInResult,
  DisputeKind,
  DisputeStatus,
  MeetupStatus,
  ParticipantRole,
  ResolveDispute,
} from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { emit } from '../analytics/emit.ts';
import { writeAccountErasure } from '../me/deletion.ts';
import { lockMeetup, transition } from '../meetups/state-machine.ts';
import type { MeetupRow } from '../meetups/queries.ts';
import { notifyAll } from '../notifications/enqueue.ts';
import { transact } from '../outbox/write.ts';
import {
  depositsForMeetup,
  fenceCaptures,
  findHoldOperation,
  planRelease,
  planReversal,
} from '../payments/holds.ts';
import { runOperationsFor } from '../payments/operations.ts';
import { otherRole } from '../settlement/outcomes.ts';
import { settleMeetup } from '../settlement/settle.ts';
import { settleDueAt } from '../settlement/timers.ts';

import type { AppServices } from '../../app.ts';

/**
 * An implementation choice, not a contract value: AAP 0.5.4 declares no cursor for
 * `GET /admin/disputes` and fixes no page size, and the operator's work is the open queue — the
 * open disputes are always returned in full, because they are the ones an operator must act on
 * within `deadlineAt`. A bound is still needed so one page stays bounded as the pilot runs, and the
 * resolved disputes are only there as context, so the newest fifty are enough to show how the last
 * dispute on a meetup ended. An operator who needs an older resolution reads the row in the
 * database.
 */
export const ADMIN_RESOLVED_DISPUTES_LIMIT = 50;

/** The one log line a resolution writes (AAP 0.11.1). */
const DISPUTE_RESOLVED = 'dispute_resolved';

/** The one log line a settlement that could not run yet writes (AAP 0.3.2). */
const DISPUTE_SETTLE_DEFERRED = 'dispute_settle_deferred';

/**
 * One row as {@link disputeSource} returns it: the columns of `Dispute`, the venue it concerns and
 * the two participants' handles and check-in results.
 *
 */
export interface DisputeQueueRow {
  readonly id: string;
  readonly meetupId: string;
  readonly cityId: string;
  readonly venueName: string;
  readonly kind: DisputeKind;
  /** The filer's free text, empty once the 180-day purge has taken it (AAP 0.5.2). */
  readonly reason: string;
  readonly status: DisputeStatus;
  /** When it was filed, `deadlineAt = openedAt + 5 days` (AAP 0.5.3). */
  readonly openedAt: Date;
  readonly deadlineAt: Date;
  /** Whether it is open and past its deadline, or already flagged by the escalation job. */
  readonly overdue: boolean;
  /** The initiator's handle, null once that account was erased (AAP 0.5.2). */
  readonly initiatorHandle: string | null;
  /** The recipient's handle, null once that account was erased (AAP 0.5.2). */
  readonly recipientHandle: string | null;
  readonly initiatorCheckIn: CheckInResult | null;
  readonly recipientCheckIn: CheckInResult | null;
}

/**
 * One queue row as the operator contract carries it (AAP 0.5.4), field by field and never spread, so
 * a column added to `Dispute`, `Meetup`, `Venue`, `User` or `CheckIn` cannot reach an operator
 * without a change here.
 *
 * Two readings are decided here:
 *
 *  - `reason` is reported as null for an emptied text. `Dispute.reason` is `NOT NULL`, so the
 *    180-day purge of AAP 0.5.2 empties it rather than nulling it, and the nullable DTO field is
 *    what "the purge removed the text" means — the reading `admin/reports.ts` gives the same
 *    column.
 *  - `checkIns` carries the two participants in a fixed order, the initiator's entry first, because
 *    the shared schema fixes an array rather than a keyed pair and a stable order is what lets the
 *    console render the pair without a second read.
 */
export function toAdminDisputeDto(row: DisputeQueueRow): AdminDisputeDto {
  return {
    id: row.id,
    meetupId: row.meetupId,
    cityId: row.cityId,
    venueName: row.venueName,
    kind: row.kind,
    reason: row.reason === '' ? null : row.reason,
    status: row.status,
    openedAt: row.openedAt.toISOString(),
    deadlineAt: row.deadlineAt.toISOString(),
    overdue: row.overdue,
    checkIns: [
      { handle: row.initiatorHandle, result: row.initiatorCheckIn },
      { handle: row.recipientHandle, result: row.recipientCheckIn },
    ],
  };
}

/**
 * One participant's check-in result for the dispute's meetup (AAP 0.5.4): `pass` when that
 * participant holds a passing check-in, `fail` when their check-ins only ever failed, and null when
 * they never checked in.
 *
 * A `check_in` row with `pass` is the venue's witness, which is exactly what a `settle_by_checkins`
 * resolution decides on, so the three-valued answer is what the operator needs: absent is not the
 * same as failed, and `bool_or` over the participant's own rows reads both without a join that would
 * multiply the dispute row.
 *
 * The participant's column is named from a code constant, never from caller input, so it is
 * interpolated as an identifier rather than bound as a parameter (AAP 0.11.2).
 */
function checkInResult(role: ParticipantRole): Prisma.Sql {
  const participant = Prisma.raw(
    role === 'initiator' ? '"m"."initiator_id"' : '"m"."recipient_id"',
  );
  return Prisma.sql`(
      SELECT CASE WHEN bool_or("ci"."result" = 'pass') THEN 'pass'
                  WHEN bool_or("ci"."result" = 'fail') THEN 'fail'
                  ELSE NULL END
        FROM "check_in" "ci"
       WHERE "ci"."meetup_id" = "m"."id"
         AND "ci"."user_id" = ${participant}
    )`;
}

/**
 * The one statement's source, shared by the queue read and the single-dispute read: the row columns
 * of {@link DisputeQueueRow}, over the dispute joined to its meetup and that meetup's venue, with a
 * `LEFT JOIN` per participant for the handle a tombstone no longer has (AAP 0.5.2).
 *
 * `overdue` is computed here rather than in the caller, from the same reading of `now` the whole
 * caller uses: an open dispute is overdue once its deadline has passed, and a dispute the
 * `dispute-escalate-<disputeId>` job has flagged stays flagged even before the deadline, which is
 * the banner AAP 0.12.2 asks for. `now` binds as a parameter cast to `timestamptz`.
 *
 * No column is selected that the DTO does not carry, and `reason` is read only to be mapped — never
 * logged (AAP 0.11.1).
 */
function disputeSource(now: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT
      "d"."id" AS "id",
      "d"."meetup_id" AS "meetupId",
      "v"."city_id" AS "cityId",
      "v"."name" AS "venueName",
      "d"."kind" AS "kind",
      "d"."reason" AS "reason",
      "d"."status" AS "status",
      "d"."opened_at" AS "openedAt",
      "d"."deadline_at" AS "deadlineAt",
      ("d"."status" = 'open'
        AND (${now}::timestamptz > "d"."deadline_at" OR "d"."escalated_at" IS NOT NULL)) AS "overdue",
      "ui"."handle" AS "initiatorHandle",
      "ur"."handle" AS "recipientHandle",
      ${checkInResult('initiator')} AS "initiatorCheckIn",
      ${checkInResult('recipient')} AS "recipientCheckIn"
    FROM "dispute" "d"
    JOIN "meetup" "m" ON "m"."id" = "d"."meetup_id"
    JOIN "venue" "v" ON "v"."id" = "m"."venue_id"
    LEFT JOIN "user" "ui" ON "ui"."id" = "m"."initiator_id"
    LEFT JOIN "user" "ur" ON "ur"."id" = "m"."recipient_id"
  `;
}

/**
 * The operator's dispute queue (AAP 0.5.4 `GET /admin/disputes`): every open dispute, nearest
 * deadline first, followed by the {@link ADMIN_RESOLVED_DISPUTES_LIMIT} most recently resolved ones,
 * newest resolution first.
 *
 * One statement and one round trip: the resolved bound is a subquery of the same statement rather
 * than a second read, so the two groups cannot be torn apart by a resolution landing between them.
 * The ordering is total — the open group by `deadline_at` ascending, the resolved group by
 * `resolved_at` descending with its id as the tie-break, because ids are UUIDv7 and therefore
 * time-ordered — so the same queue is returned in the same order on every read.
 *
 * Read-only: no transaction, no row lock, and not one of the state-writing reads, so the
 * account-deletion write fence does not apply (AAP 0.5.3). `now` decides `overdue` alone and binds
 * as a parameter, so a test can cross a deadline by moving the clock (AAP 0.11.1).
 */
export async function listDisputes(
  services: AppServices,
  now: Date,
): Promise<AdminDisputesResponse> {
  const rows = await services.db.$queryRaw<DisputeQueueRow[]>(Prisma.sql`
    ${disputeSource(now)}
    WHERE "d"."status" = 'open'
       OR "d"."id" IN (
         SELECT "r"."id"
           FROM "dispute" "r"
          WHERE "r"."status" = 'resolved'
          ORDER BY "r"."resolved_at" DESC NULLS LAST, "r"."id" DESC
          LIMIT ${ADMIN_RESOLVED_DISPUTES_LIMIT}::int
       )
    ORDER BY ("d"."status" = 'resolved'),
             CASE WHEN "d"."status" = 'open' THEN "d"."deadline_at" END ASC,
             "d"."resolved_at" DESC
  `);
  return { items: rows.map((row: DisputeQueueRow) => toAdminDisputeDto(row)) };
}

async function findDisputeRow(
  services: AppServices,
  disputeId: string,
  now: Date,
): Promise<DisputeQueueRow | null> {
  const rows = await services.db.$queryRaw<DisputeQueueRow[]>(Prisma.sql`
    ${disputeSource(now)}
    WHERE "d"."id" = ${disputeId}::uuid
  `);
  return rows[0] ?? null;
}

/**
 * What one resolution does to the dispute's meetup, as the action {@link resolutionPlan} selects
 * (AAP 0.5.3).
 *
 * `close_only` closes the dispute and changes nothing else; `settle_by_checkins` closes it and has
 * the meetup settled on its check-ins — at once, or when the check-in window closes;
 * `no_fault` closes it and applies the `operator_no_fault` transition; `reverse_forfeit` closes it,
 * reverses the forfeit's money and applies that same transition; and `invalid` is the `422
 * invalid_outcome` of AAP 0.5.4.
 */
export type DisputeResolutionAction =
  'close_only' | 'settle_by_checkins' | 'no_fault' | 'reverse_forfeit' | 'invalid';
/**
 * What {@link resolutionPlan} decided, in the form {@link resolveDispute} applies (AAP 0.5.3).
 *
 * The three booleans are the plan's effects, spelled out so a caller cannot read one for another:
 * `settleNow` has the meetup settled after this transaction commits, `noFault` has it take the
 * `operator_no_fault` transition, and `reverseForfeit` has the absent party's captured deposit
 * reversed and the attendee's credit voided.
 */
export interface ResolutionPlan {
  readonly action: DisputeResolutionAction;
  /** True when the settlement runs after the commit: a `locked` meetup whose window has closed. */
  readonly settleNow: boolean;
  readonly noFault: boolean;
  /** True when a post-settlement forfeit's money is reversed (AAP 0.5.3). */
  readonly reverseForfeit: boolean;
}

/**
 * The plan of every meetup status that carries neither of the two resolutions AAP 0.5.3 gives the
 * money: `settle_by_checkins` closes the dispute and changes nothing, `no_fault` has no hold to
 * release and no capture to reverse — a `proposed`, `declined`, `lapsed`, `cancelled`, `lock_lost`
 * or `no_fault` meetup holds no settlement to undo — so it is refused with the contract's
 * `invalid_outcome`.
 */
const CLOSE_ONLY: Readonly<Record<DisputeOutcome, DisputeResolutionAction>> = {
  settle_by_checkins: 'close_only',
  no_fault: 'invalid',
};

/**
 * The resolution decision table of AAP 0.5.3, one row per meetup status and one column per outcome.
 *
 * `locked` is the open-dispute case: the meetup is still committed, so `settle_by_checkins` decides
 * its money and `no_fault` releases both holds. `forfeited` is the post-settlement case: the money
 * already moved at `startsAt + 45 min`, so `settle_by_checkins` leaves it alone and `no_fault`
 * reverses it — "the capture is fenced if not yet run, and a reversing `refund` operation depending
 * on it …; `void` Table Credit entry". Every other status takes the same close-and-change-nothing
 * path, and refuses `no_fault`.
 */
const RESOLUTION_ACTIONS: Readonly<
  Record<MeetupStatus, Readonly<Record<DisputeOutcome, DisputeResolutionAction>>>
> = {
  locked: { settle_by_checkins: 'settle_by_checkins', no_fault: 'no_fault' },
  forfeited: { settle_by_checkins: 'close_only', no_fault: 'reverse_forfeit' },
  completed: CLOSE_ONLY,
  unattended: CLOSE_ONLY,
  proposed: CLOSE_ONLY,
  declined: CLOSE_ONLY,
  lapsed: CLOSE_ONLY,
  cancelled: CLOSE_ONLY,
  lock_lost: CLOSE_ONLY,
  no_fault: CLOSE_ONLY,
};

/**
 * Pure, structural and free of I/O, so the whole table is exercised without a database. `settleDue`
 * is whether `now` has reached `settleDueAt(startsAt)`, the instant check-in closes; it changes one
 * row alone — a `locked` meetup resolved `settle_by_checkins` — because "an operator
 * `settle_by_checkins` resolution after `startsAt + 45 min` settles at once; one made earlier only
 * closes the dispute, leaves the meetup `locked` with check-in open, and the outcome waits for the
 * timer".
 */
export function resolutionPlan(
  meetupStatus: MeetupStatus,
  outcome: DisputeOutcome,
  settleDue: boolean,
): ResolutionPlan {
  const action = RESOLUTION_ACTIONS[meetupStatus][outcome];
  return {
    action,
    settleNow: action === 'settle_by_checkins' && settleDue,
    noFault: action === 'no_fault' || action === 'reverse_forfeit',
    reverseForfeit: action === 'reverse_forfeit',
  };
}

type LockedDispute = Pick<Dispute, 'id' | 'status'>;

/**
 * Lock one dispute row for the rest of the transaction (AAP 0.5.3) and return the columns the
 * resolution decides on, or null when no such dispute exists.
 *
 * The meetup row lock is taken first, which is the order AAP 0.5.3 fixes, and this is the read that
 * makes the status check authoritative: a dispute another operator resolved while this request was
 * in flight is seen here, and the resolution is refused. Raw SQL, because Prisma has no equivalent
 * of `FOR UPDATE`; the id binds as a parameter cast to `uuid` (AAP 0.11.2).
 */
async function lockDispute(tx: DbTx, disputeId: string): Promise<LockedDispute | null> {
  const rows = await tx.$queryRaw<LockedDispute[]>(Prisma.sql`
    SELECT "id", "status" FROM "dispute" WHERE "id" = ${disputeId}::uuid FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function venueCityId(tx: DbTx, venueId: string): Promise<string | undefined> {
  const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { cityId: true } });
  return venue?.cityId;
}

function userIdOf(
  meetup: Pick<MeetupRow, 'initiatorId' | 'recipientId'>,
  role: ParticipantRole,
): string {
  return role === 'initiator' ? meetup.initiatorId : meetup.recipientId;
}

/**
 * The side a `forfeited` settlement recorded absent, or null when its two flags do not name exactly
 * one (AAP 0.5.7).
 *
 * A forfeit is a no-show of one party or a late cancellation by one party, and `MeetupSettlement`
 * records which: `lateCancelPlan` writes the canceller absent, and the `no_show` rows of the
 * settlement table write the absent party and only them. The party whose flag is false is therefore
 * the one whose deposit was captured, and the other one is the attendee who was credited.
 */
function absentRole(initiatorPresent: boolean, recipientPresent: boolean): ParticipantRole | null {
  if (initiatorPresent === recipientPresent) {
    return null;
  }
  return initiatorPresent ? 'recipient' : 'initiator';
}

/**
 * The decision AAP 0.5.3 gives the `forfeited → no_fault` row, in its order: the absent party's
 * capture is fenced first, so a capture that has not run cannot run afterwards; the reversal is
 * planned to depend on that capture, so a capture already `executing` — which cannot be fenced — is
 * waited for and the same rule then applies; and the attendee's Table Credit `grant` is voided,
 * which returns their balance to what it was. The `operator_no_fault` transition the reversal
 * accompanies is applied by the caller, after this returns: the counters derive the no-show from
 * the status alone, so the void entry and that status together remove it (AAP 0.5.3, 0.5.7).
 *
 * A deposit with no capture operation at all is not an error: the still-authorized hold is released
 * directly instead, exactly as the shared compensation of `settlement/settle.ts` does, so no
 * authorization is left outstanding at the processor. The one case refused is a `forfeited` meetup
 * whose settlement names no single absent party, because no deposit can then be attributed the money
 * the resolution has to reverse: the dispute stays open for a human rather than an outcome being
 * applied to money that was never identified.
 *
 * @throws AppError `invalid_outcome` when the settlement or the deposit the reversal needs cannot be
 *   identified; the caller has already refused every other unusable state.
 */
async function reverseForfeit(tx: DbTx, meetup: MeetupRow, now: Date): Promise<void> {
  const settlement = await tx.meetupSettlement.findUnique({ where: { meetupId: meetup.id } });
  const forfeited =
    settlement === null
      ? null
      : absentRole(settlement.initiatorPresent, settlement.recipientPresent);
  if (forfeited === null) {
    throw new AppError(
      'invalid_outcome',
      'The settlement of this meetup names no absent party whose deposit could be reversed.',
    );
  }
  const deposits = await depositsForMeetup(tx, meetup.id);
  const deposit = deposits.find((candidate) => candidate.role === forfeited) ?? null;
  if (deposit === null) {
    throw new AppError('invalid_outcome', 'The absent party of this meetup has no deposit.');
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
        userId: userIdOf(meetup, otherRole(forfeited)),
        meetupId: meetup.id,
        kind: 'void',
        amountCents: meetup.depositCents,
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * Whether an account is a party to a meetup that still has an open dispute (AAP 0.5.3).
 *
 * Read inside the resolution's transaction, so the dispute it just resolved is already `resolved`
 * and only a real remainder is found. Both sides of a meetup are searched, because either one
 * leaving an open dispute keeps that account's holds and PaymentIntents in place.
 */
async function hasOpenDispute(tx: DbTx, userId: string): Promise<boolean> {
  const open = await tx.dispute.findFirst({
    where: {
      status: 'open',
      meetup: { OR: [{ initiatorId: userId }, { recipientId: userId }] },
    },
    select: { id: true },
  });
  return open !== null;
}

/**
 * Re-queue the erasure of each participant whose account deletion this resolution unblocks
 * (AAP 0.5.3).
 *
 * `account-erasure` is queued when `DELETE /me` runs and again "when the last open dispute resolves,
 * so it can erase the remaining data": a `locked` meetup with an open dispute is left to the
 * operator with its holds and its dispute, and this resolution is the instant such an account
 * becomes erasable. Only a participant with `deletionRequestedAt` set, and with no open dispute left
 * on any meetup they are a party to, gets the request.
 *
 * **Why it is written in this transaction rather than after the commit.** The erasure row is an
 * outbox row, and `writeOutbox` makes it durable with the resolution it belongs to: a process that
 * dies between the commit and an after-commit callback still leaves the request behind for the
 * two-second poll, where a callback that never ran would lose it. The write is therefore stronger
 * here than it would be after the commit, and the row is written through the same outbox the
 * deletion itself uses (AAP 0.3.2) — so this deliberately departs from the after-commit placement
 * the rest of the post-commit work has, and not from anything it decides.
 *
 * A second row for an account already queued is harmless: the job deletes by id and is idempotent,
 * and each row gets its own job id.
 */
async function requeueErasures(tx: DbTx, participantIds: readonly string[]): Promise<void> {
  const users = await tx.user.findMany({
    where: { id: { in: [...participantIds] } },
    select: { id: true, deletionRequestedAt: true },
  });
  for (const user of users) {
    if (user.deletionRequestedAt === null) {
      continue;
    }
    if (await hasOpenDispute(tx, user.id)) {
      continue;
    }
    await writeAccountErasure(tx, user.id);
  }
}

/**
 * Settle a meetup this resolution just unblocked (AAP 0.5.3).
 *
 * Called only when {@link resolutionPlan} says the check-in window has closed and the resolution was
 * `settle_by_checkins`, in which case the settlement applies the outcome table of AAP 0.5.7 on the
 * check-ins recorded during the dispute. The settlement re-reads the meetup and refuses on its own
 * if a racing action took the row first, so nothing here has to re-check the status.
 *
 * A failure to reach the provider is not the operator's error and not a lost decision: the dispute
 * is resolved and durable, the meetup stays `locked` and the 60-second sweeper settles it on its
 * next pass (AAP 0.3.2). The failure is logged with the two ids and the failure's short code — its
 * `code`, else its name — and never its message, its stack or the filer's text (AAP 0.11.1).
 */
async function settleAfterResolution(
  services: AppServices,
  meetupId: string,
  disputeId: string,
): Promise<void> {
  try {
    await settleMeetup(services, meetupId, { trigger: 'operator' });
  } catch (error) {
    services.logger.warn(
      { event: DISPUTE_SETTLE_DEFERRED, disputeId, meetupId, code: failureToken(error) },
      DISPUTE_SETTLE_DEFERRED,
    );
  }
}

/** The safe shape a logged failure token may have: a short identifier and nothing else. */
const FAILURE_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * A failure's own short token, for a log line: its driver code (`P2028`, `resource_missing`) or its
 * class name (`SettlementReconcileError`), and never its message or stack (AAP 0.11.1).
 *
 * pino writes a message and a stack as strings that key-based redaction cannot rewrite, and the
 * Stripe or Prisma failure `settleMeetup` raises can quote what it concerns — the `PaymentIntent` id
 * of the hold, or the filer's own text on the meetup — which the log lines of this module are
 * forbidden to carry. A token that is not a plain short identifier becomes `Error`, so nothing a
 * thrown value happens to say can reach a log through this path.
 *
 * The copy lives here rather than in `../settlement/sweeper.ts` because this file imports only the
 * modules its resolution work names (`../settlement/settle.ts`, `../meetups/state-machine.ts`,
 * `../outbox/write.ts`, `../payments/operations.ts`) — the same course `../settlement/timers.ts`
 * took with its own `errorTokenOf`.
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

/**
 * Record one operator outcome on an open dispute (AAP 0.5.3, 0.5.4
 * `POST /admin/disputes/:id/resolve`).
 *
 * The refusals are checked in the order AAP 0.5.4 fixes, the outcome first so an unknown value can
 * never look up a dispute: an outcome outside `DisputeOutcome` is `422 invalid_outcome`, and an
 * unknown dispute id is `404 not_found`. A dispute that is already `resolved` is checked inside the
 * transaction, under its own row lock, and answered with the same `422 invalid_outcome` — a repeated
 * resolution and a resolution racing another operator's are both refused, and the second of two
 * operators sees the first one's result (AAP 0.5.3).
 *
 * The transaction then applies {@link resolutionPlan}: the meetup is locked first through
 * `lockMeetup`, which serializes this resolution with check-in, settlement, cancellation, a block and
 * the hold-loss webhooks; a post-settlement `no_fault` reverses the forfeit's money and a
 * `no_fault` on a locked meetup takes the `operator_no_fault` transition, which releases both holds
 * and writes no reputation change; and the dispute is closed with the outcome, `resolvedAt = now`
 * and a null `resolutionNote`, because neither automatic note describes an operator's decision.
 * Then the two parties are notified with the dispute's outcome, the resolution is recorded as an
 * analytics event, and every account whose erasure this dispute was holding up is re-queued.
 *
 * After the commit the plan's money work runs: the settlement of a `settle_by_checkins` resolution
 * whose window has closed, and then `runOperationsFor`, which carries out the release, capture and
 * refund operations this transaction planned. Both run outside it, because no Stripe call belongs
 * inside a transaction (AAP 0.3.2).
 *
 * Nothing here logs the dispute's reason text or a handle, and the log line is written after the
 * commit, when the decision is durable (AAP 0.11.1).
 *
 * @throws AppError `invalid_outcome` (422) for an outcome outside the operator's two, for a dispute
 *   already resolved, and for a `no_fault` on a meetup with no hold or capture to decide — a
 *   `completed` or `unattended` one in particular; `not_found` (404) for an unknown dispute id.
 */
export async function resolveDispute(
  services: AppServices,
  operatorId: string,
  disputeId: string,
  body: ResolveDispute,
  now: Date,
): Promise<AdminDisputeDto> {
  const parsed = DisputeOutcome.safeParse(body.outcome);
  if (!parsed.success) {
    throw new AppError('invalid_outcome');
  }
  const outcome = parsed.data;
  const target = await services.db.dispute.findUnique({
    where: { id: disputeId },
    select: { meetupId: true },
  });
  if (target === null) {
    throw new AppError('not_found');
  }
  const decided = await transact(
    services,
    async (tx, after) => {
      // The meetup lock comes first, before the dispute is even re-read: a check-in, a settlement, a
      // cancellation, a block or a hold-loss webhook that is holding this row has decided the status
      // this resolution is about to read (AAP 0.5.3).
      const meetup = await lockMeetup(tx, target.meetupId);
      if (meetup === null) {
        throw new AppError('not_found');
      }
      const dispute = await lockDispute(tx, disputeId);
      if (dispute === null) {
        throw new AppError('not_found');
      }
      if (dispute.status === 'resolved') {
        throw new AppError('invalid_outcome');
      }
      const plan = resolutionPlan(
        meetup.status,
        outcome,
        now.getTime() >= settleDueAt(meetup.startsAt).getTime(),
      );
      if (plan.action === 'invalid') {
        throw new AppError('invalid_outcome');
      }
      if (plan.reverseForfeit) {
        await reverseForfeit(tx, meetup, now);
      }
      if (plan.noFault) {
        // The transition writes the releases, the analytics and the timers of the new status; the
        // money it plans is executed after this commits, never here (AAP 0.3.2).
        await transition(tx, services, after, meetup, {
          type: 'operator_no_fault',
          operatorId,
          at: now,
          source: 'operator',
        });
      }
      await tx.dispute.update({
        where: { id: disputeId },
        data: { status: 'resolved', outcome, resolvedAt: now, resolutionNote: null },
      });
      await notifyAll(tx, [meetup.initiatorId, meetup.recipientId], 'dispute_resolved', {
        meetupId: meetup.id,
        disputeId,
      });
      // The city is the venue's, read once for the event's column; a venue that cannot be read
      // leaves the column null rather than failing a resolution the operator needs (AAP 0.5.7).
      const cityId = await venueCityId(tx, meetup.venueId);
      await emit(tx, services, 'dispute_resolved', operatorId, {
        meetupId: meetup.id,
        ...(cityId === undefined ? {} : { cityId }),
        props: { outcome },
      });
      // After the dispute is resolved, so this call's own dispute is not found as a remaining open
      // one (AAP 0.5.3).
      await requeueErasures(tx, [meetup.initiatorId, meetup.recipientId]);
      return { settleNow: plan.settleNow, plannedMoney: plan.noFault || plan.reverseForfeit };
    },
    { fenceUserId: operatorId },
  );
  services.logger.info(
    { event: DISPUTE_RESOLVED, disputeId, meetupId: target.meetupId, outcome },
    DISPUTE_RESOLVED,
  );
  if (decided.settleNow) {
    await settleAfterResolution(services, target.meetupId, disputeId);
  }
  // The transaction planned at least one Stripe call in three of the four resolutions: the release
  // of both holds a `no_fault` writes, the reversing refund of a post-settlement one, or the money
  // the settlement planned. `runOperationsFor` never throws — a failure is logged and the sweeper
  // resumes the operation on its next pass (AAP 0.3.2).
  if (decided.plannedMoney || decided.settleNow) {
    await runOperationsFor(services, { meetupId: target.meetupId });
  }
  const row = await findDisputeRow(services, disputeId, now);
  if (row === null) {
    throw new AppError('not_found');
  }
  return toAdminDisputeDto(row);
}
