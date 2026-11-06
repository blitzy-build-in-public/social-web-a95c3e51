/**
 * Account deletion: the disposition `DELETE /me` applies and the erasure request it queues
 * (AAP 0.5.1, 0.5.2, 0.5.3, 0.5.4).
 *
 * {@link requestDeletion} is the disposition of AAP 0.5.3, in the one order that section and the
 * modules it reaches already fix:
 *
 *  1. **One transaction, with the account's row locked first.** It takes `SELECT … FOR UPDATE` on
 *     `user` before it reads or writes anything else, which is what serializes the deletion against
 *     every mutation in flight: each of those holds `SELECT … FOR SHARE` on the same row through the
 *     write fence of `plugins/auth.ts`, so a mutation that started earlier commits before this
 *     transaction and the erasure that follows removes what it wrote, while every mutation that
 *     starts later sees `deletionRequestedAt` and is refused `401 token_invalid`. In that same
 *     transaction the flag is set, every session and refresh token is revoked, the account's lodging
 *     claims are deleted, the `delete_customer` `PaymentOperation` is planned, and the
 *     `account_erasure` outbox row that announces the erasure is written.
 *  2. **After it commits, the account's sessions are invalidated in Redis** — every API instance
 *     drops its cached entries and closes the account's sockets — and then **each open meetup is
 *     cancelled in a transaction of its own** through `applyCancellationRules` with the reason
 *     `account_deleted`. A deletion follows the cancellation rules rather than escaping them, so a
 *     `proposed` meetup is cancelled outright, a `locked` one follows the two-hour boundary, and a
 *     `locked` one with an open dispute is left to the operator, holds intact.
 *  3. **Last, the operations those decisions planned are carried out** by the executor: it is the
 *     only place a Stripe call happens, and it never runs inside a transaction (AAP 0.3.2).
 *
 * **Why the transaction takes no fence.** `transact`'s fence is a `FOR SHARE` read of the acting
 * account's row that refuses once `deletionRequestedAt` is set — and this transaction is the one that
 * sets it, so a fence here would refuse the deletion its own flag. `applyCancellationRules` skips the
 * fence for the same reason when its reason is `account_deleted`.
 *
 * **The lock order is `user` → `session` → `lodging_claim` → `call_task` → `payment_operation`**:
 * the order `plugins/auth.ts` states for this route ("`DELETE /me` locks the user row and only then
 * updates that account's sessions"), the order `auth/sessions.ts` keeps when it revokes a rotated
 * token's successors, the `lodging_claim` → `call_task` order `lodgings/claims.ts` keeps with
 * `apps/workers`, and the deposit-then-operation order `payments/holds.ts` keeps. Taking any of them
 * the other way round would let two of those transactions deadlock against each other.
 *
 * **What is deliberately not here.** No cancellation rule, no claim deletion, no hold of its own and
 * no Stripe call: each belongs to the module that owns it, and this file decides only the order those
 * parts run in and what a failure of one costs. A single meetup whose cancellation raises is logged
 * and the remaining meetups still run, because the erasure is queued either way and a meetup whose
 * dispute holds the money is the operator's to settle.
 *
 * Nothing here logs an email address, a handle or a Stripe identifier: the summary carries counts
 * alone, and the one per-meetup failure line carries a meetup id (AAP 0.11.1).
 *
 * @see AAP 0.5.3 for the disposition, its order and the write fence; 0.5.4 for `DELETE /me` and its
 *   `202`; 0.5.2 for what the erasure job deletes and what the tombstone keeps; 0.3.2 for the outbox
 *   and the executor; 0.11.1 for the injected clock and the log fields; 0.8.1 for this file.
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

// Type-only, so this file holds no runtime edge to the module that builds the app — the same
// `AppServices` every module of `apps/api/src/modules` names (AAP 0.5.1).
import type { AppServices } from '../../app.ts';

/**
 * The two statuses a meetup can still be cancelled from (AAP 0.5.3).
 *
 * Every other status is final, and `applyCancellationRules` answers `already_final` for one anyway;
 * the filter exists so the disposition walks the meetups that can still move instead of every meetup
 * the account ever had. The same pair is what `users/safety.ts` cancels on a block.
 */
const OPEN_MEETUP_STATUSES = ['proposed', 'locked'] as const satisfies readonly MeetupStatus[];

/**
 * What {@link requestDeletion} decided, as counts alone (AAP 0.5.3).
 *
 * Counts and nothing else, on purpose: the route logs one line and the tests assert the disposition
 * without holding a row's worth of values, and an id of a meetup, a claim or a session has no place
 * in a summary an operator or a log line reads. The six meetup counters partition the meetups the
 * disposition reached — each meetup it found lands in exactly one of them, and the ones whose
 * cancellation raised land in {@link meetupsFailed}.
 */
export interface DeletionSummary {
  /** How many sessions and refresh tokens the deletion revoked. */
  readonly sessionsRevoked: number;
  /** How many lodging claims were deleted with their booking details. */
  readonly claimsDeleted: number;
  /** How many cities' cached leaderboards the claim deletion invalidated (AAP 0.5.7). */
  readonly claimCitiesInvalidated: number;
  /** Open meetups cancelled outright: `proposed` ones, and `locked` ones at or before the boundary. */
  readonly meetupsCancelled: number;
  /** `locked` meetups cancelled inside the last two hours, settled as a late-cancel forfeit. */
  readonly meetupsLateCancelled: number;
  /** Meetups that ended `lock_lost` because one of their holds was already gone: no forfeit. */
  readonly meetupsLockLost: number;
  /** `locked` meetups with an open dispute, left to the operator with their holds and dispute. */
  readonly meetupsLeftForOperator: number;
  /** Meetups that were already final, or gone, by the time the disposition reached them. */
  readonly meetupsSkipped: number;
  /** Meetups whose cancellation raised: logged, and left to the sweeper and the operator. */
  readonly meetupsFailed: number;
}

/**
 * The `user` row {@link lockUserRow} locks, as the locking read returns it: the one column the
 * `delete_customer` operation copies. Nothing else about the account is read here — the columns the
 * disposition writes are written, never read back (AAP 0.11.1).
 */
interface LockedUserRow {
  readonly stripe_customer_id: string | null;
}

/** What the deletion transaction wrote, from which the summary and the invalidation are built. */
interface DeletionQueued {
  readonly sessionsRevoked: number;
  readonly claimsDeleted: number;
  readonly claimCitiesInvalidated: number;
}

/** What {@link cancelOpenMeetups} counted, one counter per outcome of `applyCancellationRules`. */
interface MeetupCounts {
  cancelled: number;
  lateCancel: number;
  lockLost: number;
  leftForOperator: number;
  skipped: number;
  failed: number;
}

/**
 * Applies the account-deletion disposition of `DELETE /me` (AAP 0.5.3), answering `202` through the
 * route because nothing in it is a refusal.
 *
 * The steps and the order they run in are the module documentation's. The two consequences worth
 * restating where a caller reads them:
 *
 *  - **The account is closed to writes the moment this commits.** The deletion transaction takes
 *    `FOR UPDATE` on the user row, so a mutation that started before it commits first and is erased
 *    by the job that follows, and one that starts later is refused `401 token_invalid` by the fence.
 *    Nothing an account wrote can be recreated after the erasure has run (AAP 0.5.3).
 *  - **A failure costs the meetup it happened on, not the deletion.** A cancellation that raises is
 *    logged and counted in `meetupsFailed`; the remaining meetups still run, the operations already
 *    planned stay durable, the sweeper resumes them, and the erasure request is queued either way.
 *
 * The route has no error code of its own (AAP 0.5.4), and this function answers no refusal: the only
 * thing that can end the request other than a `202` is a failure of its own transaction — the
 * database being unreachable or the commit failing — which the errors plugin reports as
 * `500 internal_error` with a request id, leaving the flag unset so the caller can retry (AAP 0.11.1).
 *
 * @param services - The app's services: the guarded client, the injected clock, the logger, the
 *   outbox dispatcher the transaction is opened through, the Redis connection and pub/sub the session
 *   invalidation uses, and the payment gateway the executor calls.
 * @param userId - The authenticated caller, from `request.auth.userId`. The account whose deletion is
 *   requested, and the actor of every cancellation the disposition applies.
 * @returns Counts of what the disposition decided, for the route's log line and for the tests.
 * @throws AppError `token_invalid` (401) when the account's row no longer exists: the bearer guard
 *   admits no session whose account row is gone, so this names an invariant rather than a case, and
 *   it keeps that failure from surfacing as a foreign-key violation on the rows written below.
 */
export async function requestDeletion(
  services: AppServices,
  userId: string,
): Promise<DeletionSummary> {
  const now = services.clock.now();

  const queued = await transact(
    services,
    async (tx, after): Promise<DeletionQueued> => {
      // The account's row is locked before anything else in this transaction, and it is the lock
      // every other mutating handler share-locks first (AAP 0.5.3; see the module's lock order).
      const user = await lockUserRow(tx, userId);

      // The flag that closes the account. Written only while it is still open, so the instant of the
      // first request survives a second one — the same first-write-wins form `me/consents.ts` uses
      // for `ageConfirmedAt`.
      await tx.user.updateMany({
        where: { id: userId, deletionRequestedAt: null },
        data: { deletionRequestedAt: now },
      });

      // Every session and refresh token of the account. A session row *is* the refresh token
      // (`auth/sessions.ts`: `refreshTokenHash` is the digest of the token, `Session.id` is the `sid`
      // of the access tokens it minted), so revoking the rows ends both, and the returned ids are
      // what the invalidation below names.
      const revoked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE "session" SET "revoked_at" = ${now}
         WHERE "user_id" = ${userId}::uuid AND "revoked_at" IS NULL
        RETURNING "id"::text AS "id"
      `);
      const sessionIds = revoked.map((row) => row.id);

      // Redis takes no part in this transaction: the invalidation runs once the commit has happened,
      // so an outage delays the cache drop by its own TTL and can never fail the deletion (AAP 0.3.2).
      after(() => invalidateUserSessions(services, userId, sessionIds));

      // The claims, inside this transaction and under the locks the order above fixes:
      // `deleteClaimsForAccount` takes no fence and opens no transaction of its own, deletes a claim
      // in `calling` rather than refusing it as the user-facing route does, and registers the
      // leaderboard invalidations for the affected cities on this transaction's own `after`
      // (AAP 0.5.3, 0.5.7).
      const claims = await deleteClaimsForAccount(tx, services, userId, after);

      // The Stripe customer's deletion, planned here with its own copy of the id so the erasure job
      // can clear `User.stripeCustomerId` without losing it. A null copy still writes the row — the
      // executor records it as a satisfied no-op — which keeps "one deletion operation per account"
      // true for an account that never saved a card, and the row's idempotency key makes a second
      // `DELETE /me` replay this plan instead of writing a second operation (AAP 0.5.2, 0.5.3).
      await planDeleteCustomer(tx, userId, user.stripe_customer_id, now);

      // The erasure is announced here, in the transaction that requests it, so the request is durable
      // with the deletion itself: the dispatcher carries it to `workers` once this commits, and it
      // runs again when the operator resolves the account's last open dispute (AAP 0.5.2, 0.5.3).
      await writeAccountErasure(tx, userId);

      return {
        sessionsRevoked: sessionIds.length,
        claimsDeleted: claims.claimIds.length,
        claimCitiesInvalidated: claims.cityIds.length,
      };
    },
    // No fence: this transaction is the one that sets `deletionRequestedAt`, so the fence would
    // refuse the deletion its own flag (see the module documentation).
  );

  const meetups = await cancelOpenMeetups(services, userId, now);

  // The operations the decisions above planned, once everything has committed: the releases of the
  // meetups just cancelled, and the `delete_customer` operation planned in the transaction. Its own
  // gate keeps that one pending while any of the account's deposits is not final or any dispute on
  // its meetups is open; the sweeper resumes it, and `admin/disputes.ts` re-queues the erasure when
  // the last dispute resolves (AAP 0.3.2, 0.5.3). The executor swallows its own failures and never
  // throws here, so a Stripe outage cannot fail this request.
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
 * Queues the erasure of one account in the transaction that requests it (AAP 0.5.2, 0.5.3).
 *
 * `account_erasure` is the outbox kind whose job deletes what is left of the account once the
 * deletion has committed, and this row is the only way that work is announced: written in the
 * caller's transaction, it is durable with the deletion it belongs to, so a process that dies before
 * the dispatcher runs still leaves the request behind and the two-second poll carries it out
 * (AAP 0.3.2).
 *
 * Two callers, one row each, and neither has to coordinate with the other: {@link requestDeletion}
 * for `DELETE /me`, and the operator path that resolves the account's last open dispute, because a
 * dispute leaves meetups, holds and their PaymentIntents in place and the erasure can only finish
 * once they are settled (AAP 0.5.3). A second row is harmless — the job deletes by id and is
 * idempotent, and each row gets its own job id — which is what makes calling it again the right
 * recovery rather than a duplicate to prevent.
 *
 * @param tx - The caller's open transaction, whose commit is what makes the request durable. It must
 *   be a transaction `transact` opened, so the row cannot be written outside one.
 * @param userId - The account to erase.
 * @returns The new outbox row's id.
 * @throws Error when `tx` is not a transaction opened by `transact`, because a request written
 *   outside one could commit without the deletion it belongs to.
 * @throws QueuePayloadError when the payload does not match its schema — the account id comes from a
 *   locked `user` row, so a payload that fails it is a programming error, not a case.
 * @see AAP 0.5.3 for the disposition that queues the erasure and for the re-queue on a resolved last
 *   dispute, 0.5.2 for the records the job then deletes and the tombstone it leaves.
 */
export async function writeAccountErasure(tx: DbTx, userId: string): Promise<string> {
  return writeOutbox(tx, 'account_erasure', { userId });
}

/**
 * Cancels every open meetup of the account, one transaction each (AAP 0.5.3).
 *
 * The meetups are read first and then cancelled one at a time, because `applyCancellationRules` owns
 * its own transaction and re-reads the row under the meetup lock before it decides: a meetup that a
 * settlement, a hold-loss webhook or the counterpart took first comes back `already_final`,
 * `lock_lost` or `left_for_operator` and is counted as such rather than cancelled twice. The instant
 * is the one the caller took from the clock, so the two-hour boundary is judged at a single point
 * across the whole disposition.
 *
 * A failure is contained: it is logged with the meetup and counted, and the next meetup still runs.
 * `applyCancellationRules` raises `payment_unavailable` when a late cancellation could not read both
 * PaymentIntents, which leaves that meetup `locked` with the money undecided — the sweeper and the
 * operator's resolution are its recovery — and a deletion that stopped there would leave the account
 * half-disposed with its erasure pending.
 *
 * @param services - The app's services, passed straight to `applyCancellationRules`.
 * @param userId - The account being deleted, and the actor of each cancellation.
 * @param now - The instant the two-hour boundary is judged at.
 * @returns The counters of the meetups this reached.
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
        { event: 'account_deletion_meetup_failed', meetupId, err: error },
        'account_deletion_meetup_failed',
      );
    }
  }

  return counts;
}

/**
 * The meetups the disposition still owns: those in one of {@link OPEN_MEETUP_STATUSES} on either
 * side of the account (AAP 0.5.3).
 *
 * A plain read, taken after the deletion transaction committed, ordered by id so two deletions that
 * reach a meetup they share walk it in the same order. Each id is then resolved under its own meetup
 * lock by `applyCancellationRules`, so this list is a hint rather than a decision: the status it
 * filtered on may have moved by the time the cancellation runs, and that function decides from the
 * locked row.
 *
 * @param services - The app's services, read for the guarded client.
 * @param userId - The account being deleted.
 * @returns The ids, ascending.
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
 * Locks the account's row for the rest of the deletion transaction (AAP 0.5.3).
 *
 * `FOR UPDATE` and not `FOR SHARE`: this transaction is the one that closes the account, so it waits
 * for the mutations already in flight and holds off the ones that would start behind it. Locking this
 * row before the session rows, the claims and the payment operation of the transaction is the order
 * the module documentation states, and it is what `auth/sessions.ts` reads when it resolves the
 * account before it locks a session.
 *
 * Spelled as raw SQL because the row lock has no Prisma client equivalent, and `"user"` quoted
 * because it is a reserved word — the same two notes `plugins/auth.ts` carries for its fence.
 *
 * @param tx - The deletion transaction, which holds the lock until it ends.
 * @param userId - The account being deleted.
 * @returns The locked row, read for `stripe_customer_id` alone.
 * @throws AppError `token_invalid` (401) when no such row exists: the bearer guard admits no session
 *   whose account row is gone, so this names an invariant rather than a case, and it is the answer
 *   the fence gives for a tombstone "the financial purge has removed" (AAP 0.5.2).
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
