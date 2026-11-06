/**
 * Safety basics: blocking a traveler and reporting one (AAP 0.5.1, 0.5.3, 0.5.4, 0.7.3).
 *
 * `POST /users/:id/block` and `POST /users/:id/report` answer `204` and hand their work to the two
 * functions here. Blocking is the safety tool the plan makes outrank the money rules: a block
 * cancels any open meetup of the pair — at any time before settlement, inside the late-cancellation
 * window and after the start included — with `cancelReason = block` and no forfeit, no Table Credit
 * and no reputation change whatsoever (AAP 0.5.3, 0.7.3). Reporting records a reason for the
 * operator queue and settles nothing.
 *
 * **One transaction per call, fenced on the acting account (AAP 0.3.2, 0.5.3).** Both functions
 * write through `transact` with `fenceUserId`, so `DELETE /me` and a block or report serialize
 * instead of interleaving. Inside that transaction the target's row is read `FOR SHARE`: the
 * deletion takes `FOR UPDATE` on the same row, so a block against an account being deleted either
 * commits first — and the erasure that follows removes it, the `Block` row cascading with the user
 * — or waits for the deletion and then reads no live row, answering `404 user_not_found`.
 *
 * **An open meetup is cancelled only through the state machine.** The meetup is found, locked with
 * `lockMeetup` and re-read: a racing settlement, early cancellation or hold-loss webhook may have
 * finalized it while this call waited, and a row that is no longer `proposed` or `locked` is left
 * as it stands. Otherwise `transition` applies the `block` event and writes the `cancelled` status,
 * `finalAt`, the release `PaymentOperation`s for every non-final attempt of both sides, the
 * automatic `no_fault` resolution of an open dispute with the note `cancelled_by_block` and the
 * notifications — none of it repeated here. The releases it plans run after the commit, through
 * `after`, so no provider call happens inside the transaction (AAP 0.3.2).
 *
 * @see AAP 0.5.3 for the transition table, the late-cancellation rule the block is exempt from and
 *   the write fence, 0.5.4 for the two routes and their errors, 0.5.2 for the `Block` and `Report`
 *   rows, 0.5.7 for the rule that blocking never changes a reputation counter, 0.7.3 for the
 *   decision that safety outranks the late-cancellation penalty, and 0.8.1 for this file.
 */

import { Prisma, type DbTx } from '@tablemate/db';
import type { MeetupStatus, ReportRequest } from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { lockMeetup, transition } from '../meetups/state-machine.ts';
import { transact } from '../outbox/write.ts';
import { runOperationsFor } from '../payments/operations.ts';

// Type-only, so this file holds no runtime edge to the module that builds the app — the same
// `AppServices` every module of `apps/api/src/modules` names (AAP 0.5.1).
import type { AppServices } from '../../app.ts';

/**
 * The two statuses an open meetup can hold, and the only ones a block cancels (AAP 0.5.3).
 *
 * A meetup in any final status — settled, cancelled, lapsed, declined, `no_fault`, `lock_lost` — is
 * never touched by a block: its money has already been decided and a later block cannot decide it
 * again.
 */
const OPEN_PAIR_STATUSES = ['proposed', 'locked'] as const satisfies readonly MeetupStatus[];

/**
 * Refuses a target that is unknown, deleted or on its way out, holding its row for the caller's
 * transaction (AAP 0.5.4).
 *
 * The `FOR SHARE` is the invariant, not an optimisation: `DELETE /me` takes `FOR UPDATE` on this
 * same row in its own transaction, and the two locks cannot be held at once. A block therefore
 * either commits before the deletion does — and the erasure that follows removes the row it wrote —
 * or waits for the deletion to commit and then reads no live row at all, answering `404
 * user_not_found`. The same read refuses a row whose account has requested deletion but not yet
 * been erased, so nothing is written about an account that is leaving.
 *
 * @param tx - The transaction `transact` opened, which holds the row until it ends.
 * @param targetId - The account being blocked or reported.
 * @throws AppError `user_not_found` when no live account has that id.
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
 * The `Block` row is written idempotently, so a repeated block is a no-op that still answers `204`,
 * and a block the target placed first does not prevent this one: the pair is then blocked in both
 * directions, which is what makes `GET /users/:userId` answer `404` to either of them. Every effect
 * on the other side follows from the row itself and is not written here.
 *
 * An open meetup of the pair is cancelled as AAP 0.5.3 requires, through the locked row and the
 * state machine, so its deposits are released and an open dispute is resolved `no_fault` with the
 * note `cancelled_by_block`. The cancellation is free at every hour: a block is not a late
 * cancellation, so `lateCancel` never applies and no hold is captured, no Table Credit is granted
 * and no `WitnessEvent` or `PairHistory` row is written — a block never changes a reputation
 * counter (AAP 0.5.7).
 *
 * @param services - The app's services: the database, the injected clock, the logger and the outbox
 *   the transaction is opened through, plus what the state machine's own effects use.
 * @param blockerId - The authenticated caller, who is doing the blocking and is fenced.
 * @param blockedId - The traveler being blocked.
 * @returns Whether an open meetup of the pair was cancelled by this call.
 * @throws AppError `user_not_found` — a self-block, and likewise an unknown, deleted or
 *   deletion-requested target, which is the one code the route answers (AAP 0.5.4).
 * @throws AppError `token_invalid` after `DELETE /me`, thrown by the fence before any write.
 * @see AAP 0.5.3 for the `block` row of the transition table, 0.5.4 for the route, 0.5.7 for the
 *   counters a block leaves alone, 0.7.3 for the decision that safety outranks the money rules.
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

      // At most one such meetup exists: the partial unique index on the pair covers exactly the two
      // open statuses (AAP 0.5.2).
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
        // A racing settlement, cancellation or hold loss finalized it while this call waited for the
        // row: its outcome stands and a block has nothing left to decide.
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
 * A block in either direction does not prevent a report: reporting is a safety tool, and the pair
 * most likely to need it is the pair where one side has already blocked the other. Reporting also
 * has no effect on the meetup, on a deposit or on any reputation counter — an operator reads the
 * report and acts, which is why no notification is sent here and the row is read back through
 * `GET /admin/reports`.
 *
 * The report carries the pair's most recent meetup as operator context, whichever status it holds,
 * and `null` when the two never met. It is the only meetup a report could be about, and it saves
 * the operator from searching for one. `createdAt` is written from the injected clock, because the
 * 180-day reason-text clearance of AAP 0.5.2 ranges over that column and a test that advances the
 * clock has to move it.
 *
 * @param services - The app's services: the database, the injected clock, the logger and the outbox
 *   the transaction is opened through.
 * @param reporterId - The authenticated caller, who is doing the reporting and is fenced.
 * @param reportedId - The traveler being reported.
 * @param body - The validated `ReportRequest`; `reason` arrives trimmed from the shared schema and
 *   is never logged, never returned and never attached to a notification (AAP 0.11.1).
 * @returns The new report's id.
 * @throws AppError `user_not_found` — a self-report, and likewise an unknown, deleted or
 *   deletion-requested target (AAP 0.5.4).
 * @throws AppError `token_invalid` after `DELETE /me`, thrown by the fence before any write.
 * @see AAP 0.5.2 for the `Report` row and its retention, 0.5.4 for the route and its errors.
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

      const shared = await tx.meetup.findFirst({
        where: {
          OR: [
            { initiatorId: reporterId, recipientId: reportedId },
            { initiatorId: reportedId, recipientId: reporterId },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });

      const created = await tx.report.create({
        data: {
          reporterId,
          reportedId,
          reason: body.reason,
          meetupId: shared?.id ?? null,
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
