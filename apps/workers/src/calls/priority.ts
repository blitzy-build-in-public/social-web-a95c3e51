/**
 * The call-and-menu priority rule (AAP 0.5.7): the order `menu-ingest`, `place-refresh` and
 * `price-freshness` queue their work in, and the order `call-dispatch` takes the next call task in.
 *
 * The rule has two signals. Primarily a place's distance to the nearest active partner venue, in
 * bands of 250 m, 500 m, 1 km and 2 km, nearest first. Secondarily, inside one band, a place within
 * 2 km of a venue that holds a locked meetup in the next 3 days comes first. A place near no partner
 * venue at all — the lodging-only places ingestion also pulls in — follows every venue-near place,
 * whatever its meetups (AAP 0.5.7).
 *
 * Two shapes of consumer are served, because BullMQ and SQL order in opposite directions:
 *
 * - {@link menuPriority} is the 1-10 number `menu-ingest` puts on the BullMQ job it enqueues and
 *   stores on the `menu_prices` `CallTask` it creates. BullMQ runs a LOWER number first, and a job
 *   enqueued with no priority runs before every prioritized job, so every job gets a number.
 * - {@link callTaskOrderSql} is the `ORDER BY` fragment `call-dispatch` orders its candidate query
 *   by, and {@link placePriorities} answers the same question for a batch of place ids in one query.
 *
 * `place.nearest_partner_distance_m` is the distance to the nearest active partner venue of the
 * place's own city — `refreshNearestPartnerDistances` in `@tablemate/db` computes it over the
 * `venue` table alone — and is NULL when the place carries no location or its city has no active
 * partner venue. Partner lodgings are not part of that measurement, so a place that is near only a
 * lodging already falls in band 4 through this column and needs no second distance; the
 * `lodgingOnly` flag of {@link menuPriority} is for a caller that knows the place is lodging-only
 * from another source (AAP 0.5.6, 0.5.7).
 *
 * Every read of `venue` or `place` here carries the fixture predicate for its own alias, so a
 * fixture row is invisible outside `test` and `demo` (AAP 0.5.2). `now` is always a parameter: this
 * module never reads the clock, so the test clock can move it (AAP 0.11.1). The only text that
 * reaches a statement unparameterized is a checked identifier, a fixed keyword or a code-constant
 * enum literal, and every value that varies per call is bound (AAP 0.11.2).
 *
 * @see AAP 0.5.7 for the priority rule, 0.5.6 for the jobs that consume it, 0.5.3 for the call-task
 *   lifecycle it feeds, 0.5.2 for the fixture environments, and 0.8.1 for this file.
 */

import type { AppEnv } from '@tablemate/shared';

import {
  fixturePredicate,
  geoColumn,
  Prisma,
  SQL_IDENTIFIER,
  withinMeters,
  type RawSqlClient,
} from '@tablemate/db';

// ---------------------------------------------------------------------------------------------
// The rule's constants
// ---------------------------------------------------------------------------------------------

/** The radius in metres within which a place counts as near a meetup venue (AAP 0.5.7). */
const NEAR_RADIUS_M = 2000;

/**
 * The inclusive upper edge of each distance band, nearest first (AAP 0.5.7): a place at or under the
 * first edge is band 0, one at or under the second is band 1, and one at or under the last is band
 * 3. Written once and read by both the TypeScript band and the SQL `CASE`, so the two cannot drift
 * apart.
 */
const PRIORITY_BANDS_M = [250, 500, 1000, NEAR_RADIUS_M] as const;

/**
 * The band of a place that is near no partner venue — a NULL or farther-than-{@link NEAR_RADIUS_M}
 * distance, which is also every lodging-only place (AAP 0.5.7). Taken from the edge list, so adding
 * a band moves it.
 */
const NOT_NEAR_BAND = PRIORITY_BANDS_M.length;

/** Days ahead a locked meetup lifts its neighbourhood inside its band (AAP 0.5.7). */
const LOCKED_MEETUP_HORIZON_DAYS = 3;

/** The alias {@link placePriorities} gives the table it reads (AAP 0.5.7). */
const PLACE_ALIAS = 'p';

/**
 * A double-quoted SQL alias, checked against {@link SQL_IDENTIFIER} first (AAP 0.11.2).
 *
 * An alias is the only caller-supplied text this module writes into a statement, and a caller passes
 * the alias of its own query, so an alias that is not a plain lower-case identifier is refused
 * rather than quoted and sent.
 *
 * @param alias - The bare alias the caller's statement gives the table.
 * @returns The alias with its double quotes.
 * @throws RangeError when `alias` does not match {@link SQL_IDENTIFIER}.
 */
function quoteAlias(alias: string): Prisma.Sql {
  if (!SQL_IDENTIFIER.test(alias)) {
    throw new RangeError(`Unsafe SQL alias: ${alias}`);
  }
  return Prisma.raw(`"${alias}"`);
}

// ---------------------------------------------------------------------------------------------
// The rule in TypeScript
// ---------------------------------------------------------------------------------------------

/**
 * The distance band a place falls in, nearest first (AAP 0.5.7): 0 up to 250 m, 1 up to 500 m, 2 up
 * to 1 km, 3 up to 2 km, and 4 beyond that.
 *
 * Band edges are inclusive. A `null` distance — what `nearest_partner_distance_m` holds when the
 * place has no location or its city has no active partner venue — is band 4, the band of a place
 * near no partner venue at all, which is where the lodging-only places sit (AAP 0.5.7). A non-finite
 * distance is band 4 as well: the column never holds one, a distance that cannot be measured is not
 * a place near a partner venue, and this way one malformed row defers its own work instead of
 * failing the whole batch the caller is prioritizing.
 *
 * @param m - The distance in metres to the nearest active partner venue, or `null`.
 * @returns The band, 0 through 4.
 */
export function distanceBand(m: number | null): 0 | 1 | 2 | 3 | 4 {
  if (m === null || !Number.isFinite(m) || m > NEAR_RADIUS_M) {
    return NOT_NEAR_BAND;
  }
  if (m <= PRIORITY_BANDS_M[0]) {
    return 0;
  }
  if (m <= PRIORITY_BANDS_M[1]) {
    return 1;
  }
  if (m <= PRIORITY_BANDS_M[2]) {
    return 2;
  }
  return 3;
}

/**
 * The priority a place carries: 1 to 10, and in BullMQ a LOWER number runs first (AAP 0.5.7).
 *
 * The band contributes two steps, which leaves the secondary signal its tie-break inside one band:
 * `1 + 2 × band + (nearLockedMeetup ? 0 : 1)`. Band 0 next to a venue that holds a locked meetup is
 * therefore 1, and band 4 without one is 10. A `lodgingOnly` place takes band 4 whatever its
 * distance column says, so it follows every venue-near place, locked meetup or not.
 *
 * BullMQ runs a job enqueued WITHOUT a priority before every prioritized job, so `menu-ingest` must
 * set this on every job it adds; the same value is stored on the `menu_prices` `CallTask` it creates
 * (AAP 0.5.6). `call-dispatch` does not read that stored column: {@link callTaskOrderSql} computes
 * the band from the joined place, because a held meetup can appear after the task was created.
 *
 * @param input - The place's distance to its nearest active partner venue, whether a locked meetup
 *   falls within {@link LOCKED_MEETUP_HORIZON_DAYS} days within {@link NEAR_RADIUS_M} of it, and
 *   whether the caller knows it is near a partner lodging only (AAP 0.5.6).
 * @returns The BullMQ priority, 1 through 10.
 */
export function menuPriority(input: {
  nearestPartnerDistanceM: number | null;
  nearLockedMeetup: boolean;
  lodgingOnly: boolean;
}): number {
  const band = input.lodgingOnly ? NOT_NEAR_BAND : distanceBand(input.nearestPartnerDistanceM);
  return 1 + 2 * band + (input.nearLockedMeetup ? 0 : 1);
}

// ---------------------------------------------------------------------------------------------
// The rule in SQL
// ---------------------------------------------------------------------------------------------

/**
 * The distance band as an SQL `CASE` over the place's distance column, with the same edges and the
 * same ordinals as {@link distanceBand} (AAP 0.5.7), so the two forms cannot disagree.
 *
 * @param place - The checked, double-quoted alias of the joined `place` table.
 * @returns The `CASE` expression, ascending in "nearest first".
 */
function bandCaseSql(place: Prisma.Sql): Prisma.Sql {
  const distance = Prisma.sql`${place}."nearest_partner_distance_m"`;
  return Prisma.sql`CASE
        WHEN ${distance} IS NULL OR ${distance} > ${NEAR_RADIUS_M}::int THEN ${NOT_NEAR_BAND}::int
        WHEN ${distance} <= ${PRIORITY_BANDS_M[0]}::int THEN 0
        WHEN ${distance} <= ${PRIORITY_BANDS_M[1]}::int THEN 1
        WHEN ${distance} <= ${PRIORITY_BANDS_M[2]}::int THEN 2
        ELSE 3
      END`;
}

/**
 * The rule's secondary signal as a boolean SQL predicate: does `placeAlias`'s place stand within
 * {@link NEAR_RADIUS_M} of a venue that holds a locked meetup starting in the next
 * {@link LOCKED_MEETUP_HORIZON_DAYS} days (AAP 0.5.7)?
 *
 * The predicate is `EXISTS` over `meetup` joined to `venue`, so it answers true or false and never
 * NULL — a place with no location, or a place-less call task whose joined place is NULL, is simply
 * false. A meetup's status literal is the `MeetupStatus` member its `status` column holds
 * (`packages/shared/src/enums.ts`, AAP 0.5.2), and the venue side carries its own fixture predicate,
 * so a locked meetup at a fixture venue does not lift its neighbourhood outside `test` and `demo`
 * (AAP 0.5.2). `now` and the band edges are bound parameters.
 *
 * Use it in a statement that has the place table in scope under `placeAlias` — in a `SELECT` list
 * (`... AS "near_locked"`), a `WHERE`, or an `ORDER BY`, as {@link placePriorities} and
 * {@link callTaskOrderSql} do.
 *
 * @param placeAlias - The alias the caller's statement gives the `place` table; checked by
 *   {@link geoColumn}, which throws RangeError when it is not a plain lower-case identifier.
 * @param now - The current instant, passed in so the test clock can move it (AAP 0.11.1).
 * @param appEnv - The process's `APP_ENV`, which decides whether fixture venues are visible
 *   (AAP 0.5.2).
 * @returns The `EXISTS` predicate, bound to `placeAlias`'s place.
 * @throws RangeError when `placeAlias` does not match `SQL_IDENTIFIER`.
 */
export function nearLockedMeetupSql(placeAlias: string, now: Date, appEnv: AppEnv): Prisma.Sql {
  return Prisma.sql`EXISTS (
        SELECT 1
          FROM "meetup" AS "m"
          JOIN "venue" AS "v" ON "v"."id" = "m"."venue_id"
         WHERE "m"."status" = 'locked'
           AND "m"."starts_at" >= ${now}::timestamptz
           AND "m"."starts_at" <=
               ${now}::timestamptz + ${LOCKED_MEETUP_HORIZON_DAYS}::int * interval '1 day'
           AND ${withinMeters(geoColumn('v', 'venue'), geoColumn(placeAlias, 'place'), NEAR_RADIUS_M)}
           AND ${fixturePredicate(appEnv, 'v')}
      )`;
}

/**
 * The `ORDER BY` fragment `call-dispatch` takes its call tasks in, keywords included (AAP 0.5.6,
 * 0.5.7).
 *
 * The caller's candidate query must LEFT JOIN the place of a price task, spelled exactly
 * `LEFT JOIN "place" AS <placeAlias> ON <placeAlias>."id" = <taskAlias>."place_id"`, and must AND in
 * the NULL-safe predicate `(<placeAlias>."id" IS NULL OR fixturePredicate(appEnv, placeAlias))` in
 * its `WHERE` — for the place alias `p`, `("p"."id" IS NULL OR "p"."is_fixture" = false)`.
 *
 * A bare `fixturePredicate(appEnv, placeAlias)` is the wrong requirement there: a
 * `lodging_stay_verification` task holds no `place_id` at all (`call_task` carries exactly one of
 * place or lodging, AAP 0.5.2), so the LEFT JOIN fills that row's place columns with NULL and the
 * bare predicate, which outside `test` and `demo` is `"p"."is_fixture" = false`, evaluates to NULL
 * rather than true for that row; `WHERE` keeps only what a predicate accepts, so the row is
 * discarded. That lost row is the very task ordering key 1 below exists to put ahead of price
 * collection, and no later key can reach a row the candidate query has already dropped. The guard
 * still belongs in the `WHERE`, because the join is a raw read of `place`, which the Prisma fixture
 * guard cannot filter (AAP 0.5.2). `call_task` itself carries no `is_fixture`.
 *
 * The keys, in order (AAP 0.5.7):
 *
 * 1. A `lodging_stay_verification` task first, which is a gap in the plan's rule, filled here. That
 *    rule orders places only, and such a task has no place: it holds a waiting user whose claim
 *    expires 72 hours after creation, so it goes ahead of price collection (AAP 0.5.3).
 * 2. The distance band as {@link bandCaseSql}, over the joined place; a place-less or unlocated row
 *    is band 4, as in {@link distanceBand}.
 * 3. A place with a near locked meetup before one without it, inside its band
 *    ({@link nearLockedMeetupSql}, true first).
 * 4. `next_attempt_at` ascending, so a deferred task that is due now is not overtaken by one due
 *    later.
 * 5. `id` ascending, so the order is total and a query's result does not depend on the plan.
 *
 * Bands, the horizon and `now` are bound parameters; the two aliases are checked by
 * {@link quoteAlias} and, for the place, by {@link geoColumn} as well.
 *
 * @param taskAlias - The alias the caller's statement gives `call_task`.
 * @param placeAlias - The alias the caller's statement gives the LEFT JOINed `place`.
 * @param now - The current instant, passed in so the test clock can move it (AAP 0.11.1).
 * @param appEnv - The process's `APP_ENV`, which decides whether fixture venues are visible
 *   (AAP 0.5.2).
 * @returns The `ORDER BY` fragment.
 * @throws RangeError when either alias does not match `SQL_IDENTIFIER`.
 */
export function callTaskOrderSql(
  taskAlias: string,
  placeAlias: string,
  now: Date,
  appEnv: AppEnv,
): Prisma.Sql {
  const task = quoteAlias(taskAlias);
  const place = quoteAlias(placeAlias);

  return Prisma.sql`ORDER BY (${task}."kind" = 'lodging_stay_verification') DESC,
      ${bandCaseSql(place)} ASC,
      ${nearLockedMeetupSql(placeAlias, now, appEnv)} DESC,
      ${task}."next_attempt_at" ASC,
      ${task}."id" ASC`;
}

/**
 * The {@link menuPriority} of several places in one query, keyed by place id (AAP 0.5.6, 0.5.7).
 *
 * `menu-ingest`, `place-refresh` and `price-freshness` call it to label the jobs they enqueue. Ids
 * are deduplicated, and an empty list answers an empty map without querying. The read is over
 * `"place" AS "p"` with {@link fixturePredicate} for that alias and the ids bound as one
 * `uuid[]` parameter, so a fixture place is absent outside `test` and `demo` (AAP 0.5.2).
 *
 * A requested id the map does not hold is one the guarded read did not return. Such a place must not
 * be enqueued unprioritized — BullMQ would then run its job before every prioritized job — so the
 * caller skips it or gives it {@link menuPriority} with band 4 by hand.
 *
 * @param sql - The guarded client or a transaction's client (AAP 0.5.2).
 * @param placeIds - The place ids to rank; duplicates are ignored.
 * @param now - The current instant, passed in so the test clock can move it (AAP 0.11.1).
 * @param appEnv - The process's `APP_ENV`, which decides whether fixture rows are visible
 *   (AAP 0.5.2).
 * @returns A map from place id to its BullMQ priority, holding only the places found.
 */
export async function placePriorities(
  sql: RawSqlClient,
  placeIds: readonly string[],
  now: Date,
  appEnv: AppEnv,
): Promise<Map<string, number>> {
  const priorities = new Map<string, number>();
  const wanted = [...new Set(placeIds)];

  if (wanted.length === 0) {
    return priorities;
  }

  const place = quoteAlias(PLACE_ALIAS);

  const rows = await sql.$queryRaw<
    { id: string; nearest_partner_distance_m: number | null; near_locked: boolean }[]
  >`SELECT ${place}."id"::text AS "id",
           ${place}."nearest_partner_distance_m" AS "nearest_partner_distance_m",
           ${nearLockedMeetupSql(PLACE_ALIAS, now, appEnv)} AS "near_locked"
      FROM "place" AS ${place}
     WHERE ${place}."id" = ANY(${wanted}::uuid[])
       AND ${fixturePredicate(appEnv, PLACE_ALIAS)}`;

  for (const row of rows) {
    const distance = row.nearest_partner_distance_m;
    priorities.set(
      row.id,
      menuPriority({
        nearestPartnerDistanceM: distance,
        nearLockedMeetup: row.near_locked,
        lodgingOnly: distanceBand(distance) === NOT_NEAR_BAND,
      }),
    );
  }

  return priorities;
}
