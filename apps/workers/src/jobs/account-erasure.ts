/**
 * Account erasure: the job that deletes what is left of a deleted account. It runs after `DELETE /me` and again in a
 * daily sweep, so every deletion completes within 30 days, and it is the only place the account's own rows are removed.
 *
 * Three properties hold throughout. The `user` row stays as a tombstone — every retained financial record and every
 * unchanged aggregate references its id, so counterparts' counters, a lodging's leaderboard score, the completion rate and
 * the retained analytics measures are unaffected. The decision to erase and every write implementing it happen in one
 * transaction between `SELECT … FOR UPDATE` on `user` and the commit, the lock taken in the order the API's own deletion
 * takes (`user` → `lodging_claim` → `call_task`), so the two cannot deadlock. Every statement is a delete-or-update-where
 * whose own predicate takes the rows it removed out of the next run's selection, so a redelivered job changes nothing.
 *
 * Deleted: the `DisclosureProfile` with its tier-3 ciphertext, the `ProfilePhoto`, the account's own `Message`,
 * `ItineraryProof`, `PushToken` and `Session` rows, its `LodgingClaim` rows with their booking ciphertext, its
 * `LodgingVisibility` row, `Block` rows in either direction and its `ExperimentAssignment`. `SpentNullifier` deliberately
 * stays: it carries no user link and survives erasure so a booking cannot be proved twice. Retained as pseudonymous records
 * linked only to the tombstone: `Meetup`, `Deposit`, `PaymentOperation`, `MeetupSettlement`, `TableCreditEntry`,
 * `StripeEvent`, `CheckIn`, `WitnessEvent`, `PairHistory`, `LodgingActivityFact`, `Report`, `Dispute` and
 * `OperatorAccessLog`; their reason text and call metadata age out in `data-expiry`.
 *
 * The analytics unlink is the one update that rewrites rather than removes: a salted actor hash is pseudonymous, not
 * anonymous, and a meetup link reconnects an event to a retained participant, so the events lose `actor_hash`,
 * `assignment_id` and `meetup_id`, `occurred_at` is truncated to the day and `props` is reduced to the measure fields.
 *
 * The one partial outcome: an open dispute is the operator's to settle and the operator has to read the conversation, so
 * the account's own messages on that meetup are kept and `deletedAt` is left null, and the run reports `partial`. The
 * erasure is queued again when that dispute resolves, and the daily sweep finishes anything outstanding, which is what
 * keeps the 30-day limit true even if the re-queue is lost. Nothing here calls a provider, time comes from `ctx.clock`,
 * and no line it writes carries an email address, a handle, a booking field or a message body.
 */

import { Prisma, type DbTx } from '@tablemate/db';
import {
  JOB,
  QUEUE,
  QueuePayloadError,
  actorHash,
  isJobName,
  parseJobData,
} from '@tablemate/server-core';
// `DAY_MS` only: the retention windows belong to `data-expiry`.
import { DAY_MS } from '@tablemate/shared';
import type { CallAttemptState, CallTaskStatus } from '@tablemate/shared';

// Type-only on purpose: `queues.ts` value-imports this file's `process`, so a value import back would close a runtime cycle.
import type { WorkerContext } from '../queues.ts';

const STEP = JOB[QUEUE.accountErasure];
// One transaction deletes every row of one account and holds its `user` row locked throughout, so it gets 60 s rather than the route default of 5: a run past it rolls back whole and is retried, never leaving a half-erased account.
const ERASURE_TRANSACTION_TIMEOUT_MS = 60_000;
// Deletion must complete within 30 days; warning at 25 leaves an operator five days to resolve the open dispute that is the only thing able to hold one unfinished.
const ERASURE_OVERDUE_DAYS = 25;
// A task in one of these has not produced the claim's result; `completed`, `refused`, `do_not_call` and `cancelled` are terminal and are left exactly as they stand.
const OUTSTANDING_TASK_STATUSES = [
  'queued',
  'in_progress',
  'needs_review',
  'unreachable',
] as const satisfies readonly CallTaskStatus[];
// The states in which a call may genuinely be live, so a cancelled task's attempt is marked `superseded` — the signal the API's relay reads before every turn; `dispatch_failed` and `ended` describe a call that is over.
const LIVE_ATTEMPT_STATES = [
  'dispatching',
  'dispatch_unknown',
  'dialing',
  'in_progress',
] as const satisfies readonly CallAttemptState[];
// The two events whose `props` survive the unlink: the claim measures — how many claims were submitted and resolved, and how long resolution took — are read from these two events alone, so their fields have to outlive the account.
const CLAIM_MEASURE_EVENT_NAMES = ['lodging_claim_submitted', 'lodging_claim_resolved'] as const;
const LODGING_VERIFICATION_KIND = 'lodging_stay_verification';
// `erased` and `partial` are the two outcomes that changed data; the other three are the refusals that make the job safe to redeliver. Only `deletionRequestedAt` opens an erasure, so a stray job can never delete a live account.
export type ErasureStatus = 'erased' | 'partial' | 'already_erased' | 'not_requested' | 'missing';
// Every field is filled from the statement that did the work, so the counts are the run's evidence and a second run reports zeros; nothing downstream keys off them.
export interface ErasureCounts {
  readonly disclosureProfilesDeleted: number;
  readonly profilePhotosDeleted: number;
  readonly messagesDeleted: number;
  readonly itineraryProofsDeleted: number;
  readonly pushTokensDeleted: number;
  readonly sessionsDeleted: number;
  readonly lodgingClaimsDeleted: number;
  readonly lodgingVisibilitiesDeleted: number;
  readonly callTasksCancelled: number;
  readonly callAttemptsSuperseded: number;
  readonly blocksDeleted: number;
  readonly experimentAssignmentsDeleted: number;
  readonly analyticsEventsUnlinked: number;
}

// `partial` repeats `status === 'partial'` so a caller can test one field, and it is the only thing the sweep has to read to decide whether an operator is needed.
export interface ErasureResult {
  readonly status: ErasureStatus;
  readonly partial: boolean;
  readonly counts: ErasureCounts;
}

// An account that becomes `already_erased` between the sweep's read and its own run is counted in `processed` alone.
export interface ErasureSweepResult {
  readonly processed: number;
  readonly erased: number;
  readonly partial: number;
}

// BullMQ's `Job`, narrowed to the fields this processor reads: the run is identified by the name and the data it parses, because the same `sweep` is added once a day and the same `erase` may be redelivered.
export interface AccountErasureJob {
  readonly id?: string;
  readonly name: string;
  readonly data: unknown;
}

interface LockedUserRow {
  readonly id: string;
  readonly deletion_requested_at: Date | null;
  readonly deleted_at: Date | null;
}

interface ErasureAttempt {
  readonly status: ErasureStatus;
  readonly counts: ErasureCounts;
}

const NO_COUNTS: ErasureCounts = Object.freeze({
  disclosureProfilesDeleted: 0,
  profilePhotosDeleted: 0,
  messagesDeleted: 0,
  itineraryProofsDeleted: 0,
  pushTokensDeleted: 0,
  sessionsDeleted: 0,
  lodgingClaimsDeleted: 0,
  lodgingVisibilitiesDeleted: 0,
  callTasksCancelled: 0,
  callAttemptsSuperseded: 0,
  blocksDeleted: 0,
  experimentAssignmentsDeleted: 0,
  analyticsEventsUnlinked: 0,
});
function unchanged(status: ErasureStatus): ErasureAttempt {
  return { status, counts: NO_COUNTS };
}

type MutableErasureCounts = { -readonly [K in keyof ErasureCounts]: number };
interface CancelledVerification {
  readonly tasks: number;
  readonly attempts: number;
}

// Erases one account's own records, leaving the tombstone the retained records point at. The status is decided from the locked row, not from an earlier read, so two erasures of the same account cannot both see it open — the second reports `already_erased`. Every API mutation holds `SELECT … FOR SHARE` on that row from the moment it starts, so a writer already in flight commits before this transaction and is erased by it, while one starting later is refused by the deletion fence. An open dispute on one of the account's meetups makes the run `partial`.
export async function eraseUser(ctx: WorkerContext, userId: string): Promise<ErasureResult> {
  const now = ctx.clock.now();
  const attempt = await ctx.db.$transaction(
    async (tx): Promise<ErasureAttempt> => {
      const locked = await lockUserRow(tx, userId);
      if (locked === null) {
        return unchanged('missing');
      }
      if (locked.deleted_at !== null) {
        return unchanged('already_erased');
      }
      if (locked.deletion_requested_at === null) {
        return unchanged('not_requested');
      }
      // Read under the lock, so a dispute that resolves while this transaction waits on the row is seen in its resolved state by this run or by the next one, never counted twice.
      const heldMeetupIds = await openDisputeMeetupIds(tx, userId);
      const counts = await deleteAccountData(tx, ctx, userId, heldMeetupIds);
      const partial = heldMeetupIds.length > 0;
      await tombstoneUser(tx, userId, now, partial);
      return { status: partial ? 'partial' : 'erased', counts };
    },
    { timeout: ERASURE_TRANSACTION_TIMEOUT_MS },
  );
  const result: ErasureResult = {
    status: attempt.status,
    partial: attempt.status === 'partial',
    counts: attempt.counts,
  };
  // Only the two outcomes that changed something are logged: the id and the counts are the whole line, and no email address, handle, booking field or message body is in scope here.
  if (result.status === 'erased' || result.status === 'partial') {
    ctx.logger.info(
      { event: 'erasure_completed', userId, partial: result.partial, ...result.counts },
      'erasure_completed',
    );
  }
  return result;
}

// Locks the account's row for the rest of the erasure transaction and reads the two timestamps the decision is made from: `FOR UPDATE`, not `FOR SHARE`, because this transaction closes the account — it waits for the mutations in flight and holds off the ones behind it; raw SQL because the row lock has no Prisma equivalent, and `"user"` is quoted as reserved.
async function lockUserRow(tx: DbTx, userId: string): Promise<LockedUserRow | null> {
  const rows = await tx.$queryRaw<LockedUserRow[]>(Prisma.sql`
    SELECT "id"::text AS "id",
           "deletion_requested_at" AS "deletion_requested_at",
           "deleted_at" AS "deleted_at"
      FROM "user"
     WHERE "id" = ${userId}::uuid
       FOR UPDATE
  `);
  return rows[0] ?? null;
}

// The account's meetups that still have an open dispute: an open dispute is the operator's to settle and keeps the meetup `locked` with the holds in place, so the account's own messages there are kept until it resolves.
async function openDisputeMeetupIds(tx: DbTx, userId: string): Promise<string[]> {
  const rows = await tx.meetup.findMany({
    where: {
      OR: [{ initiatorId: userId }, { recipientId: userId }],
      disputes: { some: { status: 'open' } },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => row.id);
}

// Deletes the account's own rows and unlinks its analytics events: a `deleteMany` per model, each a no-op when the account has none, which is what makes a second run report zeros. The order is load-bearing twice: the claims' verification tasks are cancelled before the claims, because deleting a claim nulls its tasks' claim link (`onDelete: SetNull`) and such a task could no longer be found, and `lodging_visibility` rows go before their claims.
async function deleteAccountData(
  tx: DbTx,
  ctx: WorkerContext,
  userId: string,
  heldMeetupIds: readonly string[],
): Promise<ErasureCounts> {
  const counts: MutableErasureCounts = { ...NO_COUNTS };
  // A claim still in the table is the rare case — `DELETE /me` deletes them in its own transaction — that the operator path and the sweep can reach when a failure separates the two transactions, so it is handled here rather than assumed away.
  const claims = await tx.lodgingClaim.findMany({ where: { userId }, select: { id: true } });
  const claimIds = claims.map((claim) => claim.id);
  const cancelled = await cancelClaimVerification(tx, claimIds);
  counts.callTasksCancelled = cancelled.tasks;
  counts.callAttemptsSuperseded = cancelled.attempts;
  counts.lodgingVisibilitiesDeleted = (
    await tx.lodgingVisibility.deleteMany({
      where: { OR: [{ userId }, { lodgingClaimId: { in: claimIds } }] },
    })
  ).count;
  counts.lodgingClaimsDeleted = (await tx.lodgingClaim.deleteMany({ where: { userId } })).count;
  // The account's own messages only: a counterpart's stay in the counterpart's history, and one this account sent on a meetup an open dispute still holds is kept too, because the operator settling it has to read the conversation.
  counts.messagesDeleted = (
    await tx.message.deleteMany({
      where: {
        senderId: userId,
        ...(heldMeetupIds.length === 0 ? {} : { meetupId: { notIn: [...heldMeetupIds] } }),
      },
    })
  ).count;
  counts.itineraryProofsDeleted = (await tx.itineraryProof.deleteMany({ where: { userId } })).count;
  counts.disclosureProfilesDeleted = (
    await tx.disclosureProfile.deleteMany({ where: { userId } })
  ).count;
  counts.profilePhotosDeleted = (await tx.profilePhoto.deleteMany({ where: { userId } })).count;
  counts.pushTokensDeleted = (await tx.pushToken.deleteMany({ where: { userId } })).count;
  counts.sessionsDeleted = (await tx.session.deleteMany({ where: { userId } })).count;
  counts.experimentAssignmentsDeleted = (
    await tx.experimentAssignment.deleteMany({ where: { userId } })
  ).count;
  counts.blocksDeleted = (
    await tx.block.deleteMany({ where: { OR: [{ blockerId: userId }, { blockedId: userId }] } })
  ).count;
  counts.analyticsEventsUnlinked = await unlinkAnalyticsEvents(tx, ctx.env.ANALYTICS_SALT, userId);
  return counts;
}

// Cancels the verification work a remaining claim still has outstanding — the rule the API's deletion and the `lodging-claims` job apply too: exactly the tasks that have not produced a result are cancelled, and their attempts in a possibly live state are marked `superseded`, the signal the API's voice relay reads to end the call. The kind is stated as well as the claim id, so this cannot cancel anything the claim does not own.
async function cancelClaimVerification(
  tx: DbTx,
  claimIds: readonly string[],
): Promise<CancelledVerification> {
  if (claimIds.length === 0) {
    return { tasks: 0, attempts: 0 };
  }
  const tasks = await tx.callTask.findMany({
    where: {
      lodgingClaimId: { in: [...claimIds] },
      kind: LODGING_VERIFICATION_KIND,
      status: { in: [...OUTSTANDING_TASK_STATUSES] },
    },
    select: { id: true },
  });
  if (tasks.length === 0) {
    return { tasks: 0, attempts: 0 };
  }
  const taskIds = tasks.map((task) => task.id);
  const cancelled = await tx.callTask.updateMany({
    where: { id: { in: taskIds } },
    data: { status: 'cancelled' },
  });
  const superseded = await tx.callAttempt.updateMany({
    where: {
      callTaskId: { in: taskIds },
      state: { in: [...LIVE_ATTEMPT_STATES] },
      superseded: false,
    },
    data: { superseded: true },
  });
  return { tasks: cancelled.count, attempts: superseded.count };
}

// Unlinks the account's analytics events, keeping the measures they feed. `actorHash` is HMAC-SHA256 of the user id under `ANALYTICS_SALT` — pseudonymous, not anonymous — and `meetupId` reconnects an event to two retained participants, so both go, with `assignmentId`, the `occurredAt` truncated to the day and `props` reduced to the measure fields. One statement, with the actor hash itself as the predicate.
async function unlinkAnalyticsEvents(tx: DbTx, salt: string, userId: string): Promise<number> {
  return tx.$executeRaw(Prisma.sql`
    UPDATE "analytics_event"
       SET "actor_hash" = NULL,
           "assignment_id" = NULL,
           "meetup_id" = NULL,
           "occurred_at" = date_trunc('day', "occurred_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
           "props" = jsonb_strip_nulls(jsonb_build_object(
             'variantPairing', "props"->'variantPairing',
             'depositCents', "props"->'depositCents',
             'outcome',
             CASE WHEN "name" = ANY(${CLAIM_MEASURE_EVENT_NAMES}::text[]) THEN "props"->'outcome' END,
             'resolveSeconds',
             CASE
               WHEN "name" = ANY(${CLAIM_MEASURE_EVENT_NAMES}::text[])
               THEN "props"->'resolveSeconds'
             END
           ))
     WHERE "actor_hash" = ${actorHash(salt, userId)}
  `);
}

// Turns the account's row into the tombstone the retained records point at: every personal field the API can write goes to null — the email ciphertext and lookup hash, the handle and avatar seed, the home city and country, the age-gate and terms stamps and the Stripe customer id, safe to drop because the `delete_customer` operation carries its own copy. The role and the row's timestamps are not personal data and stay. `deletedAt` is set only when nothing is holding the erasure open: setting it makes the run complete and a redelivery a no-op, and leaving it unset keeps the account visible to the next sweep.
async function tombstoneUser(tx: DbTx, userId: string, now: Date, partial: boolean): Promise<void> {
  await tx.user.update({
    where: { id: userId },
    data: {
      emailCiphertext: null,
      emailLookupHash: null,
      handle: null,
      avatarSeed: null,
      homeCity: null,
      homeCountryCode: null,
      ageConfirmedAt: null,
      termsVersion: null,
      stripeCustomerId: null,
      ...(partial ? {} : { deletedAt: now }),
    },
  });
}

// Erases every account whose deletion has been requested and not yet completed: the backstop that makes the 30-day limit true rather than likely, because the `account_erasure` outbox row `DELETE /me` writes and the row the operator path writes can both be lost and a sweep reading the requests themselves needs neither. Accounts are taken oldest first, and each is erased through {@link eraseUser}, which decides everything from its own locked row — this read is a work list, not an authority. A run warns for each account still unfinished at {@link ERASURE_OVERDUE_DAYS} days: an open dispute holds it and only the operator can resolve it.
export async function sweepPendingErasures(ctx: WorkerContext): Promise<ErasureSweepResult> {
  const now = ctx.clock.now();
  const overdueBefore = new Date(now.getTime() - ERASURE_OVERDUE_DAYS * DAY_MS);
  const pending = await ctx.db.user.findMany({
    where: { deletionRequestedAt: { not: null }, deletedAt: null },
    select: { id: true, deletionRequestedAt: true },
    orderBy: { deletionRequestedAt: 'asc' },
  });
  let erased = 0;
  let partial = 0;
  let overdue = 0;
  for (const account of pending) {
    const result = await eraseUser(ctx, account.id);
    const requestedAt = account.deletionRequestedAt;
    if (result.status === 'erased') {
      erased += 1;
    } else if (result.status === 'partial') {
      partial += 1;
    }
    if (result.status === 'partial' && requestedAt !== null && requestedAt <= overdueBefore) {
      overdue += 1;
      // An id, a day count and nothing else: a log line is not the place for what remains of the account.
      ctx.logger.warn(
        {
          event: 'erasure_overdue',
          userId: account.id,
          days: elapsedDays(now, requestedAt),
        },
        'erasure_overdue',
      );
    }
  }
  const result: ErasureSweepResult = { processed: pending.length, erased, partial };
  ctx.logger.info({ event: 'erasure_sweep', ...result, overdue }, 'account-erasure sweep complete');
  return result;
}

// Whole days between `since` and `now`, truncated rather than rounded, so the warning fires on the day the 25 days have genuinely passed.
function elapsedDays(now: Date, since: Date): number {
  return Math.floor((now.getTime() - since.getTime()) / DAY_MS);
}

// The `account-erasure` queue's processor: one account per `erase` job, one sweep per `sweep` job. The job name is narrowed with `isJobName` before the data is parsed, so an unknown name fails here rather than reaching an erasure, and `erase` is idempotent on the account rather than on the outbox row — a redelivered job finds `deletedAt` set and reports `already_erased` with zeros.
export async function process(
  job: AccountErasureJob,
  ctx: WorkerContext,
): Promise<ErasureResult | ErasureSweepResult> {
  const queue = QUEUE.accountErasure;
  const { name } = job;
  if (!isJobName(queue, name)) {
    throw new QueuePayloadError(`${queue}/${name}`);
  }
  if (name === STEP.sweep) {
    parseJobData(queue, STEP.sweep, job.data);
    return sweepPendingErasures(ctx);
  }
  const { userId } = parseJobData(queue, STEP.erase, job.data);
  return eraseUser(ctx, userId);
}
