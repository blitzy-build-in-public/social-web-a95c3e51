/**
 * Operator-led venue and lodging onboarding (AAP 0.5.1, 0.5.4, 0.5.6, 0.8.1): the two registry reads
 * and the five writes behind `GET/POST /admin/venues`, `PATCH /admin/venues/:id`,
 * `POST /admin/venues/:id/secret`, `GET/POST /admin/lodgings` and `POST /admin/lodgings/:id/secret`.
 * The route guard answers `403 operator_only` before any function here runs (AAP 0.5.4); none of them
 * reads `role`.
 *
 * **Console secrets (AAP 0.3.2).** The issue routes mint 32 random bytes through
 * `consoles/secrets.ts`, store them as a SHA-256 lookup hash beside an AES-256-GCM ciphertext — the
 * shape the seed writes for seeded consoles — and answer the plaintext once in `SecretIssued`, with
 * `Cache-Control: no-store` set by the route. Re-issuing replaces both stored forms, so the previous
 * secret stops authenticating `X-Venue-Secret` and `X-Lodging-Secret` at once. Neither the plaintext
 * nor either stored form is ever selected into a DTO or logged: every query below names its columns,
 * and every log line carries an event name and an id and nothing else.
 *
 * **Place refresh (AAP 0.5.6).** A new partner venue and a lodging that has just become one change
 * what the weekly OpenStreetMap refresh covers, so both enqueue that city's `place-refresh` job. The
 * enqueue runs in `after`, never inside the transaction, and a queue that cannot be reached is logged
 * and swallowed: the weekly scheduler is the backstop, and onboarding a venue must not fail because
 * Redis was busy (AAP 0.3.2).
 *
 * **Error codes.** AAP 0.5.4 fixes `404` for an unknown target. This module separates the two cases
 * the routes can meet, as every other city lookup does: an unknown city is `404 city_not_found`, and
 * an unknown venue, lodging or place is the generic `404 not_found`. `lat` without its `lng` is a
 * second `400 invalid_field` at this layer, so the rule holds however the function is reached.
 *
 * **Coordinates.** `location` is a PostGIS `geography` column Prisma cannot write, so each create
 * inserts its row and writes the point through `setPoint(tx, …)` in the same transaction
 * (AAP 0.2.1). Every DTO here requires `lat` and `lng`, so a row whose location is NULL has no
 * representable answer: a registry read leaves it out and logs it, and an update of one asks the
 * operator for the coordinates rather than answering with an invented point.
 *
 * **Time (AAP 0.11.1).** Every timestamp is the caller's `now` — `createdAt`, `updatedAt` and
 * `secretIssuedAt` — never Prisma's `@default(now())`/`@updatedAt`, so a test that advances the
 * injected clock sees these rows move with it, as the seed's fixtures do.
 *
 * @see AAP 0.3.2 for the console-secret format and the after-commit rule, 0.5.2 for the `Venue` and
 *   `Lodging` columns and the fixture guard these reads pass through, 0.5.4 for the routes and DTOs,
 *   0.5.6 for the place refresh and the manually entered lodging ingestion never touches, and 0.7.1
 *   item 10 for operator-led onboarding.
 */

import type { Queue } from 'bullmq';

import { readPoints, setPoint } from '@tablemate/db';
import type { DbClient } from '@tablemate/db';
import { JOB, QUEUE, jobOptionsFor, parseJobData } from '@tablemate/server-core';
import type { Clock, CommonEnv, FieldKeyring, Logger, QueueName } from '@tablemate/server-core';
import type {
  AdminLodgingDto,
  AdminLodgingsResponse,
  AdminVenueDto,
  AdminVenuesResponse,
  CreateLodgingRequest,
  CreateVenueRequest,
  LatLng,
  LodgingKind,
  PhoneSource,
  SecretIssued,
  UpdateVenueRequest,
} from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { issueSecret } from '../consoles/secrets.ts';
import { transact } from '../outbox/write.ts';
import type { TransactServices } from '../outbox/write.ts';

/**
 * What every function here needs from the app's services.
 *
 * It extends `TransactServices` — the `db`, `clock`, `logger` and `outbox` `transact` reads off the
 * object it is handed — and adds the three capabilities this module uses itself: the configuration's
 * `APP_ENV`, the BullMQ producers and the keyring. `db`, `clock` and `logger` are restated so their
 * own types are named here rather than inherited from the app's type. The composition root declares
 * the app's services type in `apps/api/src/app.ts`, which this file's dependency whitelist does not
 * admit, so the shape is stated here as the sibling admin modules state theirs (`admin/reports.ts`,
 * `admin/price-jobs.ts`, `admin/metrics.ts`): the app's services object satisfies it structurally,
 * and a test can stand a smaller double in for one member.
 */
export interface OnboardingServices extends TransactServices {
  /** The guarded Prisma client; its `city`, `place`, `venue` and `lodging` delegates are read. */
  readonly db: DbClient;
  /** The validated configuration, of which only `APP_ENV` is read: it decides fixture visibility. */
  readonly env: Pick<CommonEnv, 'APP_ENV'>;
  /**
   * The BullMQ producers the app built, keyed by queue name. `undefined` for a queue no producer was
   * created for, which leaves the refresh to the weekly scheduler instead of failing the request.
   */
  readonly queues: { get(name: QueueName): Queue | undefined };
  /** The keyring that writes the ciphertext of a newly issued console secret (AAP 0.3.2). */
  readonly keyring: FieldKeyring;
  /** The injected clock, which `transact` binds to the outbox rows of its own transaction. */
  readonly clock: Clock;
  /** The process logger; only an event name and an id are ever written through it (AAP 0.11.1). */
  readonly logger: Logger;
}

const VENUE_CREATED = 'venue_created';
const VENUE_UPDATED = 'venue_updated';
const VENUE_SECRET_ISSUED = 'venue_secret_issued';
const LODGING_CREATED = 'lodging_created';
const LODGING_SECRET_ISSUED = 'lodging_secret_issued';
const PLACE_REFRESH_ENQUEUE_FAILED = 'place_refresh_enqueue_failed';
// A row the registry cannot render, because its geography column is NULL, logged under its own
// event so the defect is visible rather than silent.
const VENUE_LOCATION_MISSING = 'admin_venue_location_missing';
const LODGING_LOCATION_MISSING = 'admin_lodging_location_missing';
// A registry read that came back with more rows than the bound below, logged under its own event
// so a truncated registry is visible rather than silently read as a complete one. The line carries
// the bound and nothing else (AAP 0.11.1).
const ADMIN_VENUES_TRUNCATED = 'admin_venues_truncated';
const ADMIN_LODGINGS_TRUNCATED = 'admin_lodgings_truncated';

/**
 * The bound on both registry reads, {@link listVenues} and {@link listLodgings}, and the largest id
 * list either of them hands to `readPoints` as one `uuid[]` bind.
 *
 * The operator queue reads in the sibling admin modules use the same batch size
 * (`ADMIN_CALL_TASKS_LIMIT` in `admin/call-tasks.ts`, `ADMIN_LODGING_CLAIMS_LIMIT` in
 * `admin/lodging-claims.ts`). Both reads are ordered by (city, name, id), so the bound answers
 * deterministically: the same rows come back from every read, and an operator that needs an older
 * row reads it in the database. The contract AAP 0.5.4 fixes for this route group carries no cursor
 * and no filter, so a cap is the resolution here rather than a contract change.
 *
 * Each read asks for one row beyond this bound and treats that row as a sentinel: it is dropped
 * before the ids reach `readPoints`, and its presence is what reports the truncation. A registry
 * silently cut to this many rows would read as a complete one, so the bound is made visible the
 * same way a row whose location is NULL is (AAP 0.5.4, 0.5.6, 0.11.1).
 */
const ADMIN_REGISTRY_LIMIT = 200;

/**
 * The venue columns every answer here is built from (AAP 0.5.4): the public `VenueDto` fields plus the
 * two facts only `/ops` shows. `secretLookupHash` and `secretCiphertext` are absent by construction,
 * so no answer can carry them.
 */
export interface AdminVenueRow {
  readonly id: string;
  readonly cityId: string;
  readonly name: string;
  readonly address: string;
  readonly isActivePartner: boolean;
  readonly isFixture: boolean;
  readonly secretIssuedAt: Date | null;
}

/**
 * The lodging columns every answer here is built from (AAP 0.5.4, 0.5.6): the two operator-managed
 * phone facts travel with the row, because they are what the weekly refresh preserves.
 */
export interface AdminLodgingRow {
  readonly id: string;
  readonly cityId: string;
  readonly name: string;
  readonly kind: LodgingKind;
  readonly address: string | null;
  readonly phone: string | null;
  readonly isFixture: boolean;
  readonly secretIssuedAt: Date | null;
  readonly phoneSource: PhoneSource;
  readonly doNotCall: boolean;
}

const VENUE_SELECT = {
  id: true,
  cityId: true,
  name: true,
  address: true,
  isActivePartner: true,
  isFixture: true,
  secretIssuedAt: true,
} as const;

const LODGING_SELECT = {
  id: true,
  cityId: true,
  name: true,
  kind: true,
  address: true,
  phone: true,
  isFixture: true,
  secretIssuedAt: true,
  phoneSource: true,
  doNotCall: true,
} as const;

/**
 * One registry row as the dashboard reads it (AAP 0.5.4).
 *
 * Fields are copied one by one rather than spread, so a column added to `Venue` cannot reach an
 * operator without a change here.
 *
 * @param row - The selected venue columns.
 * @param point - The venue's own coordinates, read from its geography column.
 * @returns The venue as `GET /admin/venues` and the create and update routes answer it.
 */
export function toAdminVenueDto(row: AdminVenueRow, point: LatLng): AdminVenueDto {
  return {
    id: row.id,
    cityId: row.cityId,
    name: row.name,
    address: row.address,
    lat: point.lat,
    lng: point.lng,
    isActivePartner: row.isActivePartner,
    isFixture: row.isFixture,
    secretIssuedAt: row.secretIssuedAt === null ? null : row.secretIssuedAt.toISOString(),
  };
}

/**
 * One lodging as `GET /admin/lodgings` and the lodging create route answer it (AAP 0.5.4).
 *
 * @param row - The selected lodging columns.
 * @param point - The lodging's own coordinates, read from its geography column.
 * @returns The lodging, with its phone source and do-not-call flag spelled out.
 */
export function toAdminLodgingDto(row: AdminLodgingRow, point: LatLng): AdminLodgingDto {
  return {
    id: row.id,
    cityId: row.cityId,
    name: row.name,
    kind: row.kind,
    address: row.address,
    phone: row.phone,
    lat: point.lat,
    lng: point.lng,
    isFixture: row.isFixture,
    secretIssuedAt: row.secretIssuedAt === null ? null : row.secretIssuedAt.toISOString(),
    phoneSource: row.phoneSource,
    doNotCall: row.doNotCall,
  };
}

// ---------------------------------------------------------------------------------------------
// Reads (AAP 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * The venue registry.
 *
 * Ordered by city, then name, with the id breaking a same-name tie so two reads agree. Active
 * partners and paused ones are both listed — pausing a venue is a status change, not a withdrawal
 * from the registry — and a fixture venue is listed only in `test` and `demo`, because the fixture
 * guard narrows this read to `isFixture: false` everywhere else (AAP 0.5.2). `readPoints` applies the
 * same rule, so both reads agree on what exists.
 *
 * The contract carries no cursor and no filter (AAP 0.5.4), so the read is bounded instead of paged:
 * the first {@link ADMIN_REGISTRY_LIMIT} rows in the (city, name, id) order above are answered, and a
 * registry holding more than that is reported through `admin_venues_truncated` rather than answered as
 * if it were complete (AAP 0.11.1).
 *
 * @param services - The app's services (see {@link OnboardingServices}).
 * @returns The first {@link ADMIN_REGISTRY_LIMIT} venues the process may see, in (city, name, id)
 *   order, with their coordinates and their secret issue time.
 */
export async function listVenues(services: OnboardingServices): Promise<AdminVenuesResponse> {
  const rows = await services.db.venue.findMany({
    select: VENUE_SELECT,
    orderBy: [{ cityId: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    take: ADMIN_REGISTRY_LIMIT + 1,
  });

  // The row past the bound is a sentinel: its presence says there are more venues than this read
  // answers, and it is dropped here so the id list below can never exceed ADMIN_REGISTRY_LIMIT.
  const truncated = rows.length > ADMIN_REGISTRY_LIMIT;
  const page = truncated ? rows.slice(0, ADMIN_REGISTRY_LIMIT) : rows;

  if (truncated) {
    services.logger.warn({ event: ADMIN_VENUES_TRUNCATED, limit: ADMIN_REGISTRY_LIMIT });
  }

  const points = await readPoints(
    services.db,
    'venue',
    page.map((row) => row.id),
    services.env.APP_ENV,
  );

  const items: AdminVenueDto[] = [];

  for (const row of page) {
    const point = points.get(row.id);

    if (point === undefined) {
      // No coordinate, so no DTO: the row is reported and left out rather than answered with a point
      // it does not have.
      services.logger.warn({ event: VENUE_LOCATION_MISSING, venueId: row.id });
      continue;
    }

    items.push(toAdminVenueDto(row, point));
  }

  return { items };
}

/**
 * The lodging registry.
 *
 * A lodging an OpenStreetMap refresh found missing carries `osmMissingAt` and has left the public
 * directory, so it is left out here too; its claims, activity facts and console secret stay attached,
 * and it returns when the element reappears in a refresh. A manually entered lodging has no
 * `osmType`, no `osmId` and `phoneSource = operator`, which is what keeps the refresh from replacing
 * its phone number or removing it (AAP 0.5.6). Ordered and bounded exactly as {@link listVenues} is:
 * the first {@link ADMIN_REGISTRY_LIMIT} rows in (city, name, id) order are answered, and a larger
 * registry is reported through `admin_lodgings_truncated`. The bound is what keeps this read off a
 * table the weekly refresh adds to with every element it finds (AAP 0.5.6).
 *
 * @param services - The app's services (see {@link OnboardingServices}).
 * @returns The first {@link ADMIN_REGISTRY_LIMIT} current lodgings the process may see, in
 *   (city, name, id) order, with their coordinates and phone facts.
 */
export async function listLodgings(services: OnboardingServices): Promise<AdminLodgingsResponse> {
  const rows = await services.db.lodging.findMany({
    where: { osmMissingAt: null },
    select: LODGING_SELECT,
    orderBy: [{ cityId: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    take: ADMIN_REGISTRY_LIMIT + 1,
  });

  // The sentinel row, dropped before the ids reach `readPoints`, exactly as in {@link listVenues}.
  const truncated = rows.length > ADMIN_REGISTRY_LIMIT;
  const page = truncated ? rows.slice(0, ADMIN_REGISTRY_LIMIT) : rows;

  if (truncated) {
    services.logger.warn({ event: ADMIN_LODGINGS_TRUNCATED, limit: ADMIN_REGISTRY_LIMIT });
  }

  const points = await readPoints(
    services.db,
    'lodging',
    page.map((row) => row.id),
    services.env.APP_ENV,
  );

  const items: AdminLodgingDto[] = [];

  for (const row of page) {
    const point = points.get(row.id);

    if (point === undefined) {
      services.logger.warn({ event: LODGING_LOCATION_MISSING, lodgingId: row.id });
      continue;
    }

    items.push(toAdminLodgingDto(row, point));
  }

  return { items };
}

// ---------------------------------------------------------------------------------------------
// Writes (AAP 0.5.4, 0.5.6)
// ---------------------------------------------------------------------------------------------

/**
 * Onboards one venue as a partner (requirement 10).
 *
 * The city must be configured, and a `placeId` must name a place of that same city: the link is what
 * lets the price pipeline find the venue's neighbours, and a place of another city would silently
 * give it the wrong ones. The row is stored with `isFixture: false` — the guard refuses the opposite
 * outside `test` and `demo` — and becomes an active partner unless the operator says otherwise,
 * because a venue is onboarded so that meetups can be held there (`422 venue_not_partner` is what
 * rejects a proposal anywhere else).
 *
 * @param services - The app's services (see {@link OnboardingServices}).
 * @param operatorId - The acting operator, whose row the write fence is taken on (AAP 0.5.3).
 * @param body - The validated `CreateVenueRequest`.
 * @param now - The injected clock's instant, stored as `createdAt` and `updatedAt`.
 * @returns The new venue, as the route's `201` body.
 * @throws {AppError} `city_not_found` for a city that is not configured, `not_found` for a `placeId`
 *   that names no place of that city.
 */
export async function createVenue(
  services: OnboardingServices,
  operatorId: string,
  body: CreateVenueRequest,
  now: Date,
): Promise<AdminVenueDto> {
  return transact(
    services,
    async (tx, after) => {
      const city = await tx.city.findUnique({ where: { id: body.cityId }, select: { id: true } });

      if (city === null) {
        throw new AppError('city_not_found');
      }

      if (body.placeId !== undefined) {
        const place = await tx.place.findFirst({
          where: { id: body.placeId, cityId: body.cityId },
          select: { id: true },
        });

        if (place === null) {
          throw new AppError('not_found');
        }
      }

      const row = await tx.venue.create({
        data: {
          cityId: body.cityId,
          placeId: body.placeId ?? null,
          name: body.name,
          address: body.address,
          isActivePartner: body.isActivePartner ?? true,
          isFixture: false,
          createdAt: now,
          updatedAt: now,
        },
        select: VENUE_SELECT,
      });

      const point: LatLng = { lat: body.lat, lng: body.lng };
      await setPoint(tx, 'venue', row.id, point);

      // After the commit, so the refresh reads the venue that is actually stored (AAP 0.3.2).
      after(() => enqueuePlaceRefresh(services, row.cityId));
      after(() => {
        services.logger.info({ event: VENUE_CREATED, venueId: row.id, cityId: row.cityId });
      });

      return toAdminVenueDto(row, point);
    },
    { fenceUserId: operatorId },
  );
}

/**
 * Edits one venue's name, address, coordinates or partner status.
 *
 * Only the fields the request carries are written, so an operator changing a name cannot clear an
 * address by omission. `lat` and `lng` are supplied together — the request schema enforces it and so
 * does the check below, because moving a venue half-way would leave the 150 m check-in geofence
 * measured from a point that is not the venue any more (AAP 0.5.7). Deactivating a venue leaves every
 * existing meetup where it is: a `locked` meetup settles at the venue that witnessed it.
 *
 * A venue with no stored location must be given coordinates by this request, because no field of
 * `AdminVenueDto` can carry the absence of one.
 *
 * @param services - The app's services (see {@link OnboardingServices}).
 * @param operatorId - The acting operator, whose row the write fence is taken on (AAP 0.5.3).
 * @param venueId - The venue to edit.
 * @param body - The validated `UpdateVenueRequest`, holding at least one field.
 * @param now - The injected clock's instant, stored as `updatedAt`.
 * @returns The venue as it stands after the edit.
 * @throws {AppError} `not_found` for an unknown venue — or a fixture venue, which the guard hides
 *   outside `test` and `demo` — and `invalid_field` for `lat` without `lng` or for an edit that
 *   leaves a venue with no stored location without supplying one.
 */
export async function updateVenue(
  services: OnboardingServices,
  operatorId: string,
  venueId: string,
  body: UpdateVenueRequest,
  now: Date,
): Promise<AdminVenueDto> {
  return transact(
    services,
    async (tx, after) => {
      if ((body.lat === undefined) !== (body.lng === undefined)) {
        throw new AppError('invalid_field');
      }

      const current = await tx.venue.findUnique({
        where: { id: venueId },
        select: { id: true, isActivePartner: true },
      });

      if (current === null) {
        throw new AppError('not_found');
      }

      const supplied =
        body.lat !== undefined && body.lng !== undefined
          ? { lat: body.lat, lng: body.lng }
          : undefined;
      const stored = (await readPoints(tx, 'venue', [venueId], services.env.APP_ENV)).get(venueId);
      const point = supplied ?? stored;

      if (point === undefined) {
        throw new AppError('invalid_field', 'Supply `lat` and `lng`: the venue has no location.');
      }

      const row = await tx.venue.update({
        where: { id: venueId },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.address === undefined ? {} : { address: body.address }),
          ...(body.isActivePartner === undefined ? {} : { isActivePartner: body.isActivePartner }),
          updatedAt: now,
        },
        select: VENUE_SELECT,
      });

      if (supplied !== undefined) {
        await setPoint(tx, 'venue', venueId, supplied);
      }

      // The refresh matters when the venue moved, or when it became one more place a meetup can be
      // held at: both change the distance bands and the neighbours the price pipeline walks
      // (AAP 0.5.6, 0.5.7).
      const moved =
        supplied !== undefined &&
        (stored === undefined || stored.lat !== supplied.lat || stored.lng !== supplied.lng);

      if (moved || (body.isActivePartner === true && !current.isActivePartner)) {
        after(() => enqueuePlaceRefresh(services, row.cityId));
      }

      after(() => {
        services.logger.info({ event: VENUE_UPDATED, venueId: row.id, cityId: row.cityId });
      });

      return toAdminVenueDto(row, point);
    },
    { fenceUserId: operatorId },
  );
}

/**
 * Issues — or re-issues — one venue's console secret (AAP 0.3.2).
 *
 * The plaintext is answered once and never stored in the clear; re-issuing replaces both stored
 * forms, so the console that used the previous secret stops authenticating at once. An operator does
 * this when a secret is lost, when a console device is replaced, or when one may have leaked.
 *
 * @param services - The app's services (see {@link OnboardingServices}).
 * @param operatorId - The acting operator, whose row the write fence is taken on (AAP 0.5.3).
 * @param venueId - The venue whose secret is issued.
 * @param now - The injected clock's instant, stored as `secretIssuedAt`.
 * @returns The plaintext secret, for that one answer.
 * @throws {AppError} `not_found` for an unknown venue — or a fixture venue, which the guard hides
 *   outside `test` and `demo`.
 */
export async function issueVenueSecret(
  services: OnboardingServices,
  operatorId: string,
  venueId: string,
  now: Date,
): Promise<SecretIssued> {
  return transact(
    services,
    async (tx, after) => {
      const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { id: true } });

      if (venue === null) {
        throw new AppError('not_found');
      }

      const material = issueSecret(services);

      await tx.venue.update({
        where: { id: venueId },
        data: {
          secretLookupHash: material.secretLookupHash,
          secretCiphertext: material.secretCiphertext,
          secretIssuedAt: now,
          updatedAt: now,
        },
        select: { id: true },
      });

      after(() => {
        services.logger.info({ event: VENUE_SECRET_ISSUED, venueId });
      });

      return { secret: material.secret };
    },
    { fenceUserId: operatorId },
  );
}

/**
 * Enters one lodging by hand (requirement 15).
 *
 * The row is stored with no OpenStreetMap identity and with `phoneSource = operator`, which is what
 * makes the weekly refresh leave it alone: it never overwrites an operator-supplied number, never
 * clears `doNotCall`, and never removes a lodging for having disappeared from a query it was never
 * part of (AAP 0.5.6). A `phone` of `null` is legitimate — a lodging with no callable number sends
 * every claim against it to the operator queue instead of dialing (AAP 0.5.3).
 *
 * No place refresh is enqueued: a manually entered lodging is not a partner until a console secret is
 * issued to it, which {@link issueLodgingSecret} reacts to.
 *
 * @param services - The app's services (see {@link OnboardingServices}).
 * @param operatorId - The acting operator, whose row the write fence is taken on (AAP 0.5.3).
 * @param body - The validated `CreateLodgingRequest`.
 * @param now - The injected clock's instant, stored as `createdAt` and `updatedAt`.
 * @returns The new lodging, as the route's `201` body.
 * @throws {AppError} `city_not_found` for a city that is not configured.
 */
export async function createLodging(
  services: OnboardingServices,
  operatorId: string,
  body: CreateLodgingRequest,
  now: Date,
): Promise<AdminLodgingDto> {
  return transact(
    services,
    async (tx, after) => {
      const city = await tx.city.findUnique({ where: { id: body.cityId }, select: { id: true } });

      if (city === null) {
        throw new AppError('city_not_found');
      }

      const row = await tx.lodging.create({
        data: {
          cityId: body.cityId,
          osmType: null,
          osmId: null,
          name: body.name,
          kind: body.kind,
          address: body.address,
          phone: body.phone,
          phoneSource: 'operator',
          doNotCall: false,
          isFixture: false,
          createdAt: now,
          updatedAt: now,
        },
        select: LODGING_SELECT,
      });

      const point: LatLng = { lat: body.lat, lng: body.lng };
      await setPoint(tx, 'lodging', row.id, point);

      after(() => {
        services.logger.info({ event: LODGING_CREATED, lodgingId: row.id, cityId: row.cityId });
      });

      return toAdminLodgingDto(row, point);
    },
    { fenceUserId: operatorId },
  );
}

/**
 * Issues — or re-issues — one lodging's console secret (AAP 0.3.2, 0.5.6).
 *
 * Issuing a secret is what makes a lodging a partner: its console can read the leaderboard standings,
 * places within 2 km of it enter the price pipeline, and the weekly refresh covers its city's
 * lodgings. That is why the refresh is enqueued here and not when the lodging row was created.
 *
 * @param services - The app's services (see {@link OnboardingServices}).
 * @param operatorId - The acting operator, whose row the write fence is taken on (AAP 0.5.3).
 * @param lodgingId - The lodging whose secret is issued.
 * @param now - The injected clock's instant, stored as `secretIssuedAt`.
 * @returns The plaintext secret, for that one answer.
 * @throws {AppError} `not_found` for an unknown lodging — or a fixture lodging, which the guard
 *   hides outside `test` and `demo`.
 */
export async function issueLodgingSecret(
  services: OnboardingServices,
  operatorId: string,
  lodgingId: string,
  now: Date,
): Promise<SecretIssued> {
  return transact(
    services,
    async (tx, after) => {
      const lodging = await tx.lodging.findUnique({
        where: { id: lodgingId },
        select: { id: true, cityId: true },
      });

      if (lodging === null) {
        throw new AppError('not_found');
      }

      const material = issueSecret(services);

      await tx.lodging.update({
        where: { id: lodgingId },
        data: {
          secretLookupHash: material.secretLookupHash,
          secretCiphertext: material.secretCiphertext,
          secretIssuedAt: now,
          updatedAt: now,
        },
        select: { id: true },
      });

      after(() => enqueuePlaceRefresh(services, lodging.cityId));
      after(() => {
        services.logger.info({ event: LODGING_SECRET_ISSUED, lodgingId });
      });

      return { secret: material.secret };
    },
    { fenceUserId: operatorId },
  );
}

// ---------------------------------------------------------------------------------------------
// Place refresh (AAP 0.5.6)
// ---------------------------------------------------------------------------------------------

/**
 * Enqueues one city's place refresh, after the change that made it necessary has committed.
 *
 * Called only from an `after` callback, so no transaction is still open and no row lock is held while
 * Redis is spoken to (AAP 0.3.2). No custom `jobId` is passed: a stable id would suppress a second
 * request for the same city, and two onboardings in one city want the refresh that follows each.
 *
 * A missing producer or a failed `add` is logged and returns: the weekly `place-refresh` scheduler is
 * the backstop for exactly this case, and an operator's onboarding must not fail because the queue is
 * unreachable. The log carries the city alone — a queue error can quote the connection string, which
 * holds the Redis password (AAP 0.11.1).
 *
 * @param services - The app's services (see {@link OnboardingServices}).
 * @param cityId - The city whose places, lodgings and distance bands are refreshed.
 * @returns Nothing; the work is the job's.
 */
async function enqueuePlaceRefresh(services: OnboardingServices, cityId: string): Promise<void> {
  const queueName = QUEUE.placeRefresh;
  const jobName = JOB[queueName].refresh;
  const queue = services.queues.get(queueName);

  if (queue === undefined) {
    services.logger.error({ event: PLACE_REFRESH_ENQUEUE_FAILED, cityId });
    return;
  }

  try {
    await queue.add(
      jobName,
      parseJobData(queueName, jobName, { cityId }),
      jobOptionsFor(queueName),
    );
  } catch {
    services.logger.error({ event: PLACE_REFRESH_ENQUEUE_FAILED, cityId });
  }
}
