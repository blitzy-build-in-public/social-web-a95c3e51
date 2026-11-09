/**
 * The recurring schedulers `apps/workers/src/main.ts` registers once at startup (AAP 0.5.1, 0.5.6): one set per configured
 * city — the weekly place refresh, the daily price-freshness sweep, the 00:05 local stay expiry and, while telephony is on,
 * the two-minute call dispatch — plus the four global runs: the daily FX table, the hourly and daily data-expiry steps, and
 * the account-erasure sweep. Beside them {@link primeFxTable} enqueues the one-off `fx-refresh` run a stack needs before its
 * first 00:30 UTC, because that table is what a price conversion reads.
 *
 * Four rules shape it. BullMQ owns the registration: `upsertJobScheduler` creates a scheduler or updates the one already under
 * that id, so registering twice — a restart, a rolling deploy, a second replica — leaves exactly one scheduler per id
 * (AAP 0.2.2), and the single removal is the call dispatch of a stack switched to `TELEPHONY_MODE=off`, so that posture stops
 * the dialling rather than leaving the timer behind (AAP 0.6.2); a city that leaves `config/cities.json` keeps its schedulers
 * until an operator removes them. Every id comes from server-core and uses `-` rather than `:`, which BullMQ refuses in a
 * custom id (AAP 0.3.2). A template's data is validated first with `parseJobData`, so a job whose data no longer matches its
 * queue's schema fails the start instead of being enqueued to a processor that would refuse it. And there is no wall clock
 * here: BullMQ evaluates a repeat pattern against real time, so no test relies on a scheduler — a suite drives the processors
 * directly with the injected test clock (AAP 0.11.1, 0.11.2).
 *
 * Registering is idempotent and not transactional: a failure part way through throws to `main.ts`, which fails the start, and
 * the next start upserts what is already there and completes the rest.
 */

import type { JobSchedulerTemplateOptions, RepeatOptions } from 'bullmq';

import {
  ACCOUNT_ERASURE_SWEEP_SCHEDULER_ID,
  DATA_EXPIRY_DAILY_SCHEDULER_ID,
  DATA_EXPIRY_HOURLY_SCHEDULER_ID,
  FX_REFRESH_PRIME_JOB_ID,
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

// Type-only on purpose: this module is imported by `main.ts`, and a value import of `queues.ts` would close the cycle `queues.ts` -> `jobs/*` -> ... -> `schedulers.ts` -> `queues.ts`.
import type { WorkerContext } from './queues.ts';

// The zone a cadence is written in: `city` for a run anchored to a city's local clock, which reads the zone the caller passes, and `UTC` — spelled as IANA and BullMQ both understand it — for the runs fixed in UTC.
const CITY_ZONE = 'city';
const UTC_ZONE = 'UTC';
// Every cadence this process registers, keyed by the run it describes (AAP 0.5.3, 0.5.6).
//
// Four instants are AAP 0.5.3/0.5.6's own — 00:05 local for the stay expiry, 00:30 UTC for the FX table, 03:00 UTC for
// the financial-retention step and every two minutes for the call dispatch. The rest are chosen here, off-peak,
// because those cadences are stated without an hour: the weekly place refresh runs Monday 04:00 local, price freshness
// daily at 04:30 local, and the account-erasure sweep — which enforces the 30 days of AAP 0.5.2 — daily at 03:15 UTC,
// after the retention step. A cadence is data, not a closure: the id, the queue and the job name beside it come from
// server-core, and `registerSchedulers` pairs the two.
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
type ScheduleEntry = (typeof SCHEDULE)[keyof typeof SCHEDULE];
// The repeat options BullMQ is handed for one cadence: an interval for an `every` entry, otherwise the cron pattern in the zone its entry names, `timezone` being read only by a `city`-zoned entry.
function repeatOptions(cadence: ScheduleEntry, timezone: string): Omit<RepeatOptions, 'key'> {
  return 'every' in cadence
    ? { every: cadence.every }
    : { pattern: cadence.cron, tz: cadence.zone === CITY_ZONE ? timezone : cadence.zone };
}

/** The keys a job scheduler owns and a queue's job policy must therefore not supply. */
const SCHEDULER_OWNED_KEYS = ['jobId', 'delay', 'repeat', 'deduplication'] as const;
// The options every job a scheduler creates is added with: the queue's own policy from `jobOptionsFor` — its attempts, its backoff and its completion caps — less the keys the scheduler owns. BullMQ refuses `jobId`, `repeat` and `delay` in a template and sets deduplication itself, so those are dropped rather than passed, and the policy the caller takes is a copy of a frozen table, so deleting here never writes through to the shared defaults.
function templateOptions(queue: QueueName): JobSchedulerTemplateOptions {
  const options: Record<string, unknown> = { ...jobOptionsFor(queue) };
  for (const key of SCHEDULER_OWNED_KEYS) {
    delete options[key];
  }
  return options;
}

// Registers one scheduler, or updates the one already under `id`, and returns that id. Whatever `upsertJobScheduler` throws, an unreachable Redis included, fails the start: a process whose schedulers are not registered is not ready.
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

// Registers every recurring scheduler this deployment runs, and unregisters the one a mode switches off (AAP 0.5.1,
// 0.5.6).
//
// The cities come from the seeded `City` rows, in id order so the log's counts and a test's list are reproducible; a
// deployment whose seed has not run yet registers the four global schedulers and none per city, which is the right
// outcome for a stack with no city to refresh. Every per-city job carries its `cityId`, which is what lets one job know
// which local day and which zone it works in.
//
// Call dispatch is registered per city only while `TELEPHONY_MODE` is `simulator` or `twilio`. With `off` the scheduler
// is removed instead — a no-op when it was never registered, and reported in `removed` only when a scheduler really
// went — so switching a running stack to `off` stops the dialling, and the tasks themselves wait in `queued` until
// telephony returns (AAP 0.6.2).
//
// A template that no longer matches its job's schema, or an unreachable Redis, fails the start deliberately: a drifted
// template is a code defect rather than something a retry repairs, and a process with no schedulers would silently
// stop refreshing places, prices, stays and retention.
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
  // Counts and ids only: a scheduler's data is an id at most, and it belongs in neither a log line nor an operator's clipboard (AAP 0.11.1).
  ctx.logger.info({
    event: 'schedulers_registered',
    registered: registered.length,
    removed: removed.length,
    telephonyMode: mode,
  });
  return { registered, removed };
}

// Enqueues the one-off `fx-refresh` run that fills an FX table no run has written yet, and reports whether it was
// added (AAP 0.5.6).
//
// AAP 0.5.6 fixes a price's conversion on the capture day's `FxRate`, and the delivered `fx-refresh` job is its only
// writer, on a schedule whose first run is 00:30 UTC, so a stack younger than that run holds no rate and the operator's
// price entry — the one path that converts a price outside the menu pipeline — would have nothing to convert a non-USD
// price with. Priming runs the delivered job once at startup instead of inventing a rate or converting at another
// day's rate, so the conversion stays the capture day's; a provider that is unreachable fails the run on the queue's
// own policy — five tries, backoff from 10 minutes (AAP 0.5.6) — leaving the table as it was.
//
// A row of any date answers the count, because the read is `usdRateFor`'s own: it takes the latest rate at or before
// the capture day, so an existing table serves every day this stack can capture on.
export async function primeFxTable(ctx: WorkerContext): Promise<boolean> {
  if ((await ctx.db.fxRate.count()) > 0) {
    return false;
  }
  await ctx.queues
    .get(QUEUE.fxRefresh)
    .add(
      JOB[QUEUE.fxRefresh].refresh,
      parseJobData(QUEUE.fxRefresh, JOB[QUEUE.fxRefresh].refresh, {}),
      jobOptionsFor(QUEUE.fxRefresh, { jobId: FX_REFRESH_PRIME_JOB_ID }),
    );
  return true;
}
