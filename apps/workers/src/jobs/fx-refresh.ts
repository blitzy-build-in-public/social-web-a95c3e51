/**
 * The daily FX refresh (AAP 0.5.6, 0.3.3): one `fx-refresh` / `refresh` run reads the provider's USD
 * table and stores it as one `FxRate` row per `FX_CURRENCIES` entry, keyed by the UTC day the
 * provider's rates belong to — its `time_last_update_unix`, never the run's own day.
 *
 * The provider is called before the transaction and never inside it, and every row is built before
 * the write: a third-party request inside a transaction would hold a database connection across a
 * network wait (AAP 0.2.2), and a table that omits a currency aborts the run with nothing stored.
 *
 * Two properties the rest of the price pipeline depends on:
 *
 *   - Rows of other dates are never deleted or rewritten, so `fxRateFor` converts a price captured on
 *     a day whose refresh failed through the newest table on or before that date — "the last good
 *     table stays in use" (AAP 0.5.6), with no staleness limit applied.
 *   - The provider's own `time_last_update_unix` keys the rows: a table served late refreshes the
 *     previous day's row idempotently instead of relabelling it as the run day's, and a retry of the
 *     same day's job therefore upserts the same rows. The write is idempotent by construction — one
 *     row per (date, currency), upserted, so a second run leaves the rows exactly as the first one
 *     left them (AAP 0.3.2).
 *
 * Nothing here is caught: a provider failure propagates so BullMQ retries the job on the queue's own
 * policy — five tries, exponential backoff from 10 minutes (`QUEUE_JOB_OPTIONS` in
 * `@tablemate/server-core`) — and the stored table keeps serving conversions while it retries.
 *
 * @see AAP 0.3.3 for the endpoint and the currency list, 0.5.2 for `FxRate`, 0.5.6 for the daily
 *   00:30 UTC schedule and the backoff.
 */

import { isJobName, parseJobData, QUEUE, QueuePayloadError } from '@tablemate/server-core';

import { fetchUsdTable, toFxRows } from '../fx/open-er-api.ts';
// Type-only on purpose: `queues.ts` value-imports this file's `process`, so a value import back
// would close a runtime cycle. A type-only import is erased on emit.
import type { WorkerContext } from '../queues.ts';

/**
 * The `fx-refresh` job as a processor receives it: a structural subset of BullMQ's `Job`, so a test
 * can call {@link process} with a plain object. The queue carries no data of its own (AAP 0.5.6),
 * which is why `data` is only ever the empty object `parseJobData` accepts.
 */
export interface FxRefreshJob {
  /**
   * BullMQ's job id — `fx-refresh`, the scheduler id of AAP 0.5.6. Accepted for the processor
   * contract and deliberately unread: the run is keyed by the day the provider's rates belong to,
   * never by its id.
   */
  readonly id?: string;
  /** The job name, which this queue accepts as `refresh` and as nothing else. */
  readonly name: string;
  /** The job's data, held by the queue's schema to the empty object. */
  readonly data: unknown;
}

/**
 * What one run reports, logged under the same three fields (AAP 0.11.1 lists the logging points).
 */
export interface FxRefreshResult {
  /** The event name every line this job logs carries. */
  readonly event: 'fx_refreshed';
  /**
   * The provider's table date the rows were stored under, `YYYY-MM-DD`: the UTC day its rates belong
   * to, not the day this run happened.
   */
  readonly date: string;
  /** How many rows were written: one per `FX_CURRENCIES` entry. */
  readonly currencies: number;
}

/**
 * Stores the provider's latest USD table as that table's own date's `FxRate` rows (AAP 0.5.6).
 *
 * @param job - The `fx-refresh` / `refresh` job; only its name and data are read.
 * @param ctx - The worker context: `env.FX_URL` for the endpoint, the logger, and the database client
 *   the six upserts run in one transaction on. A row's date is provider data, not the current time,
 *   so this job reads no clock.
 * @returns The date written and how many currencies it covers.
 * @throws QueuePayloadError when the job name is not this queue's `refresh`, or when its data is not
 *   the empty object the queue's schema allows — the same refusal, for the same reason, that
 *   `parseJobData` gives a queue and job pair with no schema. `Error` from `fetchUsdTable` when the
 *   provider fails or answers outside its envelope, and `Error` naming the currency when the table
 *   omits one of `FX_CURRENCIES`. Each of them is left to the queue to retry.
 * @see AAP 0.5.6 for the job's schedule and 0.5.3 for the durable-operation rule that keeps the
 *   provider call outside the transaction.
 */
export async function process(job: FxRefreshJob, ctx: WorkerContext): Promise<FxRefreshResult> {
  if (!isJobName(QUEUE.fxRefresh, job.name)) {
    // Also the shape of the refusal `queues.ts` raises for an unknown job name, so a job that reaches
    // this processor by a direct test call fails the same way one through the queue does.
    throw new QueuePayloadError(`${QUEUE.fxRefresh}/${job.name}`);
  }

  // The job carries no data; the parse is what refuses a job that carries any.
  parseJobData(QUEUE.fxRefresh, job.name, job.data);

  const table = await fetchUsdTable(ctx.env.FX_URL);

  // The provider's own table date keys the rows: a table served late refreshes the previous day's
  // row rather than relabelling those rates as this run's day's.
  const rows = toFxRows(table);

  await ctx.db.$transaction(async (tx) => {
    for (const row of rows) {
      // `date_currency` is Prisma's name for the compound primary key of `FxRate`, and `row.date` is
      // already the UTC midnight of the provider's day, so the key is the same day whatever the
      // writer's zone is.
      await tx.fxRate.upsert({
        where: { date_currency: { date: row.date, currency: row.currency } },
        create: row,
        update: { usdPerUnit: row.usdPerUnit },
      });
    }
  });

  const result: FxRefreshResult = {
    event: 'fx_refreshed',
    date: table.date,
    currencies: rows.length,
  };

  ctx.logger.info(result, 'fx_refreshed');

  return result;
}
