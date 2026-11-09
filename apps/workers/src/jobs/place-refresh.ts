/**
 * The weekly OpenStreetMap place and lodging refresh (AAP 0.3.3, 0.5.6, 0.5.7): one `place-refresh` / `refresh` run per
 * city, which keeps `place`, `lodging` and the call-and-menu priority bands current.
 *
 * Three rules decide the order of the work. Overpass is called before any transaction opens and the two queries run one
 * after the other: a third-party request inside a transaction would hold a database connection across a network wait, and
 * the public Overpass instance is shared infrastructure used at fair use. Only OSM-sourced fields are written: a place from
 * the fields `../places/categorize.ts` reads out of the element's own tags, and a lodging through
 * `../places/lodging-upsert.ts`, which refreshes an OSM phone only while the row's `phoneSource` is still `osm` and never
 * writes `doNotCall`, `isFixture`, a console secret or an existing row's `cityId`. And nothing is deleted: a place absent
 * from an answer is left untouched, because `price_record` rows reference it, and a lodging OSM stops listing is marked
 * `osmMissingAt` rather than removed.
 *
 * The run ends by handing the refreshed places to the price pipeline: `nearest_partner_distance_m` is recomputed first, so
 * the bands that order `menu-ingest` and `call-dispatch` are current when the jobs are added; then a place with a website
 * or a menu link whose online prices are stale is queued for `menu-ingest`, and a place with neither link nor any usable
 * price takes the `menu_prices` phone fallback. No price is guessed here and nothing is dialled here.
 *
 * Nothing is caught. An Overpass, database or queue failure propagates so BullMQ retries the job on the queue's own policy,
 * and the next weekly run is the backstop.
 */

import {
  Prisma,
  fixturePredicate,
  readPoints,
  refreshNearestPartnerDistances,
  setPoint,
  type DbClient,
  type DbTx,
} from '@tablemate/db';
import { QUEUE, QueuePayloadError, isJobName, parseJobData } from '@tablemate/server-core';
import { Bbox, FRESHNESS_ONLINE_DAYS, FRESHNESS_PHONE_OPERATOR_DAYS } from '@tablemate/shared';
import type { AppEnv, LatLng } from '@tablemate/shared';

import { crawlerUserAgent } from '../menus/robots.ts';
import { placeFields, type PlaceFields } from '../places/categorize.ts';
import { upsertLodgings, type LodgingUpsertResult } from '../places/lodging-upsert.ts';
import {
  buildLodgingsQuery,
  buildPlacesQuery,
  osmKeyString,
  runOverpass,
  type OverpassElement,
} from '../places/overpass.ts';
import { ensureMenuPricesTask, enqueueMenuIngest } from './menu-ingest.ts';
// Type-only on purpose: `queues.ts` value-imports this file's `process`, so a value import back would close a runtime cycle.
import type { WorkerContext } from '../queues.ts';

const QUEUE_NAME = QUEUE.placeRefresh;
// A batch bounds the work a retry repeats and keeps a refresh's row locks short; the two statements per place (`upsert` and `setPoint`) fit a batch of this size inside one {@link PLACE_TRANSACTION_TIMEOUT_MS} transaction.
const PLACE_BATCH_SIZE = 100;
const PLACE_TRANSACTION_TIMEOUT_MS = 60_000;
// Larger than the place batch's, because a city's bbox holds far more lodgings than one batch holds places and `upsertLodgings` costs up to two round trips per element — the room its TSDoc asks the caller for.
const LODGING_TRANSACTION_TIMEOUT_MS = 120_000;
/** The deadline of one Overpass request (AAP 0.11.1: "Overpass 60 s"). */
const OVERPASS_TIMEOUT_MS = 60_000;
// Each existing-row lookup is one branch per element type, because the (`osm_type`, `osm_id`) key has to have its leading column constrained for the unique index to be sought (AAP 0.5.2, 0.5.6).
const OSM_TYPES = ['node', 'way', 'relation'] as const;
const ONLINE_MENU_SOURCE = 'online_menu';
// A structural subset of BullMQ's `Job`, so a test can call {@link process} with a plain object. The scheduler id is `place-refresh-<cityId>`, read for the log only, and the queue's data is `{ cityId }` (AAP 0.5.6).
export interface PlaceRefreshJob {
  readonly id?: string;
  readonly name: string;
  readonly data: unknown;
}

// What the run wrote to `place` (AAP 0.5.6): places inserted, places whose row existed and was written again from what OSM reports, and elements that cannot become a place because they have no name, no category or no usable coordinate. A place this refresh did not see is counted nowhere: an answer that omits it is not evidence that it closed, so nothing is deleted or marked.
export interface PlaceRefreshCounts {
  readonly inserted: number;
  readonly updated: number;
  readonly skipped: number;
}

// What one city's refresh reports, logged under the same fields (AAP 0.11.1 lists the logging points). Counts only: no place name, lodging name, phone number, address or coordinate is part of it, and no such value reaches a log line anywhere below.
export interface PlaceRefreshResult {
  readonly event: 'place_refresh';
  readonly cityId: string;
  readonly places: PlaceRefreshCounts;
  /** Includes the rows the lodging upsert marked `osmMissingAt` and cleared again. */
  readonly lodgings: LodgingUpsertResult;
  /** The `menu-ingest` jobs BullMQ accepted for the refreshed places. */
  readonly menuJobs: number;
  /** The `menu_prices` tasks this run opened for places with no usable link or price. */
  readonly callTasks: number;
}

// The run's answer for a city the database no longer holds.
export interface UnknownCityOutcome {
  readonly skipped: 'unknown_city';
}

export type PlaceRefreshOutcome = PlaceRefreshResult | UnknownCityOutcome;
// The refreshed places, so the price work is limited to what this run wrote (AAP 0.5.6).
interface RefreshedPlaces {
  readonly counts: PlaceRefreshCounts;
  readonly ids: string[];
}

type CityRow = {
  readonly id: string;
  /** The ISO 3166-1 alpha-2 code, which the opening-hours check needs for `PH` and sunrise rules. */
  readonly countryCode: string;
  /** The `bbox` object of `config/cities.json`, as the seed wrote it into the JSON column. */
  readonly bbox: Prisma.JsonValue;
};
async function loadCity(db: DbClient, cityId: string): Promise<CityRow | null> {
  return await db.city.findUnique({
    where: { id: cityId },
    select: { id: true, countryCode: true, bbox: true },
  });
}

// The city's bounding box, as the `Bbox` schema validates it (AAP 0.5.6). The seed writes the validated `bbox` of `config/cities.json` into the column, so a value that does not parse is a row no lodging ingestion can work from. It throws rather than skipping the lodgings query: a failed job lands in the queue's failure set for an operator.
function cityBbox(city: CityRow): Bbox {
  const parsed = Bbox.safeParse(city.bbox);
  if (!parsed.success) {
    throw new Error(`place_refresh_city_bbox_invalid: "${city.id}"`);
  }
  return parsed.data;
}

// The coordinates the places query runs around: the city's active partner venues and its lodgings that hold a console secret (AAP 0.5.6) — "within 2 km of each partner venue and each partner lodging". A lodging with no `secretIssuedAt` contributes no centre, and neither does one OSM no longer lists (`osmMissingAt` set); coordinates come from `readPoints`, the only reader of the `geography` column Prisma cannot select.
async function cityCentres(db: DbClient, cityId: string, appEnv: AppEnv): Promise<LatLng[]> {
  const venues = await db.venue.findMany({
    where: { cityId, isActivePartner: true },
    select: { id: true },
  });
  const lodgings = await db.lodging.findMany({
    where: { cityId, secretIssuedAt: { not: null }, osmMissingAt: null },
    select: { id: true },
  });
  const venuePoints = await readPoints(
    db,
    'venue',
    venues.map((venue) => venue.id),
    appEnv,
  );
  const lodgingPoints = await readPoints(
    db,
    'lodging',
    lodgings.map((lodging) => lodging.id),
    appEnv,
  );
  return [...venuePoints.values(), ...lodgingPoints.values()];
}

// The (`osmType`, `osmId`) keys the batch already has, as `<osmType>/<osmId>` (AAP 0.5.2, 0.5.6): the lookup that separates an inserted place from an updated one in the run's counts. It reads one branch per element type for the reason {@link OSM_TYPES} gives, through the guarded client, which narrows it to `isFixture: false` outside `test` and `demo` so the answer is the one an upsert will act on.
async function existingPlaceKeys(tx: DbTx, batch: readonly PlaceFields[]): Promise<Set<string>> {
  const osmIds = [...new Set(batch.map((place) => place.osmId))];
  const rows = await tx.place.findMany({
    where: { OR: OSM_TYPES.map((osmType) => ({ osmType, osmId: { in: osmIds } })) },
    select: { osmType: true, osmId: true },
  });
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.osmType !== null && row.osmId !== null) {
      keys.add(osmKeyString(row.osmType, row.osmId));
    }
  }
  return keys;
}

// Turns one city's Overpass place elements into `Place` rows (AAP 0.5.2, 0.5.6). The write is an upsert keyed by (`osmType`, `osmId`), so a second run over the same answer leaves the same rows, and the location goes in through `setPoint` in the same transaction, because the `geography` column is one Prisma cannot write. The update payload carries only what OSM reports: `doNotCall`, `isFixture` and an existing row's `cityId` are never written back. An element that cannot become a place is counted as skipped, and a duplicated element is written once — the first occurrence wins.
async function refreshPlaces(
  ctx: WorkerContext,
  cityId: string,
  elements: readonly OverpassElement[],
  countryCode: string,
): Promise<RefreshedPlaces> {
  const counts = { inserted: 0, updated: 0, skipped: 0 };
  const mapped = new Map<string, PlaceFields>();
  for (const element of elements) {
    const fields = placeFields(element, { countryCode });
    if (fields === null) {
      counts.skipped += 1;
      continue;
    }
    const key = osmKeyString(fields.osmType, fields.osmId);
    if (!mapped.has(key)) {
      mapped.set(key, fields);
    }
  }
  const wanted = [...mapped.values()];
  const ids: string[] = [];
  for (let start = 0; start < wanted.length; start += PLACE_BATCH_SIZE) {
    const batch = wanted.slice(start, start + PLACE_BATCH_SIZE);
    const written = await ctx.db.$transaction(
      async (tx) => {
        const existing = await existingPlaceKeys(tx, batch);
        const batchIds: string[] = [];
        for (const place of batch) {
          const row = await tx.place.upsert({
            where: { osmType_osmId: { osmType: place.osmType, osmId: place.osmId } },
            create: {
              osmType: place.osmType,
              osmId: place.osmId,
              cityId,
              name: place.name,
              category: place.category,
              website: place.website,
              menuUrl: place.menuUrl,
              phone: place.phone,
              openingHours: place.openingHours,
              doNotCall: false,
              isFixture: false,
            },
            update: {
              name: place.name,
              category: place.category,
              website: place.website,
              menuUrl: place.menuUrl,
              phone: place.phone,
              openingHours: place.openingHours,
            },
            select: { id: true },
          });
          await setPoint(tx, 'place', row.id, { lat: place.lat, lng: place.lng });
          batchIds.push(row.id);
          if (existing.has(osmKeyString(place.osmType, place.osmId))) {
            counts.updated += 1;
          } else {
            counts.inserted += 1;
          }
        }
        return batchIds;
      },
      { timeout: PLACE_TRANSACTION_TIMEOUT_MS },
    );
    ids.push(...written);
  }
  return { counts, ids };
}

// One refreshed place as the two price questions are answered for it (AAP 0.5.6, 0.5.7): `hasLink` is a `website` or a `menu_url`, the two links `menu-ingest` can fetch; `hasFreshOnline` an approved `online_menu` record inside the 30-day window; and `hasFreshAny` an approved record of any source inside that source's own window.
interface PriceWorkRow {
  readonly id: string;
  readonly hasLink: boolean;
  readonly hasFreshOnline: boolean;
  readonly hasFreshAny: boolean;
}

// What the price work queued (AAP 0.5.6): the `menu-ingest` jobs and the `menu_prices` tasks.
interface PriceWorkCounts {
  readonly menuJobs: number;
  readonly callTasks: number;
}

// Hands the places this refresh wrote to the price pipeline (AAP 0.5.6, 0.5.7). One statement answers all three questions a
// place's price work turns on, with `fixturePredicate` in the `WHERE` and in each `EXISTS`, because raw SQL bypasses the
// guarded client's filter; the bound source name carries an explicit `::"price_source"` cast, because PostgreSQL has no `=`
// between that enum column and the `text` an untyped placeholder arrives as. "Fresh" is per source: an online menu read
// expires after 30 days, a phone quote or an operator entry after 60.
//
// A place with a website or a menu link and no fresh online price is queued for `menu-ingest`, whose own run opens the
// phone fallback if the menu yields too few items. A place with neither link and no usable price of any source takes the
// phone fallback directly: with nothing to fetch, a `menu_prices` call is the only route to a price. A price is never
// guessed, and a place whose task is already open is left alone by `ensureMenuPricesTask`.
async function enqueuePriceWork(
  ctx: WorkerContext,
  placeIds: readonly string[],
  now: Date,
): Promise<PriceWorkCounts> {
  const wanted = [...new Set(placeIds)];
  if (wanted.length === 0) {
    return { menuJobs: 0, callTasks: 0 };
  }
  const rows = await ctx.db.$queryRaw<PriceWorkRow[]>(Prisma.sql`
    SELECT "p"."id"::text AS "id",
           ("p"."website" IS NOT NULL OR "p"."menu_url" IS NOT NULL) AS "hasLink",
           EXISTS (
             SELECT 1
               FROM "price_record" AS "pr"
              WHERE "pr"."place_id" = "p"."id"
                AND "pr"."source" = ${ONLINE_MENU_SOURCE}::"price_source"
                AND "pr"."review_status" = 'approved'
                AND "pr"."captured_at" >=
                    ${now}::timestamptz - ${FRESHNESS_ONLINE_DAYS}::int * interval '1 day'
                AND ${fixturePredicate(ctx.env.APP_ENV, 'pr')}
           ) AS "hasFreshOnline",
           EXISTS (
             SELECT 1
               FROM "price_record" AS "pr"
              WHERE "pr"."place_id" = "p"."id"
                AND "pr"."review_status" = 'approved'
                AND "pr"."captured_at" >=
                    ${now}::timestamptz - (
                      CASE WHEN "pr"."source" = ${ONLINE_MENU_SOURCE}::"price_source"
                           THEN ${FRESHNESS_ONLINE_DAYS}::int
                           ELSE ${FRESHNESS_PHONE_OPERATOR_DAYS}::int
                      END
                    ) * interval '1 day'
                AND ${fixturePredicate(ctx.env.APP_ENV, 'pr')}
           ) AS "hasFreshAny"
      FROM "place" AS "p"
     WHERE "p"."id" = ANY(${wanted}::uuid[])
       AND ${fixturePredicate(ctx.env.APP_ENV, 'p')}
  `);
  const menuIds = rows.filter((row) => row.hasLink && !row.hasFreshOnline).map((row) => row.id);
  const fallbackIds = rows.filter((row) => !row.hasLink && !row.hasFreshAny).map((row) => row.id);
  const menuJobs = await enqueueMenuIngest(ctx, menuIds);
  let callTasks = 0;
  for (const placeId of fallbackIds) {
    if (await ensureMenuPricesTask(ctx.db, ctx, placeId, now)) {
      callTasks += 1;
    }
  }
  return { menuJobs, callTasks };
}

// Runs one `place-refresh` / `refresh` job: one city's places, its lodgings, its distance bands and the price work that
// follows (AAP 0.3.3, 0.5.6). The order is the design: the city is read, its centres and bbox are resolved, Overpass is
// asked once for the places around those centres and once for the lodgings inside the bbox, the places are written in
// batches, the lodgings in one transaction, the bands recomputed, and only then is the price work queued — so the jobs enter
// the queue ranked by the distances this run just wrote (AAP 0.5.7). A city with no active partner venue and no lodging
// holding a console secret has no 2 km neighbourhood, and `buildPlacesQuery` refuses an empty centre list.
export async function process(
  job: PlaceRefreshJob,
  ctx: WorkerContext,
): Promise<PlaceRefreshOutcome> {
  if (!isJobName(QUEUE_NAME, job.name)) {
    // The shape of the refusal `queues.ts` raises for an unknown job name, so a job that reaches this processor by a direct test call fails the same way one through the queue does.
    throw new QueuePayloadError(`${QUEUE_NAME}/${job.name}`);
  }
  const { cityId } = parseJobData(QUEUE_NAME, job.name, job.data);
  const now = ctx.clock.now();
  const city = await loadCity(ctx.db, cityId);
  if (city === null) {
    // A city dropped by a reseed can still have a scheduler or an onboarding job queued behind it, and there is nothing to refresh and nothing a retry would change: the city slug is configuration, not personal data, and it is what an operator needs.
    ctx.logger.warn({ event: 'place_refresh_skipped', skipReason: 'unknown_city', cityId });
    return { skipped: 'unknown_city' };
  }
  const bbox = cityBbox(city);
  const centres = await cityCentres(ctx.db, city.id, ctx.env.APP_ENV);
  const request = {
    url: ctx.env.OVERPASS_URL,
    userAgent: crawlerUserAgent(ctx.env.CRAWLER_CONTACT_URL),
    timeoutMs: OVERPASS_TIMEOUT_MS,
  };
  const placeElements =
    centres.length === 0 ? [] : await runOverpass(buildPlacesQuery(centres), request);
  const lodgingElements = await runOverpass(buildLodgingsQuery(bbox), request);
  const places = await refreshPlaces(ctx, city.id, placeElements, city.countryCode);
  const lodgings = await ctx.db.$transaction(
    (tx) => upsertLodgings(tx, city.id, lodgingElements, now, ctx.env.APP_ENV),
    { timeout: LODGING_TRANSACTION_TIMEOUT_MS },
  );
  await refreshNearestPartnerDistances(ctx.db, city.id, ctx.env.APP_ENV);
  const priceWork = await enqueuePriceWork(ctx, places.ids, now);
  const result: PlaceRefreshResult = {
    event: 'place_refresh',
    cityId: city.id,
    places: places.counts,
    lodgings,
    menuJobs: priceWork.menuJobs,
    callTasks: priceWork.callTasks,
  };
  ctx.logger.info(result, 'place_refresh');
  return result;
}
