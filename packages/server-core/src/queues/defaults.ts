import type { JobsOptions } from 'bullmq';
import { QUEUE, type QueueName } from './names.ts';
/** What every job is added with (AAP 0.5.6): five attempts, exponential backoff from 30 s, and completed and failed sets capped at 1,000 and 5,000 jobs. */
export const DEFAULT_JOB_OPTIONS: Readonly<JobsOptions> = Object.freeze({
  attempts: 5,
  backoff: Object.freeze({ type: 'exponential' as const, delay: 30_000 }),
  removeOnComplete: Object.freeze({ count: 1000 }),
  removeOnFail: Object.freeze({ count: 5000 }),
});
const SETTLEMENT_JOB_OPTIONS: Readonly<JobsOptions> = Object.freeze({
  ...DEFAULT_JOB_OPTIONS,
  backoff: Object.freeze({ type: 'exponential' as const, delay: 10_000 }),
});
const PLACE_REFRESH_JOB_OPTIONS: Readonly<JobsOptions> = Object.freeze({
  ...DEFAULT_JOB_OPTIONS,
  attempts: 3,
  backoff: Object.freeze({ type: 'exponential' as const, delay: 300_000 }),
});
const MENU_INGEST_JOB_OPTIONS: Readonly<JobsOptions> = Object.freeze({
  ...DEFAULT_JOB_OPTIONS,
  attempts: 3,
});
const FX_REFRESH_JOB_OPTIONS: Readonly<JobsOptions> = Object.freeze({
  ...DEFAULT_JOB_OPTIONS,
  backoff: Object.freeze({ type: 'exponential' as const, delay: 600_000 }),
});
/** What each queue's jobs are added with (AAP 0.5.6): every queue appears once — the four exceptions above, the defaults for the rest. */
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
/** The options to add one job with: `queue`'s policy shallow-merged with `overrides`, as a fresh object, so the frozen tables above are never written through. */
export function jobOptionsFor(queue: QueueName, overrides?: JobsOptions): JobsOptions {
  const base = QUEUE_JOB_OPTIONS[queue];
  return overrides === undefined ? { ...base } : { ...base, ...overrides };
}
