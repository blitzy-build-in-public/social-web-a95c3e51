/**
 * Resolving call attempts whose dispatch or final status was never reported (AAP 0.3.2, 0.5.3).
 *
 * A dispatch can end with nothing to read: its create answer was lost, its process died between the commit
 * that created the `CallAttempt` and the call itself, or Twilio's final status callback never arrived.
 * Nothing may assume what happened, because a redial that is not certain to be safe does not happen
 * (AAP 0.3.2). This file closes those attempts under three rules:
 *
 *  - A listing proves nothing: a `calls.list` match can belong to another dispatch and an empty listing
 *    does not prove that no call exists, so candidates are counted for the operator's log and never
 *    adopted, and a listing releases no cap slot, no dialogue budget and no task. Only attempt-tied
 *    evidence is accepted — a signed callback or TwiML fetch carrying the attempt id, which the API records
 *    on the attempt itself — and every write below is guarded on the attempt still holding no `CallSid`, no
 *    final status and no outcome, so a late callback wins and this file reports `noop`.
 *  - Nothing is redialled and nothing is given back: an attempt whose create answer was lost becomes
 *    `dispatch_unknown` and is never dialled again, and the call slot and the dialogue budget stay
 *    consumed, because the call may exist and nothing can disprove it (AAP 0.5.3, 0.5.6).
 *  - The operator takes it from there: 15 minutes after the call's own `timeLimit` ran out
 *    ({@link RECONCILE_GRACE_MS}) the task becomes `needs_review` with `blockedReason` `dispatch_unknown`
 *    (no `CallSid` at all) or `no_final_status` (a `CallSid` whose call cannot be read), and `outcomeAt` is
 *    stamped so the metrics of AAP 0.5.7 count the outcome.
 *
 * A task whose attempt holds no `CallSid` is written straight to `needs_review` here — nothing else can, as
 * `call-results` only ever applies an outcome that was recorded — while a read `CallSid` settles the attempt
 * alone, with one `apply_call_result` outbox row for `jobs/call-results.ts` to apply to the task and its
 * claim (AAP 0.5.3, 0.5.6).
 *
 * Twilio is reached only through {@link TelephonyClient} and only outside a transaction (AAP 0.2.2): the
 * fetch and the candidate listing both run before the transaction that writes, so no row lock is held across
 * a provider call. Time comes from `deps.clock` alone (AAP 0.11.1), and every log line carries an event, the
 * attempt and task ids and the decision — never a phone number, a `CallSid` or a candidate (AAP 0.12.2).
 */

import { Prisma } from '@tablemate/db';
import { localDateKey, parseOutboxPayload } from '@tablemate/server-core';
import { CALL_DISPATCH_GRACE_MINUTES, MINUTE_MS, isMachineAnswer } from '@tablemate/shared';

import { fromNumberFor, returnClaimToPending } from './dispatch-twilio.ts';

import type { DbClient } from '@tablemate/db';
import type {
  Clock,
  FetchedCall,
  LlmReservation,
  LlmSpend,
  Logger,
  TelephonyClient,
  WorkersEnv,
} from '@tablemate/server-core';
import type { CallAttemptOutcome, TwilioCallStatus } from '@tablemate/shared';

/** The one log event every decision in this file is recorded under (AAP 0.11.1). */
const LOG_EVENT = 'call_reconcile';

/**
 * How long after a call's own `timeLimit` ran out an unreconciled attempt is resolved (AAP 0.5.3):
 * `CALL_DISPATCH_GRACE_MINUTES` past the point Twilio's `timeLimit` must have ended the call, so a live
 * dispatch is never resolved out from under itself and a call whose last callback is merely late still has
 * time to arrive.
 */
export const RECONCILE_GRACE_MS = CALL_DISPATCH_GRACE_MINUTES * MINUTE_MS;

/** Milliseconds in a second, for the shared constant `CAP_CALL_SECONDS` states in seconds. */
const SECOND_MS = 1_000;

/** How many attempts one pass of {@link reconcileDue} resolves. */
const RECONCILE_BATCH_SIZE = 20;

/**
 * Twilio's error codes for a destination number that cannot exist (AAP 0.5.3), a copy of the set in the
 * API's `status-webhook.ts`: `apps/workers` cannot import `apps/api` (AAP 0.3.2 places the two processes
 * apart), so the two copies have to stay identical — a code admitted in one and not the other would have the
 * same call end a task in one process and leave it retrying in the other. `13224` and `13225` stay out
 * because both also cover a number that cannot be reached right now, and an unrecognized failure reads as
 * "not an invalid number", which leaves the task its retry.
 */
const INVALID_NUMBER_ERROR_CODES: ReadonlySet<string> = new Set(['13223', '21211', '21217']);

/** The outcome a fetched call produces, which is never `completed` or `refused` (AAP 0.5.3). */
type FetchedOutcome = Extract<CallAttemptOutcome, 'no_answer' | 'unreachable' | 'needs_review'>;

/**
 * What resolving one attempt decided (AAP 0.5.3), discriminated on `kind` so a caller handles every case to
 * compile:
 *
 *  - `not_due` — the attempt is still inside its call's own `timeLimit` plus {@link RECONCILE_GRACE_MS};
 *    nothing was read from Twilio and nothing was written.
 *  - `noop` — the attempt is gone, already carries an outcome, or was claimed by attempt-tied evidence while
 *    this resolution ran.
 *  - `dispatch_unknown_review` — no `CallSid` was ever reported, so the attempt is `dispatch_unknown` and the
 *    task waits in the operator queue with `blockedReason = dispatch_unknown`; `candidateCount` is how many
 *    calls `calls.list` offered for the number pair, a diagnostic for the operator and never evidence.
 *  - `final_status_recorded` — the call was read by its `CallSid`, the attempt now carries its final status
 *    and outcome, and one `apply_call_result` row asks `jobs/call-results.ts` to apply it.
 *  - `no_final_status_review` — the call behind the `CallSid` could not be read, so the task waits in the
 *    operator queue with `blockedReason = no_final_status`.
 */
export type ReconcileResult =
  | { readonly kind: 'not_due' }
  | { readonly kind: 'noop' }
  | { readonly kind: 'dispatch_unknown_review'; readonly candidateCount: number | null }
  | { readonly kind: 'final_status_recorded'; readonly outcome: FetchedOutcome }
  | { readonly kind: 'no_final_status_review' };
/**
 * Everything a resolution reads, passed in rather than reached for (AAP 0.5.1): the database, the telephony
 * client, the injected clock, the parsed environment and the logger. `env` is narrowed to the two fields this
 * file touches, and `spend` to `releaseLlm` alone, because this file releases the dialogue budget of a call
 * that was never answered (AAP 0.5.6) and must never make a reservation.
 */
export interface ReconcileDeps {
  readonly db: DbClient;
  readonly telephony: TelephonyClient;
  readonly clock: Clock;
  readonly env: Pick<WorkersEnv, 'CAP_CALL_SECONDS' | 'telephony'>;
  readonly logger: Logger;
  readonly spend: Pick<LlmSpend, 'releaseLlm'>;
}

/**
 * The columns a resolution reads on the attempt and the task behind it, in one query. The target is read
 * through the guarded client rather than by raw SQL, so the fixture guard's narrowing reaches the `place` and
 * `lodging` rows it reads (AAP 0.5.2).
 */
const ATTEMPT_SELECT = {
  id: true,
  state: true,
  outcome: true,
  twilioCallSid: true,
  twilioFinalStatus: true,
  extractedFields: true,
  startedAt: true,
  llmReservedMicros: true,
  callTask: {
    select: {
      id: true,
      status: true,
      lodgingClaimId: true,
      place: {
        select: { phone: true, cityId: true, city: { select: { timezone: true } } },
      },
      lodging: {
        select: { phone: true, cityId: true, city: { select: { timezone: true } } },
      },
    },
  },
} as const satisfies Prisma.CallAttemptSelect;

/** The attempt row {@link ATTEMPT_SELECT} reads, with the task it belongs to and that task's target. */
type AttemptRow = Prisma.CallAttemptGetPayload<{ select: typeof ATTEMPT_SELECT }>;

/**
 * The number a call reached and the city whose day its dialogue budget was reserved on (AAP 0.5.6). `phone`
 * is `null` for a target the guard hides, one that was deleted, and one stored blank; the candidate listing
 * is the only thing that reads it, so a target without one still resolves.
 */
interface CallTarget {
  readonly cityId: string;
  readonly timezone: string;
  readonly phone: string | null;
}

/**
 * The lines every decision is logged with (AAP 0.11.1). `taskId` is absent only when the attempt's task is
 * gone, and a `candidateCount` of `null` means "not known", never zero.
 */
interface LogFields {
  readonly attemptId: string;
  readonly taskId?: string | undefined;
  readonly candidateCount?: number | null | undefined;
}

/**
 * What a call read by its `CallSid` produced, or `null` when there is nothing to record yet (AAP 0.5.3).
 *
 * The mapping is Twilio's own vocabulary to the outcome the task's lifecycle is driven by, and it is the same
 * one the API's status callback applies: `busy`, `no-answer` and `canceled` reached nobody and keep the task
 * its retry; a machine that answered is the same as nobody; a `failed` call is `unreachable` only for a number
 * that cannot exist; and a `completed` call whose relay recorded nothing is a call dropped before any data —
 * unless the attempt already holds extracted fields, which belongs in the operator queue.
 *
 * A status that has not ended the call is `null`: the call is still up, and {@link reconcileAttempt} leaves it
 * for the next pass or for its own callback. `completed` is deliberately *not* mapped to `completed`, because
 * the dialogue that would know it ran in the API and recorded its own outcome there.
 */
export function mapFetchedFinalStatus(
  call: {
    readonly status: TwilioCallStatus;
    readonly errorCode?: number | undefined;
    readonly answeredBy?: string | undefined;
  },
  hasExtractedFields: boolean,
): FetchedOutcome | null {
  switch (call.status) {
    case 'busy':
    case 'no-answer':
    case 'canceled':
      return 'no_answer';
    case 'failed':
      return isInvalidNumber(call.errorCode) ? 'unreachable' : 'no_answer';
    case 'completed':
      if (isMachineAnswer(call.answeredBy)) {
        return 'no_answer';
      }
      return hasExtractedFields ? 'needs_review' : 'no_answer';
    default:
      // `queued`, `initiated`, `ringing` and `in-progress`: the call has not ended, so there is no
      // final status to record and nothing to decide.
      return null;
  }
}

/*
 * The machine-detection rule is not a local value here: `isMachineAnswer` comes from
 * `@tablemate/shared`, the one definition this file shares with the API's TwiML route, which reads
 * the same `AnsweredBy` on the call it answers. One call therefore cannot be a person in one process
 * and a machine in the other (AAP 0.5.3, AAP 0.8.1, AAP 0.11.1).
 */

/**
 * Whether a fetched call's error code says the destination number cannot exist (AAP 0.5.3). The code is read
 * as the string {@link INVALID_NUMBER_ERROR_CODES} holds — Twilio posts it as a string on a callback, and the
 * fetch narrows it to a number — and an unrecognized code leaves the task the retry AAP 0.5.3 gives it.
 */
function isInvalidNumber(errorCode?: number): boolean {
  return errorCode !== undefined && INVALID_NUMBER_ERROR_CODES.has(String(errorCode));
}

/**
 * Resolve the attempts of one city that are due and still unresolved (AAP 0.5.3).
 *
 * The selection is the due attempts whose task is still `in_progress`, whose target sits in `cityId`, and that
 * are in one of the two states no writer can move on its own: no `CallSid` at all and still `dispatching` or
 * `dispatch_unknown`, or a `CallSid` with `dialing`/`in_progress` whose final status never arrived. At most
 * {@link RECONCILE_BATCH_SIZE} are taken, oldest first. The guards on the writes below are what make this pass
 * safe to run at any time and any number of times.
 *
 * The due bound is computed from `deps.clock` once for the whole pass, and the guard reads `call_task` and the
 * target through the guarded client, so the `place` and `lodging` rows of a fixture business are invisible
 * outside `test` and `demo` (AAP 0.5.2). The bound is arithmetic on `started_at` rather than a SQL interval, so
 * this pass and a single attempt are measured against one expression.
 *
 * One attempt's failure never blocks the others: each is caught and logged with its id and the error's name
 * alone — never its message, which a vendor error could fill with a URL or a number (AAP 0.11.1) — and the pass
 * carries on, leaving that attempt for the next pass.
 */
export async function reconcileDue(
  cityId: string,
  deps: ReconcileDeps,
): Promise<ReconcileResult[]> {
  const now = deps.clock.now();
  const due = await deps.db.callAttempt.findMany({
    where: {
      outcome: null,
      startedAt: { lte: dueBefore(now, deps.env.CAP_CALL_SECONDS) },
      callTask: {
        status: 'in_progress',
        OR: [{ place: { cityId } }, { lodging: { cityId } }],
      },
      OR: [
        { state: { in: ['dispatching', 'dispatch_unknown'] }, twilioCallSid: null },
        {
          state: { in: ['dialing', 'in_progress'] },
          twilioCallSid: { not: null },
          twilioFinalStatus: null,
        },
      ],
    },
    select: { id: true },
    orderBy: { startedAt: 'asc' },
    take: RECONCILE_BATCH_SIZE,
  });
  const results: ReconcileResult[] = [];
  for (const { id } of due) {
    try {
      results.push(await reconcileAttempt(id, deps));
    } catch (error) {
      deps.logger.warn(
        { event: LOG_EVENT, attemptId: id, decision: 'error', errorName: errorName(error) },
        LOG_EVENT,
      );
    }
  }
  return results;
}

/**
 * Resolve one call attempt whose dispatch or final status was never reported (AAP 0.5.3).
 *
 * The attempt and the task behind it are read in one query, and the guards are asked in this order, which is
 * part of the rule: the attempt must still be open — it exists, carries no outcome and its task is still
 * `in_progress`, or the answer is `noop`; then it must be due, at least `CAP_CALL_SECONDS` plus
 * {@link RECONCILE_GRACE_MS} after it started, because before that the call may genuinely still be up and
 * nothing is read from Twilio; then the case decides, with no `CallSid` going to
 * {@link resolveWithoutCallSid} and a `CallSid` with no final status to {@link resolveWithCallSid}, and any
 * other state — `dispatch_failed` above all, whose call never existed — answering `noop`.
 */
export async function reconcileAttempt(
  attemptId: string,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  // One instant for the whole resolution: the due test, every timestamp written and the log line all
  // describe the same moment (AAP 0.11.1).
  const now = deps.clock.now();
  const attempt = await deps.db.callAttempt.findUnique({
    where: { id: attemptId },
    select: ATTEMPT_SELECT,
  });
  if (attempt === null) {
    return settle(deps, 'noop', { attemptId }, { kind: 'noop' });
  }
  const taskId = attempt.callTask.id;
  if (attempt.outcome !== null || attempt.callTask.status !== 'in_progress') {
    return settle(deps, 'noop', { attemptId, taskId }, { kind: 'noop' });
  }
  if (!isDue(now, attempt.startedAt, deps.env.CAP_CALL_SECONDS)) {
    return settle(deps, 'not_due', { attemptId, taskId }, { kind: 'not_due' });
  }
  const target = targetOf(attempt.callTask);
  if (attempt.twilioCallSid === null) {
    if (attempt.state !== 'dispatching' && attempt.state !== 'dispatch_unknown') {
      return settle(deps, 'noop', { attemptId, taskId }, { kind: 'noop' });
    }
    return await resolveWithoutCallSid(deps, attempt, target, now);
  }
  if (
    attempt.twilioFinalStatus !== null ||
    (attempt.state !== 'dialing' && attempt.state !== 'in_progress')
  ) {
    return settle(deps, 'noop', { attemptId, taskId }, { kind: 'noop' });
  }
  return await resolveWithCallSid(deps, attempt, target, now);
}

/**
 * Resolve an attempt that holds no `CallSid` (AAP 0.3.2, 0.5.3).
 *
 * The candidate listing comes first and is never evidence: it runs outside any transaction, its count is the
 * one thing this file keeps from it, and a listing that fails or a target with no number both read as `null`,
 * which is exactly what a listing can establish.
 *
 * The single transaction then does the three writes AAP 0.5.3 asks for, in an order that keeps each honest: the
 * attempt becomes `dispatch_unknown` with outcome `needs_review`, guarded on still being `dispatching` or
 * `dispatch_unknown`, still holding no `CallSid` and still carrying no outcome, where zero rows means
 * attempt-tied evidence arrived meanwhile and this returns `noop`; the task becomes `needs_review` with
 * `blockedReason = dispatch_unknown` and its `outcomeAt` stamped (AAP 0.5.7), guarded on it still being
 * `in_progress`; and a lodging claim returns to `pending_call`, because the call is certainly over.
 */
async function resolveWithoutCallSid(
  deps: ReconcileDeps,
  attempt: AttemptRow,
  target: CallTarget | null,
  now: Date,
): Promise<ReconcileResult> {
  const taskId = attempt.callTask.id;
  const candidateCount = await countCandidateCalls(deps, attempt, target);
  const written = await deps.db.$transaction(async (tx) => {
    const attempts = await tx.$executeRaw(Prisma.sql`
      UPDATE "call_attempt"
         SET "state" = 'dispatch_unknown',
             "outcome" = 'needs_review'
       WHERE "id" = ${attempt.id}::uuid
         AND "state" IN ('dispatching', 'dispatch_unknown')
         AND "twilio_call_sid" IS NULL
         AND "outcome" IS NULL`);
    if (attempts === 0) {
      return false;
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "call_task"
         SET "status" = 'needs_review',
             "blocked_reason" = 'dispatch_unknown',
             "outcome_at" = ${now}::timestamptz,
             "updated_at" = ${now}::timestamptz
       WHERE "id" = ${taskId}::uuid
         AND "status" = 'in_progress'`);
    await returnClaimToPending(tx, attempt.callTask.lodgingClaimId);
    return true;
  });
  return written
    ? settle(
        deps,
        'dispatch_unknown_review',
        { attemptId: attempt.id, taskId, candidateCount },
        { kind: 'dispatch_unknown_review', candidateCount },
      )
    : settle(deps, 'noop', { attemptId: attempt.id, taskId }, { kind: 'noop' });
}

/**
 * How many calls `calls.list` offers for the attempt's number pair, for the log alone (AAP 0.3.2): a match may
 * belong to another dispatch and an empty listing proves nothing, so nothing in this file branches on it.
 */
async function countCandidateCalls(
  deps: ReconcileDeps,
  attempt: AttemptRow,
  target: CallTarget | null,
): Promise<number | null> {
  if (target === null || target.phone === null) {
    return null;
  }
  const phone = target.phone;
  try {
    const candidates = await deps.telephony.listCalls({
      to: phone,
      from: fromNumberFor(deps.env),
      startTimeAfter: attempt.startedAt,
    });
    return candidates.length;
  } catch {
    // A listing that failed changes no state: no candidate is adopted, no reservation is released
    // and no task is moved on the strength of it (AAP 0.3.2).
    return null;
  }
}

/**
 * Resolve an attempt that holds a `CallSid` and no final status (AAP 0.5.3).
 *
 * The call is fetched by that `CallSid` outside any transaction. A call that cannot be read, or that has not
 * ended, goes the `no_final_status` way: the task to the operator queue, the attempt `needs_review`, the claim
 * back to `pending_call`, and the dialogue budget deliberately *not* released, because the call was answered
 * and nothing here says the relay never spent a turn (AAP 0.5.6). A call that ended is closed with Twilio's
 * final status, the outcome {@link mapFetchedFinalStatus} derives, its `endedAt` and duration, and one
 * `apply_call_result` outbox row; the task itself is left alone, because its `outcomeAt`, its requeue and its
 * `unreachable`/`invalid_number` ending are `jobs/call-results.ts`'s work (AAP 0.5.3, 0.5.7).
 *
 * A call nobody answered never ran the dialogue, so its whole reservation is unused and is given back: the
 * attempt's `llm_reserved_micros` is zeroed in the same transaction and {@link relayNeverRan} decides whether
 * the store is asked to release it after the commit, on the city and local day the dispatch reserved against.
 */
async function resolveWithCallSid(
  deps: ReconcileDeps,
  attempt: AttemptRow,
  target: CallTarget | null,
  now: Date,
): Promise<ReconcileResult> {
  const callSid = attempt.twilioCallSid;
  const taskId = attempt.callTask.id;
  if (callSid === null) {
    return settle(deps, 'noop', { attemptId: attempt.id, taskId }, { kind: 'noop' });
  }
  const fetched = await fetchCallOrNull(deps, callSid);
  const outcome =
    fetched === null ? null : mapFetchedFinalStatus(fetched, attempt.extractedFields !== null);
  if (fetched === null || outcome === null) {
    return await reviewWithoutFinalStatus(deps, attempt, now);
  }
  // Derived before the transaction and read inside it, where every value has to be a `const`: the
  // release needs the amount the attempt held *before* this resolution zeroes it.
  const status = fetched.status;
  const durationSec = fetched.durationSec ?? null;
  const releaseBudget = relayNeverRan(fetched);
  const reservation = releaseBudget ? reservationFor(target, attempt) : null;
  const written = await deps.db.$transaction(async (tx) => {
    const attempts = await tx.$executeRaw(Prisma.sql`
      UPDATE "call_attempt"
         SET "state" = 'ended',
             "twilio_final_status" = ${status},
             "ended_at" = COALESCE("ended_at", ${now}::timestamptz),
             "outcome" = ${outcome}::"call_attempt_outcome",
             "duration_sec" = COALESCE("duration_sec", ${durationSec}::int)
       WHERE "id" = ${attempt.id}::uuid
         AND "outcome" IS NULL
         AND "state" <> 'ended'`);
    if (attempts === 0) {
      return false;
    }
    await tx.outboxMessage.create({
      data: {
        kind: 'apply_call_result',
        payload: parseOutboxPayload('apply_call_result', {
          callAttemptId: attempt.id,
        }) as Prisma.InputJsonValue,
        createdAt: now,
      },
      select: { id: true },
    });
    if (releaseBudget) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "call_attempt"
           SET "llm_reserved_micros" = 0
         WHERE "id" = ${attempt.id}::uuid`);
    }
    return true;
  });
  if (!written) {
    return settle(deps, 'noop', { attemptId: attempt.id, taskId }, { kind: 'noop' });
  }
  if (reservation !== null) {
    // After the commit, on the store's own connection: a spend statement inside the transaction would
    // hold the attempt's row lock across a second connection (AAP 0.2.2, AAP 0.3.2).
    await deps.spend.releaseLlm(reservation);
  }
  return settle(
    deps,
    'final_status_recorded',
    { attemptId: attempt.id, taskId },
    { kind: 'final_status_recorded', outcome },
  );
}

/**
 * The `no_final_status` path (AAP 0.5.3): the call could not be read, or it has not ended. One transaction
 * writes the three rows the operator queue needs — the task guarded on it still being `in_progress`, the
 * attempt carrying `needs_review` so a later callback or pass finds it decided rather than open, and the claim
 * back to `pending_call` — because the operator's resolution of the task is what moves it on from there.
 */
async function reviewWithoutFinalStatus(
  deps: ReconcileDeps,
  attempt: AttemptRow,
  now: Date,
): Promise<ReconcileResult> {
  const taskId = attempt.callTask.id;
  await deps.db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      UPDATE "call_task"
         SET "status" = 'needs_review',
             "blocked_reason" = 'no_final_status',
             "outcome_at" = ${now}::timestamptz,
             "updated_at" = ${now}::timestamptz
       WHERE "id" = ${taskId}::uuid
         AND "status" = 'in_progress'`);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "call_attempt"
         SET "outcome" = 'needs_review'
       WHERE "id" = ${attempt.id}::uuid
         AND "outcome" IS NULL`);
    await returnClaimToPending(tx, attempt.callTask.lodgingClaimId);
  });
  return settle(
    deps,
    'no_final_status_review',
    { attemptId: attempt.id, taskId },
    { kind: 'no_final_status_review' },
  );
}

/**
 * Read one call by its `CallSid`, reporting a fetch that failed as no answer at all (AAP 0.5.3): a Twilio
 * failure is not a call result, so the caller takes the `no_final_status` path rather than inventing a status.
 * The error is not kept — a vendor error can carry the request URI — and no attempt is failed because of it.
 */
async function fetchCallOrNull(deps: ReconcileDeps, callSid: string): Promise<FetchedCall | null> {
  try {
    return await deps.telephony.fetchCall(callSid);
  } catch {
    return null;
  }
}

/**
 * Whether a call that ended never reached the dialogue (AAP 0.5.6): a status other than `completed` never
 * handed the call to a ConversationRelay session, and a `completed` call Twilio reports as a machine was hung
 * up on by the API's TwiML route before the relay opened, so both leave the reservation unused — while a
 * `completed` call that reached a person may have spent turns and releases nothing.
 */
function relayNeverRan(call: FetchedCall): boolean {
  return call.status !== 'completed' || isMachineAnswer(call.answeredBy);
}

/**
 * The dialogue budget the attempt holds, rebuilt from the attempt and its city (AAP 0.5.6): `call-dispatch`
 * reserved it on the dispatch-time local day of the city, so releasing it has to name that same city and day
 * or it would land on a counter nothing reserved against. The amount is read from the row this resolution is
 * about to zero, which makes the release the whole reservation and never more; a value that is not a positive
 * safe integer reads as nothing to release.
 */
function reservationFor(target: CallTarget | null, attempt: AttemptRow): LlmReservation | null {
  if (target === null) {
    return null;
  }
  const micros = Number(attempt.llmReservedMicros);
  return {
    cityId: target.cityId,
    localDate: localDateKey(target.timezone, attempt.startedAt),
    micros: Number.isSafeInteger(micros) && micros > 0 ? micros : 0,
  };
}

/**
 * The target a call reached: the task's place or lodging, with the number and the city whose day its
 * dialogue budget was reserved on (AAP 0.5.6).
 */
function targetOf(task: AttemptRow['callTask']): CallTarget | null {
  const source = task.place ?? task.lodging;
  if (source === null) {
    return null;
  }
  return {
    cityId: source.cityId,
    timezone: source.city.timezone,
    phone: usablePhone(source.phone),
  };
}

/** The stored number when it holds something other than whitespace, else `null` (AAP 0.5.6). */
function usablePhone(phone: string | null): string | null {
  return phone !== null && phone.trim().length > 0 ? phone : null;
}

/**
 * When an attempt started late enough to be due (AAP 0.3.2, 0.5.3): at least the call's own time limit
 * plus {@link RECONCILE_GRACE_MS} ago, so the call can no longer be live.
 */
function isDue(now: Date, startedAt: Date, capCallSeconds: number): boolean {
  return startedAt.getTime() <= dueBefore(now, capCallSeconds).getTime();
}

/**
 * The latest `startedAt` an attempt may have and still be due now: the bound {@link reconcileDue}
 * selects by, and the same arithmetic {@link isDue} applies to one attempt, so a pass and a resolution
 * of one attempt can never disagree about which attempts are due.
 */
function dueBefore(now: Date, capCallSeconds: number): Date {
  return new Date(now.getTime() - (capCallSeconds * SECOND_MS + RECONCILE_GRACE_MS));
}

/**
 * Log one resolution decision and hand the caller's result straight back (AAP 0.11.1), so a
 * resolution reads as a sequence of decisions without a branch wrapped around every one of them.
 */
function settle(
  deps: ReconcileDeps,
  decision: string,
  fields: LogFields,
  result: ReconcileResult,
): ReconcileResult {
  deps.logger.info({ event: LOG_EVENT, decision, ...fields }, LOG_EVENT);
  return result;
}

/**
 * The name of a thrown value, for a log line that must carry nothing else (AAP 0.11.1): a vendor
 * error's name names the failure, while its message can hold a request URI.
 */
function errorName(error: unknown): string {
  return error instanceof Error && error.name !== '' ? error.name : 'Error';
}
