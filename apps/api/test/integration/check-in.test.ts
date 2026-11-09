/**
 * The witnessed check-in: the venue's rotating code, the 150 m geofence, the window from `startsAt − 15 min` to `startsAt + 45 min`,
 * and what an attempt leaves behind.
 *
 * Two rules the cases turn on: the refusals arrive in the contract's order, so a request breaking two rules is answered with the first,
 * and the stored row holds the result and a distance bucket and no coordinate column at all.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { distanceFrom } from '@tablemate/db';
import {
  CODE_DIGITS,
  CODE_STEP_SECONDS,
  CODE_TOLERANCE_STEPS,
  CheckInResponse,
  DISTANCE_BUCKET_SPLIT_METERS,
  GEOFENCE_METERS,
  MINUTE_MS,
  VENUE_SECRET_HEADER,
  VenueCodeResponse,
} from '@tablemate/shared';
import { LOGGER_REDACT_PATHS } from '@tablemate/server-core';

import { codeFor } from '../../src/modules/consoles/totp.ts';
import { createTestApp } from '../support/app.ts';
import {
  callRoute,
  expectError,
  makeMeetup,
  makeUser,
  makeVenue,
  rows,
} from '../support/factories.ts';

import type {
  CheckInRequest,
  ErrorCode,
  LatLng,
  MeetupStatus,
  ParticipantRole,
} from '@tablemate/shared';
import type { TestApp } from '../support/app.ts';
import type { MeetupPoint } from '../support/clock.ts';
import type {
  ActorRef,
  FixtureRef,
  MeetupFixture,
  RouteResponse,
  UserFixture,
  VenueFixture,
} from '../support/factories.ts';

const CHECK_IN_PATH = (meetupId: string): string => `/v1/meetups/${meetupId}/check-in`;

const VENUE_CODE_PATH = '/v1/venue/check-in-code';

const CITY_ID = 'lisbon';

/** A venue location no rule or fixture produces by accident (AAP 0.12.2): a value that leaked into
 * a stored row or a log field would be recognisable rather than plausible. */
const VENUE_LOCATION: LatLng = { lat: 38.7123456, lng: -9.139337 };

/**
 * Metres in one degree of latitude, for offsets of at most a few hundred metres. A metre of slack is enough for every distance below,
 * but not for the geofence's inclusive edge, which {@link projected} places instead (AAP 0.5.7).
 */
const METERS_PER_DEGREE_LAT = 111_320;

/** Distances either side of the two boundaries of AAP 0.5.7, each with a margin it cannot drift
 * over. The geofence's own edge is not among them: it is a projected coordinate, not an offset. */
const NEAR_METERS = DISTANCE_BUCKET_SPLIT_METERS - 20; // 30 m: inside the geofence, bucket `lt_50`
const MID_METERS = DISTANCE_BUCKET_SPLIT_METERS + 70; // 120 m: bucket `m50_150`
const FRINGE_METERS = GEOFENCE_METERS - 10; // 140 m: still inside the geofence
const OUTSIDE_METERS = GEOFENCE_METERS + 50; // 200 m: criterion 6's refusal
const TOLERATED_STEPS: readonly number[] = Array.from(
  { length: 2 * CODE_TOLERANCE_STEPS + 1 },
  (_unused, index) => index - CODE_TOLERANCE_STEPS,
);

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

beforeEach(async () => {
  // A fresh database, flushed Redis and a clock back at the harness's start instant, so each case
  // reads only its own fixtures (AAP 0.11.2).
  await t.resetState();
  await t.seedCities();
});

afterAll(async () => {
  await t.close();
});

interface Base {
  readonly venue: VenueFixture;
  readonly meetup: MeetupFixture;
  readonly initiator: UserFixture;
  readonly recipient: UserFixture;
  readonly stranger: UserFixture;
}

/**
 * A meetup in `status` for a fresh pair at a fresh secret-bearing venue. `makeMeetup` writes the rows the state machine would have left, so
 * a `held` deposit is a real authorization at the provider; the default start is two hours out when open, three hours back when final.
 */
async function pairIn(status: MeetupStatus): Promise<Base> {
  const venue = await makeVenue(t, { cityId: CITY_ID, ...VENUE_LOCATION });
  const initiator = await makeUser(t);
  const recipient = await makeUser(t);
  const stranger = await makeUser(t);
  const meetup = await makeMeetup(t, { status, initiator, recipient, venue });
  return { venue, meetup, initiator, recipient, stranger };
}

/** The same, with the clock standing on the meetup's start: inside the window at either end. */
async function lockedPair(): Promise<Base> {
  const base = await pairIn('locked');
  t.time.toMeetupPoint(base.meetup, 'startsAt');
  return base;
}

async function lockedPairPast(point: MeetupPoint, offsetMs: number): Promise<Base> {
  const base = await lockedPair();
  t.time.toMeetupPoint(base.meetup, point, offsetMs);
  return base;
}

function issued(secret: string | null): string {
  if (secret === null) {
    throw new Error('the fixture was built without a console secret');
  }
  return secret;
}

function offsetMeters(origin: LatLng, meters: number): LatLng {
  return { lat: origin.lat + meters / METERS_PER_DEGREE_LAT, lng: origin.lng };
}

/**
 * A coordinate `meters` due north of `venue`, projected on the spheroid by the database's own `ST_Project`, for a case that must stand on a
 * measured boundary rather than near one (AAP 0.5.7).
 *
 * {@link offsetMeters} cannot do this job at the geofence: `METERS_PER_DEGREE_LAT` is a fixed 111,320 metres per degree, while the route
 * measures with PostGIS's spheroid, so a table offset of 150 m measures at 149.58230029 m — 0.42 m short of the boundary, which a correct
 * implementation and one comparing `distance < 150` both accept. A point `ST_Project` places at {@link GEOFENCE_METERS} and `ST_Distance`
 * measures back at exactly the geofence is the only one such an implementation refuses.
 */
async function projected(venue: VenueFixture, meters: number): Promise<LatLng> {
  const rows = await t.services.db.$queryRaw<{ lat: number; lng: number }[]>`
    SELECT ST_Y(p::geometry) AS "lat", ST_X(p::geometry) AS "lng"
      FROM (
        SELECT ST_Project(
                 ST_SetSRID(
                   ST_MakePoint(${venue.lng}::double precision, ${venue.lat}::double precision),
                   4326
                 )::geography,
                 ${meters}::double precision,
                 0::double precision
               ) AS p
      ) AS projected
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`ST_Project returned no coordinate ${meters} m north of the venue`);
  }
  return { lat: row.lat, lng: row.lng };
}

/**
 * The metres the route itself measures between `venue` and `point`: the same `distanceFrom` statement `check-in.ts` compares with
 * {@link GEOFENCE_METERS} and derives its bucket from (AAP 0.5.7). A boundary case reads its probe back through this, so the case pins what
 * the product measures rather than what it asked the database to place.
 */
async function measuredMeters(venue: VenueFixture, point: LatLng): Promise<number> {
  const meters = await distanceFrom(t.services.db, 'venue', venue.id, point, t.env.APP_ENV);
  if (meters === null) {
    throw new Error('the venue carries no location to measure the probe from');
  }
  return meters;
}

async function displayedCode(secret: string): Promise<string> {
  const response = await callRoute(t.app, {
    method: 'GET',
    url: VENUE_CODE_PATH,
    headers: { [VENUE_SECRET_HEADER]: secret },
  });
  expect(response.status, `GET /v1/venue/check-in-code answered ${response.status}`).toBe(200);
  return VenueCodeResponse.parse(response.json()).code;
}

/**
 * A six-digit value no tolerated step produces, so the wrong-code cases are refusable by construction rather than by luck.
 */
function unmatchedCode(secret: string, now: Date): string {
  const accepted = new Set(TOLERATED_STEPS.map((step) => codeFor(secret, shifted(now, step)).code));
  for (let value = 0; value < 10 ** CODE_DIGITS; value += 1) {
    const candidate = String(value).padStart(CODE_DIGITS, '0');
    if (!accepted.has(candidate)) {
      return candidate;
    }
  }
  throw new Error('every six-digit code is tolerated, which no venue secret can produce');
}

function shifted(at: Date, steps: number): Date {
  return new Date(at.getTime() + steps * CODE_STEP_SECONDS * 1000);
}

interface AttemptOptions {
  readonly meetupId?: string;
  readonly code?: string;
  readonly distanceM?: number;
  /** The exact coordinates to submit, for a case that must stand on a measured boundary; the
   * {@link offsetMeters} of `distanceM` otherwise (AAP 0.5.7). */
  readonly point?: LatLng;
}

/**
 * Submit one check-in for `base`'s meetup as `user`, from `distanceM` metres away or from the exact coordinates a boundary case hands in
 * (AAP 0.5.7).
 */
async function attemptCheckIn(
  base: Base,
  user: ActorRef,
  options: AttemptOptions = {},
): Promise<RouteResponse> {
  const code = options.code ?? (await displayedCode(issued(base.venue.secret)));
  const at = options.point ?? offsetMeters(base.venue, options.distanceM ?? NEAR_METERS);
  const meetupId = options.meetupId ?? base.meetup.id;
  // The access token is signed at the clock's current instant, so a case that jumped an hour
  // forward does not present the expired one `makeUser` minted (AAP 0.3.3).
  return callRoute(t.app, {
    method: 'POST',
    url: CHECK_IN_PATH(meetupId),
    as: await t.tokenFor(user),
    body: { code, lat: at.lat, lng: at.lng } satisfies CheckInRequest,
  });
}

function expectAccepted(response: RouteResponse): CheckInResponse {
  expect(
    response.status,
    `POST /v1/meetups/:id/check-in answered ${response.status}: ${response.body}`,
  ).toBe(200);
  return CheckInResponse.parse(response.json());
}

async function tableColumns(table: string): Promise<string[]> {
  const held = await t.services.db.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return held.map((row) => row.column_name).sort();
}

async function checkInRow(meetupId: string, user: FixtureRef) {
  return t.services.db.checkIn.findFirst({
    where: { meetupId, userId: user.id },
    select: { result: true, distanceBucket: true, failureCode: true },
  });
}

async function bothCheckedInEvents(meetupId: string): Promise<number> {
  return t.services.db.analyticsEvent.count({ where: { name: 'both_checked_in', meetupId } });
}

async function bothCheckedInAt(meetupId: string): Promise<Date | null> {
  const meetup = await t.services.db.meetup.findUniqueOrThrow({
    where: { id: meetupId },
    select: { bothCheckedInAt: true },
  });
  return meetup.bothCheckedInAt;
}

interface RefusalRow {
  readonly label: string;
  readonly status: number;
  readonly code: ErrorCode;
  readonly pair?: () => Promise<Base>;
  readonly attempt: (base: Base) => Promise<RouteResponse>;
}

const REFUSALS: readonly RefusalRow[] = [
  {
    label: 'a caller who is in neither side of the meetup',
    status: 403,
    code: 'not_participant',
    attempt: async (base) => attemptCheckIn(base, base.stranger),
  },
  {
    label: 'a meetup that does not exist',
    status: 404,
    code: 'meetup_not_found',
    attempt: async (base) => attemptCheckIn(base, base.stranger, { meetupId: randomUUID() }),
  },
  {
    label: 'a proposal that was never locked',
    status: 409,
    code: 'not_locked',
    pair: () => pairIn('proposed'),
    attempt: async (base) => attemptCheckIn(base, base.initiator),
  },
  {
    label: 'a meetup that has already settled',
    status: 409,
    code: 'not_locked',
    pair: () => pairIn('completed'),
    attempt: async (base) => attemptCheckIn(base, base.initiator),
  },
  {
    label: 'a second check-in by the same attendee',
    status: 409,
    code: 'already_checked_in',
    attempt: async (base) => {
      expectAccepted(await attemptCheckIn(base, base.initiator));
      return attemptCheckIn(base, base.initiator);
    },
  },
  {
    label: 'a check-in 16 minutes before the start',
    status: 410,
    code: 'outside_window',
    pair: () => lockedPairPast('startsAt-15m', -MINUTE_MS),
    attempt: async (base) => attemptCheckIn(base, base.initiator),
  },
  {
    label: 'a check-in 46 minutes after the start',
    status: 410,
    code: 'outside_window',
    pair: () => lockedPairPast('startsAt+45m', MINUTE_MS),
    attempt: async (base) => attemptCheckIn(base, base.initiator),
  },
];

it.each(rows(REFUSALS))(
  'answers $status $code for $label',
  async ({ status, code, pair, attempt }) => {
    expectError(await attempt(await (pair ?? lockedPair)()), status, code);
  },
);

interface RejectionRow {
  readonly label: string;
  readonly code: ErrorCode;
  readonly attempt: (base: Base) => Promise<RouteResponse>;
}

const REJECTIONS: readonly RejectionRow[] = [
  {
    label: 'a code two steps old',
    code: 'invalid_code',
    attempt: async (base) =>
      attemptCheckIn(base, base.initiator, {
        code: codeFor(issued(base.venue.secret), shifted(t.time.now(), -2)).code,
      }),
  },
  {
    label: 'a six-digit code no step produces',
    code: 'invalid_code',
    attempt: async (base) =>
      attemptCheckIn(base, base.initiator, {
        code: unmatchedCode(issued(base.venue.secret), t.time.now()),
      }),
  },
  {
    label: "another venue's current code",
    code: 'invalid_code',
    attempt: async (base) => {
      const other = await makeVenue(t, { cityId: CITY_ID });
      return attemptCheckIn(base, base.initiator, {
        code: await displayedCode(issued(other.secret)),
      });
    },
  },
  {
    label: 'a valid code submitted from 200 metres away',
    code: 'outside_geofence',
    attempt: async (base) => attemptCheckIn(base, base.initiator, { distanceM: OUTSIDE_METERS }),
  },
  {
    label: 'a valid code submitted one metre beyond the geofence',
    code: 'outside_geofence',
    attempt: async (base) =>
      attemptCheckIn(base, base.initiator, {
        point: await projected(base.venue, GEOFENCE_METERS + 1),
      }),
  },
];

it.each(rows(REJECTIONS))('answers 422 $code for $label', async ({ code, attempt }) => {
  expectError(await attempt(await lockedPair()), 422, code);
});

it('answers invalid_code when the code and the distance are both wrong', async () => {
  const base = await lockedPair();
  const response = await attemptCheckIn(base, base.initiator, {
    code: unmatchedCode(issued(base.venue.secret), t.time.now()),
    distanceM: OUTSIDE_METERS,
  });
  // The code is judged before the geofence (AAP 0.5.4), so the first broken rule is the answer.
  expectError(response, 422, 'invalid_code');
});

describe('an accepted check-in', () => {
  it('is accepted at both ends of the window', async () => {
    const base = await lockedPair();
    // Fifteen minutes before the start to 45 minutes after it, both ends inclusive (AAP 0.5.7); the
    // minute beyond either end is refused, one group above.
    t.time.toMeetupPoint(base.meetup, 'startsAt-15m');
    expect(expectAccepted(await attemptCheckIn(base, base.initiator))).toEqual({
      status: 'locked',
      bothCheckedIn: false,
    });
    t.time.toMeetupPoint(base.meetup, 'startsAt+45m');
    expect(expectAccepted(await attemptCheckIn(base, base.recipient))).toEqual({
      status: 'locked',
      bothCheckedIn: true,
    });
  });

  it('accepts the code one step either side of the current one, either attendee first', async () => {
    const base = await lockedPair();
    const secret = issued(base.venue.secret);
    const now = t.time.now();
    // The tolerance absorbs the round trip between the console and the attendee (AAP 0.5.7).
    const stale = expectAccepted(
      await attemptCheckIn(base, base.initiator, {
        code: codeFor(secret, shifted(now, -1)).code,
      }),
    );
    expect(stale.bothCheckedIn).toBe(false);
    const early = expectAccepted(
      await attemptCheckIn(base, base.recipient, {
        code: codeFor(secret, shifted(now, 1)).code,
      }),
    );
    expect(early).toEqual({ status: 'locked', bothCheckedIn: true });
  });

  it('stores the bucket the distance falls in, and nothing else about where it was made', async () => {
    const base = await lockedPair();
    expect(
      expectAccepted(await attemptCheckIn(base, base.initiator, { distanceM: NEAR_METERS })),
    ).toEqual({ status: 'locked', bothCheckedIn: false });
    expect(
      expectAccepted(await attemptCheckIn(base, base.recipient, { distanceM: MID_METERS })),
    ).toEqual({ status: 'locked', bothCheckedIn: true });
    expect(await checkInRow(base.meetup.id, base.initiator)).toEqual({
      result: 'pass',
      distanceBucket: 'lt_50',
      failureCode: null,
    });
    expect(await checkInRow(base.meetup.id, base.recipient)).toEqual({
      result: 'pass',
      distanceBucket: 'm50_150',
      failureCode: null,
    });
  });

  it('is accepted just inside the geofence', async () => {
    const base = await lockedPair();
    const response = await attemptCheckIn(base, base.recipient, { distanceM: FRINGE_METERS });
    expect(expectAccepted(response)).toEqual({ status: 'locked', bothCheckedIn: false });
    expect(await checkInRow(base.meetup.id, base.recipient)).toEqual({
      result: 'pass',
      distanceBucket: 'm50_150',
      failureCode: null,
    });
  });

  it('is accepted at the geofence itself, which an exclusive comparison would refuse', async () => {
    const base = await lockedPair();
    // AAP 0.5.7 accepts `ST_Distance(venue.location, point) <= 150` m, so the edge belongs to the accepted side, and the only probe an
    // implementation comparing `< 150` refuses is one the database measures at exactly the geofence. The pin below reads the metres back
    // through the statement the route itself compares with, so a probe that drifted off the edge fails here.
    const onEdge = await projected(base.venue, GEOFENCE_METERS);
    expect(await measuredMeters(base.venue, onEdge)).toBe(GEOFENCE_METERS);
    expect(expectAccepted(await attemptCheckIn(base, base.initiator, { point: onEdge }))).toEqual({
      status: 'locked',
      bothCheckedIn: false,
    });
    expect(await checkInRow(base.meetup.id, base.initiator)).toEqual({
      result: 'pass',
      distanceBucket: 'm50_150',
      failureCode: null,
    });
  });

  it('leaves no coordinate column on the check-in table', async () => {
    // Criterion 6's storage rule: the columns are the migration's own set, so a later column that
    // held a submitted coordinate would appear here (AAP 0.5.2, 0.12.2).
    expect(await tableColumns('check_in')).toEqual([
      'created_at',
      'distance_bucket',
      'failure_code',
      'id',
      'meetup_id',
      'result',
      'user_id',
    ]);
  });
});

describe('the rows a check-in leaves', () => {
  /** The two refusals that still record an attempt, having passed the status and window checks. */
  interface RecordedFailure {
    readonly label: string;
    readonly failureCode: ErrorCode;
    readonly attempt: (base: Base) => Promise<RouteResponse>;
  }
  const RECORDED_FAILURES: readonly RecordedFailure[] = [
    {
      label: 'an invalid code',
      failureCode: 'invalid_code',
      attempt: async (base) =>
        attemptCheckIn(base, base.initiator, {
          code: unmatchedCode(issued(base.venue.secret), t.time.now()),
        }),
    },
    {
      label: 'a check-in outside the geofence',
      failureCode: 'outside_geofence',
      attempt: async (base) => attemptCheckIn(base, base.initiator, { distanceM: OUTSIDE_METERS }),
    },
  ];
  it.each(rows(RECORDED_FAILURES))(
    'commits a fail row for $label, with its code and no bucket',
    async ({ failureCode, attempt }) => {
      const base = await lockedPair();
      expectError(await attempt(base), 422, failureCode);
      expect(await checkInRow(base.meetup.id, base.initiator)).toEqual({
        result: 'fail',
        distanceBucket: null,
        failureCode,
      });
    },
  );
  it.each(rows<ParticipantRole>(['initiator', 'recipient']))(
    // `%s` rather than `$first`: this table's rows are bare values, not objects, so the title
    // interpolates the argument.
    'completes the pair on the second pass, whichever one goes first: %s',
    async (first) => {
      const base = await lockedPair();
      const second: ParticipantRole = first === 'initiator' ? 'recipient' : 'initiator';
      expect(expectAccepted(await attemptCheckIn(base, base[first])).bothCheckedIn).toBe(false);
      // One pass alone is not the pair's completion, and the funnel stage follows the second only.
      expect(await bothCheckedInAt(base.meetup.id)).toBeNull();
      expect(await bothCheckedInEvents(base.meetup.id)).toBe(0);
      const now = t.time.now();
      const both = expectAccepted(await attemptCheckIn(base, base[second]));
      expect(both).toEqual({ status: 'locked', bothCheckedIn: true });
      expect((await bothCheckedInAt(base.meetup.id))?.getTime()).toBe(now.getTime());
      expect(await bothCheckedInEvents(base.meetup.id)).toBe(1);
      expect(
        await t.services.db.checkIn.count({
          where: { meetupId: base.meetup.id, result: 'pass' },
        }),
      ).toBe(2);
    },
  );
  it('leaves the submitted coordinates out of every logged field', async () => {
    // `createTestApp` exposes no logger injection point, and pino's default destination writes to fd 1 rather than through
    // `process.stdout`, so the live line is not captured here: the redaction list both processes share is the evidence instead.

    const base = await lockedPair();
    expect(expectAccepted(await attemptCheckIn(base, base.initiator))).toEqual({
      status: 'locked',
      bothCheckedIn: false,
    });
    // The stored row is the result and the bucket, which is all the coordinates may influence.
    expect(await checkInRow(base.meetup.id, base.initiator)).toEqual({
      result: 'pass',
      distanceBucket: 'lt_50',
      failureCode: null,
    });
    // pino censors a field named `lat`, `lng`, `latitude`, `longitude` or `coords` at the bare name
    // and under four wrappers, so a coordinate inside a DTO or a request body is censored too
    // (AAP 0.3.2, 0.11.1).
    for (const name of ['lat', 'lng', 'latitude', 'longitude', 'coords']) {
      const covered = LOGGER_REDACT_PATHS.filter(
        (path) => path === name || path.endsWith(`.${name}`),
      );
      expect(covered).toHaveLength(5);
    }
  });
});
