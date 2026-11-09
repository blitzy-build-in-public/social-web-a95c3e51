/**
 * Placing one call: the attempt is persisted before Twilio is contacted (AAP 0.3.2).
 *
 * A dispatch is three steps, and the order of the first two is what makes a crash recoverable rather than
 * ambiguous: the dialogue budget is reserved outside any transaction, because a call whose budget cannot be
 * reserved is not dialed (AAP 0.5.6); then the task, its call slot and its `CallAttempt` are claimed in one
 * transaction, so the attempt exists and commits before any call can exist (AAP 0.3.2); and only then is
 * Twilio contacted, never inside that transaction (AAP 0.2.2).
 *
 * The answer decides. Success adopts the `CallSid` and moves the attempt to `dialing`, unless a signed
 * callback carrying the attempt id already adopted it. A definite rejection — a connection refused before
 * anything was sent, or a Twilio 4xx — releases the slot, gives `attempts` back so the two-call allowance is
 * untouched, counts a vendor failure and requeues the task after the vendor backoff, or sends it to
 * `needs_review` with `vendor_unavailable` at {@link CALL_VENDOR_MAX_FAILURES} (AAP 0.5.3). An ambiguous
 * result — a timeout, a reset after sending, a 5xx, anything unrecognised — leaves the attempt
 * `dispatch_unknown`, never redialled, with the call slot and the dialogue budget both consumed, because a
 * call may exist that nothing can disprove (AAP 0.3.2).
 *
 * The crash window is covered by the same rule: a process that dies between the commit and step 3 leaves the
 * attempt `dispatching`, which `./reconcile.ts` treats exactly like an ambiguous dispatch — it resolves the
 * attempt from attempt-tied evidence (a signed callback or TwiML fetch carrying the attempt id) or sends the
 * task to `needs_review`, and never redials.
 *
 * The budget is reserved before the call slot rather than both inside the claim transaction because
 * `reserveCall` row-locks the city's `call_budget_day` row until the transaction ends, while the spend meter
 * writes its reservation on the shared pool through another connection: a `reserveLlm` issued from inside
 * that transaction would wait on the lock until PostgreSQL's interactive-transaction timeout, hanging the
 * dispatch. Reserving first and releasing on every path that does not dial gives the same observable
 * contract — a refused budget means the call is not dialed, no call slot is consumed, and the task is
 * deferred to the next local morning.
 *
 * Two safety rules hold whichever mode the process runs in: only a number {@link CallGuard.isCallable}
 * accepts is dialed — outside production that is `CALL_ALLOWLIST` alone, re-checked here so a caller that
 * skipped eligibility still cannot reach a stranger's phone (AAP 0.12.2) — and recording is off, machine
 * detection is on and the call is bounded by `CAP_CALL_SECONDS`, all of which the telephony client fixes and
 * no parameter here can turn off (AAP 0.3.3, 0.5.6).
 *
 * Time comes from `deps.clock` alone: one instant is read at entry and used for every write, so a test can
 * move it (AAP 0.11.1). Twilio is reached only through {@link TelephonyClient}, so this file imports no SDK
 * and creates no client. Every decision is logged as one `call_dispatch` line, and no line carries a phone
 * number, a URL or a vendor error body — only the error class and its HTTP status (AAP 0.11.1, 0.12.2).
 */

import { Prisma } from '@tablemate/db';
import { TWILIO_SIMULATOR, localDateKey } from '@tablemate/server-core';
import {
  CALL_VENDOR_BACKOFF_BASE_SECONDS,
  CALL_VENDOR_BACKOFF_FACTOR,
  CALL_VENDOR_MAX_FAILURES,
  VOICE_ATTEMPT_PARAMETER,
} from '@tablemate/shared';

import { capDeferral, releaseCall, reserveCall } from './caps.ts';

import type { DbClient, DbTx, RawSqlClient } from '@tablemate/db';
import type {
  CallGuard,
  Clock,
  LlmReservation,
  LlmSpend,
  Logger,
  TelephonyClient,
  WorkersEnv,
} from '@tablemate/server-core';
import type {
  BlockedReason,
  CallAttemptState,
  CallTaskKind,
  LodgingClaimStatus,
} from '@tablemate/shared';

/**
 * The environment one dispatch reads: the public base URL Twilio is told to call back and fetch the
 * TwiML from, the call's hard time limit, the day's per-city call cap, and the telephony posture that
 * names the mode, the credentials and the caller id.
 *
 * Narrowed to the four fields this module touches, so a caller passes its whole `WorkersEnv` while a
 * suite builds only these. `API_PUBLIC_URL` may be `null` — the deployment provides it or it does
 * not, and {@link apiPublicUrlFor} is what refuses a dispatch without it. The caller id lives on
 * `telephony` because it is a mode's own fact: the simulator answers every call from
 * `TWILIO_SIMULATOR.fromNumber`, and `twilio` mode carries `TWILIO_FROM_NUMBER` (AAP 0.6.2).
 */
export type DispatchEnv = Pick<
  WorkersEnv,
  'API_PUBLIC_URL' | 'CAP_CALLS_PER_CITY_DAY' | 'CAP_CALL_SECONDS' | 'telephony'
>;

/**
 * The number a call is placed from (AAP 0.6.2, 0.3.3). A blank `simulator` caller id falls back to
 * {@link TWILIO_SIMULATOR}'s constant, so a hand-built configuration can never place a call with an empty
 * caller id, and `twilio` mode dials from `TWILIO_FROM_NUMBER`, which the environment loader already
 * requires of this process.
 *
 * `off` throws on purpose: dispatch must never run with telephony switched off.
 */
export function fromNumberFor(env: Pick<WorkersEnv, 'telephony'>): string {
  const { telephony } = env;
  if (telephony.mode === 'off') {
    throw new Error('call dispatch needs a telephony mode; TELEPHONY_MODE is off');
  }
  if (telephony.mode === 'simulator') {
    return telephony.fromNumber === '' ? TWILIO_SIMULATOR.fromNumber : telephony.fromNumber;
  }
  const from = telephony.fromNumber;
  if (from === undefined || from === '') {
    throw new Error('call dispatch needs TWILIO_FROM_NUMBER when TELEPHONY_MODE=twilio');
  }
  return from;
}

/**
 * The public base URL the two callback URLs of one call are built on (AAP 0.3.2, 0.3.3). The TwiML fetch and
 * the status callback are the only two addresses Twilio is given and both resolve against this base, so a
 * dispatch cannot be placed without it — while a deployment that lacks it still starts, because the variable
 * belongs to the `api` process's scope and its absence belongs to the call-dispatch feature rather than to
 * startup.
 */
export function apiPublicUrlFor(env: Pick<WorkersEnv, 'API_PUBLIC_URL'>): string {
  const base = env.API_PUBLIC_URL;
  if (base === null) {
    throw new Error(
      'call dispatch needs API_PUBLIC_URL: the TwiML and status-callback URLs are built on it',
    );
  }
  return base;
}

/** The two URLs Twilio is handed for one attempt (AAP 0.3.2): both carry its id. */
export interface VoiceCallbackUrls {
  /** Where Twilio fetches the ConversationRelay TwiML from. */
  readonly twimlUrl: string;
  /** Where Twilio posts every status change, the four subscribed events included. */
  readonly statusCallbackUrl: string;
}

/**
 * The TwiML path, relative to `API_PUBLIC_URL`: the route whose signature the API checks
 * (`POST /v1/webhooks/voice/twiml`).
 */
const TWIML_PATH = 'v1/webhooks/voice/twiml';

/** The status-callback path, relative to `API_PUBLIC_URL` (`POST /v1/webhooks/voice`). */
const STATUS_CALLBACK_PATH = 'v1/webhooks/voice';

/**
 * The TwiML and status-callback URLs of one attempt (AAP 0.3.2, 0.3.3), each carrying the `CallAttempt` id
 * under `packages/shared`'s {@link VOICE_ATTEMPT_PARAMETER} — the one definition of that parameter name,
 * read by the API's TwiML route and by the relay socket.
 *
 * That id is the whole point: Twilio fetches the TwiML and posts every status change without a bearer token,
 * so a signed request carrying the attempt id is the only evidence accepted for a call whose create answer
 * was lost.
 *
 * The URLs are built by resolving a path relative to the base with exactly one trailing slash, which keeps a
 * reverse-proxy prefix the base carries: the signature check rebuilds the signed URL with trailing slashes
 * stripped, concatenated with the raw request target Twilio calls, so the two have to match byte for byte
 * (AAP 0.3.3).
 */
export function callbackUrls(apiPublicUrl: string, attemptId: string): VoiceCallbackUrls {
  return {
    twimlUrl: attemptUrl(apiPublicUrl, TWIML_PATH, attemptId),
    statusCallbackUrl: attemptUrl(apiPublicUrl, STATUS_CALLBACK_PATH, attemptId),
  };
}

/**
 * One callback URL: `path` resolved against the base, with the attempt id as its only query parameter, and
 * the base normalized to exactly one trailing slash rather than concatenated, so a base written with or
 * without one yields the same URL and never a `//` in the path.
 */
function attemptUrl(apiPublicUrl: string, path: string, attemptId: string): string {
  const url = new URL(path, `${apiPublicUrl.replace(/\/+$/, '')}/`);
  url.searchParams.set(VOICE_ATTEMPT_PARAMETER, attemptId);
  return url.toString();
}

/**
 * Move a lodging claim from `calling` back to `pending_call` (AAP 0.5.3): the claim is `calling` only while a
 * call may genuinely be live, so every caller that gives up writes it back and the claimant keeps seeing it
 * as pending rather than as a call that will never finish. The statement is guarded on the claim's own
 * status, so it can neither reopen a claim a result resolved nor undo another writer's move, and a `null` id
 * — a `menu_prices` task — is a no-op rather than a lookup.
 */
export async function returnClaimToPending(tx: DbTx, lodgingClaimId: string | null): Promise<void> {
  if (lodgingClaimId === null) {
    return;
  }
  await tx.$executeRaw(Prisma.sql`
    UPDATE "lodging_claim"
       SET "status" = 'pending_call'
     WHERE "id" = ${lodgingClaimId}::uuid
       AND "status" = 'calling'`);
}

/**
 * Why a claim was closed again without dialing (AAP 0.5.3, 0.5.6): a safety refusal — the target is
 * `doNotCall`, or it has no phone number — makes the task `unreachable` with that `blockedReason`, a number
 * the guard refuses keeps it `queued` with `not_allowlisted`, and a claim that is no longer open leaves it
 * alone. Nothing is written here, so the eligibility rule stays the one writer of those columns.
 */
export type DispatchNotEligibleReason =
  'target_missing' | 'do_not_call' | 'no_phone' | 'not_callable' | 'claim_not_open';
/**
 * What one dispatch did (AAP 0.5.3, 0.5.6), discriminated on `kind` so a caller has to handle every
 * outcome to compile:
 *
 * - `dialing` — the call exists and the attempt adopted its `CallSid`. The dialogue budget and the
 *   call slot stay consumed.
 * - `dispatch_failed` — a definite rejection: no call was created, the slot was released, `attempts`
 *   was given back and the task was requeued (`needsReview` marks the run that exhausted
 *   {@link CALL_VENDOR_MAX_FAILURES} and sent it to the operator queue instead).
 * - `dispatch_unknown` — the create answer was lost, so the call may exist: never redialled, and
 *   `./reconcile.ts` resolves the attempt from attempt-tied evidence.
 * - `not_claimed` — the task was not queued and due, or another runner held it, or the city's local
 *   day turned over between the budget reservation and the claim. Nothing was dialed and no slot was
 *   consumed.
 * - `not_eligible` — a safety or target rule refused the claim, with the reason.
 * - `cap_reached` / `budget_refused` — the task was deferred to `until` (09:00 local the next day),
 *   its status unchanged (AAP 0.5.6).
 */
export type DispatchResult =
  | { kind: 'dialing'; attemptId: string; callSid: string }
  | { kind: 'dispatch_failed'; attemptId: string; vendorFailures: number; needsReview: boolean }
  | { kind: 'dispatch_unknown'; attemptId: string }
  | { kind: 'not_claimed' }
  | { kind: 'not_eligible'; reason: DispatchNotEligibleReason }
  | { kind: 'cap_reached'; until: Date }
  | { kind: 'budget_refused'; until: Date };
/**
 * Everything {@link dispatch} reads, passed in rather than reached for (AAP 0.5.1): the database, the
 * telephony client, the spend meter narrowed to the two reservation operations a dispatch uses, the call
 * guard, the parsed environment, the injected clock, the logger, the business's city zone and the dialogue
 * budget one call holds.
 *
 * `callGuard` is asked again here although `jobs/call-dispatch.ts` asked it first, so a caller that skipped
 * eligibility still cannot dial a number outside the allowlist (AAP 0.12.2). `timezone` is the zone the spend
 * meter keys its counters by and `CAP_CALLS_PER_CITY_DAY` is counted in, so the call slot, the budget
 * reservation and the deferral all land on one `call_budget_day` row (AAP 0.5.6).
 */
export interface DispatchDeps {
  readonly db: DbClient;
  readonly telephony: TelephonyClient;
  readonly spend: Pick<LlmSpend, 'reserveLlm' | 'releaseLlm'>;
  readonly callGuard: CallGuard;
  readonly env: DispatchEnv;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly timezone: string;
  readonly dialogueBudgetMicros: number;
}

/** The one column the cheap pre-read needs: the city the task's target sits in (AAP 0.5.6). */
interface TargetCityRow {
  readonly city_id: string | null;
}

/** The task columns the claim reads under its own lock (AAP 0.3.2). */
interface ClaimRow {
  readonly id: string;
  readonly kind: CallTaskKind;
  readonly place_id: string | null;
  readonly lodging_id: string | null;
  readonly lodging_claim_id: string | null;
}

/** The business a call reaches: the number, the opt-out flag and the city whose caps apply. */
interface CallTarget {
  readonly cityId: string;
  readonly phone: string | null;
  readonly doNotCall: boolean;
}

/**
 * The claim values a dispatch carries past its transaction: the task and attempt it acts on, the number to
 * dial, the city and local day the slot and the budget were counted on, and the lodging claim to return to
 * `pending_call` if the call never happens.
 */
interface ClaimedCall {
  readonly taskId: string;
  readonly attemptId: string;
  readonly phone: string;
  readonly cityId: string;
  readonly localDate: string;
  readonly lodgingClaimId: string | null;
}

/** What the claim transaction decided (AAP 0.3.2, 0.5.3, 0.5.6). */
type ClaimOutcome =
  | { readonly kind: 'claimed'; readonly call: ClaimedCall }
  | { readonly kind: 'not_claimed' }
  | { readonly kind: 'not_eligible'; readonly reason: DispatchNotEligibleReason }
  | { readonly kind: 'cap_reached'; readonly until: Date };
/** The attempt columns the definite-failure branch re-reads when its guarded write matched nothing. */
interface AttemptStateRow {
  readonly state: CallAttemptState;
  readonly twilio_call_sid: string | null;
}

/**
 * What the definite-failure transaction concluded: `failed` when it owned the attempt, `adopted` when a
 * signed request had already proved the call exists, and `unresolved` otherwise.
 */
type FailureOutcome =
  | { readonly kind: 'failed'; readonly vendorFailures: number; readonly needsReview: boolean }
  | { readonly kind: 'adopted'; readonly callSid: string }
  | { readonly kind: 'unresolved'; readonly attemptState: CallAttemptState | null };
/** The one blocked reason a spent vendor allowance carries (AAP 0.5.3). */
const VENDOR_UNAVAILABLE: BlockedReason = 'vendor_unavailable';

/** The claim statuses a lodging call may be dialed for (AAP 0.5.3). */
const OPEN_CLAIM_STATUSES = [
  'pending_call',
  'calling',
] as const satisfies readonly LodgingClaimStatus[];

/** The one log event every decision in this file is recorded under (AAP 0.11.1). */
const LOG_EVENT = 'call_dispatch';

/**
 * Milliseconds in a second, for the vendor backoff the shared constant states in seconds:
 * `CALL_VENDOR_BACKOFF_BASE_SECONDS × this × CALL_VENDOR_BACKOFF_FACTOR^(failures − 1)` (AAP 0.5.3).
 */
const SECOND_MS = 1_000;

/**
 * Place one call for a queued call task, or report why it was not placed (AAP 0.3.2, 0.5.3, 0.5.6), in the
 * file header's three steps. The budget reserved in the first is released after the transaction on every path
 * that does not reach step 3 — `not_claimed`, `not_eligible`, `cap_reached` and a thrown transaction error —
 * and kept on the two paths where a call may exist.
 */
export async function dispatch(taskId: string, deps: DispatchDeps): Promise<DispatchResult> {
  // One instant for the whole dispatch: the claim, the attempt's `startedAt`, both defers and the
  // failure writes all describe the same moment (AAP 0.11.1).
  const now = deps.clock.now();
  // Resolved before anything is read, reserved or claimed: a configuration that names no caller id
  // or no public base URL must fail the job outright, never leave an attempt, a call slot and a
  // budget behind it.
  const from = fromNumberFor(deps.env);
  const apiPublicUrl = apiPublicUrlFor(deps.env);
  const target = await readTargetCity(deps.db, taskId, now);
  if (target === null) {
    return settle(deps, 'not_claimed', { taskId }, { kind: 'not_claimed' });
  }
  if (target.city_id === null) {
    return settle(
      deps,
      'not_eligible',
      { taskId, blockedReason: 'target_missing' },
      {
        kind: 'not_eligible',
        reason: 'target_missing',
      },
    );
  }
  // Derived before the reservation exists, so an unusable zone cannot leave one held.
  const localDate = localDateKey(deps.timezone, now);
  const reservation = await deps.spend.reserveLlm(target.city_id, deps.dialogueBudgetMicros);
  if (reservation === null) {
    const until = capDeferral(deps.timezone, now);
    await deferTask(deps.db, taskId, until, now);
    return settle(deps, 'budget_refused', { taskId }, { kind: 'budget_refused', until });
  }
  if (reservation.localDate !== localDate) {
    // The city's local day turned over between the two reads, so the slot would land on a row the
    // reservation does not. Give the reservation back and let the next run dial.
    await deps.spend.releaseLlm(reservation);
    return settle(
      deps,
      'not_claimed',
      { taskId, blockedReason: 'local_day_rolled' },
      {
        kind: 'not_claimed',
      },
    );
  }
  let claim: ClaimOutcome;
  try {
    claim = await claimTask(deps, taskId, now, reservation);
  } catch (error) {
    // The transaction rolled the attempt and the slot back, so step 1's reservation is the only
    // charge it leaves behind: giving it back keeps the retrying job from reserving a second
    // dialogue budget against the same city's day (AAP 0.5.6).
    await deps.spend.releaseLlm(reservation);
    throw error;
  }
  if (claim.kind !== 'claimed') {
    await deps.spend.releaseLlm(reservation);
    return claim.kind === 'not_claimed'
      ? settle(deps, 'not_claimed', { taskId }, { kind: 'not_claimed' })
      : claim.kind === 'not_eligible'
        ? settle(
            deps,
            'not_eligible',
            { taskId, blockedReason: claim.reason },
            {
              kind: 'not_eligible',
              reason: claim.reason,
            },
          )
        : settle(
            deps,
            'cap_reached',
            { taskId, until: claim.until.toISOString() },
            {
              kind: 'cap_reached',
              until: claim.until,
            },
          );
  }
  const { call } = claim;
  const { twimlUrl, statusCallbackUrl } = callbackUrls(apiPublicUrl, call.attemptId);
  let callSid: string;
  try {
    const created = await deps.telephony.createCall({
      to: call.phone,
      from,
      twimlUrl,
      statusCallbackUrl,
      timeLimitSeconds: deps.env.CAP_CALL_SECONDS,
    });
    callSid = created.callSid;
  } catch (error) {
    return await settleFailedDispatch(deps, call, reservation, error, now);
  }
  const adopted = await recordDialing(deps.db, call, callSid, now);
  if (adopted !== null && adopted !== callSid) {
    // A signed callback or TwiML fetch adopted the call first and its SID stands; the id is the only
    // thing logged, because both are call identifiers and one of them is not ours (AAP 0.11.1).
    deps.logger.warn(
      {
        event: LOG_EVENT,
        taskId: call.taskId,
        attemptId: call.attemptId,
        decision: 'sid_mismatch',
      },
      LOG_EVENT,
    );
  }
  return settle(
    deps,
    'dialing',
    { taskId: call.taskId, attemptId: call.attemptId },
    {
      kind: 'dialing',
      attemptId: call.attemptId,
      callSid,
    },
  );
}

/**
 * The cheap pre-read of step 1 (AAP 0.5.6): the city the task's place or lodging sits in, but only while the
 * task is still `queued` and due.
 *
 * It answers `null` for a task another runner has claimed, an operator has resolved or a previous deferral
 * pushed into the future — the caller then returns `not_claimed` without reserving a budget it would have to
 * release — and for a task whose target row is gone. A raw read rather than a Prisma one, because this read
 * keys a budget counter rather than exposing a business to a user; the guard's own target read in
 * {@link claimTask} remains the one place fixture rows are hidden (AAP 0.5.2).
 */
async function readTargetCity(
  db: DbClient,
  taskId: string,
  now: Date,
): Promise<TargetCityRow | null> {
  const rows = await db.$queryRaw<TargetCityRow[]>(Prisma.sql`
    SELECT COALESCE("p"."city_id", "l"."city_id") AS "city_id"
      FROM "call_task" AS "t"
      LEFT JOIN "place" AS "p" ON "p"."id" = "t"."place_id"
      LEFT JOIN "lodging" AS "l" ON "l"."id" = "t"."lodging_id"
     WHERE "t"."id" = ${taskId}::uuid
       AND "t"."status" = 'queued'
       AND "t"."next_attempt_at" <= CAST(${now} AS timestamptz)`);
  return rows[0] ?? null;
}

/**
 * Step 2 (AAP 0.3.2): claim the task and create its attempt in one transaction, or report why not.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes two runners safe — the second finds no row and gives its
 * reservation back instead of waiting — and the target, the claim and the call slot are all decided
 * under that lock, so a task cancelled mid-dispatch cannot have a slot consumed for it.
 */
async function claimTask(
  deps: DispatchDeps,
  taskId: string,
  now: Date,
  reservation: LlmReservation,
): Promise<ClaimOutcome> {
  return await deps.db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimRow[]>(Prisma.sql`
      SELECT "t"."id"::text AS "id",
             "t"."kind"::text AS "kind",
             "t"."place_id"::text AS "place_id",
             "t"."lodging_id"::text AS "lodging_id",
             "t"."lodging_claim_id"::text AS "lodging_claim_id"
        FROM "call_task" AS "t"
       WHERE "t"."id" = ${taskId}::uuid
         AND "t"."status" = 'queued'
         AND "t"."next_attempt_at" <= CAST(${now} AS timestamptz)
         FOR UPDATE SKIP LOCKED`);
    const task = rows[0];
    if (task === undefined) {
      return { kind: 'not_claimed' };
    }
    const target = await loadCallTarget(tx, task);
    if (target === null) {
      return { kind: 'not_eligible', reason: 'target_missing' };
    }
    if (target.doNotCall) {
      return { kind: 'not_eligible', reason: 'do_not_call' };
    }
    const phone = usablePhone(target.phone);
    if (phone === null) {
      return { kind: 'not_eligible', reason: 'no_phone' };
    }
    if (!deps.callGuard.isCallable(phone).callable) {
      return { kind: 'not_eligible', reason: 'not_callable' };
    }
    if (
      task.kind === 'lodging_stay_verification' &&
      !(await claimIsOpen(tx, task.lodging_claim_id))
    ) {
      return { kind: 'not_eligible', reason: 'claim_not_open' };
    }
    const reserved = await reserveCall(
      tx,
      target.cityId,
      reservation.localDate,
      deps.env.CAP_CALLS_PER_CITY_DAY,
    );
    if (!reserved) {
      const until = capDeferral(deps.timezone, now);
      await deferTask(tx, taskId, until, now);
      return { kind: 'cap_reached', until };
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "call_task"
         SET "attempts" = "attempts" + 1,
             "status" = 'in_progress',
             "blocked_reason" = NULL,
             "updated_at" = ${now}::timestamptz
       WHERE "id" = ${taskId}::uuid
         AND "status" = 'queued'`);
    if (task.lodging_claim_id !== null) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "lodging_claim"
           SET "status" = 'calling'
         WHERE "id" = ${task.lodging_claim_id}::uuid
           AND "status" = 'pending_call'`);
    }
    const attempt = await tx.callAttempt.create({
      data: {
        callTaskId: taskId,
        state: 'dispatching',
        startedAt: now,
        llmReservedMicros: BigInt(reservation.micros),
      },
      select: { id: true },
    });
    return {
      kind: 'claimed',
      call: {
        taskId,
        attemptId: attempt.id,
        phone,
        cityId: target.cityId,
        localDate: reservation.localDate,
        lodgingClaimId: task.lodging_claim_id,
      },
    };
  });
}

/**
 * The business a call reaches (AAP 0.5.2, 0.5.6), read through the guarded client so a fixture row is
 * invisible outside `test` and `demo`, and so a `place` the process may not see is reported as a
 * missing target rather than dialed.
 */
async function loadCallTarget(tx: DbTx, task: ClaimRow): Promise<CallTarget | null> {
  if (task.kind === 'lodging_stay_verification') {
    if (task.lodging_id === null) {
      return null;
    }
    return await tx.lodging.findFirst({
      where: { id: task.lodging_id },
      select: { phone: true, doNotCall: true, cityId: true },
    });
  }
  if (task.place_id === null) {
    return null;
  }
  return await tx.place.findFirst({
    where: { id: task.place_id },
    select: { phone: true, doNotCall: true, cityId: true },
  });
}

/** The stored number when it holds something other than whitespace, else `null` (AAP 0.5.6). */
function usablePhone(phone: string | null): string | null {
  return phone !== null && phone.trim().length > 0 ? phone : null;
}

/**
 * Whether the lodging claim a call verifies is still open (AAP 0.5.3): `pending_call` or `calling`.
 *
 * A claim resolved by its own call, by an operator or by its 72-hour expiry leaves tasks that must
 * not be dialed, and a claim id of `null` on a lodging task is a claim that is not open either.
 */
async function claimIsOpen(tx: DbTx, lodgingClaimId: string | null): Promise<boolean> {
  if (lodgingClaimId === null) {
    return false;
  }
  const claim = await tx.lodgingClaim.findFirst({
    where: { id: lodgingClaimId, status: { in: [...OPEN_CLAIM_STATUSES] } },
    select: { id: true },
  });
  return claim !== null;
}

/**
 * Step 3's failure branch (AAP 0.3.2, 0.5.3): decide whether the call exists, and record what that
 * means for the attempt, the task and the claim.
 *
 * `classifyCallError` is the single reading of the error — a 4xx, or a connection refused before
 * anything was sent, is `definite`; everything else, a timeout or a 5xx included, is ambiguous and
 * never redialled. A definite failure releases the dialogue budget after its transaction, since no
 * call can have consumed it; an ambiguous one keeps it, because the tokens may be flowing.
 *
 * Only the error class and its HTTP status reach the log line, never the vendor's message, the URL
 * or the number (AAP 0.11.1).
 */
async function settleFailedDispatch(
  deps: DispatchDeps,
  call: ClaimedCall,
  reservation: LlmReservation,
  error: unknown,
  now: Date,
): Promise<DispatchResult> {
  const errorClass = deps.telephony.classifyCallError(error);
  const status = errorStatus(error);
  if (errorClass === 'ambiguous') {
    await markDispatchUnknown(deps.db, call.attemptId);
    deps.logger.warn(
      {
        event: LOG_EVENT,
        taskId: call.taskId,
        attemptId: call.attemptId,
        decision: 'dispatch_unknown',
        errorClass,
        status,
      },
      LOG_EVENT,
    );
    return { kind: 'dispatch_unknown', attemptId: call.attemptId };
  }
  let outcome: FailureOutcome;
  try {
    outcome = await deps.db.$transaction(
      async (tx) => await applyDefiniteFailure(tx, deps, call, now),
    );
  } catch (writeError) {
    // Nothing was recorded, and a definite failure means no call exists, so the budget goes back and
    // the job retries rather than leaving the reservation held until the local day ends (AAP 0.5.6).
    await deps.spend.releaseLlm(reservation);
    throw writeError;
  }
  if (outcome.kind === 'adopted') {
    // A signed callback or TwiML fetch proved the call exists, so the attempt is left exactly as that
    // writer left it: no failure is counted, and the slot and the budget stay consumed.
    deps.logger.warn(
      {
        event: LOG_EVENT,
        taskId: call.taskId,
        attemptId: call.attemptId,
        decision: 'attempt_adopted',
        errorClass,
        status,
      },
      LOG_EVENT,
    );
    return { kind: 'dialing', attemptId: call.attemptId, callSid: outcome.callSid };
  }
  if (outcome.kind === 'unresolved') {
    deps.logger.warn(
      {
        event: LOG_EVENT,
        taskId: call.taskId,
        attemptId: call.attemptId,
        decision: 'dispatch_unknown',
        errorClass,
        status,
        attemptState: outcome.attemptState,
      },
      LOG_EVENT,
    );
    return { kind: 'dispatch_unknown', attemptId: call.attemptId };
  }
  await deps.spend.releaseLlm(reservation);
  deps.logger.warn(
    {
      event: LOG_EVENT,
      taskId: call.taskId,
      attemptId: call.attemptId,
      decision: 'dispatch_failed',
      errorClass,
      status,
      vendorFailures: outcome.vendorFailures,
      needsReview: outcome.needsReview,
    },
    LOG_EVENT,
  );
  return {
    kind: 'dispatch_failed',
    attemptId: call.attemptId,
    vendorFailures: outcome.vendorFailures,
    needsReview: outcome.needsReview,
  };
}

/**
 * The writes one definite rejection owes, inside one transaction (AAP 0.5.3): the attempt marked
 * `dispatch_failed`, the call slot given back, the task requeued with backoff or sent to the operator queue,
 * and a lodging claim returned to `pending_call`.
 *
 * The attempt write is guarded on `state = 'dispatching'` **and** `twilio_call_sid IS NULL`, so a signed
 * request that reached the API first wins and this whole branch becomes a read: that is the one way a
 * definite error can still hide a live call, and it is why the guard carries both conditions.
 */
async function applyDefiniteFailure(
  tx: DbTx,
  deps: DispatchDeps,
  call: ClaimedCall,
  now: Date,
): Promise<FailureOutcome> {
  const failed = await tx.$executeRaw(Prisma.sql`
    UPDATE "call_attempt"
       SET "state" = 'dispatch_failed',
           "ended_at" = ${now}::timestamptz,
           "llm_reserved_micros" = 0
     WHERE "id" = ${call.attemptId}::uuid
       AND "state" = 'dispatching'
       AND "twilio_call_sid" IS NULL`);
  if (failed === 0) {
    return await reportAttemptState(tx, call.attemptId);
  }
  await releaseCall(tx, call.cityId, call.localDate);
  const vendorFailures = await bumpVendorFailures(tx, call.taskId, now);
  const needsReview = vendorFailures >= CALL_VENDOR_MAX_FAILURES;
  if (needsReview) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE "call_task"
         SET "status" = 'needs_review',
             "blocked_reason" = ${VENDOR_UNAVAILABLE}::"blocked_reason",
             "outcome_at" = ${now}::timestamptz,
             "updated_at" = ${now}::timestamptz
       WHERE "id" = ${call.taskId}::uuid`);
  } else {
    const until = vendorBackoff(vendorFailures, now);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "call_task"
         SET "status" = 'queued',
             "blocked_reason" = NULL,
             "next_attempt_at" = ${until}::timestamptz,
             "updated_at" = ${now}::timestamptz
       WHERE "id" = ${call.taskId}::uuid`);
  }
  await returnClaimToPending(tx, call.lodgingClaimId);
  deps.logger.info(
    {
      event: LOG_EVENT,
      taskId: call.taskId,
      attemptId: call.attemptId,
      decision: needsReview ? 'vendor_unavailable' : 'vendor_backoff',
      vendorFailures,
    },
    LOG_EVENT,
  );
  return { kind: 'failed', vendorFailures, needsReview };
}

/**
 * Spend one vendor failure and give the attempt back its allowance (AAP 0.5.3): `attempts` is decremented
 * because a definite rejection never reached the business, so the task keeps the two calls it is allowed and
 * waits on the vendor backoff instead. The statement runs under the task's row lock and returns the new
 * count, which decides both the backoff and whether the vendor allowance is spent.
 */
async function bumpVendorFailures(tx: DbTx, taskId: string, now: Date): Promise<number> {
  const rows = await tx.$queryRaw<{ vendor_failures: number }[]>(Prisma.sql`
    UPDATE "call_task"
       SET "attempts" = GREATEST("attempts" - 1, 0),
           "vendor_failures" = "vendor_failures" + 1,
           "updated_at" = ${now}::timestamptz
     WHERE "id" = ${taskId}::uuid
    RETURNING "vendor_failures"`);
  const row = rows[0];
  if (row === undefined) {
    throw new Error('call dispatch lost its task row while recording a vendor failure');
  }
  return row.vendor_failures;
}

/**
 * When a task may be attempted again after `vendorFailures` definite rejections (AAP 0.5.3):
 * `now + 60 s × 2^(vendorFailures − 1)`, so the waits are 60 s, 120 s, 240 s and so on.
 */
function vendorBackoff(vendorFailures: number, now: Date): Date {
  const steps = Math.max(vendorFailures - 1, 0);
  const delayMs =
    CALL_VENDOR_BACKOFF_BASE_SECONDS * SECOND_MS * CALL_VENDOR_BACKOFF_FACTOR ** steps;
  return new Date(now.getTime() + delayMs);
}

/**
 * What the attempt had already become when the guarded failure write matched nothing, so the caller
 * reports the truth instead of recording a failure over a live call: `adopted` when the row carries a
 * `CallSid`, and an `unresolved` state otherwise — including a row that has vanished, which
 * `./reconcile.ts` treats as ambiguous and never redials.
 */
async function reportAttemptState(tx: DbTx, attemptId: string): Promise<FailureOutcome> {
  const rows = await tx.$queryRaw<AttemptStateRow[]>(Prisma.sql`
    SELECT "state"::text AS "state",
           "twilio_call_sid" AS "twilio_call_sid"
      FROM "call_attempt"
     WHERE "id" = ${attemptId}::uuid`);
  const row = rows[0];
  if (row === undefined) {
    return { kind: 'unresolved', attemptState: null };
  }
  return row.twilio_call_sid === null
    ? { kind: 'unresolved', attemptState: row.state }
    : { kind: 'adopted', callSid: row.twilio_call_sid };
}

/**
 * Record a call Twilio accepted (AAP 0.3.2, 0.5.3): adopt the `CallSid`, move the attempt to `dialing`, and
 * return the task's vendor-failure count to zero. Both writes are conditional rather than authoritative —
 * `COALESCE` keeps a SID a signed callback already adopted and the `CASE` moves only an attempt still
 * `dispatching`, so a callback that arrived first, exactly what a lost create answer produces, is never
 * overwritten — and `vendorFailures` resets because a dispatch that reached Twilio is what the backoff was
 * waiting for.
 */
async function recordDialing(
  db: DbClient,
  call: ClaimedCall,
  callSid: string,
  now: Date,
): Promise<string | null> {
  return await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ twilio_call_sid: string | null }[]>(Prisma.sql`
      UPDATE "call_attempt"
         SET "twilio_call_sid" = COALESCE("twilio_call_sid", ${callSid}),
             "state" = CASE WHEN "state" = 'dispatching' THEN 'dialing' ELSE "state" END
       WHERE "id" = ${call.attemptId}::uuid
      RETURNING "twilio_call_sid"`);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "call_task"
         SET "vendor_failures" = 0,
             "updated_at" = ${now}::timestamptz
       WHERE "id" = ${call.taskId}::uuid`);
    return rows[0]?.twilio_call_sid ?? null;
  });
}

/** Move an attempt whose create answer was lost to `dispatch_unknown`, never to be redialled. */
async function markDispatchUnknown(db: DbClient, attemptId: string): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE "call_attempt"
       SET "state" = 'dispatch_unknown'
     WHERE "id" = ${attemptId}::uuid
       AND "state" = 'dispatching'`);
}

/**
 * Move a queued task's `nextAttemptAt` to `until`, its status untouched (AAP 0.5.6): a task over either cap
 * keeps its place and is dialed from the next local morning rather than dropped or left to spin against the
 * cap for the rest of the day. The caller passes either the shared client (a budget refusal) or its claim
 * transaction (the call cap, decided under the task's own row lock).
 */
async function deferTask(sql: RawSqlClient, taskId: string, until: Date, now: Date): Promise<void> {
  await sql.$executeRaw(Prisma.sql`
    UPDATE "call_task"
       SET "next_attempt_at" = ${until}::timestamptz,
           "updated_at" = ${now}::timestamptz
     WHERE "id" = ${taskId}::uuid
       AND "status" = 'queued'`);
}

/**
 * Log one dispatch decision and hand the caller's result straight back (AAP 0.11.1), so a dispatch
 * reads as a sequence of decisions without a branch wrapped around every one of them.
 *
 * The code travels under `blockedReason`, not `reason`: the logger's redaction list censors `reason`
 * (a dispute's or a report's free text), and a code that has to be read back is logged under a name
 * the list does not cover (AAP 0.11.1).
 */
function settle(
  deps: DispatchDeps,
  decision: string,
  fields: {
    readonly taskId: string;
    readonly attemptId?: string;
    readonly blockedReason?: string;
    readonly until?: string;
  },
  result: DispatchResult,
): DispatchResult {
  deps.logger.info({ event: LOG_EVENT, decision, ...fields }, LOG_EVENT);
  return result;
}

/**
 * The HTTP status an error or its `cause` carries, for the log line alone (AAP 0.11.1): a status code is the
 * one diagnostic an operator can act on without the vendor's message, which server-core deliberately keeps
 * out of this boundary.
 */
function errorStatus(error: unknown): number | null {
  for (const candidate of [error, propertyOf(error, 'cause')]) {
    const status = propertyOf(candidate, 'status');
    if (typeof status === 'number' && Number.isInteger(status)) {
      return status;
    }
  }
  return null;
}

/** One property of a value of any shape, read without assuming anything about that shape. */
function propertyOf(value: unknown, key: 'status' | 'cause'): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
