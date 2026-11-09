/**
 * The `call-dispatch` queue: which queued call task is dialed next, and the verification task a lodging claim needs
 * before it can be dialed at all (AAP 0.3.2, 0.5.3, 0.5.6).
 *
 * Two jobs run here, and between them they are the only way a call starts. `dispatch-city` carries `{ cityId }` and
 * runs every two minutes per city: it resolves the city's unfinished attempts first, then takes at most
 * {@link DISPATCH_BATCH_SIZE} queued tasks that are due, in the call-and-menu order of `./calls/priority.ts`
 * (AAP 0.5.7), and decides each one in turn — only a task the eligibility rule accepts is handed to `dispatch`,
 * which claims it under its own lock, while every other verdict is written on the task itself, because a decision
 * that was not persisted would be taken again on the next pass. `create-task` carries `{ outboxId, lodgingClaimId }`
 * and is delivered from the `create_call_task` outbox row the API writes in the transaction that creates a lodging
 * claim (AAP 0.3.2): it opens the claim's `lodging_stay_verification` task, sends the claim straight to the operator
 * queue when the lodging cannot be called, and schedules the claim's 72-hour expiry. It is idempotent on the claim,
 * because the dispatcher may deliver one outbox row twice.
 *
 * Five rules hold across both jobs:
 *
 * 1. A call exists only after its attempt does. No Twilio call is created in this file: `dispatch` persists the
 *    `CallAttempt` as `dispatching` and commits before it dials, and it is the only place that contacts the vendor
 *    (AAP 0.3.2).
 * 2. The dialogue budget is counted once per run, before anything is dialed, and a count that fails dials nothing
 *    (AAP 0.5.6): the batch ends on the first count failure rather than dialing without a bound.
 * 3. Caps and calling hours defer, they do not drop: `cap_reached` and `budget_refused` end the batch, because
 *    `dispatch` has already moved that task to 09:00 local the next day and every later task over the same day's cap
 *    would be deferred the same way (AAP 0.5.6).
 * 4. Time and city-local reasoning come from the injected clock and the city's own zone (AAP 0.11.1), and a raw read
 *    of `place` or `lodging` carries {@link fixturePredicate}, because raw SQL bypasses the guarded client's fixture
 *    filter (AAP 0.5.2).
 * 5. Lock order: `lodging_claim` before `call_task`, the contract the API's claim deletion states with the same two
 *    tables, so a deletion and a task creation cannot deadlock.
 *
 * Every decision is logged under one `call_dispatch` event with the id it concerns and never a phone number
 * (AAP 0.11.1, 0.12.2). `dispatch` writes its own vendor-level lines, so one task never produces two lines saying
 * the same thing. Nothing here imports `@tablemate/api`, the Twilio SDK or Stripe.
 */

import { Prisma, fixturePredicate } from '@tablemate/db';
import {
  JOB,
  QUEUE,
  QueuePayloadError,
  claimExpireJobId,
  isJobName,
  jobOptionsFor,
  parseJobData,
} from '@tablemate/server-core';
import { CLAIM_EXPIRY_HOURS, HOUR_MS } from '@tablemate/shared';

import { CLASSIFICATION_TURN_TIMEOUT_MS, dialogueBudgetMicros } from '../calls/caps.ts';
import { nextCallingWindow } from '../calls/calling-hours.ts';
import { dispatch } from '../calls/dispatch-twilio.ts';
import { checkEligibility, lastCountedAttemptEndedAt } from '../calls/eligibility.ts';
import { callTaskOrderSql } from '../calls/priority.ts';
import { reconcileDue } from '../calls/reconcile.ts';

import type { Queue } from 'bullmq';

import type { DbClient, DbTx } from '@tablemate/db';
import type { BlockedReason, CallTaskStatus, LodgingClaimStatus } from '@tablemate/shared';

import type { DispatchNotEligibleReason } from '../calls/dispatch-twilio.ts';
import type { Eligibility } from '../calls/eligibility.ts';
// Type-only on purpose: `queues.ts` value-imports this file's `process`, so a value import back
// would close a runtime cycle. A type-only import is erased on emit.
import type { WorkerContext } from '../queues.ts';

/** The one log event every decision this file records is written under (AAP 0.11.1). */
const LOG_EVENT = 'call_dispatch';

/**
 * How many queued tasks one `dispatch-city` run decides (AAP 0.5.6).
 *
 * The scheduler ticks every two minutes, so a bound keeps one city's run short and a backlog walks
 * itself down over consecutive ticks in the order {@link callTaskOrderSql} defines.
 */
const DISPATCH_BATCH_SIZE = 10;

/** How long an unresolved claim may live: 72 hours from its creation (AAP 0.5.3). */
const CLAIM_EXPIRY_MS = CLAIM_EXPIRY_HOURS * HOUR_MS;

/**
 * The two claim statuses a verification call may still be dialed for (AAP 0.5.3). Every other status
 * is terminal, and the claim-resolution path cancels the tasks a terminal claim still has open.
 */
const OPEN_CLAIM_STATUSES: ReadonlySet<LodgingClaimStatus> = new Set<LodgingClaimStatus>([
  'pending_call',
  'calling',
]);

/**
 * The `priority` a `lodging_stay_verification` task is created with (AAP 0.5.7).
 *
 * `1` is the first number the call-and-menu rule assigns, and so the value that sorts first. It is not what orders
 * these tasks, though: the rule's own first key in {@link callTaskOrderSql} puts every lodging task ahead of price
 * collection whatever this column holds. The column is written so the row carries a valid priority rather than the
 * `0` default, which in BullMQ order would mean "before every prioritized job".
 */
const LODGING_TASK_PRIORITY = 1;

/**
 * The aliases {@link dueTasks} gives the three tables it reads. The two fragments of
 * `./calls/priority.ts` are written against them, and each fragment checks its own alias before it
 * quotes one (AAP 0.11.2).
 */
const TASK_ALIAS = 't';
const PLACE_ALIAS = 'p';
const LODGING_ALIAS = 'l';

/**
 * The `call-dispatch` job as a processor receives it: a structural subset of BullMQ's `Job`, so a
 * test can call {@link process} with a plain object.
 */
export interface CallDispatchJob {
  /**
   * BullMQ's job id — `call-dispatch-<cityId>` for the per-city scheduler, `outbox-<outboxId>` for a
   * delivered outbox row (AAP 0.3.2, 0.5.6). Accepted for the processor contract and deliberately
   * unread: a run is keyed by the city in its data, and a delivered row by its claim.
   */
  readonly id?: string;
  /** The job name, which this queue accepts as `dispatch-city` and `create-task`. */
  readonly name: string;
  /** The job's data, held by the queue's schema to that name's own shape (AAP 0.5.6). */
  readonly data: unknown;
}

/**
 * How one queued task was decided (AAP 0.5.3, 0.5.6). Every value but the three count-only ones is also a log line's
 * own `decision`, written by whichever side decided it:
 *
 * - `unreachable` — a safety refusal: no phone number, or a number marked `doNotCall`; the task goes to the operator
 *   queue with `outcomeAt` set.
 * - `allowlist_block` — the call guard refused the number, so the task stays `queued` with
 *   `blockedReason = not_allowlisted` and is rechecked at the next calling window.
 * - `deferred` — attempts, spacing or calling hours push the task to a named instant.
 * - `budget_count_failed` — the dialogue budget could not be counted, so nothing was dialed and the batch stopped.
 * - `target_missing` — the place or lodging the task points at is no longer visible; the row leaves the candidate
 *   set by itself, because the join that selects it can no longer match a city.
 * - `claim_cancelled` — the task's claim is no longer open, so the still-queued task is cancelled (AAP 0.5.3).
 * - `dialing` / `dispatch_failed` / `dispatch_unknown` / `not_claimed` / `cap_reached` / `budget_refused` — what
 *   `dispatch` reported.
 */
export type DispatchDecision =
  | 'unreachable'
  | 'allowlist_block'
  | 'deferred'
  | 'budget_count_failed'
  | 'target_missing'
  | 'claim_cancelled'
  | 'dialing'
  | 'dispatch_failed'
  | 'dispatch_unknown'
  | 'not_claimed'
  | 'cap_reached'
  | 'budget_refused';
/** One count per {@link DispatchDecision}: what a run reports, and what it returns (AAP 0.5.6). */
export type DispatchCounts = Readonly<Record<DispatchDecision, number>>;

/** What one `dispatch-city` run reports and logs: the event name, the city and the decisions. */
export interface CallDispatchResult {
  /** The event every line of this run carries, and the one this file logs under. */
  readonly event: 'call_dispatch';
  /** The city whose queued tasks were decided. */
  readonly cityId: string;
  /**
   * How many unfinished attempts `reconcileDue` resolved in this run. They are the dispatches and
   * calls no callback ever closed, so the count is how much of the run's work was recovery.
   */
  readonly reconciled: number;
  /** How many tasks each decision was applied to. */
  readonly decisions: DispatchCounts;
}

/**
 * Why a run decided nothing at all. Both are normal states rather than failures:
 * `telephony_off` is `TELEPHONY_MODE=off`, in which `call-dispatch` is not scheduled and every task
 * stays `queued` (AAP 0.6.2), and `unknown_city` is a job naming a `City` row the database no longer
 * holds, which is what `place-refresh` reports for the same condition.
 */
export interface CallDispatchSkipped {
  readonly event: 'call_dispatch';
  readonly cityId: string;
  readonly skipped: 'telephony_off' | 'unknown_city';
}

/** What one `create-task` run reports: whether it opened the task, and the status it was opened as. */
export interface CallTaskCreationResult {
  /** `true` only when this run created the task: a redelivery creates nothing. */
  readonly created: boolean;
  /** The status the created task carries, or `null` when no task was created. */
  readonly status: CallTaskStatus | null;
}

/** What {@link process} returns, in the shape its job name reports. */
export type CallDispatchJobResult = CallDispatchOutcome | CallTaskCreationResult;

/** A `dispatch-city` run's answer: what it decided, or that it decided nothing. */
export type CallDispatchOutcome = CallDispatchResult | CallDispatchSkipped;

/** One queued task as {@link dueTasks} reads it, with the target it would call (AAP 0.5.6). */
interface DueTaskRow {
  readonly id: string;
  /** The task's `attempts` counter, which the eligibility rule reads (AAP 0.5.3). */
  readonly attempts: number;
  /** The target's stored number: `null` when the row has none, or has nothing but whitespace. */
  readonly phone: string | null;
  /** Whether the target itself refuses calls. A number live elsewhere is caught by the rule. */
  readonly do_not_call: boolean;
}

interface LockedClaimRow {
  readonly id: string;
  readonly lodging_id: string;
  readonly status: LodgingClaimStatus;
  readonly created_at: Date;
}

/** What one `create-task` transaction decided, plus the claim age the expiry timer is built from. */
interface ClaimTaskOutcome {
  readonly result: CallTaskCreationResult;
  /** The claim's creation instant, or `null` when no expiry should be scheduled at all. */
  readonly claimCreatedAt: Date | null;
}

/**
 * The queued, due tasks of one city, in dispatch order, at most {@link DISPATCH_BATCH_SIZE} of them.
 *
 * One statement, because the order and the bound are what keep a backlog from being walked in an arbitrary sequence:
 * the `ORDER BY` fragment comes from {@link callTaskOrderSql}, which puts a lodging verification first, then the
 * place's distance band, then whether a locked meetup starts within 2 km and 3 days, then `next_attempt_at` and
 * finally the id (AAP 0.5.7).
 *
 * The `LEFT JOIN`s are the shape that fragment requires, and each fixture predicate is written NULL-safe around
 * them: a lodging task holds no `place_id` at all, so its place columns are NULL and a bare `is_fixture = false`
 * predicate would drop the row the order's first key exists to put ahead of price collection (AAP 0.5.2).
 *
 * The task's last counted attempt is deliberately not read here: `eligibility.ts` owns that rule, so a definite
 * vendor failure — which does not count as an attempt and must not start the 24-hour spacing — is excluded by the one
 * place that says so (AAP 0.5.3).
 */
async function dueTasks(ctx: WorkerContext, cityId: string, now: Date): Promise<DueTaskRow[]> {
  const appEnv = ctx.env.APP_ENV;
  return await ctx.db.$queryRaw<DueTaskRow[]>(Prisma.sql`
    SELECT "t"."id"::text AS "id",
           "t"."attempts" AS "attempts",
           COALESCE("p"."phone", "l"."phone") AS "phone",
           (COALESCE("p"."do_not_call", false) OR COALESCE("l"."do_not_call", false)) AS "do_not_call"
      FROM "call_task" AS "t"
      LEFT JOIN "place" AS "p" ON "p"."id" = "t"."place_id"
      LEFT JOIN "lodging" AS "l" ON "l"."id" = "t"."lodging_id"
     WHERE "t"."status" = 'queued'
       AND "t"."next_attempt_at" <= CAST(${now} AS timestamptz)
       AND ("p"."city_id" = ${cityId} OR "l"."city_id" = ${cityId})
       AND ("p"."id" IS NULL OR ${fixturePredicate(appEnv, PLACE_ALIAS)})
       AND ("l"."id" IS NULL OR ${fixturePredicate(appEnv, LODGING_ALIAS)})
     ${callTaskOrderSql(TASK_ALIAS, PLACE_ALIAS, now, appEnv)}
     LIMIT ${DISPATCH_BATCH_SIZE}`);
}

/**
 * The `dispatch-city` job (AAP 0.5.6): reconcile the city's unfinished attempts, then decide its due tasks one at a
 * time, in the call-and-menu order.
 *
 * The steps are the questions, in the order they have to be asked: telephony off decides nothing at all (AAP 0.6.2);
 * the city's zone is read before anything is scheduled in it, so a job naming a `City` the database does not hold
 * answers `unknown_city` rather than deferring against the host's zone; reconciliation runs before the candidates are
 * read, so an attempt it resolves into `no_answer` moves its task's `nextAttemptAt` in the same run (AAP 0.3.2); and
 * the dialogue budget is counted once, lazily, only when a call is about to be dialed. A failure in one decision
 * propagates: it is idempotent, and the retried run re-reads the state it left rather than skipping the task.
 */
async function dispatchCity(ctx: WorkerContext, cityId: string): Promise<CallDispatchOutcome> {
  const telephony = ctx.telephony;
  if (telephony === null) {
    return { event: LOG_EVENT, cityId, skipped: 'telephony_off' };
  }
  const city = await ctx.db.city.findUnique({ where: { id: cityId }, select: { timezone: true } });
  if (city === null) {
    return { event: LOG_EVENT, cityId, skipped: 'unknown_city' };
  }
  const timezone = city.timezone;
  const now = ctx.clock.now();
  const reconciled = await reconcileDue(cityId, {
    db: ctx.db,
    telephony,
    clock: ctx.clock,
    env: ctx.env,
    logger: ctx.logger,
    spend: ctx.spend,
  });
  const due = await dueTasks(ctx, cityId, now);
  const decisions = blankCounts();
  let dialogueBudget: number | null = null;
  for (const task of due) {
    const verdict = await checkEligibility(
      task,
      { phone: task.phone, doNotCall: task.do_not_call, timezone },
      {
        db: ctx.db,
        callGuard: ctx.callGuard,
        now,
        capCallSeconds: ctx.env.CAP_CALL_SECONDS,
        lastAttemptEndedAt: await lastCountedAttemptEndedAt(ctx.db, task.id),
      },
    );
    if (verdict.kind !== 'eligible') {
      count(decisions, await applyVerdict(ctx, task.id, verdict, timezone, now));
      continue;
    }
    // The guard has just accepted the number, so a `not_allowlisted` an earlier pass wrote is no
    // longer true and the column is cleared before the task is handed to `dispatch`.
    await clearBlockedReason(ctx.db, task.id);
    logDecision(ctx, { taskId: task.id, decision: 'eligible' });
    if (dialogueBudget === null) {
      dialogueBudget = await countDialogueBudget(ctx);
      if (dialogueBudget === null) {
        count(decisions, 'budget_count_failed');
        break;
      }
    }
    const dispatched = await dispatch(task.id, {
      db: ctx.db,
      telephony,
      spend: ctx.spend,
      callGuard: ctx.callGuard,
      env: ctx.env,
      clock: ctx.clock,
      logger: ctx.logger,
      timezone,
      dialogueBudgetMicros: dialogueBudget,
    });
    if (dispatched.kind === 'cap_reached' || dispatched.kind === 'budget_refused') {
      count(decisions, dispatched.kind);
      break;
    }
    if (dispatched.kind === 'not_eligible') {
      count(decisions, await applyDispatchRefusal(ctx, task.id, dispatched.reason, timezone, now));
      continue;
    }
    count(decisions, dispatched.kind);
  }
  const outcome: CallDispatchResult = {
    event: LOG_EVENT,
    cityId,
    reconciled: reconciled.length,
    decisions,
  };
  ctx.logger.info(outcome, LOG_EVENT);
  return outcome;
}

/**
 * Writes the verdict a task that is not dialed keeps, and reports the decision it recorded
 * (AAP 0.5.3, 0.5.6).
 *
 * Every write is guarded on the task still being `queued`, so a task an operator resolved or another
 * runner claimed between the read and the verdict is left exactly as it stands.
 */
async function applyVerdict(
  ctx: WorkerContext,
  taskId: string,
  verdict: Exclude<Eligibility, { kind: 'eligible' }>,
  timezone: string,
  now: Date,
): Promise<DispatchDecision> {
  if (verdict.kind === 'unreachable') {
    await markUnreachable(ctx.db, taskId, verdict.blockedReason, now);
    logDecision(ctx, { taskId, decision: 'unreachable', blockedReason: verdict.blockedReason });
    return 'unreachable';
  }
  if (verdict.kind === 'blocked') {
    // The task keeps its status and moves to the next calling window, so a number the guard refuses
    // today is rechecked once a day instead of filling every two-minute batch (AAP 0.5.6).
    await markNotAllowlisted(ctx.db, taskId, nextCallingWindow(timezone, now));
    logDecision(ctx, { taskId, decision: 'allowlist_block', blockedReason: verdict.guardReason });
    return 'allowlist_block';
  }
  await deferTask(ctx.db, taskId, verdict.until);
  logDecision(ctx, {
    taskId,
    decision: 'deferred',
    blockedReason: verdict.reason,
    until: verdict.until.toISOString(),
  });
  return 'deferred';
}

/**
 * Applies the verdict `dispatch` reached when it re-checked the task under its own lock, and reports the decision it
 * recorded (AAP 0.5.3, 0.5.6). Those re-checks exist because the state can change between this run's read and
 * `dispatch`'s claim, so the mapping repeats {@link applyVerdict}'s: `do_not_call` and `no_phone` to the operator
 * queue as `unreachable` with their `outcomeAt`, `not_callable` to `queued` with `blockedReason = not_allowlisted`
 * deferred to the next calling window, and `claim_not_open` to `cancelled` — a lifecycle state, not an outcome, so
 * `outcomeAt` is deliberately not written. `target_missing` writes nothing, because the target is gone or invisible
 * and the join that selected the task no longer matches a city.
 */
async function applyDispatchRefusal(
  ctx: WorkerContext,
  taskId: string,
  reason: DispatchNotEligibleReason,
  timezone: string,
  now: Date,
): Promise<DispatchDecision> {
  switch (reason) {
    case 'do_not_call':
    case 'no_phone': {
      await markUnreachable(ctx.db, taskId, reason, now);
      logDecision(ctx, { taskId, decision: 'unreachable', blockedReason: reason });
      return 'unreachable';
    }
    case 'not_callable': {
      await markNotAllowlisted(ctx.db, taskId, nextCallingWindow(timezone, now));
      logDecision(ctx, { taskId, decision: 'allowlist_block', blockedReason: reason });
      return 'allowlist_block';
    }
    case 'claim_not_open': {
      await cancelQueuedTask(ctx.db, taskId);
      logDecision(ctx, { taskId, decision: 'claim_cancelled', blockedReason: reason });
      return 'claim_cancelled';
    }
    case 'target_missing': {
      logDecision(ctx, { taskId, decision: 'target_missing' });
      return 'target_missing';
    }
  }
}

/**
 * Counts one call's dialogue budget, or reports that it could not be counted (AAP 0.5.6). `./calls/caps.ts` owns the
 * template and the arithmetic: the largest counted bound of one classification turn over a full conversation window,
 * times `LLM_MAX_TURNS_PER_CALL`. The count is a provider call made outside every transaction, before any claim, so a
 * refusal here leaves no state behind; a failure is logged by name alone and answers `null`, the caller's signal to
 * dial nothing.
 */
async function countDialogueBudget(ctx: WorkerContext): Promise<number | null> {
  try {
    return await dialogueBudgetMicros({
      llm: ctx.llm,
      spend: ctx.spend,
      prices: ctx.env.llm.prices,
      maxTurns: ctx.env.LLM_MAX_TURNS_PER_CALL,
      timeoutMs: CLASSIFICATION_TURN_TIMEOUT_MS,
    });
  } catch (error) {
    ctx.logger.warn(
      { event: LOG_EVENT, decision: 'budget_count_failed', errorName: errorName(error) },
      LOG_EVENT,
    );
    return null;
  }
}

/**
 * The `create-task` job (AAP 0.3.2, 0.5.3): opens the claim's `lodging_stay_verification` task, or hands the claim to
 * the operator queue, and schedules the claim's 72-hour expiry.
 *
 * The work splits in two around the commit, and the split is a rule: the task and its state are written inside the
 * transaction that locks the claim, and the BullMQ add happens after it, because a third-party call inside a
 * transaction would hold the claim lock for as long as Redis takes. A job that fails after the commit is redelivered
 * and only repeats the schedule, under the same stable id, which BullMQ ignores.
 */
async function createVerificationTask(
  ctx: WorkerContext,
  claimId: string,
  now: Date,
): Promise<CallTaskCreationResult> {
  const outcome = await ctx.db.$transaction(
    async (tx) => await openVerificationTask(ctx, tx, claimId, now),
  );
  if (outcome.claimCreatedAt !== null) {
    await scheduleClaimExpiry(ctx, claimId, outcome.claimCreatedAt, now);
  }
  return outcome.result;
}

/**
 * Opens the claim's verification task inside the caller's transaction (AAP 0.5.3).
 *
 * The claim is locked `FOR UPDATE` before anything else is read — the lock order the API's claim deletion keeps with
 * the same two tables, `lodging_claim` before `call_task`.
 *
 * Three states need no task and are not failures: the claim is gone or already terminal, whose own resolution path
 * cancels the work it still had open; a task already points at it, a redelivered outbox row for which the task stands
 * and only the expiry is scheduled again; or the lodging row is gone.
 *
 * Otherwise the task is created, and the eligibility rule decides its opening state — the same rule the dispatcher
 * asks, so a target that cannot be called is routed at creation rather than one tick later. A safety refusal opens it
 * `unreachable` with its `blockedReason` and its `outcomeAt`, which is the operator's queue, and the claim stays
 * `pending_call` so its owner still sees a claim waiting rather than a decision they cannot appeal; a refusal that is
 * not a safety one opens it `queued`, which is where the dispatcher's next pass would record it either way
 * (AAP 0.5.6).
 */
async function openVerificationTask(
  ctx: WorkerContext,
  tx: DbTx,
  claimId: string,
  now: Date,
): Promise<ClaimTaskOutcome> {
  const claim = await lockClaim(tx, claimId);
  if (claim === null || !OPEN_CLAIM_STATUSES.has(claim.status)) {
    return { result: { created: false, status: null }, claimCreatedAt: null };
  }
  const existing = await tx.callTask.findFirst({
    where: { lodgingClaimId: claimId },
    select: { id: true },
  });
  if (existing !== null) {
    return { result: { created: false, status: null }, claimCreatedAt: claim.created_at };
  }
  const lodging = await tx.lodging.findFirst({
    where: { id: claim.lodging_id },
    select: { phone: true, doNotCall: true, city: { select: { timezone: true } } },
  });
  if (lodging === null) {
    return { result: { created: false, status: null }, claimCreatedAt: claim.created_at };
  }
  const verdict = await checkEligibility(
    { attempts: 0 },
    { phone: lodging.phone, doNotCall: lodging.doNotCall, timezone: lodging.city.timezone },
    {
      db: tx,
      callGuard: ctx.callGuard,
      now,
      capCallSeconds: ctx.env.CAP_CALL_SECONDS,
      lastAttemptEndedAt: null,
    },
  );
  const blockedReason: BlockedReason | null =
    verdict.kind === 'unreachable' ? verdict.blockedReason : null;
  const created = await tx.callTask.create({
    data: {
      kind: 'lodging_stay_verification',
      lodgingId: claim.lodging_id,
      lodgingClaimId: claimId,
      status: blockedReason === null ? 'queued' : 'unreachable',
      blockedReason,
      outcomeAt: blockedReason === null ? null : now,
      attempts: 0,
      vendorFailures: 0,
      nextAttemptAt: now,
      priority: LODGING_TASK_PRIORITY,
    },
    select: { status: true },
  });
  logDecision(ctx, {
    claimId,
    decision: 'task_created',
    blockedReason: blockedReason ?? 'queued',
  });
  return { result: { created: true, status: created.status }, claimCreatedAt: claim.created_at };
}

/**
 * Schedules the 72-hour expiry of one claim, under its stable job id (AAP 0.3.2, 0.5.3).
 *
 * `claim-expire-<claimId>` is added with the delay that remains of `CLAIM_EXPIRY_HOURS`, so it fires 72 hours after
 * the claim was created whatever time this run reached it, and a redelivery adds the same id, which BullMQ ignores. A
 * claim already past its 72 hours gets a delay of zero: the expiry runs at once, and its own guard decides whether
 * the claim is still open.
 */
async function scheduleClaimExpiry(
  ctx: WorkerContext,
  claimId: string,
  createdAt: Date,
  now: Date,
): Promise<void> {
  const delay = Math.max(0, createdAt.getTime() + CLAIM_EXPIRY_MS - now.getTime());
  await lodgingClaimsQueue(ctx).add(
    JOB[QUEUE.lodgingClaims].claimExpire,
    { claimId },
    jobOptionsFor(QUEUE.lodgingClaims, { jobId: claimExpireJobId(claimId), delay }),
  );
}

/**
 * The `lodging-claims` producer (AAP 0.5.6). `queues.ts` builds one producer per queue at startup, so a worker whose
 * producer is missing is a configuration fault rather than a property of a claim: the throw reaches BullMQ, which
 * retries the job, and the retry finds the task that already exists and schedules the timer that was missing.
 */
function lodgingClaimsQueue(ctx: WorkerContext): Queue {
  const queue: Queue | undefined = ctx.queues.get(QUEUE.lodgingClaims);
  if (queue === undefined) {
    throw new Error('lodging_claims_queue_unavailable');
  }
  return queue;
}

/**
 * Runs one `call-dispatch` job (AAP 0.5.6). The job name is narrowed with `isJobName` before the data is parsed, which
 * is the pair `names.ts` and `payloads.ts` are built for: a name this queue does not accept, or data that does not
 * match that name's schema, fails here rather than reaching a rule.
 */
export async function process(
  job: CallDispatchJob,
  ctx: WorkerContext,
): Promise<CallDispatchJobResult> {
  const queue = QUEUE.callDispatch;
  // A name this queue does not accept has no schema to parse against, so it is refused here rather
  // than parsed as one of the two jobs: a foreign job arriving on this queue is a wiring fault.
  if (!isJobName(queue, job.name)) {
    throw new QueuePayloadError(`${queue}/${job.name}`);
  }
  if (job.name === JOB[queue].dispatchCity) {
    const { cityId } = parseJobData(queue, JOB[queue].dispatchCity, job.data);
    return await dispatchCity(ctx, cityId);
  }
  const { lodgingClaimId } = parseJobData(queue, JOB[queue].createTask, job.data);
  return await createVerificationTask(ctx, lodgingClaimId, ctx.clock.now());
}

/**
 * Moves a still-queued task to the operator queue (AAP 0.5.3): `unreachable` with its `blockedReason` and its
 * `outcomeAt` is the state that puts a task in front of a person. The guard on `status = 'queued'` is what keeps this
 * write off a task an operator resolved or another runner claimed meanwhile.
 */
async function markUnreachable(
  db: DbClient,
  taskId: string,
  blockedReason: BlockedReason,
  now: Date,
): Promise<void> {
  await db.callTask.updateMany({
    where: { id: taskId, status: 'queued' },
    data: { status: 'unreachable', blockedReason, outcomeAt: now },
  });
}

/**
 * Keeps a task `queued` with the reason it may not be dialed, and moves it to the next calling window
 * (AAP 0.5.6): `not_allowlisted` is the one `BlockedReason` that matches the guard's two reasons, and
 * the window keeps a refused number from being rechecked on every two-minute pass.
 */
async function markNotAllowlisted(db: DbClient, taskId: string, until: Date): Promise<void> {
  await db.callTask.updateMany({
    where: { id: taskId, status: 'queued' },
    data: { blockedReason: 'not_allowlisted', nextAttemptAt: until },
  });
}

/** Moves a task's `nextAttemptAt` to `until`, leaving its status and its reason as they stand. */
async function deferTask(db: DbClient, taskId: string, until: Date): Promise<void> {
  await db.callTask.updateMany({
    where: { id: taskId, status: 'queued' },
    data: { nextAttemptAt: until },
  });
}

/**
 * Clears a `blockedReason` the eligibility rule no longer agrees with, before the task is dialed.
 *
 * Only a task that carries one is written, so the usual dial costs no write beyond the one
 * `dispatch` makes inside its own claim transaction.
 */
async function clearBlockedReason(db: DbClient, taskId: string): Promise<void> {
  await db.callTask.updateMany({
    where: { id: taskId, status: 'queued', blockedReason: { not: null } },
    data: { blockedReason: null },
  });
}

/**
 * Cancels a still-queued task whose claim is no longer open (AAP 0.5.3).
 *
 * `cancelled` is a lifecycle state and not an outcome, so `outcomeAt` is left as it stands, exactly as
 * the claim-resolution path leaves it when it cancels the work a terminal claim still had open.
 */
async function cancelQueuedTask(db: DbClient, taskId: string): Promise<void> {
  await db.callTask.updateMany({
    where: { id: taskId, status: 'queued' },
    data: { status: 'cancelled' },
  });
}

/**
 * Locks one claim row for the rest of the caller's transaction (AAP 0.5.3). The row lock is taken before any
 * `call_task` row is read or written, which is the cross-app lock order the API's claim deletion states with the same
 * two tables: taking them in the other order would let a deletion and a task creation deadlock.
 */
async function lockClaim(tx: DbTx, claimId: string): Promise<LockedClaimRow | null> {
  const rows = await tx.$queryRaw<LockedClaimRow[]>(Prisma.sql`
    SELECT "c"."id"::text AS "id",
           "c"."lodging_id"::text AS "lodging_id",
           "c"."status"::text AS "status",
           "c"."created_at" AS "created_at"
      FROM "lodging_claim" AS "c"
     WHERE "c"."id" = ${claimId}::uuid
       FOR UPDATE`);
  return rows[0] ?? null;
}

/** A fresh count per decision, every one of them zero. */
function blankCounts(): Record<DispatchDecision, number> {
  return {
    unreachable: 0,
    allowlist_block: 0,
    deferred: 0,
    budget_count_failed: 0,
    target_missing: 0,
    claim_cancelled: 0,
    dialing: 0,
    dispatch_failed: 0,
    dispatch_unknown: 0,
    not_claimed: 0,
    cap_reached: 0,
    budget_refused: 0,
  };
}

/** Counts one task under one decision. */
function count(counts: Record<DispatchDecision, number>, decision: DispatchDecision): void {
  counts[decision] += 1;
}

/**
 * Records one decision under the one `call_dispatch` event (AAP 0.11.1). The fields are ids and codes — a task, a
 * claim, a decision, a blocked reason, an instant — and never a phone number, a URL or a vendor error body
 * (AAP 0.12.2).
 *
 * The code travels under `blockedReason`, not `reason`: the logger's redaction list censors `reason`, and a code that
 * has to be read back is logged under a name the list does not cover.
 */
function logDecision(
  ctx: WorkerContext,
  fields: {
    readonly taskId?: string;
    readonly claimId?: string;
    readonly decision: string;
    readonly blockedReason?: string;
    readonly until?: string;
  },
): void {
  ctx.logger.info({ event: LOG_EVENT, ...fields }, LOG_EVENT);
}

/** The class name of a failure, for a line that must not carry its message (AAP 0.11.1). */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
