/**
 * The `call-results` queue: applying the result the API recorded on a `CallAttempt` (AAP 0.3.2, 0.5.3, 0.5.6).
 *
 * The dialogue runs in the API, because Twilio's ConversationRelay socket terminates there, and the relay records
 * what a call produced on the attempt in the transaction that writes the `apply_call_result` outbox row. This job
 * consumes that row: it reads the attempt, decides what its outcome means for the task and, for a lodging call, for
 * the claim, and writes both in one transaction. Nothing here calls a third party — the call is over by the time
 * this runs, so PostgreSQL is the only I/O.
 *
 * Five rules shape it: a result is applied once, because the transaction locks the attempt, the
 * task and the claim and refuses anything unless the task is still `in_progress` (AAP 0.3.2);
 * terminal tasks stay terminal, whether an operator resolved them, their claim cancelled them or a
 * later attempt superseded them (AAP 0.5.3); a covered currency with no rate reaching back to the
 * capture day raises {@link FxRateUnavailableError} so the queue retries rather than converting
 * through a rate nobody published (AAP 0.5.6); the last delivery never leaves a task `in_progress`,
 * because nothing then moves it while it blocks every later call for its place (AAP 0.5.3); and a
 * claim and its task move together through `resolveClaim` — a confirmed answer sets the task
 * `completed` with the claim `verified` or `rejected`, anything less returns the claim to
 * `pending_call` (AAP 0.5.3).
 *
 * The result's shape is the cross-app contract of the API's `dialogue.ts`, mirrored below as
 * {@link ExtractedFieldsSchema} because `apps/workers` may not import `@tablemate/api` (AAP 0.11.1),
 * and no booking field is read or logged here (AAP 0.5.2).
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { Prisma, type DbTx } from '@tablemate/db';
import { QUEUE, QueuePayloadError, isJobName, parseJobData } from '@tablemate/server-core';
import { CALL_MAX_ATTEMPTS, CALL_RETRY_SPACING_HOURS, HOUR_MS } from '@tablemate/shared';
import type {
  CallAttemptOutcome,
  CallAttemptState,
  CallTaskKind,
  CallTaskStatus,
  ItemCategory,
  LodgingClaimStatus,
} from '@tablemate/shared';

import { FX_CURRENCIES, fxRateFor, toUsdCents } from '../fx/open-er-api.ts';
import { resolveClaim, type ResolvableClaim } from './lodging-claims.ts';
import { normalizeItemName } from './menu-ingest.ts';
// Type-only on purpose: `queues.ts` value-imports this file's `process`, so a value import back
// would close a runtime cycle. A type-only import is erased on emit.
import type { WorkerContext } from '../queues.ts';

/** The task statuses still outstanding, so a do-not-call reply cancels them (AAP 0.5.3). */
const OUTSTANDING_TASK_STATUSES = [
  'queued',
  'in_progress',
  'needs_review',
  'unreachable',
] as const satisfies readonly CallTaskStatus[];

/**
 * The attempt states in which a call may genuinely be live: cancelling such a task supersedes its
 * attempt, the signal the API's relay reads before every turn (AAP 0.5.3).
 */
const LIVE_ATTEMPT_STATES = [
  'dispatching',
  'dispatch_unknown',
  'dialing',
  'in_progress',
] as const satisfies readonly CallAttemptState[];

/** The two statuses a claim may still be resolved from (AAP 0.5.3). */
const ACTIVE_CLAIM_STATUSES = [
  'pending_call',
  'calling',
] as const satisfies readonly LodgingClaimStatus[];

/** The one task kind that verifies a claim (AAP 0.5.6). */
const LODGING_VERIFICATION_KIND: CallTaskKind = 'lodging_stay_verification';

/** How much later an unanswered call is retried: 24 h after the attempt ended (AAP 0.5.3). */
const RETRY_DELAY_MS = CALL_RETRY_SPACING_HOURS * HOUR_MS;

/**
 * The event a result the job could not apply is reported under (AAP 0.11.1): the last delivery hands
 * its task to the operator queue and reports the decision rather than failing the delivery, so the
 * line is the operator's record of why the task arrived there.
 */
const CALL_RESULT_UNAPPLIED = 'call_result_unapplied';

/**
 * How many places and how many lodgings one do-not-call reply may flag (AAP 0.5.3, 0.5.6). The flag
 * belongs to the number, not to the row the call was dialed from, so every target sharing the
 * caller's number is flagged — which is exactly why a bound exists: a switchboard number shared by
 * hundreds of rows in tables that grow with OSM ingestion would otherwise turn one reply into two
 * unbounded scans, and a lookup that reaches the bound then flagged only part of the number.
 */
const DO_NOT_CALL_TARGET_LIMIT = 500;

/**
 * The deadline on the one transaction this job opens: every statement in it touches a locked row, so
 * a stalled connection fails the job into BullMQ's retry instead of holding a lock indefinitely.
 */
const TRANSACTION_TIMEOUT_MS = 15_000;

/**
 * One priced item a menu call collected, as `menu-prices.ts` reports it: `amountMinor` is the price
 * in the currency's ISO 4217 minor units, copied into `PriceRecord.localAmountMinor` unchanged.
 */
const MenuPriceItemSchema = z.strictObject({
  slot: z.enum(['cheapest_main', 'priciest_main', 'coffee', 'beer']),
  dish: z.string().min(1),
  priceText: z.string().min(1),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  confirmed: z.boolean(),
});

const MenuExtractionSchema = z.strictObject({
  kind: z.literal('menu_prices'),
  items: z.array(MenuPriceItemSchema),
});

const StayExtractionSchema = z.strictObject({
  kind: z.literal('lodging_stay_verification'),
  answer: z.enum(['yes', 'no']).nullable(),
  confirmed: z.boolean(),
});

/**
 * `CallAttempt.extractedFields`, mirrored from `ExtractedFields` in the API's `dialogue.ts`, which is the source of
 * this contract; the two change together. A payload this refuses is treated as no extraction at all, so a malformed
 * result sends the task to the operator queue rather than storing a price nobody can trace.
 */
export const ExtractedFieldsSchema = z.discriminatedUnion('kind', [
  MenuExtractionSchema,
  StayExtractionSchema,
]);

/** One priced item a menu call collected (AAP 0.5.6). */
type MenuPriceItem = z.output<typeof MenuPriceItemSchema>;

/** The answer a stay call collected (AAP 0.5.3). */
interface StayAnswer {
  readonly answer: 'yes' | 'no' | null;
  readonly confirmed: boolean;
}

/**
 * Thrown when a price cannot be converted yet: the FX table covers the currency but has no row on or
 * before the capture date (AAP 0.5.6). An error rather than a silent drop, so BullMQ retries and the
 * prices are stored once `fx-refresh` writes the rate. The message names the currency, which is
 * configuration and not personal data, and never an amount or a phone number.
 */
export class FxRateUnavailableError extends Error {
  /** The currency whose rate is missing. */
  readonly currency: string;
  /** The capture date the rate had to reach back to, `YYYY-MM-DD`. */
  readonly captureDate: string;
  constructor(currency: string, captureDate: string) {
    super(`no FX rate for ${currency} on or before ${captureDate}`);
    this.name = 'FxRateUnavailableError';
    this.currency = currency;
    this.captureDate = captureDate;
  }
}

/**
 * The `call-results` job as a processor receives it: a structural subset of BullMQ's `Job`, so a test can call
 * {@link process} with a plain object. Its data is `{ outboxId, callAttemptId }`, of which the attempt is the only
 * field read here, and its two retry fields are what {@link isFinalDelivery} reads.
 */
export interface CallResultsJob {
  /** BullMQ's job id — `outbox-<outboxId>`, the stable id of AAP 0.3.2. */
  readonly id?: string;
  /** The job name, which this queue accepts as `apply` and as nothing else. */
  readonly name: string;
  /** The job's data, held by the queue's schema to the attempt to apply. */
  readonly data: unknown;
  /**
   * How many times the job has been started, counted up after each run: the first delivery carries
   * `0`, and the last one carries one less than the retry allowance.
   */
  readonly attemptsMade?: number;
  /** The options the job was added with, of which only the retry allowance is read here. */
  readonly opts?: { readonly attempts?: number };
}

/**
 * Why a result was not applied. Each is an expected state rather than a failure — the redelivery, the
 * operator who resolved the task first, a callback arriving after the claim was stripped — so the job
 * completes and reports it.
 */
export type CallResultsRefusal =
  | 'attempt_missing'
  | 'task_missing'
  | 'task_not_in_progress'
  | 'attempt_superseded'
  | 'attempt_stripped'
  | 'outcome_missing'
  | 'claim_missing'
  | 'target_missing';
/** What one run of this queue's processor reports. */
export type CallResultsResult =
  | { readonly applied: true; readonly taskStatus: CallTaskStatus }
  | { readonly applied: false; readonly reason: CallResultsRefusal };
/** One row of the attempt lock: the fields every branch below reads. */
interface LockedAttemptRow {
  readonly id: string;
  readonly call_task_id: string;
  readonly twilio_call_sid: string | null;
  readonly superseded: boolean;
  readonly outcome: CallAttemptOutcome | null;
  readonly extracted_fields: unknown;
  readonly confidence: string | null;
  readonly started_at: Date;
  readonly ended_at: Date | null;
}

/** One row of the task lock: what decides what a result means. */
interface LockedTaskRow {
  readonly id: string;
  readonly kind: CallTaskKind;
  readonly place_id: string | null;
  readonly lodging_id: string | null;
  readonly lodging_claim_id: string | null;
  readonly status: CallTaskStatus;
  readonly attempts: number;
}

/** One row of the claim lock: the fields `resolveClaim` takes. */
interface LockedClaimRow {
  readonly id: string;
  readonly user_id: string;
  readonly lodging_id: string;
  readonly status: LodgingClaimStatus;
  readonly created_at: Date;
  readonly stay_from: Date;
  readonly stay_to: Date;
}

/** A place or lodging a call was made to, as the outcome handlers need it. */
interface CallTarget {
  readonly kind: CallTaskKind;
  readonly id: string;
  readonly phone: string | null;
}

/** The place a menu call was made to, as its price records need it. */
interface MenuTarget {
  readonly id: string;
  readonly phone: string | null;
  readonly isFixture: boolean;
}

/**
 * What one result has to decide: the locked attempt and task, the outcome the relay recorded, and
 * the instant the call ended, which is the `outcomeAt` of every status below (AAP 0.5.7).
 */
interface ResultContext {
  readonly attempt: LockedAttemptRow;
  readonly task: LockedTaskRow;
  readonly outcome: CallAttemptOutcome;
  readonly endedAt: Date;
}

/**
 * Applies the result the API recorded on one call attempt (AAP 0.3.2, 0.5.3, 0.5.6).
 *
 * The whole decision runs in one transaction, so the task, the claim, the stored prices and the notification a
 * claim's resolution writes commit together or not at all. Ids come in and ids go out: the outcome is logged with
 * the task and attempt ids, never with a phone number, a dish, a summary or a transcript (AAP 0.11.1).
 *
 * A failure on a delivery the queue will retry is thrown, which is what a throw is for (AAP 0.5.6); on the last
 * delivery that throw would leave the task `in_progress` for good, so it reports the decision instead: it hands the
 * task to the operator queue through {@link handResultToOperator} and returns `{ applied: true, taskStatus:
 * 'needs_review' }`.
 */
export async function process(job: CallResultsJob, ctx: WorkerContext): Promise<CallResultsResult> {
  const queue = QUEUE.callResults;
  // A name this queue does not accept has no schema to parse against, so it is refused here rather
  // than parsed as the one job this queue carries: a foreign job arriving here is a wiring fault.
  if (!isJobName(queue, job.name)) {
    throw new QueuePayloadError(`${queue}/${job.name}`);
  }
  const { callAttemptId } = parseJobData(queue, job.name, job.data);
  try {
    return await ctx.db.$transaction(async (tx) => await applyResult(tx, ctx, callAttemptId), {
      isolationLevel: 'ReadCommitted',
      timeout: TRANSACTION_TIMEOUT_MS,
    });
  } catch (error) {
    // A delivery with a retry left fails, and the next one tries the same application again. The last
    // delivery cannot: throwing here would leave the task `in_progress` with nothing that could ever
    // move it, so what could not be applied becomes the operator's to resolve (AAP 0.5.3).
    if (!isFinalDelivery(job)) {
      throw error;
    }
    return await handResultToOperator(ctx, callAttemptId, error);
  }
}

/**
 * Whether this run is the last delivery BullMQ will start for the job. `attemptsMade` counts up
 * after each run, so a run one short of the allowance is the one no retry follows, and the one that
 * has to end the task's state itself. A job whose retry policy is not readable reads as retryable:
 * every job this queue carries is added through `jobOptionsFor`, which always sets `attempts`.
 */
function isFinalDelivery(job: CallResultsJob): boolean {
  const attempts = job.opts?.attempts;
  return attempts !== undefined && (job.attemptsMade ?? 0) + 1 >= attempts;
}

/**
 * Hands a result that could not be applied to the operator queue (AAP 0.5.3, 0.5.7).
 *
 * `needs_review` is the one status a `menu_prices` task is resolved from by an operator, and clearing
 * `blocked_reason` is what puts it in that queue rather than the blocked panel: the task is not blocked, it is
 * waiting for a person. `outcomeAt` is dated by the attempt's own end, as on every other status a call result
 * reaches, and the guards are the ones {@link applyResult} applies, in the same order, each refusal writing nothing.
 */
async function handResultToOperator(
  ctx: WorkerContext,
  attemptId: string,
  error: unknown,
): Promise<CallResultsResult> {
  ctx.logger.error(
    { event: CALL_RESULT_UNAPPLIED, attemptId, code: failureToken(error) },
    CALL_RESULT_UNAPPLIED,
  );
  return await ctx.db.$transaction(
    async (tx): Promise<CallResultsResult> => {
      const attempt = await lockAttempt(tx, attemptId);
      if (attempt === null) {
        return refuse('attempt_missing');
      }
      const task = await lockTask(tx, attempt.call_task_id);
      if (task === null) {
        return refuse('task_missing');
      }
      if (task.status !== 'in_progress') {
        return refuse('task_not_in_progress');
      }
      await setTaskStatus(tx, attempt.call_task_id, {
        status: 'needs_review',
        blockedReason: null,
        // An attempt the relay never stamped an end on is treated as having ended now, exactly as
        // {@link applyResult} dates its own `outcomeAt` (AAP 0.5.7).
        outcomeAt: attempt.ended_at ?? ctx.clock.now(),
      });
      return { applied: true, taskStatus: 'needs_review' };
    },
    { isolationLevel: 'ReadCommitted', timeout: TRANSACTION_TIMEOUT_MS },
  );
}

/**
 * The short token one unapplied result is logged by (AAP 0.11.1): the failure's own name, which
 * names the class of failure, never its message, which a driver or a provider can fill with a
 * number, a URL or a query. A name that is not a plain identifier reads as `unknown`.
 */
function failureToken(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'unknown';
}

/**
 * Locks the attempt, the task and, for a lodging call, the claim, then applies the outcome. The
 * order of the guards is the order the questions have to be asked in: the attempt exists, because a
 * purged attempt's outbox row is not a fault; the task is still `in_progress`, because every other
 * status has been decided by an earlier run of this job, by an operator or by the claim's resolution
 * (AAP 0.3.2); the attempt still counts — not `superseded`, not stripped of its call content, not
 * followed by a later attempt on the same task; and it carries an outcome to apply.
 */
async function applyResult(
  tx: DbTx,
  ctx: WorkerContext,
  attemptId: string,
): Promise<CallResultsResult> {
  const attempt = await lockAttempt(tx, attemptId);
  if (attempt === null) {
    return refuse('attempt_missing');
  }
  const task = await lockTask(tx, attempt.call_task_id);
  if (task === null) {
    return refuse('task_missing');
  }
  if (task.status !== 'in_progress') {
    return refuse('task_not_in_progress');
  }
  if (attempt.superseded) {
    return refuse('attempt_superseded');
  }
  if (isStrippedLodgingAttempt(attempt, task)) {
    return refuse('attempt_stripped');
  }
  if (attempt.outcome === null) {
    ctx.logger.warn(
      { event: 'call_result_without_outcome', attemptId: attempt.id, taskId: task.id },
      'call_result_without_outcome',
    );
    return refuse('outcome_missing');
  }
  if (await hasLaterAttempt(tx, attempt)) {
    return refuse('attempt_superseded');
  }
  const result: ResultContext = {
    attempt,
    task,
    outcome: attempt.outcome,
    // A call whose `endedAt` was never written — a relay that died before it could stamp one — is
    // treated as having ended now, so `outcomeAt` is still the attempt's own end (AAP 0.5.7).
    endedAt: attempt.ended_at ?? ctx.clock.now(),
  };
  return task.kind === LODGING_VERIFICATION_KIND
    ? await applyStayResult(tx, ctx, result)
    : await applyMenuResult(tx, ctx, result);
}

/**
 * Locks one attempt row for the rest of the caller's transaction, or reports it gone. The lock serializes this job
 * against the API's own writers of the attempt — the relay that recorded the outcome and the status webhook that may
 * still be recording one — so this job reads the row the first writer left rather than a half-written one.
 */
async function lockAttempt(tx: DbTx, attemptId: string): Promise<LockedAttemptRow | null> {
  const rows = await tx.$queryRaw<LockedAttemptRow[]>(Prisma.sql`
    SELECT "a"."id"::text AS "id",
           "a"."call_task_id"::text AS "call_task_id",
           "a"."twilio_call_sid" AS "twilio_call_sid",
           "a"."superseded" AS "superseded",
           "a"."outcome"::text AS "outcome",
           "a"."extracted_fields" AS "extracted_fields",
           "a"."confidence"::text AS "confidence",
           "a"."started_at" AS "started_at",
           "a"."ended_at" AS "ended_at"
      FROM "call_attempt" AS "a"
     WHERE "a"."id" = ${attemptId}::uuid
       FOR UPDATE
  `);
  return rows[0] ?? null;
}

/**
 * Locks one call-task row for the rest of the caller's transaction (AAP 0.5.3): the task's status under this lock is
 * the job's single decision point, so an operator resolving the task, a claim's resolution cancelling it and this job
 * are serialized and exactly one of them acts.
 */
async function lockTask(tx: DbTx, taskId: string): Promise<LockedTaskRow | null> {
  const rows = await tx.$queryRaw<LockedTaskRow[]>(Prisma.sql`
    SELECT "t"."id"::text AS "id",
           "t"."kind"::text AS "kind",
           "t"."place_id"::text AS "place_id",
           "t"."lodging_id"::text AS "lodging_id",
           "t"."lodging_claim_id"::text AS "lodging_claim_id",
           "t"."status"::text AS "status",
           "t"."attempts" AS "attempts"
      FROM "call_task" AS "t"
     WHERE "t"."id" = ${taskId}::uuid
       FOR UPDATE
  `);
  return rows[0] ?? null;
}

/**
 * Locks one lodging-claim row for the rest of the caller's transaction (AAP 0.5.3), the same lock
 * `lodging-claims.ts` takes before resolving a claim, so a call result, an operator's resolution and the 72-hour
 * expiry cannot each write a different outcome.
 */
async function lockClaim(tx: DbTx, claimId: string): Promise<LockedClaimRow | null> {
  const rows = await tx.$queryRaw<LockedClaimRow[]>(Prisma.sql`
    SELECT "c"."id"::text AS "id",
           "c"."user_id"::text AS "user_id",
           "c"."lodging_id"::text AS "lodging_id",
           "c"."status"::text AS "status",
           "c"."created_at" AS "created_at",
           "c"."stay_from" AS "stay_from",
           "c"."stay_to" AS "stay_to"
      FROM "lodging_claim" AS "c"
     WHERE "c"."id" = ${claimId}::uuid
       FOR UPDATE
  `);
  return rows[0] ?? null;
}

/**
 * Whether another attempt of the same task started after `attempt` (AAP 0.5.3): a retry creates a second attempt
 * only after the first one ended, so a first attempt whose result is applied late must not decide a task its
 * successor is already handling.
 */
async function hasLaterAttempt(tx: DbTx, attempt: LockedAttemptRow): Promise<boolean> {
  const later = await tx.callAttempt.findFirst({
    where: {
      callTaskId: attempt.call_task_id,
      id: { not: attempt.id },
      startedAt: { gt: attempt.started_at },
    },
    select: { id: true },
  });
  return later !== null;
}

/**
 * Whether a lodging attempt has had its call content stripped (AAP 0.5.2). `data-expiry` strips the call rows of a
 * resolved claim — the attempt loses its `CallSid`, its extracted fields and its summary, and the task loses its
 * claim link — so a result arriving afterwards has no claim to decide and is refused exactly as a superseded one is.
 */
function isStrippedLodgingAttempt(attempt: LockedAttemptRow, task: LockedTaskRow): boolean {
  return (
    task.kind === LODGING_VERIFICATION_KIND &&
    task.lodging_claim_id === null &&
    attempt.twilio_call_sid === null &&
    attempt.outcome !== null &&
    attempt.extracted_fields === null
  );
}

/** True while a claim can still be resolved: `pending_call` or `calling` (AAP 0.5.3). */
function isActiveClaim(status: LodgingClaimStatus): boolean {
  return ACTIVE_CLAIM_STATUSES.some((active) => active === status);
}

/** A refused result: nothing was written, and the reason names the state that was found. */
function refuse(reason: CallResultsRefusal): CallResultsResult {
  return { applied: false, reason };
}

/** Reports one applied result: ids, the outcome and the status reached, and nothing else (AAP 0.11.1). */
function report(
  ctx: WorkerContext,
  result: ResultContext,
  taskStatus: CallTaskStatus,
): CallResultsResult {
  ctx.logger.info(
    {
      event: 'call_outcome',
      taskId: result.task.id,
      attemptId: result.attempt.id,
      outcome: result.outcome,
      taskStatus,
    },
    'call_outcome',
  );
  return { applied: true, taskStatus };
}

/**
 * Applies a `menu_prices` attempt's outcome to its task (AAP 0.5.3, 0.5.6). A call that collected its prices with
 * every one confirmed stores them as one `phone_quote` batch and completes the task; anything less stores what was
 * collected as `needs_review` records and sends the task to the operator queue, which is what keeps an unverified
 * price out of suggestions.
 */
async function applyMenuResult(
  tx: DbTx,
  ctx: WorkerContext,
  result: ResultContext,
): Promise<CallResultsResult> {
  const { task } = result;
  if (task.place_id === null) {
    return refuse('target_missing');
  }
  const place = await tx.place.findUnique({
    where: { id: task.place_id },
    select: { id: true, phone: true, isFixture: true },
  });
  if (place === null) {
    return refuse('target_missing');
  }
  const taskStatus =
    result.outcome === 'completed' || result.outcome === 'needs_review'
      ? await settleMenuPrices(tx, ctx, result, place)
      : await finishWithoutAnswer(tx, ctx, result, {
          kind: task.kind,
          id: place.id,
          phone: place.phone,
        });
  return report(ctx, result, taskStatus);
}

/**
 * Stores what a menu call collected and moves its task on (AAP 0.5.3, 0.5.6). One `captureBatchId`
 * per call, as one fetch is one batch on the online path, because the estimate reads the newest batch
 * per source (AAP 0.5.7). The call is fully collected only when the outcome is `completed` with `high`
 * confidence, every item is marked `confirmed` and every one of them was stored: an item the FX or
 * currency rules dropped leaves the task for an operator rather than completing it on partial data.
 */
async function settleMenuPrices(
  tx: DbTx,
  ctx: WorkerContext,
  result: ResultContext,
  place: MenuTarget,
): Promise<CallTaskStatus> {
  const items = readMenuItems(result.attempt.extracted_fields) ?? [];
  // The number called is the price's source, and a place whose number has since been cleared has
  // nothing to attribute the price to, so the items stay with the operator: `sourceUrl` is required.
  const sourceUrl = place.phone === null ? null : `tel:${place.phone}`;
  const priced =
    items.length === 0 || sourceUrl === null
      ? { rows: [], dropped: 0 }
      : await phonePriceRows(tx, ctx, result, place, items, sourceUrl);
  const convinced =
    result.outcome === 'completed' &&
    result.attempt.confidence === 'high' &&
    items.length > 0 &&
    items.every((item) => item.confirmed) &&
    priced.rows.length === items.length;
  const rows = convinced
    ? priced.rows.map((row) => ({
        ...row,
        confidence: 'high' as const,
        reviewStatus: 'approved' as const,
      }))
    : priced.rows;
  if (rows.length > 0) {
    await tx.priceRecord.createMany({ data: rows });
  }
  const status: CallTaskStatus = convinced ? 'completed' : 'needs_review';
  await setTaskStatus(tx, result.task.id, {
    status,
    blockedReason: null,
    outcomeAt: result.endedAt,
    // Only a call that collected every price counts as the task's own result; a partial one is handed
    // to an operator, whose resolution records itself as such (AAP 0.5.2, 0.5.3).
    ...(convinced ? { resolvedBy: 'agent' as const } : {}),
  });
  return status;
}

/**
 * The `phone_quote` rows of one call (AAP 0.5.6), as `needs_review` for the caller to promote. Each
 * item keeps the price as it was heard and the same price in the currency's minor units, converted
 * through the FX row of the capture day — the attempt's own UTC day, which is also the `fxDate` stored
 * with the record, so a repeat of the same conversion cannot drift. Two ways an item is left out, and
 * neither invents a price: a currency the FX table does not cover at all, counted in the batch's
 * `dropped` as the online pipeline drops it too, and a covered currency whose rate has not arrived,
 * which throws so the queue retries.
 */
async function phonePriceRows(
  tx: DbTx,
  ctx: WorkerContext,
  result: ResultContext,
  place: MenuTarget,
  items: readonly MenuPriceItem[],
  sourceUrl: string,
): Promise<{ rows: Prisma.PriceRecordCreateManyInput[]; dropped: number }> {
  const captureDate = utcDateKey(result.endedAt);
  const captureBatchId = randomUUID();
  const rates = new Map<string, { date: string; usdPerUnit: Prisma.Decimal }>();
  const rows: Prisma.PriceRecordCreateManyInput[] = [];
  let dropped = 0;
  for (const item of items) {
    const currency = item.currency;
    let rate = rates.get(currency);
    if (rate === undefined) {
      // One lookup per currency per call: every item shares the capture date, so a rate read once
      // converts each of them to the same cents.
      const found = await fxRateFor(tx, currency, captureDate);
      if (found === null) {
        if (!isCoveredCurrency(currency)) {
          dropped += 1;
          continue;
        }
        throw new FxRateUnavailableError(currency, captureDate);
      }
      rate = found;
      rates.set(currency, found);
    }
    rows.push({
      placeId: place.id,
      captureBatchId,
      itemName: item.dish,
      normalizedName: normalizeItemName(item.dish),
      itemCategory: slotCategory(item.slot),
      alcoholic: slotAlcoholic(item.slot),
      // A phone quote is always a dish or a drink: the ticket fields belong to a page that priced an
      // admission, and neither is ever guessed here (AAP 0.5.6).
      perPerson: null,
      ticketType: null,
      priceText: item.priceText,
      localAmountMinor: item.amountMinor,
      currency,
      priceUsdCents: toUsdCents(item.amountMinor, currency, rate.usdPerUnit),
      source: 'phone_quote',
      sourceUrl,
      capturedAt: result.endedAt,
      fxDate: new Date(`${rate.date}T00:00:00.000Z`),
      confidence: 'low',
      reviewStatus: 'needs_review',
      isFixture: place.isFixture,
    });
  }
  if (dropped > 0) {
    ctx.logger.warn(
      { event: 'phone_price_unconvertible', taskId: result.task.id, dropped },
      'phone_price_unconvertible',
    );
  }
  return { rows, dropped };
}

/**
 * Applies a `lodging_stay_verification` attempt's outcome to its task and its claim (AAP 0.5.3). An
 * answer reception confirmed on read-back decides both rows in one transaction: the task becomes
 * `completed` — it produced the result, so `resolveClaim` is told not to cancel it — and the claim
 * becomes `verified` for yes or `rejected` for no; nothing else about the stay is read here, because
 * the payload carries the answer alone (AAP 0.5.2). Every other result leaves the claim undecided,
 * back to `pending_call` under its own status guard so a resolution that raced in is never
 * overwritten, with the task following {@link finishWithoutAnswer}.
 */
async function applyStayResult(
  tx: DbTx,
  ctx: WorkerContext,
  result: ResultContext,
): Promise<CallResultsResult> {
  const { task } = result;
  if (task.lodging_id === null || task.lodging_claim_id === null) {
    return refuse('claim_missing');
  }
  const claim = await lockClaim(tx, task.lodging_claim_id);
  if (claim === null || !isActiveClaim(claim.status)) {
    return refuse('claim_missing');
  }
  const lodging = await tx.lodging.findUnique({
    where: { id: task.lodging_id },
    select: { id: true, phone: true },
  });
  if (lodging === null) {
    return refuse('target_missing');
  }
  const answer = readStayAnswer(result.attempt.extracted_fields);
  if (
    result.outcome === 'completed' &&
    result.attempt.confidence === 'high' &&
    answer !== null &&
    answer.answer !== null &&
    answer.confirmed
  ) {
    await setTaskStatus(tx, task.id, {
      status: 'completed',
      blockedReason: null,
      outcomeAt: result.endedAt,
      resolvedBy: 'agent',
    });
    await resolveClaim(
      tx,
      ctx,
      resolvableClaim(claim),
      answer.answer === 'yes' ? 'verified' : 'rejected',
      { byTaskId: task.id },
    );
    return report(ctx, result, 'completed');
  }
  await tx.lodgingClaim.updateMany({
    where: { id: claim.id, status: 'calling' },
    data: { status: 'pending_call' },
  });
  const taskStatus = await finishWithoutAnswer(tx, ctx, result, {
    kind: task.kind,
    id: lodging.id,
    phone: lodging.phone,
  });
  return report(ctx, result, taskStatus);
}

/**
 * A locked claim row in the shape `lodging-claims.ts` resolves claims in: the identity, the owner,
 * the lodging and the stay the leaderboard backfill reads (AAP 0.5.3).
 */
function resolvableClaim(claim: LockedClaimRow): ResolvableClaim {
  return {
    id: claim.id,
    userId: claim.user_id,
    lodgingId: claim.lodging_id,
    createdAt: claim.created_at,
    stayFrom: claim.stay_from,
    stayTo: claim.stay_to,
  };
}

/**
 * Moves the task on for an outcome that decided nothing (AAP 0.5.3):
 *
 *   - `no_answer` — nobody picked up, or the call dropped: retried a day later while an attempt is
 *     left, `unreachable` once the second one goes unanswered.
 *   - `unreachable` — Twilio said the number cannot exist: the task stops with
 *     `blockedReason = invalid_number` and joins the operator queue.
 *   - `refused` — the callee asked for a human or to stop: the task closes and no target is blocked.
 *   - `do_not_call` — the callee asked not to be called again: the task stops and
 *     {@link applyDoNotCall} blocks the target and every task still outstanding for it.
 *
 * Shared by both kinds because the mapping is about the call and not its target.
 */
async function finishWithoutAnswer(
  tx: DbTx,
  ctx: WorkerContext,
  result: ResultContext,
  target: CallTarget,
): Promise<CallTaskStatus> {
  const { task } = result;
  switch (result.outcome) {
    case 'no_answer': {
      return await retryOrUnreachable(tx, result);
    }
    case 'unreachable': {
      await setTaskStatus(tx, task.id, {
        status: 'unreachable',
        blockedReason: 'invalid_number',
        outcomeAt: result.endedAt,
      });
      return 'unreachable';
    }
    case 'refused': {
      await setTaskStatus(tx, task.id, { status: 'refused', outcomeAt: result.endedAt });
      return 'refused';
    }
    case 'do_not_call': {
      // The task's own status is set first, so the sweep below cannot cancel the task that produced
      // this very outcome and its attempt is never superseded (AAP 0.5.3).
      await setTaskStatus(tx, task.id, {
        status: 'do_not_call',
        blockedReason: 'do_not_call',
        outcomeAt: result.endedAt,
      });
      await applyDoNotCall(tx, ctx, target, task.id);
      return 'do_not_call';
    }
    case 'completed':
    case 'needs_review': {
      // A menu call reaches this function only for the four outcomes above; a stay call reaches it
      // when its `completed` carried no confirmed answer, which is exactly what an operator reviews.
      await setTaskStatus(tx, task.id, {
        status: 'needs_review',
        blockedReason: null,
        outcomeAt: result.endedAt,
      });
      return 'needs_review';
    }
  }
}

/**
 * Retries a call that went unanswered, or stops the task once its attempts are spent (AAP 0.5.3).
 *
 * The allowance is the task's own `attempts` column, which the dispatcher increments when it dials, so a first
 * `no_answer` requeues the task a day later and a second one makes it `unreachable`, where the operator queue picks
 * it up. `blockedReason` is cleared on the requeue: the task is not blocked, it is about to be dialed again.
 */
async function retryOrUnreachable(tx: DbTx, result: ResultContext): Promise<CallTaskStatus> {
  const { task } = result;
  if (task.attempts < CALL_MAX_ATTEMPTS) {
    await setTaskStatus(tx, task.id, {
      status: 'queued',
      nextAttemptAt: new Date(result.endedAt.getTime() + RETRY_DELAY_MS),
      blockedReason: null,
      outcomeAt: result.endedAt,
    });
    return 'queued';
  }
  await setTaskStatus(tx, task.id, {
    status: 'unreachable',
    blockedReason: null,
    outcomeAt: result.endedAt,
  });
  return 'unreachable';
}

/**
 * Honours a request not to be called again (AAP 0.5.3, 0.5.6).
 *
 * The promise a `do_not_call` reply carries is about the number, not the row it was dialed from, so
 * the flag is set on the target and on every place and lodging that shares its phone. Those two
 * lookups are bounded by {@link DO_NOT_CALL_TARGET_LIMIT}, and one that returns every row the bound
 * allows is logged, because a number shared by far more rows than a business can own is a data fault
 * and the reply then flagged only part of it. Every other task still outstanding for those targets is
 * cancelled, and each of their possibly live attempts is marked `superseded` — the signal the API's
 * relay reads, speaking its closing line and ending the call on its next turn — while the task that
 * produced the outcome is excluded twice over: by its own status and by `byTaskId`.
 */
async function applyDoNotCall(
  tx: DbTx,
  ctx: WorkerContext,
  target: CallTarget,
  byTaskId: string,
): Promise<void> {
  const placeIds: string[] = [];
  const lodgingIds: string[] = [];
  if (target.kind === LODGING_VERIFICATION_KIND) {
    lodgingIds.push(target.id);
  } else {
    placeIds.push(target.id);
  }
  if (target.phone !== null) {
    // The guarded client narrows both reads to non-fixture rows outside `test` and `demo`, so a
    // production run can never block a fixture number (AAP 0.5.2). The bound is the rule constant's
    // and the order makes the rows a bounded read returns deterministic.
    const places = await tx.place.findMany({
      where: { phone: target.phone },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: DO_NOT_CALL_TARGET_LIMIT,
    });
    const lodgings = await tx.lodging.findMany({
      where: { phone: target.phone },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: DO_NOT_CALL_TARGET_LIMIT,
    });
    placeIds.push(...places.map((place) => place.id));
    lodgingIds.push(...lodgings.map((lodging) => lodging.id));
    if (
      places.length === DO_NOT_CALL_TARGET_LIMIT ||
      lodgings.length === DO_NOT_CALL_TARGET_LIMIT
    ) {
      ctx.logger.warn(
        {
          event: 'do_not_call_targets_saturated',
          taskId: byTaskId,
          placeCount: places.length,
          lodgingCount: lodgings.length,
        },
        'do_not_call_targets_saturated',
      );
    }
  }
  await tx.place.updateMany({ where: { id: { in: placeIds } }, data: { doNotCall: true } });
  await tx.lodging.updateMany({ where: { id: { in: lodgingIds } }, data: { doNotCall: true } });
  const outstanding = await tx.callTask.findMany({
    where: {
      id: { not: byTaskId },
      status: { in: [...OUTSTANDING_TASK_STATUSES] },
      OR: [{ placeId: { in: placeIds } }, { lodgingId: { in: lodgingIds } }],
    },
    select: { id: true },
  });
  if (outstanding.length === 0) {
    return;
  }
  const cancelledIds = outstanding.map((task) => task.id);
  await tx.callTask.updateMany({
    where: { id: { in: cancelledIds } },
    data: { status: 'cancelled' },
  });
  await tx.callAttempt.updateMany({
    where: {
      callTaskId: { in: cancelledIds },
      state: { in: [...LIVE_ATTEMPT_STATES] },
      superseded: false,
    },
    data: { superseded: true },
  });
  ctx.logger.info(
    { event: 'call_do_not_call', taskId: byTaskId, cancelled: cancelledIds.length },
    'call_do_not_call',
  );
}

/**
 * Applies one update to the task this result concerns, guarded on its status (AAP 0.5.3). The guard is the
 * transaction's own invariant made explicit — the row is locked and was read as `in_progress`, so nothing else can
 * have moved it — and `outcomeAt` travels with every status, dated by the attempt's own end (AAP 0.5.7).
 */
async function setTaskStatus(
  tx: DbTx,
  taskId: string,
  data: Prisma.CallTaskUpdateManyMutationInput,
): Promise<void> {
  await tx.callTask.updateMany({ where: { id: taskId, status: 'in_progress' }, data });
}

/**
 * The items a menu call collected, or `null` when the payload is not a readable menu extraction. A payload this
 * refuses — an unexpected key, a negative amount, a currency that is not an ISO 4217 code — is treated as no
 * extraction at all, which sends the task to the operator queue instead of storing a price that cannot be traced to
 * what was said.
 */
function readMenuItems(extracted: unknown): readonly MenuPriceItem[] | null {
  const parsed = ExtractedFieldsSchema.safeParse(extracted);
  return parsed.success && parsed.data.kind === 'menu_prices' ? parsed.data.items : null;
}

/** The answer a stay call collected, or `null` when the payload is not a readable stay extraction. */
function readStayAnswer(extracted: unknown): StayAnswer | null {
  const parsed = ExtractedFieldsSchema.safeParse(extracted);
  if (!parsed.success || parsed.data.kind !== 'lodging_stay_verification') {
    return null;
  }
  return { answer: parsed.data.answer, confirmed: parsed.data.confirmed };
}

/** The price-record category a menu slot stores (AAP 0.5.6). */
function slotCategory(slot: MenuPriceItem['slot']): ItemCategory {
  return slot === 'coffee' || slot === 'beer' ? 'drink' : 'main';
}

/**
 * The alcohol flag of a menu slot: `false` for the coffee question, `true` for the beer question, and
 * `null` for the two main courses, whose drink status is not asked (AAP 0.5.6).
 */
function slotAlcoholic(slot: MenuPriceItem['slot']): boolean | null {
  if (slot === 'coffee') {
    return false;
  }
  return slot === 'beer' ? true : null;
}

/** Whether the FX table covers a currency at all, as opposed to missing its row for one day. */
function isCoveredCurrency(currency: string): boolean {
  return FX_CURRENCIES.some((covered) => covered === currency);
}

/**
 * A `Date`'s UTC day, `YYYY-MM-DD`: the capture date a price is converted on and the `fxDate` it is
 * stored with. UTC rather than a city's local day, because the FX table is published per UTC day
 * (AAP 0.3.3, 0.5.6).
 */
function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
