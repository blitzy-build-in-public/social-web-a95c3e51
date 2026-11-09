/**
 * The Overpass client behind place and lodging ingestion (AAP 0.3.3, 0.5.6): the two Overpass QL
 * queries `place-refresh` runs per city, and the transport that reads their answers.
 *
 * Every value interpolated into a query comes from a constant of this file or from a coordinate
 * {@link coord} has already bounded and formatted, so no caller input reaches Overpass verbatim.
 * Overpass is operator-configured infrastructure (`OVERPASS_URL`), not a menu site: `safe-fetch` and
 * the crawl policy do not apply, the caller passes its own identifying user agent, and `zod` is the
 * only import because a third party's answer is parsed before any of it is used.
 *
 * HTTP 200 does not mean a complete answer: Overpass reports a truncated result set in `remark` and
 * still answers 200, and {@link runOverpass} throws on it, because `lodging-upsert.ts` would read
 * every lodging missing from a truncated answer as gone.
 */

import { z } from 'zod';

/**
 * The OpenStreetMap element type of a query result (AAP 0.5.6): the first half of the
 * (`osmType`, `osmId`) key `Place` and `Lodging` are upserted by.
 */
export type OsmType = 'node' | 'way' | 'relation';

/**
 * One element of an Overpass answer, as `out center tags;` returns it (AAP 0.5.6). A way or a
 * relation carries `center` instead of `lat`/`lon`. An absent property is omitted rather than set to
 * `undefined`, as `exactOptionalPropertyTypes` requires of the upsert that consumes it.
 */
export type OverpassElement = {
  type: OsmType;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

/** The `amenity` values ingested as places, shared with `categorize.ts` (AAP 0.5.6). */
export const PLACE_AMENITY_TAGS = ['restaurant', 'cafe', 'bar', 'pub'] as const;

/** The `tourism` values ingested as places, shared with `categorize.ts` (AAP 0.5.6). */
export const PLACE_TOURISM_TAGS = [
  'museum',
  'gallery',
  'attraction',
  'zoo',
  'aquarium',
  'theme_park',
] as const;

/**
 * The `leisure` values ingested as places, shared with `categorize.ts` (AAP 0.5.6).
 *
 * The three place lists stay short on purpose: broad tags such as `tourism=attraction` and
 * `leisure=park` add places that rarely publish a price, and such a place takes the phone fallback
 * or goes straight to `unreachable` (`no_phone`) in `menu-ingest`.
 */
export const PLACE_LEISURE_TAGS = ['park', 'water_park', 'sports_centre'] as const;

/**
 * The `tourism` values ingested as lodgings (AAP 0.5.6): the three kinds `Lodging.kind` accepts,
 * queried inside a city's bbox rather than around a partner venue.
 */
export const LODGING_TOURISM_TAGS = ['hostel', 'hotel', 'guest_house'] as const;

/** The radius of the places query in metres: "within 2 km of each partner venue" (AAP 0.5.6). */
const PLACES_RADIUS_M = 2_000;

/** The deadline applied when the caller passes none (AAP 0.11.1: "Overpass 60 s"). */
const DEFAULT_TIMEOUT_MS = 60_000;

/** The coordinate bounds {@link coord} enforces, which keep an unchecked number out of a query. */
const LATITUDE_BOUNDS = { min: -90, max: 90 } as const;
const LONGITUDE_BOUNDS = { min: -180, max: 180 } as const;

/**
 * The `remark` values that mark a truncated answer (AAP 0.5.6): Overpass answers 200 with a partial
 * `elements` array and one of these in `remark`.
 */
const PARTIAL_RESULT_REMARK = /runtime error|timed out|out of memory|rate_limited/i;

/**
 * Thrown when a query cannot be built, or when Overpass answers with a failure or a truncated result
 * set (AAP 0.5.6). The message carries the HTTP status or the remark, never a response body.
 * `place-refresh` lets it propagate, so BullMQ retries the job on its own backoff.
 */
export class OverpassError extends Error {
  /** The HTTP status of the answer, when the failure was a response. */
  readonly status?: number;
  /** Overpass's own `remark`, when a successful answer carried one. */
  readonly remark?: string;
  constructor(
    message: string,
    options: { status?: number; remark?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OverpassError';
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.remark !== undefined) {
      this.remark = options.remark;
    }
  }
}

/**
 * Formats one coordinate for a query (AAP 0.3.3). `toFixed(6)` is what makes it safe to interpolate:
 * a string of digits, a sign and a point, never exponent notation and never query syntax.
 */
function coord(value: number, bounds: { min: number; max: number }): string {
  if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) {
    throw new RangeError(`overpass_coordinate_out_of_range: expected ${bounds.min}..${bounds.max}`);
  }
  return value.toFixed(6);
}

/**
 * Builds an exact-match regular expression over OSM tag values (AAP 0.3.3). `values` comes only from
 * the tag constants above, so no user-supplied string is ever interpolated.
 */
function regex(values: readonly string[]): string {
  return `^(${values.join('|')})$`;
}

/**
 * The query that fetches places around a city's partner venues and partner lodgings (AAP 0.3.3,
 * 0.5.6): the three tag lists above, each within 2 km of every centre, in one union.
 *
 * The `["name"]` filter drops unnamed elements at the server, because `Place.name` is required and an
 * unnamed element could never be stored. Overpass deduplicates across union members within one
 * answer, but the client verifies uniqueness anyway, since a union member is no contract.
 *
 * city with no partner venue and no partner lodging, or when a coordinate is unusable.
 */
export function buildPlacesQuery(centers: readonly { lat: number; lng: number }[]): string {
  if (centers.length === 0) {
    throw new RangeError('overpass_no_centers: a places query needs at least one centre');
  }
  const statements: string[] = [];
  const emitted = new Set<string>();
  for (const center of centers) {
    const lat = coord(center.lat, LATITUDE_BOUNDS);
    const lon = coord(center.lng, LONGITUDE_BOUNDS);
    const key = `${lat},${lon}`;
    if (emitted.has(key)) {
      continue;
    }
    emitted.add(key);
    const around = `(around:${PLACES_RADIUS_M},${lat},${lon})`;
    statements.push(
      `  nwr["amenity"~"${regex(PLACE_AMENITY_TAGS)}"]["name"]${around};`,
      `  nwr["tourism"~"${regex(PLACE_TOURISM_TAGS)}"]["name"]${around};`,
      `  nwr["leisure"~"${regex(PLACE_LEISURE_TAGS)}"]["name"]${around};`,
    );
  }
  return `[out:json][timeout:60];\n(\n${statements.join('\n')}\n);\nout center tags;`;
}

/**
 * The query that fetches the lodgings inside a city's bbox (AAP 0.3.3, 0.5.6).
 *
 * The Overpass bounding box is south, west, north, east, which is the shape `City.bbox` carries in
 * `config/cities.json`.
 */
export function buildLodgingsQuery(bbox: {
  south: number;
  west: number;
  north: number;
  east: number;
}): string {
  const south = coord(bbox.south, LATITUDE_BOUNDS);
  const west = coord(bbox.west, LONGITUDE_BOUNDS);
  const north = coord(bbox.north, LATITUDE_BOUNDS);
  const east = coord(bbox.east, LONGITUDE_BOUNDS);
  if (bbox.south >= bbox.north || bbox.west >= bbox.east) {
    throw new RangeError(
      'overpass_bbox_not_increasing: south < north and west < east are required',
    );
  }
  return (
    `[out:json][timeout:60];\n` +
    `nwr["tourism"~"${regex(LODGING_TOURISM_TAGS)}"]["name"](${south},${west},${north},${east});\n` +
    `out center tags;`
  );
}

/** One element of an answer. Loose, because Overpass adds keys beside the ones read here. */
const ElementSchema = z.looseObject({
  type: z.enum(['node', 'way', 'relation']),
  id: z.number().int().positive(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

/**
 * The answer envelope (AAP 0.3.3). `elements` stays `unknown[]` so each element is validated on its
 * own and one malformed element drops only itself.
 */
const EnvelopeSchema = z.looseObject({
  version: z.number().optional(),
  generator: z.string().optional(),
  osm3s: z.looseObject({}).optional(),
  remark: z.string().optional(),
  elements: z.array(z.unknown()),
});

/** The parsed shape of one element, before it is narrowed to {@link OverpassElement}. */
type ParsedElement = z.output<typeof ElementSchema>;

/**
 * Narrows a parsed element to {@link OverpassElement}, omitting the properties the answer did not
 * carry. The explicit copy keeps `undefined` out of the property values, as
 * `exactOptionalPropertyTypes` requires and as the upsert that follows depends on.
 */
function toElement(parsed: ParsedElement): OverpassElement {
  const element: OverpassElement = { type: parsed.type, id: parsed.id };
  if (parsed.lat !== undefined) element.lat = parsed.lat;
  if (parsed.lon !== undefined) element.lon = parsed.lon;
  if (parsed.tags !== undefined) element.tags = parsed.tags;
  if (parsed.center !== undefined) {
    element.center = { lat: parsed.center.lat, lon: parsed.center.lon };
  }
  return element;
}

/**
 * Runs one Overpass query and returns its elements (AAP 0.3.3, 0.5.6). The query travels as a
 * form-encoded `data` field, which is the interface the public instance documents.
 *
 * `60_000` by default.
 * its status; on a network failure or an elapsed deadline, with the failure as `cause`; on a body
 * that is not JSON or does not match the envelope; and on a 200 whose `remark` reports a runtime
 * error, a timeout, an out-of-memory abort or a rate limit, because its `elements` array is
 * truncated and returning it would read as "every other lodging in this city is gone".
 *
 * An element that does not match the expected shape, and an element already seen, are dropped rather
 * than failing the refresh: a malformed element must not cost the city its whole place list.
 */
export async function runOverpass(
  query: string,
  opts: { url: string; userAgent: string; timeoutMs?: number },
): Promise<OverpassElement[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(opts.url, {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
      headers: {
        'User-Agent': opts.userAgent,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new OverpassError('overpass_unreachable', { cause: error });
  }
  if (!response.ok) {
    throw new OverpassError(`overpass_status: ${response.status}`, { status: response.status });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new OverpassError('overpass_malformed', { cause: error });
  }
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new OverpassError('overpass_malformed', { cause: envelope.error });
  }
  const { remark } = envelope.data;
  if (remark !== undefined && PARTIAL_RESULT_REMARK.test(remark)) {
    throw new OverpassError(`overpass_partial_result: ${remark}`, { remark });
  }
  const elements: OverpassElement[] = [];
  const seen = new Set<string>();
  for (const candidate of envelope.data.elements) {
    const parsed = ElementSchema.safeParse(candidate);
    if (!parsed.success) {
      continue;
    }
    const element = toElement(parsed.data);
    const key = osmKeyString(element.type, element.id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    elements.push(element);
  }
  return elements;
}

/**
 * The (`osmType`, `osmId`) key of an element, as `Place` and `Lodging` store it (AAP 0.5.6). The id
 * is a `bigint` because an OSM id outgrows an `int4` and the column is `BigInt?`.
 */
export function osmKeyOf(element: Pick<OverpassElement, 'type' | 'id'>): {
  osmType: OsmType;
  osmId: bigint;
} {
  return { osmType: element.type, osmId: BigInt(element.id) };
}

/**
 * The composite key string of an element, `` `<osmType>/<osmId>` `` (AAP 0.5.6). `lodging-upsert.ts`
 * compares it against the SQL expression `osm_type || '/' || osm_id::text`, so both spellings of the
 * same key have to agree.
 */
export function osmKeyString(osmType: string, osmId: bigint | number): string {
  return `${osmType}/${osmId}`;
}
