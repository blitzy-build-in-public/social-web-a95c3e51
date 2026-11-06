/**
 * The three city routes (AAP 0.5.1, 0.5.4, 0.5.8): the configured city list, a city's partner
 * venues, and one page of traveler discovery.
 *
 * `GET /cities` answers the launch cities in `config/cities.json` order, `GET /cities/:cityId/venues`
 * answers a city's active partner venues, and `GET /cities/:cityId/travelers` answers one page of
 * `Tier0Profile`s. The three differ in what they ask of a caller, and every difference is a rule of
 * AAP 0.5.4 and 0.5.8 rather than a choice made here:
 *
 *  - The venue list requires no proof, so an unverified traveler browses where a meetup may be held
 *    while the traveler list keeps answering `403 no_valid_proof` and the client shows its import
 *    banner in the list's place (AAP 0.5.8).
 *  - Discovery delegates its page to `./discovery.ts`, which owns proof validity, the blocks in
 *    either direction, the unverified-reader rule and the keyset cursor (AAP 0.5.7). This file
 *    decides the two errors that precede that call, in the order AAP 0.5.4 lists them:
 *    `404 city_not_found` for a slug no configured city carries, then `403 no_valid_proof` for a
 *    caller holding no proof valid for that city at the instant the request is served.
 *  - All three carry the traveler guard at route-group level, and none is rate-limited: they are
 *    plain reads, and AAP 0.5.4 limits the mutating routes and the two state-writing reads alone.
 *    `GET /cities` is guarded although it is additive and reads as public, because the age-gate scope
 *    of AAP 0.5.4 names the public routes and this one is not among them.
 *
 * Every response is built from an explicit field allowlist — a `CityDto` and a `VenueDto` are
 * assembled field by field and an ORM row is never spread — so `Venue.secretLookupHash` and
 * `Venue.secretCiphertext`, which are no fields of `VenueDto`, cannot reach a response however the
 * model grows (AAP 0.5.4). Coordinates come from `readPoints`, because the geography column is an
 * `Unsupported` field Prisma cannot select (AAP 0.5.2), and discovery's profiles come from
 * `tier0Profiles` and are never re-serialized here.
 *
 * The instant a request is judged at is read once, from the injected clock, so the proof check and
 * the page it gates cannot straddle the boundary of a proof's validity (AAP 0.11.1). The only line
 * this module logs is the warning for a venue whose location was never written: no user id, proof
 * date or coordinate is ever logged (AAP 0.11.1).
 *
 * @see AAP 0.5.2 for the `City` and `Venue` models and the fixture rule, 0.5.4 for the three routes,
 *   their schemas, their errors and the guard scope, 0.5.7 for proof validity and the discovery
 *   rules, 0.5.8 for the unverified browsing states, 0.11.1 for the injected clock and the logging
 *   rules, and 0.8.1 for this file.
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

// Type-only, so this file holds no run-time edge back to the module that registers it: `App` and
// `AppServices` are the plan's one declaration of the instance and of what it hands its modules, they
// are erased at compile time, and nothing of `app.ts` is read here at runtime.
import type { App, AppServices } from '../../app.ts';

/** The tag all three routes group under: a member of the document's own vocabulary (AAP 0.11.2). */
const CITIES_TAG = 'cities' satisfies OpenApiTag;

/** What the city list reads: the guarded client, which already narrows fixture rows (AAP 0.5.2). */
type CityListServices = Pick<AppServices, 'db'>;

/** What the venue list reads: the client, the mode the fixture rule follows, and the logger. */
type VenueListServices = Pick<AppServices, 'db' | 'env' | 'logger'>;

/**
 * Every stored city, in the order `config/cities.json` lists them (AAP 0.5.2, 0.5.4).
 *
 * The `City` rows are the source of truth for which cities exist — the seed loads them from that same
 * file — while the file fixes their order, so a city the configuration no longer lists sorts after
 * every configured one instead of vanishing from the response.
 *
 * @param services - The guarded database client.
 * @returns Every stored city, each as the five fields of `CityDto`.
 * @throws {ZkConfigurationError} When `config/cities.json` cannot be read.
 */
async function cityList(services: CityListServices): Promise<CitiesResponse> {
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

/** The configuration's city order, as slug to position. Read from the cached configuration. */
function cityOrder(): ReadonlyMap<string, number> {
  return new Map(
    readCitiesConfig().cities.map((city, index): [string, number] => [city.id, index]),
  );
}

/**
 * Orders two cities the way `GET /cities` answers them: configuration order first, then name, then
 * id, so the list is one total order whatever the database hands back (AAP 0.5.4). Names and ids are
 * compared by code unit rather than with `localeCompare`, which would make the order a function of
 * the host's locale data.
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
 * A city's active partner venues (AAP 0.5.4, 0.5.8).
 *
 * No proof is required: an unverified traveler browses where a meetup may be held, and
 * `422 venue_not_partner` is what rejects a proposal at any other place — which is why only active
 * partners are listed.
 *
 * A venue whose `location` is NULL is left out of the list and logged: `VenueDto` carries the
 * coordinates the client maps the venue by and the 150 m check-in geofence is measured from
 * (AAP 0.5.7), and a null coordinate is not a shape the contract has.
 *
 * @param services - The guarded client, the mode the fixture rule follows and the logger.
 * @param cityId - The city slug from the path.
 * @returns The city's active partner venues, each as the seven fields of `VenueDto`.
 * @throws AppError `city_not_found` (404) when no configured city carries `cityId`.
 */
async function cityVenues(services: VenueListServices, cityId: string): Promise<VenuesResponse> {
  if (cityBySlug(cityId) === undefined) {
    throw new AppError('city_not_found');
  }

  // The client's fixture guard narrows this read outside `test` and `demo`, so a fixture venue is
  // listed in those two environments alone (AAP 0.5.2). The select holds no secret column:
  // `secretLookupHash`, `secretCiphertext` and `secretIssuedAt` are never loaded (AAP 0.5.4).
  const venues = await services.db.venue.findMany({
    where: { cityId, isActivePartner: true },
    select: { id: true, cityId: true, name: true, address: true, isActivePartner: true },
    orderBy: { name: 'asc' },
  });

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
 * One page of travelers visible in a city (AAP 0.5.4, 0.5.7).
 *
 * This route's own part is the two guards, in the order AAP 0.5.4 lists them — `404 city_not_found`,
 * then `403 no_valid_proof` — and the single instant both the check and the page are judged at is
 * read once, so a proof reaching the end of its window cannot be rejected by one and accepted by the
 * other. The page, its keyset cursor and the block and unverified-reader rules belong to
 * `./discovery.ts`, which is also what refuses a malformed cursor as `400 invalid_field`.
 *
 * @param services - The app's services: the client, the clock and everything the page needs.
 * @param viewerId - The authenticated caller, from `request.auth`.
 * @param cityId - The city slug from the path.
 * @param cursor - The previous page's `nextCursor`, or `undefined` for the first page.
 * @returns The page of `Tier0Profile`s and, while rows remain, the cursor to continue from.
 * @throws AppError `city_not_found` (404), `no_valid_proof` (403) when the caller has no proof valid
 *   for this city now, and `invalid_field` (400) for a cursor this API did not write.
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
 * Registers the three city routes on the context `app.ts` mounts under `/v1` (AAP 0.5.1, 0.5.4).
 *
 * The guard is installed here, at route-group level, so these three routes are the only ones it
 * covers and a route outside this context cannot inherit the age gate by accident (AAP 0.5.4).
 * Registration is synchronous, as in every plugin the composition root installs — `clock.ts`,
 * `security.ts`, `openapi.ts`, `auth.ts`, `rate-limit.ts`, `raw-body.ts` and `websocket.ts` all
 * declare a `void` function — and the returned promise is what Fastify's plugin type expects.
 *
 * @param app - The route instance; its `services` carry the guarded database client, the injected
 *   clock, the logger and the configuration the three handlers read.
 * @see AAP 0.5.4 for the routes, their schemas and their errors, 0.5.8 for the unverified browsing
 *   states the client builds on the venue list's freedom from the proof check.
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
