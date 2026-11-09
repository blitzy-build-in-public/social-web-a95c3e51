/**
 * Resolving call attempts whose dispatch or final status was never reported. Nothing may assume what happened, because a
 * redial that is not certain to be safe does not happen: a `calls.list` match can belong to another dispatch and an empty
 * listing proves nothing, so candidates are counted for the operator's log and never adopted, and a listing releases no cap
 * slot, no dialogue budget and no task. Only attempt-tied evidence is accepted — a signed callback or a TwiML fetch carrying
 * the attempt id — and every write below is guarded on the attempt still holding no `CallSid`, no final status and no
 * outcome, so a late callback wins and this file reports `noop`. Nothing is redialled and nothing is given back: an attempt
 * whose create answer was lost becomes `dispatch_unknown` and the call slot and the dialogue budget stay consumed, because
 * the call may exist and nothing can disprove it.
 *
 * {@link RECONCILE_GRACE_MS} after the call's own `timeLimit` ran out, the task becomes `needs_review` with `blockedReason`
 * `dispatch_unknown` or `no_final_status` and `outcomeAt` stamped. A task whose attempt holds no `CallSid` is written
 * straight to `needs_review` here — `call-results` only ever applies an outcome that was recorded — while a read `CallSid`
 * settles the attempt alone, with one `apply_call_result` outbox row for `jobs/call-results.ts`. Twilio is reached only
 * through {@link TelephonyClient} and only outside a transaction, so no row lock is held across a provider call, and no log
 * line carries a phone number, a `CallSid` or a candidate.
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

const LOG_EVENT = 'call_reconcile';
// `CALL_DISPATCH_GRACE_MINUTES` past the point Twilio's `timeLimit` must have ended the call, so a live dispatch is never resolved out from under itself and a call whose last callback is merely late still has time to arrive.
export const RECONCILE_GRACE_MS = CALL_DISPATCH_GRACE_MINUTES * MINUTE_MS;
const SECOND_MS = 1_000;
/** How many attempts one pass of {@link reconcileDue} resolves. */
const RECONCILE_BATCH_SIZE = 20;
// Twilio's error codes for a destination number that cannot exist, a copy of the set in the API's `status-webhook.ts`: `apps/workers` cannot import `apps/api`, so the two copies have to stay identical. `13224` and `13225` stay out because both also cover a number unreachable right now; an unrecognized code leaves the retry.
const INVALID_NUMBER_ERROR_CODES: ReadonlySet<string> = new Set(['13223', '21211', '21217']);
// The outcome a fetched call produces, which is never `completed` or `refused` (AAP 0.5.3).
type FetchedOutcome = Extract<CallAttemptOutcome, 'no_answer' | 'unreachable' | 'needs_review'>;
// What resolving one attempt decided: `not_due` is inside the call's own `timeLimit` plus {@link RECONCILE_GRACE_MS}, nothing read and nothing written; `noop` is an attempt gone, already carrying an outcome, or claimed by attempt-tied evidence while this resolution ran; the two `_review` cases leave the task in the operator queue with `blockedReason` `dispatch_unknown` (no `CallSid` ever reported; `candidateCount` is a diagnostic, never evidence) or `no_final_status` (a `CallSid` whose call cannot be read); `final_status_recorded` was read by its `CallSid` and one `apply_call_result` row asks `jobs/call-results.ts` to apply it.
export type ReconcileResult =
  | { readonly kind: 'not_due' }
  | { readonly kind: 'noop' }
  | { readonly kind: 'dispatch_unknown_review'; readonly candidateCount: number | null }
  | { readonly kind: 'final_status_recorded'; readonly outcome: FetchedOutcome }
  | { readonly kind: 'no_final_status_review' };
// Everything a resolution reads, passed in rather than reached for. `spend` is narrowed to `releaseLlm` alone: this file releases the dialogue budget of a call that was never answered and never makes a reservation.
export interface ReconcileDeps {
  readonly db: DbClient;
  readonly telephony: TelephonyClient;
  readonly clock: Clock;
  readonly env: Pick<WorkersEnv, 'CAP_CALL_SECONDS' | 'telephony'>;
  readonly logger: Logger;
  readonly spend: Pick<LlmSpend, 'releaseLlm'>;
}

// The columns a resolution reads, through the guarded client so the fixture guard narrows the `place` and `lodging`.
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
type AttemptRow = Prisma.CallAttemptGetPayload<{ select: typeof ATTEMPT_SELECT }>;
// The number a call reached and the city whose day its dialogue budget was reserved on. `phone` is null for a target the guard hides or one stored blank, and only the candidate listing reads it.
interface CallTarget {
  readonly cityId: string;
  readonly timezone: string;
  readonly phone: string | null;
}

// The fields every decision is logged with (AAP 0.11.1); a `candidateCount` of `null` means "not known", never zero.
interface LogFields {
  readonly attemptId: string;
  readonly taskId?: string | undefined;
  readonly candidateCount?: number | null | undefined;
}

// What a call read by its `CallSid` produced, or `null` when there is nothing to record yet — the same mapping the API's status callback applies. `busy`, `no-answer` and `canceled` reached nobody and keep the task its retry; a machine that answered is the same as nobody; a `failed` call is `unreachable` only for a number that cannot exist; a `completed` call whose relay recorded nothing is a call dropped before any data, unless the attempt already holds extracted fields, which belongs in the operator queue. A status that has not ended the call is `null`, and `completed` is deliberately *not* mapped to `completed`, because the dialogue that would know it ran in the API and recorded its own outcome there.
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
      return null;
  }
}

// The machine-detection rule is not a local value: `isMachineAnswer` comes from `@tablemate/shared`, the one definition shared with the API's TwiML route, which reads the same `AnsweredBy`, so one call cannot be a person in one process and a machine in the other.

// Whether a fetched call's error code says the destination number cannot exist. An unrecognized code leaves the task the retry the AAP gives it.
function isInvalidNumber(errorCode?: number): boolean {
  return errorCode !== undefined && INVALID_NUMBER_ERROR_CODES.has(String(errorCode));
}

// Resolve the due attempts of one city that are still unresolved: at most {@link RECONCILE_BATCH_SIZE}, oldest first, in the two states no writer can move on its own — no `CallSid` and still `dispatching` or `dispatch_unknown`, or a `CallSid` whose final status never arrived. The due bound is one expression this pass shares with {@link isDue}, and the guards on the writes below are what make it safe to run at any time and any number of times. One attempt's failure never blocks the others: it is caught and logged with its id and the error's name alone — never its message, which a vendor error could fill with a URL or a number.
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

// Resolve one attempt whose dispatch or final status was never reported. The guards are asked in this order, which is part of the rule: the attempt must still be open (it exists, carries no outcome and its task is still `in_progress`, or the answer is `noop`), then due — at least `CAP_CALL_SECONDS` plus {@link RECONCILE_GRACE_MS} after it started, before which the call may genuinely still be up — and then the case decides; any other state, `dispatch_failed` above all, answers `noop`.
export async function reconcileAttempt(
  attemptId: string,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  // One instant for the whole resolution: the due test, every written timestamp and the log line.
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

// Resolve an attempt that holds no `CallSid`. The candidate listing is never evidence: it runs outside any transaction, its count is the one thing kept from it, and a listing that fails or a target with no number both read as `null`. The single transaction then does three writes in an order that keeps each honest — the attempt to `dispatch_unknown`/`needs_review`, guarded on still being open with no `CallSid` (zero rows means attempt-tied evidence arrived meanwhile, returning `noop`), the task to `needs_review` with `blockedReason = dispatch_unknown` and `outcomeAt` stamped, and a lodging claim back to `pending_call`.
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

// The count of `calls.list` matches for the attempt's number pair, for the log alone: never evidence.
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
    // A listing that failed changes no state: no candidate adopted, no reservation released, no task moved.
    return null;
  }
}

// Resolve an attempt that holds a `CallSid` and no final status. The call is fetched outside any transaction: one that cannot be read, or that has not ended, goes the `no_final_status` way — the task to the operator queue, the attempt `needs_review`, the claim back to `pending_call` — and the dialogue budget is deliberately *not* released, because the call was answered and nothing here says the relay never spent a turn. A call that ended is closed with Twilio's final status, the outcome {@link mapFetchedFinalStatus} derives, its `endedAt` and duration, and one `apply_call_result` outbox row; the task is `jobs/call-results.ts`'s. A call nobody answered never ran the dialogue, so its whole reservation is given back after the commit, on the city and local day the dispatch reserved against ({@link relayNeverRan}).
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
    // After the commit, on the store's own connection: a spend statement inside the transaction would hold the attempt's row lock across a second connection.
    await deps.spend.releaseLlm(reservation);
  }
  return settle(
    deps,
    'final_status_recorded',
    { attemptId: attempt.id, taskId },
    { kind: 'final_status_recorded', outcome },
  );
}

// The `no_final_status` path: the call could not be read, or it has not ended. One transaction writes the three rows the operator queue needs — the task, the attempt so a later callback or pass finds it decided, and the claim back to `pending_call`.
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

// Reads one call by its `CallSid`, reporting a failed fetch as no answer at all: a Twilio failure is not a call result, and the error is not kept — a vendor error can carry the request URI.
async function fetchCallOrNull(deps: ReconcileDeps, callSid: string): Promise<FetchedCall | null> {
  try {
    return await deps.telephony.fetchCall(callSid);
  } catch {
    return null;
  }
}

// Whether a call that ended never reached the dialogue: a status other than `completed` never handed the call to a ConversationRelay session, and a machine-answered `completed` call was hung up on before the relay opened — while a `completed` call that reached a person may have spent turns and releases nothing.
function relayNeverRan(call: FetchedCall): boolean {
  return call.status !== 'completed' || isMachineAnswer(call.answeredBy);
}

// The dialogue budget the attempt holds, rebuilt from the attempt and its city: it was reserved on the dispatch-time local day of the city, so the release names that same city and day, and the amount comes from the row this resolution zeroes, which makes the release the whole reservation and never more.
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

function usablePhone(phone: string | null): string | null {
  return phone !== null && phone.trim().length > 0 ? phone : null;
}

function isDue(now: Date, startedAt: Date, capCallSeconds: number): boolean {
  return startedAt.getTime() <= dueBefore(now, capCallSeconds).getTime();
}

// The latest `startedAt` an attempt may have and still be due: the bound {@link reconcileDue} selects by and the same arithmetic {@link isDue} applies, so a pass and a single resolution never disagree about what is due.
function dueBefore(now: Date, capCallSeconds: number): Date {
  return new Date(now.getTime() - (capCallSeconds * SECOND_MS + RECONCILE_GRACE_MS));
}

function settle(
  deps: ReconcileDeps,
  decision: string,
  fields: LogFields,
  result: ReconcileResult,
): ReconcileResult {
  deps.logger.info({ event: LOG_EVENT, decision, ...fields }, LOG_EVENT);
  return result;
}

// The name of a thrown value, for a log line that must carry nothing else: a vendor message can hold a URI.
function errorName(error: unknown): string {
  return error instanceof Error && error.name !== '' ? error.name : 'Error';
}
