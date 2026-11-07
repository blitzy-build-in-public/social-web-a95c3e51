/**
 * The city routes' integration suite (AAP 0.8.1; AAP 0.5.4 names this file for `GET /cities`,
 * `GET /cities/:cityId/venues` and `GET /cities/:cityId/travelers`).
 *
 * Four phases, one per shape of the contract, and each asserts a rule rather than a response:
 *
 *  - `GET /cities` answers the configured cities in `config/cities.json` order, and the guard the
 *    route group installs answers `403 age_gate_required` to a caller who has not accepted the terms
 *    (AAP 0.5.4).
 *  - `GET /cities/:cityId/venues` requires no proof, so an unverified traveler browses where a
 *    meetup may be held (AAP 0.5.8); it lists active partners alone, and every item carries exactly
 *    the seven `VenueDto` fields, with the venue's own coordinates and no console secret.
 *  - `GET /cities/:cityId/travelers` answers its errors in the order AAP 0.5.4 lists them —
 *    `404 city_not_found` before `403 no_valid_proof` before `400 invalid_field` for a cursor this
 *    API did not write — which is why the error table names the caller each row needs.
 *  - The listing itself is the keyset pagination, the exclusions and the unverified-reader rule of
 *    AAP 0.5.1 and 0.5.7, and every traveler on a page is a `Tier0Profile` and nothing wider.
 *
 * The expected cities and their slugs are read from `config/cities.json` through the contract's own
 * `CitiesFile` schema rather than hard-coded, the keys a response carries are compared with
 * `TIER_FIELDS` and `VenueDto` rather than with a copy of either, and every instant comes from the
 * injected test clock, which `resetState` returns to `DEFAULT_TEST_NOW`, so a case crosses a proof's
 * validity boundary instead of waiting for it (AAP 0.11.1). One app serves the file, with
 * `resetState` plus `seedCities` between cases, so no case reads a row another wrote (AAP 0.11.2).
 *
 * @see AAP 0.5.2 for the models and the fixture rules, 0.5.4 for the three routes, their schemas,
 *   their errors and their guard scope, 0.5.7 for proof validity and the discovery rules, 0.5.8 for
 *   the venue list an unverified traveler may browse, and 0.11.2 for the harness this file drives.
 */

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CitiesFile,
  CitiesResponse,
  PAGE_SIZE,
  TIER_FIELDS,
  Tier0Profile,
  TravelersResponse,
  VenueDto,
  VenuesResponse,
} from '@tablemate/shared';
import type { CityConfig, ErrorCode } from '@tablemate/shared';

import { createTestApp } from '../support/app.ts';
import {
  callRoute,
  expectError,
  keysDeep,
  makeBlock,
  makeMeetup,
  makeProof,
  makeUser,
  makeVenue,
  rows,
} from '../support/factories.ts';
import type { RouteResponse, UserFixture } from '../support/factories.ts';

import type { TestApp } from '../support/app.ts';

/* The configuration the suite asserts against (AAP 0.5.2) */

/** `config/cities.json`, resolved from this file rather than from the process's working directory. */
const CITIES_CONFIG_PATH = fileURLToPath(
  new URL('../../../../config/cities.json', import.meta.url),
);

/**
 * The launch cities as `config/cities.json` lists them, parsed by the contract's own schema: the
 * file's order is the contract `GET /cities` answers in, so every expectation about the list or about
 * a slug comes from here and a city added to the pilot changes what this suite expects (AAP 0.5.2).
 */
const LAUNCH_CITIES: readonly CityConfig[] = CitiesFile.parse(
  JSON.parse(readFileSync(CITIES_CONFIG_PATH, 'utf8')) as unknown,
).cities;

/** One configured city by slug. */
function configuredCity(slug: string): CityConfig {
  const found = LAUNCH_CITIES.find((city) => city.id === slug);
  if (found === undefined) {
    throw new Error(`${CITIES_CONFIG_PATH} holds no city "${slug}"`);
  }
  return found;
}

/** The city the venue and discovery cases work in. */
const PRIMARY_CITY = configuredCity('lisbon');

/** A second launch city: where a proof, a venue or a traveler must NOT be found. */
const OTHER_CITY = configuredCity('mexico-city');

/** A slug no configured city carries, which is what the two `404 city_not_found` cases ask for. */
const UNKNOWN_CITY = 'atlantis';

/**
 * Text a client could produce and this API could not: base64url of a JSON object that is not a keyset
 * cursor, so it clears the 200-character `Cursor` a route validates and reaches the decoder that
 * refuses it (AAP 0.5.4).
 */
const GARBAGE_CURSOR = Buffer.from('{"not":"a cursor"}', 'utf8').toString('base64url');

/**
 * How many travelers the pagination case adds beyond one full page, so its second page is short and
 * the case crosses both boundaries (AAP 0.5.1).
 */
const EXTRA_TRAVELERS = 5;

/** The path of a city's venue list. */
function venuesPath(cityId: string): string {
  return `/v1/cities/${encodeURIComponent(cityId)}/venues`;
}

/** The path of a city's traveler list. */
function travelersPath(cityId: string): string {
  return `/v1/cities/${encodeURIComponent(cityId)}/travelers`;
}

/* The harness (AAP 0.11.2) */

/** The one app every case of this file drives. */
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
});

afterAll(async () => {
  await t.close();
});

/**
 * Inject a `GET` as `actor`. The token is signed per request, so a case that moved the test clock
 * still acts as the same account, and a case without a cursor sends no query string at all.
 */
async function getAs(
  app: TestApp,
  actor: UserFixture,
  url: string,
  cursor?: string,
): Promise<RouteResponse> {
  return callRoute(app.app, {
    method: 'GET',
    url,
    as: await app.tokenFor(actor),
    ...(cursor === undefined ? {} : { query: { cursor } }),
  });
}

/** The account ids a page lists, in the order it lists them. */
function idsOf(page: TravelersResponse): string[] {
  return page.items.map((item) => item.id);
}

/** The one element of a list a case has already asserted the length of. */
function onlyItem<T>(items: readonly T[]): T {
  const first = items[0];
  if (first === undefined) {
    throw new Error('expected a one-item list, received none');
  }
  return first;
}

/**
 * A traveler holding a valid proof for `cityId` now: what discovery lists, unless the account is
 * tombstoned or fenced by a deletion request, which is what an exclusion case builds (AAP 0.5.2). No
 * card is attached: a provider customer for each of the twenty-six accounts of the pagination case
 * would be traffic no assertion here observes.
 */
async function provenTraveler(
  app: TestApp,
  cityId: string = PRIMARY_CITY.id,
  state: 'active' | 'deleted' | 'deletionRequested' = 'active',
): Promise<UserFixture> {
  const user = await makeUser(app, {
    card: 'none',
    deleted: state === 'deleted',
    deletionRequested: state === 'deletionRequested',
  });
  await makeProof(app, user, { cityId });

  return user;
}

/* GET /cities (AAP 0.5.4) */

describe('GET /cities', () => {
  it('answers every configured city in the order config/cities.json lists them', async () => {
    const viewer = await makeUser(t, { card: 'none' });

    const response = await getAs(t, viewer, '/v1/cities');

    expect(response.status).toBe(200);
    const cities = CitiesResponse.parse(response.json());
    expect(cities.items.map((city) => city.id)).toEqual(LAUNCH_CITIES.map((city) => city.id));
    expect(cities.items).toHaveLength(LAUNCH_CITIES.length);
  });

  it('refuses a caller who has not confirmed the age gate and the terms', async () => {
    const viewer = await makeUser(t, { consents: false, card: 'none' });

    const response = await getAs(t, viewer, '/v1/cities');

    expectError(response, 403, 'age_gate_required');
  });
});

/* GET /cities/:cityId/venues (AAP 0.5.4, 0.5.8) */

describe('GET /cities/:cityId/venues', () => {
  it('answers 404 city_not_found for a slug the configuration does not carry', async () => {
    expect(LAUNCH_CITIES.map((city) => city.id)).not.toContain(UNKNOWN_CITY);
    const viewer = await makeUser(t, { card: 'none' });

    const response = await getAs(t, viewer, venuesPath(UNKNOWN_CITY));

    expectError(response, 404, 'city_not_found');
  });

  it("lists only the city's active partner venues, and needs no proof", async () => {
    // No proof anywhere: the venue list is what an unverified traveler browses (AAP 0.5.8).
    const viewer = await makeUser(t, { card: 'none' });
    const first = await makeVenue(t, { cityId: PRIMARY_CITY.id });
    const second = await makeVenue(t, { cityId: PRIMARY_CITY.id });
    const inactive = await makeVenue(t, { cityId: PRIMARY_CITY.id, isActivePartner: false });
    const elsewhere = await makeVenue(t, { cityId: OTHER_CITY.id });

    const response = await getAs(t, viewer, venuesPath(PRIMARY_CITY.id));

    expect(response.status).toBe(200);
    const venues = VenuesResponse.parse(response.json());
    const ids = venues.items.map((item) => item.id);
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(ids).not.toContain(inactive.id);
    expect(ids).not.toContain(elsewhere.id);
  });

  it('answers exactly the seven VenueDto fields, with the venue co-ordinates and no secret', async () => {
    const viewer = await makeUser(t, { card: 'none' });
    const lat = 38.712345;
    const lng = -9.145678;
    const venue = await makeVenue(t, { cityId: PRIMARY_CITY.id, lat, lng });

    const response = await getAs(t, viewer, venuesPath(PRIMARY_CITY.id));

    expect(response.status).toBe(200);
    // The keys are read off the wire, where an extra column would show: the response schema strips
    // unknown keys, so a parsed item alone could not prove the field list (AAP 0.5.4).
    const wire = response.json<{ items: Record<string, unknown>[] }>();
    const item = onlyItem(wire.items);
    expect(Object.keys(item).sort()).toEqual([
      'address',
      'cityId',
      'id',
      'isActivePartner',
      'lat',
      'lng',
      'name',
    ]);

    const dto = VenueDto.parse(item);
    expect(dto.id).toBe(venue.id);
    expect(dto.cityId).toBe(PRIMARY_CITY.id);
    expect(dto.isActivePartner).toBe(true);
    expect(dto.lat).toBeCloseTo(lat, 6);
    expect(dto.lng).toBeCloseTo(lng, 6);
    // Neither `secretLookupHash` nor `secretCiphertext` is a field of `VenueDto`, and a console
    // secret is shown once by its issue route alone (AAP 0.5.4).
    expect(response.body).not.toContain('secret');
  });
});

/* GET /cities/:cityId/travelers: the errors, in the order AAP 0.5.4 lists them */

/**
 * One row of the traveler list's error table. The rows are ordered as the route checks them —
 * `404 city_not_found` before `403 no_valid_proof` before the cursor, and never a proof failure where
 * a city does not exist — which is why the first row asks for an unknown city as a caller holding no
 * proof at all (AAP 0.5.4).
 */
interface TravelerErrorRow {
  /** What the row shows, read as part of the case title. */
  readonly case: string;
  /** What the caller's proofs are: none, an expired one, one for another city, or a valid one. */
  readonly caller: 'none' | 'expired' | 'otherCity' | 'valid';
  readonly cityId: string;
  /** The `cursor` the request carries; a row without one sends no query string. */
  readonly cursor?: string;
  readonly status: number;
  readonly code: ErrorCode;
}

const TRAVELER_ERROR_ROWS = rows<TravelerErrorRow>([
  {
    case: 'an unknown city, checked before the proof',
    caller: 'none',
    cityId: UNKNOWN_CITY,
    status: 404,
    code: 'city_not_found',
  },
  {
    case: 'a caller holding no proof at all',
    caller: 'none',
    cityId: PRIMARY_CITY.id,
    status: 403,
    code: 'no_valid_proof',
  },
  {
    case: 'a caller whose only proof for the city has expired',
    caller: 'expired',
    cityId: PRIMARY_CITY.id,
    status: 403,
    code: 'no_valid_proof',
  },
  {
    case: 'a caller whose valid proof is for another city',
    caller: 'otherCity',
    cityId: PRIMARY_CITY.id,
    status: 403,
    code: 'no_valid_proof',
  },
  {
    case: 'a cursor that is not a cursor this API wrote',
    caller: 'valid',
    cityId: PRIMARY_CITY.id,
    cursor: '%%%',
    status: 400,
    code: 'invalid_field',
  },
  {
    case: 'a cursor decoding to a payload of another shape',
    caller: 'valid',
    cityId: PRIMARY_CITY.id,
    cursor: GARBAGE_CURSOR,
    status: 400,
    code: 'invalid_field',
  },
]);

/**
 * The caller a row needs. An expired proof is a real row whose window closed: `validNow: false` puts
 * the stay thirty days back, so the caller holds a proof and none that is valid now (AAP 0.5.7).
 */
async function callerFor(app: TestApp, kind: TravelerErrorRow['caller']): Promise<UserFixture> {
  if (kind === 'none') {
    return makeUser(app, { card: 'none' });
  }
  if (kind === 'otherCity') {
    return provenTraveler(app, OTHER_CITY.id);
  }

  const user = await makeUser(app, { card: 'none' });
  await makeProof(app, user, { cityId: PRIMARY_CITY.id, validNow: kind === 'valid' });

  return user;
}

describe('GET /cities/:cityId/travelers: the errors', () => {
  it.each(TRAVELER_ERROR_ROWS)('answers $status $code for $case', async (row) => {
    const viewer = await callerFor(t, row.caller);

    const response = await getAs(t, viewer, travelersPath(row.cityId), row.cursor);

    expectError(response, row.status, row.code);
  });
});

/* GET /cities/:cityId/travelers: the listing rules (AAP 0.5.1, 0.5.7) */

/**
 * The `created_at` instant of each account's valid proof for {@link PRIMARY_CITY}, in the order the
 * ids are given. `ItineraryProof.createdAt` is written by the database's own `now()`, so the
 * newest-proof-first order is asserted against the instants the rows carry rather than against the
 * order the fixtures were created in (AAP 0.5.1).
 *
 * @throws {Error} When an account holds no proof valid now, which would make the page a lie.
 */
async function proofInstants(app: TestApp, ids: readonly string[]): Promise<number[]> {
  const now = app.time.now();
  const proofs = await app.services.db.itineraryProof.findMany({
    where: {
      userId: { in: [...ids] },
      cityId: PRIMARY_CITY.id,
      validFrom: { lte: now },
      validTo: { gte: now },
    },
    select: { userId: true, createdAt: true },
  });
  const instantOf = new Map(proofs.map((proof) => [proof.userId, proof.createdAt.getTime()]));

  return ids.map((id) => {
    const instant = instantOf.get(id);
    if (instant === undefined) {
      throw new Error(`the traveler ${id} holds no valid proof for ${PRIMARY_CITY.id}`);
    }
    return instant;
  });
}

describe('GET /cities/:cityId/travelers: the listing', () => {
  it('pages 20 travelers at a time, newest proof first', async () => {
    const viewer = await provenTraveler(t);
    const others: UserFixture[] = [];

    // One page, one row beyond it, and one short page: the boundary `PAGE_SIZE` and the `nextCursor`
    // that says more rows remain (AAP 0.5.1). The clock steps a second between proofs so no two
    // fixtures are built at one test-clock instant; the order the page answers in is checked against
    // the instants the rows carry, which a fixture cannot choose.
    for (let index = 0; index < PAGE_SIZE + EXTRA_TRAVELERS; index += 1) {
      const other = await makeUser(t, { card: 'none' });
      await makeProof(t, other, { cityId: PRIMARY_CITY.id });
      others.push(other);
      t.time.advance({ seconds: 1 });
    }

    const first = await getAs(t, viewer, travelersPath(PRIMARY_CITY.id));
    expect(first.status).toBe(200);
    const page1 = TravelersResponse.parse(first.json());
    expect(page1.items).toHaveLength(PAGE_SIZE);
    expect(page1.nextCursor).not.toBeNull();

    const second = await getAs(
      t,
      viewer,
      travelersPath(PRIMARY_CITY.id),
      page1.nextCursor ?? undefined,
    );
    expect(second.status).toBe(200);
    const page2 = TravelersResponse.parse(second.json());
    expect(page2.items).toHaveLength(EXTRA_TRAVELERS);
    expect(page2.nextCursor).toBeNull();

    const listed = [...idsOf(page1), ...idsOf(page2)];
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).not.toContain(viewer.id);
    expect([...listed].sort()).toEqual(others.map((other) => other.id).sort());

    // Newest proof first: the instants the page is keyed on never increase down it.
    const instants = await proofInstants(t, listed);
    expect(instants).toEqual([...instants].sort((left, right) => right - left));
  });

  it('hides the caller, a block in either direction, and accounts that are gone', async () => {
    const viewer = await provenTraveler(t);
    const listed = await provenTraveler(t);
    const blocking = await provenTraveler(t);
    const blocked = await provenTraveler(t);
    const deleted = await provenTraveler(t, PRIMARY_CITY.id, 'deleted');
    const requested = await provenTraveler(t, PRIMARY_CITY.id, 'deletionRequested');
    await makeBlock(t, blocking, viewer);
    await makeBlock(t, viewer, blocked);

    const response = await getAs(t, viewer, travelersPath(PRIMARY_CITY.id));

    expect(response.status).toBe(200);
    const ids = idsOf(TravelersResponse.parse(response.json()));
    expect(ids).toEqual([listed.id]);
    expect(ids).not.toContain(viewer.id);
    expect(ids).not.toContain(blocking.id);
    expect(ids).not.toContain(blocked.id);
    expect(ids).not.toContain(deleted.id);
    expect(ids).not.toContain(requested.id);
  });

  it('shows a traveler whose proof lapsed only to someone who met them, in the city of their latest proof', async () => {
    // The viewer holds a proof for both cities, so it may ask each of them (AAP 0.5.4).
    const viewer = await provenTraveler(t);
    await makeProof(t, viewer, { cityId: OTHER_CITY.id });

    const stranger = await provenTraveler(t);
    // One proof, and it has already ended: the traveler's latest proof is the primary city's, and
    // they hold nothing valid anywhere (AAP 0.5.7).
    const lapsed = await makeUser(t, { card: 'none' });
    await makeProof(t, lapsed, { cityId: PRIMARY_CITY.id, validNow: false });

    // One completed meetup writes the `PairHistory` row the shared-history branch reads, and the
    // witness events the reputation counters read (AAP 0.5.2, 0.5.7).
    const venue = await makeVenue(t, { cityId: PRIMARY_CITY.id });
    await makeMeetup(t, { status: 'completed', initiator: viewer, recipient: lapsed, venue });

    const forStranger = await getAs(t, stranger, travelersPath(PRIMARY_CITY.id));
    const forViewer = await getAs(t, viewer, travelersPath(PRIMARY_CITY.id));
    const elsewhere = await getAs(t, viewer, travelersPath(OTHER_CITY.id));

    expect(forStranger.status).toBe(200);
    expect(forViewer.status).toBe(200);
    expect(elsewhere.status).toBe(200);

    const strangerIds = idsOf(TravelersResponse.parse(forStranger.json()));
    const viewerIds = idsOf(TravelersResponse.parse(forViewer.json()));
    const elsewhereIds = idsOf(TravelersResponse.parse(elsewhere.json()));

    expect(strangerIds).not.toContain(lapsed.id);
    expect(viewerIds).toContain(lapsed.id);
    // The lapsed traveler's latest proof is the primary city's, so the other city's page is not a
    // place the pair can share (AAP 0.5.7).
    expect(elsewhereIds).not.toContain(lapsed.id);
    expect(elsewhereIds).not.toContain(stranger.id);
  });

  it('leaves out a traveler whose valid proof is for another city', async () => {
    const viewer = await provenTraveler(t);
    const elsewhere = await provenTraveler(t, OTHER_CITY.id);

    const response = await getAs(t, viewer, travelersPath(PRIMARY_CITY.id));

    expect(response.status).toBe(200);
    const ids = idsOf(TravelersResponse.parse(response.json()));
    expect(ids).not.toContain(elsewhere.id);
  });

  it('answers each traveler as exactly the tier-0 field set', async () => {
    const viewer = await provenTraveler(t);
    const listed = await provenTraveler(t);

    const response = await getAs(t, viewer, travelersPath(PRIMARY_CITY.id));

    expect(response.status).toBe(200);
    const wire = response.json<{ items: Record<string, unknown>[]; nextCursor: string | null }>();
    const item = onlyItem(wire.items);

    // Tier 0 is what a stranger receives, whatever the tier between the pair would otherwise be
    // (AAP 0.5.4), and the keys are read off the wire where an extra field would show.
    expect(Object.keys(item).sort()).toEqual([...TIER_FIELDS[0]].sort());
    expect(() => Tier0Profile.parse(item)).not.toThrow();
    expect(() => TravelersResponse.parse(wire)).not.toThrow();
    expect(item['id']).toBe(listed.id);

    // No path outside the tier-0 field list, nested ones included: `reputation.witnessedMeetups` and
    // `proofDates.arrivalDate` are inside it, `nickname` and `externalContact` are not.
    const allowed = new Set<string>(TIER_FIELDS[0]);
    const paths = keysDeep(item);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const [top] = path.split('.');
      expect(allowed.has((top ?? path).replace(/\[\]$/, ''))).toBe(true);
    }
  });
});
