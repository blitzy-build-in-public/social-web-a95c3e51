/**
 * BullMQ job options for every queue: the defaults of AAP 0.5.6 and the per-queue exceptions of its
 * job table.
 *
 * The defaults are "5 tries, exponential backoff from 30 s, no BullMQ priority (first in, first
 * out), `removeOnComplete` after 1,000 jobs and `removeOnFail` after 5,000" (AAP 0.5.6). They are
 * passed on `add`, not on a `Worker`, so a job's retry policy travels with the job that was
 * enqueued. A handler throws to trigger that retry (AAP 0.11.1), and the retry repeats no effect,
 * because every handler is idempotent.
 *
 * Task-level scheduling does not belong here: the call-task vendor backoff (60 s x 2^(n-1), at most
 * 8 failures), the 24-hour spacing between call attempts and the cap deferrals are
 * `CallTask.nextAttemptAt` values that `call-dispatch` computes (AAP 0.5.3), and the menu-ingest
 * deferral to 00:05 local and the cap deferral to 09:00 local come from `src/time/city-time.ts`.
 * Each of those reaches BullMQ as an ordinary `delay`.
 */

import type { JobsOptions } from 'bullmq';
import { QUEUE, type QueueName } from './names.ts';

/**
 * What every job is added with (AAP 0.5.6): five attempts, exponential backoff from 30 s, and
 * completed and failed sets capped at 1,000 and 5,000 jobs.
 *
 * `priority` is deliberately absent: unset means no explicit priority, and BullMQ takes
 * unprioritised jobs before prioritised ones, so every queue is first in, first out unless a single
 * job is given a priority. Only one place's menu ingestion is (AAP 0.5.7).
 *
 * Deep-frozen, nested objects included, so no consumer can change a shared policy in place; callers
 * take a copy through {@link jobOptionsFor}.
 */
export const DEFAULT_JOB_OPTIONS: Readonly<JobsOptions> = Object.freeze({
  attempts: 5,
  backoff: Object.freeze({ type: 'exponential' as const, delay: 30_000 }),
  removeOnComplete: Object.freeze({ count: 1000 }),
  removeOnFail: Object.freeze({ count: 5000 }),
});

/**
 * Settlement, lapse, reminders and dispute escalation back off from 10 s: each is worth retrying
 * promptly, and the 60-second sweeper remains the backstop that resumes unfinished payment
 * operations, so a Redis outage costs time rather than money (AAP 0.5.6).
 */
const SETTLEMENT_JOB_OPTIONS: Readonly<JobsOptions> = Object.freeze({
  ...DEFAULT_JOB_OPTIONS,
  backoff: Object.freeze({ type: 'exponential' as const, delay: 10_000 }),
});

/**
 * Place refresh gets 3 attempts from 5 minutes: an Overpass outage is long, and the weekly scheduler
 * tick behind a failed run comes anyway (AAP 0.5.6).
 */
const PLACE_REFRESH_JOB_OPTIONS: Readonly<JobsOptions> = Object.freeze({
  ...DEFAULT_JOB_OPTIONS,
  attempts: 3,
  backoff: Object.freeze({ type: 'exponential' as const, delay: 300_000 }),
});

/**
 * Menu ingestion gets 3 attempts; a page that will not load falls back to a price call for that
 * place instead of being retried indefinitely (AAP 0.5.6).
 */
const MENU_INGEST_JOB_OPTIONS: Readonly<JobsOptions> = Object.freeze({
  ...DEFAULT_JOB_OPTIONS,
  attempts: 3,
});

/**
 * FX refresh backs off from 10 minutes, and the last good table stays in use meanwhile, so a failed
 * run costs staleness rather than a wrong conversion (AAP 0.5.6).
 */
const FX_REFRESH_JOB_OPTIONS: Readonly<JobsOptions> = Object.freeze({
  ...DEFAULT_JOB_OPTIONS,
  backoff: Object.freeze({ type: 'exponential' as const, delay: 600_000 }),
});

/**
 * What each queue's jobs are added with (AAP 0.5.6): every queue appears once — the four exceptions
 * above, the defaults for the rest. Keying it by {@link QueueName} rather than filling it in at
 * runtime is what makes it exhaustive: a queue added to `names.ts` fails to compile until its policy
 * is written down, so a consumer iterating `ALL_QUEUES` always finds an entry. Frozen; read a copy
 * from {@link jobOptionsFor}.
 */
export const QUEUE_JOB_OPTIONS: Readonly<Record<QueueName, Readonly<JobsOptions>>> = Object.freeze({
  [QUEUE.settlement]: SETTLEMENT_JOB_OPTIONS,
  [QUEUE.notifications]: DEFAULT_JOB_OPTIONS,
  [QUEUE.placeRefresh]: PLACE_REFRESH_JOB_OPTIONS,
  [QUEUE.menuIngest]: MENU_INGEST_JOB_OPTIONS,
  [QUEUE.priceFreshness]: DEFAULT_JOB_OPTIONS,
  [QUEUE.fxRefresh]: FX_REFRESH_JOB_OPTIONS,
  [QUEUE.callDispatch]: DEFAULT_JOB_OPTIONS,
  [QUEUE.callResults]: DEFAULT_JOB_OPTIONS,
  [QUEUE.lodgingClaims]: DEFAULT_JOB_OPTIONS,
  [QUEUE.dataExpiry]: DEFAULT_JOB_OPTIONS,
  [QUEUE.accountErasure]: DEFAULT_JOB_OPTIONS,
});

/**
 * The options to add one job with: `queue`'s policy shallow-merged with `overrides`, as a fresh
 * object, so the frozen tables above are never written through. `overrides` wins per key, and its
 * `backoff` replaces the whole backoff object rather than merging into it.
 *
 * Typical overrides are `{ jobId: settleJobId(id), delay }` for a settlement timer,
 * `{ jobId: outboxJobId(id) }` for the outbox dispatcher, and `{ priority }` for one place's menu
 * ingestion.
 */
export function jobOptionsFor(queue: QueueName, overrides?: JobsOptions): JobsOptions {
  const base = QUEUE_JOB_OPTIONS[queue];
  return overrides === undefined ? { ...base } : { ...base, ...overrides };
}
