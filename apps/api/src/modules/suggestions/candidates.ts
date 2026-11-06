/**
 * Candidate places, opening hours and the `suggest` orchestration behind
 * `GET /meetups/:id/suggestions` (AAP 0.5.1, 0.5.7).
 *
 * AAP 0.5.7 "Suggestion filtering" is the rule applied here. A candidate is a `restaurant`, `cafe`,
 * `bar` or `activity` place within `SUGGESTION_RADIUS_METERS` (2 km) of the meetup's venue, and it
 * survives only when its stored `PriceRecord` rows produce an estimate, when it is open at some
 * point between `SUGGESTION_OPEN_FROM_HOURS_AFTER_START` (1 h) after the start and
 * `SUGGESTION_LOCAL_CUTOFF` (23:00) on the meetup's city-local day, and when that estimate is at or
 * under the pair's shared per-person budget. The three counts that remain give the empty-state
 * reason, in the order `no_priced_places`, `none_open`, `budget_too_low`.
 *
 * Read-only by design (AAP 0.5.1): one parameterized statement over `Place` and `PriceRecord`, no
 * write, no transaction, no external service, and no price is ever guessed. Per place it ships the
 * rows of the newest capture batch of each source rather than every in-window row — all the estimate
 * can read from a place — so the payload no longer grows with a place's weekly recaptures
 * (AAP 0.5.7). A failure here therefore reaches `routes.ts` alone, which answers
 * `503 suggestions_unavailable` on that route while proposing, locking, checking in and settling are
 * untouched (AAP 0.3.2).
 *
 * Two conventions are load-bearing. Every identifier of the statement comes from a helper of
 * `@tablemate/db` — `fixturePredicate`, `geoColumn`, `withinMeters`, `distanceMeters` — and every
 * value is a bound parameter, so the read carries the fixture guard that `$queryRaw` does not add
 * itself (AAP 0.5.2, 0.11.2). And because `opening_hours` reads a `Date`'s *process-local* fields,
 * every instant handed to it is shifted into the city's own zone first, so a Lisbon place open
 * `Mo-Su 12:00-15:00` is judged by Lisbon wall-clock time whatever the host's `TZ` is (AAP 0.11.1).
 *
 * @see AAP 0.5.2 for `Place` and `PriceRecord`, 0.5.4 for the route and its errors, 0.5.6 for the
 *   ticket and freshness rules, 0.5.7 for the filtering, estimation and ranking rules, 0.5.8 for the
 *   empty states each reason drives, and 0.8.1 for this file.
 */

import { Prisma, distanceMeters, fixturePredicate, geoColumn, withinMeters } from '@tablemate/db';
import type { DbClient } from '@tablemate/db';
import { addLocalDays, localDateKey, localTimeOn, startOfLocalDay } from '@tablemate/server-core';
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
import { DateTime } from 'luxon';
import OpeningHours from 'opening_hours';
import { z } from 'zod';

import { cityBySlug } from '../proofs/registry.ts';
import { estimatePlace } from './estimate.ts';
import type { PlaceEstimate, PriceRow } from './estimate.ts';
import { emptyReasonFor, fitsBudget, rankSuggestions } from './rank.ts';
import type { RankInput } from './rank.ts';

// ---------------------------------------------------------------------------------------------
// Services (AAP 0.5.1)
// ---------------------------------------------------------------------------------------------

/**
 * What {@link loadCandidates} and {@link suggest} need from the API's composition root.
 *
 * A narrowed declaration rather than an import of the app's services type: `apps/api/src/app.ts` is
 * the composition root this module never reads, the shape below states exactly the capabilities the
 * work uses, and a unit test can stand a client, an environment and a logger in for the app. The
 * app's own services object satisfies this shape structurally.
 */
export interface SuggestionServices {
  /** The guarded Prisma client; only its raw, parameterized read surface is used (AAP 0.11.2). */
  readonly db: Pick<DbClient, '$queryRaw'>;
  /** The validated configuration, read for `APP_ENV`, which decides the fixture predicate. */
  readonly env: Pick<ApiEnv, 'APP_ENV'>;
  /** The process logger, written for the one debug line an unreadable hours value raises. */
  readonly logger: Pick<Logger, 'debug'>;
}

// ---------------------------------------------------------------------------------------------
// Types (AAP 0.5.1, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * One place within the suggestion radius of the meetup's venue, with the price rows its estimate is
 * built from (AAP 0.5.7).
 *
 * `cityId` is the meetup venue's city rather than the place's own: the opening window and the 23:00
 * cut-off are wall-clock times of that city's zone, and the meetup day is that city's day.
 * `isPartnerVenue` is true when an active partner venue is linked to the place, which ranks it
 * before every non-partner place, and `distanceM` is its distance from the meetup's venue.
 */
export interface CandidatePlace {
  readonly placeId: string;
  readonly name: string;
  readonly category: PlaceCategory;
  readonly cityId: string;
  readonly isPartnerVenue: boolean;
  readonly distanceM: number;
  /** The place's `opening_hours` value as OpenStreetMap stores it, or `null` when it has none. */
  readonly openingHours: string | null;
  /**
   * The rows of the place's newest capture batch per source among its approved rows inside the
   * widest freshness window, as the statement aggregated them: the first stage of `currentSet`'s
   * rule, which `estimatePlace` completes with the per-source window and the per-item dedupe
   * (AAP 0.5.7).
   */
  readonly prices: readonly PriceRow[];
}

/**
 * One ranked suggestion: a candidate that produced an estimate and is open in the meetup's window
 * (AAP 0.5.7).
 *
 * `estimateCents` mirrors `estimate.estimateCents`, because that is the figure `rankSuggestions`
 * filters and orders on, and `openingHoursToday` is the meetup day's known-open intervals in the
 * city's time, which the client renders beside the suggestion (AAP 0.5.8).
 */
export type SuggestedPlace = CandidatePlace &
  RankInput & {
    readonly estimate: PlaceEstimate;
    readonly estimateCents: number;
    readonly openingHoursToday: string | null;
  };

/**
 * What {@link suggest} returns (AAP 0.5.1): the ranked places, and why the list is empty when it is.
 *
 * `emptyReason` is present only when `items` is empty. The budget the list was ranked against is
 * added by the route, the only caller that knows the pair's stored budget (AAP 0.5.4).
 */
export interface SuggestResult {
  readonly items: SuggestedPlace[];
  readonly emptyReason?: SuggestionEmptyReason;
}

// ---------------------------------------------------------------------------------------------
// The candidate statement and its rows (AAP 0.5.2, 0.5.7, 0.11.2)
// ---------------------------------------------------------------------------------------------

/**
 * The statement's freshness prefilter: `FRESHNESS_PHONE_OPERATOR_DAYS` (60 days), the widest window
 * of any source. It bounds both what the statement scans and what it aggregates: only the rows of a
 * place's newest capture batch per source inside this window reach the API. It is still only a
 * prefilter — `estimatePlace` applies the exact per-source window (`isFresh`: 30 days online, 60 days
 * for a phone quote or an operator entry), which stays the one authoritative freshness rule.
 */
const WIDEST_FRESHNESS_DAYS = FRESHNESS_PHONE_OPERATOR_DAYS;

/**
 * One price row as the statement's `json_build_object` renders it, which is also the shape
 * {@link PriceRow} wants once the capture instant is rebuilt from its epoch milliseconds.
 *
 * A row that does not match is our own invariant violation — the statement builds these keys
 * itself — so it is rejected rather than coerced, and the message names no value.
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

/** One candidate row as the statement renders it, validated before any of it is used. */
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

/** The rows the statement is expected to return. */
type CandidateRow = z.infer<typeof CANDIDATE_ROW>;
type AggregatedPriceRow = z.infer<typeof AGGREGATED_PRICE_ROW>;

/** Raised when a row does not match the shape the statement built. */
const CANDIDATE_ROW_MISMATCH = 'suggestions: a candidate row does not match the statement shape';

/**
 * The candidate statement: every category-carrying place within the suggestion radius of the
 * meetup's venue that has at least one approved price row inside the widest freshness window, with
 * the rows of that place's newest capture batch per source aggregated into one array.
 *
 * The 2 km test is `withinMeters(geoColumn('p', 'place'), geoColumn('v', 'venue'), …)`, so the
 * GiST-indexed `place.location` stands on the left and the venue row — reduced to one by its primary
 * key — supplies the right-hand point (AAP 0.2.1). The place must also belong to the venue's own
 * city, which is what makes every row carry one city: the one whose zone the opening window and the
 * 23:00 cut-off are judged in. `opening_hours` is deliberately not filtered here: a priced place
 * with no hours, or with hours that do not parse, counts as priced but not open, which is what makes
 * `emptyReason` `none_open` rather than `no_priced_places` (AAP 0.5.7).
 *
 * The aggregate carries only what the estimate can read. Inside the widest-window prefilter one
 * capture batch is kept per source — its own newest — which is the first stage of `currentSet`'s rule
 * (AAP 0.5.7): a weekly crawl adds a batch per week, so a place accumulates captures of the same menu
 * inside the 60-day window, and only the newest of them can weigh on an estimate. A batch's recency
 * is the latest `capturedAt` of its rows, and two batches captured at the same instant are separated
 * by the larger `capture_batch_id` first, which is exactly how `latestBatchPerSource` orders them.
 *
 * Reducing any further in SQL would change the estimate. The second stage of that rule — the latest
 * record per `(itemCategory, normalizedName)` across the kept batches — is not reproducible per
 * place here, because the record it keeps for an item can come from another source while an older
 * batch of the item's own source holds it too; dropping such a row in SQL could drop the row
 * `estimatePlace` would have chosen. The batch rule has no such gap: a source has one freshness
 * window and a batch is written with one capture instant, so a batch whose rows are all stale is
 * never a source's newest fresh batch — the batch kept here is the batch `currentSet` keeps, and the
 * rows kept here are a superset of the rows that rule keeps. The per-item dedupe and the exact
 * per-source window therefore stay in `estimatePlace`, the one authoritative rule.
 *
 * `isPartnerVenue` asks whether any active partner venue is linked to the place, so the meetup's own
 * venue place — when that venue carries a `place_id` — is a candidate at 0 m that ranks first. Each
 * of the three fixture-bearing tables carries `fixturePredicate` for its own alias (AAP 0.5.2). A
 * venue, or a place, with no location is not a candidate: `ST_DWithin` is unknown for a null
 * geography, and a distance that cannot be measured does not qualify.
 *
 * @param env - The process's `APP_ENV`, which decides how strictly the fixture predicate filters.
 * @param venueId - The meetup's venue, bound as a `uuid` parameter.
 * @param now - The instant the freshness prefilter is measured at, from the caller's injected clock.
 * @returns The parameterized statement, ready for `$queryRaw`.
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
 * The candidate places of one meetup, read in a single statement (AAP 0.5.7).
 *
 * The read goes through `services.db.$queryRaw`, the surface the fixture guard leaves to its own
 * `fixturePredicate` and the one a test replaces to prove that a suggestions failure stays on this
 * route (AAP 0.3.2, 0.11.2).
 *
 * @param services - The guarded client and the environment whose fixture policy applies.
 * @param venueId - The meetup's venue, whose row also supplies the city the window is judged in.
 * @param now - The instant the freshness prefilter is measured at.
 * @returns Every candidate within 2 km that carries an approved, in-window price row, with the rows
 *   of its newest capture batch per source.
 * @throws Error when a returned row does not match the shape the statement built.
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

/** Maps one statement row to a candidate, rounding the distance to the metre the DTO reports. */
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

/** Rebuilds the capture instant of an aggregated price row from its epoch milliseconds. */
function toPriceRow(row: AggregatedPriceRow): PriceRow {
  const { capturedAtMs, ...prices } = row;
  return { ...prices, capturedAt: new Date(capturedAtMs) };
}

// ---------------------------------------------------------------------------------------------
// Opening hours (AAP 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * How many parsed `opening_hours` values one process keeps. The values are a handful per city, so
 * the cap is only a guard against a pathological sweep; reaching it clears the map.
 */
const HOURS_CACHE_LIMIT = 2000;

/** The wall time a known-open interval reaching the end of the day is written as, `24:00`. */
const MIDNIGHT_WALL_TIME = '24:00';

/** The separator between two intervals of one day. */
const INTERVAL_SEPARATOR = ', ';

/** The en dash inside one interval, as in `12:00\u201315:00` (U+2013). */
const INTERVAL_DASH = '\u2013';

/** The wall-clock format the intervals are rendered in, `HH:mm` on a 24-hour clock. */
const WALL_TIME_FORMAT = 'HH:mm';

/**
 * The parsed `opening_hours` values of one process, keyed `<cityId>|<value>`, because a place's
 * hours are a pure function of the value and of the city the window is judged in (public holidays,
 * sunrise and sunset need the city's country and coordinates).
 *
 * A value that cannot be parsed is cached as `null` too, and the map is cleared rather than evicted
 * when it fills, which costs one re-parse per value. It is a memo of immutable instances several
 * requests use read-only, which keeps the read inside the 300 ms p95 target (AAP 0.12.2).
 */
const hoursCache = new Map<string, OpeningHours | null>();

/**
 * The library value of one place's hours, or `null` when the value cannot be parsed, which is the
 * one way a place with unusable hours stays out of the suggestions (AAP 0.5.7).
 *
 * @param city - The meetup venue's city, whose coordinates and country the parse needs.
 * @param value - The place's `opening_hours` value as OpenStreetMap stores it.
 */
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

/**
 * Parses one `opening_hours` value with the city's own context, or returns `null`.
 *
 * The library reports a value it cannot parse by throwing a bare string rather than an `Error`, so
 * the catch is value-less, and `suggest` counts what it returns `null` for.
 */
function parseOpeningHours(city: CityConfig, value: string): OpeningHours | null {
  // The third constructor argument is left out on purpose: its `optional_conf` shape requires every
  // key to be present, and its `mode` default is `time_ranges` (0), which is what
  // `getOpenIntervals` needs. Passing `{ mode: 0 }` alone would not typecheck, and passing the
  // whole object would mean claiming a warnings severity and a locale this file does not mean.
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

/**
 * An instant carrying `tz`'s wall-clock fields, for handing to the library, and its inverse below.
 *
 * `opening_hours` reads a `Date`'s *local* fields, so an instant built for Lisbon would be read as
 * the process zone's fields; writing the same fields in the process zone gives it exactly the fields
 * it must read, whatever `TZ` the process runs in. A wall-clock time inside the process zone's own
 * spring-forward gap would shift by the size of that gap; the containers run UTC, which has no gap.
 */
function toCityWallClock(at: Date, tz: string): Date {
  return DateTime.fromJSDate(at, { zone: tz }).setZone('local', { keepLocalTime: true }).toJSDate();
}

/** The inverse of {@link toCityWallClock}: the instant the library's own fields denote in `tz`. */
function fromCityWallClock(at: Date, tz: string): Date {
  return DateTime.fromJSDate(at).setZone(tz, { keepLocalTime: true }).toJSDate();
}

/**
 * The known-open intervals of `oh` inside `from`–`to`, as instants in `tz`. An interval the library
 * marks `unknown` is dropped: "open, times to be confirmed" is not evidence that a place is open,
 * and only places open in the window qualify (AAP 0.5.7).
 */
function openIntervals(
  oh: OpeningHours,
  tz: string,
  from: Date,
  to: Date,
): Array<readonly [Date, Date]> {
  const intervals: Array<readonly [Date, Date]> = [];
  for (const [start, end, unknown] of oh.getOpenIntervals(
    toCityWallClock(from, tz),
    toCityWallClock(to, tz),
  )) {
    if (unknown) {
      continue;
    }
    intervals.push([fromCityWallClock(start, tz), fromCityWallClock(end, tz)]);
  }
  return intervals;
}

/**
 * Whether the place is open at some point between an hour after the meetup's start and 23:00 on the
 * meetup's city-local day (AAP 0.5.7). A meetup starting at 22:30 local leaves an empty window, and
 * an empty window is never open.
 */
function isOpenInWindow(oh: OpeningHours, tz: string, startsAt: Date): boolean {
  const from = new Date(startsAt.getTime() + SUGGESTION_OPEN_FROM_HOURS_AFTER_START * HOUR_MS);
  const to = localTimeOn(tz, localDateKey(tz, startsAt), SUGGESTION_LOCAL_CUTOFF);
  if (from.getTime() >= to.getTime()) {
    return false;
  }
  return openIntervals(oh, tz, from, to).length > 0;
}

/**
 * The meetup day's known-open intervals in city time, `12:00\u201315:00, 19:00\u201324:00`, or `null`
 * when the place is not known to be open that day at all (AAP 0.5.7). The span is the meetup's own
 * local day, and an interval reaching the end of it is written `24:00`, which is how a value such as
 * `Mo-Su 10:00-24:00` reads back.
 */
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
      const closing = end.getTime() === to.getTime() ? MIDNIGHT_WALL_TIME : wallTime(tz, end);
      return `${wallTime(tz, start)}${INTERVAL_DASH}${closing}`;
    })
    .join(INTERVAL_SEPARATOR);
}

/** One instant as `HH:mm` on a 24-hour clock in the city's own time. */
function wallTime(tz: string, at: Date): string {
  return DateTime.fromJSDate(at, { zone: tz }).toFormat(WALL_TIME_FORMAT);
}

// ---------------------------------------------------------------------------------------------
// Orchestration (AAP 0.5.1, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * The ranked day-plan suggestions of one meetup (AAP 0.5.1, 0.5.7).
 *
 * The three filters run in the order `emptyReason` reports them, and each count is kept so the
 * reason names the filter that stopped the flow: **priced** (the candidates whose rows produce an
 * estimate, freshness included), **open** (of those, the ones open between an hour after the start
 * and 23:00 local on the meetup day — parsed only for priced places, and a place with no hours or
 * unreadable hours is not open), then **fitting** (`rankSuggestions`, which applies the budget
 * filter along with the ordering and both limits).
 *
 * Nothing is written and nothing outside PostgreSQL is read, so a failure here cannot reach the
 * meetup flow; the route answers `503 suggestions_unavailable` for this route alone (AAP 0.3.2).
 *
 * @param services - The guarded client, the environment and the logger.
 * @param meetup - The meetup's venue and start, both read from its row by the route.
 * @param budgetCents - The pair's shared per-person budget in USD cents, already range-checked.
 * @param now - The instant freshness is judged at, from the caller's injected clock.
 * @returns The ranked suggestions, and the empty-state reason when there are none.
 * @throws Error when a statement row does not match its shape, or when the venue's city is not
 *   configured.
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
 * The configured city a candidate's `cityId` names (AAP 0.5.5).
 *
 * A venue row whose city the configuration does not name is a configuration error rather than a
 * data condition: without the city's zone no opening window can be judged, and reporting every such
 * place as closed would hide the fault behind `none_open`.
 *
 * @param cityId - The city slug the venue row carries.
 * @returns The configured city.
 * @throws Error when no configured city carries that slug. The message names no configured value.
 */
function cityOf(cityId: string): CityConfig {
  const city = cityBySlug(cityId);
  if (city === undefined) {
    throw new Error('suggestions: the meetup venue is in a city the configuration does not name');
  }
  return city;
}
