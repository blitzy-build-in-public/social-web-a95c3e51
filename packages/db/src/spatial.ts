import type { AppEnv, LatLng } from '@tablemate/shared';

import { Prisma, type RawSqlClient } from './client.ts';
import { fixturePredicate, SQL_IDENTIFIER } from './fixtures-guard.ts';
/** The geography column of each table that carries one, GiST-indexed in the init migration. */
export const GEO_COLUMNS = {
  venue: 'location',
  place: 'location',
  lodging: 'location',
  city: 'centroid',
} as const;
/** A table carrying a geography column. */
export type GeoTable = keyof typeof GEO_COLUMNS;
/** The alias each helper below gives its table, so a statement that reads two geography tables can qualify every column. */
export const GEO_ALIASES = { venue: 'v', place: 'p', lodging: 'l', city: 'c' } as const;
const FIXTURE_TABLES: ReadonlySet<GeoTable> = new Set(['venue', 'place', 'lodging']);
function quote(name: string): string {
  if (!SQL_IDENTIFIER.test(name)) {
    throw new RangeError(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}
function geoColumnName(table: GeoTable): string {
  const columnName: string | undefined = GEO_COLUMNS[table];
  if (columnName === undefined) {
    throw new RangeError(`Unknown geography table: ${String(table)}`);
  }
  return columnName;
}
function geoAlias(table: GeoTable): string {
  const alias: string | undefined = GEO_ALIASES[table];
  if (alias === undefined) {
    throw new RangeError(`Unknown geography table: ${String(table)}`);
  }
  return alias;
}
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
function geoGuard(table: GeoTable, appEnv: AppEnv): Prisma.Sql {
  return FIXTURE_TABLES.has(table) ? fixturePredicate(appEnv, geoAlias(table)) : Prisma.sql`TRUE`;
}
function idEquals(table: GeoTable, id: string): Prisma.Sql {
  return table === 'city' ? Prisma.sql`"id" = ${id}` : Prisma.sql`"id" = ${id}::uuid`;
}
function idList(table: GeoTable, ids: readonly string[]): Prisma.Sql {
  return table === 'city' ? Prisma.sql`${ids}::text[]` : Prisma.sql`${ids}::uuid[]`;
}
/** A point as a `geography` value: `ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography`. */
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
/** The geography column of `table` as the alias qualifies it, for a caller composing its own SQL: `geoColumn('p', 'place')` is `"p"."location"`. */
export function geoColumn(alias: string, table: GeoTable): Prisma.Sql {
  return Prisma.raw(`${quote(alias)}.${quote(geoColumnName(table))}`);
}
/** The 2 km suggestion radius and the 150 m check-in geofence, as a bound `ST_DWithin` test. */
export function withinMeters(a: Prisma.Sql, b: Prisma.Sql, meters: number): Prisma.Sql {
  if (!Number.isFinite(meters) || meters < 0) {
    throw new RangeError('withinMeters requires a finite distance of 0 metres or more');
  }
  return Prisma.sql`ST_DWithin(${a}, ${b}, ${meters}::double precision)`;
}
/** The distance in metres between two geography fragments, measured on the spheroid. */
export function distanceMeters(a: Prisma.Sql, b: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`ST_Distance(${a}, ${b})`;
}
/** The `lat` and `lng` select items of a geography column, in the order the DTOs carry them. */
export function latLngColumns(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`ST_Y(${column}::geometry) AS "lat", ST_X(${column}::geometry) AS "lng"`;
}
/** Writes a row's geography column, the only way it can be set, since Prisma cannot write an `Unsupported` field. */
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
/** Reads the coordinates of several rows at once — `VenueDto.lat`/`lng`, `LodgingDetail.lat`/`lng` and the admin DTOs — as a map keyed by id. */
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
/** The distance in metres from a row's own geography column to a supplied point, or `null` when the row is missing, the fixture guard filters it out, or it carries no location. */
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
/** Recomputes `place.nearest_partner_distance_m` for one city: the rounded metric distance from each place to the nearest active partner venue of its own city. */
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
