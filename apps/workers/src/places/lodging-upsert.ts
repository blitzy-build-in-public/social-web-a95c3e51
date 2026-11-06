/**
 * The OpenStreetMap lodging upsert behind the weekly place refresh (AAP 0.5.6). `./overpass.ts`
 * fetches the `tourism=hostel|hotel|guest_house` elements inside a city's bbox; this module turns
 * them into `Lodging` rows keyed by (`osmType`, `osmId`).
 *
 * Four invariants decide every write, each because the alternative loses something a claim, a call
 * task or an operator relies on:
 *
 *   - Operator-owned facts are never written. `phone` is refreshed only while the row's
 *     `phoneSource` is still `osm`; `doNotCall`, `isFixture`, `phoneSource`, the venue-console
 *     secret and an existing row's `cityId` are never part of an insert or an update (AAP 0.5.2,
 *     0.5.6).
 *   - A row this pipeline does not own is never touched. Matching is by the global unique key
 *     (`osmType`, `osmId`), and a manually entered or seeded lodging carries no `osmId` at all, so
 *     it is neither selected nor updated (AAP 0.5.6).
 *   - An element OSM stops listing is marked `osmMissingAt` rather than deleted, and one that
 *     reappears has it cleared, so the claims, activity facts, visibility rows and console secret
 *     referencing `Lodging.id` — an id that never changes — stay attached across the gap (AAP 0.5.6,
 *     0.5.7).
 *   - The disappearance statement runs only when at least one element survived mapping. An empty
 *     answer for a whole city bbox is a data-source fault, not mass closure, and reading it as
 *     closure would empty the city's directory in a single run (AAP 0.5.6).
 *
 * The caller owns the transaction and the Overpass request: `../jobs/place-refresh.ts` fetches
 * outside any transaction (AAP 0.2.2) and passes the elements, the injected clock's instant and the
 * process's `APP_ENV` in. This module writes no log line and returns counts instead, so no phone
 * number, address or coordinate can reach a log through it (AAP 0.11.1).
 *
 * @see AAP 0.5.2 for the `Lodging` model and the fixture policy, 0.5.6 for the ingestion rules,
 *   0.3.2 for idempotency and the unique key, and 0.8.1 for this file.
 */

import { fixturePredicate, readPoints, setPoint, type DbTx, type Prisma } from '@tablemate/db';
import type { AppEnv, LatLng, LodgingKind, PhoneSource } from '@tablemate/shared';

import { elementPoint, osmAddress, toE164 } from './categorize.ts';
import { osmKeyOf, osmKeyString, type OsmType, type OverpassElement } from './overpass.ts';

/**
 * The OSM `tourism` tag value of each `Lodging.kind` (AAP 0.5.2, 0.5.6). `guest_house` is the one
 * value that does not spell the kind it maps to.
 */
export const LODGING_KIND_BY_TOURISM = {
  hostel: 'hostel',
  hotel: 'hotel',
  guest_house: 'guesthouse',
} as const satisfies Record<string, LodgingKind>;

/**
 * The lodging kind an element's `tourism` tag names, or `null` when the element is no lodging this
 * pipeline stores (AAP 0.5.6).
 *
 * The table is read through a widened record because the tag value is free text: `as const` keeps
 * {@link LODGING_KIND_BY_TOURISM}'s literals, and this view makes an unrecognized tag yield `null`
 * instead of a value TypeScript only believes exists.
 *
 * @param tags - The element's tags, absent on an element Overpass answered without them.
 * @returns The kind, or `null` for a missing or unrecognized `tourism` tag.
 */
export function lodgingKindOf(
  tags: Readonly<Record<string, string>> | undefined,
): LodgingKind | null {
  const tourism = tags?.['tourism']?.trim() ?? '';
  const kindByTourism: Readonly<Record<string, LodgingKind | undefined>> = LODGING_KIND_BY_TOURISM;

  return kindByTourism[tourism] ?? null;
}

/** How many ids one preload query binds: a city holds thousands, and a bound parameter list is not. */
const ID_CHUNK = 1_000;

/**
 * The three OSM element types, in the order {@link findExisting} builds its key branches from them
 * (AAP 0.5.6). The type is the one `./overpass.ts` declares, and the list exists because each branch
 * has to pin the `osmType` half of the pair by its literal.
 */
const OSM_TYPES = ['node', 'way', 'relation'] as const satisfies readonly OsmType[];

/**
 * The tolerance within which two coordinates are the same point, in degrees: about a centimetre,
 * far above the round-trip error of a `double precision` geography and far below any real move, so
 * an untouched row is never rewritten for a rounding difference.
 */
const COORD_EPSILON = 1e-7;

/** One element's `Lodging` fields, in the spelling the model stores them (AAP 0.5.2, 0.5.6). */
type LodgingFields = {
  /** `<osmType>/<osmId>`, the same text as the SQL expression `osm_type || '/' || osm_id::text`. */
  key: string;
  /** The element's type: the first half of the upsert key. */
  osmType: OsmType;
  /** The element's OSM id, the width of the `BigInt` column it is stored in. */
  osmId: bigint;
  /** The trimmed `name` tag, which `Lodging.name` requires. */
  name: string;
  /** `hostel`, `hotel` or `guesthouse`. */
  kind: LodgingKind;
  /** The `addr:*` address as `osmAddress` joins it, or `null`. */
  address: string | null;
  /** The `phone` or `contact:phone` tag in E.164 form, or `null` when it holds no usable number. */
  phone: string | null;
  /** Where the element sits, as `setPoint` takes it. */
  point: LatLng;
};

/** The columns of one existing row this module decides against (AAP 0.5.2). */
type ExistingLodging = {
  id: string;
  osmType: string | null;
  osmId: bigint | null;
  name: string;
  kind: LodgingKind;
  address: string | null;
  phone: string | null;
  phoneSource: PhoneSource;
  osmMissingAt: Date | null;
};

/**
 * What one refresh wrote (AAP 0.5.6): `returned` counts the rows whose `osmMissingAt` was cleared,
 * which are also counted in `updated`, and `missing` the rows the disappearance statement marked.
 * `unchanged` and `skipped` exist for the job's log line, so a run that changed nothing is visible
 * as such.
 */
export type LodgingUpsertResult = {
  /** Elements that had no row yet, inserted with their location. */
  inserted: number;
  /** Rows whose OSM-sourced fields or location changed, including every returned row. */
  updated: number;
  /** Rows already holding exactly what OSM reports; nothing was written for them. */
  unchanged: number;
  /** Rows of this city marked `osmMissingAt` because OSM no longer lists them. */
  missing: number;
  /** Rows OSM lists again, whose `osmMissingAt` was cleared. */
  returned: number;
  /** Elements that cannot become a lodging: no name, no kind, or no usable coordinate. */
  skipped: number;
};

/**
 * The `Lodging` fields one element yields, or `null` when it cannot become a lodging (AAP 0.5.6).
 *
 * A missing name would have to be invented, a missing kind would make the lodging unfilterable and a
 * missing coordinate could not be searched or called, so any of the three drops the element; every
 * other tag stands on its own, because a lodging with no phone is still listed and can still be
 * claimed.
 *
 * @param element - One element of an Overpass answer.
 * @returns The fields, or `null` for an element without a name, a kind or a usable point.
 */
function lodgingFields(element: OverpassElement): LodgingFields | null {
  const { tags } = element;
  const name = tags?.['name']?.trim() ?? '';
  const kind = lodgingKindOf(tags);
  const point = elementPoint(element);

  if (name === '' || kind === null || point === null) {
    return null;
  }

  const { osmType, osmId } = osmKeyOf(element);

  return {
    key: osmKeyString(osmType, osmId),
    osmType,
    osmId,
    name,
    kind,
    address: osmAddress(tags),
    phone: toE164(tags?.['phone'] ?? tags?.['contact:phone']),
    point,
  };
}

/** True when two coordinates are the same point within {@link COORD_EPSILON}. */
function samePoint(a: LatLng, b: LatLng): boolean {
  return Math.abs(a.lat - b.lat) <= COORD_EPSILON && Math.abs(a.lng - b.lng) <= COORD_EPSILON;
}

/**
 * Reads the rows the elements already have, by (`osmType`, `osmId`) (AAP 0.5.6).
 *
 * Matching is global rather than per city, because the unique key is: a row already owned by another
 * city is found and updated in place, and its `cityId` is never written. City bboxes do not overlap
 * in `config/cities.json`, so this only matters for a boundary element OSM moved between two
 * queries.
 *
 * The predicate constrains both halves of the key, because `lodging_osm_type_osm_id_key` is a btree
 * on (`osmType`, `osmId`) and PostgreSQL can seek such a key only when its leading column is
 * constrained: filtering on `osmId` alone scans the whole `lodging` table — a table no city bbox
 * bounds — once per chunk. The three branches cover every non-NULL `osmType` between them, so they
 * return the rows the `osmId`-only filter returned (AAP 0.5.2, 0.5.6).
 *
 * @param tx - The caller's transaction.
 * @param ids - The element ids to look for; deduplicated and chunked at {@link ID_CHUNK}.
 * @returns A map from `<osmType>/<osmId>` to the row, holding only the rows found. A row whose
 * `osmType` is NULL cannot be keyed and is left out, as is a fixture row outside `test` and `demo`,
 * which the client's fixture guard filters from the read (AAP 0.5.2).
 */
async function findExisting(
  tx: DbTx,
  ids: readonly bigint[],
): Promise<Map<string, ExistingLodging>> {
  const found = new Map<string, ExistingLodging>();
  const wanted = [...new Set(ids)];

  for (let start = 0; start < wanted.length; start += ID_CHUNK) {
    const chunk = wanted.slice(start, start + ID_CHUNK);
    // One branch per osm_type: the unique key's leading column has to be constrained for the index
    // to be seeked, and every branch pins it beside the same id chunk (AAP 0.5.2's Lodging unique
    // key, AAP 0.5.6's upsert by the pair).
    const rows = await tx.lodging.findMany({
      where: { OR: OSM_TYPES.map((osmType) => ({ osmType, osmId: { in: chunk } })) },
      select: {
        id: true,
        osmType: true,
        osmId: true,
        name: true,
        kind: true,
        address: true,
        phone: true,
        phoneSource: true,
        osmMissingAt: true,
      },
    });

    for (const row of rows) {
      if (row.osmType === null || row.osmId === null) {
        continue;
      }

      found.set(osmKeyString(row.osmType, row.osmId), row);
    }
  }

  return found;
}

/**
 * Inserts one element as a new lodging and writes its location (AAP 0.5.6). The row is created by
 * Prisma, which supplies the `uuid(7)` id, and `setPoint` writes the `geography` column Prisma
 * cannot write, in the same transaction.
 *
 * `phoneSource` is `osm` because this is an OSM phone, and `doNotCall`, `isFixture` and the console
 * secret are left at their schema defaults.
 */
async function insertLodging(tx: DbTx, cityId: string, fields: LodgingFields): Promise<void> {
  const data: Prisma.LodgingUncheckedCreateInput = {
    cityId,
    osmType: fields.osmType,
    osmId: fields.osmId,
    name: fields.name,
    kind: fields.kind,
    address: fields.address,
    phone: fields.phone,
    phoneSource: 'osm',
    isFixture: false,
  };
  const row = await tx.lodging.create({ data, select: { id: true } });

  await setPoint(tx, 'lodging', row.id, fields.point);
}

/**
 * Brings one existing row up to what OSM reports (AAP 0.5.6), writing nothing when it already
 * agrees, and returns whether anything changed.
 *
 * Only the OSM-sourced fields are written: the phone only while the row's own `phoneSource` is
 * `osm`, so an operator-entered number survives an OSM edit, and an OSM number that disappeared is
 * cleared. A row that OSM lists again has `osmMissingAt` cleared in the same update. The location is
 * rewritten only when the point moved or was never stored.
 */
async function refreshLodging(
  tx: DbTx,
  row: ExistingLodging,
  fields: LodgingFields,
  points: ReadonlyMap<string, LatLng>,
): Promise<boolean> {
  const phone = row.phoneSource === 'osm' ? fields.phone : row.phone;
  const returned = row.osmMissingAt !== null;
  const stored = points.get(row.id);
  const moved = stored === undefined || !samePoint(stored, fields.point);
  const same =
    row.name === fields.name &&
    row.kind === fields.kind &&
    row.address === fields.address &&
    row.phone === phone;

  if (!returned && !moved && same) {
    return false;
  }

  const data: Prisma.LodgingUncheckedUpdateInput = {
    name: fields.name,
    kind: fields.kind,
    address: fields.address,
    phone,
  };

  if (returned) {
    data.osmMissingAt = null;
  }

  await tx.lodging.update({ where: { id: row.id }, data });

  if (moved) {
    await setPoint(tx, 'lodging', row.id, fields.point);
  }

  return true;
}

/**
 * Marks the city's rows that OSM no longer lists (AAP 0.5.6) and returns how many rows changed.
 *
 * The statement is one tagged template, so every value is a bound parameter and the only text in it
 * is a double-quoted identifier; the array binds as `text[]` through its explicit cast, and the key
 * is compared against the very `osm_type || '/' || osm_id::text` spelling {@link osmKeyString}
 * produces. `updated_at` is set by hand because raw SQL bypasses Prisma's `@updatedAt`, and
 * `fixturePredicate` is ANDed in because raw SQL also bypasses the client's fixture guard (AAP
 * 0.5.2).
 *
 * The `osm_missing_at IS NULL` condition keeps a row's first disappearance time, and the two
 * NOT NULL conditions keep a row the concatenation could never match — and which `NOT (NULL)` would
 * therefore never update — out of the statement's way.
 *
 * @param tx - The caller's transaction.
 * @param cityId - The city whose rows are considered; another city's rows are untouched.
 * @param seenKeys - Every `<osmType>/<osmId>` this refresh kept. Never empty: the caller skips this
 * statement when nothing survived mapping, because an empty list would mark the whole city missing.
 * @param now - The instant to record, from the caller's injected clock.
 * @param appEnv - The process's `APP_ENV`, which decides whether fixture rows are visible.
 * @returns The number of rows marked.
 */
async function markMissing(
  tx: DbTx,
  cityId: string,
  seenKeys: readonly string[],
  now: Date,
  appEnv: AppEnv,
): Promise<number> {
  return tx.$executeRaw`
    UPDATE "lodging" AS "l"
       SET "osm_missing_at" = ${now}::timestamptz, "updated_at" = ${now}::timestamptz
     WHERE "l"."city_id" = ${cityId}
       AND "l"."osm_id" IS NOT NULL
       AND "l"."osm_type" IS NOT NULL
       AND "l"."osm_missing_at" IS NULL
       AND NOT (("l"."osm_type" || '/' || "l"."osm_id"::text) = ANY(${seenKeys}::text[]))
       AND ${fixturePredicate(appEnv, 'l')}
  `;
}

/**
 * Turns one city's Overpass lodging elements into `Lodging` rows (AAP 0.5.6): inserts what is new,
 * updates what changed, marks what OSM stopped listing, and clears `osmMissingAt` on what it lists
 * again. Run inside the caller's transaction, it is idempotent — a second run with the same elements
 * writes nothing — and a concurrent refresh of the same city can only collide on the unique
 * (`osmType`, `osmId`) index, which fails the transaction and lets BullMQ retry the job rather than
 * leaving a partial write (AAP 0.3.2, 0.5.6).
 *
 * @param tx - The transaction `place-refresh` opened. Give it room: Lisbon's bbox holds more than a
 * thousand lodgings, and the writes cost up to two round trips per element (`{ timeout: 120_000 }`).
 * @param cityId - The city the elements were fetched for. Every new row belongs to it, and its rows
 * are the only candidates for `osmMissingAt`.
 * @param elements - The lodgings `runOverpass` returned, fetched before the transaction began.
 * @param now - The instant to record on a disappearing row, from the caller's injected clock.
 * @param appEnv - The process's `APP_ENV`; only `test` and `demo` may see fixture rows.
 * @returns The counts of {@link LodgingUpsertResult}, for the job's log line.
 */
export async function upsertLodgings(
  tx: DbTx,
  cityId: string,
  elements: readonly OverpassElement[],
  now: Date,
  appEnv: AppEnv,
): Promise<LodgingUpsertResult> {
  const result: LodgingUpsertResult = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    returned: 0,
    skipped: 0,
  };
  const byKey = new Map<string, LodgingFields>();

  for (const element of elements) {
    const fields = lodgingFields(element);

    if (fields === null) {
      result.skipped += 1;
      continue;
    }

    // The first occurrence wins, so a duplicated element is refreshed once. It is not counted as
    // skipped: nothing is dropped that a caller would have missed, and `runOverpass` already
    // deduplicates an answer by key.
    if (!byKey.has(fields.key)) {
      byKey.set(fields.key, fields);
    }
  }

  const wanted = [...byKey.values()];
  const existing = await findExisting(
    tx,
    wanted.map((fields) => fields.osmId),
  );
  const points = await readPoints(
    tx,
    'lodging',
    [...existing.values()].map((row) => row.id),
    appEnv,
  );

  for (const fields of wanted) {
    const row = existing.get(fields.key);

    if (row === undefined) {
      await insertLodging(tx, cityId, fields);
      result.inserted += 1;
      continue;
    }

    const wasMissing = row.osmMissingAt !== null;

    if (await refreshLodging(tx, row, fields, points)) {
      result.updated += 1;

      if (wasMissing) {
        result.returned += 1;
      }
    } else {
      result.unchanged += 1;
    }
  }

  if (wanted.length > 0) {
    result.missing = await markMissing(tx, cityId, [...byKey.keys()], now, appEnv);
  }

  return result;
}
