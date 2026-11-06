/**
 * Operator-triggered price jobs: the handler of `POST /admin/price-jobs` (AAP 0.5.4, 0.5.6).
 *
 * `kind: "menus"` queues one menu-ingestion fan-out for a city and `kind: "calls"` its phone
 * fallback. This module only enqueues: `menu-ingest` / `ingest-city` expands into per-place `ingest`
 * jobs in the call-and-menu priority order of AAP 0.5.7, and `call-dispatch` / `dispatch-city` takes
 * the city's queued call tasks. Both run in `apps/workers`, which is what keeps a slow crawl, a
 * telephony outage and a language-model failure out of every request path (AAP 0.3.2) — this route
 * never waits on the work it queues, and it opens no transaction of its own, because it writes
 * nothing.
 *
 * The cap check here is an early refusal for the operator, never the enforcement point. A `calls`
 * request is refused once the city's local day has used `CAP_CALLS_PER_CITY_DAY` slots, and a
 * `menus` one once its committed language-model spend — spent plus reserved — has reached
 * `CAP_LLM_USD_PER_CITY_DAY`. Both counters live in `CallBudgetDay`, and both caps are still
 * enforced where the work happens: `apps/workers/src/calls/caps.ts` reserves a slot with a
 * conditional `UPDATE … RETURNING`, and the spend reservation in `@tablemate/server-core` sends no
 * request whose worst case does not fit (AAP 0.5.6). A job admitted here can therefore still be
 * deferred to the next local day by the worker that runs it, and a refusal here only saves the
 * operator a job nobody would run today.
 *
 * With `TELEPHONY_MODE=off` — the local stack's default — no worker processes `call-dispatch`, so a
 * `calls` job waits in its queue until the mode changes; the request still answers `202 { jobId }`.
 *
 * Refusals are ordered as the route fixes them (AAP 0.5.4): the operator guard answers `403
 * operator_only` before this handler runs, an unknown city answers `404 city_not_found`, and a
 * used-up daily cap answers `429 daily_cap_reached` with nothing queued.
 *
 * @see AAP 0.5.4 for the route, its body, its `202 { jobId }` answer and its errors, 0.5.6 for the
 *   two job names and the daily caps, and 0.3.2 for the isolation of price work from the request
 *   path.
 */

import type { Queue } from 'bullmq';

import type { DbClient } from '@tablemate/db';
import { JOB, QUEUE, jobOptionsFor, localDateKey, parseJobData } from '@tablemate/server-core';
import type { CommonEnv, Logger, QueueName } from '@tablemate/server-core';
import type { PriceJobKind, PriceJobRequest, PriceJobResponse } from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';

/**
 * What {@link enqueuePriceJob} needs: the app's services, narrowed to the capabilities this module
 * reads.
 *
 * Narrowed on purpose. The composition root declares the app's services type, and the dependency
 * whitelist of this file admits `@tablemate/db`, `@tablemate/server-core` and `@tablemate/shared`
 * only, so the module states exactly what it uses rather than importing the app's type; the app's
 * services object satisfies this structurally, and a test can stand a producer or a reader in for
 * one of the four.
 */
export interface PriceJobServices {
  /** The guarded Prisma client, of which only the `city` and `callBudgetDay` delegates are read. */
  readonly db: Pick<DbClient, 'city' | 'callBudgetDay'>;
  /**
   * The BullMQ producers the app built, keyed by queue name. `undefined` for a queue no producer was
   * created for, which fails the request as an unexpected error rather than queueing nowhere.
   */
  readonly queues: { get(name: QueueName): Queue | undefined };
  /** The validated configuration, of which only the two daily caps are read. */
  readonly env: Pick<CommonEnv, 'CAP_CALLS_PER_CITY_DAY' | 'capLlmMicrosPerCityDay'>;
  /** The process logger; only these two levels are written through. */
  readonly logger: Pick<Logger, 'info' | 'error'>;
}

/** The one log event of a queued job, and the one of a queue that could not be reached. */
const PRICE_JOB_ENQUEUED = 'price_job_enqueued';
const PRICE_JOB_ENQUEUE_FAILED = 'price_job_enqueue_failed';

/**
 * Refuses a city whose local day has used up the cap `kind` is counted against, then queues the
 * city's fan-out job (AAP 0.5.4, 0.5.6).
 *
 * @param services - The app's services (see {@link PriceJobServices}).
 * @param body - The validated `PriceJobRequest`; `kind` selects the queue and the cap.
 * @param now - The current instant, from the request's received time — this module reads no clock
 *   of its own (AAP 0.11.1), and the cap is counted against the city's local day at `now`.
 * @returns The id of the job BullMQ created.
 * @throws {AppError} `city_not_found` for a city that is not configured, and `daily_cap_reached`
 *   when the local day's calls or committed language-model spend has reached its cap. A job that
 *   cannot be queued throws a plain `Error` instead, which the errors plugin answers as `500
 *   internal_error` (AAP 0.11.1) — see {@link enqueueCityJob}.
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
 * A missing `CallBudgetDay` row is zero usage, which is how a city that has never been called or
 * spent on starts: the row is created by the first reservation, not by this read (AAP 0.5.6). The
 * spend totals are `BigInt` columns, compared as `BigInt` so a day near the cap is never decided by
 * a float.
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
 * Adds and logs one city-wide price job, so the queue's policy and the job that carries the payload
 * are decided in one place (AAP 0.5.6).
 *
 * `data` arrives already parsed by `parseJobData` at the call site, where the queue and its job name
 * are literal constants: that literal pair is what lets the payload schema be resolved, so the parse
 * happens there rather than under this call's wider types.
 *
 * No custom `jobId` is passed: a stable id suppresses a duplicate `add` in BullMQ, and an operator
 * asking twice for the same city wants two runs of the work, not one. The retries and retention come
 * from `jobOptionsFor`, so the job table's per-queue exceptions travel with the job.
 *
 * @param services - The app's services (see {@link PriceJobServices}).
 * @param queueName - The queue to enqueue on.
 * @param jobName - The fan-out job of that queue, which is the name BullMQ carries.
 * @param data - The parsed payload of that queue and job pair.
 * @param kind - The requested kind, for the log line.
 * @param cityId - The city the fan-out covers, for the log line.
 * @returns The id of the job BullMQ created.
 * @throws {Error} when no producer exists for the queue, when the `add` fails (an unreachable
 *   Redis, most often) or when BullMQ returns a job without an id. Deliberately not an `AppError`:
 *   the route's contract names three errors and nothing else (AAP 0.5.4), and an unreachable queue
 *   is an unexpected failure, answered as `500 internal_error` with the request id while the
 *   underlying cause reaches the log (AAP 0.11.1). The operator's own signal is the
 *   `price_job_enqueue_failed` line, which carries the city and the kind and nothing else.
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
