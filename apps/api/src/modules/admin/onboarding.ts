/**
 * Operator-led venue and lodging onboarding: the two registry reads and the five writes behind `GET/POST
 * /admin/venues`, `PATCH /admin/venues/:id`, `POST /admin/venues/:id/secret`, `GET/POST /admin/lodgings` and
 * `POST /admin/lodgings/:id/secret`.
 * Console secrets: the issue routes mint 32 random bytes through `consoles/secrets.ts`, store them as a SHA-256 lookup
 * hash beside an AES-256-GCM ciphertext, and answer the plaintext once in `SecretIssued`. Re-issuing replaces both
 * stored forms, so the previous secret stops authenticating `X-Venue-Secret` and `X-Lodging-Secret` at once. Neither the
 * plaintext nor either stored form is ever selected into a DTO or logged: every query names its columns, and every log
 * line carries an event name and an id and nothing else.
 * `location` is a PostGIS `geography` column Prisma cannot write, so each create inserts its row and writes the point
 * through `setPoint(tx, …)` in the same transaction; a row whose location is NULL has no representable answer, so a
 * registry read leaves it out and logs it, and an update of one asks the operator for the coordinates rather than
 * answering an invented point. Every timestamp is the caller's `now`, never Prisma's `@default(now())`, so a test that
 * advances the injected clock sees these rows move with it.
 */

import type { Queue } from 'bullmq';
import { z } from 'zod';

import { readPoints, setPoint } from '@tablemate/db';
import type { DbClient, Prisma } from '@tablemate/db';
import { JOB, QUEUE, jobOptionsFor, parseJobData } from '@tablemate/server-core';
import type { Clock, CommonEnv, FieldKeyring, Logger, QueueName } from '@tablemate/server-core';
import { Uuid } from '@tablemate/shared';
import type {
  AdminLodgingDto,
  AdminLodgingsQuery,
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

export interface OnboardingServices extends TransactServices {
  readonly db: DbClient;
  /** The validated configuration, of which only `APP_ENV` is read: it decides fixture visibility. */
  readonly env: Pick<CommonEnv, 'APP_ENV'>;
  /**
   * The BullMQ producers the app built, keyed by queue name; `undefined` for a queue no producer was created for, which
   * leaves the refresh to the weekly scheduler instead of failing the request.
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
// A venue registry that came back with more rows than the bound below, logged under its own event so a truncated venue
// list is visible rather than silently read as a complete one. The line carries the bound and nothing else. The lodging
// registry needs no such line: it pages, so a page of it is no longer a truncation.
const ADMIN_VENUES_TRUNCATED = 'admin_venues_truncated';

/**
 * The venue registry's bound, and the page size {@link listLodgings} answers when its query names no `limit` — the same
 * batch size the sibling operator queue reads use (`ADMIN_CALL_TASKS_LIMIT`, `ADMIN_LODGING_CLAIMS_LIMIT`). It is also
 * the longest id list {@link listVenues} hands to `readPoints` as one `uuid[]` bind; the lodging read binds the ids of
 * the page its query asked for, which the contract bounds at 500.
 * Both registries answer in (city, name, id) order, so a bound on it answers deterministically: the same rows come back
 * from every read. For {@link listVenues} that bound is still the whole answer — AAP 0.5.4 carries no query for the venue
 * registry — so a larger one is made visible through {@link ADMIN_VENUES_TRUNCATED}. {@link listLodgings} reads the same
 * order as the page size of a read continued by a keyset cursor, so every lodging is reachable and the row past the page
 * is what says another page follows.
 * Each read asks for one row beyond its bound and treats that row as a sentinel: it is dropped before the ids reach
 * `readPoints`, and its presence is what reports the truncation — or, for the lodging read, what the next page's cursor
 * is built from.
 */
const ADMIN_REGISTRY_LIMIT = 200;

/**
 * The venue columns every answer here is built from: the public `VenueDto` fields plus the two facts only `/ops` shows.
 * `secretLookupHash` and `secretCiphertext` are absent by construction, so no answer can carry them.
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
 * The lodging columns every answer here is built from: the two operator-managed phone facts travel with the row, because
 * they are what the weekly refresh preserves.
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

/** Fields are copied one by one rather than spread, so a column added to `Venue` cannot reach an operator without a
 * change here. */
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

/**
 * Ordered by city, then name, with the id breaking a same-name tie so two reads agree. Active partners and paused ones
 * are both listed — pausing a venue is a status change, not a withdrawal from the registry — and a fixture venue is
 * listed only in `test` and `demo`, because the fixture guard narrows this read to `isFixture: false` everywhere else.
 * The venue registry's route carries no query at all, so this read is bounded rather than paged: the first
 * {@link ADMIN_REGISTRY_LIMIT} rows in that order are answered, and a registry holding more than that is reported
 * through `admin_venues_truncated` rather than answered as if it were complete.
 */
export async function listVenues(services: OnboardingServices): Promise<AdminVenuesResponse> {
  const rows = await services.db.venue.findMany({
    select: VENUE_SELECT,
    orderBy: [{ cityId: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    take: ADMIN_REGISTRY_LIMIT + 1,
  });
  // The row past the bound is a sentinel: its presence says there are more venues than this read answers, and it is dropped here so the id list below can never exceed ADMIN_REGISTRY_LIMIT.
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
      // No coordinate, so no DTO: the row is reported and left out rather than answered with a point it does not have.
      services.logger.warn({ event: VENUE_LOCATION_MISSING, venueId: row.id });
      continue;
    }
    items.push(toAdminVenueDto(row, point));
  }
  return { items };
}

/**
 * A strict object, so a cursor carrying a second key — or a payload of any other shape — is refused rather than
 * interpreted, and the field is named `i` to keep the encoded form short as the shared keyset codecs do. The id alone is
 * all the cursor can hold: `Cursor` is bounded at 200 characters and a lodging's name runs to 120, so a payload carrying
 * the row's whole sort key would not survive the bound. The row's own `(city, name)` are read back from the database
 * instead, for the reason {@link lodgingCursorBoundary} states.
 */
const LodgingsCursor = z.strictObject({ i: Uuid });

interface LodgingsCursorPosition {
  readonly cityId: string;
  readonly name: string;
  readonly id: string;
}

/**
 * The JSON value one cursor's text carries, or `null` for a value that is not one this read wrote.
 * A cursor is client-supplied text, so both steps are checked rather than trusted: the text has to be the canonical
 * base64url of what it decodes to, because a value this read did not write re-encodes to something else, and what it
 * decodes to has to be JSON. The payload's own shape is checked by the caller's schema.
 */
function decodeCursorPayload(value: string): unknown {
  const text = Buffer.from(value, 'base64url').toString('utf8');
  if (Buffer.from(text, 'utf8').toString('base64url') !== value) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function encodeLodgingsCursor(id: string): string {
  return Buffer.from(JSON.stringify(LodgingsCursor.parse({ i: id })), 'utf8').toString('base64url');
}

/**
 * The key is read from the row rather than carried in the cursor: what reaches the statement as a bound is this row's
 * stored `(cityId, name)`, never text the client supplied, so no caller can steer the next page to a position the
 * previous one did not end at.
 * @throws {AppError} `invalid_field` (400) when the cursor names no lodging the process may read, which is the
 *   contract's answer for a query value it cannot use — a row a refresh removed, or a fixture row outside `test` and
 *   `demo`, leaves a cursor this read cannot continue from.
 */
async function lodgingCursorBoundary(
  services: OnboardingServices,
  id: string,
): Promise<LodgingsCursorPosition> {
  const row = await services.db.lodging.findUnique({
    where: { id },
    select: { cityId: true, name: true },
  });
  if (row === null) {
    throw new AppError('invalid_field', 'The cursor names no lodging this registry lists.');
  }
  return { cityId: row.cityId, name: row.name, id };
}

/** The keyset half of the lodging read: every row ordered after `position` by `(cityId asc, name asc, id asc)`. */
function afterLodgingCursor(position: LodgingsCursorPosition): Prisma.LodgingWhereInput {
  return {
    OR: [
      { cityId: { gt: position.cityId } },
      { cityId: position.cityId, name: { gt: position.name } },
      { cityId: position.cityId, name: position.name, id: { gt: position.id } },
    ],
  };
}

/**
 * A lodging an OpenStreetMap refresh found missing carries `osmMissingAt` and has left the public directory, so it is
 * left out here too; its claims, activity facts and console secret stay attached, and it returns when the element
 * reappears in a refresh. A manually entered lodging has no `osmType`, no `osmId` and `phoneSource = operator`, which is
 * what keeps the refresh from replacing its phone number or removing it.
 * `total` counts the lodgings the request's filters match with the cursor ignored, so an operator reads how many rows the
 * page leaves behind. A row whose location is NULL has no `AdminLodgingDto` — the DTO requires `lat` and `lng` — so it is
 * left out of the answer and reported under {@link LODGING_LOCATION_MISSING} with its own id, which makes `items` one
 * element shorter than `total`; the page it sits in still counts toward the bound, so the row after it is reached.
 * @throws {AppError} `invalid_field` (400) for a cursor this read did not write, or one naming a lodging it can no
 *   longer continue from.
 */
export async function listLodgings(
  services: OnboardingServices,
  query: AdminLodgingsQuery,
): Promise<AdminLodgingsResponse> {
  const limit = query.limit ?? ADMIN_REGISTRY_LIMIT;
  const filters: Prisma.LodgingWhereInput[] = [{ osmMissingAt: null }];
  if (query.cityId !== undefined) {
    filters.push({ cityId: query.cityId });
  }
  if (query.q !== undefined) {
    filters.push({ name: { contains: query.q, mode: 'insensitive' } });
  }
  // Taken before the keyset half joins the list, and as a copy of it: `total` is how many lodgings the request's filters match, never how many of them follow the cursor.
  const matching: Prisma.LodgingWhereInput = { AND: [...filters] };
  if (query.cursor !== undefined) {
    const payload = LodgingsCursor.safeParse(decodeCursorPayload(query.cursor));
    if (!payload.success) {
      throw new AppError('invalid_field', 'The cursor is malformed.');
    }
    filters.push(afterLodgingCursor(await lodgingCursorBoundary(services, payload.data.i)));
  }
  const [rows, total] = await Promise.all([
    services.db.lodging.findMany({
      where: { AND: filters },
      select: LODGING_SELECT,
      orderBy: [{ cityId: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    }),
    services.db.lodging.count({ where: matching }),
  ]);
  // The row past the page is the sentinel: its presence says another page follows, it is dropped before the ids reach `readPoints`, and the cursor continues after the last row the page holds.
  const page = rows.slice(0, limit);
  const boundary = rows.length > limit ? page[page.length - 1] : undefined;
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
  return {
    items,
    total,
    nextCursor: boundary === undefined ? null : encodeLodgingsCursor(boundary.id),
  };
}

/**
 * The city must be configured, and a `placeId` must name a place of that same city: the link is what lets the price
 * pipeline find the venue's neighbours, and a place of another city would silently give it the wrong ones. The row is
 * stored with `isFixture: false` — the guard refuses the opposite outside `test` and `demo` — and becomes an active
 * partner unless the operator says otherwise, because a venue is onboarded so that meetups can be held there.
 * @throws {AppError} `city_not_found` for a city that is not configured, `not_found` for a `placeId` that names no place
 *   of that city.
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
 * Only the fields the request carries are written, so an operator changing a name cannot clear an address by omission.
 * `lat` and `lng` are supplied together — the request schema enforces it and so does the check below, because moving a
 * venue half-way would leave the 150 m check-in geofence measured from a point that is not the venue any more.
 * Deactivating a venue leaves every existing meetup where it is: a `locked` meetup settles at the venue that witnessed
 * it. A venue with no stored location must be given coordinates by this request, because no field of `AdminVenueDto` can
 * carry the absence of one.
 * @throws {AppError} `not_found` for an unknown venue — or a fixture venue, which the guard hides outside `test` and
 *   `demo` — and `invalid_field` for `lat` without `lng` or for an edit that leaves a venue with no stored location.
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
      // The refresh matters when the venue moved, or when it became one more place a meetup can be held at: both change the
      // distance bands and the neighbours the price pipeline walks.
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
 * The plaintext is answered once and never stored in the clear; re-issuing replaces both stored forms, so the console
 * that used the previous secret stops authenticating at once. An operator does this when a secret is lost, when a console
 * device is replaced, or when one may have leaked.
 * @throws {AppError} `not_found` for an unknown venue — or a fixture venue, which the guard hides outside `test` and
 *   `demo`.
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
 * The row is stored with no OpenStreetMap identity and with `phoneSource = operator`, which is what makes the weekly
 * refresh leave it alone: it never overwrites an operator-supplied number, never clears `doNotCall`, and never removes a
 * lodging for having disappeared from a query it was never part of. A `phone` of `null` is legitimate — a lodging with no
 * callable number sends every claim against it to the operator queue instead of dialing.
 * No place refresh is enqueued: a manually entered lodging is not a partner until a console secret is issued to it,
 * which {@link issueLodgingSecret} reacts to.
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
 * Issuing a secret is what makes a lodging a partner: its console can read the leaderboard standings, places within 2 km
 * of it enter the price pipeline, and the weekly refresh covers its city's lodgings. That is why the refresh is enqueued
 * here and not when the lodging row was created.
 * @throws {AppError} `not_found` for an unknown lodging — or a fixture lodging, which the guard hides outside `test` and
 *   `demo`.
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

/**
 * Called only from an `after` callback, so no transaction is still open and no row lock is held while Redis is spoken
 * to. No custom `jobId` is passed: a stable id would suppress a second request for the same city, and two onboardings in
 * one city want the refresh that follows each.
 * A missing producer or a failed `add` is logged and returns: the weekly `place-refresh` scheduler is the backstop for
 * exactly this case, and an operator's onboarding must not fail because the queue is unreachable. The log carries the
 * city alone — a queue error can quote the connection string, which holds the Redis password.
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
