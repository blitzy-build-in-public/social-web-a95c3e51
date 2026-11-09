/**
 * The daily price-freshness sweep (AAP 0.5.6, 0.5.7): one `price-freshness` / `check` run per city finds the places whose
 * prices `suggestions` can no longer serve from and re-queues the work that can refresh them — a menu re-read where the place
 * publishes a menu, a `menu_prices` call where it does not.
 *
 * AAP 0.5.7 estimates a place's cost only from fresh, approved records: an `online_menu` price counts for 30 days and a
 * `phone_quote` or `operator_entry` price for 60, which are `FRESHNESS_ONLINE_DAYS` and `FRESHNESS_PHONE_OPERATOR_DAYS` in
 * `@tablemate/shared`. Past those windows a record is still stored but no longer usable, and this job is what closes the gap:
 * {@link process} hands each city's aged-out sets to the two producers that already own the follow-up work, so no crawl and no
 * call is ever made from here, which keeps every third-party call out of a schedule-driven path (AAP 0.3.2).
 *
 * Two selections, one per window, and neither one guesses. A place with a website or a menu link whose approved `online_menu`
 * records have all aged out — a record exists and none is fresh, exactly the test `suggestions` applies, while a place that
 * never published an online menu is the `ingest-city` fan-out's business. And a place whose estimate rests on approved
 * `phone_quote` or `operator_entry` records that have all aged out, where a fresh online set excludes it because `suggestions`
 * would already hold a usable price for it.
 *
 * Both selections are bounded to {@link STALE_PLACE_BATCH} places, both leave out a place whose `menu_prices` refresh is
 * already outstanding, and both are ordered by ascending place id — which is what lets one run hand a city over to the next
 * instead of reading the same head forever (AAP 0.5.6, 0.5.7). A place stays eligible while its prices stay stale, so nothing
 * is skipped, only deferred.
 *
 * Idempotency holds by construction, so a retry and the sweeper's own repeat are no-ops (AAP 0.3.2): a menu job carries the
 * deterministic id `menu-ingest-<placeId>-<localDateKey>`, which BullMQ suppresses while a job of that id is waiting, delayed
 * or retained, and `ensureMenuPricesTask` refuses a place that already has an open `menu_prices` task. Time comes from
 * `ctx.clock.now()` and every cut-off is computed in Node and bound as a parameter — never SQL `now()` — so the test clock
 * moves both windows at once (AAP 0.11.1); both raw reads carry `fixturePredicate`, because raw SQL bypasses the guarded
 * client's fixture filter.
 */

import { Prisma, fixturePredicate } from '@tablemate/db';
import { QUEUE, QueuePayloadError, isJobName, parseJobData } from '@tablemate/server-core';
import { DAY_MS, FRESHNESS_ONLINE_DAYS, FRESHNESS_PHONE_OPERATOR_DAYS } from '@tablemate/shared';
import type { CitySlug } from '@tablemate/shared';

import {
  OPEN_MENU_PRICES_TASK_PREDICATE,
  enqueueMenuIngest,
  ensureMenuPricesTask,
} from './menu-ingest.ts';
// Type-only on purpose: `queues.ts` owns `WorkerContext` and value-imports this file's `process`, so a value import back would close a runtime cycle. A type-only import is erased on emit.
import type { WorkerContext } from '../queues.ts';

// The most places each of the two selections below returns in one run (AAP 0.5.6, 0.5.7).
//
// The job is scheduled daily per city, so a batch of 500 is a page that schedule can repeat: both selections are
// ordered by ascending place id and leave out a place whose refresh is already outstanding, so the places a run acted
// on are gone from the next page and consecutive runs walk the city rather than covering it in one pass. 500 is a run
// whose fan-out — one queued job per place, and one transaction with a per-place advisory lock for each place that
// needs a call — stays bounded while a city's place table grows with every weekly Overpass refresh.
const STALE_PLACE_BATCH = 500;
// A structural subset of BullMQ's `Job`, so a test can call {@link process} with a plain object.
export interface PriceFreshnessJob {
  // `price-freshness-<cityId>`, the scheduler id built by `priceFreshnessSchedulerId` (AAP 0.3.2, 0.5.6): accepted for
  // the processor contract and deliberately unread, because the run is keyed by the city in its data, never by its id.
  readonly id?: string;
  readonly name: string;
  readonly data: unknown;
}

// What one city's sweep reported, logged under the same fields (AAP 0.5.6, 0.11.1).
export interface PriceFreshnessResult {
  readonly event: 'price_freshness';
  readonly cityId: CitySlug;
  /** What `enqueueMenuIngest` reported for the page of aged-out online places: one entry per place whose online prices
   * aged past 30 days. A place the queue already holds today's job for comes back with the same job id, so the count
   * repeats while BullMQ suppresses the duplicate. */
  readonly menuJobs: number;
  /** The `menu_prices` call tasks this run actually opened, since `ensureMenuPricesTask` answers true only when it
   * created one and a place whose task was already outstanding is not selected at all. */
  readonly callTasks: number;
}

// The `place_id` values of one city's places whose approved online-menu prices have aged out, at most
// {@link STALE_PLACE_BATCH} of them, in ascending id order (AAP 0.5.6, 0.5.7).
//
// Both arms carry `review_status = 'approved'`: a record an operator has not approved is not a price, so a place whose
// only online records are awaiting review still counts as one that needs re-reading. The two arms together are the
// "has an online set and none of it is fresh" test, and they are what keeps this selection identical to the one
// `suggestions` reads prices by.
//
// A place whose `menu_prices` refresh is already outstanding is left out: neither producer would act on such a row, and
// skipping it is what makes the bounded page advance, because with a bare `LIMIT` the same outstanding places would
// hold the head of every run's page until their calls resolved and the places behind them would never be reached.
async function placesWithStaleOnlinePrices(
  ctx: WorkerContext,
  cityId: CitySlug,
  onlineCutoff: Date,
): Promise<string[]> {
  const rows = await ctx.db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "p"."id"::text AS "id"
      FROM "place" AS "p"
     WHERE "p"."city_id" = ${cityId}
       AND ("p"."website" IS NOT NULL OR "p"."menu_url" IS NOT NULL)
       AND EXISTS (
             SELECT 1
               FROM "price_record" AS "pr"
              WHERE "pr"."place_id" = "p"."id"
                AND "pr"."source" = 'online_menu'
                AND "pr"."review_status" = 'approved'
                AND ${fixturePredicate(ctx.env.APP_ENV, 'pr')}
           )
       AND NOT EXISTS (
             SELECT 1
               FROM "price_record" AS "pr"
              WHERE "pr"."place_id" = "p"."id"
                AND "pr"."source" = 'online_menu'
                AND "pr"."review_status" = 'approved'
                AND "pr"."captured_at" >= ${onlineCutoff}::timestamptz
                AND ${fixturePredicate(ctx.env.APP_ENV, 'pr')}
           )
       AND NOT EXISTS (
             SELECT 1
               FROM "call_task" AS "t"
              WHERE "t"."place_id" = "p"."id"
                AND "t"."kind" = 'menu_prices'
                AND ${OPEN_MENU_PRICES_TASK_PREDICATE}
           )
       AND ${fixturePredicate(ctx.env.APP_ENV, 'p')}
     ORDER BY "p"."id" ASC
     LIMIT ${STALE_PLACE_BATCH}::int
  `);
  return rows.map((row) => row.id);
}

/**
 * The place ids of one city whose approved phone-quoted or operator-entered prices have aged out
 * and whose estimate no fresh online set already supplies, at most {@link STALE_PLACE_BATCH} of
 * them, in ascending id order (AAP 0.5.6, 0.5.7).
 *
 * The three arms are the rule: the place has phone or operator prices, none of them is inside the
 * 60-day window, and it holds no fresh approved online record. Without the last arm a place that
 * `suggestions` can price from its own website would be sent to a paid call for nothing.
 *
 * A place whose `menu_prices` refresh is already outstanding is left out for the same reason the
 * selection is bounded at all: `ensureMenuPricesTask` opens no second task for it — it takes a
 * transaction and a per-place advisory lock only to answer `false` — so a page that kept returning
 * such a place would spend the run on it and never reach the places behind it.
 */
async function placesWithStalePhonePrices(
  ctx: WorkerContext,
  cityId: CitySlug,
  phoneCutoff: Date,
  onlineCutoff: Date,
): Promise<string[]> {
  const rows = await ctx.db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "p"."id"::text AS "id"
      FROM "place" AS "p"
     WHERE "p"."city_id" = ${cityId}
       AND EXISTS (
             SELECT 1
               FROM "price_record" AS "pr"
              WHERE "pr"."place_id" = "p"."id"
                AND "pr"."source" IN ('phone_quote', 'operator_entry')
                AND "pr"."review_status" = 'approved'
                AND ${fixturePredicate(ctx.env.APP_ENV, 'pr')}
           )
       AND NOT EXISTS (
             SELECT 1
               FROM "price_record" AS "pr"
              WHERE "pr"."place_id" = "p"."id"
                AND "pr"."source" IN ('phone_quote', 'operator_entry')
                AND "pr"."review_status" = 'approved'
                AND "pr"."captured_at" >= ${phoneCutoff}::timestamptz
                AND ${fixturePredicate(ctx.env.APP_ENV, 'pr')}
           )
       AND NOT EXISTS (
             SELECT 1
               FROM "price_record" AS "pr"
              WHERE "pr"."place_id" = "p"."id"
                AND "pr"."source" = 'online_menu'
                AND "pr"."review_status" = 'approved'
                AND "pr"."captured_at" >= ${onlineCutoff}::timestamptz
                AND ${fixturePredicate(ctx.env.APP_ENV, 'pr')}
           )
       AND NOT EXISTS (
             SELECT 1
               FROM "call_task" AS "t"
              WHERE "t"."place_id" = "p"."id"
                AND "t"."kind" = 'menu_prices'
                AND ${OPEN_MENU_PRICES_TASK_PREDICATE}
           )
       AND ${fixturePredicate(ctx.env.APP_ENV, 'p')}
     ORDER BY "p"."id" ASC
     LIMIT ${STALE_PLACE_BATCH}::int
  `);
  return rows.map((row) => row.id);
}

/**
 * Runs one city's price-freshness sweep (AAP 0.5.6, 0.5.7).
 *
 * The job name is narrowed with `isJobName` before the data is parsed, which is the pair
 * `names.ts` and `payloads.ts` are built for: the name and the data are validated together, so a
 * name this queue does not accept, or data that does not match that name's schema, fails here
 * rather than reaching a rule.
 *
 * Both selections are bounded, and both leave out a place whose `menu_prices` refresh is already
 * outstanding, so the run's fan-out does not grow with the city's place table and the sweep walks a
 * city over consecutive daily runs instead of re-reading its head (AAP 0.3.2, 0.5.6). The page moves
 * in ascending place id, and every place the run acts on carries outstanding work afterwards and so
 * leaves the next page, while a place the run only queued a re-read for keeps its prices until the
 * re-read lands and is selected again — with the same job id, which the queue already holds, so a
 * re-run at the same instant is a no-op either way.
 *
 * The menu re-reads go through `enqueueMenuIngest`, which is the only producer of this queue's jobs
 * and the place where a deterministic job id and the call-and-menu priority are applied, and the
 * calls go through `ensureMenuPricesTask`, which is the only opener of a `menu_prices` task and the
 * place where a `doNotCall` place and a place with a call already open are refused. The two counts
 * this returns are what the producers reported and not what was selected: `menuJobs` repeats on a
 * re-run whose jobs the queue already holds, while `callTasks` counts only the tasks the run opened.
 */
export async function process(
  job: PriceFreshnessJob,
  ctx: WorkerContext,
): Promise<PriceFreshnessResult> {
  const queue = QUEUE.priceFreshness;
  if (!isJobName(queue, job.name)) {
    // Also the shape of the refusal `queues.ts` raises for an unknown job name, so a job that reaches this processor by a direct test call fails the same way one through the queue does.
    throw new QueuePayloadError(`${queue}/${job.name}`);
  }
  const { cityId } = parseJobData(queue, job.name, job.data);
  // Both windows are measured from the injected clock and bound as parameters, so a test that moves the clock by 31 or 61 days moves the selection with it (AAP 0.11.1).
  const now = ctx.clock.now();
  const onlineCutoff = new Date(now.getTime() - FRESHNESS_ONLINE_DAYS * DAY_MS);
  const phoneCutoff = new Date(now.getTime() - FRESHNESS_PHONE_OPERATOR_DAYS * DAY_MS);
  const menuJobs = await enqueueMenuIngest(
    ctx,
    await placesWithStaleOnlinePrices(ctx, cityId, onlineCutoff),
  );
  const stalePhonePlaces = await placesWithStalePhonePrices(ctx, cityId, phoneCutoff, onlineCutoff);
  // One at a time: `ensureMenuPricesTask` takes a per-place advisory lock in its own transaction, so a sweep that opened them together would hold as many connections as the city has places.
  let callTasks = 0;
  for (const placeId of stalePhonePlaces) {
    if (await ensureMenuPricesTask(ctx.db, ctx, placeId, now)) {
      callTasks += 1;
    }
  }
  const result: PriceFreshnessResult = {
    event: 'price_freshness',
    cityId,
    menuJobs,
    callTasks,
  };
  ctx.logger.info(result, 'price_freshness');
  return result;
}
