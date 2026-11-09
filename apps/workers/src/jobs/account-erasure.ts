/**
 * Account erasure: the job that deletes what is left of a deleted account (AAP 0.5.2, 0.5.3).
 *
 * AAP 0.5.2 gives every user-linked record a disposition and names `account-erasure` as the job that carries out the
 * deletions: it runs immediately after `DELETE /me` and again in a daily sweep, so every deletion completes within 30
 * days. The API has already done its half by the time this job runs — it set `deletionRequestedAt`, revoked every
 * session, deleted the account's lodging claims, planned the `delete_customer` `PaymentOperation`, applied the
 * cancellation rules to the open meetups and wrote the `account_erasure` outbox row this job is delivered as. This
 * module is the other half, and the only place the account's own rows are removed.
 *
 * Three properties hold across everything it does:
 *
 *   - A tombstone, not a deleted account: the `user` row stays, carrying its id and, once the erasure is complete,
 *     `deletedAt`, because every retained financial record in AAP 0.5.2 references that id, so counterparts'
 *     reputation counters, a lodging's historical leaderboard score, the dashboard's completion rate and every
 *     retained analytics measure are unchanged by an erasure.
 *   - One transaction, with the account's row locked first: the decision to erase and every write that implements it
 *     happen between `SELECT … FOR UPDATE` on `user` and the commit, so a second `erase` job, a concurrent sweep and
 *     an API mutation serialized behind the auth fence cannot interleave with it. The lock is taken in the order the
 *     API's deletion takes (`user` → `lodging_claim` → `call_task`, AAP 0.5.3), so the two cannot deadlock.
 *   - Idempotent, and never a partial account: every statement is a delete-or-update-where whose own predicate takes
 *     the rows it removed out of the next run's selection, so a redelivered job changes nothing and reports zeros.
 *
 * What it deletes, which is the list of AAP 0.5.2: the `DisclosureProfile` with its tier-3 ciphertext, the
 * `ProfilePhoto`, the account's own `Message` rows, its `ItineraryProof` rows, its `PushToken` rows, its `Session`
 * rows, its `LodgingClaim` rows with their booking ciphertext, its `LodgingVisibility` row, `Block` rows in either
 * direction and its `ExperimentAssignment`. `SpentNullifier` deliberately stays: it carries no user link and survives
 * account erasure so a booking cannot be proved twice (AAP 0.5.2).
 *
 * What it does not touch: `Meetup`, `Deposit`, `PaymentOperation`, `MeetupSettlement`, `TableCreditEntry`,
 * `StripeEvent`, `CheckIn`, `WitnessEvent`, `PairHistory`, `LodgingActivityFact`, `Report`, `Dispute` and
 * `OperatorAccessLog`. They are retained as pseudonymous records linked only to the tombstone; their reason text and
 * the call metadata beside them age out in `data-expiry`, and the seven-year financial purge removes what it must
 * (AAP 0.5.2).
 *
 * The analytics unlink is the one update that rewrites rather than removes (AAP 0.5.2, "Unlinked on erasure"): a
 * salted actor hash is pseudonymous, not anonymous, and a meetup link reconnects an event to a retained participant,
 * so the deleted account's events lose `actor_hash`, `assignment_id` and `meetup_id`, their `occurred_at` is
 * truncated to the day, and `props` is reduced to the measure fields. `name`, `city_id` and `variant` are kept, which
 * leaves the signup count, the funnel stages and the claim measures exactly as they were.
 *
 * The one partial outcome: a meetup with an open dispute is the operator's to settle and the operator has to read the
 * conversation on it, so the account's own messages on that meetup are kept and `deletedAt` is left null — the run
 * reports `partial` rather than pretending the account is erased. The erasure is queued again when the last open
 * dispute resolves, and the daily sweep finishes any that is still outstanding, which is what keeps the 30-day limit
 * true even if that re-queue is lost. A pending erasure is the only thing the sweep warns about, at 25 days.
 *
 * Nothing here calls a provider: the Stripe customer is deleted by the API's `PaymentOperation` executor, not by this
 * process, which is why the erasure still completes while Stripe, Twilio, the language model and Overpass are all
 * unreachable (AAP 0.3.2). Time comes from `ctx.clock` (AAP 0.11.1), and no line it writes carries an email address,
 * a handle, a booking field or a message body.
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
// `DAY_MS` only: the two windows below are the sweep's 25-day warning and nothing else, and the
// retention windows belong to `data-expiry` (AAP 0.5.2, 0.5.6).
import { DAY_MS } from '@tablemate/shared';
import type { CallAttemptState, CallTaskStatus } from '@tablemate/shared';

// Type-only on purpose, exactly as every other job in this directory: `queues.ts` value-imports
// this file's `process`, so a value import back would close a runtime cycle. Erased on emit.
import type { WorkerContext } from '../queues.ts';

/**
 * This file's queue and its two job names, read from `packages/server-core/src/queues/names.ts` —
 * the one place either is written down, so a rename there reaches this processor too (AAP 0.5.6).
 */
const STEP = JOB[QUEUE.accountErasure];

/**
 * How long the erasure transaction may run before PostgreSQL rolls it back (AAP 0.5.3). One transaction deletes every
 * row of one account and locks its `user` row throughout, so it is heavier than a domain transition and gets its own
 * budget; the default of five seconds is meant for a route. A run that exceeds it rolls back whole and is retried by
 * the queue or the next sweep, so the transaction never leaves a half-erased account.
 */
const ERASURE_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * How long a requested erasure may stay unfinished before the sweep warns (AAP 0.5.2).
 *
 * Deletion must complete within 30 days; warning at 25 leaves an operator five days to resolve the
 * open dispute that is holding it, which is the only thing that can leave one partial.
 */
const ERASURE_OVERDUE_DAYS = 25;

/**
 * The call-task statuses a deleted account's claim cancels: a task that is `queued`, `in_progress`,
 * `needs_review` or `unreachable` has not produced the claim's result (AAP 0.5.3). `completed`,
 * `refused`, `do_not_call` and `cancelled` are terminal and are left exactly as they stand.
 */
const OUTSTANDING_TASK_STATUSES = [
  'queued',
  'in_progress',
  'needs_review',
  'unreachable',
] as const satisfies readonly CallTaskStatus[];

/**
 * The attempt states in which a call may genuinely be live, so a cancelled task's attempt is marked
 * `superseded`: the API's relay checks its task before every turn and speaks its closing line
 * (AAP 0.5.3). `dispatch_failed` and `ended` describe a call that is over.
 */
const LIVE_ATTEMPT_STATES = [
  'dispatching',
  'dispatch_unknown',
  'dialing',
  'in_progress',
] as const satisfies readonly CallAttemptState[];

/**
 * The two events whose `props` survive the unlink (AAP 0.5.2).
 *
 * The claim measures — how many claims were submitted and resolved, and how long resolution took —
 * are read from these two events alone, because no retained meetup fact carries them, so their
 * `outcome` and `resolveSeconds` fields have to outlive the account that produced them.
 */
const CLAIM_MEASURE_EVENT_NAMES = ['lodging_claim_submitted', 'lodging_claim_resolved'] as const;

/** The one task kind a lodging claim owns (AAP 0.5.3, 0.5.6). */
const LODGING_VERIFICATION_KIND = 'lodging_stay_verification';

/**
 * What one attempt at erasing an account found (AAP 0.5.2, 0.5.3).
 *
 * `erased` and `partial` are the two outcomes that changed data; the other three are the refusals that make the job
 * safe to redeliver, each a no-op by construction: `missing` is no such account, a tombstone the seven-year financial
 * purge removed; `already_erased` is `deletedAt` set, so the work is done; and `not_requested` is an active account,
 * because `deletionRequestedAt` alone opens the erasure and a stray job can never delete a live account.
 */
export type ErasureStatus = 'erased' | 'partial' | 'already_erased' | 'not_requested' | 'missing';

/**
 * What one erasure removed or rewrote, counted in rows (AAP 0.5.2). Every field is filled from the statement that did
 * the work, so the counts are the run's evidence and a second run reports zeros; they are logged and asserted on, and
 * nothing downstream keys off them.
 */
export interface ErasureCounts {
  /** `DisclosureProfile` rows deleted, the tier-1..3 fields including the tier-3 ciphertext. */
  readonly disclosureProfilesDeleted: number;
  /** `ProfilePhoto` rows deleted. */
  readonly profilePhotosDeleted: number;
  /** The account's own `Message` rows deleted. A message on an open-dispute meetup is kept. */
  readonly messagesDeleted: number;
  /** `ItineraryProof` rows deleted. `SpentNullifier` is deliberately untouched. */
  readonly itineraryProofsDeleted: number;
  /** `PushToken` rows deleted. */
  readonly pushTokensDeleted: number;
  /** `Session` and refresh-token rows deleted. */
  readonly sessionsDeleted: number;
  /** `LodgingClaim` rows deleted, taking their booking ciphertext with them. */
  readonly lodgingClaimsDeleted: number;
  /** `LodgingVisibility` rows deleted, by owner and by claim. */
  readonly lodgingVisibilitiesDeleted: number;
  /** Still-outstanding verification tasks cancelled with their claim (AAP 0.5.3). */
  readonly callTasksCancelled: number;
  /** Live attempts of those tasks marked `superseded`, which is how the relay is told to stop. */
  readonly callAttemptsSuperseded: number;
  /** `Block` rows deleted, in either direction. */
  readonly blocksDeleted: number;
  /** `ExperimentAssignment` rows deleted. The framing experiment is never re-run for a tombstone. */
  readonly experimentAssignmentsDeleted: number;
  /** `AnalyticsEvent` rows unlinked: the pseudonymous re-identifiers removed, the measures kept. */
  readonly analyticsEventsUnlinked: number;
}

/**
 * What one `erase` job reports (AAP 0.5.2, 0.5.3): `partial` repeats `status === 'partial'` so a caller can test one
 * field, and it is the only thing the sweep has to read to decide whether an operator is needed.
 */
export interface ErasureResult {
  /** What the attempt found, and what it did with it. */
  readonly status: ErasureStatus;
  /** True only for {@link ErasureStatus} `partial`: an open dispute still holds the erasure open. */
  readonly partial: boolean;
  /** What was removed, counted in rows; all zeros for a no-op. */
  readonly counts: ErasureCounts;
}

/**
 * What one daily sweep reports, which is also what its log line carries (AAP 0.5.2): `processed` counts the accounts
 * the sweep tried, `erased` those it finished and `partial` those an open dispute still holds. An account that
 * becomes `already_erased` between the read and its own run is counted in `processed` alone.
 */
export interface ErasureSweepResult {
  /** How many accounts the sweep selected and ran an erasure for. */
  readonly processed: number;
  /** How many of them are now complete, with `deletedAt` set. */
  readonly erased: number;
  /** How many of them are still held open by an open dispute on one of their meetups. */
  readonly partial: number;
}

/**
 * The `account-erasure` job as a processor receives it: BullMQ's `Job`, narrowed to the fields this processor reads.
 * `id` is part of the accepted shape so the worker entry point can hand its own `Job` straight in, while the run is
 * identified by the name and the data it parses, because the same `sweep` is added once a day and the same `erase` may
 * be redelivered (AAP 0.3.2).
 */
export interface AccountErasureJob {
  /** The BullMQ job id; accepted for structural compatibility, not read (see the interface's note). */
  readonly id?: string;
  /** The job name: `erase` or `sweep`, exactly as `names.ts` declares them. */
  readonly name: string;
  /** The job data, unparsed: `{ outboxId, userId }` or `{}`, validated before it is used. */
  readonly data: unknown;
}

/** The row {@link lockUserRow} locks, as the locking read returns it. */
interface LockedUserRow {
  readonly id: string;
  readonly deletion_requested_at: Date | null;
  readonly deleted_at: Date | null;
}

/** An erasure in progress: the decision and the counts, before the result is built. */
interface ErasureAttempt {
  readonly status: ErasureStatus;
  readonly counts: ErasureCounts;
}

/** Zero counts, for the three attempts that removed nothing (AAP 0.5.2). */
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

/** An attempt that changed nothing, with the reason it did not. */
function unchanged(status: ErasureStatus): ErasureAttempt {
  return { status, counts: NO_COUNTS };
}

/** The counts while they are being filled in; frozen into {@link ErasureCounts} at the end. */
type MutableErasureCounts = { -readonly [K in keyof ErasureCounts]: number };

/** What {@link cancelClaimVerification} cancelled, for the two call-related counters. */
interface CancelledVerification {
  readonly tasks: number;
  readonly attempts: number;
}

/**
 * Erases one account's own records, leaving the tombstone the retained records point at (AAP 0.5.2, 0.5.3).
 *
 * The whole erasure is one transaction that locks the account's `user` row first, which is what makes it safe to
 * redeliver and safe to run beside the API: the status is decided from the locked row, not from an earlier read, so
 * two erasures of the same account cannot both see it as open and the second reports `already_erased`; every API
 * mutation holds `SELECT … FOR SHARE` on that same row from the moment it starts, so a writer already in flight
 * commits before this transaction runs — and is erased by it — while one starting later is refused by the deletion
 * fence; and nothing in it reaches a provider, so an erasure completes while every provider is unreachable.
 *
 * A run that finds an open dispute on one of the account's meetups is `partial`: the operator has to settle that
 * meetup and read the conversation on it, so the account's own messages there are kept and `deletedAt` is left unset.
 * The erasure is queued again when that last dispute resolves, and the daily sweep would finish it regardless.
 */
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
      // Read under the lock, so a dispute that resolves while this transaction waits on the row is
      // seen in its resolved state by this run or by the next one, never counted twice.
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
  // Only the two outcomes that changed something are logged (AAP 0.11.1, "Erasure completion"). The
  // id and the counts are the whole line: no email address, handle, booking field or message body is
  // in scope here, and none of them is in the counts.
  if (result.status === 'erased' || result.status === 'partial') {
    ctx.logger.info(
      { event: 'erasure_completed', userId, partial: result.partial, ...result.counts },
      'erasure_completed',
    );
  }
  return result;
}

/**
 * Locks the account's row for the rest of the erasure transaction, and reads the two timestamps the decision is made
 * from (AAP 0.5.3).
 *
 * `FOR UPDATE` and not `FOR SHARE`, because this transaction is the one that closes the account: it waits for the
 * mutations already in flight and holds off the ones that would start behind it. The two columns are read from the
 * locked row rather than from an earlier statement, so the decision and the lock cannot disagree. It is spelled as
 * raw SQL because the row lock has no Prisma client equivalent, and `"user"` is quoted because it is a reserved word.
 */
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

/**
 * The account's meetups that still have an open dispute (AAP 0.5.3). An open dispute is the operator's to settle and
 * it keeps the meetup `locked` with the holds in place, so the account's own messages on that meetup are the record
 * of what was said: they are kept until it resolves, and their presence is what makes the run `partial`.
 */
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

/**
 * Deletes the account's own rows and unlinks its analytics events (AAP 0.5.2).
 *
 * The order inside the transaction is load-bearing in two places: the claims' verification tasks are cancelled before
 * the claims are deleted, because deleting a claim nulls its tasks' claim link (`onDelete: SetNull`) and a task that
 * had lost its link could no longer be found by the claim it belonged to; and `lodging_visibility` rows are deleted
 * before their claims, so the visibility is gone whether the row is reached by its owner or by its claim.
 *
 * Everything after those two is independent — a `deleteMany` per model, each a no-op when the account has none, which
 * is what makes a second run report zeros. The retained models of AAP 0.5.2 are deliberately absent from this list.
 */
async function deleteAccountData(
  tx: DbTx,
  ctx: WorkerContext,
  userId: string,
  heldMeetupIds: readonly string[],
): Promise<ErasureCounts> {
  const counts: MutableErasureCounts = { ...NO_COUNTS };
  // A claim still in the table is the rare case: `DELETE /me` deletes them in its own transaction
  // (`deleteClaimsForAccount`, AAP 0.5.3). The second `DELETE /me`-less path into this job — an
  // operator resolving the account's last dispute, or the sweep — can still leave one behind if the
  // API's transaction and this one are separated by a failure, so it is handled here rather than
  // assumed away.
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
  // The account's own messages only: a message the counterpart sent stays in the counterpart's
  // history, which is what AAP 0.5.2 means by "Messages written by the counterpart stay in the
  // counterpart's history". A message this account sent on a meetup an open dispute still holds is
  // kept as well, because the operator settling it has to read the conversation.
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

/**
 * Cancels the verification work a remaining claim still has outstanding (AAP 0.5.3).
 *
 * The same rule the API's deletion and the `lodging-claims` job apply: exactly the tasks that have not produced a
 * result are cancelled, and their attempts in a possibly live state are marked `superseded`, which is the signal the
 * API's voice relay reads to speak its closing line and end the call; `completed`, `refused`, `do_not_call` and
 * `cancelled` are terminal and are left exactly as they stand.
 *
 * `lodgingClaimId` alone would select them — the one-target check ties a claim to a lodging task — but the kind is
 * stated as well so this cannot cancel anything the claim does not own.
 */
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

/**
 * Unlinks the account's analytics events, keeping the measures they feed (AAP 0.5.2).
 *
 * `actorHash` is HMAC-SHA256 of the user id under `ANALYTICS_SALT` — pseudonymous, not anonymous — and `meetupId`
 * reconnects an event to two retained participants, so both go, with `assignmentId`, the `occurredAt` truncated to
 * the day, and `props` reduced to the measure fields. What is kept is what the unchanged aggregates are computed
 * from: `name`, `cityId`, `variant`, and inside `props` the funnel fields plus the two claim measures. Everything
 * else in `props` — a place reference, and anything a future event adds — is dropped rather than kept by default.
 *
 * One statement, and the predicate is the actor hash itself, so the second run matches nothing.
 */
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

/**
 * Turns the account's row into the tombstone the retained records point at (AAP 0.5.2).
 *
 * Every personal field the API can write goes to null — the email's ciphertext and lookup hash, the handle and avatar
 * seed, the home city and country, the age-gate and terms stamps and the Stripe customer id, safe to drop here
 * because the `delete_customer` operation planned by the API's deletion carries its own copy (AAP 0.5.3). The role and
 * the row's timestamps are not personal data and stay as they are.
 *
 * `deletedAt` is set only when nothing is holding the erasure open: setting it is what makes the run complete and a
 * redelivery a no-op, and leaving it unset is what makes the account visible to the next sweep, which is what the
 * erasure queued when the last open dispute resolves comes back for.
 */
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

/**
 * Erases every account whose deletion has been requested and not yet completed (AAP 0.5.2).
 *
 * This is the backstop that makes the 30-day limit true rather than likely. The normal path is the `account_erasure`
 * outbox row `DELETE /me` writes, and the second is the row the operator path writes when the last open dispute on a
 * deleted account resolves; either can be lost, and a daily sweep that reads the requests themselves needs neither of
 * them.
 *
 * The accounts are taken oldest first, so an operator's oldest commitment to a user is the first thing the run spends
 * its work on, and each is erased through {@link eraseUser}, which decides everything from its own locked row: this
 * read is a work list, not an authority, and an account that moved between the two is reported as such rather than
 * erased twice.
 *
 * A run warns for each account still unfinished at {@link ERASURE_OVERDUE_DAYS} days, because that is the one case a
 * person has to act on: an open dispute holds the erasure, only the operator can resolve it, and five days are left
 * before the 30-day limit is missed (AAP 0.5.3).
 */
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
      // An id, a day count and nothing else: the account's fields are gone or about to be, and a log
      // line is not the place for what remains of them (AAP 0.11.1).
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
  // The overdue count rides the sweep's own line as well, so an operator reading the run sees both
  // the work it did and the accounts that need a human (AAP 0.11.1, 0.5.7).
  ctx.logger.info({ event: 'erasure_sweep', ...result, overdue }, 'account-erasure sweep complete');
  return result;
}

/**
 * Whole days between `since` and `now`, for the sweep's overdue line (AAP 0.5.2): truncating rather than rounding, so
 * the warning fires on the day the 25 days have genuinely passed. Both instants come from the injected clock and the
 * stored row, so a test that advances the clock by exactly 25 days sees the warning.
 */
function elapsedDays(now: Date, since: Date): number {
  return Math.floor((now.getTime() - since.getTime()) / DAY_MS);
}

/**
 * The `account-erasure` queue's processor (AAP 0.5.6): one account per `erase` job, one sweep per `sweep` job.
 *
 * The job name is narrowed with `isJobName` before the data is parsed: an unknown name fails here rather than reaching
 * an erasure, and a job whose data does not match its own schema is refused the same way. Dispatching on the narrowed
 * name keeps the two payload shapes apart — `erase` carries the account, `sweep` carries nothing.
 *
 * `erase` is idempotent on the account rather than on the outbox row: a redelivered job whose account is already
 * erased finds `deletedAt` set and reports `already_erased` with zeros, which is why no per-row bookkeeping is needed
 * on either side of the queue.
 */
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
    // The sweep carries no data; the parse is what refuses a job that carries any.
    parseJobData(queue, STEP.sweep, job.data);
    return sweepPendingErasures(ctx);
  }
  const { userId } = parseJobData(queue, STEP.erase, job.data);
  return eraseUser(ctx, userId);
}
