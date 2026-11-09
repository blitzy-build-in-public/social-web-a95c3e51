/**
 * The call-eligibility rule (AAP 0.5.6): whether a queued call task may be dialed now, and what the
 * dispatcher does with it instead when it may not.
 *
 * Six questions are asked, in this order, and the order is part of the rule (AAP 0.5.3, 0.5.6):
 *
 * 1. Is the target marked `doNotCall`, on its own row or on any other row of either kind holding the
 *    same number? Then the task goes straight to the operator queue as `unreachable` / `do_not_call`.
 * 2. Does a phone number exist? Without one the task is `unreachable` / `no_phone`, the same queue.
 * 3. May Tablemate dial that number at all? {@link CallGuard} answers: outside production only
 *    `CALL_ALLOWLIST` numbers are dialed and in production `CALLS_PRODUCTION_APPROVED` gates every
 *    call. A refusal keeps the task `queued` with `blockedReason = not_allowlisted` — the only value
 *    of `BlockedReason` that matches — and the guard's own reason travels beside it.
 * 4. Has the task spent its attempts? `CALL_MAX_ATTEMPTS` is two (AAP 0.5.3).
 * 5. Is it inside {@link CALL_SPACING_MS}, the 24 hours two attempts must be apart by?
 * 6. Is it inside calling hours — 09:00 local, finishing by 20:00 local (AAP 0.5.6)?
 *
 * Safety refusals are decided before scheduling, so a `doNotCall` target with no phone is refused
 * rather than deferred, and a number the guard refuses at 21:00 local is blocked rather than deferred.
 * Every other verdict names the instant the caller records as `nextAttemptAt`: the next 09:00 local
 * for a caller outside the window, and for a spacing deferral the spacing instant itself unless that
 * instant is also outside the window, in which case it moves to the following 09:00 local so no
 * wake-up is wasted.
 *
 * This module decides and writes nothing; `./dispatch-twilio.ts` calls it in the transaction that
 * claims the task, and `../jobs/call-dispatch.ts` applies the verdict. Call caps are deliberately not
 * asked here — `./caps.ts` reserves the slot at dispatch — and neither is the task's status, which the
 * claim itself re-checks.
 *
 * `now` arrives from the injected clock and a phone number reaches neither a log nor an error message
 * (AAP 0.11.1, 0.12.2); reads go through the Prisma delegates, so the fixtures-guard extension filters
 * `place` and `lodging` for the process's own `APP_ENV` without this module knowing it (AAP 0.5.2).
 */

import type { DbClient, DbTx } from '@tablemate/db';
import type { CallGuard, NotCallableReason } from '@tablemate/server-core';
import {
  CALL_MAX_ATTEMPTS,
  CALL_RETRY_SPACING_HOURS,
  HOUR_MS,
  type BlockedReason,
} from '@tablemate/shared';

import { nextCallingWindow, withinCallingHours } from './calling-hours.ts';

/**
 * The 24 hours between two attempts at the same task (AAP 0.5.3, 0.5.6), derived from
 * `CALL_RETRY_SPACING_HOURS` so the rule and its constant cannot drift apart.
 */
const CALL_SPACING_MS = CALL_RETRY_SPACING_HOURS * HOUR_MS;

type SafetyBlockedReason = Extract<BlockedReason, 'do_not_call' | 'no_phone'>;

type AllowlistBlockedReason = Extract<BlockedReason, 'not_allowlisted'>;

/** Why a dispatch waits (AAP 0.5.6). */
export type DeferralReason = 'calling_hours' | 'spacing' | 'attempts';

/**
 * The dispatcher's verdict on one queued call task (AAP 0.5.3, 0.5.6), discriminated on `kind` so a
 * caller has to handle every verdict to compile:
 *
 * - `eligible` — dial it now.
 * - `unreachable` — the task goes to the operator queue with this `blockedReason` and is never dialed;
 *   a safety refusal, decided before any scheduling question.
 * - `blocked` — the task stays `queued` with `blockedReason = not_allowlisted`, and `guardReason` says
 *   whether the number is outside `CALL_ALLOWLIST` or production calls are not approved yet.
 * - `defer` — dial it no earlier than `until`, which the caller records as `nextAttemptAt`.
 */
export type Eligibility =
  | { kind: 'eligible' }
  | { kind: 'unreachable'; blockedReason: SafetyBlockedReason }
  | { kind: 'blocked'; blockedReason: AllowlistBlockedReason; guardReason: NotCallableReason }
  | { kind: 'defer'; until: Date; reason: DeferralReason };
/**
 * The business a queued call task targets (AAP 0.5.6): its stored phone number, the `doNotCall`
 * refusal any task may have set on it, and the IANA zone of the business's own city — from
 * `config/cities.json`, never the host's, and the same zone the calling-hours rule is then read in.
 */
export type EligibilityTarget = {
  phone: string | null;
  doNotCall: boolean;
  timezone: string;
};

/**
 * Everything {@link checkEligibility} reads, passed in rather than reached for: the database for the
 * shared-number lookup, the call guard, the instant from the injected clock, `CAP_CALL_SECONDS`, and
 * when the task's last counted attempt ended (`null` when it has none). `db` is the guarded client or
 * an interactive transaction, so the same call serves the dispatch transaction and a standalone read.
 */
export type EligibilityDeps = {
  db: DbClient | DbTx;
  callGuard: CallGuard;
  now: Date;
  /** `CAP_CALL_SECONDS` (300): how long the call may last, per AAP 0.5.6, capped again by Twilio. */
  capCallSeconds: number;
  lastAttemptEndedAt: Date | null;
};

/**
 * The verdict on a queued call task, in the order AAP 0.5.6 lists its conditions: `doNotCall` (the
 * target's own row, or any other row of either kind holding the same number) and a missing phone
 * number decide `unreachable`; the guard's refusal decides `blocked`; `attempts >=
 * CALL_MAX_ATTEMPTS`, less than 24 h since the last counted attempt ended and an instant outside
 * 09:00-20:00 local for a call of `capCallSeconds` each decide `defer`; otherwise `eligible`.
 *
 * A phone value that is present but blank counts as no number at all: it cannot belong to any
 * allowlist, and a task without a usable number belongs in the operator queue rather than in a
 * refusal loop.
 *
 * The attempts deferral is a state that should not occur — `call-results` turns a second `no_answer`
 * into `unreachable` rather than requeueing (AAP 0.5.3) — so a caller reaching it logs an inconsistency
 * instead of dialing. It still answers with an instant rather than throwing, which keeps a task that
 * somehow got there out of the way for 24 hours.
 */
export async function checkEligibility(
  task: { attempts: number },
  target: EligibilityTarget,
  deps: EligibilityDeps,
): Promise<Eligibility> {
  if (target.doNotCall) {
    return { kind: 'unreachable', blockedReason: 'do_not_call' };
  }
  const phone = target.phone !== null && target.phone.trim().length > 0 ? target.phone : null;
  // Asked before the guard, because a number another row has opted out of must not be dialed even
  // where the allowlist would admit it (AAP 0.5.6).
  if (phone !== null && (await phoneIsMarkedDoNotCall(deps.db, phone))) {
    return { kind: 'unreachable', blockedReason: 'do_not_call' };
  }
  if (phone === null) {
    return { kind: 'unreachable', blockedReason: 'no_phone' };
  }
  const callable = deps.callGuard.isCallable(phone);
  if (!callable.callable) {
    return { kind: 'blocked', blockedReason: 'not_allowlisted', guardReason: callable.reason };
  }
  const { lastAttemptEndedAt } = deps;
  if (task.attempts >= CALL_MAX_ATTEMPTS) {
    const since = lastAttemptEndedAt ?? deps.now;
    return {
      kind: 'defer',
      reason: 'attempts',
      until: new Date(since.getTime() + CALL_SPACING_MS),
    };
  }
  if (lastAttemptEndedAt !== null) {
    const spacingUntil = new Date(lastAttemptEndedAt.getTime() + CALL_SPACING_MS);
    if (deps.now.getTime() < spacingUntil.getTime()) {
      return {
        kind: 'defer',
        reason: 'spacing',
        until: withinCallingHours(target.timezone, spacingUntil, deps.capCallSeconds)
          ? spacingUntil
          : nextCallingWindow(target.timezone, spacingUntil),
      };
    }
  }
  if (!withinCallingHours(target.timezone, deps.now, deps.capCallSeconds)) {
    return {
      kind: 'defer',
      reason: 'calling_hours',
      until: nextCallingWindow(target.timezone, deps.now),
    };
  }
  return { kind: 'eligible' };
}

/**
 * The instant the task's last counted attempt ended, or `null` when it has none (AAP 0.5.3):
 * {@link checkEligibility}'s `deps.lastAttemptEndedAt`.
 *
 * An attempt with `state = 'dispatch_failed'` is left out: a definite vendor rejection — a connection
 * refused before anything was sent, or a Twilio 4xx — does not count as an attempt at the business
 * (AAP 0.5.3), so it must not spend one of the task's two and must not start the 24-hour spacing
 * either; the task waits on the vendor backoff instead.
 *
 * The attempts of a task are sequential, so the latest one by `startedAt` is the one that matters.
 * While that attempt has not ended — a dispatch still being reconciled, or a call in flight — its start
 * instant stands in, which keeps an unresolved task inside the spacing rather than free to redial.
 */
export async function lastCountedAttemptEndedAt(
  db: DbClient | DbTx,
  taskId: string,
): Promise<Date | null> {
  const attempt = await db.callAttempt.findFirst({
    where: { callTaskId: taskId, state: { not: 'dispatch_failed' } },
    orderBy: { startedAt: 'desc' },
    select: { endedAt: true, startedAt: true },
  });
  return attempt === null ? null : (attempt.endedAt ?? attempt.startedAt);
}

/**
 * Whether any place or lodging holding `phone` is marked `doNotCall` (AAP 0.5.3, 0.5.6).
 *
 * The rule is about the number, not the row: one business's number can be recorded on a place and on a
 * lodging, and an operator asking not to be called again sets `doNotCall` on the target of the call
 * that heard the request and on every other task of that target, so a caller reading only its own row
 * could miss the same number live elsewhere. Both `findFirst` reads select only `id` and run together.
 *
 * The Prisma delegates carry the fixtures-guard extension, so an `is_fixture` row is invisible outside
 * `test` and `demo` exactly as it is everywhere else (AAP 0.5.2).
 */
async function phoneIsMarkedDoNotCall(db: DbClient | DbTx, phone: string): Promise<boolean> {
  const [place, lodging] = await Promise.all([
    db.place.findFirst({ where: { phone, doNotCall: true }, select: { id: true } }),
    db.lodging.findFirst({ where: { phone, doNotCall: true }, select: { id: true } }),
  ]);
  return place !== null || lodging !== null;
}
