/**
 * The price-job trigger behind `POST /admin/price-jobs`: `kind: "menus"` queues one menu-ingestion fan-out for a city and `kind:
 * "calls"` its phone fallback.
 *
 * This module only enqueues: the workers' `menu-ingest`/`ingest-city` expands it into per-place jobs in the call-and-menu priority
 * order, and `call-dispatch`/`dispatch-city` takes the city's queued call tasks — which is what keeps a slow crawl, a telephony outage
 * and a language-model failure out of every request path.
 *
 * The cap check here is an early refusal for the operator, never the enforcement point: both caps are still enforced where the work
 * happens, so a job admitted here can still be deferred to the next local day. With `TELEPHONY_MODE=off` no worker processes
 * `call-dispatch`, so a `calls` job waits in its queue and the request still answers `202 { jobId }`.
 */

import type { Queue } from 'bullmq';

import type { DbClient } from '@tablemate/db';
import { JOB, QUEUE, jobOptionsFor, localDateKey, parseJobData } from '@tablemate/server-core';
import type { CommonEnv, Logger, QueueName } from '@tablemate/server-core';
import type { PriceJobKind, PriceJobRequest, PriceJobResponse } from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';

/**
 * What {@link enqueuePriceJob} needs: the app's services, narrowed to the capabilities this module reads. Narrowed on purpose, because
 * the dependency whitelist of this file admits `@tablemate/db`, `@tablemate/server-core` and `@tablemate/shared` only.
 */
export interface PriceJobServices {
  readonly db: Pick<DbClient, 'city' | 'callBudgetDay'>;
  /** The BullMQ producers the app built, keyed by queue name; `undefined` for a queue no producer was created for, which fails the
   * request as an unexpected error rather than queueing nowhere. */
  readonly queues: { get(name: QueueName): Queue | undefined };
  readonly env: Pick<CommonEnv, 'CAP_CALLS_PER_CITY_DAY' | 'capLlmMicrosPerCityDay'>;
  readonly logger: Pick<Logger, 'info' | 'error'>;
}

const PRICE_JOB_ENQUEUED = 'price_job_enqueued';
const PRICE_JOB_ENQUEUE_FAILED = 'price_job_enqueue_failed';

/**
 * Refuses a city whose local day has used up the cap `kind` is counted against, then queues the city's fan-out job.
 *
 * `now` comes from the request's received time — this module reads no clock of its own — and the cap is counted against the city's
 * local day at `now`: `city_not_found` for a city that is not configured, and `daily_cap_reached` when the day's calls or committed
 * language-model spend has reached its cap. A job that cannot be queued throws a plain `Error`, which the errors plugin answers as
 * `500 internal_error`.
 */
export async function enqueuePriceJob(
  services: PriceJobServices,
  body: PriceJobRequest,
  now: Date,
): Promise<PriceJobResponse> {
  const city = await services.db.city.findUnique({
    where: { id: body.cityId },
    select: { id: true, timezone: true },
  });
  if (city === null) {
    throw new AppError('city_not_found');
  }
  // The city's own zone keys the cap, so the day the operator is refused for is the day the worker
  // counts its calls in; a second lookup through `services` could only disagree with this row.
  await assertUnderDailyCap(services, city.id, city.timezone, body.kind, now);
  // Written out per kind rather than looked up in a table of pairs: `parseJobData` resolves a
  // payload schema through both the queue and its job name, and TypeScript collapses that lookup to
  // `never` for a union of queue names, so each branch parses its payload under one literal pair.
  switch (body.kind) {
    case 'menus': {
      const queueName = QUEUE.menuIngest;
      const jobName = JOB[queueName].ingestCity;
      return enqueueCityJob(
        services,
        queueName,
        jobName,
        parseJobData(queueName, jobName, { cityId: city.id }),
        body.kind,
        city.id,
      );
    }
    case 'calls': {
      const queueName = QUEUE.callDispatch;
      const jobName = JOB[queueName].dispatchCity;
      return enqueueCityJob(
        services,
        queueName,
        jobName,
        parseJobData(queueName, jobName, { cityId: city.id }),
        body.kind,
        city.id,
      );
    }
  }
}

/**
 * Throws `429 daily_cap_reached` when `kind`'s cap for the city's current local day is reached.
 *
 * A missing `CallBudgetDay` row is zero usage, which is how a city that has never been called or spent on starts. The spend totals are
 * `BigInt` columns, compared as `BigInt` so a day near the cap is never decided by a float.
 */
async function assertUnderDailyCap(
  services: PriceJobServices,
  cityId: string,
  timezone: string,
  kind: PriceJobKind,
  now: Date,
): Promise<void> {
  const localDate = localDateKey(timezone, now);
  // Prisma types the `@db.Date` column as a DateTime and refuses a bare `YYYY-MM-DD` string, so the
  // local date is passed as its UTC midnight: the date part PostgreSQL stores is then exactly the
  // key `localDateKey` derived, whatever zone the process happens to run in.
  const day = new Date(`${localDate}T00:00:00.000Z`);
  const usage = await services.db.callBudgetDay.findUnique({
    where: { cityId_localDate: { cityId, localDate: day } },
    select: { calls: true, llmSpendMicros: true, llmReservedMicros: true },
  });
  if (kind === 'calls') {
    if ((usage?.calls ?? 0) >= services.env.CAP_CALLS_PER_CITY_DAY) {
      throw new AppError('daily_cap_reached');
    }
    return;
  }
  const committedMicros = (usage?.llmSpendMicros ?? 0n) + (usage?.llmReservedMicros ?? 0n);
  if (committedMicros >= BigInt(services.env.capLlmMicrosPerCityDay)) {
    throw new AppError('daily_cap_reached');
  }
}

/**
 * `data` arrives already parsed by `parseJobData` at the call site, where the queue and its job name are literal constants: that literal
 * pair is what lets the payload schema be resolved, so the parse happens there rather than under this call's wider types.
 *
 * No custom `jobId` is passed: a stable id suppresses a duplicate `add` in BullMQ, and an operator asking twice for the same city wants
 * two runs of the work, not one. The retries and retention come from `jobOptionsFor`.
 *
 * An unreachable Redis, a queue with no producer and a job BullMQ returns without an id all throw a plain `Error` rather than an
 * `AppError`: the route's contract names three errors and nothing else, so this is an unexpected failure, answered as
 * `500 internal_error` with the request id while the operator's own signal is the `price_job_enqueue_failed` line.
 */
async function enqueueCityJob(
  services: PriceJobServices,
  queueName: QueueName,
  jobName: string,
  data: unknown,
  kind: PriceJobKind,
  cityId: string,
): Promise<PriceJobResponse> {
  const queue = services.queues.get(queueName);
  if (queue === undefined) {
    services.logger.error({ event: PRICE_JOB_ENQUEUE_FAILED, cityId, kind });
    throw new Error('price_job_enqueue_failed: no producer for the queue');
  }
  let jobId: string | undefined;
  try {
    const job = await queue.add(jobName, data, jobOptionsFor(queueName));
    jobId = job.id;
  } catch (cause) {
    services.logger.error({ event: PRICE_JOB_ENQUEUE_FAILED, cityId, kind });
    throw new Error('price_job_enqueue_failed', { cause });
  }
  if (jobId === undefined) {
    // BullMQ assigns the id when it creates the job, and the contract answers one; without it the
    // caller would be handed an unusable id instead of learning that queueing failed.
    services.logger.error({ event: PRICE_JOB_ENQUEUE_FAILED, cityId, kind });
    throw new Error('price_job_enqueue_failed: the job carries no id');
  }
  services.logger.info({ event: PRICE_JOB_ENQUEUED, cityId, kind, jobId });
  return { jobId };
}
