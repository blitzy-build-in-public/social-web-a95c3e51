/**
 * The meetup and dispute timers (AAP 0.5.3, 0.5.6, 0.3.2): the delayed jobs on the in-process `settlement` queue
 * that settle a meetup, lapse a proposal, remind both attendees and escalate a dispute, plus the pure functions
 * that say when each of them is due.
 *
 * A timer is a latency optimisation, never a guarantee. BullMQ fires by wall-clock time, while the application's
 * time comes from the injected clock (AAP 0.11.1) and may be a test clock, so every handler re-checks the meetup's
 * or dispute's current status and its due time against the database before it acts, and the 60-second sweeper
 * settles, lapses and escalates by the app clock whether or not a single job ever arrives (AAP 0.3.2, 0.5.6). That
 * is why no scheduler here is ever allowed to throw: they run inside the post-commit callback of a domain
 * transaction, and a Redis outage must leave the committed state intact for the sweeper to pick up.
 *
 * The four scheduled times are the ones AAP 0.5.3 fixes: `settle-<meetupId>` at `startsAt + 45 min`, the instant
 * check-in closes; `remind-<meetupId>` at `startsAt - 15 min`, the instant check-in opens; `lapse-<meetupId>` at
 * the recipient deadline, or `createdAt + 48 h` while the proposal is still invisible to the recipient; and
 * `dispute-escalate-<disputeId>` at `deadlineAt - 24 h`.
 *
 * This file imports `@tablemate/server-core` and `@tablemate/shared` only, and no sibling module:
 * `meetups/state-machine.ts` imports it, so a module import here would close an ESM cycle. The queue comes from the
 * caller's services, and job ids and names come from the server-core builders and `JOB` table, because BullMQ
 * rejects `:` in a custom id and a hand-built string would drift from the names the processors accept.
 */

import {
  JOB,
  QUEUE,
  disputeEscalateJobId,
  jobOptionsFor,
  lapseJobId,
  remindJobId,
  settleJobId,
} from '@tablemate/server-core';
import type { Clock, JobName, Logger, QueueName } from '@tablemate/server-core';
import {
  CHECK_IN_CLOSES_AFTER_MINUTES,
  CHECK_IN_OPENS_BEFORE_MINUTES,
  DISPUTE_ESCALATE_BEFORE_HOURS,
  HOUR_MS,
  MINUTE_MS,
  RECIPIENT_DEADLINE_HOURS,
} from '@tablemate/shared';

/**
 * The one queue these timers are scheduled on.
 *
 * A narrowed structural view of a BullMQ `Queue`, not the class itself: the dependency whitelist of this file admits
 * server-core and shared only, so the two operations used are stated here rather than the library's type imported.
 * `add` takes the options `jobOptionsFor` produces, which is where the settlement queue's retry policy (five
 * attempts, exponential backoff from 10 s) travels with the job; `remove` answers `1` for a job it removed and `0`
 * for one it could not — a job already gone, or one locked by a worker running it.
 */
export interface SettlementTimerQueue {
  add(
    name: JobName<typeof QUEUE.settlement>,
    data: MeetupTimerJobData,
    options: ReturnType<typeof jobOptionsFor>,
  ): Promise<unknown>;
  remove(jobId: string): Promise<number>;
}

/**
 * What every scheduler here needs from its caller: the app's clock, its logger and the `settlement` queue.
 *
 * Narrowed on purpose: `apps/api/src/app.ts` is not on this file's dependency whitelist and
 * `meetups/state-machine.ts` imports this file, so the module states the three capabilities it uses rather than
 * importing a type from a module it must not depend on. The app's services object satisfies this shape
 * structurally, and a test can stand a fake clock, logger and queue in for them.
 */
export interface SettlementTimerServices {
  /** The injected clock: the only source of "now" for a delay (AAP 0.11.1). */
  readonly clock: Clock;
  /** The process logger a failed schedule is recorded on. */
  readonly logger: Logger;
  /** The queue holder, read for the settlement queue only. */
  readonly queues: { get(name: QueueName): SettlementTimerQueue };
}

/**
 * The data every settlement-queue job carries: ids only, one field per kind of timer (AAP 0.3.2). Job data is
 * stored in Redis and the handler reads the row it names, so no field of a meetup or a dispute — and no personal
 * data — is ever serialized into a job.
 */
export type MeetupTimerJobData = { readonly meetupId: string } | { readonly disputeId: string };

/**
 * When the settlement job for a meetup is due: `startsAt + 45 min` (AAP 0.5.3), the instant check-in closes and
 * AAP 0.5.7's outcome table is applied.
 *
 * @returns A new `Date`; the argument is not modified.
 */
export function settleDueAt(startsAt: Date): Date {
  return new Date(startsAt.getTime() + CHECK_IN_CLOSES_AFTER_MINUTES * MINUTE_MS);
}

/**
 * When the reminder for a meetup is due: `startsAt - 15 min` (AAP 0.5.3), the instant check-in opens.
 *
 * @returns A new `Date`; the argument is not modified.
 */
export function remindDueAt(startsAt: Date): Date {
  return new Date(startsAt.getTime() - CHECK_IN_OPENS_BEFORE_MINUTES * MINUTE_MS);
}

/**
 * When a proposal lapses: its recipient deadline when one is set, otherwise `createdAt + 48 h` (AAP 0.5.3
 * "→ proposed"). The fallback covers the window in which the proposal is not yet visible: `POST /meetups` creates
 * the meetup and its hold attempt in one transaction, and the recipient sees nothing until the initiator's hold is
 * held. `markProposalVisible` then sets `recipientDeadline = min(proposalVisibleAt + 48 h, startsAt)` and
 * re-schedules the timer against it, so a proposal never outlives its own start.
 *
 * @returns A new `Date`; the input is not modified.
 */
export function lapseDueAt(meetup: { recipientDeadline: Date | null; createdAt: Date }): Date {
  if (meetup.recipientDeadline !== null) {
    return new Date(meetup.recipientDeadline.getTime());
  }
  return new Date(meetup.createdAt.getTime() + RECIPIENT_DEADLINE_HOURS * HOUR_MS);
}

/**
 * When a dispute escalates: `deadlineAt - 24 h` (AAP 0.5.3), which flags it in `/ops` a day before the operator's
 * five-day deadline. The subtractive day is applied here, so the caller passes the dispute's own deadline and never
 * a pre-adjusted instant.
 *
 * @returns A new `Date`; the argument is not modified.
 */
export function escalationDueAt(deadlineAt: Date): Date {
  return new Date(deadlineAt.getTime() - DISPUTE_ESCALATE_BEFORE_HOURS * HOUR_MS);
}

/**
 * Schedule the two timers of a locked meetup: the reminder at {@link remindDueAt} and the settlement at
 * {@link settleDueAt} (AAP 0.5.3 "proposed → locked").
 *
 * Called once from the transition that reaches `locked`, through the transaction's post-commit callback. BullMQ
 * ignores an `add` whose `jobId` already exists, so a repeated call is harmless and neither timer is duplicated. A
 * call that cannot be scheduled is logged and returns.
 *
 * The proposal's own lapse timer is deliberately left where it is: it only ever lapses a `proposed` meetup, so on a
 * locked one its handler finds the status changed and does nothing, and {@link removeMeetupTimers} drops it once the
 * meetup reaches a final state.
 */
export async function scheduleLockedTimers(
  services: SettlementTimerServices,
  meetup: { id: string; startsAt: Date },
): Promise<void> {
  await addDelayed(
    services,
    JOB.settlement.remind,
    { meetupId: meetup.id },
    remindJobId(meetup.id),
    remindDueAt(meetup.startsAt),
  );
  await addDelayed(
    services,
    JOB.settlement.settle,
    { meetupId: meetup.id },
    settleJobId(meetup.id),
    settleDueAt(meetup.startsAt),
  );
}

/**
 * Move a proposal's lapse timer to `at` (AAP 0.5.3).
 *
 * Called twice in a proposal's life: at `POST /meetups` with `createdAt + 48 h`, and again by `markProposalVisible`
 * with the recipient deadline. BullMQ ignores an `add` under an existing `jobId`, so the earlier job is removed
 * before the new one is added; a removal that cannot happen — the job is gone, or locked because the processor is
 * running it — is not a failure, because the lapse handler re-checks the deadline and the meetup's status against
 * the database before it lapses anything.
 */
export async function scheduleLapse(
  services: SettlementTimerServices,
  meetupId: string,
  at: Date,
): Promise<void> {
  await removeTimer(services, JOB.settlement.lapse, lapseJobId(meetupId), meetupId);
  await addDelayed(services, JOB.settlement.lapse, { meetupId }, lapseJobId(meetupId), at);
}

/**
 * Drop every timer a meetup still has: the settlement, the reminder and the lapse (AAP 0.5.3).
 *
 * Called after a meetup reaches a final state — a cancellation, a decline, a block, a deletion or a hold loss —
 * where no timer can have an effect any more. Each removal is independent, and a removal that cannot happen is not a
 * failure: a job the sweeper has already settled, one locked by a running processor, or any job at all while Redis
 * is unreachable leaves only a handler that re-checks the meetup's final status and does nothing.
 */
export async function removeMeetupTimers(
  services: SettlementTimerServices,
  meetupId: string,
): Promise<void> {
  await removeTimer(services, JOB.settlement.settle, settleJobId(meetupId), meetupId);
  await removeTimer(services, JOB.settlement.remind, remindJobId(meetupId), meetupId);
  await removeTimer(services, JOB.settlement.lapse, lapseJobId(meetupId), meetupId);
}

/**
 * Schedule the escalation of a dispute at {@link escalationDueAt} (AAP 0.5.3).
 *
 * @param deadlineAt - The dispute's **own deadline**, `openedAt + 5 days`. The 24 hours the escalation fires before
 *   it are subtracted by this module, so no caller pre-adjusts the instant.
 */
export async function scheduleDisputeEscalation(
  services: SettlementTimerServices,
  disputeId: string,
  deadlineAt: Date,
): Promise<void> {
  await addDelayed(
    services,
    JOB.settlement.disputeEscalate,
    { disputeId },
    disputeEscalateJobId(disputeId),
    escalationDueAt(deadlineAt),
  );
}

/**
 * Add one delayed job, and record rather than raise whatever that takes (AAP 0.3.2).
 *
 * The `jobId` is the timer's identity: BullMQ holds one job per id, so a repeated add is ignored and a re-scheduled
 * timer is added by {@link scheduleLapse} only after its predecessor has been removed. The options are the
 * settlement queue's own policy plus the id and the delay, copied through `jobOptionsFor` so the frozen tables in
 * server-core are never written through.
 */
async function addDelayed(
  services: SettlementTimerServices,
  job: JobName<typeof QUEUE.settlement>,
  data: MeetupTimerJobData,
  jobId: string,
  target: Date,
): Promise<void> {
  try {
    const options = { ...jobOptionsFor(QUEUE.settlement), jobId, delay: delayMs(services, target) };
    await services.queues.get(QUEUE.settlement).add(job, data, options);
  } catch (error) {
    warnScheduleFailed(services, job, data, error);
  }
}

/**
 * Remove one timer job, and record rather than raise whatever that takes.
 *
 * BullMQ answers `0` for a job it could not remove — an id that is no longer there, or a job a worker holds — which
 * needs no record: the handler re-checks the row it names. Only a failure to reach Redis at all is logged.
 */
async function removeTimer(
  services: SettlementTimerServices,
  job: JobName<typeof QUEUE.settlement>,
  jobId: string,
  meetupId: string,
): Promise<void> {
  try {
    await services.queues.get(QUEUE.settlement).remove(jobId);
  } catch (error) {
    warnScheduleFailed(services, job, { meetupId }, error);
  }
}

/**
 * The delay BullMQ is handed, in milliseconds: never negative, never `NaN`.
 *
 * A target already in the past fires at once — the handler's own due-time check decides whether anything happens —
 * and an unparseable target is treated the same way rather than propagated into a job option BullMQ would refuse,
 * because a scheduling call must not be the place a data defect surfaces.
 */
function delayMs(services: SettlementTimerServices, target: Date): number {
  const dueMs = target.getTime();
  if (Number.isNaN(dueMs)) {
    return 0;
  }
  return Math.max(0, dueMs - services.clock.nowMs());
}

/**
 * Record a timer that could not be written or cancelled, naming the job, the id it concerns and the failing
 * error's own short name — never an error message, a stack, a connection string or any meetup or dispute content
 * (AAP 0.11.1).
 */
function warnScheduleFailed(
  services: SettlementTimerServices,
  job: JobName<typeof QUEUE.settlement>,
  data: MeetupTimerJobData,
  error: unknown,
): void {
  services.logger.warn(
    { event: 'timer_schedule_failed', job, ...data, err: errorTokenOf(error) },
    'timer_schedule_failed',
  );
}

/** A short token from an error's own `name`, or `Error`: a message or a stack never reaches a line. */
function errorTokenOf(error: unknown): string {
  const name: unknown = error instanceof Error ? error.name : undefined;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'Error';
}
