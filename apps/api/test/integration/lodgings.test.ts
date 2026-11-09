/**
 * The lodging directory, its guest list and its leaderboard, end to end.
 *
 * The rules the cases turn on: a verified guest count below `GUEST_COUNT_THRESHOLD` is never a
 * number — it is `GUEST_COUNT_BELOW_LABEL`, in the directory and on the detail alike — an opted-in
 * guest is released only to a caller holding a valid proof for the lodging's city, and the city
 * board counts one pair once in any 30 days and ignores facts older than its 90-day window.
 *
 * The directory is cached in Redis for `LEADERBOARD_CACHE_SECONDS` under
 * `leaderboard:<APP_ENV>:<cityId>`, whose TTL is wall-clock: the reader drops this run's own key
 * before every read that must see rows a case has just written.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';

import { createPrismaClient, type DbClient } from '@tablemate/db';
import { pairKey } from '@tablemate/server-core';
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
  MINUTE_MS,
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
  LEADERBOARD_CACHE_VERSION,
  LODGING_ACTIVITY_FACTS_LIMIT,
  LODGING_DIRECTORY_LIMIT,
  leaderboard,
  lodgingStats,
  type LodgingLeaderboardServices,
} from '../../src/modules/lodgings/leaderboard.ts';
import { LODGING_GUEST_LIST_LIMIT } from '../../src/modules/lodgings/visibility.ts';

const LISBON = 'lisbon';

/** Another launch city, whose proof must never open the Lisbon directory (AAP 0.5.7). */
const MEXICO_CITY = 'mexico-city';

/** A slug `CitySlug` accepts that this deployment is not configured with. */
const UNKNOWN_CITY = 'narnia';

const MISSING_LODGING_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The directory's cache entry under this run's own fixture policy,
 * `leaderboard:test:<cityId>`, rewritten by every recomputation. `APP_ENV` is in the key, so the
 * integration project's own `test` policy is named here.
 */
const CACHE_KEY = `leaderboard:test:${LISBON}`;

const FORBIDDEN_IN_RESPONSE = ['secret', 'cipher', 'booking', 'nullifier', 'emailCiphertext'];

/** The words a guest-list key path must never carry: a stay date or a room field would be one. */
const FORBIDDEN_GUEST_PATH = /stay|room|booking/i;

let t: TestApp;

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

type Actor = UserFixture | null;

async function listRoute(cityId: string, actor: Actor, sort?: string): Promise<RouteResponse> {
  return await callRoute(t.app, {
    method: 'GET',
    url: `/v1/cities/${cityId}/lodgings`,
    ...(actor === null ? {} : { as: actor }),
    ...(sort === undefined ? {} : { query: { sort } }),
  });
}

async function detailRoute(lodgingId: string, actor: Actor): Promise<RouteResponse> {
  return await callRoute(t.app, {
    method: 'GET',
    url: `/v1/lodgings/${lodgingId}`,
    ...(actor === null ? {} : { as: actor }),
  });
}

async function setStaying(actor: UserFixture, showStaying: boolean): Promise<RouteResponse> {
  return await callRoute(t.app, {
    method: 'PUT',
    url: '/v1/me/lodging-visibility',
    as: actor,
    body: { showStaying },
  });
}

/**
 * The city's activity-ordered directory, read past the cache: the key is dropped first so the board
 * reflects the rows the case has just written, and the TTL the write left behind is asserted, which
 * pins the cache key, its lifetime and the fact that a read repopulates it. `sort=name` re-sorts the
 * same board and writes the same entry, so the check holds for both orders.
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

function item(items: readonly LodgingSummary[], lodgingId: string): LodgingSummary {
  const found = items.find((entry) => entry.id === lodgingId);
  if (found === undefined) {
    throw new Error(`the directory lists no lodging with id ${lodgingId}`);
  }
  return found;
}

async function readDetail(lodgingId: string): Promise<RouteResponse> {
  await t.services.redis.client.del(CACHE_KEY);
  const response = await detailRoute(lodgingId, viewer);
  expect(response.status).toBe(200);
  return response;
}

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

function ago(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

function dayFrom(now: Date, days: number): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * A pair for one lodging fact. A fact carries a keyed hash of two traveler ids and no user id at
 * all, so the pair needs no account rows: two fresh ids are what the key is taken over.
 */
function pairOf(): readonly [FixtureRef, FixtureRef] {
  return [{ id: randomUUID() }, { id: randomUUID() }];
}

/**
 * One lodging under a name the case controls. `makeLodging` numbers its own names from a counter
 * that runs for the whole process, so their alphabetical order is not the order the cases create
 * them in; the leaderboard orders by name, so the scenario's own names are written over it.
 */
async function namedLodging(name: string): Promise<LodgingFixture> {
  const lodging = await makeLodging(t, { cityId: LISBON });
  await t.services.db.lodging.update({ where: { id: lodging.id }, data: { name } });
  return { ...lodging, name };
}

interface GuestOptions {
  readonly status?: LodgingClaimStatus;
  readonly stayFrom?: string;
  readonly stayTo?: string;
}

interface GuestFixture {
  readonly user: UserFixture;
  readonly claim: ClaimFixture;
}

/**
 * One guest with a claim on `lodging`, `verified` unless the case says otherwise. A verified claim
 * whose `stayTo` has not passed is what the guest count, the guest list and the visibility toggle
 * all read, so this is the shape every criterion-15 case starts from.
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

type ViewerKind = 'valid' | 'no-proof' | 'other-city' | 'no-consent';

async function actorFor(kind: ViewerKind | 'none'): Promise<Actor> {
  if (kind === 'none') return null;
  if (kind === 'valid') return viewer;
  const user = await makeUser(t, kind === 'no-consent' ? { consents: false } : {});
  if (kind === 'other-city') await makeProof(t, user, { cityId: MEXICO_CITY });
  return user;
}

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

interface GuestCountRow {
  readonly guests: number;
  readonly expected: GuestCount;
}

/**
 * The counts criterion 15 is read at, straddling `GUEST_COUNT_THRESHOLD`: below it the count is the
 * label, at and above it the number itself.
 */
const GUEST_COUNTS: readonly GuestCountRow[] = [
  { guests: 0, expected: GUEST_COUNT_BELOW_LABEL },
  { guests: 1, expected: GUEST_COUNT_BELOW_LABEL },
  { guests: 2, expected: GUEST_COUNT_BELOW_LABEL },
  { guests: 3, expected: 3 },
  { guests: 4, expected: 4 },
];

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

type BoardKey = 'alpha' | 'bravo' | 'charlie' | 'delta' | 'echo';

interface BoardFixture {
  readonly lodgings: Readonly<Record<BoardKey, LodgingFixture>>;
  readonly charliePair: readonly [FixtureRef, FixtureRef];
}

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

const CHARLIE_PAIR_DAYS_AGO = LEADERBOARD_PAIR_DEDUPE_DAYS + 10;
const CHARLIE_OTHER_PAIR_DAYS_AGO = CHARLIE_PAIR_DAYS_AGO - 5;

const INSIDE_PAIR_WINDOW_GAP_DAYS = 10;
const PAST_PAIR_WINDOW_GAP_DAYS = LEADERBOARD_PAIR_DEDUPE_DAYS + 1;

const OUTSIDE_WINDOW_DAYS_AGO = LEADERBOARD_WINDOW_DAYS + 10;

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

/** One warning line the module wrote, kept as the fields it carries (AAP 0.11.1). */
type WarningLine = Record<string, unknown>;

/** The services a case drives the module with, and the warning lines the module wrote through them. */
interface RecordedServices {
  readonly services: LodgingLeaderboardServices;
  readonly warnings: WarningLine[];
}

/**
 * The run's own services over a logger that keeps every warning the module writes, so a case can read
 * the line a bounded answer is reported with (AAP 0.11.1).
 *
 * The directory route calls this module with services built the same way — `t.services` narrowed to
 * {@link LodgingLeaderboardServices} — so the line asserted here is the line the route writes; only
 * the logger differs, because the app's own logger writes to the process rather than to the case.
 */
function recordingServices(db: DbClient): RecordedServices {
  const warnings: WarningLine[] = [];
  return {
    warnings,
    services: {
      db,
      redis: t.services.redis,
      clock: t.services.clock,
      logger: {
        warn: (...args: unknown[]): void => {
          const first = args[0];
          warnings.push(typeof first === 'object' && first !== null ? (first as WarningLine) : {});
        },
      },
      env: { APP_ENV: t.env.APP_ENV, ANALYTICS_SALT: t.env.ANALYTICS_SALT },
      timezoneFor: t.services.timezoneFor,
    },
  };
}

/** The lines of `warnings` carrying `event`, in the order they were written (AAP 0.11.1). */
function warningsFor(warnings: readonly WarningLine[], event: string): WarningLine[] {
  return warnings.filter((line) => line.event === event);
}

/** How many lodgings {@link createLodgings} opens at once: past this the client queue does the rest. */
const LODGING_CREATE_BATCH = 50;

/** `count` lodgings in Lisbon, created in batches rather than all in one `Promise.all`. */
async function createLodgings(count: number): Promise<LodgingFixture[]> {
  const created: LodgingFixture[] = [];
  while (created.length < count) {
    const size = Math.min(LODGING_CREATE_BATCH, count - created.length);
    created.push(
      ...(await Promise.all(
        Array.from({ length: size }, () => makeLodging(t, { cityId: LISBON })),
      )),
    );
  }
  return created;
}

/** One lodging in Lisbon, failing the case when none was created. */
async function oneLodging(): Promise<LodgingFixture> {
  const [lodging] = await createLodgings(1);
  if (lodging === undefined) {
    throw new Error('no lodging was created');
  }
  return lodging;
}

describe('the bound on a directory answer', () => {
  it('answers the bound and keeps the lodgings that witnessed a meetup', async () => {
    // The two lodgings that carry activity sort last of all by name, so a bound cut in name order
    // alone would drop exactly these two; the order the bound cuts in has them first instead.
    const scored = [
      await namedLodging('Zzz Scored Lodging A'),
      await namedLodging('Zzz Scored Lodging B'),
    ];
    const quiet = await createLodgings(LODGING_DIRECTORY_LIMIT - 1);
    const quietIds = new Set(quiet.map((lodging) => lodging.id));
    const now = t.time.now();
    for (const lodging of scored) {
      await makeActivityFacts(t, lodging, [{ pair: pairOf(), completedAt: ago(now, 1) }]);
    }
    const recorded = recordingServices(t.services.db);
    const listed = await leaderboard(recorded.services, LISBON, 'activity');
    expect(listed).toHaveLength(LODGING_DIRECTORY_LIMIT);
    expect(listed.slice(0, 2).map((entry) => entry.id)).toEqual(
      scored.map((lodging) => lodging.id),
    );
    expect(listed.slice(0, 2).map((entry) => entry.rank)).toEqual([1, 2]);
    // Exactly one lodging is missing, and it is one that witnessed nothing.
    expect(listed.filter((entry) => quietIds.has(entry.id))).toHaveLength(
      LODGING_DIRECTORY_LIMIT - 2,
    );
    expect(warningsFor(recorded.warnings, 'lodgings_truncated')).toEqual([
      { event: 'lodgings_truncated', cityId: LISBON, limit: LODGING_DIRECTORY_LIMIT },
    ]);
    // The route answers the same board over the app's own services, and caches it again.
    const items = await board();
    expect(items.map((entry) => entry.id)).toEqual(listed.map((entry) => entry.id));
  });

  it('saturates one lodging at the facts bound and reports the cap', async () => {
    const lodging = await oneLodging();
    const now = t.time.now();
    // A distinct pair per fact, so every fact inside the window would count on its own and the score
    // is exactly the number of facts the read kept.
    await t.services.db.lodgingActivityFact.createMany({
      data: Array.from({ length: LODGING_ACTIVITY_FACTS_LIMIT + 1 }, () => ({
        lodgingId: lodging.id,
        meetupId: randomUUID(),
        pairKey: pairKey(t.env.ANALYTICS_SALT, randomUUID(), randomUUID()),
        completedAt: now,
      })),
    });
    const recorded = recordingServices(t.services.db);
    const listed = await leaderboard(recorded.services, LISBON, 'activity');
    expect(item(listed, lodging.id).activityScore).toBe(LODGING_ACTIVITY_FACTS_LIMIT);
    expect(warningsFor(recorded.warnings, 'lodging_activity_facts_capped')).toEqual([
      {
        event: 'lodging_activity_facts_capped',
        lodgingId: lodging.id,
        limit: LODGING_ACTIVITY_FACTS_LIMIT,
      },
    ]);
    // The reads that score this lodging on its own — its console standings and its detail summary —
    // clip at the same bound, so the three readers report one number rather than the directory
    // reporting the bound and the console the lodging's own larger count.
    const standings = await lodgingStats(recorded.services, lodging.id);
    expect(standings.activityScore).toBe(LODGING_ACTIVITY_FACTS_LIMIT);
    expect(standings.weeklyTrend.reduce((sum, point) => sum + point.activityScore, 0)).toBe(
      LODGING_ACTIVITY_FACTS_LIMIT,
    );
  });
});

describe('the detail route over a bounded directory', () => {
  it('answers a lodging the bound left out with its own numbers, not as one that does not exist', async () => {
    const now = t.time.now();
    // A board full to its bound, every lodging in it carrying a meetup inside the window, so the two
    // lodgings below are ones the cut leaves out however their own data reads.
    const fullBoard = await createLodgings(LODGING_DIRECTORY_LIMIT);
    await t.services.db.lodgingActivityFact.createMany({
      data: fullBoard.map((lodging) => ({
        lodgingId: lodging.id,
        meetupId: randomUUID(),
        pairKey: pairKey(t.env.ANALYTICS_SALT, randomUUID(), randomUUID()),
        completedAt: now,
      })),
    });
    // The name sorts after every listed one's, so a name the cut orders by drops this lodging.
    const scored = await namedLodging('Zzz Cap Lodging Scored');
    await makeActivityFacts(t, scored, [
      { pair: pairOf(), completedAt: ago(now, 1) },
      { pair: pairOf(), completedAt: ago(now, 2) },
    ]);
    // Carrying no fact inside the window and three current verified guests of its own.
    const quiet = await namedLodging('Zzz Cap Lodging Quiet');
    for (let index = 0; index < GUEST_COUNT_THRESHOLD; index += 1) {
      await makeGuest(quiet);
    }
    await makeActivityFacts(t, quiet, [
      { pair: pairOf(), completedAt: ago(now, OUTSIDE_WINDOW_DAYS_AGO) },
    ]);
    const items = await board();
    const listedIds = items.map((entry) => entry.id);
    expect(items).toHaveLength(LODGING_DIRECTORY_LIMIT);
    expect(listedIds).not.toContain(scored.id);
    expect(listedIds).not.toContain(quiet.id);
    // The scored one is answered with the two facts of its own window and the position after the
    // whole board; the quiet one with the count its own three current guests give it and a score of
    // 0, because its only fact is older than the window (AAP 0.5.7).
    const scoredDetail = LodgingDetail.parse((await readDetail(scored.id)).json());
    expect(scoredDetail.activityScore).toBe(2);
    expect(scoredDetail.guestCount).toBe(GUEST_COUNT_BELOW_LABEL);
    expect(scoredDetail.rank).toBe(LODGING_DIRECTORY_LIMIT + 1);
    const quietDetail = LodgingDetail.parse((await readDetail(quiet.id)).json());
    expect(quietDetail.activityScore).toBe(0);
    expect(quietDetail.guestCount).toBe(GUEST_COUNT_THRESHOLD);
    expect(quietDetail.rank).toBe(LODGING_DIRECTORY_LIMIT + 1);
    // Its own row, through the mapping the directory uses: the fields the contract publishes, no
    // more, and the name and number the row itself holds.
    expect(quietDetail.name).toBe(quiet.name);
    expect(quietDetail.phone).toBe(quiet.phone);
    expect(Object.keys(quietDetail).sort()).toEqual(Object.keys(LodgingDetail.shape).sort());
  });

  it('bounds a guest list at the limit, the newest resolved stay first', async () => {
    const lodging = await oneLodging();
    const now = t.time.now();
    const guests: GuestFixture[] = [];
    // One opted-in guest more than the list answers, each with its own resolved instant, so a list
    // that were unbounded would carry one guest more and a list cut in any other order would carry
    // the oldest stay (AAP 0.5.7).
    for (let index = 0; index <= LODGING_GUEST_LIST_LIMIT; index += 1) {
      const guest = await makeGuest(lodging);
      await t.services.db.lodgingClaim.update({
        where: { id: guest.claim.id },
        data: { resolvedAt: new Date(now.getTime() - index * MINUTE_MS) },
      });
      await makeVisibility(t, guest.user, guest.claim, true);
      guests.push(guest);
    }
    const detail = LodgingDetail.parse((await readDetail(lodging.id)).json());
    expect(detail.guests).toHaveLength(LODGING_GUEST_LIST_LIMIT);
    expect(detail.guests.map((entry) => entry.id)).toEqual(
      guests.slice(0, LODGING_GUEST_LIST_LIMIT).map((guest) => guest.user.id),
    );
    // The count beside the list is every current verified guest, so a list shorter than it is a cut
    // list a reader can see rather than a claim that nobody else is staying here (AAP 0.5.7).
    expect(detail.guestCount).toBe(LODGING_GUEST_LIST_LIMIT + 1);
  });

  it('answers a lodging the board carries with exactly the numbers the board published', async () => {
    const now = t.time.now();
    const carried = await namedLodging('Zzz Carried Lodging');
    await makeActivityFacts(t, carried, [{ pair: pairOf(), completedAt: ago(now, 1) }]);
    for (let index = 0; index < GUEST_COUNT_THRESHOLD; index += 1) {
      await makeGuest(carried);
    }
    const listed = item(await board(), carried.id);
    const detail = LodgingDetail.parse((await readDetail(carried.id)).json());
    const { lat, lng, guests, ...summary } = detail;
    // Field for field the same object as the directory's entry, so a lodging both answers carry is
    // described the same way by both (AAP 0.5.4).
    expect(summary).toEqual(listed);
    expect(lat).toBeCloseTo(carried.lat, 6);
    expect(lng).toBeCloseTo(carried.lng, 6);
    // Nobody opted in, so the list is empty while the count still reports the three guests.
    expect(guests).toEqual([]);
    expect(listed.guestCount).toBe(GUEST_COUNT_THRESHOLD);
    expect(listed.activityScore).toBe(1);
  });
});

/**
 * The entries a hit must refuse rather than serve (AAP 0.5.7), as (title, raw entry) rows: a bare
 * array an older process wrote, a stamp a later version wrote, a value that is not an object, and
 * JSON that will not parse.
 */
const STALE_ENTRIES: readonly (readonly [string, string])[] = [
  ['a bare array', JSON.stringify([])],
  ['a stamp from a later version', JSON.stringify({ v: LEADERBOARD_CACHE_VERSION + 1, items: [] })],
  ['a value that is not an object', JSON.stringify('not a board')],
  ['JSON that will not parse', '{ not json'],
];

describe('the directory cache entry', () => {
  it.each(rows(STALE_ENTRIES))('recomputes and re-stamps %s', async (_title, raw) => {
    const lodging = await oneLodging();
    const recorded = recordingServices(t.services.db);
    // One board is computed first, so the entry the case overwrites is one this process wrote: the
    // read below then proves the entry was refused and recomputed, not simply absent.
    await leaderboard(recorded.services, LISBON, 'activity');
    expect(await cachedVersion(CACHE_KEY)).toBe(LEADERBOARD_CACHE_VERSION);
    await t.services.redis.client.set(CACHE_KEY, raw, 'EX', LEADERBOARD_CACHE_SECONDS);
    const listed = await leaderboard(recorded.services, LISBON, 'activity');
    expect(idsOf(listed)).toEqual([lodging.id]);
    expect(warningsFor(recorded.warnings, 'leaderboard_cache_invalid')).toEqual([
      { event: 'leaderboard_cache_invalid', cityId: LISBON },
    ]);
    expect(await cachedVersion(CACHE_KEY)).toBe(LEADERBOARD_CACHE_VERSION);
  });
});

/** The environment the second policy stands for: one that may neither write nor read fixture rows. */
const REFUSING_ENV = 'staging' as const;

const REFUSING_CACHE_KEY = `leaderboard:${REFUSING_ENV}:${LISBON}`;

/**
 * The services of the fixture-refusing policy: the run's own Redis, clock and logger, over a client
 * built for an environment outside `test` and `demo`.
 *
 * The case drives the module's exported {@link leaderboard} rather than a second app, because the
 * harness cannot build one: `buildApp` refuses a fault injector outside `APP_ENV=test` and the
 * factory always supplies one. The directory route calls exactly this function with exactly these
 * services, so the cache key under test is the one the route reads and writes.
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

function idsOf(items: readonly LodgingSummary[]): string[] {
  return items.map((entry) => entry.id).sort();
}

async function cachedBoard(key: string): Promise<readonly LodgingSummary[]> {
  return (await cachedEntry(key)).items;
}

/** The version stamp one cache entry carries, which a case reads to see the entry was re-stamped. */
async function cachedVersion(key: string): Promise<unknown> {
  return (await cachedEntry(key)).v;
}

/**
 * The envelope one cache key holds: the board `items` carries, and the `v` stamp that gates a hit
 * (AAP 0.5.7).
 *
 * The entry is the version-stamped envelope the module writes, not the bare board — a bare array is a
 * shape the module refuses and recomputes — so a case reads both halves; `items` is parsed as the
 * board the contract publishes, which is what an older process's array could not satisfy.
 *
 * @param key - The cache key to read.
 * @returns The entry's stamp and its board.
 */
async function cachedEntry(
  key: string,
): Promise<{ readonly v: unknown; readonly items: readonly LodgingSummary[] }> {
  const raw = await t.services.redis.client.get(key);
  if (raw === null) {
    throw new Error(`no leaderboard cache entry at ${key}`);
  }
  const decoded = JSON.parse(raw) as { readonly v?: unknown; readonly items?: unknown };
  if (decoded.items === undefined) {
    throw new Error(`the leaderboard cache entry at ${key} carries no items`);
  }
  return { v: decoded.v, items: LodgingSummary.array().parse(decoded.items) };
}

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
