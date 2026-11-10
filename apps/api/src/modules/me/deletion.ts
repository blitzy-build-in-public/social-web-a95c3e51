/**
 * Account deletion: the disposition `DELETE /me` applies and the erasure request it queues.
 *
 * {@link requestDeletion} runs in three steps. One transaction locks the account's row with `SELECT … FOR UPDATE` and sets
 * `deletionRequestedAt`, revokes every session and refresh token, deletes the account's lodging claims, plans the
 * `delete_customer` `PaymentOperation` and writes the `account_erasure` outbox row. After it commits, the account's sessions
 * are invalidated in Redis and each open meetup is cancelled in a transaction of its own through `applyCancellationRules`.
 * Last, the executor carries out the operations those decisions planned; it is the only place a Stripe call happens, and it
 * never runs inside a transaction.
 *
 * The transaction takes no fence: `transact`'s fence refuses once `deletionRequestedAt` is set, and this is the transaction
 * that sets it. The lock order is `user` → `session` → `lodging_claim` → `call_task` → `payment_operation`, the order the
 * other modules keep. Nothing here logs an email address, a handle or a Stripe identifier: the summary carries counts alone.
 */
import { Prisma, type DbTx } from '@tablemate/db';
import type { MeetupStatus } from '@tablemate/shared';

import { invalidateUserSessions } from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { deleteClaimsForAccount } from '../lodgings/claims.ts';
import { applyCancellationRules } from '../meetups/cancel.ts';
import { transact, writeOutbox } from '../outbox/write.ts';
import { planDeleteCustomer } from '../payments/holds.ts';
import { runOperationsFor } from '../payments/operations.ts';

import type { AppServices } from '../../app.ts';

/** The two statuses a meetup can still be cancelled from; every other status is final, and `applyCancellationRules` answers
 * `already_final` for one anyway. */
const OPEN_MEETUP_STATUSES = ['proposed', 'locked'] as const satisfies readonly MeetupStatus[];

/**
 * What {@link requestDeletion} decided, as counts alone: an id of a meetup, a claim or a session has no place in a summary an
 * operator or a log line reads. The meetup counters partition the meetups the disposition reached, and the ones whose
 * cancellation raised land in {@link meetupsFailed}.
 */
export interface DeletionSummary {
  readonly sessionsRevoked: number;
  readonly claimsDeleted: number;
  readonly claimCitiesInvalidated: number;
  /** Open meetups cancelled outright: `proposed` ones, and `locked` ones at or before the boundary. */
  readonly meetupsCancelled: number;
  /** `locked` meetups cancelled inside the last two hours, settled as a late-cancel forfeit. */
  readonly meetupsLateCancelled: number;
  /** Meetups that ended `lock_lost` because one of their holds was already gone: no forfeit. */
  readonly meetupsLockLost: number;
  /** `locked` meetups with an open dispute, left to the operator with their holds and dispute. */
  readonly meetupsLeftForOperator: number;
  readonly meetupsSkipped: number;
  readonly meetupsFailed: number;
}

interface LockedUserRow {
  readonly stripe_customer_id: string | null;
}

interface DeletionQueued {
  readonly sessionsRevoked: number;
  readonly claimsDeleted: number;
  readonly claimCitiesInvalidated: number;
}

interface MeetupCounts {
  cancelled: number;
  lateCancel: number;
  lockLost: number;
  leftForOperator: number;
  skipped: number;
  failed: number;
}

/**
 * Applies the account-deletion disposition of `DELETE /me`; the route answers `202`, because nothing here is a refusal.
 *
 * The account is closed to writes the moment this commits: a mutation that started before it commits first and is erased by
 * the job that follows, and one that starts later is refused `401 token_invalid` by the fence. A failure costs the meetup it
 * happened on, not the deletion — a cancellation that raises is logged and counted, the remaining meetups still run, the
 * operations already planned stay durable, and the erasure request is queued either way.
 */
export async function requestDeletion(
  services: AppServices,
  userId: string,
): Promise<DeletionSummary> {
  const now = services.clock.now();
  const queued = await transact(
    services,
    async (tx, after): Promise<DeletionQueued> => {
      // The lock every other mutating handler share-locks first, taken before anything else (AAP 0.5.3).
      const user = await lockUserRow(tx, userId);
      // The flag that closes the account, written only while it is still open, so the instant of the first
      // request survives a second one.
      await tx.user.updateMany({
        where: { id: userId, deletionRequestedAt: null },
        data: { deletionRequestedAt: now },
      });
      // Every session and refresh token: a session row *is* the refresh token, since `refreshTokenHash` is
      // the token's digest and `Session.id` the `sid` of the access tokens it minted.
      const revoked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE "session" SET "revoked_at" = ${now}
         WHERE "user_id" = ${userId}::uuid AND "revoked_at" IS NULL
        RETURNING "id"::text AS "id"
      `);
      const sessionIds = revoked.map((row) => row.id);
      // Redis takes no part in this transaction: the invalidation runs once the commit has happened,
      // so an outage delays the cache drop by its own TTL and can never fail the deletion (AAP 0.3.2).
      after(() => invalidateUserSessions(services, userId, sessionIds));
      // The claims, under the locks the order above fixes: `deleteClaimsForAccount` takes no fence and opens
      // no transaction of its own, deletes a claim in `calling` rather than refusing it as the user-facing
      // route does, and registers the leaderboard invalidations (AAP 0.5.3, 0.5.7).
      const claims = await deleteClaimsForAccount(tx, services, userId, after);
      // The Stripe customer's deletion, planned with its own copy of the id so the erasure job can clear
      // `User.stripeCustomerId` without losing it; a null copy still writes the row, the executor recording
      // it as a satisfied no-op (AAP 0.5.2, 0.5.3).
      await planDeleteCustomer(tx, userId, user.stripe_customer_id, now);
      // The erasure is announced in the transaction that requests it, so the request is durable with the
      // deletion itself (AAP 0.5.2, 0.5.3).
      await writeAccountErasure(tx, userId);
      return {
        sessionsRevoked: sessionIds.length,
        claimsDeleted: claims.claimIds.length,
        claimCitiesInvalidated: claims.cityIds.length,
      };
    },
    // No fence: this transaction sets `deletionRequestedAt`, so a fence would refuse the deletion its own flag.
  );
  const meetups = await cancelOpenMeetups(services, userId, now);
  // The operations the decisions above planned, once everything has committed; the executor's gate keeps
  // `delete_customer` pending while a deposit is not final or a dispute is open, and the sweeper resumes
  // it. The executor swallows its own failures, so a Stripe outage cannot fail this request (AAP 0.3.2).
  await runOperationsFor(services, { userId });
  const summary: DeletionSummary = {
    sessionsRevoked: queued.sessionsRevoked,
    claimsDeleted: queued.claimsDeleted,
    claimCitiesInvalidated: queued.claimCitiesInvalidated,
    meetupsCancelled: meetups.cancelled,
    meetupsLateCancelled: meetups.lateCancel,
    meetupsLockLost: meetups.lockLost,
    meetupsLeftForOperator: meetups.leftForOperator,
    meetupsSkipped: meetups.skipped,
    meetupsFailed: meetups.failed,
  };
  services.logger.info(
    { event: 'account_deletion_requested', userId, ...summary },
    'account_deletion_requested',
  );
  return summary;
}

/**
 * Queues the erasure of one account in the transaction that requests it. `account_erasure` is the outbox kind whose job
 * deletes what is left of the account; written in the caller's transaction, it is durable with the deletion it belongs to, so
 * a process that dies before the dispatcher runs still leaves the request behind. A second row is harmless: the job deletes
 * by id, is idempotent, and each row gets its own job id.
 */
export async function writeAccountErasure(tx: DbTx, userId: string): Promise<string> {
  return writeOutbox(tx, 'account_erasure', { userId });
}

/**
 * Cancels every open meetup of the account, one transaction each.
 *
 * The meetups are read first and cancelled one at a time, because `applyCancellationRules` owns its own transaction and
 * re-reads the row under the meetup lock: a meetup that a settlement, a hold-loss webhook or the counterpart took first comes
 * back `already_final`, `lock_lost` or `left_for_operator` and is counted as such. A failure is contained — logged with the
 * meetup and counted — because a deletion that stopped there would leave the account half-disposed.
 */
async function cancelOpenMeetups(
  services: AppServices,
  userId: string,
  now: Date,
): Promise<MeetupCounts> {
  const counts: MeetupCounts = {
    cancelled: 0,
    lateCancel: 0,
    lockLost: 0,
    leftForOperator: 0,
    skipped: 0,
    failed: 0,
  };
  for (const meetupId of await openMeetupIds(services, userId)) {
    try {
      const outcome = await applyCancellationRules(services, meetupId, userId, 'account_deleted', {
        now,
      });
      switch (outcome.result) {
        case 'cancelled':
          counts.cancelled += 1;
          break;
        case 'late_cancel':
          counts.lateCancel += 1;
          break;
        case 'lock_lost':
          counts.lockLost += 1;
          break;
        case 'left_for_operator':
          counts.leftForOperator += 1;
          break;
        case 'not_found':
        case 'already_final':
          counts.skipped += 1;
          break;
      }
    } catch (error) {
      counts.failed += 1;
      services.logger.warn(
        { event: 'account_deletion_meetup_failed', meetupId, code: failureToken(error) },
        'account_deletion_meetup_failed',
      );
    }
  }
  return counts;
}

/**
 * The meetups the disposition still owns: those in one of {@link OPEN_MEETUP_STATUSES} on either side of the account, ordered
 * by id so two deletions that share a meetup walk it in the same order. Each id is then resolved under its own meetup lock by
 * `applyCancellationRules`, so this list is a hint rather than a decision.
 */
async function openMeetupIds(services: AppServices, userId: string): Promise<string[]> {
  const rows: readonly { readonly id: string }[] = await services.db.meetup.findMany({
    where: {
      status: { in: [...OPEN_MEETUP_STATUSES] },
      OR: [{ initiatorId: userId }, { recipientId: userId }],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => row.id);
}

/**
 * Locks the account's row for the rest of the deletion transaction. `FOR UPDATE` and not `FOR SHARE`: this transaction is the
 * one that closes the account, so it waits for the mutations already in flight and holds off the ones that would start behind
 * it. Raw SQL because the row lock has no Prisma client equivalent, with `"user"` quoted as a reserved word.
 */
async function lockUserRow(tx: DbTx, userId: string): Promise<LockedUserRow> {
  const rows = await tx.$queryRaw<LockedUserRow[]>(Prisma.sql`
    SELECT "stripe_customer_id"
      FROM "user"
     WHERE "id" = ${userId}::uuid
       FOR UPDATE
  `);
  const row = rows[0];
  if (row === undefined) {
    throw new AppError('token_invalid');
  }
  return row;
}

const FAILURE_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * A failure's own short token, for a log line: its driver code (`P2028`, `resource_missing`) or its class name, and never its
 * message or stack. pino writes a message and a stack as strings that key-based redaction cannot rewrite, and the Prisma or
 * Stripe failure this walk swallows can quote what it concerns — a driver's message names the column and the value it refused,
 * a provider's names the email address or the customer the call carried. A token that is not a plain short identifier becomes
 * `Error`.
 *
 * The copy lives here rather than in `../settlement/sweeper.ts` because this file imports only the modules its disposition
 * names, the same course `../settlement/timers.ts` took with its own `errorTokenOf`.
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
