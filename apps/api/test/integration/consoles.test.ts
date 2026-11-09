/**
 * The two console routes: a partner venue's rotating check-in code and one lodging's leaderboard
 * standings. Every instant comes from the injected clock and every secret is minted by a fixture
 * or generated per request, so nothing credential-shaped is written here.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CODE_STEP_SECONDS,
  DAY_MS,
  GUEST_COUNT_BELOW_LABEL,
  GUEST_COUNT_THRESHOLD,
  LODGING_SECRET_HEADER,
  LODGING_TREND_WEEKS,
  LodgingConsoleStats,
  VENUE_SECRET_HEADER,
  VenueCodeResponse,
} from '@tablemate/shared';

import { codeFor, counterAt } from '../../src/modules/consoles/totp.ts';
import { createTestApp } from '../support/app.ts';
import {
  callRoute,
  expectError,
  makeActivityFacts,
  makeClaim,
  makeLodging,
  makeUser,
  makeVenue,
  rows,
} from '../support/factories.ts';

import type { TestApp } from '../support/app.ts';
import type { FixtureRef, RouteResponse } from '../support/factories.ts';

const VENUE_CODE_PATH = '/v1/venue/check-in-code';

const LODGING_STATS_PATH = '/v1/lodging-console/stats';

/** One of the five seeded launch cities: a console belongs to one venue or lodging, not to a city. */
const CITY_ID = 'lisbon';

let t: TestApp;

type HeaderBag = Readonly<Record<string, string | string[] | number | undefined>>;

beforeAll(async () => {
  t = await createTestApp();
});

beforeEach(async () => {
  // A fresh database, flushed Redis and a clock back at the harness's start instant, so each case
  // reads only its own fixtures and the leaderboard cache a previous case wrote (AAP 0.11.2).
  await t.resetState();
  await t.seedCities();
});

afterAll(async () => {
  await t.close();
});

/**
 * One response header as a single lower-cased string (AAP 0.3.2): a header arrives as a string, an
 * array, a number or nothing, and an absent one reads `''` so a case that expects it fails on the
 * comparison rather than on a dereference.
 */
function header(headers: HeaderBag, name: string): string {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value.join(', ').toLowerCase();
  }
  return value === undefined ? '' : String(value).toLowerCase();
}

function endOfStepIso(at: Date): string {
  return new Date((counterAt(at) + 1) * CODE_STEP_SECONDS * 1000).toISOString();
}

/** A console secret no row holds: the 32 fresh random bytes one is issued from (AAP 0.3.2). */
function unknownSecret(): string {
  return randomBytes(32).toString('base64url');
}

function issued(secret: string | null): string {
  if (secret === null) {
    throw new Error('the fixture was built without a console secret');
  }
  return secret;
}

/**
 * Two distinct ids for one activity fact, and no account behind them: a fact carries a keyed hash of
 * the pair and never a user reference (AAP 0.5.7).
 */
function pair(): readonly [FixtureRef, FixtureRef] {
  return [{ id: randomUUID() }, { id: randomUUID() }];
}

async function lodgingStats(secret: string): Promise<LodgingConsoleStats> {
  const response = await callRoute(t.app, {
    method: 'GET',
    url: LODGING_STATS_PATH,
    headers: { [LODGING_SECRET_HEADER]: secret },
  });
  expect(response.status).toBe(200);
  return LodgingConsoleStats.parse(response.json());
}

interface SecretFailure {
  readonly label: string;
  readonly headers: () => Promise<Record<string, string>>;
}

describe('GET /v1/venue/check-in-code', () => {
  const failures: readonly SecretFailure[] = [
    { label: 'no secret header at all', headers: () => Promise.resolve({}) },
    {
      label: 'a random secret no venue holds',
      headers: () => Promise.resolve({ [VENUE_SECRET_HEADER]: unknownSecret() }),
    },
    {
      label: 'a lodging secret sent as a venue secret',
      headers: async () => {
        const lodging = await makeLodging(t, { cityId: CITY_ID, withSecret: true });
        return { [VENUE_SECRET_HEADER]: issued(lodging.secret) };
      },
    },
  ];
  it.each(rows(failures))('answers 401 bad_venue_secret for $label', async ({ headers: build }) => {
    const response = await callRoute(t.app, {
      method: 'GET',
      url: VENUE_CODE_PATH,
      headers: await build(),
    });
    expectError(response, 401, 'bad_venue_secret');
  });
  it('answers the code the secret derives for the current step, and caches nothing', async () => {
    const venue = await makeVenue(t, { cityId: CITY_ID });
    const secret = issued(venue.secret);
    const now = t.clock.now();
    const response = await callRoute(t.app, {
      method: 'GET',
      url: VENUE_CODE_PATH,
      headers: { [VENUE_SECRET_HEADER]: secret },
    });
    expect(response.status).toBe(200);
    const body = VenueCodeResponse.parse(response.json());
    expect(body.code).toBe(codeFor(secret, now).code);
    expect(body.expiresAt).toBe(endOfStepIso(now));
    expect(header(response.headers, 'cache-control')).toContain('no-store');
    // The console holds the secret already; nothing of it reaches the body or a cache (AAP 0.3.2).
    expect(response.body).not.toContain(secret);
  });
  it('answers a new code one step later', async () => {
    const venue = await makeVenue(t, { cityId: CITY_ID });
    const secret = issued(venue.secret);
    const request = (): Promise<RouteResponse> =>
      callRoute(t.app, {
        method: 'GET',
        url: VENUE_CODE_PATH,
        headers: { [VENUE_SECRET_HEADER]: secret },
      });
    const first = VenueCodeResponse.parse((await request()).json());
    const later = t.time.advance({ seconds: CODE_STEP_SECONDS });
    const second = VenueCodeResponse.parse((await request()).json());
    expect(second.code).toBe(codeFor(secret, later).code);
    expect(Date.parse(second.expiresAt) - Date.parse(first.expiresAt)).toBe(
      CODE_STEP_SECONDS * 1000,
    );
  });
  it('refuses a bearer token that carries no console secret', async () => {
    const user = await makeUser(t);
    const response = await callRoute(t.app, {
      method: 'GET',
      url: VENUE_CODE_PATH,
      as: user.accessToken,
    });
    expectError(response, 401, 'bad_venue_secret');
  });
});

describe('console CORS', () => {
  it('lets the venue console origin read the server clock', async () => {
    const venue = await makeVenue(t, { cityId: CITY_ID });
    const response = await callRoute(t.app, {
      method: 'GET',
      url: VENUE_CODE_PATH,
      headers: { [VENUE_SECRET_HEADER]: issued(venue.secret), origin: t.env.VENUE_CONSOLE_ORIGIN },
    });
    expect(response.status).toBe(200);
    expect(header(response.headers, 'access-control-allow-origin')).toBe(
      t.env.VENUE_CONSOLE_ORIGIN,
    );
    // The countdown is measured from `Date`, which a browser withholds unless CORS exposes it.
    expect(header(response.headers, 'access-control-expose-headers')).toContain('date');
  });
  it('approves a preflight that asks for the venue secret header', async () => {
    // A preflight is an `OPTIONS` the browser sends before the real request, which `callRoute`'s
    // method union does not carry, so it goes through the app's own `inject`.
    const preflight = await t.app.inject({
      method: 'OPTIONS',
      url: VENUE_CODE_PATH,
      headers: {
        origin: t.env.VENUE_CONSOLE_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': VENUE_SECRET_HEADER,
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(header(preflight.headers, 'access-control-allow-origin')).toBe(
      t.env.VENUE_CONSOLE_ORIGIN,
    );
    expect(header(preflight.headers, 'access-control-allow-headers')).toContain(
      VENUE_SECRET_HEADER.toLowerCase(),
    );
  });
  it('answers an origin outside the allowlist without its CORS headers', async () => {
    const venue = await makeVenue(t, { cityId: CITY_ID });
    const response = await callRoute(t.app, {
      method: 'GET',
      url: VENUE_CODE_PATH,
      headers: {
        [VENUE_SECRET_HEADER]: issued(venue.secret),
        origin: 'https://elsewhere.example.test',
      },
    });
    // The route still answers — CORS is the browser's rule, not the server's — but withholds the
    // allow-origin header, so a page on that origin cannot read the answer.
    expect(response.status).toBe(200);
    expect(header(response.headers, 'access-control-allow-origin')).toBe('');
  });
});

describe('GET /v1/lodging-console/stats', () => {
  const failures: readonly SecretFailure[] = [
    { label: 'no secret header at all', headers: () => Promise.resolve({}) },
    {
      label: 'a random secret no lodging holds',
      headers: () => Promise.resolve({ [LODGING_SECRET_HEADER]: unknownSecret() }),
    },
    {
      label: 'a venue secret sent as a lodging secret',
      headers: async () => {
        const venue = await makeVenue(t, { cityId: CITY_ID });
        return { [LODGING_SECRET_HEADER]: issued(venue.secret) };
      },
    },
  ];
  it.each(rows(failures))(
    'answers 401 bad_lodging_secret for $label',
    async ({ headers: build }) => {
      const response = await callRoute(t.app, {
        method: 'GET',
        url: LODGING_STATS_PATH,
        headers: await build(),
      });
      expectError(response, 401, 'bad_lodging_secret');
    },
  );
  it('scores the facts the activity rule counts, over 13 weekly points', async () => {
    const lodging = await makeLodging(t, { cityId: CITY_ID, withSecret: true });
    const now = t.clock.now();
    const recurring = pair();
    await makeActivityFacts(t, lodging, [
      { pair: recurring, completedAt: new Date(now.getTime() - DAY_MS) },
      // The same pair a day later: inside the 30-day window, so it is not counted a second time.
      { pair: recurring, completedAt: now },
      { pair: pair(), completedAt: now },
    ]);
    const stats = await lodgingStats(issued(lodging.secret));
    expect(stats.activityScore).toBe(2);
    expect(stats.weeklyTrend).toHaveLength(LODGING_TREND_WEEKS);
    // The points bucket the counted facts themselves, so the trend accounts for the whole score.
    expect(stats.weeklyTrend.reduce((sum, point) => sum + point.activityScore, 0)).toBe(
      stats.activityScore,
    );
  });
  it('never leaves a guest count below the threshold as a number', async () => {
    const lodging = await makeLodging(t, { cityId: CITY_ID, withSecret: true });
    const [first, second, third] = [await makeUser(t), await makeUser(t), await makeUser(t)];
    const secret = issued(lodging.secret);
    await makeClaim(t, first, lodging, { status: 'verified' });
    await makeClaim(t, second, lodging, { status: 'verified' });
    expect((await lodgingStats(secret)).verifiedGuests).toBe(GUEST_COUNT_BELOW_LABEL);
    await makeClaim(t, third, lodging, { status: 'verified' });
    expect((await lodgingStats(secret)).verifiedGuests).toBe(GUEST_COUNT_THRESHOLD);
  });
  it('ranks a scored lodging ahead of one that witnessed nothing', async () => {
    const [scored, quiet] = [
      await makeLodging(t, { cityId: CITY_ID, withSecret: true }),
      await makeLodging(t, { cityId: CITY_ID, withSecret: true }),
    ];
    const now = t.clock.now();
    await makeActivityFacts(t, scored, [
      { pair: pair(), completedAt: now },
      { pair: pair(), completedAt: now },
    ]);
    expect((await lodgingStats(issued(scored.secret))).rank).toBe(1);
    expect((await lodgingStats(issued(quiet.secret))).rank).toBe(2);
  });
});
