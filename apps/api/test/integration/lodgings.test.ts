/**
 * The lodging directory, its guest list and its leaderboard, end to end (AAP 0.8.1, 0.5.4, 0.5.7;
 * criteria 15 and 16 of AAP 0.12.1).
 *
 * Every case drives the three routes through the real app `apps/api/test/support/app.ts` builds — real
 * PostgreSQL 16 with PostGIS 3.4 and real Redis — and asserts on what the contract publishes: the error
 * envelope through `expectError`, the DTO key set derived from the shared schemas, and the key paths of
 * the raw JSON through `keysDeep`, so a field that has no business leaving the server is caught even
 * where no schema declares it.
 *
 * Criterion 15: a guest who has not opted in appears in no response; a verified guest count below
 * `GUEST_COUNT_THRESHOLD` is never a number — it is `GUEST_COUNT_BELOW_LABEL`, in the directory and on
 * the detail alike — and an opted-in guest is released only to a caller holding a valid proof for the
 * lodging's city, as the tier-0 profile discovery discloses and no more. The toggle needs a claim that
 * is `verified` and still inside its stay, judged in the lodging's city time (`409 no_verified_claim`
 * otherwise), and hiding always succeeds (AAP 0.5.7).
 *
 * Criterion 16: one seeded city ranks its lodgings by witnessed activity, breaks an equal score by the
 * current verified guest count, keeps each lodging's activity rank under `sort=name`, ignores facts
 * older than the 90-day window, and counts one pair once in any 30 days (AAP 0.5.7).
 *
 * Two harness facts shape the file. The clock is frozen at `DEFAULT_TEST_NOW` and every date here is
 * derived from it and `DAY_MS` — a claim whose stay has ended is written with dates before it, never by
 * moving the clock — so no case waits for a window to pass. And the directory is cached in Redis for
 * `LEADERBOARD_CACHE_SECONDS` under `leaderboard:<APP_ENV>:<cityId>`, one entry per fixture policy,
 * whose TTLs are wall-clock: the reader below drops this run's own key before every read that must see
 * the rows a case has just written, and asserts the entry was written again with the TTL the contract
 * states, which is also what proves the key it drops is the route's own.
 *
 * @see AAP 0.5.4 for the routes, their errors and their DTOs, 0.5.7 for the visibility, guest-count and
 *   leaderboard rules, 0.12.1 for the two criteria, 0.11.2 for the harness, 0.8.1 for this file.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';

import { createPrismaClient, type DbClient } from '@tablemate/db';
import {
  DAY_MS,
  GUEST_COUNT_BELOW_LABEL,
  GUEST_COUNT_THRESHOLD,
  GuestCount,
  LEADERBOARD_CACHE_SECONDS,
  LEADERBOARD_PAIR_DEDUPE_DAYS,
  LEADERBOARD_WINDOW_DAYS,
  LodgingDetail,
  LodgingsResponse,
  LodgingSummary,
  TIER_FIELDS,
  VisibilityResponse,
} from '@tablemate/shared';
import type { ErrorCode, LodgingClaimStatus, LodgingSort, Tier0Profile } from '@tablemate/shared';

import { createTestApp, type TestApp } from '../support/app.ts';
import {
  callRoute,
  expectError,
  keysDeep,
  makeActivityFacts,
  makeBlock,
  makeClaim,
  makeLodging,
  makeProof,
  makeUser,
  makeVisibility,
  rows,
} from '../support/factories.ts';
import type {
  ClaimFixture,
  FixtureRef,
  LodgingFixture,
  RouteResponse,
  UserFixture,
} from '../support/factories.ts';
import {
  leaderboard,
  type LodgingLeaderboardServices,
} from '../../src/modules/lodgings/leaderboard.ts';

/* Names and keys every case is written against (AAP 0.5.2, 0.5.7) */

/** The city every case stands in: one of the five launch cities of `config/cities.json`. */
const LISBON = 'lisbon';

/** Another launch city, whose proof must never open the Lisbon directory (AAP 0.5.7). */
const MEXICO_CITY = 'mexico-city';

/** A slug `CitySlug` accepts that this deployment is not configured with. */
const UNKNOWN_CITY = 'narnia';

/** A `Uuid` no lodging has, for the detail route's not-found case. */
const MISSING_LODGING_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The directory's cache entry under this run's own fixture policy, `leaderboard:test:<cityId>`
 * (AAP 0.5.2, 0.5.7), rewritten by every recomputation. `APP_ENV` is in the key, so the integration
 * project's own `test` policy is named here. Redis TTLs are wall-clock, so the reader below drops this
 * key rather than waiting it out.
 */
const CACHE_KEY = `leaderboard:test:${LISBON}`;

/** What must never appear in an answer: a console secret, a booking field or a proof nullifier. */
const FORBIDDEN_IN_RESPONSE = ['secret', 'cipher', 'booking', 'nullifier', 'emailCiphertext'];

/** The words a guest-list key path must never carry: a stay date or a room field would be one. */
const FORBIDDEN_GUEST_PATH = /stay|room|booking/i;

/* The suite (AAP 0.11.2) */

let t: TestApp;

/** The caller every read is made as: a consented traveler holding a valid proof for Lisbon. */
let viewer: UserFixture;

beforeAll(async () => {
  t = await createTestApp();
}, 240_000);

afterAll(async () => {
  await t.close();
});

// A fresh database, a fresh Redis and a fresh subject per case: `resetState` truncates every table,
// flushes the cache and returns the frozen clock to `DEFAULT_TEST_NOW`.
beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
  viewer = await makeUser(t);
  await makeProof(t, viewer, { cityId: LISBON });
});

/* The three routes (AAP 0.5.4) */

/** Who a request is made as: a fixture account, or nobody at all (no bearer header). */
type Actor = UserFixture | null;

/** `GET /v1/cities/:cityId/lodgings`, with an optional `sort`. */
async function listRoute(cityId: string, actor: Actor, sort?: string): Promise<RouteResponse> {
  return await callRoute(t.app, {
    method: 'GET',
    url: `/v1/cities/${cityId}/lodgings`,
    ...(actor === null ? {} : { as: actor }),
    ...(sort === undefined ? {} : { query: { sort } }),
  });
}

/** `GET /v1/lodgings/:id`. */
async function detailRoute(lodgingId: string, actor: Actor): Promise<RouteResponse> {
  return await callRoute(t.app, {
    method: 'GET',
    url: `/v1/lodgings/${lodgingId}`,
    ...(actor === null ? {} : { as: actor }),
  });
}

/** `PUT /v1/me/lodging-visibility`, the opt-in switch (AAP 0.5.7). */
async function setStaying(actor: UserFixture, showStaying: boolean): Promise<RouteResponse> {
  return await callRoute(t.app, {
    method: 'PUT',
    url: '/v1/me/lodging-visibility',
    as: actor,
    body: { showStaying },
  });
}

/* Reads over the directory (AAP 0.5.7) */

/**
 * The city's activity-ordered directory, read past the cache.
 *
 * The key is dropped first so the board reflects the rows the case has just written, and the TTL the
 * write left behind is asserted, which pins the cache key, its lifetime and the fact that a read
 * repopulates it. `sort=name` re-sorts the same board and writes the same entry, so the check holds
 * for both orders.
 *
 * @param sort - `activity` (the default) or `name`.
 * @returns The directory entries, in the order the route answered with.
 */
async function board(sort: LodgingSort = 'activity'): Promise<readonly LodgingSummary[]> {
  await t.services.redis.client.del(CACHE_KEY);

  const response = await listRoute(LISBON, viewer, sort);
  expect(response.status).toBe(200);

  const ttl = await t.services.redis.client.ttl(CACHE_KEY);
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(LEADERBOARD_CACHE_SECONDS);

  return LodgingsResponse.parse(response.json()).items;
}

/** One directory entry, failing the case when the lodging is not listed at all. */
function item(items: readonly LodgingSummary[], lodgingId: string): LodgingSummary {
  const found = items.find((entry) => entry.id === lodgingId);
  if (found === undefined) {
    throw new Error(`the directory lists no lodging with id ${lodgingId}`);
  }
  return found;
}

/** `GET /v1/lodgings/:id` as the proof-holding viewer, read past the cache. */
async function readDetail(lodgingId: string): Promise<RouteResponse> {
  await t.services.redis.client.del(CACHE_KEY);

  const response = await detailRoute(lodgingId, viewer);
  expect(response.status).toBe(200);

  return response;
}

/** One guest as a detail lists them, failing the case when the guest is absent. */
function guestOf(detail: LodgingDetail, userId: string): Tier0Profile {
  const listed = detail.guests.find((entry) => entry.id === userId);
  if (listed === undefined) {
    throw new Error(`the guest list does not carry ${userId}`);
  }
  return listed;
}

/** The handle a live fixture account carries; `makeUser` leaves it null only for a tombstone. */
function handleOf(user: UserFixture): string {
  if (user.handle === null) {
    throw new Error('a live fixture account carries no handle');
  }
  return user.handle;
}

/* Fixtures the cases are built from (AAP 0.5.2, 0.5.7) */

/** The instant `days` before `now`, which places every activity fact in time (AAP 0.5.7). */
function ago(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/** A calendar date `days` from `now` as `YYYY-MM-DD`: the form a stay's dates are written in. */
function dayFrom(now: Date, days: number): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * A pair for one lodging fact.
 *
 * A fact carries a keyed hash of two traveler ids and no user id at all (AAP 0.5.7), so the pair needs
 * no account rows: two fresh ids are what the key is taken over, and each call is a pair the
 * leaderboard has not seen before.
 */
function pairOf(): readonly [FixtureRef, FixtureRef] {
  return [{ id: randomUUID() }, { id: randomUUID() }];
}

/**
 * One lodging under a name the case controls.
 *
 * `makeLodging` numbers its own names from a counter that runs for the whole process, so their
 * alphabetical order is not the order the cases create them in; the leaderboard orders by name, so the
 * scenario's own names are written over it.
 */
async function namedLodging(name: string): Promise<LodgingFixture> {
  const lodging = await makeLodging(t, { cityId: LISBON });
  await t.services.db.lodging.update({ where: { id: lodging.id }, data: { name } });

  return { ...lodging, name };
}

/** What {@link makeGuest} may set. */
interface GuestOptions {
  readonly status?: LodgingClaimStatus;
  readonly stayFrom?: string;
  readonly stayTo?: string;
}

/** One guest account, and the claim that carries its stay. */
interface GuestFixture {
  readonly user: UserFixture;
  readonly claim: ClaimFixture;
}

/**
 * One guest with a claim on `lodging`, `verified` unless the case says otherwise (AAP 0.5.7).
 *
 * A verified claim whose `stayTo` has not passed is what the guest count, the guest list and the
 * visibility toggle all read, so this is the shape every criterion-15 case starts from.
 */
async function makeGuest(
  lodging: LodgingFixture,
  options: GuestOptions = {},
): Promise<GuestFixture> {
  const user = await makeUser(t);
  const claim = await makeClaim(t, user, lodging, {
    status: options.status ?? 'verified',
    ...(options.stayFrom === undefined ? {} : { stayFrom: options.stayFrom }),
    ...(options.stayTo === undefined ? {} : { stayTo: options.stayTo }),
  });

  return { user, claim };
}

/* ---------------------------------------------------------------------------------------------
 * The refusals of the three routes (AAP 0.5.4)
 * ------------------------------------------------------------------------------------------- */

/** How a case's request is authenticated: the shared viewer, a fresh one, or nobody at all. */
type ViewerKind = 'valid' | 'no-proof' | 'other-city' | 'no-consent';

/** The account a row acts as. */
async function actorFor(kind: ViewerKind | 'none'): Promise<Actor> {
  if (kind === 'none') return null;
  if (kind === 'valid') return viewer;

  const user = await makeUser(t, kind === 'no-consent' ? { consents: false } : {});
  if (kind === 'other-city') await makeProof(t, user, { cityId: MEXICO_CITY });

  return user;
}

/** One row of the directory route's error table: the read, and the answer it must produce. */
type ListRow = readonly [
  title: string,
  viewer: ViewerKind | 'none',
  city: string,
  sort: string | null,
  status: number,
  code: ErrorCode,
];

const LIST_ERRORS: readonly ListRow[] = [
  ['no bearer token', 'none', LISBON, null, 401, 'token_invalid'],
  ['an unknown city', 'valid', UNKNOWN_CITY, null, 404, 'city_not_found'],
  ['no proof for the city', 'no-proof', LISBON, null, 403, 'no_valid_proof'],
  ['a proof for another city', 'other-city', LISBON, null, 403, 'no_valid_proof'],
  ['an unknown sort', 'valid', LISBON, 'rating', 400, 'invalid_field'],
];

/** One row of the detail route's error table; a `lodging` of `null` means the case's own lodging. */
type DetailRow = readonly [
  title: string,
  viewer: ViewerKind | 'none',
  lodging: string | null,
  status: number,
  code: ErrorCode,
];

const DETAIL_ERRORS: readonly DetailRow[] = [
  ['no bearer token', 'none', null, 401, 'token_invalid'],
  ['an unknown id', 'valid', MISSING_LODGING_ID, 404, 'lodging_not_found'],
  ['no proof for the city', 'no-proof', null, 403, 'no_valid_proof'],
  ['a proof for another city', 'other-city', null, 403, 'no_valid_proof'],
];

describe('the refusals of the directory, the detail and the visibility toggle', () => {
  it.each(rows(LIST_ERRORS))(
    'GET /cities/:cityId/lodgings: %s',
    async (_title, kind, city, sort, status, code) => {
      expectError(await listRoute(city, await actorFor(kind), sort ?? undefined), status, code);
    },
  );

  it.each(rows(DETAIL_ERRORS))(
    'GET /lodgings/:id: %s',
    async (_title, kind, target, status, code) => {
      const lodging = await makeLodging(t, { cityId: LISBON });
      const response = await detailRoute(target ?? lodging.id, await actorFor(kind));

      expectError(response, status, code);
    },
  );

  it('holds both directory routes behind the age gate', async () => {
    const lodging = await makeLodging(t, { cityId: LISBON });
    const gated = await actorFor('no-consent');

    expectError(await listRoute(LISBON, gated), 403, 'age_gate_required');
    expectError(await detailRoute(lodging.id, gated), 403, 'age_gate_required');
  });
});

/* ---------------------------------------------------------------------------------------------
 * Criterion 15 — what a lodging discloses, and to whom (AAP 0.5.4, 0.5.7)
 * ------------------------------------------------------------------------------------------- */

/** One row of the guest-count table: the guests a lodging holds and the count its DTOs render. */
interface GuestCountRow {
  readonly guests: number;
  readonly expected: GuestCount;
}

/**
 * The counts criterion 15 is read at, straddling `GUEST_COUNT_THRESHOLD`: below it the count is the
 * label, at and above it the number itself (AAP 0.5.4).
 */
const GUEST_COUNTS: readonly GuestCountRow[] = [
  { guests: 0, expected: GUEST_COUNT_BELOW_LABEL },
  { guests: 1, expected: GUEST_COUNT_BELOW_LABEL },
  { guests: 2, expected: GUEST_COUNT_BELOW_LABEL },
  { guests: 3, expected: 3 },
  { guests: 4, expected: 4 },
];

/** One row of the visibility toggle's error table: the claim the caller holds (AAP 0.5.7). */
interface VisibilityErrorRow {
  readonly title: string;
  readonly claim: 'none' | 'pending_call' | 'stay_ended';
}

const VISIBILITY_ERRORS: readonly VisibilityErrorRow[] = [
  { title: 'no claim', claim: 'none' },
  { title: 'a claim still being verified', claim: 'pending_call' },
  { title: 'a stay that has ended', claim: 'stay_ended' },
];

describe('criterion 15: a guest is disclosed only when opted in, and only to a proof-holder', () => {
  it('keeps a verified guest who has not opted in out of every response', async () => {
    const lodging = await makeLodging(t, { cityId: LISBON });
    const guest = await makeGuest(lodging);
    await makeVisibility(t, guest.user, guest.claim, false);

    await t.services.redis.client.del(CACHE_KEY);
    const listResponse = await listRoute(LISBON, viewer);
    expect(listResponse.status).toBe(200);

    const items = LodgingsResponse.parse(listResponse.json()).items;
    // Hidden from the guest list, and still one of the counts the lodging reports.
    expect(item(items, lodging.id).guestCount).toBe(GUEST_COUNT_BELOW_LABEL);

    const detailResponse = await readDetail(lodging.id);
    expect(LodgingDetail.parse(detailResponse.json()).guests).toEqual([]);

    for (const body of [listResponse.body, detailResponse.body]) {
      expect(body).not.toContain(guest.user.id);
      expect(body).not.toContain(handleOf(guest.user));
    }
  });

  it.each(rows(GUEST_COUNTS))('renders $guests verified guests as $expected', async (row) => {
    const lodging = await makeLodging(t, { cityId: LISBON });
    for (let index = 0; index < row.guests; index += 1) {
      await makeGuest(lodging);
    }

    const listed = item(await board(), lodging.id).guestCount;
    const detail = LodgingDetail.parse((await readDetail(lodging.id)).json()).guestCount;

    expect(listed).toEqual(row.expected);
    expect(detail).toEqual(row.expected);
    expect(GuestCount.parse(listed)).toEqual(row.expected);

    // Below the threshold the count never leaves the server as a number (AAP 0.5.4).
    if (row.guests < GUEST_COUNT_THRESHOLD) {
      expect(typeof listed).toBe('string');
      expect(typeof detail).toBe('string');
    } else {
      expect(listed).toBe(row.guests);
    }
  });

  it('lists an opted-in guest with exactly the tier-0 fields', async () => {
    const lodging = await makeLodging(t, { cityId: LISBON });
    const guest = await makeGuest(lodging);

    const optedIn = await setStaying(guest.user, true);
    expect(optedIn.status).toBe(200);
    expect(VisibilityResponse.parse(optedIn.json())).toEqual({ showStaying: true });

    const response = await readDetail(lodging.id);
    const listed = guestOf(LodgingDetail.parse(response.json()), guest.user.id);

    expect(Object.keys(listed).sort()).toEqual([...TIER_FIELDS[0]].sort());
    expect(keysDeep(listed).filter((path) => FORBIDDEN_GUEST_PATH.test(path))).toEqual([]);
    expect(response.body).not.toContain(guest.claim.id);
  });

  it('releases the guest list only to a viewer with a proof for the lodging city', async () => {
    const lodging = await makeLodging(t, { cityId: LISBON });
    const guest = await makeGuest(lodging);
    await setStaying(guest.user, true);

    const refused = await detailRoute(lodging.id, await actorFor('other-city'));

    expectError(refused, 403, 'no_valid_proof');
    expect(refused.body).not.toContain(guest.user.id);
  });

  it('omits a guest who blocked the viewer, and still counts them', async () => {
    const lodging = await makeLodging(t, { cityId: LISBON });
    const blocker = await makeGuest(lodging);
    const other = await makeGuest(lodging);
    await setStaying(blocker.user, true);
    await setStaying(other.user, true);
    await makeBlock(t, blocker.user, viewer);

    const detail = LodgingDetail.parse((await readDetail(lodging.id)).json());

    expect(detail.guests.map((entry) => entry.id)).toEqual([other.user.id]);
    expect(detail.guestCount).toBe(GUEST_COUNT_BELOW_LABEL);
  });

  it.each(rows(VISIBILITY_ERRORS))(
    'PUT /me/lodging-visibility: $title is 409 no_verified_claim',
    async (row) => {
      const user = await makeUser(t);

      if (row.claim !== 'none') {
        const now = t.time.now();
        await makeClaim(t, user, await makeLodging(t, { cityId: LISBON }), {
          status: row.claim === 'pending_call' ? 'pending_call' : 'verified',
          ...(row.claim === 'stay_ended'
            ? { stayFrom: dayFrom(now, -10), stayTo: dayFrom(now, -5) }
            : {}),
        });
      }

      expectError(await setStaying(user, true), 409, 'no_verified_claim');
    },
  );

  it('always lets a traveler hide again', async () => {
    const lodging = await makeLodging(t, { cityId: LISBON });
    const guest = await makeGuest(lodging);
    await setStaying(guest.user, true);

    const shown = LodgingDetail.parse((await readDetail(lodging.id)).json());
    expect(shown.guests.map((entry) => entry.id)).toEqual([guest.user.id]);

    const hidden = await setStaying(guest.user, false);
    expect(hidden.status).toBe(200);
    expect(VisibilityResponse.parse(hidden.json())).toEqual({ showStaying: false });
    expect(LodgingDetail.parse((await readDetail(lodging.id)).json()).guests).toEqual([]);
  });

  it('publishes exactly the lodging DTO fields and nothing above them', async () => {
    const lodging = await makeLodging(t, { cityId: LISBON, withSecret: true });

    const listed = item(await board(), lodging.id);
    const detailResponse = await readDetail(lodging.id);
    const detail = LodgingDetail.parse(detailResponse.json());

    expect(Object.keys(listed).sort()).toEqual(Object.keys(LodgingSummary.shape).sort());
    expect(Object.keys(detail).sort()).toEqual(Object.keys(LodgingDetail.shape).sort());
    // The business contact the directory exists to show, never a traveler's.
    expect(listed.phone).toBe(lodging.phone);
    expect(listed.address).not.toBeNull();

    for (const forbidden of FORBIDDEN_IN_RESPONSE) {
      expect(detailResponse.body).not.toContain(forbidden);
    }
  });

  it('drops a lodging that has left the OpenStreetMap directory', async () => {
    const gone = await makeLodging(t, { cityId: LISBON });
    const listed = await makeLodging(t, { cityId: LISBON });
    await t.services.db.lodging.update({
      where: { id: gone.id },
      data: { osmMissingAt: t.time.now() },
    });

    expect((await board()).map((entry) => entry.id)).toEqual([listed.id]);
    expectError(await detailRoute(gone.id, viewer), 404, 'lodging_not_found');
  });
});

/* ---------------------------------------------------------------------------------------------
 * Criterion 16 — the city leaderboard (AAP 0.5.7)
 * ------------------------------------------------------------------------------------------- */

/** The five lodgings of the seeded scenario, by the key each case names them with. */
type BoardKey = 'alpha' | 'bravo' | 'charlie' | 'delta' | 'echo';

/** The seeded city, and the pair whose chain the 30-day dedupe case extends. */
interface BoardFixture {
  readonly lodgings: Readonly<Record<BoardKey, LodgingFixture>>;
  readonly charliePair: readonly [FixtureRef, FixtureRef];
}

/** One row of the expectation the seeded board is read against. */
interface BoardExpectation {
  readonly name: string;
  readonly score: number;
  readonly rank: number;
  readonly guestCount: GuestCount;
}

/**
 * What the seeded scenario must produce on the activity board.
 *
 * Two properties make these rows a test of the rule rather than of the fixtures: Bravo's 3 come from
 * three distinct pairs and a fourth fact older than the 90-day window, which no score counts; and
 * Alpha and Charlie both score 2, so their order is the guest-count tie-break, Alpha holding three
 * current verified guests to Charlie's one.
 */
const SEEDED_BOARD: readonly BoardExpectation[] = [
  { name: 'Bravo Lodge', score: 3, rank: 1, guestCount: GUEST_COUNT_BELOW_LABEL },
  { name: 'Alpha Lodge', score: 2, rank: 2, guestCount: 3 },
  { name: 'Charlie Lodge', score: 2, rank: 3, guestCount: GUEST_COUNT_BELOW_LABEL },
  { name: 'Delta Lodge', score: 0, rank: 4, guestCount: GUEST_COUNT_BELOW_LABEL },
  { name: 'Echo Lodge', score: 0, rank: 5, guestCount: GUEST_COUNT_BELOW_LABEL },
];

/** The days before now of Charlie's two counted facts, the first of them the shared pair's. */
const CHARLIE_PAIR_DAYS_AGO = LEADERBOARD_PAIR_DEDUPE_DAYS + 10;
const CHARLIE_OTHER_PAIR_DAYS_AGO = CHARLIE_PAIR_DAYS_AGO - 5;

/** How much later than the pair's counted fact the dedupe case places each fact of its own. */
const INSIDE_PAIR_WINDOW_GAP_DAYS = 10;
const PAST_PAIR_WINDOW_GAP_DAYS = LEADERBOARD_PAIR_DEDUPE_DAYS + 1;

/** How far outside the 90-day activity window Bravo's ignored fact sits. */
const OUTSIDE_WINDOW_DAYS_AGO = LEADERBOARD_WINDOW_DAYS + 10;

/** Build the scenario: five named lodgings, their witnessed facts and their current verified guests. */
async function seedBoard(): Promise<BoardFixture> {
  const now = t.time.now();
  const charliePair = pairOf();

  const lodgings: Record<BoardKey, LodgingFixture> = {
    alpha: await namedLodging('Alpha Lodge'),
    bravo: await namedLodging('Bravo Lodge'),
    charlie: await namedLodging('Charlie Lodge'),
    delta: await namedLodging('Delta Lodge'),
    echo: await namedLodging('Echo Lodge'),
  };

  await makeActivityFacts(t, lodgings.alpha, [
    { pair: pairOf(), completedAt: ago(now, 1) },
    { pair: pairOf(), completedAt: ago(now, 2) },
  ]);
  await makeActivityFacts(t, lodgings.bravo, [
    { pair: pairOf(), completedAt: ago(now, 3) },
    { pair: pairOf(), completedAt: ago(now, 4) },
    { pair: pairOf(), completedAt: ago(now, 5) },
    { pair: pairOf(), completedAt: ago(now, OUTSIDE_WINDOW_DAYS_AGO) },
  ]);
  await makeActivityFacts(t, lodgings.charlie, [
    { pair: charliePair, completedAt: ago(now, CHARLIE_PAIR_DAYS_AGO) },
    { pair: pairOf(), completedAt: ago(now, CHARLIE_OTHER_PAIR_DAYS_AGO) },
  ]);

  for (let index = 0; index < 3; index += 1) {
    await makeGuest(lodgings.alpha);
  }
  await makeGuest(lodgings.charlie);

  return { lodgings, charliePair };
}

describe('criterion 16: the city leaderboard', () => {
  let seeded: BoardFixture;

  beforeEach(async () => {
    seeded = await seedBoard();
  });

  it('ranks by witnessed activity and breaks an equal score by the verified guest count', async () => {
    const items = await board();

    expect(items.map((entry) => entry.name)).toEqual(SEEDED_BOARD.map((row) => row.name));
    expect(items.map((entry) => entry.activityScore)).toEqual(SEEDED_BOARD.map((row) => row.score));
    expect(items.map((entry) => entry.rank)).toEqual(SEEDED_BOARD.map((row) => row.rank));
    expect(items.map((entry) => entry.guestCount)).toEqual(
      SEEDED_BOARD.map((row) => row.guestCount),
    );
  });

  it("keeps each lodging's activity rank when the directory is sorted by name", async () => {
    const alphabetical = [...SEEDED_BOARD].sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const items = await board('name');

    expect(items.map((entry) => entry.name)).toEqual(alphabetical.map((row) => row.name));
    expect(items.map((entry) => entry.rank)).toEqual(alphabetical.map((row) => row.rank));
    expect(items.map((entry) => entry.activityScore)).toEqual(alphabetical.map((row) => row.score));
  });

  it('counts one pair once in any 30 days', async () => {
    const now = t.time.now();
    const { alpha, bravo, charlie } = seeded.lodgings;
    expect(item(await board(), charlie.id).activityScore).toBe(2);

    // Ten days after the counted fact: inside the pair's window, so the score does not move.
    const insideGap = CHARLIE_PAIR_DAYS_AGO - INSIDE_PAIR_WINDOW_GAP_DAYS;
    await makeActivityFacts(t, charlie, [
      { pair: seeded.charliePair, completedAt: ago(now, insideGap) },
    ]);
    expect(item(await board(), charlie.id).activityScore).toBe(2);

    // Thirty-one days after the counted fact: the chain advances, because a fact that did not count
    // never reset it, so the score rises by exactly one (AAP 0.5.7).
    const pastGap = CHARLIE_PAIR_DAYS_AGO - PAST_PAIR_WINDOW_GAP_DAYS;
    await makeActivityFacts(t, charlie, [
      { pair: seeded.charliePair, completedAt: ago(now, pastGap) },
    ]);
    const items = await board();

    expect(item(items, charlie.id).activityScore).toBe(3);
    // Level with Bravo on score and one verified guest ahead of it: the tie-break moves Charlie up.
    expect(item(items, charlie.id).rank).toBe(1);
    expect(item(items, bravo.id).rank).toBe(2);
    expect(item(items, alpha.id).rank).toBe(3);
  });
});

/* ---------------------------------------------------------------------------------------------
 * The cache's scope — one board per fixture policy (AAP 0.5.2)
 * ------------------------------------------------------------------------------------------- */

/** The environment the second policy stands for: one that may neither write nor read fixture rows. */
const REFUSING_ENV = 'staging' as const;

/** The city's cache entry under {@link REFUSING_ENV}, the key a fixture-refusing process must use. */
const REFUSING_CACHE_KEY = `leaderboard:${REFUSING_ENV}:${LISBON}`;

/**
 * The services of the fixture-refusing policy: the run's own Redis, clock and logger, over a client
 * built for an environment outside `test` and `demo` (AAP 0.5.2).
 *
 * The case drives the module's exported {@link leaderboard} rather than a second app, because the
 * harness cannot build one: `buildApp` refuses a fault injector outside `APP_ENV=test`
 * (`apps/api/src/app.ts:564`) and the factory always supplies one
 * (`apps/api/test/support/app.ts:866`). The directory route calls exactly this function with exactly
 * these services, so the cache key under test is the one the route reads and writes.
 */
function refusingServices(db: DbClient): LodgingLeaderboardServices {
  return {
    db,
    redis: t.services.redis,
    clock: t.services.clock,
    logger: t.services.logger,
    env: { APP_ENV: REFUSING_ENV, ANALYTICS_SALT: t.env.ANALYTICS_SALT },
    timezoneFor: t.services.timezoneFor,
  };
}

/** The ids a board carries, sorted, so two boards compare without depending on their order. */
function idsOf(items: readonly LodgingSummary[]): string[] {
  return items.map((entry) => entry.id).sort();
}

/** The board one cache key holds, as the route would have answered it (AAP 0.5.7). */
async function cachedBoard(key: string): Promise<readonly LodgingSummary[]> {
  const raw = await t.services.redis.client.get(key);
  if (raw === null) {
    throw new Error(`no leaderboard cache entry at ${key}`);
  }

  // The entry is the board itself, the array the route hands its callers (AAP 0.5.7).
  const decoded: unknown = JSON.parse(raw);
  return LodgingSummary.array().parse(decoded);
}

/** Asserts one key holds an entry whose lifetime is the contract's (AAP 0.5.7). */
async function expectCacheTtl(key: string): Promise<void> {
  const ttl = await t.services.redis.client.ttl(key);
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(LEADERBOARD_CACHE_SECONDS);
}

describe('the directory cache holds one board per fixture policy', () => {
  let guarded: DbClient;
  let refusing: LodgingLeaderboardServices;

  beforeAll(() => {
    guarded = createPrismaClient({ databaseUrl: inject('databaseUrl'), appEnv: REFUSING_ENV });
    refusing = refusingServices(guarded);
  });

  afterAll(async () => {
    await guarded.$disconnect();
  });

  it('never serves a fixture-bearing board to a process outside test and demo', async () => {
    const lodgings = [
      await makeLodging(t, { cityId: LISBON }),
      await makeLodging(t, { cityId: LISBON }),
      await makeLodging(t, { cityId: LISBON }),
    ];
    const ids = lodgings.map((lodging) => lodging.id).sort();

    // The fixture-allowing policy lists them, and the board it computed is the one the cache holds.
    await t.services.redis.client.del(CACHE_KEY);
    const allowed = await leaderboard(t.services, LISBON, 'activity');

    expect(allowed.every((entry) => entry.name.startsWith('Fixture'))).toBe(true);
    expect(idsOf(allowed)).toEqual(ids);
    expect(idsOf(await cachedBoard(CACHE_KEY))).toEqual(ids);
    await expectCacheTtl(CACHE_KEY);

    // The same city through a process that may not read fixture rows at all. On a key without the
    // environment this read is served the board above, fixtures and all.
    const refused = await leaderboard(refusing, LISBON, 'activity');

    expect(refused.filter((entry) => entry.name.startsWith('Fixture'))).toEqual([]);
    expect(idsOf(refused)).toEqual([]);

    // The two entries are independent: the refusing read wrote one of its own, and the
    // fixture-allowing board is still the one its own policy computed.
    expect(idsOf(await cachedBoard(REFUSING_CACHE_KEY))).toEqual([]);
    await expectCacheTtl(REFUSING_CACHE_KEY);
    expect(idsOf(await cachedBoard(CACHE_KEY))).toEqual(ids);
  });
});
