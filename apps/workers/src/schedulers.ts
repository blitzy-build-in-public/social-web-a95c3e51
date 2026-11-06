/**
 * The recurring schedulers `apps/workers/src/main.ts` registers once at startup (AAP 0.5.1, 0.5.6):
 * one set per configured city — the weekly place refresh, the daily price-freshness sweep, the 00:05
 * local stay expiry and, while telephony is on, the two-minute call dispatch — plus the four global
 * runs: the daily FX table, the hourly and daily data-expiry steps, and the account-erasure sweep.
 *
 * Four rules shape it.
 *
 * - **BullMQ owns the registration.** `upsertJobScheduler` creates a scheduler or updates the one
 *   already under that id, so registering twice — a restart, a rolling deploy, a second replica —
 *   leaves exactly one scheduler per id and no run has to look at what exists first (AAP 0.2.2). The
 *   single removal is the call dispatch of a stack switched to `TELEPHONY_MODE=off`, so that posture
 *   stops the dialling rather than leaving the timer behind (AAP 0.6.2). This is not a
 *   reconciliation for anything else: a city that leaves `config/cities.json` keeps its schedulers
 *   until an operator removes them.
 * - **Every id comes from server-core.** The `*SchedulerId` builders and the four constants are the
 *   only place a scheduler id is spelled, and each uses `-` rather than `:`, which BullMQ refuses in
 *   a custom id (AAP 0.3.2).
 * - **A template's data is validated first.** Each template is parsed with `parseJobData`, so a job
 *   whose data no longer matches its queue's schema fails the start instead of being enqueued to a
 *   processor that would refuse it.
 * - **No wall clock here.** BullMQ evaluates a repeat pattern against real time, so this module
 *   reads no clock, and no test relies on a scheduler: a suite drives the processors directly with
 *   the injected test clock (AAP 0.11.1, 0.11.2).
 *
 * Registering is idempotent and safe to repeat, and it is not transactional: a failure part way
 * through throws to `main.ts`, which fails the start, and the next start upserts what is already
 * there and completes the rest.
 *
 * @see AAP 0.5.1 for the worker runtime, 0.5.3 for the timers, 0.5.6 for the job table and its
 *   cadences, 0.6.2 for `TELEPHONY_MODE`, 0.8.1 for this file's inventory row.
 */

import type { JobSchedulerTemplateOptions, RepeatOptions } from 'bullmq';

import {
  ACCOUNT_ERASURE_SWEEP_SCHEDULER_ID,
  DATA_EXPIRY_DAILY_SCHEDULER_ID,
  DATA_EXPIRY_HOURLY_SCHEDULER_ID,
  FX_REFRESH_SCHEDULER_ID,
  JOB,
  QUEUE,
  callDispatchSchedulerId,
  jobOptionsFor,
  parseJobData,
  placeRefreshSchedulerId,
  priceFreshnessSchedulerId,
  stayExpirySchedulerId,
  type QueueName,
} from '@tablemate/server-core';

// Type-only on purpose: this module is imported by `main.ts`, and a value import of `queues.ts`
// would close the cycle `queues.ts` -> `jobs/*` -> ... -> `schedulers.ts` -> `queues.ts`.
import type { WorkerContext } from './queues.ts';

/*
 * The cadences (AAP 0.5.3, 0.5.6)
 */

/**
 * The zone a cadence is written in: `city` for a run anchored to a city's local clock, which reads
 * the zone the caller passes, and `UTC` — spelled as IANA and BullMQ both understand it — for the
 * runs the plan fixes in UTC.
 */
const CITY_ZONE = 'city';
const UTC_ZONE = 'UTC';

/**
 * Every cadence this process registers, keyed by the run it describes (AAP 0.5.3, 0.5.6).
 *
 * Every cadence below is the plan's (AAP 0.5.3, 0.5.6), and so are four of the instants: 00:05 local
 * for the stay expiry, 00:30 UTC for the FX table, 03:00 UTC for the financial-retention step, and
 * every two minutes for the call dispatch. The clock times that remain are chosen here, off-peak,
 * because the plan states those cadences without an hour: the weekly place refresh runs Monday 04:00
 * local, price freshness daily at 04:30 local, and the account-erasure sweep — which enforces the
 * 30 days of AAP 0.5.2 — daily at 03:15 UTC, after the retention step.
 *
 * A cadence is data, not a closure: the id, the queue and the job name beside it come from
 * server-core, and `registerSchedulers` pairs the two.
 */
export const SCHEDULE = {
  /** Weekly, Monday 04:00 in the city's own zone: Overpass is queried per city (AAP 0.5.6). */
  placeRefresh: { cron: '0 4 * * 1', zone: CITY_ZONE },
  /** Daily 04:30 local, after the place refresh hour so a new place is priced the same morning. */
  priceFreshness: { cron: '30 4 * * *', zone: CITY_ZONE },
  /** 00:05 local, the instant AAP 0.5.3 fixes for turning a lapsed stay's `showStaying` off. */
  stayExpiry: { cron: '5 0 * * *', zone: CITY_ZONE },
  /** Every two minutes per city (AAP 0.5.6): the sweep that finds a task due to be dialled. */
  callDispatch: { every: 120_000 },
  /** Daily at 00:30 UTC (AAP 0.5.6): one table for every city, so it runs once per process. */
  fxRefresh: { cron: '30 0 * * *', zone: UTC_ZONE },
  /** Hourly (AAP 0.5.2, 0.5.6): the expiry steps that carry no retention clock of their own. */
  dataExpiryHourly: { cron: '0 * * * *', zone: UTC_ZONE },
  /** The daily step at 03:00 UTC (AAP 0.5.6): the financial-retention purge. */
  dataExpiryDaily: { cron: '0 3 * * *', zone: UTC_ZONE },
  /** Daily at 03:15 UTC: the sweep that enforces the 30 days of AAP 0.5.2, after the purge. */
  accountErasureSweep: { cron: '15 3 * * *', zone: UTC_ZONE },
} as const;

/** One entry of {@link SCHEDULE}, read by {@link repeatOptions}. */
type ScheduleEntry = (typeof SCHEDULE)[keyof typeof SCHEDULE];

/*
 * Helpers
 */

/**
 * The repeat options BullMQ is handed for one cadence: an interval for an `every` entry, otherwise
 * the cron pattern in the zone its entry names.
 *
 * @param cadence - the {@link SCHEDULE} entry being registered.
 * @param timezone - the city's IANA zone, read only by a `city`-zoned entry.
 * @returns the repeat options, without the `key` BullMQ sets itself.
 */
function repeatOptions(cadence: ScheduleEntry, timezone: string): Omit<RepeatOptions, 'key'> {
  return 'every' in cadence
    ? { every: cadence.every }
    : { pattern: cadence.cron, tz: cadence.zone === CITY_ZONE ? timezone : cadence.zone };
}

/** The keys a job scheduler owns and a queue's job policy must therefore not supply. */
const SCHEDULER_OWNED_KEYS = ['jobId', 'delay', 'repeat', 'deduplication'] as const;

/**
 * The options every job a scheduler creates is added with: the queue's own policy from
 * `jobOptionsFor` — its attempts, its backoff and its completion caps — less the keys the scheduler
 * owns. BullMQ refuses `jobId`, `repeat` and `delay` in a template and sets deduplication itself, so
 * those are dropped rather than passed, and the policy the caller takes is a copy of a frozen table,
 * so deleting here never writes through to the shared defaults.
 *
 * @param queue - the queue whose policy the template carries.
 * @returns the template options for `queue`.
 */
function templateOptions(queue: QueueName): JobSchedulerTemplateOptions {
  const options: Record<string, unknown> = { ...jobOptionsFor(queue) };

  for (const key of SCHEDULER_OWNED_KEYS) {
    delete options[key];
  }

  return options;
}

/**
 * Register one scheduler, or update the one already under `id`, and return that id.
 *
 * @param ctx - the process context: the producer registry and, through it, the queue's policy.
 * @param id - the scheduler id, from a server-core builder or constant.
 * @param queue - the queue the scheduler enqueues into.
 * @param name - the job name, one `queue` accepts, whose schema `templateData` was parsed against.
 * @param templateData - the parsed data of every job the scheduler creates.
 * @param repeat - {@link repeatOptions} for this cadence.
 * @returns `id`, so the caller collects just the ids it registered.
 * @throws Whatever `upsertJobScheduler` throws, an unreachable Redis included: this is a start path,
 *   and a process whose schedulers are not registered is not ready.
 */
async function upsert(
  ctx: WorkerContext,
  id: string,
  queue: QueueName,
  name: string,
  templateData: unknown,
  repeat: Omit<RepeatOptions, 'key'>,
): Promise<string> {
  await ctx.queues
    .get(queue)
    .upsertJobScheduler(id, repeat, { name, data: templateData, opts: templateOptions(queue) });

  return id;
}

/*
 * Registration (AAP 0.5.1, 0.5.6)
 */

/**
 * Register every recurring scheduler this deployment runs, and unregister the one a mode switches
 * off (AAP 0.5.1, 0.5.6).
 *
 * The cities come from the seeded `City` rows, in id order so the log's counts and a test's list are
 * reproducible; a deployment whose seed has not run yet registers the four global schedulers and no
 * per-city ones, which is the right outcome for a stack with no city to refresh. Every per-city job
 * carries its `cityId`, which is what lets one job know which local day and which zone it works in.
 *
 * Call dispatch is registered per city only while `TELEPHONY_MODE` is `simulator` or `twilio`. With
 * `off` the scheduler is removed instead — a no-op when it was never registered, and reported in
 * `removed` only when a scheduler really went — so switching a running stack to `off` stops the
 * dialling, and the tasks themselves wait in `queued` until telephony returns (AAP 0.6.2).
 *
 * @param ctx - the process context: the database read for the cities, the producer registry and the
 *   validated environment's telephony mode.
 * @returns the scheduler ids registered and the ones removed, both in the order they were handled.
 * @throws Error from the city read, `QueuePayloadError` from a template that no longer matches its
 *   job's schema, and whatever Redis or BullMQ throws. Each fails the start deliberately: a template
 *   that drifted is a code defect, not something a retry repairs, and a process with no schedulers
 *   would silently stop refreshing places, prices, stays and retention.
 */
export async function registerSchedulers(
  ctx: WorkerContext,
): Promise<{ registered: string[]; removed: string[] }> {
  const registered: string[] = [];
  const removed: string[] = [];
  const { mode } = ctx.env.telephony;

  const cities = await ctx.db.city.findMany({
    select: { id: true, timezone: true },
    orderBy: { id: 'asc' },
  });

  for (const city of cities) {
    registered.push(
      await upsert(
        ctx,
        placeRefreshSchedulerId(city.id),
        QUEUE.placeRefresh,
        JOB[QUEUE.placeRefresh].refresh,
        parseJobData(QUEUE.placeRefresh, JOB[QUEUE.placeRefresh].refresh, { cityId: city.id }),
        repeatOptions(SCHEDULE.placeRefresh, city.timezone),
      ),
      await upsert(
        ctx,
        priceFreshnessSchedulerId(city.id),
        QUEUE.priceFreshness,
        JOB[QUEUE.priceFreshness].check,
        parseJobData(QUEUE.priceFreshness, JOB[QUEUE.priceFreshness].check, { cityId: city.id }),
        repeatOptions(SCHEDULE.priceFreshness, city.timezone),
      ),
      await upsert(
        ctx,
        stayExpirySchedulerId(city.id),
        QUEUE.lodgingClaims,
        JOB[QUEUE.lodgingClaims].stayExpiry,
        parseJobData(QUEUE.lodgingClaims, JOB[QUEUE.lodgingClaims].stayExpiry, { cityId: city.id }),
        repeatOptions(SCHEDULE.stayExpiry, city.timezone),
      ),
    );

    const dispatchId = callDispatchSchedulerId(city.id);

    if (mode === 'off') {
      if (await ctx.queues.get(QUEUE.callDispatch).removeJobScheduler(dispatchId)) {
        removed.push(dispatchId);
      }
    } else {
      registered.push(
        await upsert(
          ctx,
          dispatchId,
          QUEUE.callDispatch,
          JOB[QUEUE.callDispatch].dispatchCity,
          parseJobData(QUEUE.callDispatch, JOB[QUEUE.callDispatch].dispatchCity, {
            cityId: city.id,
          }),
          repeatOptions(SCHEDULE.callDispatch, city.timezone),
        ),
      );
    }
  }

  // The four global runs, once per process rather than once per city.
  registered.push(
    await upsert(
      ctx,
      FX_REFRESH_SCHEDULER_ID,
      QUEUE.fxRefresh,
      JOB[QUEUE.fxRefresh].refresh,
      parseJobData(QUEUE.fxRefresh, JOB[QUEUE.fxRefresh].refresh, {}),
      repeatOptions(SCHEDULE.fxRefresh, UTC_ZONE),
    ),
    await upsert(
      ctx,
      DATA_EXPIRY_HOURLY_SCHEDULER_ID,
      QUEUE.dataExpiry,
      JOB[QUEUE.dataExpiry].hourly,
      // The step is the job name's own value, so the data and the name cannot drift apart.
      parseJobData(QUEUE.dataExpiry, JOB[QUEUE.dataExpiry].hourly, {
        step: JOB[QUEUE.dataExpiry].hourly,
      }),
      repeatOptions(SCHEDULE.dataExpiryHourly, UTC_ZONE),
    ),
    await upsert(
      ctx,
      DATA_EXPIRY_DAILY_SCHEDULER_ID,
      QUEUE.dataExpiry,
      JOB[QUEUE.dataExpiry].daily,
      parseJobData(QUEUE.dataExpiry, JOB[QUEUE.dataExpiry].daily, {
        step: JOB[QUEUE.dataExpiry].daily,
      }),
      repeatOptions(SCHEDULE.dataExpiryDaily, UTC_ZONE),
    ),
    await upsert(
      ctx,
      ACCOUNT_ERASURE_SWEEP_SCHEDULER_ID,
      QUEUE.accountErasure,
      JOB[QUEUE.accountErasure].sweep,
      parseJobData(QUEUE.accountErasure, JOB[QUEUE.accountErasure].sweep, {}),
      repeatOptions(SCHEDULE.accountErasureSweep, UTC_ZONE),
    ),
  );

  // Counts and ids only: a scheduler's data is an id at most, and it belongs in neither a log line
  // nor an operator's clipboard (AAP 0.11.1).
  ctx.logger.info({
    event: 'schedulers_registered',
    registered: registered.length,
    removed: removed.length,
    telephonyMode: mode,
  });

  return { registered, removed };
}
