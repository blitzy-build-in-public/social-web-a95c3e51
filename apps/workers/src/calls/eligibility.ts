/**
 * The call-eligibility rule: whether a queued call task may be dialed now, and what the dispatcher does with it instead
 * when it may not. Six questions are asked, in this order, and the order is part of the rule: is the target marked
 * `doNotCall`, on its own row or on any other row of either kind holding the same number, which sends the task straight to
 * the operator queue as `unreachable` / `do_not_call`; does a phone number exist, without which the task is `unreachable` /
 * `no_phone`; may Tablemate dial that number at all, which {@link CallGuard} answers — outside production only
 * `CALL_ALLOWLIST` numbers are dialed and in production `CALLS_PRODUCTION_APPROVED` gates every call — where a refusal keeps
 * the task `queued` with `blockedReason = not_allowlisted`; has the task spent its attempts (`CALL_MAX_ATTEMPTS` is two); is it
 * inside {@link CALL_SPACING_MS}, the 24 hours two attempts must be apart by; and is it inside calling hours, 09:00 local to a
 * finish by 20:00 local.
 *
 * Safety refusals are decided before scheduling, so a `doNotCall` target with no phone is refused rather than deferred, and a
 * number the guard refuses at 21:00 local is blocked rather than deferred. This module decides and writes nothing. `now`
 * arrives from the injected clock, a phone number reaches neither a log nor an error message, and reads go through the Prisma
 * delegates, so the fixtures guard filters `place` and `lodging` without this module knowing it.
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

// The 24 hours between two attempts at the same task, derived from `CALL_RETRY_SPACING_HOURS` so the rule and its constant cannot drift apart.
const CALL_SPACING_MS = CALL_RETRY_SPACING_HOURS * HOUR_MS;
type SafetyBlockedReason = Extract<BlockedReason, 'do_not_call' | 'no_phone'>;
type AllowlistBlockedReason = Extract<BlockedReason, 'not_allowlisted'>;
export type DeferralReason = 'calling_hours' | 'spacing' | 'attempts';
export type Eligibility =
  | { kind: 'eligible' }
  | { kind: 'unreachable'; blockedReason: SafetyBlockedReason }
  | { kind: 'blocked'; blockedReason: AllowlistBlockedReason; guardReason: NotCallableReason }
  | { kind: 'defer'; until: Date; reason: DeferralReason };
// The business a queued call task targets: its stored phone number, the `doNotCall` refusal any task may have set on it, and the IANA zone of the business's own city — from `config/cities.json`, never the host's, and the same zone the calling-hours rule is then read in.
export type EligibilityTarget = {
  phone: string | null;
  doNotCall: boolean;
  timezone: string;
};
// Everything {@link checkEligibility} reads, passed in rather than reached for: `db` is the guarded client or an interactive transaction, so the same call serves the dispatch transaction and a standalone read, and `lastAttemptEndedAt` is when the task's last counted attempt ended (`null` when it has none).
export type EligibilityDeps = {
  db: DbClient | DbTx;
  callGuard: CallGuard;
  now: Date;
  /** `CAP_CALL_SECONDS` (300): how long the call may last, capped again by Twilio. */
  capCallSeconds: number;
  lastAttemptEndedAt: Date | null;
};
// The verdict on a queued call task, in the order the conditions are listed: `doNotCall` (the target's own row, or any other row of either kind holding the same number) and a missing phone number decide `unreachable`; the guard's refusal decides `blocked`; `attempts >= CALL_MAX_ATTEMPTS`, less than 24 h since the last counted attempt ended and an instant outside 09:00-20:00 local for a call of `capCallSeconds` each decide `defer`; otherwise `eligible`. A phone value that is present but blank counts as no number at all: it cannot belong to any allowlist, and a task without a usable number belongs in the operator queue rather than in a refusal loop.
export async function checkEligibility(
  task: { attempts: number },
  target: EligibilityTarget,
  deps: EligibilityDeps,
): Promise<Eligibility> {
  if (target.doNotCall) {
    return { kind: 'unreachable', blockedReason: 'do_not_call' };
  }
  const phone = target.phone !== null && target.phone.trim().length > 0 ? target.phone : null;
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

// The instant the task's last counted attempt ended, or `null` when it has none: an attempt with `state = 'dispatch_failed'` is left out, because a definite vendor rejection never reached the business, so it must not spend one of the task's two attempts nor start the 24-hour spacing. The attempts of a task are sequential, so the latest one by `startedAt` is the one that matters; while that attempt has not ended, its start instant stands in, which keeps an unresolved task inside the spacing rather than free to redial.
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

// Whether any place or lodging holding `phone` is marked `doNotCall`: the rule is about the number, not the row — one business's number can be recorded on a place and on a lodging, and an operator asking not to be called again sets `doNotCall` on the target of the call that heard the request and on every other task of that target — and both `findFirst` reads select only `id` and run together through the guarded client, so an `is_fixture` row is invisible outside `test` and `demo`.
async function phoneIsMarkedDoNotCall(db: DbClient | DbTx, phone: string): Promise<boolean> {
  const [place, lodging] = await Promise.all([
    db.place.findFirst({ where: { phone, doNotCall: true }, select: { id: true } }),
    db.lodging.findFirst({ where: { phone, doNotCall: true }, select: { id: true } }),
  ]);
  return place !== null || lodging !== null;
}
