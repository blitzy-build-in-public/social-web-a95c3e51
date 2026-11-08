/**
 * Rate limits, and the Redis outage behind them (AAP 0.5.4, AAP 0.3.2, AAP 0.11.2, 0.8.1).
 *
 *  - **A mutating route is a budget for a caller and for an address.** AAP 0.5.4 allows one account 60
 *    writes a minute (`RATE_LIMIT_USER_PER_MIN`) and one address `RATE_LIMIT_IP_PER_MIN` (600 by
 *    default), the webhook routes 6,000 a minute, and a refusal is `429 rate_limited` with
 *    `Retry-After`. The two reads that write — `GET /meetups/:id`, whose recipient's first read records
 *    `recipientViewedAt`, and `GET /meetups/:id/suggestions` — carry that per-user counter, while the
 *    plain reads carry none at all.
 *  - **A refusal is a refusal: the request does not run.** Each outage case asserts the state its route
 *    would have written, not only the status, because a counter that refused the request and a handler
 *    that wrote it anyway look the same to a status-only assertion.
 *  - **An unusable counter fails closed, and settlement does not need it.** AAP 0.3.2 keeps
 *    `@fastify/rate-limit`'s `skipOnError: false`: a Redis that answers nothing turns every limited
 *    route into `503 service_unavailable` rather than letting it through uncounted, and the sweeper
 *    behind it still takes its settlement decision, because that decision reads PostgreSQL and Stripe
 *    alone. What a settlement commits to the outbox then waits for Redis, and is delivered once it
 *    answers.
 *
 * `pauseRedis` produces the outage in its honest form: the socket stays open and nothing answers, so
 * the fail-fast `client` connection cannot detect it by itself and the store's own bound answers
 * instead. Every pause is released in a `finally` — the container is shared by the whole run, so the
 * suites after this file need it resumed. Domain time comes from the injected clock (AAP 0.11.1); the
 * waits that are not on it are infrastructure ones — Redis readiness after an unpause, and the poll
 * for a decision a stalled pass has already committed.
 *
 * @see AAP 0.5.4 for the allowances, the counted routes and the envelope, 0.3.2 for the fail-closed
 *   store, the sweeper's independence from Redis and the outbox's durability, 0.11.2 for the harness,
 *   0.12.2 for the check that `skipOnError: false` is what answers the outage, and 0.8.1 for this file.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { HOUR_MS, RATE_LIMIT_USER_PER_MIN, RATE_LIMIT_WEBHOOK_IP_PER_MIN } from '@tablemate/shared';

import { runSweeper } from '../../src/modules/settlement/sweeper.ts';

import { createTestApp, pauseRedis, unpauseRedis } from '../support/app.ts';
import {
  callRoute,
  expectError,
  makeMeetup,
  makeUser,
  makeVenue,
  rows,
} from '../support/factories.ts';

import type { TestApp } from '../support/app.ts';
import type { RouteResponse } from '../support/factories.ts';

/* The app under test (AAP 0.11.2) */

/** The app every case drives: one build for the file, reset to a fresh database before each case. */
let t: TestApp;

/** A launch city, for the venue and the meetups a case hangs off (AAP 0.5.2). */
const LISBON = 'lisbon';

/** The queue a meetup's notification rows are delivered to (AAP 0.5.6). */
const NOTIFICATION_QUEUE = 'notifications';

/** One attempt id, in the shape Twilio's status callback carries in its query (AAP 0.3.3). */
const ATTEMPT_ID = '01890a5d-ac96-774b-bcce-b302099a8057';

/** How many plain reads one case issues, to show that no counter is taken for any of them. */
const PLAIN_READS_PER_CASE = 100;

/** How long one refused request may take: the store's one-second bound plus the session cache's 250 ms. */
const OUTAGE_CASE_TIMEOUT_MS = 30_000;

/**
 * How long the pass a paused Redis holds up may take to finish once Redis answers, which is longer
 * than a refused request: it is bounded by BullMQ's own reconnect delays rather than by the rate
 * limiter's one-second bound.
 */
const PASS_TIMEOUT_MS = 60_000;

/** How the settlement a paused pass commits is looked for in PostgreSQL, and for how long. */
const DECISION_ATTEMPTS = 150;
const DECISION_POLL_MS = 100;

/** How the recovery case waits for the producer connection, and how long it waits in total. */
const PRODUCER_READY_ATTEMPTS = 40;
const PRODUCER_READY_INTERVAL_MS = 250;

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

/* Helpers (AAP 0.5.4, AAP 0.11.2) */

/** A counter for the device tokens the allowance cases register: `push_token.token` is unique. */
let deviceTokens = 0;

/** One push-token body, distinct per call, so a re-registration is a fresh write. */
function pushTokenBody(): { token: string; platform: 'ios' } {
  deviceTokens += 1;
  return { token: `test-device-token-${String(deviceTokens)}`, platform: 'ios' };
}

/** One push-token registration, which is the write every counter here is measured on. */
function registerPushToken(
  harness: TestApp,
  user: { readonly accessToken: string },
  body: { readonly token: string; readonly platform: 'ios' } = pushTokenBody(),
): Promise<RouteResponse> {
  return callRoute(harness.app, {
    method: 'POST',
    url: '/v1/me/push-tokens',
    as: user.accessToken,
    body,
  });
}

/**
 * One injected request from a caller-chosen address.
 *
 * `callRoute` forwards the method, the path, the bearer token and the body, and not the client
 * address, which is exactly what a per-IP case has to vary: Fastify reads `request.ip` from the
 * address `inject` was given, so this sends the same request its own way.
 */
async function fromAddress(
  harness: TestApp,
  remoteAddress: string,
  request: {
    readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    readonly url: string;
    readonly as?: string;
    readonly body?: object;
  },
): Promise<RouteResponse> {
  const injected = await harness.app.inject({
    method: request.method,
    url: request.url,
    remoteAddress,
    ...(request.as === undefined ? {} : { headers: { authorization: `Bearer ${request.as}` } }),
    ...(request.body === undefined ? {} : { payload: request.body }),
  });

  return {
    status: injected.statusCode,
    body: injected.body,
    headers: injected.headers,
    json: <T>() => JSON.parse(injected.body) as T,
  };
}

/** The last answer of a list, which is the one that met the limit. */
function lastAnswer(answers: readonly RouteResponse[]): RouteResponse {
  const answer = answers.at(-1);
  if (answer === undefined) throw new Error('no request was made');
  return answer;
}

/**
 * Spend one caller's whole allowance on `send`, and answer the refusal.
 *
 * Every allowed request must answer `allowedStatus` and carry the allowance it was counted against —
 * which is what tells a counted route from an uncounted one — and the request after them must be the
 * `429 rate_limited` refusal with the window on it.
 */
async function exhaust(
  send: () => Promise<RouteResponse>,
  allowedStatus: number,
): Promise<RouteResponse> {
  for (let request = 0; request < RATE_LIMIT_USER_PER_MIN; request += 1) {
    const answer = await send();
    expect(answer.status).toBe(allowedStatus);
    expect(Number(answer.headers['x-ratelimit-limit'])).toBe(RATE_LIMIT_USER_PER_MIN);
  }

  const refused = await send();
  expectError(refused, 429, 'rate_limited');
  expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  return refused;
}

/**
 * A locked meetup that has fallen due: it started an hour ago on the injected clock, so
 * `startsAt + 45 min` is a quarter of an hour past, both attendees checked in, and nothing has
 * settled it.
 */
async function overdueMeetup(): Promise<{
  readonly meetupId: string;
  readonly initiator: { readonly accessToken: string };
}> {
  const initiator = await makeUser(t);
  const recipient = await makeUser(t);
  const venue = await makeVenue(t, { cityId: LISBON });
  const meetup = await makeMeetup(t, {
    status: 'locked',
    initiator,
    recipient,
    venue,
    startsAt: new Date(t.time.now().getTime() - HOUR_MS),
    checkIns: { initiator: 'pass', recipient: 'pass' },
  });

  return { meetupId: meetup.id, initiator };
}

/**
 * The settlement a paused pass commits, once it is visible in PostgreSQL — `null` when none appears
 * within the poll's budget.
 */
async function settlementWithin(
  harness: TestApp,
  meetupId: string,
): Promise<{ readonly outcome: string; readonly status: string } | null> {
  for (let attempt = 0; attempt < DECISION_ATTEMPTS; attempt += 1) {
    const row = await harness.services.db.meetupSettlement.findUnique({
      where: { meetupId },
      select: { outcome: true, status: true },
    });
    if (row !== null) return row;

    await new Promise((resolve) => {
      setTimeout(resolve, DECISION_POLL_MS);
    });
  }

  return null;
}

/** Every deposit status of `meetupId`, sorted, so a case can compare the whole set at once. */
async function depositStatuses(harness: TestApp, meetupId: string): Promise<string[]> {
  const deposits = await harness.services.db.deposit.findMany({
    where: { meetupId },
    select: { status: true },
  });
  return deposits.map((deposit) => deposit.status).sort();
}

/** A Redis connection as this file reads it: its status, and a `PING` that answers when it is up. */
interface Connection {
  readonly status: string;
  readonly ping: () => Promise<string>;
}

/**
 * Wait until `connection` is ready and answers a `PING`.
 *
 * Every connection the app builds is fail-fast (`enableOfflineQueue: false`), so a command issued
 * before the socket reached `ready` is refused rather than queued: a fresh app's first counted request
 * would read that as a store failure, and an outbox pass would deliver nothing. This waits on
 * infrastructure, not on a domain instant — it reads no `Date.now()` and moves no clock.
 */
async function awaitAnswering(connection: Connection): Promise<void> {
  for (let attempt = 0; attempt < PRODUCER_READY_ATTEMPTS; attempt += 1) {
    if (connection.status === 'ready') {
      try {
        await connection.ping();
        return;
      } catch {
        // The socket dropped between the status check and the ping: the next attempt re-checks it.
      }
    }

    await new Promise((resolve) => {
      setTimeout(resolve, PRODUCER_READY_INTERVAL_MS);
    });
  }

  throw new Error('a Redis connection did not answer after the outage');
}

/* The allowances (AAP 0.5.4) */

describe('the per-user and per-IP allowances', () => {
  it('allows 60 writes for one account and refuses the 61st', async () => {
    const user = await makeUser(t);

    await exhaust(() => registerPushToken(t, user), 204);

    // The refusal ran before the handler: the refused registration was never stored.
    expect(await t.services.db.pushToken.count()).toBe(RATE_LIMIT_USER_PER_MIN);

    // The counter is the account's, not the route's or the address's: a second account still writes.
    const other = await makeUser(t);
    expect((await registerPushToken(t, other)).status).toBe(204);
  });

  it('counts one address across accounts and leaves another address alone', async () => {
    const limited = await createTestApp({ env: { RATE_LIMIT_IP_PER_MIN: '5' } });
    try {
      // The counters live in Redis, and this app is fresh: its first counted request would otherwise
      // race the connection and answer `503` instead of the `204` the allowance allows.
      await awaitAnswering(limited.services.redis.client);

      const owner = await makeUser(limited);
      const guest = await makeUser(limited);
      const stranger = await makeUser(limited);
      const crowded = '203.0.113.7';

      const answers: RouteResponse[] = [];
      for (const user of [owner, guest, stranger]) {
        for (let write = 0; write < 2; write += 1) {
          answers.push(
            await fromAddress(limited, crowded, {
              method: 'POST',
              url: '/v1/me/push-tokens',
              as: await limited.tokenFor(user),
              body: pushTokenBody(),
            }),
          );
        }
      }

      // Three accounts, two writes each, one address: the sixth request is the one that address cannot
      // pay for, whichever of its accounts makes it.
      expect(answers.slice(0, 5).map((answer) => answer.status)).toEqual([204, 204, 204, 204, 204]);
      const refused = lastAnswer(answers);
      expectError(refused, 429, 'rate_limited');
      expect(Number(refused.headers['x-ratelimit-limit'])).toBe(5);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

      // Another address is untouched by it, and so is an account of the crowded address.
      const elsewhere = await fromAddress(limited, '203.0.113.9', {
        method: 'POST',
        url: '/v1/me/push-tokens',
        as: await limited.tokenFor(stranger),
        body: pushTokenBody(),
      });
      expect(elsewhere.status).toBe(204);
    } finally {
      await limited.close();
    }
  });

  it('gives the webhook routes the higher per-IP allowance', async () => {
    // A provider's request is not a caller's: no bearer token, so the counter is per address at the
    // higher allowance, and the signature is what refuses it (AAP 0.3.3).
    const stripe = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/webhooks/stripe',
      body: { id: 'evt_fixture', type: 'charge.refunded' },
    });
    expectError(stripe, 400, 'bad_signature');
    expect(Number(stripe.headers['x-ratelimit-limit'])).toBe(RATE_LIMIT_WEBHOOK_IP_PER_MIN);

    const voice = await callRoute(t.app, {
      method: 'POST',
      url: `/v1/webhooks/voice?attemptId=${ATTEMPT_ID}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'CallSid=CAfixture&CallStatus=completed&SequenceNumber=1',
    });
    expectError(voice, 400, 'bad_signature');
    expect(Number(voice.headers['x-ratelimit-limit'])).toBe(RATE_LIMIT_WEBHOOK_IP_PER_MIN);
  });
});

/* The reads that carry a counter and the reads that do not (AAP 0.5.4) */

/**
 * The two reads that write, both limited per caller: the proposal detail records its recipient's first
 * view and the suggestion route stores a supplied budget. Each is marked `config.stateWritingRead`,
 * which is how the limiter knows the method alone cannot tell them from the plain reads below.
 */
const STATE_WRITING_READS: readonly (readonly [string, (meetupId: string) => string])[] = [
  ['GET /v1/meetups/:id', (meetupId) => `/v1/meetups/${meetupId}`],
  ['GET /v1/meetups/:id/suggestions', (meetupId) => `/v1/meetups/${meetupId}/suggestions`],
];

/** The plain reads a client calls constantly, which carry no counter at all. */
const PLAIN_READS: readonly (readonly [string, string])[] = [
  ['GET /v1/me', '/v1/me'],
  ['GET /v1/cities', '/v1/cities'],
  ['GET /v1/meetups', '/v1/meetups'],
];

describe('which reads carry a counter', () => {
  it.each(rows(STATE_WRITING_READS))('counts %s against its caller', async (_label, path) => {
    const initiator = await makeUser(t);
    const recipient = await makeUser(t);
    const venue = await makeVenue(t, { cityId: LISBON });
    const meetup = await makeMeetup(t, { status: 'locked', initiator, recipient, venue });

    await exhaust(
      () => callRoute(t.app, { method: 'GET', url: path(meetup.id), as: recipient.accessToken }),
      200,
    );
  });

  it.each(rows(PLAIN_READS))('leaves %s uncounted', async (_label, url) => {
    const user = await makeUser(t);

    for (let read = 0; read < PLAIN_READS_PER_CASE; read += 1) {
      const answer = await callRoute(t.app, { method: 'GET', url, as: user.accessToken });
      expect(answer.status).toBe(200);
      // No header at all is the difference between "under the limit" and "never counted".
      expect(answer.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });
});

/* A Redis that answers nothing (AAP 0.3.2) */

/**
 * One mutating route, and the state it must leave untouched while the counter cannot read Redis.
 *
 * The two halves travel together on purpose: `503 service_unavailable` proves the request was refused
 * and `unchanged` proves it did not run, which a status-only assertion cannot tell apart.
 */
interface OutageCase {
  readonly label: string;
  readonly prepare: (harness: TestApp) => Promise<{
    readonly send: () => Promise<RouteResponse>;
    readonly unchanged: () => Promise<void>;
  }>;
}

/** The nickname of the caller's own profile, for the case that edits one. */
async function nicknameOf(harness: TestApp, userId: string): Promise<string | null> {
  const profile = await harness.services.db.disclosureProfile.findUnique({
    where: { userId },
    select: { nickname: true },
  });
  return profile?.nickname ?? null;
}

/** When the recipient first read `meetupId`'s proposal, if they have. */
async function viewedAt(harness: TestApp, meetupId: string): Promise<Date | null> {
  const row = await harness.services.db.meetup.findUniqueOrThrow({
    where: { id: meetupId },
    select: { recipientViewedAt: true },
  });
  return row.recipientViewedAt;
}

/** One `PUT /me/profile`, which the profile case makes before and during the outage. */
function putNickname(
  harness: TestApp,
  user: { readonly accessToken: string },
  nickname: string,
): Promise<RouteResponse> {
  return callRoute(harness.app, {
    method: 'PUT',
    url: '/v1/me/profile',
    as: user.accessToken,
    body: { nickname },
  });
}

/** The mutating routes of AAP 0.5.4 this file drives through the outage, one row each. */
const OUTAGE_CASES: readonly OutageCase[] = [
  {
    label: 'POST /v1/me/push-tokens',
    prepare: async (harness) => {
      const user = await makeUser(harness);
      const body = pushTokenBody();
      return {
        send: () => registerPushToken(harness, user, body),
        unchanged: async () => {
          const count = await harness.services.db.pushToken.count({ where: { token: body.token } });
          expect(count).toBe(0);
        },
      };
    },
  },
  {
    label: 'PUT /v1/me/profile',
    prepare: async (harness) => {
      const user = await makeUser(harness);
      expect((await putNickname(harness, user, 'Fixture Before')).status).toBe(200);
      return {
        send: () => putNickname(harness, user, 'Fixture After'),
        unchanged: async () => {
          expect(await nicknameOf(harness, user.id)).toBe('Fixture Before');
        },
      };
    },
  },
  {
    label: 'POST /v1/users/:id/report',
    prepare: async (harness) => {
      const reporter = await makeUser(harness);
      const reported = await makeUser(harness);
      return {
        send: () =>
          callRoute(harness.app, {
            method: 'POST',
            url: `/v1/users/${reported.id}/report`,
            as: reporter.accessToken,
            body: { reason: 'Fixture outage report' },
          }),
        unchanged: async () => {
          expect(await harness.services.db.report.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'POST /v1/meetups',
    prepare: async (harness) => {
      const initiator = await makeUser(harness);
      const recipient = await makeUser(harness);
      const venue = await makeVenue(harness, { cityId: LISBON });
      const startsAt = new Date(harness.time.now().getTime() + HOUR_MS).toISOString();
      return {
        send: () =>
          callRoute(harness.app, {
            method: 'POST',
            url: '/v1/meetups',
            as: initiator.accessToken,
            body: { recipientId: recipient.id, venueId: venue.id, startsAt, depositCents: 1000 },
          }),
        unchanged: async () => {
          // No meetup row, so nothing was proposed and no hold was placed.
          expect(await harness.services.db.meetup.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'GET /v1/meetups/:id as its recipient',
    prepare: async (harness) => {
      const initiator = await makeUser(harness);
      const recipient = await makeUser(harness);
      const venue = await makeVenue(harness, { cityId: LISBON });
      const meetup = await makeMeetup(harness, { status: 'proposed', initiator, recipient, venue });
      const url = `/v1/meetups/${meetup.id}`;
      return {
        send: () => callRoute(harness.app, { method: 'GET', url, as: recipient.accessToken }),
        unchanged: async () => {
          expect(await viewedAt(harness, meetup.id)).toBeNull();
        },
      };
    },
  },
];

describe('a Redis that answers nothing', () => {
  it.each(OUTAGE_CASES)(
    'refuses $label and writes nothing',
    async (outage) => {
      const prepared = await outage.prepare(t);

      await pauseRedis();
      try {
        expectError(await prepared.send(), 503, 'service_unavailable');
      } finally {
        await unpauseRedis();
      }

      await prepared.unchanged();
    },
    OUTAGE_CASE_TIMEOUT_MS,
  );

  it(
    'still settles an overdue meetup while Redis answers nothing',
    async () => {
      const { meetupId } = await overdueMeetup();

      await pauseRedis();
      // The pass is not awaited here on purpose. Its decision is written by the settlement transaction,
      // which reads PostgreSQL and Stripe alone (AAP 0.3.2); the pass then reaches the queue calls its
      // post-commit timers make, and those retry inside BullMQ until Redis answers, so awaiting the
      // pass here would wait on the outage instead of on the settlement.
      const pass = runSweeper(t.services);
      // A pass that rejects after an assertion failed below must not surface as an unhandled rejection.
      pass.catch(() => undefined);

      try {
        const settlement = await settlementWithin(t, meetupId);
        expect(settlement).toEqual({ outcome: 'completed', status: 'applying' });

        const settled = await t.services.db.meetup.findUniqueOrThrow({
          where: { id: meetupId },
          select: { status: true },
        });
        expect(settled.status).toBe('completed');

        // Both holds are still held: money moves in the executor phase, which runs once the pass can
        // reach the provider calls its own decisions recorded.
        expect(await depositStatuses(t, meetupId)).toEqual(['held', 'held']);

        // Durability is the point: the rows are committed, and no pass can deliver them yet.
        const waiting = await t.services.db.outboxMessage.count({ where: { dispatchedAt: null } });
        expect(waiting).toBeGreaterThan(0);
        expect(await t.services.outbox.runOnce()).toBe(0);
        expect(await t.services.db.outboxMessage.count({ where: { dispatchedAt: null } })).toBe(
          waiting,
        );
      } finally {
        await unpauseRedis();
      }

      // With Redis answering again the pass finishes its executor phase: both holds released and the
      // settlement complete.
      const sweep = await pass;
      expect(sweep.skipped).toBe(false);
      expect(sweep.settled).toBe(1);
      expect(await settlementWithin(t, meetupId)).toEqual({
        outcome: 'completed',
        status: 'complete',
      });
      expect(await depositStatuses(t, meetupId)).toEqual(['released', 'released']);
    },
    PASS_TIMEOUT_MS,
  );

  it(
    'delivers every waiting row once Redis answers again',
    async () => {
      const { meetupId, initiator } = await overdueMeetup();

      await pauseRedis();
      const pass = runSweeper(t.services);
      pass.catch(() => undefined);

      let waiting = 0;
      try {
        // The decision is durable while Redis answers nothing, and its rows are not deliverable yet.
        expect(await settlementWithin(t, meetupId)).toEqual({
          outcome: 'completed',
          status: 'applying',
        });
        waiting = await t.services.db.outboxMessage.count({ where: { dispatchedAt: null } });
        expect(waiting).toBeGreaterThan(0);
        expect(await t.services.outbox.runOnce()).toBe(0);
      } finally {
        await unpauseRedis();
      }

      await pass;
      await awaitAnswering(t.services.redis.producer);
      // Whichever pass delivers them — the settlement's own kick once Redis answered, or this one —
      // every row the outage left waiting ends dispatched.
      await t.services.outbox.runOnce();

      const messages = await t.services.db.outboxMessage.findMany({
        select: { id: true, kind: true, dispatchedAt: true },
      });
      expect(messages.length).toBe(waiting);

      for (const message of messages) {
        // A settlement's rows are its notifications, each one job in the queue that consumes it, under
        // the row's own id — which is what suppresses a second enqueue (AAP 0.3.2).
        expect(message.kind).toBe('notification');
        expect(message.dispatchedAt).not.toBeNull();

        const jobId = `outbox-${message.id}`;
        expect((await t.services.queues.get(NOTIFICATION_QUEUE).getJob(jobId))?.id).toBe(jobId);
      }

      // And the API serves writes again, not only its poller.
      expect((await registerPushToken(t, initiator)).status).toBe(204);
    },
    PASS_TIMEOUT_MS,
  );
});
