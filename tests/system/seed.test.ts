/**
 * Criterion 9 (AAP 0.12.1): the seeded fixture set, the code every venue console derives, and the two
 * fixture environments that refuse it. Four claims, each against the real code path rather than the
 * configuration behind it:
 *
 *  - **The set is there.** Five cities, at least ten active partner venues, ten lodgings and thirty
 *    priced places each, every place carrying `MIN_PRICED_ITEMS` price records (AAP 0.5.2).
 *  - **Every row is a fixture.** Each venue, lodging, place and price record is `is_fixture = true`,
 *    named `Fixture …`, and — where it has a number — carries one from the reserved fictional ranges
 *    of AAP 0.5.2 that the harness's own `CALL_ALLOWLIST` admits.
 *  - **Every console secret works.** Each venue secret opens `GET /venue/check-in-code`, and the code
 *    the route answers — derived from the row and the injected clock by `consoles/totp.ts`, never
 *    here — passes a real `POST /meetups/:id/check-in` at that venue's published coordinates; each
 *    lodging secret opens `GET /lodging-console/stats` (AAP 0.5.4, 0.5.7).
 *  - **Outside `test` and `demo` nothing of it exists.** A client built for `staging` or `production`
 *    reads none of it however it asks and refuses to write one, and the seed refuses `fixtures: true`
 *    there before its first write (AAP 0.5.2). A second seed changes no count and rotates no console
 *    secret, so a demo's console survives a `docker compose up`.
 *
 * Two conventions shape the suite: time comes only from the injected clock (`t.time`), each row of the
 * per-venue cases starting at `DEFAULT_TEST_NOW` so no row inherits the instant the row before it moved
 * the clock to; and the rows are read from the seed's own summary, so a case fails when the *seed*
 * misses a row rather than when a fixture file moves. The console secrets exist only once the seed hook
 * has run, so a case per venue cannot be collected before then: each city's case walks its own venues
 * and reports every failure by row id — never by code, secret, phone or coordinate (AAP 0.11.1).
 *
 * @see AAP 0.12.1 criterion 9 for the recorded result, 0.5.2 for the fixture sets, the reserved number
 *   ranges and the two environments, 0.5.4 for the console routes and their errors, 0.5.7 for the
 *   check-in rule, 0.11.1 and 0.11.2 for the harness this drives, 0.8.1 for its inventory row.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  createTestApp,
  DEFAULT_TEST_NOW,
  testCallAllowlist,
  type TestApp,
} from '@tablemate/api/test-support/app';
import {
  callRoute,
  expectError,
  makeMeetup,
  makeProof,
  makeUser,
  rows,
} from '@tablemate/api/test-support/factories';
import {
  createPrismaClient,
  fixturePredicate,
  FixturesNotAllowedError,
  type DbClient,
} from '@tablemate/db';
import { runSeed, type FixtureSecretsFile, type SeedSummary } from '@tablemate/db/seed';
import {
  CheckInResponse,
  FIXTURE_MIN_COUNTS,
  FIXTURE_PHONE_PATTERN,
  FixtureName,
  LODGING_SECRET_HEADER,
  LODGING_TREND_WEEKS,
  LodgingConsoleStats,
  MIN_PRICED_ITEMS,
  VENUE_SECRET_HEADER,
  VenueCodeResponse,
  VenuesResponse,
} from '@tablemate/shared';
import type { AppEnv, ErrorCode } from '@tablemate/shared';

/* The set the criterion names (AAP 0.5.2, 0.12.1) */

/** The five launch cities, in `config/cities.json` order. */
const CITY_IDS = ['lisbon', 'mexico-city', 'medellin', 'chiang-mai', 'canggu'] as const;

/** The two environments that may hold fixture rows: `test` and `demo`; the other two refuse them. */
const REFUSING_ENVS = ['staging', 'production'] as const satisfies readonly AppEnv[];
type RefusingEnv = (typeof REFUSING_ENVS)[number];

/** The least each city carries of a kind, and the floor Criterion 9 sets for it (AAP 0.5.2). */
const { venues: MIN_VENUES, lodgings: MIN_LODGINGS, places: MIN_PLACES } = FIXTURE_MIN_COUNTS;

/** The three reserved fictional number blocks of AAP 0.5.2: `+1 <area> 555 01xx`. */
const RESERVED_FIXTURE_NUMBER = FIXTURE_PHONE_PATTERN;

/** A console secret no venue and no lodging holds: the negative row's input, in no credential shape. */
const UNKNOWN_SECRET = 'no-such-console-secret';

/** The two console routes, each with the secret header it reads and the refusal a wrong one gets. */
const CONSOLES: readonly { route: string; header: string; refusal: ErrorCode }[] = rows([
  { route: '/v1/venue/check-in-code', header: VENUE_SECRET_HEADER, refusal: 'bad_venue_secret' },
  {
    route: '/v1/lodging-console/stats',
    header: LODGING_SECRET_HEADER,
    refusal: 'bad_lodging_secret',
  },
]);

/**
 * How long one city's console rows may take: each creates two accounts, two proofs and a locked meetup
 * with its two holds, and the whole table is fifty venues, so sixty seconds is the wrong ceiling.
 */
const CONSOLE_TABLE_TIMEOUT_MS = 300_000;

/* The suite (AAP 0.11.2) */

let t: TestApp;
let seeded: SeedSummary;
/** The guarded clients that stand for a deployment outside `test` and `demo`, built in `beforeAll`. */
let guarded: Record<RefusingEnv, DbClient>;

beforeAll(async () => {
  t = await createTestApp();
  const databaseUrl = inject('databaseUrl');
  guarded = {
    staging: createPrismaClient({ databaseUrl, appEnv: 'staging' }),
    production: createPrismaClient({ databaseUrl, appEnv: 'production' }),
  };
});

afterAll(async () => {
  await Promise.all(REFUSING_ENVS.map((appEnv) => guarded[appEnv].$disconnect()));
  await t.close();
});

/* Helpers (AAP 0.11.1, 0.11.2) */

/** One fixture console secret, in the shape the seed's summary carries it. */
type FixtureSecretEntry = FixtureSecretsFile['venues'][number];

/**
 * The seeded console secrets of one kind, in one city, from the summary the seed returned: the seed's
 * own report of what it wrote, which an entry of another city is left out of rather than asserted away.
 */
function consoleEntries(kind: 'venues' | 'lodgings', cityId: string): FixtureSecretEntry[] {
  const entries = seeded.secrets?.[kind] ?? [];
  return rows(entries.filter((entry) => entry.cityId === cityId));
}

/**
 * Why one row of a console table failed, in terms that carry no secret, phone or coordinate: the
 * error's name and, for the domain's own error, its code. A Zod issue list or a route's response body
 * can hold a coordinate or a console secret, and a run's output is not the place for either (AAP 0.11.1).
 */
function reason(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'threw a value that is not an error';
  }
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.name}(${code})` : error.name;
}

/** One row count per table a fixture row can reach. */
interface TableCounts {
  readonly cities: number;
  readonly venues: number;
  readonly lodgings: number;
  readonly places: number;
  readonly priceRecords: number;
}

/** What the database holds in every table a fixture row can reach. */
async function tableCounts(): Promise<TableCounts> {
  const db = t.services.db;
  const [cities, venues, lodgings, places, priceRecords] = await Promise.all([
    db.city.count(),
    db.venue.count(),
    db.lodging.count(),
    db.place.count(),
    db.priceRecord.count(),
  ]);
  return { cities, venues, lodgings, places, priceRecords };
}

/**
 * One seed run against the unguarded `test` client, so the refusal a fixture-free environment gets
 * can only be the seed's own gate and never the guard extension's.
 */
function seedRun(appEnv: AppEnv, fixtures: boolean): Promise<SeedSummary> {
  return runSeed({
    db: t.services.db,
    appEnv,
    keyring: t.services.keyring,
    clock: t.clock,
    fixtures,
    secretsOutPath: null,
  });
}

/** The row ids whose console secret differs between two seed runs; empty when nothing was rotated. */
function rotatedSecretIds(before: SeedSummary, after: SeedSummary): string[] {
  const previous = new Map(
    [...(before.secrets?.venues ?? []), ...(before.secrets?.lodgings ?? [])].map(
      (entry): [string, string] => [entry.id, entry.secret],
    ),
  );
  return [...(after.secrets?.venues ?? []), ...(after.secrets?.lodgings ?? [])]
    .filter((entry) => previous.get(entry.id) !== entry.secret)
    .map((entry) => entry.id);
}

/**
 * One venue, end to end: its console's code, a locked meetup at that venue, and a passing check-in.
 *
 * The clock is put on {@link DEFAULT_TEST_NOW} and moved an hour on, so every row of the table runs at
 * the same two instants whatever the row before it did; the accounts are created at that second
 * instant, which is also the one their access tokens are signed for (15 minutes, AAP 0.3.3). The meetup
 * starts an hour later — inside the five days AAP 0.5.4 allows — and the check-in is made at `startsAt`
 * exactly, inside the window of AAP 0.5.7, at the venue's own published coordinates, so the geofence
 * admits it at distance zero.
 */
async function assertVenueReachable(entry: FixtureSecretEntry): Promise<void> {
  t.time.at(DEFAULT_TEST_NOW);
  const startsAt = t.time.advance({ hours: 1 });

  const initiator = await makeUser(t);
  const recipient = await makeUser(t);
  await makeProof(t, initiator, { cityId: entry.cityId });
  await makeProof(t, recipient, { cityId: entry.cityId });
  const meetup = await makeMeetup(t, {
    status: 'locked',
    initiator,
    recipient,
    venue: { id: entry.id },
    startsAt,
  });

  // The code the venue console renders, from the route it polls: the server derives it from the row
  // and its own clock, and `expiresAt` ends the 60-second step it answered in (AAP 0.5.4, 0.5.7).
  const consoleAnswer = await callRoute(t.app, {
    method: 'GET',
    url: '/v1/venue/check-in-code',
    headers: { [VENUE_SECRET_HEADER]: entry.secret },
  });
  expect(consoleAnswer.status, `console refused for venue ${entry.id}`).toBe(200);
  const displayed = VenueCodeResponse.parse(consoleAnswer.json());
  expect(displayed.code).toMatch(/^\d{6}$/);
  expect(Date.parse(displayed.expiresAt)).toBeGreaterThan(t.time.now().getTime());

  // The coordinates the client maps the venue by, from the route that publishes them: the geofence is
  // measured from the stored point, so reading it here rather than from the column shows the two agree
  // (AAP 0.5.4, 0.5.7). That route carries the traveler guard and needs no proof.
  const listed = await callRoute(t.app, {
    method: 'GET',
    url: `/v1/cities/${entry.cityId}/venues`,
    as: initiator,
  });
  expect(listed.status, `venue list refused for city ${entry.cityId}`).toBe(200);
  const published = VenuesResponse.parse(listed.json()).items.find((item) => item.id === entry.id);
  if (published === undefined) {
    throw new Error(`venue ${entry.id} is not published by its city`);
  }

  const answer = await callRoute(t.app, {
    method: 'POST',
    url: `/v1/meetups/${meetup.id}/check-in`,
    as: initiator,
    body: { code: displayed.code, lat: published.lat, lng: published.lng },
  });
  expect(answer.status, `check-in refused for venue ${entry.id}`).toBe(200);
  expect(CheckInResponse.parse(answer.json())).toEqual({ status: 'locked', bothCheckedIn: false });
}

/* Criterion 9, against the seeded environment (AAP 0.12.1) */

describe('seeded test environment', () => {
  beforeAll(async () => {
    await t.resetState();
    seeded = await t.seedFixtures();
  });

  it.each(rows(CITY_IDS))('%s carries its venues, lodgings and priced places', async (cityId) => {
    const db = t.services.db;
    expect(
      await db.city.findUnique({ where: { id: cityId }, select: { id: true } }),
    ).not.toBeNull();

    const [venues, lodgings, places] = await Promise.all([
      db.venue.count({ where: { cityId, isActivePartner: true } }),
      db.lodging.count({ where: { cityId } }),
      db.place.count({ where: { cityId } }),
    ]);
    expect(venues).toBeGreaterThanOrEqual(MIN_VENUES);
    expect(lodgings).toBeGreaterThanOrEqual(MIN_LODGINGS);
    expect(places).toBeGreaterThanOrEqual(MIN_PLACES);

    // The estimate rule of AAP 0.5.7 needs `MIN_PRICED_ITEMS` fresh records on a place, so the seed
    // has to leave every one of them with at least that many (AAP 0.5.2).
    const priced = await db.place.findMany({
      where: { cityId },
      select: { id: true, _count: { select: { priceRecords: true } } },
    });
    const thin = rows(priced)
      .filter((place) => place._count.priceRecords < MIN_PRICED_ITEMS)
      .map((place) => place.id);
    expect(thin).toEqual([]);
  });

  it('reports the whole set, and no secret file, from the seed itself', async () => {
    expect(seeded.cities).toBe(CITY_IDS.length);
    expect(seeded.venues).toBeGreaterThanOrEqual(MIN_VENUES * CITY_IDS.length);
    expect(seeded.lodgings).toBeGreaterThanOrEqual(MIN_LODGINGS * CITY_IDS.length);
    expect(seeded.places).toBeGreaterThanOrEqual(MIN_PLACES * CITY_IDS.length);
    expect(seeded.priceRecords).toBeGreaterThanOrEqual(
      MIN_PRICED_ITEMS * MIN_PLACES * CITY_IDS.length,
    );
    expect(seeded.secrets).not.toBeNull();

    // The `.local/fixture-secrets.json` file belongs to the demo CLI; a test reads the summary.
    expect(seeded.secretsFile).toBeNull();

    const counts = await tableCounts();
    expect(counts.cities).toBe(CITY_IDS.length);
    expect(counts.venues).toBeGreaterThanOrEqual(MIN_VENUES * CITY_IDS.length);
  });

  it('flags every seeded row as a fixture', async () => {
    const db = t.services.db;
    const counts = await tableCounts();
    // Non-zero first, so the four zeroes below cannot pass against an empty database.
    expect(
      Math.min(counts.venues, counts.lodgings, counts.places, counts.priceRecords),
    ).toBeGreaterThan(0);

    const [venues, lodgings, places, priceRecords] = await Promise.all([
      db.venue.count({ where: { isFixture: false } }),
      db.lodging.count({ where: { isFixture: false } }),
      db.place.count({ where: { isFixture: false } }),
      db.priceRecord.count({ where: { isFixture: false } }),
    ]);
    expect({ venues, lodgings, places, priceRecords }).toEqual({
      venues: 0,
      lodgings: 0,
      places: 0,
      priceRecords: 0,
    });
  });

  it('names and numbers every fixture row in its reserved fictional form', async () => {
    const db = t.services.db;
    const allowed = new Set(testCallAllowlist().split(','));
    const [venues, lodgings, places] = await Promise.all([
      db.venue.findMany({ select: { id: true, name: true } }),
      db.lodging.findMany({ select: { id: true, name: true, phone: true } }),
      db.place.findMany({ select: { id: true, name: true, phone: true } }),
    ]);

    const violations: string[] = [];
    const checkName = (id: string, name: string): void => {
      // The schema `packages/shared` gives the fixture files enforces the same prefix, so a row here
      // that does not match it was not written by the seed's own path.
      if (!FixtureName.safeParse(name).success) {
        violations.push(`${id} is named outside the fixture form`);
      }
    };
    // A venue carries no number at all (AAP 0.5.2 fixes the ranges for the lodgings and the places), so
    // a missing one is a violation only where the fixture set has the column: the row id alone is
    // reported, because a phone number is a contact detail and stays out of a run's output (AAP 0.11.1).
    // Only the reserved ranges are admitted, and the harness's call allowlist has to hold them too, or
    // a demo's console would be unreachable by its own suite.
    const checkNumber = (id: string, phone: string | null): void => {
      if (phone === null || !RESERVED_FIXTURE_NUMBER.test(phone) || !allowed.has(phone)) {
        violations.push(`${id} holds a number outside the reserved ranges`);
      }
    };

    for (const venue of venues) checkName(venue.id, venue.name);
    for (const lodging of lodgings) {
      checkName(lodging.id, lodging.name);
      checkNumber(lodging.id, lodging.phone);
    }
    for (const place of places) {
      checkName(place.id, place.name);
      checkNumber(place.id, place.phone);
    }

    expect(violations).toEqual([]);
  });

  it.each(CONSOLES)('$header is refused with $refusal', async ({ route, header, refusal }) => {
    expectError(
      await callRoute(t.app, { method: 'GET', url: route, headers: { [header]: UNKNOWN_SECRET } }),
      401,
      refusal,
    );
  });

  describe('the consoles the seed provisions', { timeout: CONSOLE_TABLE_TIMEOUT_MS }, () => {
    it.each(rows(CITY_IDS))(
      'every %s venue secret returns a code that passes check-in',
      async (cityId) => {
        const venues = consoleEntries('venues', cityId);
        expect(venues.length).toBeGreaterThanOrEqual(MIN_VENUES);

        const failures: string[] = [];
        for (const venue of venues) {
          try {
            await assertVenueReachable(venue);
          } catch (error) {
            failures.push(`${venue.id}: ${reason(error)}`);
          }
        }
        expect(failures).toEqual([]);
      },
    );

    it.each(rows(CITY_IDS))('every %s lodging secret opens its console', async (cityId) => {
      const lodgings = consoleEntries('lodgings', cityId);
      expect(lodgings.length).toBeGreaterThanOrEqual(MIN_LODGINGS);

      const failures: string[] = [];
      for (const lodging of lodgings) {
        try {
          const answer = await callRoute(t.app, {
            method: 'GET',
            url: '/v1/lodging-console/stats',
            headers: { [LODGING_SECRET_HEADER]: lodging.secret },
          });
          expect(answer.status, `console refused for lodging ${lodging.id}`).toBe(200);
          const stats = LodgingConsoleStats.parse(answer.json());
          expect(stats.rank).toBeGreaterThanOrEqual(1);
          expect(stats.weeklyTrend).toHaveLength(LODGING_TREND_WEEKS);
        } catch (error) {
          failures.push(`${lodging.id}: ${reason(error)}`);
        }
      }
      expect(failures).toEqual([]);
    });
  });

  it('reseeds without changing a count or rotating a console secret', async () => {
    const before = await tableCounts();
    const again = await t.seedFixtures();

    expect(await tableCounts()).toEqual(before);
    expect(rotatedSecretIds(seeded, again)).toEqual([]);

    // The first venue's console, which a demo holds across the rerun, still answers with a code.
    const venue = consoleEntries('venues', CITY_IDS[0])[0];
    if (venue === undefined) {
      throw new Error('the seed reported no Lisbon venue');
    }
    const answer = await callRoute(t.app, {
      method: 'GET',
      url: '/v1/venue/check-in-code',
      headers: { [VENUE_SECRET_HEADER]: venue.secret },
    });
    expect(answer.status).toBe(200);
    expect(VenueCodeResponse.parse(answer.json()).code).toMatch(/^\d{6}$/);
  });
});

/* The two environments that forbid fixtures (AAP 0.5.2, 0.12.1 criterion 9) */

describe('fixture rows outside test and demo', () => {
  beforeAll(async () => {
    await t.resetState();
    seeded = await t.seedFixtures();
  });

  it.each(rows(REFUSING_ENVS))('%s reads none of them', async (appEnv) => {
    const db = guarded[appEnv];
    const lodgingId = (await t.services.db.lodging.findFirstOrThrow({ select: { id: true } })).id;

    expect(await db.venue.findMany()).toEqual([]);
    expect(await db.lodging.findUnique({ where: { id: lodgingId } })).toBeNull();
    expect(await db.place.count()).toBe(0);
    expect(await db.priceRecord.findFirst()).toBeNull();

    // A raw read is the guard's own business to keep: `$queryRaw` is left to the caller's predicate,
    // which is what the client above applies for it. The `test` control shows what is being hidden.
    const [hidden] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS "n" FROM "venue" "v" WHERE ${fixturePredicate(appEnv, 'v')}
    `;
    expect(hidden?.n).toBe(0);

    const [visible] = await t.services.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS "n" FROM "venue" "v" WHERE ${fixturePredicate('test', 'v')}
    `;
    expect(visible?.n).toBeGreaterThanOrEqual(MIN_VENUES * CITY_IDS.length);
  });

  it.each(rows(REFUSING_ENVS))('%s refuses to write one', async (appEnv) => {
    const before = await t.services.db.venue.count();

    await expect(
      guarded[appEnv].venue.create({
        data: {
          cityId: CITY_IDS[0],
          name: 'Fixture Refused Venue',
          address: '1 Fixture Street',
          isFixture: true,
        },
      }),
    ).rejects.toBeInstanceOf(FixturesNotAllowedError);

    // Refused before the statement reaches the database, so nothing was stored.
    expect(await t.services.db.venue.count()).toBe(before);
  });
});

describe('the seed outside test and demo', () => {
  beforeEach(async () => {
    await t.resetState();
  });

  it.each(rows(REFUSING_ENVS))('%s refuses fixtures and writes nothing', async (appEnv) => {
    await expect(seedRun(appEnv, true)).rejects.toBeInstanceOf(FixturesNotAllowedError);

    // The gate runs before the first write, so not even the cities were stored.
    expect(await tableCounts()).toEqual({
      cities: 0,
      venues: 0,
      lodgings: 0,
      places: 0,
      priceRecords: 0,
    });
  });

  it.each(rows(REFUSING_ENVS))('%s seeds the cities and no fixture row', async (appEnv) => {
    const summary = await seedRun(appEnv, false);

    expect(summary.cities).toBe(CITY_IDS.length);
    expect(summary.secrets).toBeNull();
    expect(await tableCounts()).toEqual({
      cities: CITY_IDS.length,
      venues: 0,
      lodgings: 0,
      places: 0,
      priceRecords: 0,
    });
  });
});
