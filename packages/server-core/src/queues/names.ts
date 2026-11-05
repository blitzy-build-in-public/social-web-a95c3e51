/**
 * Queue, job and identifier names shared by `apps/api` and `apps/workers`, and the only place any
 * of them is written down: a rename here renames it in both processes at once.
 *
 * The cadences themselves — weekly place refresh, daily FX at 00:30 UTC, the hourly expiry run,
 * the daily 03:00 UTC retention step, call dispatch every 2 minutes and the 00:05 local stay-expiry
 * step — live in `apps/workers/src/schedulers.ts`.
 *
 * It imports nothing, so loading it pulls in neither BullMQ, Redis nor the database (AAP 0.5.1).
 */

/** The eleven queues of the job table in AAP 0.5.6, keyed by the camelCase name code uses. */
export const QUEUE = {
  settlement: 'settlement',
  notifications: 'notifications',
  placeRefresh: 'place-refresh',
  menuIngest: 'menu-ingest',
  priceFreshness: 'price-freshness',
  fxRefresh: 'fx-refresh',
  callDispatch: 'call-dispatch',
  callResults: 'call-results',
  lodgingClaims: 'lodging-claims',
  dataExpiry: 'data-expiry',
  accountErasure: 'account-erasure',
} as const;

/** A queue name as BullMQ receives it. */
export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** Every queue name, in the order of `QUEUE`, frozen so no consumer can mutate the list. */
export const ALL_QUEUES: readonly QueueName[] = Object.freeze([
  QUEUE.settlement,
  QUEUE.notifications,
  QUEUE.placeRefresh,
  QUEUE.menuIngest,
  QUEUE.priceFreshness,
  QUEUE.fxRefresh,
  QUEUE.callDispatch,
  QUEUE.callResults,
  QUEUE.lodgingClaims,
  QUEUE.dataExpiry,
  QUEUE.accountErasure,
]);

/**
 * The one queue `apps/api` processes: settlement, lapse, reminders and dispute escalation. It stays
 * in the API, the one process holding the Stripe secret (AAP 0.3.2).
 */
export const API_QUEUES: readonly QueueName[] = Object.freeze([QUEUE.settlement]);

/**
 * The queues `apps/workers` processes: `ALL_QUEUES` without `API_QUEUES`, so the worker entry point
 * can iterate it and the settlement queue never gets a worker-side consumer.
 */
export const WORKER_QUEUES: readonly QueueName[] = Object.freeze(
  ALL_QUEUES.filter((queue) => queue !== QUEUE.settlement),
);

/**
 * The job names each queue accepts, keyed by queue name. A processor narrows `job.name` with
 * `isJobName` before reading `job.data`, because BullMQ types a job name as a plain string.
 */
export const JOB = {
  settlement: {
    settle: 'settle',
    lapse: 'lapse',
    remind: 'remind',
    disputeEscalate: 'dispute-escalate',
  },
  notifications: { deliver: 'deliver' },
  'place-refresh': { refresh: 'refresh' },
  // `ingest-city` is the fan-out that keeps `POST /v1/admin/price-jobs` with `kind: "menus"` to
  // one `{ jobId }` per city (AAP 0.5.4): the API enqueues it, the worker expands it into
  // per-place `ingest` jobs in the call-and-menu priority order of AAP 0.5.7.
  'menu-ingest': { ingest: 'ingest', ingestCity: 'ingest-city' },
  'price-freshness': { check: 'check' },
  'fx-refresh': { refresh: 'refresh' },
  'call-dispatch': { dispatchCity: 'dispatch-city', createTask: 'create-task' },
  'call-results': { apply: 'apply' },
  'lodging-claims': { claimExpire: 'claim-expire', stayExpiry: 'stay-expiry' },
  'data-expiry': { hourly: 'hourly', daily: 'daily' },
  'account-erasure': { erase: 'erase', sweep: 'sweep' },
} as const satisfies Record<QueueName, Record<string, string>>;

// The per-queue lookup is what keeps the job-name union concrete: reading `keyof` directly off a
// deferred `JOB[Q]` widens it to `string | number | symbol`.
type JobNameMap = { [Q in QueueName]: (typeof JOB)[Q][keyof (typeof JOB)[Q]] };

/** Every job name `Q` accepts. */
export type JobName<Q extends QueueName> = JobNameMap[Q];

/**
 * Narrows a BullMQ job name to the names `queue` accepts, before any payload schema sees it. The
 * name it matches on is `JOB`'s value — the string BullMQ carries — not the camelCase key.
 */
export function isJobName<Q extends QueueName>(queue: Q, name: string): name is JobName<Q> {
  const accepted: readonly string[] = Object.values(JOB[queue]);
  return accepted.includes(name);
}

/**
 * Thrown when an identifier cannot become a custom BullMQ id. The message names the builder, never
 * the identifier, which comes from user data and would otherwise reach the logs (AAP 0.11.1).
 */
export class InvalidJobIdError extends Error {
  constructor(builder: string) {
    super(`${builder} needs a non-empty identifier without ':'; BullMQ rejects ':' in a custom id`);
    this.name = 'InvalidJobIdError';
  }
}

/**
 * Builds `<prefix>-<id>` for a delayed job, a custom id or a job scheduler. BullMQ rejects `:` in a
 * custom job id, so `-` separates here while Redis channel names and Stripe keys keep theirs.
 */
function scopedId(builder: string, prefix: string, id: string): string {
  const value = `${prefix}-${id}`;
  if (id.length === 0 || value.includes(':')) {
    throw new InvalidJobIdError(builder);
  }
  return value;
}

// A stable id suppresses a duplicate enqueue: BullMQ ignores an `add` whose jobId already exists
// in the waiting, delayed or retained sets. A timer whose deadline moves must therefore be removed
// before it is re-added under the same id — `apps/api/src/modules/settlement/timers.ts` owns that
// for `lapse-<meetupId>`, which starts at `createdAt + 48 h` while the proposal is invisible and
// moves to `recipientDeadline` once the initiator's hold is placed (AAP 0.5.3).

/** The `settle` job for a meetup, at `startsAt + 45 min` (AAP 0.5.3). */
export function settleJobId(meetupId: string): string {
  return scopedId('settleJobId', 'settle', meetupId);
}

/** The `lapse` job for a meetup, at its recipient deadline (AAP 0.5.3). */
export function lapseJobId(meetupId: string): string {
  return scopedId('lapseJobId', 'lapse', meetupId);
}

/** The `remind` job for a meetup, at `startsAt - 15 min` (AAP 0.5.3). */
export function remindJobId(meetupId: string): string {
  return scopedId('remindJobId', 'remind', meetupId);
}

/** The `dispute-escalate` job for a dispute, at `deadlineAt - 24 h` (AAP 0.5.3). */
export function disputeEscalateJobId(disputeId: string): string {
  return scopedId('disputeEscalateJobId', 'dispute-escalate', disputeId);
}

/** The `claim-expire` job for a lodging claim, 72 h after it was created (AAP 0.5.3). */
export function claimExpireJobId(claimId: string): string {
  return scopedId('claimExpireJobId', 'claim-expire', claimId);
}

/** The job delivering one outbox row; the row id makes a second dispatch a no-op (AAP 0.3.2). */
export function outboxJobId(outboxId: string): string {
  return scopedId('outboxJobId', 'outbox', outboxId);
}

/** The `upsertJobScheduler` id of a city's weekly place refresh (AAP 0.5.6). */
export function placeRefreshSchedulerId(cityId: string): string {
  return scopedId('placeRefreshSchedulerId', 'place-refresh', cityId);
}

/** The `upsertJobScheduler` id of a city's daily price-freshness sweep (AAP 0.5.6). */
export function priceFreshnessSchedulerId(cityId: string): string {
  return scopedId('priceFreshnessSchedulerId', 'price-freshness', cityId);
}

/** The `upsertJobScheduler` id of a city's 00:05 local stay-expiry step (AAP 0.5.6). */
export function stayExpirySchedulerId(cityId: string): string {
  return scopedId('stayExpirySchedulerId', 'stay-expiry', cityId);
}

/** The `upsertJobScheduler` id of a city's call dispatch, every 2 minutes (AAP 0.5.6). */
export function callDispatchSchedulerId(cityId: string): string {
  return scopedId('callDispatchSchedulerId', 'call-dispatch', cityId);
}

/** The `upsertJobScheduler` id of the daily FX refresh at 00:30 UTC (AAP 0.5.6). */
export const FX_REFRESH_SCHEDULER_ID = 'fx-refresh';

/** The `upsertJobScheduler` id of the hourly data-expiry run (AAP 0.5.6). */
export const DATA_EXPIRY_HOURLY_SCHEDULER_ID = 'data-expiry-hourly';

/** The `upsertJobScheduler` id of the daily 03:00 UTC financial-retention step (AAP 0.5.2). */
export const DATA_EXPIRY_DAILY_SCHEDULER_ID = 'data-expiry-daily';

/** The `upsertJobScheduler` id of the daily account-erasure sweep, which enforces 30 days. */
export const ACCOUNT_ERASURE_SWEEP_SCHEDULER_ID = 'account-erasure-sweep';
