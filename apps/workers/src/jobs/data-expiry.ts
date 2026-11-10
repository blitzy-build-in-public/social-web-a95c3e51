/**
 * Retention enforcement: the hourly `data-expiry` step and its daily 03:00 UTC financial step. {@link runHourlyExpiry}
 * applies the sub-daily rules and {@link runDailyExpiry} the four that only run once a day; each rule's own doc below
 * states its window.
 *
 * Four invariants hold across every rule: time comes from `ctx.clock`, never from SQL `now()`, so every cut-off is computed
 * in Node, bound as a parameter and moved at once by the test clock; every rule is a delete-or-update-where whose own
 * predicate takes the write out of the selection, so a second run changes nothing and reports zeros; bulk deletes and strips
 * take {@link DELETE_BATCH_SIZE} rows per statement, each batch's transaction carrying its own budget
 * ({@link TRANSACTION_TIMEOUT_MS}) rather than Prisma's route-sized default, so a busy database cannot expire it mid-batch
 * and abort a pass before the later rules have run; and every statement is a tagged template over the guarded client,
 * identifiers double-quoted (`"user"` is reserved) and values bound. Nothing here calls Stripe, Twilio, Overpass, a language
 * model or any other provider, which is what keeps retention working while every one of them is unreachable.
 */

import type { DbClient, RawSqlClient } from '@tablemate/db';
import { JOB, QUEUE, QueuePayloadError, isJobName, parseJobData } from '@tablemate/server-core';
import { DAY_MS, HOUR_MS } from '@tablemate/shared';
import type { CallTaskStatus, LodgingClaimStatus, PaymentOperationStatus } from '@tablemate/shared';

import type { WorkerContext } from '../queues.ts';

// This file's queue and its two step names, read from `packages/server-core/src/queues/names.ts`, the one place either is written down, so a rename there reaches this processor too.
const STEP = JOB[QUEUE.dataExpiry];
// The rows one bulk statement takes: a rule with a large backlog runs its statement once per batch, so a run holds bounded statements and a bounded transaction however much data is due.
const DELETE_BATCH_SIZE = 1_000;
// How long one batch's transaction may run. One budget covers each of the three batch transactions this module opens: five seconds is Prisma's default, meant for a route, and once it expires mid-batch the next statement is refused and every rule after it is skipped for that pass with no counts line written.
const TRANSACTION_TIMEOUT_MS = 60_000;
/** How long a `menu_prices` call transcript is kept, the only call content ever stored (AAP 0.5.2). */
const TRANSCRIPT_RETENTION_DAYS = 30;
/** The grace after a magic-link token's expiry before its row is purged (AAP 0.5.2). */
const MAGIC_LINK_PURGE_GRACE_HOURS = 24;
// The grace after a session's expiry before its row is purged: a session lives 30 days, so the rule covers the expired rows, while a revoked but unexpired row keeps its place until its expiry passes.
const SESSION_PURGE_GRACE_HOURS = 24;
/** How long call, cap and spend metadata is kept for the call metrics (AAP 0.5.2). */
const CALL_METADATA_RETENTION_DAYS = 365;
/** How long report and dispute reason text is kept for safety and payment disputes (AAP 0.5.2). */
const REASON_RETENTION_DAYS = 180;
/** How long the operator's booking-detail access log is kept (AAP 0.5.2). */
const OPERATOR_ACCESS_LOG_RETENTION_DAYS = 365;
/** How long a lodging's activity fact is kept, past the 90-day leaderboard window (AAP 0.5.2, 0.5.7). */
const LODGING_ACTIVITY_FACT_RETENTION_DAYS = 120;
// The id a tombstone page starts before: the all-zero UUID, which no generated id is, so `"id" > ${FIRST_UUID}` selects from the first row in uuid order.
const FIRST_UUID = '00000000-0000-0000-0000-000000000000';
// A lodging claim in one of these states has resolved, so its booking details are erased and its lodging call rows are stripped; a claim still `pending_call` or `calling` is live and keeps its details.
const TERMINAL_CLAIM_STATUSES: readonly LodgingClaimStatus[] = [
  'verified',
  'rejected',
  'unreachable',
];
// A call task in one of these states has finished, so the 365-day rule ages it by its last activity.
const TERMINAL_TASK_STATUSES: readonly CallTaskStatus[] = [
  'completed',
  'refused',
  'do_not_call',
  'unreachable',
  'cancelled',
];
// A `delete_customer` operation in one of these states has finished with its target; `pending`, `executing` and `failed_retryable` are unfinished work and are never purged.
const TERMINAL_PAYMENT_STATUSES: readonly PaymentOperationStatus[] = [
  'succeeded',
  'failed_terminal',
  'fenced',
];
// What one run of a step changed, keyed by rule and counted in rows affected. Every rule contributes at least one entry, and a rule that found nothing reports `0`, which makes a second run of the same step a no-op.
export type ExpiryCounts = Record<string, number>;
// The job a `data-expiry` processor receives: BullMQ's `Job`, narrowed to the two fields this processor reads and the data it parses. The processor identifies its run by the `step` it parses, which its log line and counts are keyed by.
export interface DataExpiryJob {
  readonly id?: string;
  readonly name: string;
  readonly data: unknown;
}

type LodgingCallStripCounts = {
  lodgingCallCallbacksDeleted: number;
  lodgingCallAttemptsStripped: number;
  lodgingCallTasksStripped: number;
};
type CallMetadataCounts = {
  callAttemptsPurged: number;
  callTasksPurged: number;
};
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
type TombstoneReputationCounts = {
  tombstoneWitnessEventsPurged: number;
  pairHistoryRowsPurged: number;
};
// `now` less `days` days: the cut-off every age-based rule compares a stored timestamp against, computed in Node and bound as a parameter rather than written as SQL `now()`, so the injected clock governs the run.
function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/** `now` less `hours` hours: the magic-link and session purge grace periods (AAP 0.5.2). */
function hoursBefore(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * HOUR_MS);
}

// Runs `execute` until it affects no row, and returns the total it affected: each call re-runs the same statement, whose own predicate takes the rows it just removed out of the selection, so a statement whose rows are all gone costs one extra no-op query per rule — the price of not trusting a row count to mean "the backlog is empty".
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

// Erases the booking details of every lodging claim that has resolved, within an hour of the claim reaching `verified`, `rejected` or `unreachable`, which is well inside the 24-hour limit criterion 14 measures. `details_erased_at` records when, and its `IS NULL` predicate makes a second run a no-op.
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

// Strips the lodging call rows of every claim that has resolved or been deleted. The batch predicate is the whole of "not yet stripped": a task whose claim link is still set, or whose attempts still hold a call id, summary, extracted fields, confidence, duration, transcript or language-model reservation, or which still has a callback row. Each of the three statements below takes one of those away, so the next query no longer selects the task and a second run reports zeros. The order inside the transaction is load-bearing: `voice_callback_event` rows go first, by attempt id and by the call's own sid, which is why both forms are written — the sid is still readable here and not after the next statement; the attempts then lose their content and keep their identity, so the outcome and the counts survive while nothing that described the guest or the conversation does; and the task loses its claim link and keeps the fields the one-target check and the metrics read. A claim still `pending_call` or `calling` is never selected: its call may be live, and the relay reads the claim's status before every turn.
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
    const stripped = await db.$transaction(
      async (tx) => {
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
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    counts.lodgingCallCallbacksDeleted += stripped.callbacksDeleted;
    counts.lodgingCallAttemptsStripped += stripped.attemptsStripped;
    counts.lodgingCallTasksStripped += stripped.tasksStripped;
  }
}

// Deletes the transcripts of menu calls whose 30 days are up; a lodging call never stores one. `transcript_delete_at` is what normally says when a transcript is due, and the writer sets it; the second branch is the safety net for a stored transcript whose date is missing, because the window belongs to the data, not to the column, so such a transcript is still deleted once the call that produced it is more than {@link TRANSCRIPT_RETENTION_DAYS} days old. Clearing the date as well takes the row out of the next run's selection either way.
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

// Nulls the delivery ciphertext of every magic-link token that has expired: the sweep behind the mailer's own cleanup, since `notifications` nulls the ciphertext when it sends the link and when it finds an expired token, and this statement catches whatever a backlogged, failed or dropped job left behind.
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

// Deletes the call tasks whose 365 days are up, and their attempts. Two kinds of task qualify: a terminal `menu_prices` task, whose metadata exists only for the call, cap and spend metrics, and a `lodging_stay_verification` task once its claim link is cleared, whatever its status, because a stripped row carries no call content at all; a task still `queued`, `in_progress` or `needs_review` is work the operator or the dispatcher may still need and is never selected. A task is aged by the latest activity there is — its `outcome_at`, else the latest of its attempts' `started_at` and `ended_at`, else its `updated_at` — so the clock starts when the task stopped doing anything; the attempts' callback rows go with them through the schema's cascade.
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
    const purged = await db.$transaction(
      async (tx) => {
        const attempts = await tx.$executeRaw`
          DELETE FROM "call_attempt" WHERE "call_task_id" = ANY(${ids}::uuid[])
        `;
        const tasks = await tx.$executeRaw`
          DELETE FROM "call_task" WHERE "id" = ANY(${ids}::uuid[])
        `;
        return { attempts, tasks };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    callAttemptsPurged += purged.attempts;
    callTasksPurged += purged.tasks;
  }
}

// Clears the reason text of reports older than 180 days: the row is kept — it is the record that a report exists — and only the text goes. `"reason" <> ''` is what makes a second run a no-op: the column is `NOT NULL`, so an emptied reason is the empty string rather than NULL.
async function clearReportReasonText(db: RawSqlClient, now: Date): Promise<number> {
  const cutoff = daysBefore(now, REASON_RETENTION_DAYS);
  return db.$executeRaw`
    UPDATE "report"
       SET "reason" = ''
     WHERE "reason" <> ''
       AND "created_at" <= ${cutoff}::timestamptz
  `;
}

// Clears the reason text of disputes resolved more than 180 days ago. An open dispute keeps its text whatever its age: the operator resolving it reads it. Reports date their text from `created_at` and disputes from `resolved_at`, which is why the two rules are separate statements.
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

// Purges lodging activity facts at 120 days: the leaderboard counts a fact only inside a 90-day window, so keeping the two apart leaves the window a month of slack and a fact a clock difference puts just inside 90 days is never deleted early.
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

// Purges a meetup and its financial family once the retention period has run. A meetup is eligible when `final_at` — the moment it reached its final status, which is the retention clock — is older than the caller's cut-off. Each batch runs in one transaction and deletes or unlinks in a fixed order, so one meetup's family is never half-gone: `payment_operation` by deposit, then `deposit`, because the operations are what an executor reads to resume a Stripe call; `meetup_settlement`, `table_credit_entry`, `check_in`, `message` and `dispute`; `witness_event.meetup_id` and `report.meetup_id` nulled rather than deleted, so the events and reports of live counterparts survive and a live account's reputation counters stay unchanged; `lodging_activity_fact` rows; and the meetup row itself, last. It runs whether or not the schema cascades each child, so the purge does not depend on the shape of a foreign key written elsewhere, and a tombstone it frees is deleted by the next rule of the daily step, in the same run.
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
    const purged = await db.$transaction(
      async (tx) => {
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
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
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

// Purges the finished `delete_customer` operations of accounts erased long ago. The operation carries no deposit — it targets the user and its `stripe_customer_id` copy is nulled when success is recorded — so nothing but the row is left, and it is purged on the same cut-off as the financial records because while it exists its `user_id` keeps the erased account's tombstone alive. A row is aged by `completed_at`, falling back to `created_at`: a `fenced` or failed-terminal operation may carry no completion time, and ageing such a row by nothing would let it keep a tombstone forever; `pending`, `executing` and `failed_retryable` rows are work in progress and are never selected, however old.
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

// Purges `StripeEvent` rows received before the cut-off. The row is the webhook dedupe record: a replay is recognised because its event id is present. Once every meetup that could receive a retry is purged, the event of an old delivery can no longer change anything, so the record goes with the same cut-off the financial records use.
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

// Deletes the reputation rows that belong to an erased account alone, both narrowed so a live account's counters cannot move: a `witness_event` whose user is a tombstone and whose `meetup_id` is already null, the meetup link being what the financial purge clears — a tombstone's counterpart keeps its own event, because that row's `user_id` is the live account — and a `pair_history` row older than the cut-off with a tombstone on either side, because `completed_count` is read for a pair whose two members are both live.
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

// Deletes every tombstone no retained record references: an erased account stays as a row so the records kept about it — a deposit, a check-in, a reputation event — keep their foreign keys, and once the last one is gone the tombstone is the only thing left of the account. "No retained record" is every relation to `"user"` that does not cascade: the twelve RESTRICT foreign keys and the three references that carry a uuid without a foreign key; the cascading children — sessions, proofs, the disclosure profile, the photo, blocks, the experiment assignment, push tokens, lodging claims and their visibility rows — are `account-erasure`'s, so they are deliberately not tested here. The page cursor is what keeps this loop bounded and finishing: candidates are read a page at a time in uuid order and the cursor advances to the page's last id whatever the delete removes, so a page in which every tombstone is still referenced cannot repeat itself — which matters because, unlike the other rules, this one's predicate does not take a page out of its own selection.
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

// Runs the hourly retention rules and returns what each one changed, in the order the module docblock lists them: the booking-detail erase precedes the strip that follows it in the same run. Every rule is idempotent, so a rerun of the same instant reports zeros, and the run logs one line carrying its step and its counts.
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

// Runs the daily financial-retention rules and returns what each one changed. The cut-off is `now - env.FINANCIAL_RETENTION_DAYS`, so the period is configuration rather than a constant here, and the four rules run in an order that settles the tombstone question in one pass: purge the financial records, purge the `StripeEvent` records of the same age, drop what belonged to an erased account alone, then remove a tombstone nothing references.
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

// The `data-expiry` queue's processor: one step per job, dispatched on the step the job carries. The job name is narrowed with `isJobName` before the data is parsed, so a name this queue does not accept fails here rather than reaching a rule; the job's own name and the `step` in its data are the same value by construction.
export async function process(job: DataExpiryJob, ctx: WorkerContext): Promise<ExpiryCounts> {
  const queue = QUEUE.dataExpiry;
  if (!isJobName(queue, job.name)) {
    throw new QueuePayloadError(`${queue}/${job.name}`);
  }
  const { step } = parseJobData(queue, job.name, job.data);
  return step === STEP.hourly ? runHourlyExpiry(ctx) : runDailyExpiry(ctx);
}
