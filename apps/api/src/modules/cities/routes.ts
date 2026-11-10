/**
 * The three city routes: the configured city list, a city's partner venues, and one page of traveler discovery.
 *
 * The three differ in what they ask of a caller, and every difference is a rule of the contract: the venue list requires no
 * proof, so an unverified traveler browses where a meetup may be held, while the traveler list keeps answering
 * `403 no_valid_proof`. Discovery delegates its page to `./discovery.ts`, which owns proof validity, the blocks in either
 * direction, the unverified-reader rule and the keyset cursor, and this file decides the two errors that precede that call
 * in the contract's order — `404 city_not_found`, then `403 no_valid_proof`. All three carry the traveler guard at
 * route-group level, and none is rate-limited.
 *
 * Every response is built from an explicit field allowlist — an ORM row is never spread — so
 * `Venue.secretLookupHash` and `Venue.secretCiphertext` cannot reach a response however the model grows. The instant a
 * request is judged at is read once, so the proof check and the page it gates cannot straddle the boundary of a proof's
 * validity.
 */

import { readPoints } from '@tablemate/db';
import {
  CitiesResponse,
  CityIdParams,
  CursorQuery,
  ErrorEnvelope,
  TravelersResponse,
  VenuesResponse,
} from '@tablemate/shared';
import type { CityDto, VenueDto } from '@tablemate/shared';

import { requireTraveler } from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { OPENAPI_SECURITY, type OpenApiTag } from '../../plugins/openapi.ts';
import { cityBySlug, readCitiesConfig } from '../proofs/registry.ts';
import { hasValidProof } from '../proofs/validity.ts';
import { listTravelers } from './discovery.ts';

import type { App, AppServices } from '../../app.ts';

/** The tag all three routes group under: a member of the document's own vocabulary (AAP 0.11.2). */
const CITIES_TAG = 'cities' satisfies OpenApiTag;

/** What the city list reads: the guarded client, which already narrows fixture rows (AAP 0.5.2). */
type CityListServices = Pick<AppServices, 'db'>;

type VenueListServices = Pick<AppServices, 'db' | 'env' | 'logger'>;

/**
 * The bound on the venue list {@link cityVenues} answers, and the largest number of venue ids that read therefore hands to
 * `readPoints` as one `uuid[]` bind.
 *
 * AAP 0.5.4 fixes no cursor for `GET /cities/:cityId/venues`, so this read is capped rather than paged: the first
 * {@link CITY_VENUES_LIMIT} venues in (name, id) order are answered, and a city holding more is reported through
 * `city_venues_truncated`. The list is operator-driven rather than ingestion-driven, so this read names the same default
 * page size as the two admin registry reads (`ADMIN_REGISTRY_LIMIT`), which page on where this one stops.
 */
export const CITY_VENUES_LIMIT = 200;

/**
 * A venue list that came back with more rows than the bound, logged under its own event so a truncated list is visible
 * rather than silently read as a complete one. The line carries the bound and nothing else.
 */
const CITY_VENUES_TRUNCATED = 'city_venues_truncated';

/**
 * Every stored city, in the order `config/cities.json` lists them.
 *
 * The `City` rows are the source of truth for which cities exist — the seed loads them from that same
 * file — while the file fixes their order, so a city the configuration no longer lists sorts after
 * every configured one instead of vanishing from the response.
 *
 * Exported because the operator's own read of the same catalogue, `GET /admin/cities`, answers with it
 * (AAP 0.5.4): the operator area is entered by role alone and lies outside the age gate that guards
 * this route, so it cannot read the list from here, and a second implementation of the order and the
 * field allowlist would let the two answers drift apart.
 *
 * @throws {ZkConfigurationError} When `config/cities.json` cannot be read.
 */
export async function cityList(services: CityListServices): Promise<CitiesResponse> {
  const rows = await services.db.city.findMany({
    select: { id: true, name: true, countryCode: true, timezone: true, currency: true },
  });
  const order = cityOrder();
  const items = rows
    .map((row): CityDto => ({
      id: row.id,
      name: row.name,
      countryCode: row.countryCode,
      timezone: row.timezone,
      currency: row.currency,
    }))
    .sort((left, right) => compareCities(left, right, order));
  return { items };
}

function cityOrder(): ReadonlyMap<string, number> {
  return new Map(
    readCitiesConfig().cities.map((city, index): [string, number] => [city.id, index]),
  );
}

/**
 * Orders two cities the way `GET /cities` answers them: configuration order first, then name, then id, so the list is one
 * total order whatever the database hands back. Names and ids are compared by code unit rather than with `localeCompare`,
 * which would make the order a function of the host's locale data.
 */
function compareCities(left: CityDto, right: CityDto, order: ReadonlyMap<string, number>): number {
  const leftAt = order.get(left.id);
  const rightAt = order.get(right.id);
  if (leftAt !== undefined && rightAt !== undefined && leftAt !== rightAt) {
    return leftAt - rightAt;
  }
  if (leftAt !== undefined && rightAt === undefined) {
    return -1;
  }
  if (leftAt === undefined && rightAt !== undefined) {
    return 1;
  }
  if (left.name !== right.name) {
    return left.name < right.name ? -1 : 1;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

/**
 * A city's active partner venues.
 *
 * No proof is required: an unverified traveler browses where a meetup may be held, and `422 venue_not_partner` is what
 * rejects a proposal at any other place, which is why only active partners are listed.
 *
 * The list is bounded rather than paged, because AAP 0.5.4 fixes no cursor for this route: the read answers the first
 * {@link CITY_VENUES_LIMIT} rows in (name, id) order, and the id breaks a same-name tie, so the capped read is one total
 * order and two reads of the same city answer the same rows.
 *
 * A venue whose `location` is NULL is left out of the list and logged: `VenueDto` carries the coordinates the client maps
 * the venue by and the 150 m check-in geofence is measured from.
 *
 * `@throws AppError city_not_found` (404) when no configured city carries `cityId`.
 */
async function cityVenues(services: VenueListServices, cityId: string): Promise<VenuesResponse> {
  if (cityBySlug(cityId) === undefined) {
    throw new AppError('city_not_found');
  }
  // The client's fixture guard narrows this read outside `test` and `demo`, so a fixture venue is
  // listed in those two environments alone (AAP 0.5.2). The select holds no secret column:
  // `secretLookupHash`, `secretCiphertext` and `secretIssuedAt` are never loaded (AAP 0.5.4).
  const rows = await services.db.venue.findMany({
    where: { cityId, isActivePartner: true },
    select: { id: true, cityId: true, name: true, address: true, isActivePartner: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: CITY_VENUES_LIMIT + 1,
  });
  // The row past the bound is a sentinel: its presence says the city holds more venues than this read
  // answers, and it is dropped here so the id list below can never exceed CITY_VENUES_LIMIT. A list
  // silently cut to this many rows would read as a complete one, so the truncation is logged.
  const truncated = rows.length > CITY_VENUES_LIMIT;
  const venues = truncated ? rows.slice(0, CITY_VENUES_LIMIT) : rows;
  if (truncated) {
    services.logger.warn({ event: CITY_VENUES_TRUNCATED, limit: CITY_VENUES_LIMIT });
  }
  // The geography column is `Unsupported` in the Prisma schema, so Prisma cannot select it and the
  // coordinates come from the PostGIS helper, which applies the fixture predicate to this table
  // itself (AAP 0.5.2).
  const points = await readPoints(
    services.db,
    'venue',
    venues.map((venue) => venue.id),
    services.env.APP_ENV,
  );
  const items: VenueDto[] = [];
  for (const venue of venues) {
    const point = points.get(venue.id);
    if (point === undefined) {
      services.logger.warn(
        { event: 'venue_without_location', venueId: venue.id },
        'venue_without_location',
      );
      continue;
    }
    items.push({
      id: venue.id,
      cityId: venue.cityId,
      name: venue.name,
      address: venue.address,
      lat: point.lat,
      lng: point.lng,
      isActivePartner: venue.isActivePartner,
    });
  }
  return { items };
}

/**
 * One page of travelers visible in a city.
 *
 * This route's own part is the two guards, in the order AAP 0.5.4 lists them — `404 city_not_found`, then
 * `403 no_valid_proof` — and the single instant both the check and the page are judged at is read once, so a proof reaching
 * the end of its window cannot be rejected by one and accepted by the other. The page, its keyset cursor and the block and
 * unverified-reader rules belong to `./discovery.ts`.
 *
 * `@throws AppError city_not_found` (404), `no_valid_proof` (403) and `invalid_field` (400) for a cursor this API did not
 * write.
 */
async function cityTravelers(
  services: AppServices,
  viewerId: string,
  cityId: string,
  cursor: string | undefined,
): Promise<TravelersResponse> {
  const now = services.clock.now();
  if (cityBySlug(cityId) === undefined) {
    throw new AppError('city_not_found');
  }
  if (!(await hasValidProof(services.db, viewerId, cityId, now))) {
    throw new AppError('no_valid_proof');
  }
  return listTravelers(services, cityId, viewerId, cursor, now);
}

/**
 * Registers the three city routes on the context `app.ts` mounts under `/v1`.
 *
 * The guard is installed here, at route-group level, so these three routes are the only ones it covers and a route outside
 * this context cannot inherit the age gate by accident. Registration is synchronous, as in every plugin the composition root
 * installs, and the returned promise is what Fastify's plugin type expects.
 */
export default function citiesRoutes(app: App): Promise<void> {
  app.addHook('onRequest', requireTraveler);
  app.get(
    '/cities',
    {
      schema: {
        tags: [CITIES_TAG],
        security: OPENAPI_SECURITY.bearer,
        response: { 200: CitiesResponse, 401: ErrorEnvelope, 403: ErrorEnvelope },
      },
    },
    async () => cityList(app.services),
  );
  app.get(
    '/cities/:cityId/venues',
    {
      schema: {
        tags: [CITIES_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: CityIdParams,
        response: {
          200: VenuesResponse,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request) => cityVenues(app.services, request.params.cityId),
  );
  app.get(
    '/cities/:cityId/travelers',
    {
      schema: {
        tags: [CITIES_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: CityIdParams,
        querystring: CursorQuery,
        response: {
          200: TravelersResponse,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request) => {
      // Read the context rather than asserting it. The guard above admitted this request, so it is
      // set — but that is a property of the registration, not of this handler, and a hook that were
      // moved, removed or shadowed would otherwise leave a `TypeError` answered as
      // `500 internal_error` where the contract requires `401 token_invalid`.
      if (request.auth === null) {
        throw new AppError('token_invalid');
      }
      return cityTravelers(
        app.services,
        request.auth.userId,
        request.params.cityId,
        request.query.cursor,
      );
    },
  );
  return Promise.resolve();
}
