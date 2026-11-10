/** OpenStreetMap tags into the fields `Place` is upserted from (AAP 0.5.2, 0.5.6). `./overpass.ts` fetches the elements; this module is the only place their tags are read, and it is pure and deterministic — no clock, no logging, no network, no database client. A value that cannot be read becomes `null` rather than an exception, and only a missing name, category or coordinate drops the element. A value that is kept is kept as OSM spells it: AAP 0.5.2 stores the raw `opening_hours` syntax, which `suggestions/candidates.ts` parses with this library version (AAP 0.5.7). */

import OpeningHours from 'opening_hours';

import { E164 } from '@tablemate/shared';
import type { LatLng, PlaceCategory } from '@tablemate/shared';

import {
  PLACE_AMENITY_TAGS,
  PLACE_LEISURE_TAGS,
  PLACE_TOURISM_TAGS,
  osmKeyOf,
  type OsmType,
  type OverpassElement,
} from './overpass.ts';

/** What is stripped out of a phone number before it is validated (AAP 0.5.6): the whitespace and separators OSM uses inside a number as it is dialled, including the non-breaking space. */
const PHONE_SEPARATORS = /[\s\u00A0\-.()/]/g;
/** The scheme prefix of a URL, which decides whether one has to be added (AAP 0.5.6). */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** The coordinate bounds a point falls inside for `setPoint` to accept it (AAP 0.5.6). */
const LATITUDE_BOUNDS = { min: -90, max: 90 } as const;
const LONGITUDE_BOUNDS = { min: -180, max: 180 } as const;
/** The first entry of a `;`-separated tag value, trimmed (AAP 0.5.6). OSM records a second phone number or URL after a semicolon, and only the first is read: a place carries one number to dial and a menu fetch follows one link. */
function firstEntry(raw: string | undefined): string | null {
  const first = raw?.split(';')[0]?.trim() ?? '';
  return first === '' ? null : first;
}

/** A tag value trimmed, for the tags stored as they are read (AAP 0.5.6). */
function tagValue(tags: Readonly<Record<string, string>> | undefined, key: string): string | null {
  const value = tags?.[key]?.trim();
  return value === undefined || value === '' ? null : value;
}

/** Membership test over one of the tag lists in `./overpass.ts` (AAP 0.5.6): the lists are what the Overpass query matches on, so categorizing from them keeps the query and this module from drifting apart, and an element the query returned can never fail to categorize. */
function isTagged<T extends string>(values: readonly T[], value: string | null): value is T {
  return value !== null && values.some((tag) => tag === value);
}

/** Joins the parts one address line is made of with a single space, dropping the empty ones. */
function joinParts(...parts: (string | null)[]): string | null {
  const kept = parts.filter((part): part is string => part !== null);
  return kept.length === 0 ? null : kept.join(' ');
}

/** True when `value` is a finite number inside `min..max`. */
function isCoordinate(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/**
 * The guard that keeps the `amenity` switch exhaustive (AAP 0.5.2, 0.5.6). Every member of
 * `PLACE_AMENITY_TAGS` has a `case`, so the value reaching the switch's `default` arm narrows to
 * `never` and this call compiles only while that stays true. A tag added to the list without a
 * category is therefore a compile error here instead of a place silently stored as a `bar`, which a
 * comment alone cannot prevent.
 *
 * This does not conflict with the module's rule that OSM free text which cannot be read becomes
 * `null` rather than an exception: an uncategorizable tag is an inconsistency between this module
 * and the list it categorizes from, not unreadable OSM data, and the arm is unreachable once the
 * build passes.
 *
 * out of `readonly string[]` at the call site could arrange at runtime.
 */
function assertNever(value: never): never {
  throw new RangeError(`uncategorized place amenity: ${String(value)}`);
}

/** The place category an element's tags describe (AAP 0.5.2, 0.5.6): `restaurant`, `cafe`, `bar` or `activity`, or `null` when the element is no place this pipeline stores. Precedence is `amenity`, then `tourism`, then `leisure`, so a restaurant with a `tourism` tag is still a restaurant. */
export function categorizePlace(
  tags: Readonly<Record<string, string>> | undefined,
): PlaceCategory | null {
  const amenity = tagValue(tags, 'amenity');
  if (isTagged(PLACE_AMENITY_TAGS, amenity)) {
    switch (amenity) {
      case 'restaurant':
        return 'restaurant';
      case 'cafe':
        return 'cafe';
      // `bar` and `pub` are both stored as `bar`, the two remaining members of `PLACE_AMENITY_TAGS`.
      case 'bar':
      case 'pub':
        return 'bar';
      default:
        return assertNever(amenity);
    }
  }
  if (isTagged(PLACE_TOURISM_TAGS, tagValue(tags, 'tourism'))) {
    return 'activity';
  }
  return isTagged(PLACE_LEISURE_TAGS, tagValue(tags, 'leisure')) ? 'activity' : null;
}

/** An OSM phone tag in E.164, or `null` when it does not hold one (AAP 0.5.2 `Place.phone`). The separators OSM uses are removed and a leading international prefix `00` becomes `+`. A number left in a national format (`21 123 4567`) is rejected rather than completed with a country code: the country belongs to the place's city, not to the tag, and a guessed number is one the phone agent would dial. */
export function toE164(raw: string | undefined): string | null {
  const entry = firstEntry(raw);
  if (entry === null) {
    return null;
  }
  const digits = entry.replace(PHONE_SEPARATORS, '');
  const normalized = digits.startsWith('00') ? `+${digits.slice(2)}` : digits;
  return E164.safeParse(normalized).success ? normalized : null;
}

/** An OSM URL tag as an absolute `http` or `https` URL, or `null` (AAP 0.5.6). A scheme-less `www.example.pt/menu` gets `https://`; anything that is not a web address (`ftp:`, `mailto:`, a bare word) is rejected, because `Place.website` and `Place.menuUrl` are fetched by `menu-ingest` and the crawl policy is applied to the host that comes out of here. */
export function normalizeWebUrl(raw: string | undefined): string | null {
  const entry = firstEntry(raw);
  if (entry === null) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(URL_SCHEME.test(entry) ? entry : `https://${entry}`);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

/** The postal address an element's `addr:*` tags describe, or `null` (AAP 0.5.6). `addr:full` wins when present, because whoever filled it wrote the address as it is posted. Otherwise the street and number form one line and the postcode and city another, and a line that holds nothing is left out instead of leaving a separator behind. */
export function osmAddress(tags: Readonly<Record<string, string>> | undefined): string | null {
  const full = tagValue(tags, 'addr:full');
  if (full !== null) {
    return full;
  }
  const lines = [
    joinParts(tagValue(tags, 'addr:street'), tagValue(tags, 'addr:housenumber')),
    joinParts(tagValue(tags, 'addr:postcode'), tagValue(tags, 'addr:city')),
  ].filter((line): line is string => line !== null);
  return lines.length === 0 ? null : lines.join(', ');
}

/** The point an element is located at, in the `{ lat, lng }` form `setPoint` takes (AAP 0.5.6). A node carries `lat`/`lon`; a way or a relation carries the `center` both queries ask for. The bounds are checked here rather than at the database, so one malformed element drops only its own place instead of failing the refresh of every place in a city. */
export function elementPoint(element: OverpassElement): LatLng | null {
  const nodePoint =
    element.lat === undefined || element.lon === undefined
      ? null
      : { lat: element.lat, lng: element.lon };
  const centerPoint =
    element.center === undefined ? null : { lat: element.center.lat, lng: element.center.lon };
  const point = nodePoint ?? centerPoint;
  if (
    point === null ||
    !isCoordinate(point.lat, LATITUDE_BOUNDS.min, LATITUDE_BOUNDS.max) ||
    !isCoordinate(point.lng, LONGITUDE_BOUNDS.min, LONGITUDE_BOUNDS.max)
  ) {
    return null;
  }
  return point;
}

/** Whether the `opening_hours` library can read a value (AAP 0.5.6, 0.5.7). A place whose hours do not parse is stored with `null` hours and left out of suggestions, which is the correct outcome: an unreadable schedule is not evidence that a place is open. The nominatim context is passed through because the library needs it to evaluate a `PH` (public holiday) or a `sunrise`/`sunset` rule, which is what `suggestions/candidates.ts` does with the stored string. value by throwing a plain value rather than an `Error`, so nothing is read from it. */
export function isValidOpeningHours(
  value: string,
  opts: { lat: number; lng: number; countryCode?: string },
): boolean {
  const nominatim =
    opts.countryCode === undefined
      ? null
      : {
          lat: opts.lat,
          lon: opts.lng,
          address: { country_code: opts.countryCode.toLowerCase(), state: '' },
        };
  try {
    new OpeningHours(value, nominatim);
    return true;
  } catch {
    return false;
  }
}

/** The `Place` fields one Overpass element yields (AAP 0.5.2, 0.5.6). The names match the `Place` model column for column, so `place-refresh` maps them straight onto an upsert. */
export type PlaceFields = {
  /** The element's type: the first half of the (`osmType`, `osmId`) upsert key. */
  osmType: OsmType;
  /** The element's OSM id as a `bigint`, the width of the `BigInt` column it is stored in. */
  osmId: bigint;
  /** The element's trimmed `name`, which `Place.name` requires. */
  name: string;
  /** `restaurant`, `cafe`, `bar` or `activity` (AAP 0.5.2). */
  category: PlaceCategory;
  /** Latitude in degrees. */
  lat: number;
  /** Longitude in degrees: the `lon` of the Overpass answer. */
  lng: number;
  /** The `phone` or `contact:phone` tag in E.164 form, or `null` when it holds no usable number. */
  phone: string | null;
  /** The `website` or `contact:website` tag as an absolute URL, or `null`. */
  website: string | null;
  /** The `website:menu` tag as an absolute URL, or `null`. */
  menuUrl: string | null;
  /** The raw `opening_hours` tag, or `null` when it is absent or does not parse. */
  openingHours: string | null;
  /** The `addr:*` address, which `Place` has no column for and a caller may ignore. */
  address: string | null;
};
/** The fields `Place` is built from, derived from one Overpass element (AAP 0.5.2, 0.5.6). `null` means the element cannot become a place: no name (`Place.name` is required), no category or no usable coordinate. Every other field stands on its own — a place with no website is still stored, because the phone fallback can price it, while a missing name would have to be invented. which the library needs to evaluate a `PH` (public holiday) or a `sunrise`/`sunset` rule in the stored value. Optional, so a caller with no city still gets every other field. */
export function placeFields(
  element: OverpassElement,
  opts: { countryCode?: string } = {},
): PlaceFields | null {
  const { tags } = element;
  const name = tagValue(tags, 'name');
  if (name === null) {
    return null;
  }
  const category = categorizePlace(tags);
  if (category === null) {
    return null;
  }
  const point = elementPoint(element);
  if (point === null) {
    return null;
  }
  const rawHours = tagValue(tags, 'opening_hours');
  const hoursOptions: { lat: number; lng: number; countryCode?: string } = {
    lat: point.lat,
    lng: point.lng,
  };
  if (opts.countryCode !== undefined) {
    hoursOptions.countryCode = opts.countryCode;
  }
  const { osmType, osmId } = osmKeyOf(element);
  return {
    osmType,
    osmId,
    name,
    category,
    lat: point.lat,
    lng: point.lng,
    phone: toE164(tags?.['phone'] ?? tags?.['contact:phone']),
    website: normalizeWebUrl(tags?.['website'] ?? tags?.['contact:website']),
    menuUrl: normalizeWebUrl(tags?.['website:menu']),
    openingHours:
      rawHours !== null && isValidOpeningHours(rawHours, hoursOptions) ? rawHours : null,
    address: osmAddress(tags),
  };
}
