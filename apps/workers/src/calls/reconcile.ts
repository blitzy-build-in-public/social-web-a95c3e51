/**
 * Resolving call attempts whose dispatch or final status was never reported (AAP 0.3.2, 0.5.3).
 *
 * A dispatch can end with nothing to read: its create answer was lost, its process died between the
 * commit that created the `CallAttempt` and the call itself, or Twilio's final status callback never
 * arrived. Nothing may assume what happened, because a second authorization or a redial that is not
 * certain to be safe does not happen (AAP 0.3.2). This file is the one that closes those attempts,
 * under three rules:
 *
 *  - **A listing proves nothing.** A `calls.list({ to, from, startTimeAfter })` match can belong to
 *    another dispatch, and an empty listing does not prove that no call exists, so candidates are
 *    counted for the operator's log and never adopted, and a listing releases no cap slot, no
 *    dialogue budget and no task. Only attempt-tied evidence is accepted: a signed callback or TwiML
 *    fetch carrying the attempt id, which the API's `modules/voice-agent/status-webhook.ts` and
 *    `modules/voice-agent/twiml.ts` record on the attempt itself. An attempt a callback did adopt is
 *    already out of this file's hands: every write below is guarded on the attempt still holding no
 *    `CallSid`, no final status and no outcome, so a late callback wins and this file reports `noop`.
 *  - **Nothing is redialled and nothing is given back.** An attempt whose create answer was lost
 *    becomes `dispatch_unknown` and is never dialled again; the call slot consumed by the dispatch
 *    and the dialogue budget reserved before it stay consumed, because the call may exist and
 *    nothing can disprove it (AAP 0.5.6, AAP 0.5.3).
 *  - **The operator takes it from there.** 15 minutes after the call's own `timeLimit` ran out
 *    ({@link RECONCILE_GRACE_MS}) the task becomes `needs_review` with `blockedReason`
 *    `dispatch_unknown` (no `CallSid` at all) or `no_final_status` (a `CallSid` whose call cannot be
 *    read), and `outcomeAt` is stamped so the metrics of AAP 0.5.7 count the outcome.
 *
 * What one attempt's resolution does to the *task* differs by case, deliberately:
 *
 *  - No `CallSid`: the task is written straight to `needs_review` here. Nothing else can: the task
 *    is `in_progress` with an attempt no callback can reach, and `call-results` only ever applies an
 *    outcome that was recorded (AAP 0.5.3).
 *  - A read `CallSid`: only the attempt is decided, with the outcome
 *    {@link mapFetchedFinalStatus} derives, its `endedAt` — the instant `call-results` dates the
 *    task's `outcomeAt` by — and one `apply_call_result` outbox row. Applying it is
 *    `jobs/call-results.ts`'s work: it requeues an unanswered task a day later, ends the attempts of
 *    an invalid number, and moves a lodging claim with its task (AAP 0.5.3, 0.5.6).
 *
 * Twilio is reached only through `@tablemate/server-core`'s {@link TelephonyClient} and only outside
 * a transaction (AAP 0.2.2): the fetch and the candidate listing both run before the transaction
 * that writes, so no row lock is held across a provider call. Time comes from `deps.clock` alone
 * (AAP 0.11.1), and every log line carries an event, the attempt and task ids and the decision —
 * never a phone number, a `CallSid` or a candidate (AAP 0.11.1, AAP 0.12.2).
 *
 * @see AAP 0.3.2 for the reconciliation rules and the dispatch it closes, 0.3.3 for the Twilio
 *   integration row, 0.5.3 for the call-task and attempt lifecycles, 0.5.6 for the caps and the
 *   dialogue budget, 0.5.7 for `outcomeAt`, 0.5.1 for `reconcileAttempt(attemptId)`, 0.8.1 for this
 *   file.
 */

import { Prisma } from '@tablemate/db';
import { localDateKey, parseOutboxPayload } from '@tablemate/server-core';
import { CALL_DISPATCH_GRACE_MINUTES, MINUTE_MS } from '@tablemate/shared';

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

// ---------------------------------------------------------------------------------------------
// The rules, as values (AAP 0.3.2, 0.5.3)
// ---------------------------------------------------------------------------------------------

/** The one log event every decision in this file is recorded under (AAP 0.11.1). */
const LOG_EVENT = 'call_reconcile';

/**
 * How long after a call's own `timeLimit` ran out an unreconciled attempt is resolved (AAP 0.5.3):
 * `CALL_DISPATCH_GRACE_MINUTES` past the point Twilio's `timeLimit` must have ended the call, so a
 * live dispatch — which finishes in seconds, and at the latest after `CAP_CALL_SECONDS` — is never
 * resolved out from under itself, and a call whose last callback is merely late still has time to
 * arrive.
 */
export const RECONCILE_GRACE_MS = CALL_DISPATCH_GRACE_MINUTES * MINUTE_MS;

/** Milliseconds in a second, for the shared constant `CAP_CALL_SECONDS` states in seconds. */
const SECOND_MS = 1_000;

/** How many attempts one pass of {@link reconcileDue} resolves. */
const RECONCILE_BATCH_SIZE = 20;

/**
 * Twilio's error codes for a destination number that cannot exist (AAP 0.5.3), copied from the
 * canonical set in `apps/api/src/modules/voice-agent/status-webhook.ts`.
 *
 * `apps/workers` cannot import `apps/api` (AAP 0.3.2 places the two processes apart), so the set is
 * restated here and the two copies have to stay identical: a code admitted in one and not the other
 * would have the same call end a task in one process and leave it retrying in the other. `13224` and
 * `13225` stay out for the reason the API's comment gives — both also cover a number that cannot be
 * reached right now — and an unrecognized failure reads as "not an invalid number", which leaves the
 * task its retry.
 */
const INVALID_NUMBER_ERROR_CODES: ReadonlySet<string> = new Set(['13223', '21211', '21217']);

/**
 * The prefix of every machine-detection verdict that reported a machine rather than a person:
 * `machine_start`, from a machine still playing its greeting, and `machine_end_*`, whose greeting
 * has ended. Twilio's `human`, `unknown` and every verdict outside this set read as a person, which
 * is the safe direction — a person treated as a machine throws a reachable call away.
 */
const MACHINE_VERDICT_PREFIX = 'machine';

/** The other verdict that means nobody answered: a fax machine picked the call up. */
const FAX_VERDICT = 'fax';

/** The outcome a fetched call produces, which is never `completed` or `refused` (AAP 0.5.3). */
type FetchedOutcome = Extract<CallAttemptOutcome, 'no_answer' | 'unreachable' | 'needs_review'>;

// ---------------------------------------------------------------------------------------------
// What a caller is given, and what one resolution reports (AAP 0.5.1, 0.5.3)
// ---------------------------------------------------------------------------------------------

/**
 * What resolving one attempt decided (AAP 0.5.3), discriminated on `kind` so a caller handles every
 * case to compile:
 *
 *  - `not_due` — the attempt is still inside its call's own `timeLimit` plus
 *    {@link RECONCILE_GRACE_MS}; nothing was read from Twilio and nothing was written.
 *  - `noop` — the attempt is gone, already carries an outcome, or was claimed by attempt-tied
 *    evidence while this resolution ran. A second run of the same attempt is always this.
 *  - `dispatch_unknown_review` — no `CallSid` was ever reported: the attempt is `dispatch_unknown`
 *    and the task waits in the operator queue with `blockedReason = dispatch_unknown`.
 *    `candidateCount` is how many calls `calls.list` offered for the number pair, which is a
 *    diagnostic for the operator and never evidence: `null` when there was no number to list by or
 *    the listing failed.
 *  - `final_status_recorded` — the call was read by its `CallSid`, the attempt now carries its final
 *    status and outcome, and one `apply_call_result` row asks `jobs/call-results.ts` to apply it.
 *  - `no_final_status_review` — the call behind the `CallSid` could not be read: the task waits in
 *    the operator queue with `blockedReason = no_final_status`.
 */
export type ReconcileResult =
  | { readonly kind: 'not_due' }
  | { readonly kind: 'noop' }
  | { readonly kind: 'dispatch_unknown_review'; readonly candidateCount: number | null }
  | { readonly kind: 'final_status_recorded'; readonly outcome: FetchedOutcome }
  | { readonly kind: 'no_final_status_review' };

/**
 * Everything a resolution reads, passed in rather than reached for (AAP 0.5.1): the database, the
 * telephony client, the injected clock, the parsed environment and the logger.
 *
 * `env` is narrowed to the two fields this file touches, so a caller passes its whole `WorkersEnv`
 * while a suite builds only these: `CAP_CALL_SECONDS` is the call's own time limit, the due bound
 * below is measured from it, and `telephony` is the mode and credentials a candidate listing needs.
 *
 * `spend` is a dependency beyond the dispatch's own list, added because this file releases the
 * dialogue budget of a call that was never answered (AAP 0.5.6) — and narrowed to `releaseLlm`, the
 * one operation it uses, so a caller cannot reach a reservation this file must never make.
 */
export interface ReconcileDeps {
  readonly db: DbClient;
  readonly telephony: TelephonyClient;
  readonly clock: Clock;
  readonly env: Pick<WorkersEnv, 'CAP_CALL_SECONDS' | 'telephony'>;
  readonly logger: Logger;
  readonly spend: Pick<LlmSpend, 'releaseLlm'>;
}

// ---------------------------------------------------------------------------------------------
// The attempt, its task and the number the call reached
// ---------------------------------------------------------------------------------------------

/**
 * The columns a resolution reads on the attempt and the task behind it, in one query.
 *
 * The target is read through the guarded client rather than by raw SQL, so the fixture guard's
 * `is_fixture = false` narrowing reaches the `place` and `lodging` rows it reads (AAP 0.5.2): a
 * fixture business is invisible outside `test` and `demo`, which costs this file only the candidate
 * count of a `calls.list` a demo would never make. The task is a required relation of the attempt, so
 * `callTask` is never absent; `place` and `lodging` are the task's one optional target each.
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
 * The number a call reached and the city whose day its dialogue budget was reserved on (AAP 0.5.6).
 *
 * `phone` is `null` for a target the guard hides, one that was deleted, and one stored blank; the
 * candidate listing is the only thing that reads it, so a target without one still resolves.
 */
interface CallTarget {
  readonly cityId: string;
  readonly timezone: string;
  readonly phone: string | null;
}

/**
 * The lines every decision is logged with (AAP 0.11.1).
 *
 * `taskId` is absent only when the attempt's task is gone, which leaves nothing to name; a
 * `candidateCount` of `null` means "not known", never zero.
 */
interface LogFields {
  readonly attemptId: string;
  readonly taskId?: string | undefined;
  readonly candidateCount?: number | null | undefined;
}

// ---------------------------------------------------------------------------------------------
// Reading a fetched call (AAP 0.5.3)
// ---------------------------------------------------------------------------------------------

/**
 * What a call read by its `CallSid` produced, or `null` when there is nothing to record yet
 * (AAP 0.5.3).
 *
 * The mapping is Twilio's own vocabulary to the outcome the task's lifecycle is driven by, and it is
 * the same one the API's status callback applies to a callback: `busy`, `no-answer` and `canceled`
 * reached nobody and keep the task its retry; a machine that answered is the same as nobody; a
 * `failed` call is `unreachable` only for a number that cannot exist and otherwise a call that was
 * not answered; and a `completed` call whose relay recorded nothing is a call dropped before any
 * data, which is `no_answer` — unless the attempt already holds extracted fields, which means the
 * script ran and got part way, and that belongs in the operator queue.
 *
 * A status that has not ended the call — `queued`, `initiated`, `ringing`, `in-progress` — is `null`:
 * the call is still up, and {@link reconcileAttempt} leaves it for the next pass or for its own
 * callback. `completed` is deliberately *not* mapped to `completed`: this file never declares a call
 * successful, because the dialogue that would know it ran in the API and recorded its own outcome,
 * and an attempt reaching here with none has none.
 *
 * @param call - What {@link TelephonyClient.fetchCall} reported. `errorCode` is never set by that
 *   method — Twilio's Call resource carries no error code — so an invalid number is recognized from
 *   a status callback instead, and this mapping stays correct for the day it is.
 * @param hasExtractedFields - Whether the attempt already holds extracted fields: the difference
 *   between a call dropped before any data and one dropped mid-script.
 * @returns The outcome to record, or `null` when the call has not ended.
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

/**
 * Whether Twilio's machine detection found a machine rather than a person (AAP 0.5.3).
 *
 * The rule is `apps/api/src/modules/voice-agent/twiml.ts`'s `isMachineAnswer`: the verdict is
 * normalized first, so a stray case or a space cannot turn a machine into a person, and `machine_*`
 * together with `fax` is a machine. That process cannot be imported here (AAP 0.3.2), so the rule is
 * restated — and it stays equivalent, because `machine_start` and the `machine_end_*` verdicts are
 * the only verdicts Twilio prefixes with `machine`.
 *
 * @param answeredBy - Twilio's `AnsweredBy`, if the fetch reported one.
 * @returns True for a machine, a fax or a machine-greeting-end verdict; false otherwise.
 */
function isMachineAnswer(answeredBy?: string): boolean {
  const verdict = answeredBy?.trim().toLowerCase() ?? '';
  return verdict.startsWith(MACHINE_VERDICT_PREFIX) || verdict === FAX_VERDICT;
}

/**
 * Whether a fetched call's error code says the destination number cannot exist (AAP 0.5.3).
 *
 * The code is read as the string {@link INVALID_NUMBER_ERROR_CODES} holds — Twilio posts it as a
 * string on a callback, and the fetch narrows it to a number — and a code this file does not
 * recognize reads as "not an invalid number", which leaves the task the retry AAP 0.5.3 gives it.
 */
function isInvalidNumber(errorCode?: number): boolean {
  return errorCode !== undefined && INVALID_NUMBER_ERROR_CODES.has(String(errorCode));
}

// ---------------------------------------------------------------------------------------------
// Resolving the attempts of one city (AAP 0.5.3, 0.5.6)
// ---------------------------------------------------------------------------------------------

/**
 * Resolve the attempts of one city that are due and still unresolved (AAP 0.5.3).
 *
 * The selection is the due attempts whose *task* is still `in_progress`, whose target sits in
 * `cityId`, and that are in one of the two states no writer can move on its own: no `CallSid` at all
 * and still `dispatching` or `dispatch_unknown`, or a `CallSid` with `dialing`/`in_progress` whose
 * final status never arrived. At most {@link RECONCILE_BATCH_SIZE} of them are taken, oldest first.
 *
 * An attempt whose call a signed callback adopted is therefore absent or, if the callback arrived
 * between the selection and the resolution, is reported `noop` by that resolution itself: the guards
 * on the writes below are what make this pass safe to run at any time and any number of times.
 *
 * The due bound is computed from `deps.clock` once for the whole pass, so a suite that moves the
 * clock sees exactly the attempts it means to; the guard reads `call_task` and the target through the
 * guarded client, so the `place` and `lodging` rows of a fixture business are invisible outside
 * `test` and `demo` (AAP 0.5.2) and their attempts are left for an environment that can see them.
 * The selection is a guarded-client query rather than a raw join for that reason, and it is bounded by
 * arithmetic on `started_at` rather than by a SQL interval so that the pass and a single attempt are
 * measured against one expression (`dueBefore`).
 *
 * One attempt's failure never blocks the others: each is caught, logged with its id and the error's
 * name alone — never its message, which a vendor error could fill with a URL or a number
 * (AAP 0.11.1) — and the pass carries on. The attempt stays unresolved and the next pass retries it.
 *
 * @param cityId - The city slug whose call tasks this pass resolves.
 * @param deps - The database, telephony client, clock, environment, logger and spend meter.
 * @returns One entry per resolution that completed, in the order attempted. An attempt that failed
 *   has no entry; it was logged.
 * @see AAP 0.3.2 for why nothing here redials, 0.5.3 for the two states and the outcomes.
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

// ---------------------------------------------------------------------------------------------
// Resolving one attempt (AAP 0.5.3)
// ---------------------------------------------------------------------------------------------

/**
 * Resolve one call attempt whose dispatch or final status was never reported (AAP 0.5.3).
 *
 * The attempt and the task behind it are read in one query, and the order of the guards is the order
 * the questions have to be asked in:
 *
 *  1. **The attempt is still open**: it exists, it carries no outcome, and its task is still
 *     `in_progress`. Every other state has been decided — by its own callback, by its own relay, by
 *     an operator or by a claim's resolution — so the answer is `noop`.
 *  2. **It is due**: at least `CAP_CALL_SECONDS` plus {@link RECONCILE_GRACE_MS} have passed since the
 *     attempt started. Before that the call may genuinely still be up — a dispatch that has not
 *     returned yet, or a call using its whole allowance — so the answer is `not_due` and nothing is
 *     read from Twilio.
 *  3. **Which case it is**: no `CallSid` at all is {@link resolveWithoutCallSid}, and a `CallSid`
 *     whose call reported no final status is {@link resolveWithCallSid}. A state that is neither of
 *     those two — `dispatch_failed` above all, whose call never existed — is `noop`.
 *
 * @param attemptId - The `CallAttempt` to resolve.
 * @param deps - The database, telephony client, clock, environment, logger and spend meter.
 * @returns What was decided, one of {@link ReconcileResult}'s shapes.
 * @throws Error when `deps.env` names no caller id for a candidate listing — which
 *   {@link resolveWithoutCallSid} catches, so only a database, clock or city-zone failure escapes. A
 *   zone that is not an IANA zone raises `RangeError` from `localDateKey`; both a database and a zone
 *   failure belong to the caller, which logs the attempt and retries it on the next pass.
 * @see AAP 0.3.2 for the two cases, 0.5.3 for what each writes, 0.5.6 for the dialogue budget.
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

// ---------------------------------------------------------------------------------------------
// Case A: no call was ever reported for this attempt (AAP 0.3.2, 0.5.3)
// ---------------------------------------------------------------------------------------------

/**
 * Resolve an attempt that holds no `CallSid` (AAP 0.3.2, 0.5.3).
 *
 * The candidate listing comes first and is never evidence: it runs outside any transaction, its
 * count is the one thing this file keeps from it, and a listing that fails or a target with no number
 * both read as `null` — "not known", which is exactly what a listing can establish. Nothing is
 * adopted and nothing is released because of a candidate.
 *
 * The single transaction then does the three writes AAP 0.5.3 asks for, in the order that keeps each
 * of them honest:
 *
 *  1. the attempt becomes `dispatch_unknown` with outcome `needs_review`, guarded on it still being
 *     `dispatching` or `dispatch_unknown`, still holding no `CallSid` and still carrying no outcome.
 *     Zero rows means attempt-tied evidence arrived in the meantime, so the callback's answer stands
 *     and this returns `noop`;
 *  2. the task becomes `needs_review` with `blockedReason = dispatch_unknown` and its `outcomeAt`
 *     stamped (AAP 0.5.7), guarded on it still being `in_progress`;
 *  3. a lodging claim returns to `pending_call`, because the call is certainly over — the grace is
 *     measured from the point its `timeLimit` must have ended it — so the claimant reads their claim
 *     as pending rather than as a call in progress that will never finish.
 *
 * @param deps - The database, telephony client, clock, environment, logger and spend meter.
 * @param attempt - The open attempt, with no `CallSid`.
 * @param target - The number the call reached, if the guard and the task's own row still offer one.
 * @param now - The one instant this resolution describes.
 * @returns `dispatch_unknown_review`, or `noop` when a callback claimed the attempt first.
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
 * How many calls `calls.list` offers for the attempt's number pair, for the log alone (AAP 0.3.2).
 *
 * A candidate is never adopted and never releases anything: a match may belong to another dispatch,
 * and an empty listing proves nothing, so the count is a diagnostic an operator can act on and
 * nothing in this file branches on it.
 *
 * @returns The number of candidates, and `null` when there is no number to list by or the listing
 *   failed — a listing that fails says nothing about whether a call exists, so it is never reported
 *   as zero.
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

// ---------------------------------------------------------------------------------------------
// Case B: the call was created, its final status never arrived (AAP 0.5.3)
// ---------------------------------------------------------------------------------------------

/**
 * Resolve an attempt that holds a `CallSid` and no final status (AAP 0.5.3).
 *
 * The call is fetched by that `CallSid` outside any transaction, and the answer decides one of two
 * paths:
 *
 *  - **The call cannot be read**, or it has not ended: the task goes to the operator queue with
 *    `blockedReason = no_final_status`, the attempt carries `needs_review`, and the claim returns to
 *    `pending_call`. The dialogue budget is *not* released: the call was answered, and nothing this
 *    file can see says the relay never spent a turn (AAP 0.5.6).
 *  - **The call ended**: the attempt is closed with Twilio's final status, the outcome
 *    {@link mapFetchedFinalStatus} derives, its `endedAt` and its duration, and one
 *    `apply_call_result` outbox row asks `jobs/call-results.ts` to apply the outcome to the task and,
 *    for a lodging call, to its claim. The task itself is left alone — its `outcomeAt`, its requeue a
 *    day later and its `unreachable`/`invalid_number` ending are that job's (AAP 0.5.3, 0.5.7).
 *
 * A call nobody answered — `busy`, `no-answer`, `canceled`, a failure, or a machine that picked up —
 * never ran the dialogue, so its whole reservation is unused and is given back: the attempt's
 * `llm_reserved_micros` is zeroed in the same transaction and {@link relayNeverRan} decides whether
 * the store is asked to release it after the commit, on the city and the local day the dispatch
 * reserved it against (AAP 0.5.6).
 *
 * @param deps - The database, telephony client, clock, environment, logger and spend meter.
 * @param attempt - The open attempt, with a `CallSid` and no final status.
 * @param target - The target whose city and local day the reservation is released against.
 * @param now - The one instant this resolution describes.
 * @returns `final_status_recorded`, `no_final_status_review`, or `noop` when another writer closed
 *   the attempt first.
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
 * The `no_final_status` path (AAP 0.5.3): the call could not be read, or it has not ended.
 *
 * One transaction writes the three rows the operator queue needs. The task is written first, guarded
 * on it still being `in_progress`, and the attempt then carries `needs_review` so that a later signed
 * callback or a later pass finds the attempt decided rather than open — and so that a second run of
 * this resolution stops at its own first guard. The claim returns to `pending_call`, because the
 * operator's resolution of the task is what moves it on from there.
 *
 * @param deps - The database, telephony client, clock, environment, logger and spend meter.
 * @param attempt - The open attempt whose call could not be resolved.
 * @param now - The one instant this resolution describes.
 * @returns `no_final_status_review`.
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
 * Read one call by its `CallSid`, reporting a fetch that failed as no answer at all (AAP 0.5.3).
 *
 * A Twilio failure is not a call result: it says nothing about the call, so the caller takes the
 * `no_final_status` path rather than inventing a status for it. The error is not kept — a vendor
 * error can carry the request URI — and no attempt is failed because of it.
 *
 * @returns The call as Twilio reported it, or `null` when the fetch failed.
 */
async function fetchCallOrNull(deps: ReconcileDeps, callSid: string): Promise<FetchedCall | null> {
  try {
    return await deps.telephony.fetchCall(callSid);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The small decisions (AAP 0.3.2, 0.5.6, 0.11.1)
// ---------------------------------------------------------------------------------------------

/**
 * Whether a call that ended never reached the dialogue (AAP 0.5.6).
 *
 * A status other than `completed` never handed the call to a ConversationRelay session, and a
 * `completed` call Twilio reports as a machine was hung up on by the API's TwiML route before the
 * relay opened. Both leave the attempt's whole reservation unused. A `completed` call that reached a
 * person may have spent turns, so it releases nothing.
 */
function relayNeverRan(call: FetchedCall): boolean {
  return call.status !== 'completed' || isMachineAnswer(call.answeredBy);
}

/**
 * The dialogue budget the attempt holds, rebuilt from the attempt and its city (AAP 0.5.6).
 *
 * `apps/workers`' `call-dispatch` reserved it before dialing, on the dispatch-time local day of the
 * city, so releasing it has to name that same city and day or it would land on a counter nothing
 * reserved against. The amount is read from the row this resolution is about to zero, which is what
 * makes the release the whole reservation and never more; a value that is not a positive safe integer
 * reads as nothing to release, the same rule the API's relay applies when it rebuilds a reservation.
 *
 * @param target - The attempt's target, or `null` when its city cannot be resolved.
 * @param attempt - The attempt holding the reserved amount.
 * @returns The reservation to release, or `null` when there is no city to release it against.
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
 *
 * @returns The target, or `null` when neither row is readable — the fixture guard hides a fixture
 *   business outside `test` and `demo`, and a target that was deleted leaves the same gap.
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
