/**
 * The PostGIS geography helpers: the only place in this codebase that builds SQL against a
 * `geography(Point,4326)` column (AAP 0.2.1, 0.5.7, 0.8.1).
 *
 * Four such columns exist — `venue.location`, `place.location`, `lodging.location` and
 * `city.centroid` — and Prisma cannot write them, because each is an optional
 * `Unsupported("geography(Point,4326)")` field. Application code therefore creates or upserts the
 * row with Prisma and calls {@link setPoint} in the same transaction. Reads go through
 * {@link readPoints}, the check-in geofence through {@link distanceFrom} (150 m, AAP 0.5.7), the
 * 2 km suggestion radius through {@link withinMeters}, and the call-and-menu priority bands through
 * {@link refreshNearestPartnerDistances}. Distances are metres on geography, which measures on the
 * spheroid by default, so a distance is never computed over `geometry` (AAP 0.2.1).
 *
 * Every statement is a tagged template over `Prisma.sql`, every identifier comes from
 * {@link GEO_COLUMNS} or {@link GEO_ALIASES} and is checked against `SQL_IDENTIFIER` before it is
 * written, and every value is a bound parameter with an explicit cast (AAP 0.11.2). Check-in
 * coordinates are bound parameters only: no user coordinate is ever stored or logged (AAP 0.5.2).
 *
 * Deviation from the folder brief, recorded in TSDoc as the brief requires: the read helpers take
 * the process's `appEnv` and build their fixture predicate themselves, rather than taking a
 * caller-built guard fragment. {@link refreshNearestPartnerDistances} reads two guarded tables at
 * once (`place` and `venue`), which one caller-built fragment cannot cover, and building the
 * predicate here from {@link GEO_ALIASES} rules out an alias mismatch.
 */

import type { AppEnv, LatLng } from '@tablemate/shared';

import { Prisma, type RawSqlClient } from './client.ts';
import { fixturePredicate, SQL_IDENTIFIER } from './fixtures-guard.ts';

// ---------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------

/**
 * The geography column of each table that carries one, GiST-indexed in the init migration
 * (AAP 0.2.1, 0.5.2). Table and column identifiers reach a query only from this map.
 */
export const GEO_COLUMNS = {
  venue: 'location',
  place: 'location',
  lodging: 'location',
  city: 'centroid',
} as const;

/** A table carrying a geography column (AAP 0.2.1). */
export type GeoTable = keyof typeof GEO_COLUMNS;

/**
 * The alias each helper below gives its table, so a statement that reads two geography tables can
 * qualify every column. Callers composing their own SQL use the same aliases (AAP 0.5.7).
 */
export const GEO_ALIASES = { venue: 'v', place: 'p', lodging: 'l', city: 'c' } as const;

/** The tables carrying `is_fixture`; `city` does not, so no fixture predicate applies to it (AAP 0.5.2). */
const FIXTURE_TABLES: ReadonlySet<GeoTable> = new Set(['venue', 'place', 'lodging']);

/**
 * A double-quoted SQL identifier, checked against `SQL_IDENTIFIER` first.
 *
 * Table names, aliases and column names are the only text that reaches a statement unparameterized,
 * so every one of them passes through here (AAP 0.11.2).
 *
 * @param name - The bare identifier, taken from {@link GEO_COLUMNS} or {@link GEO_ALIASES}.
 * @returns The identifier with its double quotes.
 * @throws RangeError when `name` is not a plain lower-case SQL identifier.
 */
function quote(name: string): string {
  if (!SQL_IDENTIFIER.test(name)) {
    throw new RangeError(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

/**
 * The geography column of `table`.
 *
 * @param table - The table whose column is wanted.
 * @returns The bare column name, `location` or `centroid`.
 * @throws RangeError when `table` is not a key of {@link GEO_COLUMNS}, which is what keeps a name
 *   that did not come from the map out of the SQL text.
 */
function geoColumnName(table: GeoTable): string {
  const columnName: string | undefined = GEO_COLUMNS[table];
  if (columnName === undefined) {
    throw new RangeError(`Unknown geography table: ${String(table)}`);
  }
  return columnName;
}

/** The alias of `table`; a key outside {@link GEO_ALIASES} throws. */
function geoAlias(table: GeoTable): string {
  const alias: string | undefined = GEO_ALIASES[table];
  if (alias === undefined) {
    throw new RangeError(`Unknown geography table: ${String(table)}`);
  }
  return alias;
}

/** The quoted identifiers one helper builds its statement from, all drawn from the two maps. */
interface GeoRefs {
  /** The table, `"place"`. */
  readonly table: Prisma.Sql;
  /** The table's alias, `"p"`. */
  readonly alias: Prisma.Sql;
  /** The geography column qualified by the alias, `"p"."location"`. */
  readonly column: Prisma.Sql;
  /** The bare geography column name, for a statement that may not qualify it. */
  readonly columnName: string;
}

/** Builds {@link GeoRefs} for `table`, refusing a key that is not in both maps. */
function geoRefs(table: GeoTable): GeoRefs {
  const columnName = geoColumnName(table);
  const alias = quote(geoAlias(table));
  return {
    table: Prisma.raw(quote(table)),
    alias: Prisma.raw(alias),
    column: Prisma.raw(`${alias}.${quote(columnName)}`),
    columnName,
  };
}

/** The fixture predicate for `table`, or `TRUE` for `city`, which carries no `is_fixture` (AAP 0.5.2). */
function geoGuard(table: GeoTable, appEnv: AppEnv): Prisma.Sql {
  return FIXTURE_TABLES.has(table) ? fixturePredicate(appEnv, geoAlias(table)) : Prisma.sql`TRUE`;
}

/**
 * The single-row id comparison: `city.id` is a text slug, every other id is a uuid (AAP 0.5.2).
 * The column is left unqualified, which resolves against the alias in force either way.
 */
function idEquals(table: GeoTable, id: string): Prisma.Sql {
  return table === 'city' ? Prisma.sql`"id" = ${id}` : Prisma.sql`"id" = ${id}::uuid`;
}

/** The id list of a multi-row read, cast to the id column's own type (AAP 0.5.2). */
function idList(table: GeoTable, ids: readonly string[]): Prisma.Sql {
  return table === 'city' ? Prisma.sql`${ids}::text[]` : Prisma.sql`${ids}::uuid[]`;
}

// ---------------------------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------------------------

/**
 * A point as a `geography` value: `ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography`.
 *
 * Longitude comes first, the order `ST_MakePoint` takes.
 *
 * @param point - The WGS 84 coordinate pair to bind. Its values are parameters, never SQL text.
 * @returns The fragment binding both coordinates with an explicit cast.
 * @throws RangeError when either value is not finite or falls outside the WGS 84 range.
 * @see AAP 0.5.2 for check-in coordinates, which are never stored or logged.
 */
export function geoPoint(point: LatLng): Prisma.Sql {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    throw new RangeError('geoPoint requires finite lat and lng');
  }
  if (point.lat < -90 || point.lat > 90) {
    throw new RangeError('geoPoint requires lat within [-90, 90]');
  }
  if (point.lng < -180 || point.lng > 180) {
    throw new RangeError('geoPoint requires lng within [-180, 180]');
  }
  return Prisma.sql`ST_SetSRID(ST_MakePoint(${point.lng}::double precision, ${point.lat}::double precision), 4326)::geography`;
}

/**
 * The geography column of `table` as the alias qualifies it, for a caller composing its own SQL:
 * `geoColumn('p', 'place')` is `"p"."location"`.
 *
 * @param alias - The alias the caller gave that table, checked against `SQL_IDENTIFIER`.
 * @param table - The table whose geography column is wanted.
 * @returns The qualified column identifier.
 * @throws RangeError when `alias` is not a plain lower-case SQL identifier, or `table` has no
 *   geography column.
 * @see AAP 0.5.7 for the 150 m and 2 km tests a caller composes with this and {@link withinMeters}.
 */
export function geoColumn(alias: string, table: GeoTable): Prisma.Sql {
  return Prisma.raw(`${quote(alias)}.${quote(geoColumnName(table))}`);
}

/**
 * The 2 km suggestion radius and the 150 m check-in geofence, as a bound `ST_DWithin` test
 * (AAP 0.5.7).
 *
 * Put the GiST-indexed column first, as in
 * `withinMeters(geoColumn('p', 'place'), geoColumn('v', 'venue'), 2000)`, so the index is used.
 *
 * @param a - The fragment on the left, normally the indexed column.
 * @param b - The fragment on the right, normally {@link geoPoint}.
 * @param meters - The radius in metres.
 * @returns The `ST_DWithin` predicate.
 * @throws RangeError when `meters` is not finite or is negative.
 */
export function withinMeters(a: Prisma.Sql, b: Prisma.Sql, meters: number): Prisma.Sql {
  if (!Number.isFinite(meters) || meters < 0) {
    throw new RangeError('withinMeters requires a finite distance of 0 metres or more');
  }
  return Prisma.sql`ST_DWithin(${a}, ${b}, ${meters}::double precision)`;
}

/**
 * The distance in metres between two geography fragments, measured on the spheroid.
 *
 * The caller decides what the measurement means; the check-in route compares it with 150 m and
 * derives its distance bucket from it (AAP 0.5.7).
 *
 * @param a - The fragment on the left.
 * @param b - The fragment on the right.
 * @returns The `ST_Distance` expression.
 */
export function distanceMeters(a: Prisma.Sql, b: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`ST_Distance(${a}, ${b})`;
}

/**
 * The `lat` and `lng` select items of a geography column, in the order the DTOs carry them:
 * `ST_Y(column::geometry) AS "lat", ST_X(column::geometry) AS "lng"`.
 *
 * The cast serves the accessors only; distances are never computed over `geometry` (AAP 0.2.1).
 *
 * @param column - The geography column, normally from {@link geoColumn}.
 * @returns The two aliased select items.
 */
export function latLngColumns(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`ST_Y(${column}::geometry) AS "lat", ST_X(${column}::geometry) AS "lng"`;
}

// ---------------------------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------------------------

/**
 * Writes a row's geography column, the only way it can be set, since Prisma cannot write an
 * `Unsupported` field.
 *
 * Runs inside the caller's transaction, immediately after the Prisma `create`/`upsert` that made
 * the row, so that `api` onboarding, the seed and the workers' place and lodging upserts each
 * write the location and the row atomically. It writes by id and therefore applies no fixture
 * predicate, and it leaves `updated_at` alone, which the caller's Prisma write already set.
 *
 * @param db - The guarded client or the transaction's client.
 * @param table - The table holding the row.
 * @param id - The row's id: a uuid, or the `city` slug.
 * @param point - The coordinates to store, checked by {@link geoPoint}.
 * @returns Nothing.
 * @throws RangeError when `point` is not a valid WGS 84 pair.
 * @throws Error when no row matches, which means the caller wrote the location of a row that is
 *   not there. The message names the table, never the coordinates.
 * @see AAP 0.5.2 for the geography columns Prisma cannot write, and 0.3.2 for the seed and the
 *   place refresh that call this.
 */
export async function setPoint(
  db: RawSqlClient,
  table: GeoTable,
  id: string,
  point: LatLng,
): Promise<void> {
  const refs = geoRefs(table);
  const updated = await db.$executeRaw`
    UPDATE ${refs.table}
       SET ${Prisma.raw(quote(refs.columnName))} = ${geoPoint(point)}
     WHERE ${idEquals(table, id)}
  `;

  if (updated === 0) {
    throw new Error(`setPoint matched no row in "${table}"`);
  }
}

/**
 * Reads the coordinates of several rows at once — `VenueDto.lat`/`lng`, `LodgingDetail.lat`/`lng`
 * and the admin DTOs — as a map keyed by id.
 *
 * Ids are deduplicated, and an empty list returns an empty map without querying. A row whose
 * location is NULL, or which the fixture guard filters out, is absent from the map rather than
 * present with a null coordinate: outside `test` and `demo` a fixture row is invisible (AAP 0.5.2).
 *
 * The helper takes `appEnv` and builds its own fixture predicate from {@link GEO_ALIASES} instead
 * of taking a caller-built guard fragment — the deviation noted in the module docblock.
 *
 * @param db - The guarded client or the transaction's client.
 * @param table - The table holding the rows.
 * @param ids - The ids to read; a uuid list, or `city` slugs.
 * @param appEnv - The process's `APP_ENV`, which decides whether fixture rows are visible.
 * @returns A map from id to coordinates, holding only the rows found.
 */
export async function readPoints(
  db: RawSqlClient,
  table: GeoTable,
  ids: readonly string[],
  appEnv: AppEnv,
): Promise<Map<string, LatLng>> {
  const points = new Map<string, LatLng>();
  const wanted = [...new Set(ids)];

  if (wanted.length === 0) {
    return points;
  }

  const refs = geoRefs(table);
  const rows = await db.$queryRaw<{ id: string; lat: number; lng: number }[]>`
    SELECT ${refs.alias}."id"::text AS "id", ${latLngColumns(refs.column)}
      FROM ${refs.table} AS ${refs.alias}
     WHERE ${refs.alias}."id" = ANY(${idList(table, wanted)})
       AND ${refs.column} IS NOT NULL
       AND ${geoGuard(table, appEnv)}
  `;

  for (const row of rows) {
    points.set(row.id, { lat: row.lat, lng: row.lng });
  }

  return points;
}

/**
 * The distance in metres from a row's own geography column to a supplied point, or `null` when the
 * row is missing, the fixture guard filters it out, or it carries no location.
 *
 * The check-in route is the caller: it compares the result with the 150 m geofence and derives the
 * `lt_50` or `m50_150` bucket from it (AAP 0.5.7). The point is a bound parameter of the statement
 * and nothing else — no coordinate is stored, and none is logged (AAP 0.5.2).
 *
 * @param db - The guarded client or the transaction's client.
 * @param table - The table holding the row to measure from.
 * @param id - The row's id: a uuid, or the `city` slug.
 * @param point - The point to measure to, checked by {@link geoPoint}.
 * @param appEnv - The process's `APP_ENV`, which decides whether fixture rows are visible.
 * @returns The distance in metres, or `null` when there is nothing to measure.
 * @throws RangeError when `point` is not a valid WGS 84 pair.
 */
export async function distanceFrom(
  db: RawSqlClient,
  table: GeoTable,
  id: string,
  point: LatLng,
  appEnv: AppEnv,
): Promise<number | null> {
  const refs = geoRefs(table);
  const rows = await db.$queryRaw<{ meters: number | null }[]>`
    SELECT ${distanceMeters(refs.column, geoPoint(point))} AS "meters"
      FROM ${refs.table} AS ${refs.alias}
     WHERE ${idEquals(table, id)}
       AND ${geoGuard(table, appEnv)}
  `;

  const row = rows[0];
  return row === undefined || row.meters === null ? null : Number(row.meters);
}

/**
 * Recomputes `place.nearest_partner_distance_m` for one city: the rounded metric distance from each
 * place to the nearest active partner venue of its own city.
 *
 * The column is NULL when the place has no location or the city has no active partner venue, and the
 * value feeds the call-and-menu priority bands — 250 m, 500 m, 1 km and 2 km — that order
 * `menu-ingest` and `call-dispatch` (AAP 0.5.7).
 *
 * The seed calls it after loading a city's fixtures, and `place-refresh` after each refresh or venue
 * change. Both tables it reads carry `is_fixture`, so it ANDs in the predicate for each, which is
 * why it takes `appEnv` rather than a single caller-built fragment (the deviation in the module
 * docblock).
 *
 * @param db - The guarded client or the transaction's client.
 * @param cityId - The city slug whose places are recomputed.
 * @param appEnv - The process's `APP_ENV`, which decides whether fixture rows are visible.
 * @returns The number of place rows the statement updated.
 */
export async function refreshNearestPartnerDistances(
  db: RawSqlClient,
  cityId: string,
  appEnv: AppEnv,
): Promise<number> {
  return db.$executeRaw`
    UPDATE "place" AS "p"
       SET "nearest_partner_distance_m" = (
             SELECT ROUND(MIN(ST_Distance("p"."location", "v"."location")))::int
               FROM "venue" AS "v"
              WHERE "v"."city_id" = "p"."city_id"
                AND "v"."is_active_partner"
                AND "v"."location" IS NOT NULL
                AND ${fixturePredicate(appEnv, 'v')}
           )
     WHERE "p"."city_id" = ${cityId}
       AND ${fixturePredicate(appEnv, 'p')}
  `;
}
