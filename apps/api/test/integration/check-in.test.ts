/**
 * The witnessed check-in of AAP 0.5.4 and criterion 6 (AAP 0.8.1): the venue's rotating code, the
 * 150 m geofence, the window from `startsAt − 15 min` to `startsAt + 45 min`, and what an attempt
 * leaves behind.
 *
 * Three contracts are pinned, each of them a rule the product depends on:
 *
 *  - **The refusals arrive in the contract's order** (AAP 0.5.4): `403 not_participant`,
 *    `409 not_locked`, `409 already_checked_in`, `410 outside_window`, `422 invalid_code`,
 *    `422 outside_geofence`. A request breaking two rules is answered with the first, so the
 *    precedence case submits a wrong code from 200 metres away and reads `invalid_code`.
 *  - **The code is the server's** (AAP 0.5.7): the accepted counters are `T` and one step either
 *    side of it, and a code two steps old is refused — criterion 6's row. No instant here is
 *    device-supplied: every reading comes from the injected `TestClock`, moved onto a meetup's own
 *    boundaries, and the code itself from the venue's own secret.
 *  - **The stored row holds no coordinates** (AAP 0.5.2, 0.12.2): `check_in` carries no coordinate
 *    column, a pass keeps its result and its distance bucket alone, and a refusal that passed the
 *    status and window checks commits a `fail` row with its failure code and a null bucket.
 *
 * The second pass has its own group: it sets `Meetup.bothCheckedInAt` and emits exactly one
 * `both_checked_in` funnel stage, whichever order the two attendees arrive in, and it does not wait
 * for settlement (AAP 0.5.7).
 *
 * Every secret is minted by a fixture at run time and every instant comes from the injected clock,
 * so nothing credential-shaped is written here (AAP 0.11.1).
 *
 * @see AAP 0.5.7 for the acceptance rule and the rotating code, 0.5.4 for the route and its error
 *   order, 0.5.2 for the `CheckIn` columns, 0.11.2 for the harness this file drives, 0.12.1 for
 *   criterion 6, and 0.8.1 for its place in the inventory.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

/** `POST /v1/meetups/:id/check-in`, under the `/v1` prefix the composition root mounts (AAP 0.5.1). */
const CHECK_IN_PATH = (meetupId: string): string => `/v1/meetups/${meetupId}/check-in`;

/** `GET /v1/venue/check-in-code`: the code the console of a venue displays at the clock's instant. */
const VENUE_CODE_PATH = '/v1/venue/check-in-code';

/** One of the five seeded launch cities; a venue belongs to a city, not to the suite. */
const CITY_ID = 'lisbon';

/** A venue location no rule or fixture produces by accident (AAP 0.12.2): a value that leaked into
 * a stored row or a log field would be recognisable rather than plausible. */
const VENUE_LOCATION: LatLng = { lat: 38.7123456, lng: -9.139337 };

/** Metres in one degree of latitude, for offsets of at most a few hundred metres: the geodesic
 * distance of a northward offset lands within a metre of the metres asked for. */
const METERS_PER_DEGREE_LAT = 111_320;

/** Distances either side of the two boundaries of AAP 0.5.7, each with a margin it cannot drift over. */
const NEAR_METERS = DISTANCE_BUCKET_SPLIT_METERS - 20; // 30 m: inside the geofence, bucket `lt_50`
const MID_METERS = DISTANCE_BUCKET_SPLIT_METERS + 70; // 120 m: bucket `m50_150`
const FRINGE_METERS = GEOFENCE_METERS - 10; // 140 m: still inside the geofence
const OUTSIDE_METERS = GEOFENCE_METERS + 50; // 200 m: criterion 6's refusal

/** The counters a venue's code is accepted for: `T` and {@link CODE_TOLERANCE_STEPS} either side. */
const TOLERATED_STEPS: readonly number[] = Array.from(
  { length: 2 * CODE_TOLERANCE_STEPS + 1 },
  (_unused, index) => index - CODE_TOLERANCE_STEPS,
);

/** The app these cases drive, built once for the file (AAP 0.11.2). */
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

/* Fixtures (AAP 0.5.2, 0.5.3) */

/** One meetup, its venue, its two attendees and an account that is in neither side of it. */
interface Base {
  readonly venue: VenueFixture;
  readonly meetup: MeetupFixture;
  readonly initiator: UserFixture;
  readonly recipient: UserFixture;
  readonly stranger: UserFixture;
}

/**
 * A meetup in `status` for a fresh pair at a fresh secret-bearing venue (AAP 0.5.3). `makeMeetup`
 * writes the rows the state machine would have left, so a `held` deposit is a real authorization at
 * the provider this run points at — the stateful proxy in `STRIPE_MODE=mock` — and the default start
 * is two hours out for a meetup that is still open and three hours back for a final one.
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

/** The same, with the clock on the far side of one end of the check-in window (AAP 0.5.7). */
async function lockedPairPast(point: MeetupPoint, offsetMs: number): Promise<Base> {
  const base = await lockedPair();
  t.time.toMeetupPoint(base.meetup, point, offsetMs);
  return base;
}

/** The secret a fixture minted, as the value `withSecret: true` promises. */
function issued(secret: string | null): string {
  if (secret === null) {
    throw new Error('the fixture was built without a console secret');
  }
  return secret;
}

/* Requests (AAP 0.5.4, 0.5.7) */

/** The device coordinates a case submits: due north of the venue by `meters` (AAP 0.5.7). */
function offsetMeters(origin: LatLng, meters: number): LatLng {
  return { lat: origin.lat + meters / METERS_PER_DEGREE_LAT, lng: origin.lng };
}

/** The code the venue's console displays at the clock's current instant (AAP 0.5.4). */
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
 * A six-digit value no tolerated step produces, so the wrong-code cases are refusable by
 * construction rather than by luck: at most four candidates can be taken.
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

/** `at` moved by `steps` of {@link CODE_STEP_SECONDS}, which is what a code's counter counts. */
function shifted(at: Date, steps: number): Date {
  return new Date(at.getTime() + steps * CODE_STEP_SECONDS * 1000);
}

/** What a case may replace in one submitted check-in. */
interface AttemptOptions {
  /** The meetup to check in to; the base's own unless a case asks for another (the unknown id). */
  readonly meetupId?: string;
  /** The code to submit; the venue's current one otherwise. */
  readonly code?: string;
  /** How far from the venue the device stands, due north. Default {@link NEAR_METERS}. */
  readonly distanceM?: number;
}

/** Submit one check-in for `base`'s meetup as `user`, from `distanceM` metres away (AAP 0.5.7). */
async function attemptCheckIn(
  base: Base,
  user: ActorRef,
  options: AttemptOptions = {},
): Promise<RouteResponse> {
  const code = options.code ?? (await displayedCode(issued(base.venue.secret)));
  const at = offsetMeters(base.venue, options.distanceM ?? NEAR_METERS);
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

/** Assert a `200` and parse the shared `CheckInResponse`, which every accepted case reads. */
function expectAccepted(response: RouteResponse): CheckInResponse {
  expect(
    response.status,
    `POST /v1/meetups/:id/check-in answered ${response.status}: ${response.body}`,
  ).toBe(200);
  return CheckInResponse.parse(response.json());
}

/* Stored state (AAP 0.5.2, 0.12.2) */

/** The columns `table` holds, from the catalog: what the migration actually created. */
async function tableColumns(table: string): Promise<string[]> {
  const held = await t.services.db.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `;

  return held.map((row) => row.column_name).sort();
}

/** The one check-in row `user` left on `meetupId`, as the three fields a case asserts on. */
async function checkInRow(meetupId: string, user: FixtureRef) {
  return t.services.db.checkIn.findFirst({
    where: { meetupId, userId: user.id },
    select: { result: true, distanceBucket: true, failureCode: true },
  });
}

/** How many `both_checked_in` stages the meetup emitted: one, and only on the second pass. */
async function bothCheckedInEvents(meetupId: string): Promise<number> {
  return t.services.db.analyticsEvent.count({ where: { name: 'both_checked_in', meetupId } });
}

/** `Meetup.bothCheckedInAt`, the instant the pair's second pass set, or null. */
async function bothCheckedInAt(meetupId: string): Promise<Date | null> {
  const meetup = await t.services.db.meetup.findUniqueOrThrow({
    where: { id: meetupId },
    select: { bothCheckedInAt: true },
  });

  return meetup.bothCheckedInAt;
}

/* Refusals (AAP 0.5.4, criterion 6) */

/** One refusal, the request that earns it, and the answer the contract fixes (AAP 0.5.4). */
interface RefusalRow {
  readonly label: string;
  readonly status: number;
  readonly code: ErrorCode;
  /** The meetup to attempt against; a locked pair at its start unless a row asks for another. */
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

/** One rejected attempt that still commits a `fail` row (AAP 0.5.2, 0.5.4). */
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

/* Accepted check-ins (AAP 0.5.7, criterion 6) */

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

/* What an attempt leaves behind (AAP 0.5.2, 0.5.7, 0.12.2) */

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
    // `createTestApp` exposes no logger injection point (its options are the environment, the clock,
    // the language model, the gateway and whether to start background work), and pino's default
    // destination writes to fd 1 rather than through `process.stdout`, so the live line is not
    // captured here: the redaction list both processes share is the evidence instead.
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
