/**
 * Retention enforcement: the hourly `data-expiry` step and its daily 03:00 UTC financial step
 * (AAP 0.5.2, 0.5.6).
 *
 * AAP 0.5.2 gives every record a retention rule and names `data-expiry` as the job that enforces it;
 * AAP 0.5.6 runs that job hourly, with the financial-retention purge in a daily step at 03:00 UTC.
 * This module is the whole of it: {@link runHourlyExpiry} applies the sub-daily rules and
 * {@link runDailyExpiry} the four that only run once a day. `account-erasure` deletes an account's
 * own rows at its request; this job owns everything that ages by time.
 *
 * The hourly rules, in the order they run — the first two share one run, which is what AAP 0.5.2 and
 * 0.12.2 ask for:
 *
 *   1. Booking details. A `LodgingClaim` that has resolved loses its encrypted booking name and
 *      reference and gets its `details_erased_at`, which is the 24-hour limit criterion 14 measures.
 *   2. The same run strips that claim's lodging call rows: its callbacks, its attempts' content and
 *      the task's claim link, in one transaction per batch, so a later Twilio callback matches
 *      nothing and is acknowledged without effect.
 *   3. Menu-call transcripts at 30 days — the only call content ever stored.
 *   4. Magic links: an expired token whose ciphertext was never cleared has it nulled, and the row is
 *      purged 24 hours after expiry.
 *   5. Sessions 24 hours after expiry.
 *   6. Call metadata at 365 days: terminal `menu_prices` tasks and stripped lodging tasks, with their
 *      attempts. Counts and spend stay in `call_budget_day`.
 *   7. Report and resolved-dispute reason text at 180 days; an open dispute keeps its text.
 *   8. `OperatorAccessLog` at 365 days.
 *   9. `LodgingActivityFact` at 120 days, past the 90-day leaderboard window.
 *
 * The daily rules run from `now - FINANCIAL_RETENTION_DAYS` (2,557 days, seven years):
 *
 *  10. The financial purge. A meetup finalised before the cut-off loses its deposits, payment
 *      operations, settlement, credit entries, check-ins, messages and disputes; the kept rows are
 *      unlinked from it (`witness_event.meetup_id` and `report.meetup_id` are nulled); its activity
 *      facts go; and last the meetup itself. A terminal `delete_customer` operation with no deposit
 *      goes with it, because it would otherwise keep a tombstone referenced forever.
 *  11. `StripeEvent` rows older than the same cut-off, where the webhook dedupe window ends.
 *  12. Tombstone-owned reputation rows: a `witness_event` with no meetup whose user is erased, and a
 *      `pair_history` row inactive past the cut-off with an erased member. A row that still counts
 *      for a live account is never deleted, because counters never decay (AAP 0.5.2).
 *  13. A tombstone no retained record references, so an erased account does not outlive the last row
 *      that needed its id.
 *
 * Four invariants hold across every rule:
 *
 *   - Time comes from `ctx.clock`, never from SQL `now()`: every cut-off is computed in Node and
 *     bound as a parameter, so the test clock moves every rule at once (AAP 0.11.1).
 *   - Every rule is a delete-or-update-where whose own predicate the write takes the row out of, so a
 *     second run of the same step changes nothing and reports zeros (AAP 0.3.2).
 *   - Bulk deletes and strips take {@link DELETE_BATCH_SIZE} rows per statement, so a run over a
 *     large backlog holds bounded statements and a bounded transaction.
 *   - Every statement is a tagged template over the guarded client: identifiers double-quoted
 *     (`"user"` is reserved), values bound, no string interpolation (AAP 0.11.2). Nothing here calls
 *     Stripe, Twilio, Overpass, a language model or any other provider, which is what keeps retention
 *     working while every one of them is unreachable (AAP 0.3.2).
 *
 * @see AAP 0.5.2 for each rule and its window, 0.5.6 for the cadences, 0.12.2 for the stripped shape
 *   this module must produce, 0.5.3 for the claim and call-task states it reads, 0.11.1 for the clock,
 *   and 0.8.1 for this file.
 */

import type { DbClient, RawSqlClient } from '@tablemate/db';
import { JOB, QUEUE, QueuePayloadError, isJobName, parseJobData } from '@tablemate/server-core';
import { DAY_MS, HOUR_MS } from '@tablemate/shared';
import type { CallTaskStatus, LodgingClaimStatus, PaymentOperationStatus } from '@tablemate/shared';

import type { WorkerContext } from '../queues.ts';

/**
 * The queue this file processes, and the two step names it dispatches on. Read from
 * `packages/server-core/src/queues/names.ts`, the one place either is written down, so a rename there
 * reaches this processor too (AAP 0.5.6).
 */
const STEP = JOB[QUEUE.dataExpiry];

// ---------------------------------------------------------------------------------------------
// Windows, batch size and the statuses each rule treats as finished
// ---------------------------------------------------------------------------------------------

/**
 * The rows one bulk statement takes (AAP 0.5.2). A rule with a large backlog runs its statement once
 * per batch instead of once over everything, so a run holds bounded statements and a bounded
 * transaction however much data is due.
 */
const DELETE_BATCH_SIZE = 1_000;

/** How long a `menu_prices` call transcript is kept, the only call content ever stored (AAP 0.5.2). */
const TRANSCRIPT_RETENTION_DAYS = 30;

/** The grace after a magic-link token's expiry before its row is purged (AAP 0.5.2). */
const MAGIC_LINK_PURGE_GRACE_HOURS = 24;

/**
 * The grace after a session's expiry before its row is purged (AAP 0.5.2). A session lives 30 days
 * (`REFRESH_TOKEN_TTL_DAYS`), so the rule covers the expired rows; a revoked but unexpired row keeps
 * its place until its expiry passes.
 */
const SESSION_PURGE_GRACE_HOURS = 24;

/** How long call, cap and spend metadata is kept for the call metrics (AAP 0.5.2). */
const CALL_METADATA_RETENTION_DAYS = 365;

/** How long report and dispute reason text is kept for safety and payment disputes (AAP 0.5.2). */
const REASON_RETENTION_DAYS = 180;

/** How long the operator's booking-detail access log is kept (AAP 0.5.2). */
const OPERATOR_ACCESS_LOG_RETENTION_DAYS = 365;

/** How long a lodging's activity fact is kept, past the 90-day leaderboard window (AAP 0.5.2, 0.5.7). */
const LODGING_ACTIVITY_FACT_RETENTION_DAYS = 120;

/**
 * The id a tombstone page starts before: the all-zero UUID, which no generated id is, so
 * `"id" > ${FIRST_UUID}` selects from the first row in uuid order.
 */
const FIRST_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * A lodging claim in one of these states has resolved, so its booking details are erased and its
 * lodging call rows are stripped (AAP 0.5.2, 0.5.3). A claim still `pending_call` or `calling` is
 * live: its call may be running and its details are what a manual verification call needs.
 */
const TERMINAL_CLAIM_STATUSES: readonly LodgingClaimStatus[] = [
  'verified',
  'rejected',
  'unreachable',
];

/**
 * A call task in one of these states has finished, so the 365-day rule ages it by its last activity
 * (AAP 0.5.2, 0.5.3). `queued`, `in_progress` and `needs_review` are still work: they wait for a
 * dispatch or for an operator.
 */
const TERMINAL_TASK_STATUSES: readonly CallTaskStatus[] = [
  'completed',
  'refused',
  'do_not_call',
  'unreachable',
  'cancelled',
];

/**
 * A `delete_customer` operation in one of these states has finished with its target (AAP 0.5.2): it
 * either deleted the customer, failed for good, or was superseded. `pending`, `executing` and
 * `failed_retryable` are unfinished work and are never purged.
 */
const TERMINAL_PAYMENT_STATUSES: readonly PaymentOperationStatus[] = [
  'succeeded',
  'failed_terminal',
  'fenced',
];

// ---------------------------------------------------------------------------------------------
// The public shape
// ---------------------------------------------------------------------------------------------

/**
 * What one run of a step changed, keyed by rule and counted in rows affected (AAP 0.5.2). Every rule
 * contributes at least one entry, and a rule that found nothing to do reports `0` — which is what the
 * job's log line carries and what makes a second run of the same step visibly a no-op.
 */
export type ExpiryCounts = Record<string, number>;

/**
 * The job a `data-expiry` processor receives: BullMQ's `Job`, narrowed to the two fields this
 * processor reads and the data it parses.
 *
 * `id` is part of the accepted shape so the worker entry point can hand its own `Job` straight in;
 * this processor identifies its run by the `step` it parses instead, which is the value its log line
 * and its counts are keyed by.
 */
export interface DataExpiryJob {
  /** The BullMQ job id; accepted for structural compatibility, not read (see the interface's note). */
  readonly id?: string;
  /** The job name: `hourly` or `daily`, exactly as `names.ts` declares them. */
  readonly name: string;
  /** The job data, unparsed: `{ step }`, validated by {@link process} before it is used. */
  readonly data: unknown;
}

/** The three removals of the lodging-call strip, keyed for {@link ExpiryCounts} (AAP 0.5.2). */
type LodgingCallStripCounts = {
  lodgingCallCallbacksDeleted: number;
  lodgingCallAttemptsStripped: number;
  lodgingCallTasksStripped: number;
};

/** The two removals of the 365-day call-metadata rule, keyed for {@link ExpiryCounts} (AAP 0.5.2). */
type CallMetadataCounts = {
  callAttemptsPurged: number;
  callTasksPurged: number;
};

/** The removals of the daily financial purge, keyed for {@link ExpiryCounts} (AAP 0.5.2). */
type FinancialPurgeCounts = {
  meetupsPurged: number;
  depositOperationsPurged: number;
  depositsPurged: number;
  settlementsPurged: number;
  creditEntriesPurged: number;
  checkInsPurged: number;
  messagesPurged: number;
  disputesPurged: number;
  witnessEventsUnlinked: number;
  reportsUnlinked: number;
  activityFactsPurgedForMeetups: number;
  customerOperationsPurged: number;
};

/** The two removals of the tombstone-reputation rule, keyed for {@link ExpiryCounts} (AAP 0.5.2). */
type TombstoneReputationCounts = {
  tombstoneWitnessEventsPurged: number;
  pairHistoryRowsPurged: number;
};

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/**
 * `now` less `days` days: the cut-off every age-based rule compares a stored timestamp against.
 * Computed in Node and bound as a parameter rather than written as SQL `now()`, so the injected clock
 * governs the run and the test clock can move a retention boundary (AAP 0.11.1).
 */
function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/** `now` less `hours` hours: the magic-link and session purge grace periods (AAP 0.5.2). */
function hoursBefore(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * HOUR_MS);
}

/**
 * Runs `execute` until it affects no row, and returns the total it affected.
 *
 * Each call re-runs the same statement, whose own predicate takes the rows it just removed out of the
 * selection, so the next call takes the next {@link DELETE_BATCH_SIZE} rows and the loop ends on the
 * first call that changes nothing. A statement whose rows are all gone therefore costs one extra
 * no-op query per rule, which is the price of not trusting a row count to mean "the backlog is
 * empty": a batch that removes exactly one batch's worth is followed by a call that proves it.
 */
async function drainBatches(execute: () => Promise<number>): Promise<number> {
  let total = 0;

  for (;;) {
    const affected = await execute();

    if (affected === 0) {
      return total;
    }

    total += affected;
  }
}

// ---------------------------------------------------------------------------------------------
// Hourly rule 1 — booking details (AAP 0.5.2)
// ---------------------------------------------------------------------------------------------

/**
 * Erases the booking details of every lodging claim that has resolved (AAP 0.5.2).
 *
 * The rule runs within an hour of the claim reaching `verified`, `rejected` or `unreachable`, well
 * inside the 24-hour limit criterion 14 measures, and `details_erased_at` records when: the row keeps
 * the fact that the details are gone, which is what the operator's booking-details route reads to
 * answer `409 details_unavailable`.
 *
 * The rule is one statement, and `details_erased_at IS NULL` is what makes a second run a no-op.
 */
async function eraseBookingDetails(db: RawSqlClient, now: Date): Promise<number> {
  return db.$executeRaw`
    UPDATE "lodging_claim"
       SET "booking_name_ciphertext" = NULL,
           "booking_reference_ciphertext" = NULL,
           "details_erased_at" = ${now}::timestamptz
     WHERE "status"::text = ANY(${TERMINAL_CLAIM_STATUSES}::text[])
       AND "details_erased_at" IS NULL
  `;
}

// ---------------------------------------------------------------------------------------------
// Hourly rule 2 — the stripped lodging call rows (AAP 0.5.2, 0.12.2)
// ---------------------------------------------------------------------------------------------

/**
 * Strips the lodging call rows of every claim that has resolved or been deleted (AAP 0.5.2, 0.12.2).
 *
 * The batch predicate is the whole of "not yet stripped": a task whose claim link is still set, or
 * whose attempts still hold a call id, summary, extracted fields, confidence, duration, transcript or
 * a language-model reservation, or which still has a callback row. Each of the three statements below
 * takes one of those away, so the loop's next query no longer selects the task and a second run of
 * the step reports zeros.
 *
 * The order inside the transaction is load-bearing:
 *
 *   1. `voice_callback_event` rows go first, by attempt id and by the call's own sid, which is why
 *      both forms are written: the sid is still readable here and not after step 2, and a Twilio
 *      callback that arrives later matches no row and is acknowledged without effect.
 *   2. The attempts lose their content and keep their identity — `id`, `call_task_id`, `state`,
 *      `outcome`, `twilio_final_status`, `started_at` and `ended_at` stay, so the call's outcome and
 *      its counts survive while nothing that described the guest or the conversation does.
 *   3. The task loses its claim link and keeps `id`, `kind`, `lodging_id` (so the one-target check
 *      still holds), `status`, `attempts`, `outcome_at`, `blocked_reason` and `resolved_by`. Its
 *      `updated_at` is set by hand because raw SQL bypasses the column's own maintenance, and it
 *      becomes the 365-day rule's activity stamp for a task with no outcome.
 *
 * A claim still `pending_call` or `calling` is never selected: its call may be live, and the relay
 * reads the claim's status before every turn (AAP 0.5.3).
 */
async function stripLodgingCallRows(db: DbClient, now: Date): Promise<LodgingCallStripCounts> {
  const counts: LodgingCallStripCounts = {
    lodgingCallCallbacksDeleted: 0,
    lodgingCallAttemptsStripped: 0,
    lodgingCallTasksStripped: 0,
  };

  for (;;) {
    const batch = await db.$queryRaw<{ id: string }[]>`
      SELECT "t"."id"::text AS "id"
        FROM "call_task" AS "t"
        LEFT JOIN "lodging_claim" AS "c" ON "c"."id" = "t"."lodging_claim_id"
       WHERE "t"."kind" = 'lodging_stay_verification'
         AND (
           "t"."lodging_claim_id" IS NULL
           OR "c"."status"::text = ANY(${TERMINAL_CLAIM_STATUSES}::text[])
         )
         AND (
           "t"."lodging_claim_id" IS NOT NULL
           OR EXISTS (
             SELECT 1
               FROM "call_attempt" AS "a"
              WHERE "a"."call_task_id" = "t"."id"
                AND (
                  "a"."twilio_call_sid" IS NOT NULL
                  OR "a"."summary" IS NOT NULL
                  OR "a"."extracted_fields" IS NOT NULL
                  OR "a"."confidence" IS NOT NULL
                  OR "a"."duration_sec" IS NOT NULL
                  OR "a"."transcript" IS NOT NULL
                  OR "a"."llm_reserved_micros" <> 0
                )
           )
           OR EXISTS (
             SELECT 1
               FROM "call_attempt" AS "a"
               JOIN "voice_callback_event" AS "v" ON "v"."call_attempt_id" = "a"."id"
              WHERE "a"."call_task_id" = "t"."id"
           )
         )
       ORDER BY "t"."id"
       LIMIT ${DELETE_BATCH_SIZE}::int
    `;

    if (batch.length === 0) {
      return counts;
    }

    const ids = batch.map((row) => row.id);
    const stripped = await db.$transaction(async (tx) => {
      const callbacksDeleted = await tx.$executeRaw`
        DELETE FROM "voice_callback_event"
         WHERE "call_attempt_id" IN (
                 SELECT "id" FROM "call_attempt" WHERE "call_task_id" = ANY(${ids}::uuid[])
               )
            OR "call_sid" IN (
                 SELECT "twilio_call_sid"
                   FROM "call_attempt"
                  WHERE "call_task_id" = ANY(${ids}::uuid[])
                    AND "twilio_call_sid" IS NOT NULL
               )
      `;
      const attemptsStripped = await tx.$executeRaw`
        UPDATE "call_attempt"
           SET "twilio_call_sid" = NULL,
               "summary" = NULL,
               "extracted_fields" = NULL,
               "confidence" = NULL,
               "duration_sec" = NULL,
               "transcript" = NULL,
               "transcript_delete_at" = NULL,
               "llm_reserved_micros" = 0
         WHERE "call_task_id" = ANY(${ids}::uuid[])
      `;
      const tasksStripped = await tx.$executeRaw`
        UPDATE "call_task"
           SET "lodging_claim_id" = NULL, "updated_at" = ${now}::timestamptz
         WHERE "id" = ANY(${ids}::uuid[])
      `;

      return { callbacksDeleted, attemptsStripped, tasksStripped };
    });

    counts.lodgingCallCallbacksDeleted += stripped.callbacksDeleted;
    counts.lodgingCallAttemptsStripped += stripped.attemptsStripped;
    counts.lodgingCallTasksStripped += stripped.tasksStripped;
  }
}

// ---------------------------------------------------------------------------------------------
// Hourly rules 3 to 9 (AAP 0.5.2)
// ---------------------------------------------------------------------------------------------

/**
 * Deletes the transcripts of menu calls whose 30 days are up (AAP 0.5.2). A lodging call never stores
 * one — its `transcript` and `transcript_delete_at` are null throughout, so this statement cannot
 * touch it.
 *
 * The date the transcript was stored with is what normally says when it is due, and the writer sets
 * it (`transcript_delete_at`). The second branch is the safety net for a stored transcript whose date
 * is missing: the window belongs to the data, not to the column, so a transcript with no recorded
 * deadline is still deleted once the call that produced it is more than
 * {@link TRANSCRIPT_RETENTION_DAYS} days old. Clearing `transcript_delete_at` as well is what takes
 * the row out of the next run's selection either way.
 */
async function deleteMenuTranscripts(db: RawSqlClient, now: Date): Promise<number> {
  const cutoff = daysBefore(now, TRANSCRIPT_RETENTION_DAYS);

  return db.$executeRaw`
    UPDATE "call_attempt"
       SET "transcript" = NULL, "transcript_delete_at" = NULL
     WHERE "transcript_delete_at" <= ${now}::timestamptz
        OR (
             "transcript_delete_at" IS NULL
             AND "transcript" IS NOT NULL
             AND "started_at" <= ${cutoff}::timestamptz
           )
  `;
}

/**
 * Nulls the delivery ciphertext of every magic-link token that has expired (AAP 0.5.2).
 *
 * This is the sweep behind the mailer's own cleanup: `notifications` nulls the ciphertext when it
 * sends the link and when it finds an expired token, and this statement catches whatever a
 * backlogged, failed or dropped job left behind, so a dead link's token cannot survive its expiry.
 */
async function disarmExpiredMagicLinks(db: RawSqlClient, now: Date): Promise<number> {
  return db.$executeRaw`
    UPDATE "magic_link_token"
       SET "delivery_token_ciphertext" = NULL
     WHERE "expires_at" <= ${now}::timestamptz
       AND "delivery_token_ciphertext" IS NOT NULL
  `;
}

/** Purges magic-link rows 24 hours after they expired (AAP 0.5.2). */
async function purgeExpiredMagicLinks(db: RawSqlClient, now: Date): Promise<number> {
  const purgedBefore = hoursBefore(now, MAGIC_LINK_PURGE_GRACE_HOURS);

  return drainBatches(
    () => db.$executeRaw`
      DELETE FROM "magic_link_token"
       WHERE "id" IN (
         SELECT "id" FROM "magic_link_token"
          WHERE "expires_at" <= ${purgedBefore}::timestamptz
          ORDER BY "expires_at"
          LIMIT ${DELETE_BATCH_SIZE}::int
       )
    `,
  );
}

/** Purges session rows 24 hours after they expired (AAP 0.5.2). */
async function purgeExpiredSessions(db: RawSqlClient, now: Date): Promise<number> {
  const purgedBefore = hoursBefore(now, SESSION_PURGE_GRACE_HOURS);

  return drainBatches(
    () => db.$executeRaw`
      DELETE FROM "session"
       WHERE "id" IN (
         SELECT "id" FROM "session"
          WHERE "expires_at" <= ${purgedBefore}::timestamptz
          ORDER BY "expires_at"
          LIMIT ${DELETE_BATCH_SIZE}::int
       )
    `,
  );
}

/**
 * Deletes the call tasks whose 365 days are up, and their attempts (AAP 0.5.2).
 *
 * Two kinds of task qualify. A terminal `menu_prices` task is done and its metadata exists only for
 * the call, cap and spend metrics. A `lodging_stay_verification` task qualifies once its claim link
 * is cleared, whatever its status, because a stripped row carries no call content at all. A task
 * still `queued`, `in_progress` or `needs_review` is not selected: it is work the operator or the
 * dispatcher may still need.
 *
 * A task is aged by the latest activity there is — its `outcome_at`, else the latest of its attempts'
 * `started_at` and `ended_at`, else its `updated_at` — so the clock starts when the task stopped
 * doing anything. Deleting an attempt and its task together keeps the pair consistent, and the
 * attempts' callback rows go with them through the schema's cascade.
 */
async function purgeCallMetadata(db: DbClient, now: Date): Promise<CallMetadataCounts> {
  const cutoff = daysBefore(now, CALL_METADATA_RETENTION_DAYS);
  let callAttemptsPurged = 0;
  let callTasksPurged = 0;

  for (;;) {
    const batch = await db.$queryRaw<{ id: string }[]>`
      SELECT "t"."id"::text AS "id"
        FROM "call_task" AS "t"
       WHERE (
               (
                 "t"."kind" = 'menu_prices'
                 AND "t"."status"::text = ANY(${TERMINAL_TASK_STATUSES}::text[])
               )
               OR ("t"."kind" = 'lodging_stay_verification' AND "t"."lodging_claim_id" IS NULL)
             )
         AND COALESCE(
               "t"."outcome_at",
               (
                 SELECT MAX(GREATEST("a"."started_at", COALESCE("a"."ended_at", "a"."started_at")))
                   FROM "call_attempt" AS "a"
                  WHERE "a"."call_task_id" = "t"."id"
               ),
               "t"."updated_at"
             ) <= ${cutoff}::timestamptz
       ORDER BY "t"."id"
       LIMIT ${DELETE_BATCH_SIZE}::int
    `;

    if (batch.length === 0) {
      return { callAttemptsPurged, callTasksPurged };
    }

    const ids = batch.map((row) => row.id);
    const purged = await db.$transaction(async (tx) => {
      const attempts = await tx.$executeRaw`
        DELETE FROM "call_attempt" WHERE "call_task_id" = ANY(${ids}::uuid[])
      `;
      const tasks = await tx.$executeRaw`
        DELETE FROM "call_task" WHERE "id" = ANY(${ids}::uuid[])
      `;

      return { attempts, tasks };
    });

    callAttemptsPurged += purged.attempts;
    callTasksPurged += purged.tasks;
  }
}

/**
 * Clears the reason text of reports older than 180 days (AAP 0.5.2).
 *
 * The row is kept — it is the record that a report exists, and the safety and payment-dispute window
 * covers 180 days of its text — and only the text goes. `"reason" <> ''` is what makes a second run a
 * no-op: the column is `NOT NULL` in `packages/db/prisma/schema.prisma`, so an emptied reason is the
 * empty string rather than NULL, and the predicate must therefore exclude what this rule already
 * cleared.
 */
async function clearReportReasonText(db: RawSqlClient, now: Date): Promise<number> {
  const cutoff = daysBefore(now, REASON_RETENTION_DAYS);

  return db.$executeRaw`
    UPDATE "report"
       SET "reason" = ''
     WHERE "reason" <> ''
       AND "created_at" <= ${cutoff}::timestamptz
  `;
}

/**
 * Clears the reason text of disputes resolved more than 180 days ago (AAP 0.5.2).
 *
 * An open dispute keeps its text whatever its age: the operator resolving it reads it, and a dispute
 * is open for at most five days plus the escalation the sweeper raises. Reports date their text from
 * `created_at` and disputes from `resolved_at`, which is why the two rules are separate statements.
 */
async function clearResolvedDisputeReasonText(db: RawSqlClient, now: Date): Promise<number> {
  const cutoff = daysBefore(now, REASON_RETENTION_DAYS);

  return db.$executeRaw`
    UPDATE "dispute"
       SET "reason" = ''
     WHERE "reason" <> ''
       AND "status" = 'resolved'
       AND "resolved_at" <= ${cutoff}::timestamptz
  `;
}

/** Purges the operator's booking-detail access log at 365 days (AAP 0.5.2). */
async function purgeOperatorAccessLogs(db: RawSqlClient, now: Date): Promise<number> {
  const cutoff = daysBefore(now, OPERATOR_ACCESS_LOG_RETENTION_DAYS);

  return drainBatches(
    () => db.$executeRaw`
      DELETE FROM "operator_access_log"
       WHERE "id" IN (
         SELECT "id" FROM "operator_access_log"
          WHERE "accessed_at" <= ${cutoff}::timestamptz
          ORDER BY "accessed_at"
          LIMIT ${DELETE_BATCH_SIZE}::int
       )
    `,
  );
}

/**
 * Purges lodging activity facts at 120 days (AAP 0.5.2, 0.5.7).
 *
 * The leaderboard counts a fact only inside a 90-day window, so a fact past 120 days changes no score
 * and its `pairKey` is the only thing it still holds. Keeping the two dates apart leaves the window a
 * month of slack, so a fact that a clock difference puts just inside 90 days is never deleted early.
 */
async function purgeLodgingActivityFacts(db: RawSqlClient, now: Date): Promise<number> {
  const cutoff = daysBefore(now, LODGING_ACTIVITY_FACT_RETENTION_DAYS);

  return drainBatches(
    () => db.$executeRaw`
      DELETE FROM "lodging_activity_fact"
       WHERE "id" IN (
         SELECT "id" FROM "lodging_activity_fact"
          WHERE "completed_at" <= ${cutoff}::timestamptz
          ORDER BY "completed_at"
          LIMIT ${DELETE_BATCH_SIZE}::int
       )
    `,
  );
}

// ---------------------------------------------------------------------------------------------
// Daily rule 1 — the financial purge (AAP 0.5.2)
// ---------------------------------------------------------------------------------------------

/**
 * Purges a meetup and its financial family once the retention period has run (AAP 0.5.2).
 *
 * A meetup is eligible when `final_at` — the moment it reached its final status, which is the
 * retention clock — is older than the caller's cut-off. Each batch runs in one transaction and
 * deletes or unlinks in a fixed order, so one meetup's family is never half-gone:
 *
 *   1. `payment_operation` by deposit, then `deposit`: the operations go first because they are what
 *      an executor reads to resume a Stripe call, and a deposit gone from under a pending operation
 *      would leave it unrunnable.
 *   2. `meetup_settlement`, `table_credit_entry`, `check_in`, `message`, `dispute`: the children that
 *      describe how the meetup went, including the one whose `meetup_id` the schema cascades.
 *   3. `witness_event.meetup_id` and `report.meetup_id` are nulled rather than deleted: the events and
 *      reports belong to live counterparts and survive with no link to the purged meetup, which is
 *      what keeps a live account's reputation counters unchanged (AAP 0.5.2).
 *   4. `lodging_activity_fact` rows for the meetup are deleted — normally already gone at 120 days,
 *      but a fact written for a claim verified late could still be inside that window.
 *   5. The meetup row itself, last.
 *
 * This runs whether or not the schema cascades each child, so the purge does not depend on the shape
 * of a foreign key written elsewhere. A tombstone the purge frees is deleted by the next rule of the
 * daily step, in the same run.
 *
 * @param cutoff - `now - FINANCIAL_RETENTION_DAYS * 24 h`, computed by the caller.
 */
async function purgeFinancialRecords(db: DbClient, cutoff: Date): Promise<FinancialPurgeCounts> {
  const counts: FinancialPurgeCounts = {
    meetupsPurged: 0,
    depositOperationsPurged: 0,
    depositsPurged: 0,
    settlementsPurged: 0,
    creditEntriesPurged: 0,
    checkInsPurged: 0,
    messagesPurged: 0,
    disputesPurged: 0,
    witnessEventsUnlinked: 0,
    reportsUnlinked: 0,
    activityFactsPurgedForMeetups: 0,
    customerOperationsPurged: 0,
  };

  for (;;) {
    const batch = await db.$queryRaw<{ id: string }[]>`
      SELECT "id"::text AS "id"
        FROM "meetup"
       WHERE "final_at" IS NOT NULL
         AND "final_at" < ${cutoff}::timestamptz
       ORDER BY "final_at"
       LIMIT ${DELETE_BATCH_SIZE}::int
    `;

    if (batch.length === 0) {
      break;
    }

    const ids = batch.map((row) => row.id);
    const purged = await db.$transaction(async (tx) => {
      const depositOperationsPurged = await tx.$executeRaw`
        DELETE FROM "payment_operation"
         WHERE "deposit_id" IN (
                 SELECT "id" FROM "deposit" WHERE "meetup_id" = ANY(${ids}::uuid[])
               )
      `;
      const depositsPurged = await tx.$executeRaw`
        DELETE FROM "deposit" WHERE "meetup_id" = ANY(${ids}::uuid[])
      `;
      const settlementsPurged = await tx.$executeRaw`
        DELETE FROM "meetup_settlement" WHERE "meetup_id" = ANY(${ids}::uuid[])
      `;
      const creditEntriesPurged = await tx.$executeRaw`
        DELETE FROM "table_credit_entry" WHERE "meetup_id" = ANY(${ids}::uuid[])
      `;
      const checkInsPurged = await tx.$executeRaw`
        DELETE FROM "check_in" WHERE "meetup_id" = ANY(${ids}::uuid[])
      `;
      const messagesPurged = await tx.$executeRaw`
        DELETE FROM "message" WHERE "meetup_id" = ANY(${ids}::uuid[])
      `;
      const disputesPurged = await tx.$executeRaw`
        DELETE FROM "dispute" WHERE "meetup_id" = ANY(${ids}::uuid[])
      `;
      const witnessEventsUnlinked = await tx.$executeRaw`
        UPDATE "witness_event" SET "meetup_id" = NULL WHERE "meetup_id" = ANY(${ids}::uuid[])
      `;
      const reportsUnlinked = await tx.$executeRaw`
        UPDATE "report" SET "meetup_id" = NULL WHERE "meetup_id" = ANY(${ids}::uuid[])
      `;
      const activityFactsPurgedForMeetups = await tx.$executeRaw`
        DELETE FROM "lodging_activity_fact" WHERE "meetup_id" = ANY(${ids}::uuid[])
      `;
      const meetupsPurged = await tx.$executeRaw`
        DELETE FROM "meetup" WHERE "id" = ANY(${ids}::uuid[])
      `;

      return {
        depositOperationsPurged,
        depositsPurged,
        settlementsPurged,
        creditEntriesPurged,
        checkInsPurged,
        messagesPurged,
        disputesPurged,
        witnessEventsUnlinked,
        reportsUnlinked,
        activityFactsPurgedForMeetups,
        meetupsPurged,
      };
    });

    counts.depositOperationsPurged += purged.depositOperationsPurged;
    counts.depositsPurged += purged.depositsPurged;
    counts.settlementsPurged += purged.settlementsPurged;
    counts.creditEntriesPurged += purged.creditEntriesPurged;
    counts.checkInsPurged += purged.checkInsPurged;
    counts.messagesPurged += purged.messagesPurged;
    counts.disputesPurged += purged.disputesPurged;
    counts.witnessEventsUnlinked += purged.witnessEventsUnlinked;
    counts.reportsUnlinked += purged.reportsUnlinked;
    counts.activityFactsPurgedForMeetups += purged.activityFactsPurgedForMeetups;
    counts.meetupsPurged += purged.meetupsPurged;
  }

  counts.customerOperationsPurged = await purgeFinishedCustomerOperations(db, cutoff);

  return counts;
}

/**
 * Purges the finished `delete_customer` operations of accounts erased long ago (AAP 0.5.2).
 *
 * The operation carries no deposit: it targets the user, and its `stripe_customer_id` copy is nulled
 * in the transaction that records success, so nothing but the row itself is left. It is purged on the
 * same cut-off as the financial records because it is one of them — and because while it exists its
 * `user_id` keeps the erased account's tombstone alive, which is exactly what the last daily rule is
 * there to settle.
 *
 * A row is aged by `completed_at`, falling back to `created_at`: a `fenced` or failed-terminal
 * operation may carry no completion time, and ageing such a row by nothing would let it keep a
 * tombstone forever. `pending`, `executing` and `failed_retryable` rows are work in progress and are
 * never selected, however old.
 */
async function purgeFinishedCustomerOperations(db: RawSqlClient, cutoff: Date): Promise<number> {
  return drainBatches(
    () => db.$executeRaw`
      DELETE FROM "payment_operation"
       WHERE "id" IN (
         SELECT "id" FROM "payment_operation"
          WHERE "kind" = 'delete_customer'
            AND "deposit_id" IS NULL
            AND "status"::text = ANY(${TERMINAL_PAYMENT_STATUSES}::text[])
            AND COALESCE("completed_at", "created_at") < ${cutoff}::timestamptz
          ORDER BY "created_at"
          LIMIT ${DELETE_BATCH_SIZE}::int
       )
    `,
  );
}

// ---------------------------------------------------------------------------------------------
// Daily rules 2 to 4 (AAP 0.5.2)
// ---------------------------------------------------------------------------------------------

/**
 * Purges `StripeEvent` rows received before the cut-off (AAP 0.5.2).
 *
 * The row is the webhook dedupe record: a replay is recognised because its event id is present. Once
 * every meetup that could receive a retry is purged, the event of an old delivery can no longer
 * change anything, so the record goes with the same cut-off the financial records use.
 */
async function purgeStripeEvents(db: RawSqlClient, cutoff: Date): Promise<number> {
  return drainBatches(
    () => db.$executeRaw`
      DELETE FROM "stripe_event"
       WHERE "id" IN (
         SELECT "id" FROM "stripe_event"
          WHERE "received_at" < ${cutoff}::timestamptz
          ORDER BY "received_at"
          LIMIT ${DELETE_BATCH_SIZE}::int
       )
    `,
  );
}

/**
 * Deletes the reputation rows that belong to an erased account alone (AAP 0.5.2).
 *
 * Two rules, both narrowed so a live account's counters cannot move:
 *
 *   - A `witness_event` whose user is a tombstone and whose `meetup_id` is already null. The meetup
 *     link is what the financial purge clears, and a witness event with neither a live owner nor a
 *     meetup has nothing left to count for. A tombstone's counterpart keeps its own event: that row's
 *     `user_id` is the live account, so it stays.
 *   - A `pair_history` row older than the cut-off with a tombstone on either side. `completed_count`
 *     is read for a pair whose two members are both live, so dropping the row of a pair that no
 *     longer has two live members changes no tier and no reputation figure.
 */
async function purgeTombstoneReputationRows(
  db: DbClient,
  cutoff: Date,
): Promise<TombstoneReputationCounts> {
  const tombstoneWitnessEventsPurged = await drainBatches(
    () => db.$executeRaw`
      DELETE FROM "witness_event"
       WHERE "id" IN (
         SELECT "id" FROM "witness_event"
          WHERE "meetup_id" IS NULL
            AND "user_id" IN (SELECT "id" FROM "user" WHERE "deleted_at" IS NOT NULL)
          ORDER BY "id"
          LIMIT ${DELETE_BATCH_SIZE}::int
       )
    `,
  );

  const pairHistoryRowsPurged = await drainBatches(
    () => db.$executeRaw`
      DELETE FROM "pair_history"
       WHERE ("user_low_id", "user_high_id") IN (
         SELECT "user_low_id", "user_high_id"
           FROM "pair_history"
          WHERE "last_completed_at" < ${cutoff}::timestamptz
            AND (
              "user_low_id" IN (SELECT "id" FROM "user" WHERE "deleted_at" IS NOT NULL)
              OR "user_high_id" IN (SELECT "id" FROM "user" WHERE "deleted_at" IS NOT NULL)
            )
          ORDER BY "user_low_id", "user_high_id"
          LIMIT ${DELETE_BATCH_SIZE}::int
       )
    `,
  );

  return { tombstoneWitnessEventsPurged, pairHistoryRowsPurged };
}

/**
 * Deletes every tombstone no retained record references (AAP 0.5.2).
 *
 * An erased account stays as a row so the records kept about it — a deposit, a check-in, a reputation
 * event — keep their foreign keys. Once the last one is gone the tombstone is the only thing left of
 * the account, so it goes too.
 *
 * "No retained record" is every relation to `"user"` that does not cascade, read from
 * `packages/db/prisma/schema.prisma`: the twelve RESTRICT foreign keys (`meetup.initiator_id`,
 * `meetup.recipient_id`, `deposit.owner_id`, `payment_operation.user_id`, `check_in.user_id`,
 * `witness_event.user_id`, `message.sender_id`, `dispute.filed_by_id`, `report.reporter_id`,
 * `report.reported_id`, `table_credit_entry.user_id`, `operator_access_log.operator_id`) plus the
 * three references that carry a uuid without a foreign key (`meetup.budget_updated_by`,
 * `witness_event.counterpart_id`, `pair_history.user_low_id` and `user_high_id`). The cascading
 * children — sessions, proofs, the disclosure profile, the photo, blocks, the experiment assignment,
 * push tokens, lodging claims and their visibility rows — are deleted by `account-erasure` and never
 * block this delete, so they are deliberately not tested here: an EXISTS on one would only keep a
 * tombstone alive for a row nobody needs.
 *
 * The page cursor is what keeps this loop bounded and finishing: candidates are read a page at a time
 * in uuid order and the cursor advances to the page's last id whatever the delete removes, so a page
 * in which every tombstone is still referenced cannot repeat itself. That matters because unlike the
 * other rules this one's predicate does not take a page out of its own selection.
 */
async function purgeUnreferencedTombstones(db: DbClient): Promise<number> {
  let cursor = FIRST_UUID;
  let purged = 0;

  for (;;) {
    const page = await db.$queryRaw<{ id: string }[]>`
      SELECT "id"::text AS "id"
        FROM "user"
       WHERE "deleted_at" IS NOT NULL
         AND "id" > ${cursor}::uuid
       ORDER BY "id"
       LIMIT ${DELETE_BATCH_SIZE}::int
    `;
    const last = page[page.length - 1];

    if (last === undefined) {
      return purged;
    }

    cursor = last.id;
    purged += await db.$executeRaw`
      DELETE FROM "user" AS "u"
       WHERE "u"."id" = ANY(${page.map((row) => row.id)}::uuid[])
         AND "u"."deleted_at" IS NOT NULL
         AND NOT EXISTS (
               SELECT 1 FROM "meetup" AS "m"
                WHERE "m"."initiator_id" = "u"."id"
                   OR "m"."recipient_id" = "u"."id"
                   OR "m"."budget_updated_by" = "u"."id"
             )
         AND NOT EXISTS (SELECT 1 FROM "deposit" AS "d" WHERE "d"."owner_id" = "u"."id")
         AND NOT EXISTS (SELECT 1 FROM "payment_operation" AS "p" WHERE "p"."user_id" = "u"."id")
         AND NOT EXISTS (SELECT 1 FROM "check_in" AS "c" WHERE "c"."user_id" = "u"."id")
         AND NOT EXISTS (
               SELECT 1 FROM "witness_event" AS "w"
                WHERE "w"."user_id" = "u"."id" OR "w"."counterpart_id" = "u"."id"
             )
         AND NOT EXISTS (SELECT 1 FROM "message" AS "s" WHERE "s"."sender_id" = "u"."id")
         AND NOT EXISTS (SELECT 1 FROM "dispute" AS "ds" WHERE "ds"."filed_by_id" = "u"."id")
         AND NOT EXISTS (
               SELECT 1 FROM "report" AS "r"
                WHERE "r"."reporter_id" = "u"."id" OR "r"."reported_id" = "u"."id"
             )
         AND NOT EXISTS (
               SELECT 1 FROM "table_credit_entry" AS "tce" WHERE "tce"."user_id" = "u"."id"
             )
         AND NOT EXISTS (
               SELECT 1 FROM "operator_access_log" AS "oal" WHERE "oal"."operator_id" = "u"."id"
             )
         AND NOT EXISTS (
               SELECT 1 FROM "pair_history" AS "ph"
                WHERE "ph"."user_low_id" = "u"."id" OR "ph"."user_high_id" = "u"."id"
             )
    `;
  }
}

// ---------------------------------------------------------------------------------------------
// The two steps
// ---------------------------------------------------------------------------------------------

/**
 * Runs the hourly retention rules and returns what each one changed (AAP 0.5.2, 0.5.6).
 *
 * The rules run in the order the module docblock lists them, one after the other: the booking-detail
 * erase precedes the strip that follows it in the same run, and nothing here depends on a rule that
 * runs after it. Every rule is idempotent, so a rerun of the same instant reports zeros.
 *
 * The run logs one line carrying its step and its counts, and nothing a rule touched beyond them
 * (AAP 0.11.1).
 */
export async function runHourlyExpiry(ctx: WorkerContext): Promise<ExpiryCounts> {
  const now = ctx.clock.now();

  const counts: ExpiryCounts = {
    bookingDetailsErased: await eraseBookingDetails(ctx.db, now),
    ...(await stripLodgingCallRows(ctx.db, now)),
    menuTranscriptsDeleted: await deleteMenuTranscripts(ctx.db, now),
    magicLinkTokensDisarmed: await disarmExpiredMagicLinks(ctx.db, now),
    magicLinkTokensPurged: await purgeExpiredMagicLinks(ctx.db, now),
    sessionsPurged: await purgeExpiredSessions(ctx.db, now),
    ...(await purgeCallMetadata(ctx.db, now)),
    reportReasonsCleared: await clearReportReasonText(ctx.db, now),
    disputeReasonsCleared: await clearResolvedDisputeReasonText(ctx.db, now),
    operatorAccessLogsPurged: await purgeOperatorAccessLogs(ctx.db, now),
    lodgingActivityFactsPurged: await purgeLodgingActivityFacts(ctx.db, now),
  };

  ctx.logger.info(
    { event: 'data_expiry', step: STEP.hourly, counts },
    'data-expiry hourly step complete',
  );

  return counts;
}

/**
 * Runs the daily financial-retention rules and returns what each one changed (AAP 0.5.2, 0.5.6).
 *
 * The cut-off is `now - env.FINANCIAL_RETENTION_DAYS` (2,557 days by default), so the period is
 * configuration rather than a constant in this file. The four rules run in an order that settles the
 * tombstone question in one pass: the financial purge frees what it deletes, the `StripeEvent` purge
 * takes the webhook records of the same age, the reputation rule drops what belonged to an erased
 * account alone, and the tombstone cleanup then removes an account nothing references any more.
 */
export async function runDailyExpiry(ctx: WorkerContext): Promise<ExpiryCounts> {
  const cutoff = daysBefore(ctx.clock.now(), ctx.env.FINANCIAL_RETENTION_DAYS);

  const counts: ExpiryCounts = {
    ...(await purgeFinancialRecords(ctx.db, cutoff)),
    stripeEventsPurged: await purgeStripeEvents(ctx.db, cutoff),
    ...(await purgeTombstoneReputationRows(ctx.db, cutoff)),
    tombstonesPurged: await purgeUnreferencedTombstones(ctx.db),
  };

  ctx.logger.info(
    { event: 'data_expiry', step: STEP.daily, counts },
    'data-expiry daily step complete',
  );

  return counts;
}

/**
 * The `data-expiry` queue's processor (AAP 0.5.6): one step per job, dispatched on the step the job
 * carries.
 *
 * The job name is narrowed with `isJobName` before the data is parsed, which is the pair
 * `packages/server-core/src/queues/names.ts` is built for: name and data are validated together, and
 * a name this queue does not accept fails here rather than reaching a rule. The job's own name and the
 * `step` in its data are the same value by construction — the schema binds one literal per job — so
 * dispatching on the parsed step is dispatching on the name, without a second read of it.
 *
 * @param job - The BullMQ job: its name and unparsed data.
 * @param ctx - The worker's configuration, clock, logger and guarded client.
 * @returns The counts of the step that ran, which a caller may log, assert on or ignore.
 * @throws QueuePayloadError when the job name is not this queue's, or its data does not match the
 *   step's schema.
 */
export async function process(job: DataExpiryJob, ctx: WorkerContext): Promise<ExpiryCounts> {
  const queue = QUEUE.dataExpiry;

  if (!isJobName(queue, job.name)) {
    throw new QueuePayloadError(`${queue}/${job.name}`);
  }

  const { step } = parseJobData(queue, job.name, job.data);

  return step === STEP.hourly ? runHourlyExpiry(ctx) : runDailyExpiry(ctx);
}
