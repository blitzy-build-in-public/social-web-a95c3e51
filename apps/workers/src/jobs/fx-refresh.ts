// The daily FX refresh: one `fx-refresh` / `refresh` run reads the provider's USD table and stores it as one `FxRate` row per `FX_CURRENCIES` entry, keyed by the UTC day the provider's rates belong to — its `time_last_update_unix`, never the run's own day, which makes the write idempotent by construction. The provider is called before the transaction and never inside it, and every row is built before the write: a third-party request inside a transaction would hold a database connection across a network wait, and a table that omits a currency aborts the run with nothing stored. Two properties the price pipeline depends on: rows of other dates are never deleted or rewritten, so `fxRateFor` converts a price captured on a day whose refresh failed through the newest table on or before that date ("the last good table stays in use", with no staleness limit), and nothing here is caught — a provider failure propagates so BullMQ retries the job on the queue's own policy while the stored table keeps serving conversions.

import { isJobName, parseJobData, QUEUE, QueuePayloadError } from '@tablemate/server-core';

import { fetchUsdTable, toFxRows } from '../fx/open-er-api.ts';
// Type-only on purpose: `queues.ts` value-imports this file's `process`, so a value import back would close a runtime cycle. A type-only import is erased on emit.
import type { WorkerContext } from '../queues.ts';

// The `fx-refresh` job as a processor receives it: a structural subset of BullMQ's `Job`, so a test can call {@link process} with a plain object. The queue carries no data of its own.
export interface FxRefreshJob {
  // BullMQ's job id — `fx-refresh`, the scheduler id — accepted for the processor contract and deliberately unread: the run is keyed by the day the provider's rates belong to, never by its id.
  readonly id?: string;
  readonly name: string;
  readonly data: unknown;
}

export interface FxRefreshResult {
  readonly event: 'fx_refreshed';
  readonly date: string;
  readonly currencies: number;
}

// Stores the provider's latest USD table as that table's own date's `FxRate` rows.
export async function process(job: FxRefreshJob, ctx: WorkerContext): Promise<FxRefreshResult> {
  if (!isJobName(QUEUE.fxRefresh, job.name)) {
    // Also the shape of the refusal `queues.ts` raises for an unknown job name, so a job that reaches this processor by a direct test call fails the same way one through the queue does.
    throw new QueuePayloadError(`${QUEUE.fxRefresh}/${job.name}`);
  }
  parseJobData(QUEUE.fxRefresh, job.name, job.data);
  const table = await fetchUsdTable(ctx.env.FX_URL);
  // The provider's own table date keys the rows: a table served late refreshes the previous day's row rather than relabelling those rates as this run's day's.
  const rows = toFxRows(table);
  await ctx.db.$transaction(async (tx) => {
    for (const row of rows) {
      // `date_currency` is Prisma's name for the compound primary key of `FxRate`, and `row.date` is already the UTC midnight of the provider's day, so the key is the same day whatever the writer's zone is.
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
