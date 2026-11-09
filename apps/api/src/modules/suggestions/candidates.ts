/**
 * Candidate places, opening hours and the `suggest` orchestration behind `GET /meetups/:id/suggestions`.
 *
 * A candidate is a `restaurant`, `cafe`, `bar` or `activity` place within `SUGGESTION_RADIUS_METERS` (2 km) of the
 * meetup's venue, and it survives only when its stored `PriceRecord` rows produce an estimate, when it is open between
 * `SUGGESTION_OPEN_FROM_HOURS_AFTER_START` (1 h) after the start and `SUGGESTION_LOCAL_CUTOFF` (23:00) on the meetup's
 * city-local day, and when that estimate is at or under the pair's shared per-person budget. The counts that remain give
 * the empty-state reason, in the order `no_priced_places`, `none_open`, `budget_too_low`.
 *
 * Read-only by design: one parameterized statement over `Place` and `PriceRecord`, no price is ever guessed, and a
 * failure here reaches `routes.ts` alone, which answers `503 suggestions_unavailable`. Two conventions are load-bearing:
 * every identifier comes from a helper of `@tablemate/db` and every value is a bound parameter, so the read carries the
 * fixture guard `$queryRaw` does not add itself; and because `opening_hours` reads a `Date`'s process-local fields, every
 * instant handed to it is shifted into the city's own zone first by `toCityWallClock` of `@tablemate/server-core`, the
 * one home of the city-wall-clock shift, whatever the host's `TZ` is.
 */

import { Prisma, distanceMeters, fixturePredicate, geoColumn, withinMeters } from '@tablemate/db';
import type { DbClient } from '@tablemate/db';
import {
  addLocalDays,
  formatCityWallTime,
  fromCityWallClock,
  localDateKey,
  localTimeOn,
  startOfLocalDay,
  toCityWallClock,
} from '@tablemate/server-core';
import type { ApiEnv, Logger } from '@tablemate/server-core';
import {
  DAY_MS,
  FRESHNESS_PHONE_OPERATOR_DAYS,
  HOUR_MS,
  ItemCategory,
  PlaceCategory,
  PriceSource,
  ReviewStatus,
  SUGGESTION_LOCAL_CUTOFF,
  SUGGESTION_OPEN_FROM_HOURS_AFTER_START,
  SUGGESTION_RADIUS_METERS,
  TicketType,
} from '@tablemate/shared';
import type { AppEnv, CityConfig, SuggestionEmptyReason } from '@tablemate/shared';
import OpeningHours from 'opening_hours';
import { z } from 'zod';

import { cityBySlug } from '../proofs/registry.ts';
import { estimatePlace } from './estimate.ts';
import type { PlaceEstimate, PriceRow } from './estimate.ts';
import { emptyReasonFor, fitsBudget, rankSuggestions } from './rank.ts';
import type { RankInput } from './rank.ts';

/**
 * What {@link loadCandidates} and {@link suggest} need from the composition root: a narrowed declaration rather than an
 * import of the app's services type, so a suite can stand a client, an environment and a logger in for the app.
 */
export interface SuggestionServices {
  /** The guarded Prisma client; only its raw, parameterized read surface is used (AAP 0.11.2). */
  readonly db: Pick<DbClient, '$queryRaw'>;
  readonly env: Pick<ApiEnv, 'APP_ENV'>;
  readonly logger: Pick<Logger, 'debug'>;
}

/**
 * One place within the suggestion radius of the meetup's venue, with the price rows its estimate is built from. `cityId`
 * is the meetup venue's city rather than the place's own, because the opening window and the 23:00 cut-off are wall-clock
 * times of that city's zone; `isPartnerVenue` ranks a linked partner place before every non-partner place.
 */
export interface CandidatePlace {
  readonly placeId: string;
  readonly name: string;
  readonly category: PlaceCategory;
  readonly cityId: string;
  readonly isPartnerVenue: boolean;
  readonly distanceM: number;
  readonly openingHours: string | null;
  /**
   * The rows of the place's newest capture batch per source among its approved rows inside the widest freshness window:
   * the first stage of `currentSet`'s rule, which `estimatePlace` completes.
   */
  readonly prices: readonly PriceRow[];
}

/** One ranked suggestion: a candidate that produced an estimate and is open in the meetup's window. `estimateCents`
 * mirrors `estimate.estimateCents`, because that is the figure `rankSuggestions` filters and orders on. */
export type SuggestedPlace = CandidatePlace &
  RankInput & {
    readonly estimate: PlaceEstimate;
    readonly estimateCents: number;
    readonly openingHoursToday: string | null;
  };
/** What {@link suggest} returns: the ranked places, and why the list is empty when it is. `emptyReason` is present only
 * when `items` is empty; the budget the list was ranked against is added by the route. */
export interface SuggestResult {
  readonly items: SuggestedPlace[];
  readonly emptyReason?: SuggestionEmptyReason;
}

/**
 * The statement's freshness prefilter: the widest window of any source, bounding what the statement scans and aggregates.
 * It is still only a prefilter — `estimatePlace` applies the exact per-source window, the authoritative rule.
 */
const WIDEST_FRESHNESS_DAYS = FRESHNESS_PHONE_OPERATOR_DAYS;

/**
 * One price row as the statement's `json_build_object` renders it, which is {@link PriceRow} once the capture instant is
 * rebuilt. A row that does not match is our own invariant violation, so it is rejected rather than coerced.
 */
const AGGREGATED_PRICE_ROW = z.object({
  id: z.string(),
  captureBatchId: z.string(),
  itemName: z.string(),
  normalizedName: z.string(),
  itemCategory: ItemCategory,
  alcoholic: z.boolean().nullable(),
  perPerson: z.boolean().nullable(),
  ticketType: TicketType.nullable(),
  priceUsdCents: z.number().int().nonnegative(),
  source: PriceSource,
  sourceUrl: z.string(),
  reviewStatus: ReviewStatus,
  capturedAtMs: z.number().int(),
});

const CANDIDATE_ROW = z.object({
  placeId: z.string(),
  name: z.string(),
  category: PlaceCategory,
  openingHours: z.string().nullable(),
  cityId: z.string(),
  distanceM: z.number(),
  isPartnerVenue: z.boolean(),
  prices: z.array(AGGREGATED_PRICE_ROW),
});

type CandidateRow = z.infer<typeof CANDIDATE_ROW>;
type AggregatedPriceRow = z.infer<typeof AGGREGATED_PRICE_ROW>;

const CANDIDATE_ROW_MISMATCH = 'suggestions: a candidate row does not match the statement shape';

/**
 * The candidate statement: every category-carrying place within the suggestion radius of the meetup's venue that has at
 * least one approved price row inside the widest freshness window, with the rows of that place's newest capture batch per
 * source aggregated into one array.
 *
 * The 2 km test is `withinMeters(geoColumn('p', 'place'), geoColumn('v', 'venue'), …)`, so the GiST-indexed
 * `place.location` stands on the left and the venue row supplies the right-hand point. The place must belong to the
 * venue's own city, which is what makes every row carry the one city whose zone the window is judged in. `opening_hours`
 * is deliberately not filtered here: a priced place with no hours counts as priced but not open, which is what makes
 * `emptyReason` `none_open` rather than `no_priced_places`.
 *
 * The aggregate keeps, per source, the batch ordered by the latest `capturedAt` of its rows and then by the larger
 * `capture_batch_id` — the first stage of `currentSet`'s rule. Reducing any further in SQL would change the estimate: the
 * second stage, the latest record per `(itemCategory, normalizedName)`, is not reproducible per place here, because the
 * record it keeps for an item can come from another source while an older batch of the item's own source holds it too.
 *
 * `isPartnerVenue` asks whether any active partner venue is linked to the place, so the meetup's own venue place is a
 * candidate at 0 m that ranks first. Each of the three fixture-bearing tables carries `fixturePredicate` for its own
 * alias. A venue, or a place, with no location is not a candidate: `ST_DWithin` is unknown for a null geography.
 */
function candidatesStatement(env: AppEnv, venueId: string, now: Date): Prisma.Sql {
  const widestCutoff = new Date(now.getTime() - WIDEST_FRESHNESS_DAYS * DAY_MS);
  return Prisma.sql`
    SELECT p."id"::text AS "placeId",
           p."name" AS "name",
           p."category"::text AS "category",
           p."opening_hours" AS "openingHours",
           v."city_id" AS "cityId",
           ${distanceMeters(geoColumn('p', 'place'), geoColumn('v', 'venue'))} AS "distanceM",
           EXISTS (
             SELECT 1
               FROM "venue" "pv"
              WHERE "pv"."place_id" = p."id"
                AND "pv"."is_active_partner"
                AND ${fixturePredicate(env, 'pv')}
           ) AS "isPartnerVenue",
           "prices"."items" AS "prices"
      FROM "venue" "v"
      JOIN "place" "p"
        ON ${withinMeters(geoColumn('p', 'place'), geoColumn('v', 'venue'), SUGGESTION_RADIUS_METERS)}
       AND p."city_id" = v."city_id"
       AND p."category"::text IN (${Prisma.join(PlaceCategory.options)})
       AND ${fixturePredicate(env, 'p')}
      JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 'id', "k"."id", 'captureBatchId', "k"."capture_batch_id",
                 'itemName', "k"."item_name", 'normalizedName', "k"."normalized_name",
                 'itemCategory', "k"."item_category", 'alcoholic', "k"."alcoholic",
                 'perPerson', "k"."per_person", 'ticketType', "k"."ticket_type",
                 'priceUsdCents', "k"."price_usd_cents", 'source', "k"."source",
                 'sourceUrl', "k"."source_url", 'reviewStatus', "k"."review_status",
                 'capturedAtMs', (EXTRACT(EPOCH FROM "k"."captured_at") * 1000)::bigint
               ) ORDER BY "k"."id") AS "items"
          FROM (
            SELECT "b".*,
                   rank() OVER (
                     PARTITION BY "b"."source"
                     ORDER BY "b"."batch_latest" DESC, "b"."capture_batch_id" DESC
                   ) AS "batch_rank"
              FROM (
                SELECT "r"."id",
                       "r"."capture_batch_id",
                       "r"."item_name",
                       "r"."normalized_name",
                       "r"."item_category",
                       "r"."alcoholic",
                       "r"."per_person",
                       "r"."ticket_type",
                       "r"."price_usd_cents",
                       "r"."source",
                       "r"."source_url",
                       "r"."review_status",
                       "r"."captured_at",
                       max("r"."captured_at") OVER (
                         PARTITION BY "r"."source", "r"."capture_batch_id"
                       ) AS "batch_latest"
                  FROM "price_record" "r"
                 WHERE r."place_id" = p."id"
                   AND r."review_status" = 'approved'
                   AND r."captured_at" >= ${widestCutoff}
                   AND ${fixturePredicate(env, 'r')}
              ) "b"
          ) "k"
         WHERE "k"."batch_rank" = 1
      ) "prices" ON "prices"."items" IS NOT NULL
     WHERE "v"."id" = ${venueId}::uuid
       AND ${fixturePredicate(env, 'v')}
  `;
}

/**
 * The candidate places of one meetup, read in a single statement. The read goes through `services.db.$queryRaw`, the
 * surface the fixture guard leaves to its own `fixturePredicate` and the one a test replaces to prove that a suggestions
 * failure stays on this route.
 */
export async function loadCandidates(
  services: SuggestionServices,
  venueId: string,
  now: Date,
): Promise<CandidatePlace[]> {
  const rows = await services.db.$queryRaw<unknown[]>(
    candidatesStatement(services.env.APP_ENV, venueId, now),
  );
  const parsed = z.array(CANDIDATE_ROW).safeParse(rows);
  if (!parsed.success) {
    throw new Error(CANDIDATE_ROW_MISMATCH);
  }
  return parsed.data.map(toCandidatePlace);
}

function toCandidatePlace(row: CandidateRow): CandidatePlace {
  return {
    placeId: row.placeId,
    name: row.name,
    category: row.category,
    cityId: row.cityId,
    isPartnerVenue: row.isPartnerVenue,
    distanceM: Math.round(row.distanceM),
    openingHours: row.openingHours,
    prices: row.prices.map(toPriceRow),
  };
}

function toPriceRow(row: AggregatedPriceRow): PriceRow {
  const { capturedAtMs, ...prices } = row;
  return { ...prices, capturedAt: new Date(capturedAtMs) };
}

/** How many parsed `opening_hours` values one process keeps: the values are a handful per city, so the cap only guards
 * against a pathological sweep. */
const HOURS_CACHE_LIMIT = 2000;

const MIDNIGHT_WALL_TIME = '24:00';

const INTERVAL_SEPARATOR = ', ';

const INTERVAL_DASH = '\u2013';

const WALL_TIME_FORMAT = 'HH:mm';

/**
 * The parsed `opening_hours` values of one process, keyed `<cityId>|<value>`, because a place's hours are a pure function
 * of the value and of the city the window is judged in. A value that cannot be parsed is cached as `null` too, and the map
 * is cleared rather than evicted when it fills.
 */
const hoursCache = new Map<string, OpeningHours | null>();

/** The library value of one place's hours, or `null` when the value cannot be parsed, the one way a place with unusable
 * hours stays out of the suggestions. */
function openingHoursFor(city: CityConfig, value: string): OpeningHours | null {
  const key = `${city.id}|${value}`;
  const cached = hoursCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseOpeningHours(city, value);
  if (hoursCache.size >= HOURS_CACHE_LIMIT) {
    hoursCache.clear();
  }
  hoursCache.set(key, parsed);
  return parsed;
}

/** Parses one `opening_hours` value with the city's own context, or returns `null`; the library reports a value it cannot
 * parse by throwing a bare string rather than an `Error`, so the catch is value-less. */
function parseOpeningHours(city: CityConfig, value: string): OpeningHours | null {
  // The third constructor argument is left out on purpose: its `optional_conf` shape requires every key to
  // be present, and its `mode` default is `time_ranges` (0), which is what `getOpenIntervals` needs. Passing
  // `{ mode: 0 }` alone would not typecheck.
  try {
    return new OpeningHours(value, {
      lat: city.centroid.lat,
      lon: city.centroid.lng,
      address: { country_code: city.countryCode.toLowerCase(), state: '' },
    });
  } catch {
    return null;
  }
}

/** The known-open intervals of `oh` inside `from`–`to`, as instants in `tz`; an interval the library marks `unknown` is
 * dropped, because "open, times to be confirmed" is not evidence that a place is open. */
function openIntervals(
  oh: OpeningHours,
  tz: string,
  from: Date,
  to: Date,
): Array<readonly [Date, Date]> {
  const intervals: Array<readonly [Date, Date]> = [];
  for (const [start, end, unknown] of oh.getOpenIntervals(
    toCityWallClock(tz, from),
    toCityWallClock(tz, to),
  )) {
    if (unknown) {
      continue;
    }
    intervals.push([fromCityWallClock(tz, start), fromCityWallClock(tz, end)]);
  }
  return intervals;
}

/** Whether the place is open at some point between an hour after the meetup's start and 23:00 on the meetup's city-local
 * day; a meetup starting at 22:30 local leaves an empty window, and an empty window is never open. */
function isOpenInWindow(oh: OpeningHours, tz: string, startsAt: Date): boolean {
  const from = new Date(startsAt.getTime() + SUGGESTION_OPEN_FROM_HOURS_AFTER_START * HOUR_MS);
  const to = localTimeOn(tz, localDateKey(tz, startsAt), SUGGESTION_LOCAL_CUTOFF);
  if (from.getTime() >= to.getTime()) {
    return false;
  }
  return openIntervals(oh, tz, from, to).length > 0;
}

/** The meetup day's known-open intervals in city time, or `null` when the place is not known to be open that day at all;
 * an interval reaching the end of the span is written `24:00`, which is how `Mo-Su 10:00-24:00` reads back. */
function formatOpeningHoursOn(oh: OpeningHours, tz: string, startsAt: Date): string | null {
  const day = localDateKey(tz, startsAt);
  const from = startOfLocalDay(tz, day);
  const to = startOfLocalDay(tz, addLocalDays(day, 1));
  const intervals = openIntervals(oh, tz, from, to);
  if (intervals.length === 0) {
    return null;
  }
  return intervals
    .map(([start, end]) => {
      const closing =
        end.getTime() === to.getTime()
          ? MIDNIGHT_WALL_TIME
          : formatCityWallTime(tz, end, WALL_TIME_FORMAT);
      return `${formatCityWallTime(tz, start, WALL_TIME_FORMAT)}${INTERVAL_DASH}${closing}`;
    })
    .join(INTERVAL_SEPARATOR);
}

/**
 * The ranked day-plan suggestions of one meetup.
 *
 * The three filters run in the order `emptyReason` reports them, and each count is kept so the reason names the filter
 * that stopped the flow: **priced** (the candidates whose rows produce an estimate, freshness included), **open** (of
 * those, the ones open between an hour after the start and 23:00 local on the meetup day), then **fitting**
 * (`rankSuggestions`, which applies the budget filter along with the ordering and both limits).
 *
 * Nothing is written and nothing outside PostgreSQL is read, so a failure here cannot reach the meetup flow; the route
 * answers `503 suggestions_unavailable` for this route alone.
 */
export async function suggest(
  services: SuggestionServices,
  meetup: { readonly venueId: string; readonly startsAt: Date },
  budgetCents: number,
  now: Date,
): Promise<SuggestResult> {
  const candidates = await loadCandidates(services, meetup.venueId, now);
  // One candidate row carries the meetup venue's own city, which is the city the window is judged
  // in (`p."city_id" = v."city_id"` in the statement). With no candidate at all there is nothing
  // priced to report and no city to resolve.
  const venue = candidates[0];
  if (venue === undefined) {
    return { items: [], emptyReason: 'no_priced_places' };
  }
  const city = cityOf(venue.cityId);
  const priced: Array<{ readonly place: CandidatePlace; readonly estimate: PlaceEstimate }> = [];
  for (const place of candidates) {
    const estimate = estimatePlace(place.category, place.prices, now);
    if (estimate !== null) {
      priced.push({ place, estimate });
    }
  }
  const open: SuggestedPlace[] = [];
  let unparsableHours = 0;
  for (const { place, estimate } of priced) {
    const hours = place.openingHours === null ? null : openingHoursFor(city, place.openingHours);
    if (place.openingHours !== null && hours === null) {
      unparsableHours += 1;
    }
    if (hours === null || !isOpenInWindow(hours, city.timezone, meetup.startsAt)) {
      continue;
    }
    open.push({
      ...place,
      estimate,
      estimateCents: estimate.estimateCents,
      openingHoursToday: formatOpeningHoursOn(hours, city.timezone, meetup.startsAt),
    });
  }
  if (unparsableHours > 0) {
    services.logger.debug(
      { event: 'suggestions_hours_unparsable', count: unparsableHours },
      'suggestions_hours_unparsable',
    );
  }
  const items = rankSuggestions(open, budgetCents);
  const emptyReason = emptyReasonFor({
    pricedCount: priced.length,
    openCount: open.length,
    fittingCount: open.filter((place) => fitsBudget(place.estimateCents, budgetCents)).length,
  });
  return emptyReason === undefined ? { items } : { items, emptyReason };
}

/**
 * The configured city a candidate's `cityId` names. A venue row whose city the configuration does not name is a
 * configuration error rather than a data condition: without the city's zone no opening window can be judged, and reporting
 * every such place as closed would hide the fault behind `none_open`. The message names no configured value.
 */
function cityOf(cityId: string): CityConfig {
  const city = cityBySlug(cityId);
  if (city === undefined) {
    throw new Error('suggestions: the meetup venue is in a city the configuration does not name');
  }
  return city;
}
