/**
 * Safety basics: blocking a traveler and reporting one (AAP 0.5.1, 0.5.3, 0.5.4, 0.7.3).
 *
 * A block cancels any open meetup of the pair — at any time before settlement, inside the
 * late-cancellation window and after the start included — with `cancelReason = block` and no forfeit, no
 * Table Credit and no reputation change whatsoever (AAP 0.5.3, 0.7.3). Reporting records a reason for the
 * operator queue and settles nothing.
 *
 * Both functions write through one fenced transaction, and inside it the target's row is read `FOR SHARE`:
 * the deletion takes `FOR UPDATE` on the same row, so a block against an account being deleted either
 * commits first — and the erasure that follows removes it, the `Block` row cascading with the user — or
 * waits for the deletion and then reads no live row, answering `404 user_not_found` (AAP 0.3.2, 0.5.3).
 * An open meetup is cancelled only through the state machine, after `lockMeetup` and a re-read, and the
 * releases it plans run after the commit, through `after`, so no provider call happens inside the
 * transaction (AAP 0.3.2).
 */
import { Prisma, type DbTx } from '@tablemate/db';
import type { MeetupStatus, ReportRequest } from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { lockMeetup, transition } from '../meetups/state-machine.ts';
import { transact } from '../outbox/write.ts';
import { runOperationsFor } from '../payments/operations.ts';

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { AppServices } from '../../app.ts';

/**
 * The two statuses an open meetup can hold, and the only ones a block cancels: a meetup in any final status
 * is never touched, because its money has already been decided (AAP 0.5.3).
 */
const OPEN_PAIR_STATUSES = ['proposed', 'locked'] as const satisfies readonly MeetupStatus[];

/**
 * Refuses a target that is unknown, deleted or on its way out, holding its row for the caller's
 * transaction: the `FOR SHARE` is the invariant, not an optimisation, because `DELETE /me` takes
 * `FOR UPDATE` on this same row and the two locks cannot be held at once, so a block either commits before
 * the deletion — and the erasure removes the row it wrote — or waits and reads no live row at all.
 */
async function lockLiveTarget(tx: DbTx, targetId: string): Promise<void> {
  const rows = await tx.$queryRaw<readonly { id: string }[]>(Prisma.sql`
    SELECT "id" FROM "user"
     WHERE "id" = ${targetId}::uuid
       AND "deleted_at" IS NULL
       AND "deletion_requested_at" IS NULL
       FOR SHARE
  `);
  if (rows.length === 0) {
    throw new AppError('user_not_found');
  }
}

/**
 * Block a traveler, cancelling any open meetup the pair shares (AAP 0.5.3, 0.5.4, 0.7.3).
 *
 * The `Block` row is written idempotently, so a repeated block is a no-op that still answers `204`, and a
 * block the target placed first does not prevent this one: the pair is then blocked in both directions,
 * which is what makes `GET /users/:userId` answer `404` to either of them. An open meetup is cancelled
 * through the locked row and the state machine, so its deposits are released and an open dispute is
 * resolved `no_fault` with the note `cancelled_by_block`. The cancellation is free at every hour: no hold
 * is captured, no Table Credit is granted and no reputation counter changes (AAP 0.5.7).
 */
export async function block(
  services: AppServices,
  blockerId: string,
  blockedId: string,
): Promise<{ meetupCancelled: boolean }> {
  if (blockerId === blockedId) {
    throw new AppError('user_not_found');
  }
  const meetupCancelled = await transact(
    services,
    async (tx, after): Promise<boolean> => {
      const now = services.clock.now();
      await lockLiveTarget(tx, blockedId);
      await tx.block.createMany({
        data: [{ blockerId, blockedId, createdAt: now }],
        skipDuplicates: true,
      });
      // At most one such meetup exists: the partial unique index on the pair covers the two open statuses.
      const open = await tx.meetup.findFirst({
        where: {
          status: { in: [...OPEN_PAIR_STATUSES] },
          OR: [
            { initiatorId: blockerId, recipientId: blockedId },
            { initiatorId: blockedId, recipientId: blockerId },
          ],
        },
        select: { id: true },
      });
      if (open === null) {
        return false;
      }
      const meetup = await lockMeetup(tx, open.id);
      if (meetup === null || (meetup.status !== 'proposed' && meetup.status !== 'locked')) {
        // A racing settlement, cancellation or hold loss finalized it while this call waited: its outcome stands.
        return false;
      }
      await transition(tx, services, after, meetup, {
        type: 'block',
        actorId: blockerId,
        at: now,
        source: 'route',
      });
      // The releases the transition planned run after the commit, never inside it (AAP 0.3.2).
      after(() => runOperationsFor(services, { meetupId: open.id }));
      return true;
    },
    { fenceUserId: blockerId },
  );
  services.logger.info(
    { event: 'user_blocked', blockerId, blockedId, meetupCancelled },
    'user_blocked',
  );
  return { meetupCancelled };
}

/**
 * Report a traveler to the operators (AAP 0.5.2, 0.5.4).
 *
 * A block in either direction does not prevent a report: the pair most likely to need one is the pair where
 * one side has already blocked the other. A report has no effect on the meetup, on a deposit or on any
 * reputation counter — an operator reads it through `GET /admin/reports` and acts — and it carries the
 * meetup the report was filed from when the caller names one the pair shares, whichever status that meetup
 * holds, and the pair's most recent shared meetup otherwise, `null` when the two never met (AAP 0.5.2
 * `Report.meetupId`). A named meetup the pair does not share is ignored rather than refused, so the route
 * never tells a caller whether a meetup id exists and a bad context never costs the report itself.
 * `createdAt` is written from the injected clock, because the 180-day reason-text clearance of AAP 0.5.2
 * ranges over that column.
 */
export async function report(
  services: AppServices,
  reporterId: string,
  reportedId: string,
  body: ReportRequest,
): Promise<{ reportId: string }> {
  if (reporterId === reportedId) {
    throw new AppError('user_not_found');
  }
  const reportId = await transact(
    services,
    async (tx): Promise<string> => {
      await lockLiveTarget(tx, reportedId);
      // The pair's meetups in either direction, which is what every context read below is restricted to.
      const pair: Prisma.MeetupWhereInput = {
        OR: [
          { initiatorId: reporterId, recipientId: reportedId },
          { initiatorId: reportedId, recipientId: reporterId },
        ],
      };
      const named =
        body.meetupId === undefined
          ? null
          : await tx.meetup.findFirst({
              where: { ...pair, id: body.meetupId },
              select: { id: true },
            });
      // A meetup the pair does not share is no context of theirs, so only the inference below can name one;
      // the report is still filed, because a bad context must never cost the safety report itself.
      const context =
        named ??
        (await tx.meetup.findFirst({
          where: pair,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        }));
      const created = await tx.report.create({
        data: {
          reporterId,
          reportedId,
          reason: body.reason,
          meetupId: context?.id ?? null,
          createdAt: services.clock.now(),
        },
        select: { id: true },
      });
      return created.id;
    },
    { fenceUserId: reporterId },
  );
  services.logger.info({ event: 'user_reported', reportId, reportedId }, 'user_reported');
  return { reportId };
}
